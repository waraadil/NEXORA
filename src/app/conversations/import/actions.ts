'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createSupabaseServerClient, createSupabaseAdminClient } from '@/lib/supabase/server';
import { parseWhatsAppExport, looksLikeWhatsAppExport } from '@/lib/whatsapp/parser';

export type ImportState =
  | {
      error?: string;
      fieldErrors?: Record<string, string>;
      batch?: {
        id: string;
        filename: string;
        totalParsed: number;
        participants: { name: string; messageCount: number }[];
        issues: number;
        systemLines: number;
        isGroup: boolean;
        format: string;
        firstDate: string | null;
        lastDate: string | null;
        preview: { sender: string; body: string; sentAt: string | null; isFromMe: boolean }[];
      };
    }
  | { committed?: { conversationId: string; inserted: number; duplicates: number; errors: number } }
  | null;

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — WhatsApp exports are text, this is generous

/** Step 1 — parse the uploaded export and stage it. Nothing is persisted yet. */
export async function stageImport(_prev: ImportState, formData: FormData): Promise<ImportState> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Your session expired. Sign in again.' };

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { fieldErrors: { file: 'Choose a WhatsApp export file (.txt or .zip).' } };
  }
  if (file.size > MAX_BYTES) {
    return { fieldErrors: { file: 'File is larger than 25 MB. Split the export and retry.' } };
  }

  const meName = String(formData.get('meName') ?? '').trim();

  const raw = await file.text();

  // A .zip export contains the .txt inside; we cannot unzip server-side without
  // a dependency, so tell the user plainly rather than failing cryptically.
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

  if (!meName) {
    return { fieldErrors: { meName: 'Enter the name your messages appear under in this export.' } };
  }

  const parsed = parseWhatsAppExport(raw, { meName });

  if (parsed.messages.length === 0) {
    return {
      error:
        'No messages could be parsed. Check that you exported the chat as "Without media" and that the file is the .txt transcript.',
    };
  }

  // Cap staged payload — a huge export would blow the JSON column and the UI.
  const MAX_STAGE = 5000;
  const staged = parsed.messages.slice(0, MAX_STAGE).map((m) => ({
    senderName: m.senderName,
    isFromMe: m.isFromMe,
    body: m.body.slice(0, 4000),
    sentAt: m.sentAt,
    hash: m.hash,
  }));

  const admin = createSupabaseAdminClient();
  const { data: batch, error } = await admin
    .from('import_batches')
    .insert({
      user_id: user.id,
      filename: file.name.slice(0, 200),
      file_size_bytes: file.size,
      status: 'parsed',
      total_parsed: parsed.messages.length,
      detected_participants: parsed.participants,
      errors: parsed.issues.length,
      me_name: meName,
      relationship: String(formData.get('relationship') ?? '').trim() || null,
      chat_title: parsed.isGroup ? 'Group chat' : parsed.participants[0]?.name ?? 'Imported chat',
      staged_messages: staged,
      report: {
        format: parsed.formatDetected,
        systemLines: parsed.systemLineCount,
        issues: parsed.issues.slice(0, 50),
        truncatedAt: parsed.messages.length > MAX_STAGE ? MAX_STAGE : null,
        dateRange: parsed.dateRange,
      },
    })
    .select('id')
    .single();

  if (error || !batch) return { error: 'Could not stage the import. Please retry.' };

  return {
    batch: {
      id: batch.id as string,
      filename: file.name,
      totalParsed: parsed.messages.length,
      participants: parsed.participants,
      issues: parsed.issues.length,
      systemLines: parsed.systemLineCount,
      isGroup: parsed.isGroup,
      format: parsed.formatDetected,
      firstDate: parsed.dateRange.first,
      lastDate: parsed.dateRange.last,
      preview: staged.slice(0, 8).map((m) => ({
        sender: m.senderName,
        body: m.body,
        sentAt: m.sentAt,
        isFromMe: m.isFromMe,
      })),
    },
  };
}

