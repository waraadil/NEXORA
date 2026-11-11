import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { resolveBridgeToken, type BridgePayload } from '@/lib/whatsapp/bridge';

/**
 * Personal-bridge ingest endpoint.
 *
 * A user-run bridge process authenticates with its issued token and POSTs
 * batches of messages. NEXORA hosts NO automation — it only receives data.
 *
 * Every message is tagged `source = 'personal_bridge'` so provenance is always
 * visible in the UI and can never be confused with the official integration.
 */


function normalisePhone(chatId: string): string {
  // "919876543210@c.us" -> "+919876543210"
  const digits = chatId.split('@')[0].replace(/[^\d]/g, '');
  return digits ? `+${digits}` : chatId;
}

export async function POST(request: NextRequest) {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';

  if (!token) {
    return NextResponse.json({ error: 'missing bearer token' }, { status: 401 });
  }

  const owner = await resolveBridgeToken(token);
  if (!owner) {
    return NextResponse.json({ error: 'invalid or revoked token' }, { status: 401 });
  }

  let payload: BridgePayload;
  try {
    payload = (await request.json()) as BridgePayload;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  if (!payload?.chat?.id || !Array.isArray(payload.messages)) {
    return NextResponse.json({ error: 'chat.id and messages[] are required' }, { status: 400 });
  }
  if (payload.messages.length > 500) {
    return NextResponse.json({ error: 'send at most 500 messages per batch' }, { status: 413 });
  }

  const admin = createSupabaseAdminClient();
  const userId = owner.userId;

  const phone = normalisePhone(payload.chat.id);
  const displayName = payload.chat.name?.trim() || phone;

  // Contact — upsert by phone
  let contactId: string;
  const { data: existing } = await admin
    .from('contacts')
    .select('id')
    .eq('user_id', userId)
    .eq('phone', phone)
    .maybeSingle();

  if (existing) {
    contactId = existing.id as string;
  } else {
    const { data: created, error } = await admin
      .from('contacts')
      .insert({
        user_id: userId,
        display_name: displayName,
        phone,
        is_group: !!payload.chat.isGroup,
      })
      .select('id')
      .single();
    if (error || !created) {
      return NextResponse.json({ error: 'contact create failed' }, { status: 500 });
    }
    contactId = created.id as string;
  }

  // Conversation
  const waChatId = payload.chat.id;
  let conversationId: string;
  const { data: conv } = await admin
    .from('conversations')
    .select('id')
    .eq('user_id', userId)
    .eq('wa_chat_id', waChatId)
    .maybeSingle();

  if (conv) {
    conversationId = conv.id as string;
  } else {
    const { data: created, error } = await admin
      .from('conversations')
      .insert({
        user_id: userId,
        contact_id: contactId,
        title: displayName,
        source: 'personal_bridge',
        integration_id: owner.integrationId,
        wa_chat_id: waChatId,
        is_group: !!payload.chat.isGroup,
      })
      .select('id')
      .single();
    if (error || !created) {
      return NextResponse.json({ error: 'conversation create failed' }, { status: 500 });
    }
    conversationId = created.id as string;
  }

  // Messages — dedupe on provider id
  const { createHash } = await import('node:crypto');
  let inserted = 0;
  let duplicates = 0;

  for (const m of payload.messages) {
    if (!m?.id || typeof m.body !== 'string') continue;

    const sentAt = new Date((m.timestamp ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
    const hash = createHash('sha256')
      .update(`${m.senderName ?? ''}\u0000${sentAt}\u0000${m.body}`)
      .digest('hex');

    const { error } = await admin.from('messages').insert({
      user_id: userId,
      conversation_id: conversationId,
      sender_name: m.fromMe ? 'You' : m.senderName || displayName,
      is_from_me: !!m.fromMe,
      body: m.body,
      sent_at: sentAt,
      message_hash: hash,
      provider_message_id: `bridge:${m.id}`,
      direction: m.fromMe ? 'outbound' : 'inbound',
      wa_status: 'received',
    });

    if (error?.code === '23505') duplicates++;
    else if (error) continue;
    else inserted++;
  }

  // Recompute conversation rollups from the messages table — authoritative.
  const { data: agg } = await admin
    .from('messages')
    .select('sent_at')
    .eq('conversation_id', conversationId)
    .order('sent_at', { ascending: true });

  if (agg?.length) {
    await admin
      .from('conversations')
      .update({
        message_count: agg.length,
        first_message_at: agg[0].sent_at,
        last_message_at: agg[agg.length - 1].sent_at,
      })
      .eq('id', conversationId)
      .eq('user_id', userId);
  }

  return NextResponse.json({ ok: true, inserted, duplicates, conversationId });
}

/** Health check a bridge can call before pushing, so failures are obvious. */
export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const owner = token ? await resolveBridgeToken(token) : null;

  if (!owner) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, integrationId: owner.integrationId });
}
