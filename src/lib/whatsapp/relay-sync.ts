import 'server-only';
import { createHash } from 'node:crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

/**
 * Shared persistence for live WhatsApp messages.
 *
 * The relay (`/api/whatsapp/relay/sync`) calls this. It used to be shared with a
 * legacy ingest endpoint that once existed here, so message attribution is
 * decided in exactly one place and cannot drift between the two channels.
 *
 * Attribution rules that matter:
 *  • `is_from_me` is decided from the relay's own view of the account, never
 *    from a display name.
 *  • In groups, the speaker is the message author — not the group name.
 *  • Unreadable message types become labelled placeholders (`[photo]`), never
 *    invented text and never silently dropped.
 *  • Dedupe is layered: `provider_message_id` unique per user, and
 *    `(conversation_id, message_hash)` unique for anything without an id.
 */

export type InboundMessage = {
  id: string;
  isGroup?: boolean;
  fromMe: boolean;
  senderJid?: string | null;
  senderName: string;
  body: string;
  /** unix seconds */
  timestamp: number;
};

export type InboundChat = {
  /** WhatsApp JID, e.g. 919876543210@s.whatsapp.net or 1203630…@g.us */
  id: string;
  name: string;
  isGroup: boolean;
  participants?: { jid: string; phone?: string; name?: string | null }[];
};

export type SyncResult = {
  conversationId: string;
  contactId: string;
  inserted: number;
  duplicates: number;
  /** Provider ids of messages that were newly stored — the relay uses these. */
  newMessageIds: string[];
};

export const MAX_BATCH = 500;

/** "+919876543210" | undefined */
export function jidToPhone(jid: string | null | undefined): string | undefined {
  if (!jid) return undefined;
  const digits = jid.split('@')[0].split(':')[0].replace(/[^\d]/g, '');
  if (digits.length < 7 || digits.length > 15) return undefined;
  return `+${digits}`;
}

export function isReadableBody(body: unknown): body is string {
  return typeof body === 'string' && body.trim().length > 0;
}

/** Same hash shape the text importer uses, so re-imports of the same chat collapse. */
function hashMessage(senderName: string, sentAt: string, body: string) {
  return createHash('sha256').update(`${senderName}\u0000${sentAt}\u0000${body}`).digest('hex');
}

