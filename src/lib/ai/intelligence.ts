import 'server-only';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { getActiveCredentialForUser, callProvider } from './credentials';
import {
  styleProfilePrompt,
  replyPrompt,
  memoryPrompt,
  parseJsonResponse,
  renderTranscript,
  type TranscriptLine,
} from './prompts';
import { ProviderError } from './providers';

/**
 * All AI work for a user runs on THAT user's key, fetched from the encrypted
 * credential store. There is no fallback to a shared key: if the user has not
 * connected a provider, every function here returns a clear "not configured".
 */

export type AiOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'no_credential' | 'provider' | 'bad_output'; message: string };

function noCredential(): AiOutcome<never> {
  return {
    ok: false,
    reason: 'no_credential',
    message: 'Connect an AI provider in Settings before using assistant features.',
  };
}

async function loadTranscript(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  userId: string,
  conversationId: string,
  limit = 400,
): Promise<TranscriptLine[]> {
  // Take the MOST RECENT `limit` messages, then restore chronological order.
  // Ordering ascending with a limit returned the oldest messages instead, so in
  // a long conversation the model was asked to reply to months-old context and
  // never saw the message it was supposed to answer.
  const { data } = await admin
    .from('messages')
    .select('sender_name, body, is_from_me, sent_at')
    .eq('user_id', userId)
    .eq('conversation_id', conversationId)
    .order('sent_at', { ascending: false })
    .limit(limit);

  return (data ?? []).reverse().map((m) => ({
    sender: m.sender_name as string,
    body: m.body as string,
    isFromMe: m.is_from_me as boolean,
    sentAt: m.sent_at as string | null,
  }));
}

function describeError(e: unknown): AiOutcome<never> {
  if (e instanceof ProviderError) {
    const messages: Record<string, string> = {
      invalid_key: 'Your AI provider key was rejected. Re-check it in Settings → AI provider.',
      insufficient_quota: 'Your provider account has no credit left. Top up with your provider.',
      rate_limited: 'Your provider is rate limiting requests. Try again in a moment.',
      model_unavailable: 'That model is not available on your key. Pick another in Settings.',
      network: 'Could not reach your AI provider. Check the network and retry.',
      provider_error: 'Your AI provider returned an error. Try again shortly.',
    };
    return { ok: false, reason: 'provider', message: messages[e.kind] ?? e.message };
  }
  return { ok: false, reason: 'provider', message: `Unexpected error: ${(e as Error).message}` };
}

// ─────────────────────── Style profiling ───────────────────────

export type StyleProfile = {
  tone: string;
  averageMessageLength: number;
  emojiUsage: string;
  formality: string;
  humour: string;
  punctuationHabits: string;
  vocabularyNotes: string;
  signaturePhrases: string[];
  confidence: number;
};

/**
 * Derive a style profile. When `contactId` is given the profile is
 * contact-specific and stored on that contact; otherwise it is the user's
 * global profile.
 */
