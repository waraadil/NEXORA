import 'server-only';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { createHash } from 'node:crypto';
import { getActiveCredentialForUser, type ActiveCredential } from './credentials';
import { getProvider } from './providers';

/**
 * Semantic search over message history.
 *
 * Design constraints that shaped this file:
 *  - A user may hold a chat model key with no embedding capability (e.g. Anthropic).
 *    We then report `no_embedding_provider` instead of silently degrading to a
 *    keyword-only result the user would wrongly believe was semantic.
 *  - Embeddings are pinned to the credential that produced them (`credential_id`),
 *    because vectors from different models live in different spaces and are not
 *    comparable. `match_messages` filters on that column for exactly this reason.
 *  - Nothing here is simulated: no vectors are invented, and a failed embed throws.
 */

export type EmbeddingCredential = ActiveCredential & { embeddingModel: string };

const EMBED_BATCH = 64;

/**
 * Resolve a credential that can actually embed. Returns null when the provider has
 * no embedding support — the caller must surface that, not paper over it.
 */
export async function getEmbeddingCredential(userId: string): Promise<EmbeddingCredential | null> {
  const cred = await getActiveCredentialForUser(userId);
  if (!cred) return null;

  const provider = getProvider(cred.provider);
  if (!provider.embed) return null;

  // Prefer a dedicated embedding model on the same provider.
  const embeddingModel =
    provider.models.find((m) => m.supportsEmbeddings)?.id ?? cred.model;

  if (!provider.models.some((m) => m.supportsEmbeddings)) return null;

  return { ...cred, embeddingModel };
}

/** Stable content hash so re-embedding an unchanged message is a no-op. */
function contentHash(body: string): string {
  return createHash('sha256').update(body.trim()).digest('hex').slice(0, 32);
}

export async function embedQuery(text: string, cred: EmbeddingCredential): Promise<number[]> {
  const provider = getProvider(cred.provider);
  if (!provider.embed) throw new Error('Provider cannot embed.');

  const { vectors } = await provider.embed({
    key: cred.apiKey,
    model: cred.embeddingModel,
    input: [text],
    baseUrl: cred.baseUrl ?? undefined,
  });

  const vector = vectors[0];
  if (!vector || vector.length === 0) {
    throw new Error('Provider returned an empty embedding.');
  }
  return vector;
}

/** Raised when the user's provider genuinely cannot embed — surfaced, never faked. */
export class NoEmbeddingProviderError extends Error {
  constructor() {
    super(
      'Your current AI provider has no embedding model, so semantic search is unavailable. ' +
        'Add an OpenAI or Google credential (or an OpenAI-compatible embedding endpoint) to enable it.',
    );
    this.name = 'NoEmbeddingProviderError';
  }
}

export type EmbedProgress = {
  attempted: number;
  embedded: number;
  skipped: number;
  failed: number;
  batches: number;
};

/**
 * Embed messages that don't yet have a vector for this credential.
 * Idempotent: the unique index on (message_id, credential_id) stops duplicates.
 */
export async function embedMissingMessages(
  userId: string,
  options: { limit?: number; onProgress?: (p: EmbedProgress) => void } = {},
): Promise<EmbedProgress> {
  const admin = createSupabaseAdminClient();
  const cred = await getEmbeddingCredential(userId);

  if (!cred) {
    throw new NoEmbeddingProviderError();
  }

  const provider = getProvider(cred.provider);
  const max = options.limit ?? 400;

  // Messages with no vector for this credential yet.
  const { data: already } = await admin
    .from('message_embeddings')
    .select('message_id')
    .eq('user_id', userId)
    .eq('credential_id', cred.id);

  const done = new Set((already ?? []).map((r) => r.message_id as string));

  const { data: messages, error } = await admin
    .from('messages')
    .select('id, body')
    .eq('user_id', userId)
    .not('body', 'is', null)
    .order('sent_at', { ascending: false })
    .limit(max + done.size);

  if (error) throw new Error('Could not read messages to embed.');

  const todo = (messages ?? [])
    .filter((m) => !done.has(m.id as string))
    .filter((m) => String(m.body ?? '').trim().length >= 3)
    .slice(0, max);

  const progress: EmbedProgress = {
    attempted: todo.length,
    embedded: 0,
    skipped: 0,
    failed: 0,
    batches: 0,
  };

  if (todo.length === 0) return progress;

  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    const batch = todo.slice(i, i + EMBED_BATCH);
    progress.batches++;

    try {
      const { vectors, model } = await provider.embed!({
        key: cred.apiKey,
        model: cred.embeddingModel,
        input: batch.map((m) => String(m.body).slice(0, 8000)),
        baseUrl: cred.baseUrl ?? undefined,
      });

      const rows = batch
        .map((m, idx) => {
          const vec = vectors[idx];
          if (!vec || vec.length === 0) return null;
          return {
            user_id: userId,
            message_id: m.id as string,
            conversation_id: null as string | null,
            embedding: JSON.stringify(vec),
            model,
            credential_id: cred.id,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      // conversation_id is denormalised for cheaper filtering; fill it per batch.
      const ids = rows.map((r) => r.message_id);
      const { data: convs } = await admin
        .from('messages')
        .select('id, conversation_id')
        .in('id', ids);

      const convMap = new Map((convs ?? []).map((c) => [c.id as string, c.conversation_id as string]));
      for (const r of rows) r.conversation_id = convMap.get(r.message_id) ?? null;

      const { error: insErr } = await admin
        .from('message_embeddings')
        .upsert(rows, { onConflict: 'message_id,credential_id', ignoreDuplicates: true });

      if (insErr) {
        progress.failed += batch.length;
      } else {
        progress.embedded += rows.length;
        progress.skipped += batch.length - rows.length;
      }
    } catch {
      progress.failed += batch.length;
    }

    options.onProgress?.(progress);
  }

  return progress;
}

export type SemanticHit = {
  messageId: string;
  conversationId: string;
  contactId: string | null;
  contactName: string | null;
  body: string;
  sentAt: string | null;
  isFromMe: boolean;
  similarity: number;
};

/**
 * Vector search. Returns null when no embedding-capable credential exists, so the
 * UI can say "keyword only, and here's why" rather than pretending it searched.
 */
export async function semanticSearch(
  userId: string,
  query: string,
  options: { contactId?: string; limit?: number; minSimilarity?: number } = {},
): Promise<{ hits: SemanticHit[]; model: string } | null> {
  const cred = await getEmbeddingCredential(userId);
  if (!cred) return null;

  const vector = await embedQuery(query, cred);

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc('match_messages', {
    p_user_id: userId,
    p_credential_id: cred.id,
    p_query: JSON.stringify(vector),
    p_contact_id: options.contactId ?? null,
    p_limit: options.limit ?? 20,
    p_min_similarity: options.minSimilarity ?? 0.3,
  });

  if (error) throw new Error('Semantic search failed.');

  const hits = (data ?? []).map((r: Record<string, unknown>) => ({
    messageId: r.message_id as string,
    conversationId: r.conversation_id as string,
    contactId: (r.contact_id as string | null) ?? null,
    contactName: (r.contact_name as string | null) ?? null,
    body: r.body as string,
    sentAt: (r.sent_at as string | null) ?? null,
    isFromMe: r.is_from_me as boolean,
    similarity: Number(r.similarity),
  }));

  return { hits, model: cred.embeddingModel };
}

export { contentHash };
