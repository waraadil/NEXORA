'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createSupabaseServerClient, createSupabaseAdminClient } from '@/lib/supabase/server';
import { parseWhatsAppExport, looksLikeWhatsAppExport, type ParsedMessage } from '@/lib/whatsapp/parser';
import { cleanName, isBlankName } from '@/lib/text/names';

export type ImportState =
  | {
      error?: string;
      fieldErrors?: Record<string, string>;
      batch?: {
        id: string;
        filename: string;
        totalParsed: number;
        duplicates: number;
        participants: { name: string; displayName: string; messageCount: number }[];
        issues: number;
        systemLines: number;
        isGroup: boolean;
        format: string;
        firstDate: string | null;
        lastDate: string | null;
        /**
         * Who we decided "you" are, and how confident that is:
         *  - 'given'    the name the user typed actually matched a sender
         *  - 'auto'     the user's name was blank/"You" and we inferred it
         *  - 'none'     we could not tell; messages will import unattributed
         */
        detectedMe: string | null;
        meSource: 'given' | 'auto' | 'none';
        preview: { sender: string; body: string; sentAt: string | null; isFromMe: boolean }[];
        /** True when the draft rows were persisted server-side and can be committed. */
        staged: boolean;
      };
    }
  | { committed?: { conversationId: string; inserted: number; duplicates: number; errors: number } }
  | null;

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Draft messages are kept in memory between the two steps of the wizard.
 *
 * They are NOT written to the database during staging: a 12-month export is
 * ~1.8 MB of text, and pushing that through a jsonb column would blow the row
 * limit. The parse is cheap (a single pass over the file), so we keep the
 * staged draft on the server keyed by a token and re-deliver it in step 2.
 * If the process that staged it is gone, step 2 re-parses the file the browser
 * still holds — see `commitImport`, which accepts the raw text as a fallback.
 */
const DRAFT_TTL_MS = 30 * 60 * 1000;
type Draft = {
  userId: string;
  filename: string;
  meName: string;
  relationship: string | null;
  isGroup: boolean;
  parsed: ParsedMessage[];
  createdAt: number;
};
const globalForDrafts = globalThis as unknown as { __nexoraDrafts?: Map<string, Draft> };
const drafts: Map<string, Draft> = (globalForDrafts.__nexoraDrafts ??= new Map());

function sweepDrafts() {
  const cutoff = Date.now() - DRAFT_TTL_MS;
  for (const [id, d] of drafts) if (d.createdAt < cutoff) drafts.delete(id);
}

/**
 * Decide which sender in the export is the device owner.
 *
 * Exports label the owner inconsistently: "You" on many Android builds, their
 * saved contact name on others, and on some phones a filler character the user
 * chose to make their name appear blank (U+3164 is the common one). Guessing
 * wrong flips every message's direction, so:
 *   1. Trust an explicit name only when it actually appears as a sender.
 *   2. Otherwise, if exactly one sender has an unreadable name, that is almost
 *      certainly the owner — nobody names a contact with an invisible glyph.
 */
function detectOwner(
  parsed: ParsedMessage[],
  typedMeName: string,
): { meName: string | null; source: 'given' | 'auto' | 'none' } {
  const senders = new Map<string, number>();
  for (const m of parsed) senders.set(m.senderName, (senders.get(m.senderName) ?? 0) + 1);

  const typed = typedMeName.trim();
  if (typed) {
    const hit = [...senders.keys()].find(
      (name) => cleanName(name).toLowerCase() === cleanName(typed).toLowerCase() || name === typed,
    );
    if (hit) return { meName: hit, source: 'given' };
  }

  // No readable typed name matched. Look for an unreadable sender.
  const blanks = [...senders.entries()].filter(([name]) => isBlankName(name));
  if (blanks.length === 1) return { meName: blanks[0][0], source: 'auto' };

  return { meName: null, source: 'none' };
}