export async function deriveStyleProfile(params: {
  userId: string;
  conversationId?: string;
  contactId?: string;
}): Promise<AiOutcome<StyleProfile>> {
  const cred = await getActiveCredentialForUser(params.userId);
  if (!cred) return noCredential();

  const admin = createSupabaseAdminClient();

  // Collect the user's own messages, preferring the given conversation.
  let ownLines: TranscriptLine[] = [];

  if (params.conversationId) {
    ownLines = (await loadTranscript(admin, params.userId, params.conversationId, 500)).filter(
      (l) => l.isFromMe,
    );
  } else {
    const { data } = await admin
      .from('messages')
      .select('sender_name, body, is_from_me, sent_at')
      .eq('user_id', params.userId)
      .eq('is_from_me', true)
      .order('sent_at', { ascending: false })
      .limit(300);

    ownLines = (data ?? [])
      .map((m) => ({
        sender: 'me',
        body: m.body as string,
        isFromMe: true,
        sentAt: m.sent_at as string | null,
      }))
      .reverse();
  }

  if (ownLines.length < 10) {
    return {
      ok: false,
      reason: 'bad_output',
      message: `Only ${ownLines.length} of your own messages available. Import a longer conversation — at least 10 of your own messages are needed for a meaningful profile.`,
    };
  }

  // The model needs both sides for context, but only "ME:" lines are the user.
  const transcript = renderTranscript(ownLines, 400);

  const contactName = await resolveContactName(admin, params.userId, params.contactId);

  try {
    const result = await callProvider(cred, styleProfilePrompt({
      transcript,
      contactName,
      relationship: null,
      messageCount: ownLines.length,
    }), { temperature: 0.2, maxTokens: 900 });

    const parsed = parseJsonResponse<StyleProfile>(result.text);
    if (!parsed) {
      return { ok: false, reason: 'bad_output', message: 'The model returned output we could not read as a profile. Try again.' };
    }

    // Persist — global profile, or contact-specific notes.
    if (params.contactId) {
      await admin
        .from('contacts')
        .update({
          communication_style: [
            parsed.tone,
            parsed.formality,
            parsed.emojiUsage !== 'none' ? `emoji: ${parsed.emojiUsage}` : null,
            parsed.punctuationHabits,
          ]
            .filter(Boolean)
            .join(' · '),
        })
        .eq('id', params.contactId)
        .eq('user_id', params.userId);
    } else {
      const { error: upsertError } = await admin.from('user_style_profiles').upsert(
        {
          user_id: params.userId,
          tone: parsed.tone,
          average_message_length: Math.round(Number(parsed.averageMessageLength) || 0),
          emoji_usage: parsed.emojiUsage,
          formality: parsed.formality,
          humour: parsed.humour,
          vocabulary_notes: parsed.vocabularyNotes,
          signature_phrases: parsed.signaturePhrases ?? [],
          punctuation_habits: parsed.punctuationHabits,
          sample_message_count: ownLines.length,
          confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
          derived_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );

      // Reporting success while the write failed would leave the user with a
      // profile that silently disappears on reload.
      if (upsertError) {
        return {
          ok: false,
          reason: 'bad_output',
          message: `Profile was generated but could not be saved: ${upsertError.message}`,
        };
      }
    }

    return { ok: true, data: parsed };
  } catch (e) {
    return describeError(e);
  }
}

async function resolveContactName(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  userId: string,
  contactId?: string,
): Promise<string> {
  if (!contactId) return 'the user';
  const { data } = await admin
    .from('contacts')
    .select('display_name')
    .eq('id', contactId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data?.display_name as string) ?? 'the user';
}

/** Build a compact style brief for prompt injection. */
export async function loadStyleBrief(userId: string, contactId?: string) {
  const admin = createSupabaseAdminClient();

  const { data: global } = await admin
    .from('user_style_profiles')
    .select('tone, formality, emoji_usage, humour, vocabulary_notes, signature_phrases, punctuation_habits, average_message_length')
    .eq('user_id', userId)
    .maybeSingle();

  let contactStyle: string | null = null;
  let relationship: string | null = null;
  let relationshipDetail: string | null = null;

  if (contactId) {
    const { data: c } = await admin
      .from('contacts')
      .select('communication_style, relationship, relationship_detail')
      .eq('id', contactId)
      .eq('user_id', userId)
      .maybeSingle();
    contactStyle = (c?.communication_style as string) ?? null;
    relationship = (c?.relationship as string) ?? null;
    relationshipDetail = (c?.relationship_detail as string) ?? null;
  }

  const lines: string[] = [];
  if (global) {
    lines.push(`Overall: ${global.tone ?? 'unknown'} tone, ${global.formality ?? 'unknown'} formality.`);
    if (global.emoji_usage) lines.push(`Emoji: ${global.emoji_usage}.`);
    if (global.humour && global.humour !== 'none observed') lines.push(`Humour: ${global.humour}.`);
    if (global.punctuation_habits) lines.push(`Punctuation: ${global.punctuation_habits}.`);
    if (global.vocabulary_notes) lines.push(`Vocabulary: ${global.vocabulary_notes}.`);
    const phrases = (global.signature_phrases as string[] | null) ?? [];
    if (phrases.length) lines.push(`Recurring phrases: ${phrases.join(', ')}.`);
    if (global.average_message_length) lines.push(`Typical length: ~${global.average_message_length} words.`);
  }
  if (contactStyle) lines.push(`With this contact specifically: ${contactStyle}.`);

  return {
    brief: lines.length ? lines.join('\n') : 'No style profile yet — infer the style from the transcript.',
    relationship,
    relationshipDetail,
  };
}

// ─────────────────────── Reply generation ───────────────────────

export type ReplySuggestion = { text: string; angle: string };

export async function generateReplies(params: {
  userId: string;
  conversationId: string;
  count?: number;
  instructions?: string | null;
}): Promise<AiOutcome<ReplySuggestion[]>> {
  const cred = await getActiveCredentialForUser(params.userId);
  if (!cred) return noCredential();

  const admin = createSupabaseAdminClient();

  const { data: conv } = await admin
    .from('conversations')
    .select('contact_id, title')
    .eq('id', params.conversationId)
    .eq('user_id', params.userId)
    .maybeSingle();

  if (!conv) {
    return { ok: false, reason: 'bad_output', message: 'Conversation not found.' };
  }

  const contactId = conv.contact_id as string;
  const transcriptLines = await loadTranscript(admin, params.userId, params.conversationId, 120);

  if (transcriptLines.length === 0) {
    return { ok: false, reason: 'bad_output', message: 'This conversation has no messages to reply to.' };
  }

  const { brief, relationship, relationshipDetail } = await loadStyleBrief(params.userId, contactId);

  try {
    const result = await callProvider(
      cred,
      replyPrompt({
        transcript: renderTranscript(transcriptLines, 120),
        contactName: (conv.title as string) ?? 'them',
        relationship,
        relationshipDetail,
        style: brief,
        userInstructions: params.instructions ?? null,
        count: params.count ?? 3,
      }),
      { temperature: 0.8, maxTokens: 800 },
    );

    const parsed = parseJsonResponse<{ replies: ReplySuggestion[] }>(result.text);
    if (!parsed?.replies?.length) {
      return { ok: false, reason: 'bad_output', message: 'The model did not return usable replies. Try regenerating.' };
    }

    return {
      ok: true,
      data: parsed.replies
        .filter((r) => typeof r?.text === 'string' && r.text.trim().length > 0)
        .slice(0, params.count ?? 3),
    };
  } catch (e) {
    return describeError(e);
  }
}

// ─────────────────────── Memory extraction ───────────────────────

/** Content tokens for near-duplicate detection. */
function memoryTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * A memory we already hold in different words.
 *
 * The model re-extracts the same fact each run in slightly different phrasing
 * ("the user plans to visit home next weekend" / "…visit their parents next
 * weekend"). The unique index on md5(normalized) only stops exact repeats, so
 * without this the memory list fills with paraphrases of one fact.
 */
const DUPLICATE_THRESHOLD = 0.6;


/**
 * Coerce a model-supplied date into something a Postgres `date` column accepts.
 * Models return partial dates ("2025-02", "2025") and prose ("next February").
 * Slicing those to 10 chars produced "2025-02", which fails the insert and used
 * to take the whole batch down with it.
 */
function normalizeEventDate(input: string | null | undefined): string | null {
  if (!input || typeof input !== 'string') return null;
  const v = input.trim();
  if (!v) return null;

  // Full date — the only case we trust verbatim.
  const full = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (full) return `${full[1]}-${full[2]}-${full[3]}`;

  // Year-month → first of that month.
  const ym = v.match(/^(\d{4})-(\d{2})$/);
  if (ym) return `${ym[1]}-${ym[2]}-01`;

  // Bare year → first of January.
  const y = v.match(/^(\d{4})$/);
  if (y) return `${y[1]}-01-01`;

  // Anything else is a guess we cannot safely store.
  return null;
}


export type ExtractedMemory = {
  kind: 'fact' | 'preference' | 'event' | 'topic' | 'promise' | 'relationship';
  content: string;
  confidence: number;
  // No provenance field: the model does not get to certify its own output.
  eventDate: string | null;
};

export async function extractMemories(params: {
  userId: string;
  conversationId: string;
}): Promise<AiOutcome<{ inserted: number; skipped: number }>> {
  const cred = await getActiveCredentialForUser(params.userId);
  if (!cred) return noCredential();

  const admin = createSupabaseAdminClient();

  const { data: conv } = await admin
    .from('conversations')
    .select('contact_id, title')
    .eq('id', params.conversationId)
    .eq('user_id', params.userId)
    .maybeSingle();

  if (!conv) return { ok: false, reason: 'bad_output', message: 'Conversation not found.' };

  const lines = await loadTranscript(admin, params.userId, params.conversationId, 300);
  if (lines.length < 4) {
    return { ok: false, reason: 'bad_output', message: 'Not enough messages to extract memories from.' };
  }

  try {
    const result = await callProvider(
      cred,
      memoryPrompt({
        transcript: renderTranscript(lines, 300),
        contactName: (conv.title as string) ?? 'the contact',
        today: new Date().toISOString().slice(0, 10),
      }),
      { temperature: 0.2, maxTokens: 1200 },
    );

    const parsed = parseJsonResponse<{ memories: ExtractedMemory[] }>(result.text);
    if (!parsed) {
      return { ok: false, reason: 'bad_output', message: 'Could not read the extraction output. Try again.' };
    }

    const memories = (parsed.memories ?? []).filter(
      (m) => typeof m?.content === 'string' && m.content.trim().length > 3,
    );

    // Load what we already know so paraphrases can be dropped before insert.
    const { data: existing } = await admin
      .from('memories')
      .select('normalized')
      .eq('user_id', params.userId);

    const known: Set<string>[] = (existing ?? []).map((m) => memoryTokens(m.normalized as string));

    let duplicateCount = 0;

    // One round-trip for the whole batch instead of one per memory. With 20
    // extracted memories the old loop meant 20 sequential inserts (~20x the
    // latency) before the user saw anything.
    const rows = memories.filter((m) => {
      const tokens = memoryTokens(m.content);
      const dupe = known.some((k) => jaccard(tokens, k) >= DUPLICATE_THRESHOLD);
      if (dupe) {
        duplicateCount++;
        return false;
      }
      // Also compare against rows accepted earlier in this same batch, so the
      // model repeating itself once is not stored twice.
      known.push(tokens);
      return true;
    }).map((m) => ({
      user_id: params.userId,
      contact_id: conv.contact_id,
      conversation_id: params.conversationId,
      kind: m.kind ?? 'fact',
      content: m.content.trim(),
      normalized: m.content.trim().toLowerCase().replace(/\s+/g, ' '),
      confidence: Math.min(1, Math.max(0, Number(m.confidence) || 0.5)),
      // Always "inferred". Only the user can promote a memory to confirmed
      // (see /memory → Confirm), because "confirmed" means "I checked this",
      // not "the model felt sure". The prompt no longer even asks for it.
      provenance: 'inferred' as const,
      event_date: normalizeEventDate(m.eventDate),
    }));

    if (rows.length === 0) {
      return { ok: true, data: { inserted: 0, skipped: duplicateCount } };
    }

    // ignoreDuplicates turns a re-extraction of the same memory into a no-op,
    // which is what the unique index on md5(normalized) enforced per-row before.
    const { data: written, error: insertError } = await admin
      .from('memories')
      .insert(rows)
      .select('id');

    if (insertError) {
      // A duplicate (23505) or one malformed row must not discard the whole
      // batch. Fall back to per-row writes so the user still gets everything
      // that is valid — the batch is an optimisation, not a correctness
      // guarantee.
      let inserted = 0;
      let skipped = 0;
      let lastError: string | null = null;
      for (const row of rows) {
        const { error } = await admin.from('memories').insert(row);
        if (error?.code === '23505') skipped++;
        else if (!error) inserted++;
        else lastError = error.message;
      }
      if (inserted === 0 && lastError) {
        return { ok: false, reason: 'bad_output', message: `Could not save memories: ${lastError}` };
      }
      return { ok: true, data: { inserted, skipped: duplicateCount + skipped } };
    }

    const inserted = written?.length ?? rows.length;
    return { ok: true, data: { inserted, skipped: duplicateCount + (rows.length - inserted) } };
  } catch (e) {
    return describeError(e);
  }
}