/** Step 2 — user confirmed the participants. Commit to real tables. */
export async function commitImport(
  _prev: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Your session expired. Sign in again.' };

  const parsed = z
    .object({
      batchId: z.string().uuid(),
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

  const admin = createSupabaseAdminClient();

  // Re-read the batch, pinned to this user — never trust the client's batch id alone.
  const { data: batch, error: bErr } = await admin
    .from('import_batches')
    .select('*')
    .eq('id', parsed.data.batchId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (bErr || !batch) return { error: 'That import could not be found.' };
  if (batch.status === 'confirmed') return { error: 'This import was already confirmed.' };

  const staged = (batch.staged_messages ?? []) as {
    senderName: string;
    isFromMe: boolean;
    body: string;
    sentAt: string | null;
    hash: string;
  }[];

  if (staged.length === 0) return { error: 'Nothing staged for this import.' };

  // Contact — upsert by (user, name)
  let contactId: string;
  const { data: existingContact } = await admin
    .from('contacts')
    .select('id')
    .eq('user_id', user.id)
    .ilike('display_name', parsed.data.contactName)
    .maybeSingle();

  if (existingContact) {
    contactId = existingContact.id as string;
    await admin
      .from('contacts')
      .update({
        relationship: batch.relationship ?? undefined,
        last_interaction_at: staged[staged.length - 1]?.sentAt ?? null,
      })
      .eq('id', contactId)
      .eq('user_id', user.id);
  } else {
    const { data: created, error } = await admin
      .from('contacts')
      .insert({
        user_id: user.id,
        display_name: parsed.data.contactName,
        relationship: batch.relationship ?? null,
        is_group: !!batch.detected_participants && (batch.detected_participants as unknown[]).length > 1,
        group_participants: batch.detected_participants ?? [],
        last_interaction_at: staged[staged.length - 1]?.sentAt ?? null,
      })
      .select('id')
      .single();
    if (error || !created) return { error: 'Could not create the contact.' };
    contactId = created.id as string;
  }

  // Conversation — reuse an existing import for the same contact, or create.
  let conversationId: string;
  const { data: existingConv } = await admin
    .from('conversations')
    .select('id, message_count, first_message_at')
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
        title: batch.chat_title ?? parsed.data.contactName,
        source: 'manual',
        is_group: !!batch.detected_participants && (batch.detected_participants as unknown[]).length > 1,
        import_batch_id: batch.id,
        first_message_at: staged[0]?.sentAt ?? null,
        last_message_at: staged[staged.length - 1]?.sentAt ?? null,
      })
      .select('id')
      .single();
    if (error || !created) return { error: 'Could not create the conversation.' };
    conversationId = created.id as string;
  }

  // Messages — insert in chunks; the unique index on (conversation_id, message_hash)
  // is the dedupe guarantee, so re-importing the same export is safe.
  const CHUNK = 500;
  let inserted = 0;
  let duplicates = 0;
  let errors = 0;

  for (let i = 0; i < staged.length; i += CHUNK) {
    const slice = staged.slice(i, i + CHUNK).map((m) => ({
      user_id: user.id,
      conversation_id: conversationId,
      sender_name: m.isFromMe ? 'You' : m.senderName,
      is_from_me: m.isFromMe,
      body: m.body,
      sent_at: m.sentAt,
      message_hash: m.hash,
      direction: m.isFromMe ? 'outbound' : 'inbound',
    }));

    // upsert with ignoreDuplicates lets Postgres skip conflicts without erroring.
    const { data: rowsIn, error: insErr } = await admin
      .from('messages')
      .upsert(slice, { onConflict: 'conversation_id,message_hash', ignoreDuplicates: true })
      .select('id');

    if (insErr) {
      errors += slice.length;
    } else {
      inserted += rowsIn?.length ?? 0;
      duplicates += slice.length - (rowsIn?.length ?? 0);
    }
  }

  // Authoritative rollups from the messages table.
  const { data: agg } = await admin
    .from('messages')
    .select('sent_at')
    .eq('conversation_id', conversationId)
    .eq('user_id', user.id)
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
      .eq('user_id', user.id);
  }

  await admin
    .from('import_batches')
    .update({
      status: errors > 0 && inserted === 0 ? 'failed' : 'confirmed',
      contact_id: contactId,
      conversation_id: conversationId,
      inserted,
      duplicates_skipped: duplicates,
      errors,
      staged_messages: null, // free the staging blob
    })
    .eq('id', batch.id)
    .eq('user_id', user.id);

  revalidatePath('/conversations');
  revalidatePath('/contacts');
  revalidatePath('/dashboard');

  return { committed: { conversationId, inserted, duplicates, errors } };
}

/** Discard a staged import without committing. */
export async function discardImport(batchId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const admin = createSupabaseAdminClient();
  await admin
    .from('import_batches')
    .update({ status: 'failed', staged_messages: null })
    .eq('id', batchId)
    .eq('user_id', user.id)
    .eq('status', 'parsed');
}
