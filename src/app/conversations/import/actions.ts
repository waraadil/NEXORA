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
        relationshipValue: string | null;
        preview: { sender: string; body: string; sentAt: string | null; isFromMe: boolean }[];
        /** True when the draft rows were persisted server-side and can be committed. */
        staged: boolean;
      };
    }
  | { committed?: { conversationId: string; inserted: number; duplicates: number; errors: number } }
  | null;

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Why there is no server-side draft store.
 *
 * The wizard has two steps, and on Vercel each request can land on a different
 * serverless instance, each with its own memory. Keeping the parsed export in a
 * module-level Map therefore "works" on a laptop and fails in production with
 * "that import expired". Instead the browser keeps the file it already has and
 * re-sends it on confirm; parsing 1.8 MB costs ~0.5 s, so the second pass is
 * cheap and the flow is fully stateless.
 */

/**
 * Decide which sender in the export is the device owner.
 *
 * Exports label the owner inconsistently: "You" on many Android builds, their
 * saved contact name on others, and on some phones a filler character the user
 * chose to make their name appear blank (U+3164 is the common one). Guessing
 * wrong flips the direction of every message, so:
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

  const blanks = [...senders.entries()].filter(([name]) => isBlankName(name));
  if (blanks.length === 1) return { meName: blanks[0][0], source: 'auto' };

  return { meName: null, source: 'none' };
}

/** Parse + decide ownership. Shared by both steps so they can never disagree. */
function analyse(raw: string, typedMeName: string) {
  const probe = parseWhatsAppExport(raw, { meName: '\u0000no-match' });
  const owner = detectOwner(probe.messages, typedMeName);
  if (!owner.meName) return { probe, owner, parsed: null };
  return { probe, owner, parsed: parseWhatsAppExport(raw, { meName: owner.meName }) };
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
  void relationship;

  // Parse once, decide ownership, then re-derive isFromMe with the answer.
  const { probe, owner, parsed } = analyse(raw, typedMeName);
  if (probe.messages.length === 0) {
    return {
      error:
        'No messages could be parsed. Check that you exported the chat as "Without media" and that the file is the .txt transcript.',
    };
  }

  if (!owner.meName || !parsed) {
    const names = probe.participants.map((p) => p.displayName).join(', ');
    return {
      fieldErrors: {
        meName: `We could not tell which sender is you. Senders in this export: ${names}. Type one of them exactly.`,
      },
    };
  }

  const otherParticipants = parsed.participants;
  // Nothing is persisted yet; the id just ties the two steps together in the UI.
  const batchId = crypto.randomUUID();
  void relationship; // captured on the commit step, where it is actually written

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
      relationshipValue: relationship,
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

  const parsedInput = z
    .object({
      batchId: z.string().min(8),
      contactName: z.string().trim().min(1, 'Confirm the contact name').max(120),
      meName: z.string().default(''),
      relationship: z.string().max(60).optional(),
    })
    .safeParse({
      batchId: formData.get('batchId'),
      contactName: formData.get('contactName'),
      meName: formData.get('meName') ?? '',
      relationship: String(formData.get('relationship') ?? '') || undefined,
    });

  if (!parsedInput.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsedInput.error.issues) fieldErrors[String(issue.path[0])] = issue.message;
    return { fieldErrors };
  }

  const contactName = cleanName(parsedInput.data.contactName);
  if (!contactName) {
    return {
      fieldErrors: { contactName: 'That name is blank or invisible — pick a name you can read.' },
    };
  }

  // The browser still holds the file; re-parse it here rather than trusting a
  // server-side draft, which would not survive a different serverless instance.
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'The export file was not sent with the confirmation. Re-upload and try again.' };
  }
  if (file.size > MAX_BYTES) {
    return { error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 25 MB.` };
  }
  const raw = await file.text();
  if (!looksLikeWhatsAppExport(raw)) {
    return { error: 'That file no longer looks like a WhatsApp export. Re-upload and try again.' };
  }

  const { owner, parsed: parsedExport } = analyse(raw, parsedInput.data.meName);
  if (!owner.meName || !parsedExport || parsedExport.messages.length === 0) {
    return { error: 'Could not identify your messages in that export. Re-upload and set your name.' };
  }

  const admin = createSupabaseAdminClient();
  const messagesIn = parsedExport.messages;
  const isGroup = parsedExport.participants.length > 1;
  const relationship = parsedInput.data.relationship ?? null;
  const lastSentAt = messagesIn[messagesIn.length - 1]?.sentAt ?? null;
  const firstSentAt = messagesIn[0]?.sentAt ?? null;

  // ── Contact ──
  let contactId: string;
  const { data: existingContact } = await admin
    .from('contacts')
    .select('id')
    .eq('user_id', user.id)
    .ilike('display_name', contactName)
    .maybeSingle();

  if (existingContact) {
    contactId = existingContact.id as string;
    await admin
      .from('contacts')
      .update({
        ...(relationship ? { relationship } : {}),
        last_interaction_at: lastSentAt,
        is_group: isGroup,
      })
      .eq('id', contactId)
      .eq('user_id', user.id);
  } else {
    const { data: created, error } = await admin
      .from('contacts')
      .insert({
        user_id: user.id,
        display_name: contactName,
        relationship,
        is_group: isGroup,
        last_interaction_at: lastSentAt,
      })
      .select('id')
      .single();
    if (error || !created)
      return { error: `Could not create the contact: ${error?.message ?? 'unknown error'}` };
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
        first_message_at: firstSentAt,
        last_message_at: lastSentAt,
      })
      .select('id')
      .single();
    if (error || !created)
      return { error: `Could not create the conversation: ${error?.message ?? 'unknown error'}` };
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

  for (let i = 0; i < messagesIn.length; i += CHUNK) {
    const slice = messagesIn.slice(i, i + CHUNK).map((m) => ({
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
    return { error: `Every message failed to save. First database error: ${firstError}` };
  }

  // Authoritative rollups read back from the table, not from what we sent.
  const [{ data: firstRow }, { data: lastRow }, { count: totalCount }] = await Promise.all([
    admin
      .from('messages')
      .select('sent_at')
      .eq('conversation_id', conversationId)
      .eq('user_id', user.id)
      .not('sent_at', 'is', null)
      .order('sent_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    admin
      .from('messages')
      .select('sent_at')
      .eq('conversation_id', conversationId)
      .eq('user_id', user.id)
      .not('sent_at', 'is', null)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
      .eq('user_id', user.id),
  ]);

  await admin
    .from('conversations')
    .update({
      message_count: totalCount ?? inserted,
      first_message_at: firstRow?.sent_at ?? null,
      last_message_at: lastRow?.sent_at ?? null,
    })
    .eq('id', conversationId)
    .eq('user_id', user.id);

  revalidatePath('/conversations');
  revalidatePath(`/conversations/${conversationId}`);
  revalidatePath('/contacts');
  revalidatePath('/dashboard');

  return { committed: { conversationId, inserted, duplicates, errors } };
}

/** Kept for API compatibility; there is no server-side draft to discard. */
export async function discardImport(_batchId: string): Promise<void> {
  void _batchId;
}