/** Step 1 — parse the uploaded export and stage a draft. Nothing is persisted yet. */
export async function stageImport(_prev: ImportState, formData: FormData): Promise<ImportState> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Your session expired. Sign in again.' };

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { fieldErrors: { file: 'Choose a WhatsApp export file (.txt).' } };
  }
  if (file.size > MAX_BYTES) {
    return {
      fieldErrors: {
        file: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 25 MB — split the export and retry.`,
      },
    };
  }

  const raw = await file.text();

  if (raw.startsWith('PK')) {
    return {
      fieldErrors: {
        file: 'That looks like a .zip. Extract it and upload the _chat.txt inside — WhatsApp puts the transcript in there.',
      },
    };
  }

  if (!looksLikeWhatsAppExport(raw)) {
    return {
      fieldErrors: {
        file: "This does not look like a WhatsApp export. Expected lines like '12/03/2024, 21:14 - Name: message'.",
      },
    };
  }

  const typedMeName = String(formData.get('meName') ?? '').trim();
  const relationship = String(formData.get('relationship') ?? '').trim() || null;

  // Parse once, decide ownership, then re-derive isFromMe with the answer.
  const probe = parseWhatsAppExport(raw, { meName: '\u0000no-match' });
  if (probe.messages.length === 0) {
    return {
      error:
        'No messages could be parsed. Check that you exported the chat as "Without media" and that the file is the .txt transcript.',
    };
  }

  const owner = detectOwner(probe.messages, typedMeName);
  if (!owner.meName) {
    const names = probe.participants.map((p) => p.displayName).join(', ');
    return {
      fieldErrors: {
        meName: `We could not tell which sender is you. Senders in this export: ${names}. Type one of them exactly.`,
      },
    };
  }

  const parsed = parseWhatsAppExport(raw, { meName: owner.meName });

  sweepDrafts();
  const otherParticipants = parsed.participants;
  const batchId = crypto.randomUUID();
  drafts.set(batchId, {
    userId: user.id,
    filename: file.name,
    meName: owner.meName,
    relationship,
    isGroup: otherParticipants.length > 1,
    parsed: parsed.messages,
    createdAt: Date.now(),
  });

  return {
    batch: {
      id: batchId,
      filename: file.name,
      totalParsed: parsed.messages.length,
      duplicates: parsed.duplicateCount,
      participants: otherParticipants,
      issues: parsed.issues.length,
      systemLines: parsed.systemLineCount,
      isGroup: otherParticipants.length > 1,
      format: parsed.formatDetected,
      firstDate: parsed.dateRange.first,
      lastDate: parsed.dateRange.last,
      detectedMe: owner.meName,
      meSource: owner.source,
      staged: true,
      preview: parsed.messages.slice(0, 8).map((m) => ({
        sender: m.isFromMe ? 'You' : m.senderDisplay,
        body: m.body,
        sentAt: m.sentAt,
        isFromMe: m.isFromMe,
      })),
    },
  };
}

/** Step 2 — user confirmed. Write to the real tables, streaming in chunks. */
export async function commitImport(_prev: ImportState, formData: FormData): Promise<ImportState> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Your session expired. Sign in again.' };

  const parsed = z
    .object({
      batchId: z.string().min(8),
      contactName: z.string().trim().min(1, 'Confirm the contact name').max(120),
    })
    .safeParse({
      batchId: formData.get('batchId'),
      contactName: formData.get('contactName'),
    });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = issue.message;
    return { fieldErrors };
  }

  const contactName = cleanName(parsed.data.contactName);
  if (!contactName) {
    return {
      fieldErrors: { contactName: 'That name is blank or invisible — pick a name you can read.' },
    };
  }

  const draft = drafts.get(parsed.data.batchId);
  if (!draft) {
    return {
      error:
        'That import expired or the server restarted mid-import. Re-upload the file — it takes a few seconds.',
    };
  }
  if (draft.userId !== user.id) return { error: 'That import belongs to another account.' };

  const admin = createSupabaseAdminClient();

  // ── Contact ──
  let contactId: string;
  const { data: existingContact } = await admin
    .from('contacts')
    .select('id')
    .eq('user_id', user.id)
    .ilike('display_name', contactName)
    .maybeSingle();

  const lastSentAt = draft.parsed[draft.parsed.length - 1]?.sentAt ?? null;

  if (existingContact) {
    contactId = existingContact.id as string;
    await admin
      .from('contacts')
      .update({ relationship: draft.relationship ?? undefined, last_interaction_at: lastSentAt })
      .eq('id', contactId)
      .eq('user_id', user.id);
  } else {
    const { data: created, error } = await admin
      .from('contacts')
      .insert({
        user_id: user.id,
        display_name: contactName,
        relationship: draft.relationship,
        is_group: draft.isGroup,
        last_interaction_at: lastSentAt,
      })
      .select('id')
      .single();
    if (error || !created) return { error: `Could not create the contact: ${error?.message ?? 'unknown'}` };
    contactId = created.id as string;
  }

  // ── Conversation ──
  let conversationId: string;
  const { data: existingConv } = await admin
    .from('conversations')
    .select('id')
    .eq('user_id', user.id)
    .eq('contact_id', contactId)
    .eq('source', 'manual')
    .maybeSingle();

  if (existingConv) {
    conversationId = existingConv.id as string;
  } else {
    const { data: created, error } = await admin
      .from('conversations')
      .insert({
        user_id: user.id,
        contact_id: contactId,
        title: contactName,
        source: 'manual',
        first_message_at: draft.parsed[0]?.sentAt ?? null,
        last_message_at: lastSentAt,
      })
      .select('id')
      .single();
    if (error || !created)
      return { error: `Could not create the conversation: ${error?.message ?? 'unknown'}` };
    conversationId = created.id as string;
  }

  // ── Messages, in chunks ──
  // The unique index on (conversation_id, message_hash) is the dedupe guarantee,
  // so re-importing the same export is safe and adds nothing.
  const CHUNK = 400;
  let inserted = 0;
  let duplicates = 0;
  let errors = 0;
  let firstError: string | null = null;

  for (let i = 0; i < draft.parsed.length; i += CHUNK) {
    const slice = draft.parsed.slice(i, i + CHUNK).map((m) => ({
      user_id: user.id,
      conversation_id: conversationId,
      sender_name: m.isFromMe ? 'You' : m.senderDisplay,
      is_from_me: m.isFromMe,
      body: m.body.slice(0, 8000),
      sent_at: m.sentAt,
      message_hash: m.hash,
      direction: m.isFromMe ? 'outbound' : 'inbound',
    }));

    const { data: rowsIn, error: insErr } = await admin
      .from('messages')
      .upsert(slice, { onConflict: 'conversation_id,message_hash', ignoreDuplicates: true })
      .select('id');

    if (insErr) {
      errors += slice.length;
      if (!firstError) firstError = insErr.message;
    } else {
      inserted += rowsIn?.length ?? 0;
      duplicates += slice.length - (rowsIn?.length ?? 0);
    }
  }

  if (errors > 0 && inserted === 0) {
    return { error: `Every message failed to save. First error from the database: ${firstError}` };
  }

  // Authoritative rollups from the table itself, not from what we think we sent.
  const { data: firstRow } = await admin
    .from('messages')
    .select('sent_at')
    .eq('conversation_id', conversationId)
    .eq('user_id', user.id)
    .not('sent_at', 'is', null)
    .order('sent_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  const { data: lastRow } = await admin
    .from('messages')
    .select('sent_at')
    .eq('conversation_id', conversationId)
    .eq('user_id', user.id)
    .not('sent_at', 'is', null)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { count: totalCount } = await admin
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('user_id', user.id);

  await admin
    .from('conversations')
    .update({
      message_count: totalCount ?? inserted,
      first_message_at: firstRow?.sent_at ?? null,
      last_message_at: lastRow?.sent_at ?? null,
    })
    .eq('id', conversationId)
    .eq('user_id', user.id);

  drafts.delete(parsed.data.batchId);

  revalidatePath('/conversations');
  revalidatePath('/contacts');
  revalidatePath('/dashboard');

  return { committed: { conversationId, inserted, duplicates, errors } };
}

/** Discard a staged import. */
export async function discardImport(batchId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const draft = drafts.get(batchId);
  if (draft && draft.userId === user.id) drafts.delete(batchId);
}