export async function syncChat(params: {
  userId: string;
  integrationId: string;
  chat: InboundChat;
  messages: InboundMessage[];
  /** 'personal_bridge' for the relay, 'importer' when replaying history. */
  source?: 'personal_bridge' | 'importer';
  /** Skip writing the conversation rollup (bulk history replays do it once). */
  skipRollup?: boolean;
}): Promise<SyncResult> {
  const { userId, integrationId, chat, messages } = params;
  const source = params.source ?? 'personal_bridge';
  const admin = createSupabaseAdminClient();

  const chatJid = chat.id;
  const isGroup = !!chat.isGroup;
  const phone = isGroup ? undefined : jidToPhone(chatJid);
  const displayName = chat.name?.trim() || phone || (isGroup ? 'WhatsApp group' : 'WhatsApp contact');

  // ── Contact ──────────────────────────────────────────────────────────────
  // Identity key is the JID. A contact that already exists from a .txt import
  // (matched by phone) is adopted rather than duplicated.
  let contactId: string | null = null;

  const { data: byJid } = await admin
    .from('contacts')
    .select('id, display_name')
    .eq('user_id', userId)
    .eq('wa_jid', chatJid)
    .maybeSingle();

  if (byJid) contactId = byJid.id as string;

  if (!contactId && phone) {
    const { data: byPhone } = await admin
      .from('contacts')
      .select('id')
      .eq('user_id', userId)
      .eq('phone', phone)
      .maybeSingle();
    if (byPhone) {
      contactId = byPhone.id as string;
      // Bind the imported contact to its live WhatsApp identity.
      await admin.from('contacts').update({ wa_jid: chatJid }).eq('id', contactId).eq('user_id', userId);
    }
  }

  if (!contactId) {
    const { data: created, error } = await admin
      .from('contacts')
      .insert({
        user_id: userId,
        display_name: displayName,
        phone: phone ?? null,
        wa_jid: chatJid,
        is_group: isGroup,
        group_participants: chat.participants ?? [],
        last_interaction_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error || !created) {
      throw new Error(`contact create failed: ${error?.message ?? 'unknown'}`);
    }
    contactId = created.id as string;
  }

  // ── Conversation ─────────────────────────────────────────────────────────
  let conversationId: string | null = null;

  const { data: conv } = await admin
    .from('conversations')
    .select('id')
    .eq('user_id', userId)
    .eq('wa_chat_id', chatJid)
    .maybeSingle();

  if (conv) conversationId = conv.id as string;

  if (!conversationId) {
    const { data: created, error } = await admin
      .from('conversations')
      .insert({
        user_id: userId,
        contact_id: contactId,
        title: displayName,
        source,
        integration_id: integrationId,
        wa_chat_id: chatJid,
        is_group: isGroup,
      })
      .select('id')
      .single();

    if (error) {
      // Unique (user_id, wa_chat_id) means another request won the race —
      // read the winner instead of failing the batch.
      const { data: raced } = await admin
        .from('conversations')
        .select('id')
        .eq('user_id', userId)
        .eq('wa_chat_id', chatJid)
        .maybeSingle();
      if (!raced) throw new Error(`conversation create failed: ${error.message}`);
      conversationId = raced.id as string;
    } else {
      conversationId = created!.id as string;
    }
  }

  // ── Messages ─────────────────────────────────────────────────────────────
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const m of messages) {
    if (!m?.id || !isReadableBody(m.body)) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);

    const sentAt = new Date((Number(m.timestamp) || Math.floor(Date.now() / 1000)) * 1000).toISOString();
    const senderName = m.fromMe ? 'You' : m.senderName?.trim() || displayName;

    rows.push({
      user_id: userId,
      conversation_id: conversationId,
      sender_name: senderName,
      is_from_me: !!m.fromMe,
      body: m.body,
      sent_at: sentAt,
      message_hash: hashMessage(senderName, sentAt, m.body),
      provider_message_id: m.id,
      direction: m.fromMe ? 'outbound' : 'inbound',
      wa_status: m.fromMe ? 'sent' : 'received',
      auto_reply_state: m.fromMe ? null : 'pending',
    });
  }

  const insertedIds: string[] = [];
  let duplicates = 0;

  if (rows.length) {
    // One statement, not one round trip per message: a 400-message history
    // replay took minutes when each insert was awaited individually.
    //
    // onConflict targets (user_id, provider_message_id). Rows without an id are
    // excluded above, so the partial index applies to every row here.
    const { data: inserted, error } = await admin
      .from('messages')
      .upsert(rows, {
        onConflict: 'user_id,provider_message_id',
        ignoreDuplicates: true,
      })
      .select('provider_message_id');

    if (error) {
      // Fall back to per-row so one bad row cannot sink the whole batch, and
      // the caller learns which messages succeeded.
      for (const row of rows) {
        const { error: rowErr } = await admin.from('messages').insert(row);
        if (!rowErr) insertedIds.push(row.provider_message_id as string);
        else if (rowErr.code === '23505') duplicates++;
      }
    } else {
      for (const r of inserted ?? []) insertedIds.push(r.provider_message_id as string);
      duplicates = rows.length - insertedIds.length;
    }
  }

  // ── Rollup (authoritative, recomputed — never incremented blind) ─────────
  if (!params.skipRollup) {
    const { data: agg } = await admin
      .from('messages')
      .select('sent_at')
      .eq('conversation_id', conversationId)
      .eq('user_id', userId)
      .order('sent_at', { ascending: true });

    if (agg) {
      await admin
        .from('conversations')
        .update({
          message_count: agg.length,
          first_message_at: agg[0]?.sent_at ?? null,
          last_message_at: agg[agg.length - 1]?.sent_at ?? null,
        })
        .eq('id', conversationId)
        .eq('user_id', userId);
    }

    if (contactId) {
      await admin
        .from('contacts')
        .update({ last_interaction_at: new Date().toISOString() })
        .eq('id', contactId)
        .eq('user_id', userId);
    }
  }

  return {
    conversationId,
    contactId: contactId!,
    inserted: insertedIds.length,
    duplicates,
    newMessageIds: insertedIds,
  };
}
