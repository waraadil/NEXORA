'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  semanticSearch,
  embedMissingMessages,
  getEmbeddingCredential,
  NoEmbeddingProviderError,
  type SemanticHit,
  type EmbedProgress,
} from '@/lib/ai/semantic';

async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

export type KeywordHit = {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  contactName: string | null;
  body: string;
  sentAt: string | null;
  isFromMe: boolean;
};

export type SearchState =
  | {
      query: string;
      mode: 'semantic' | 'keyword_only' | 'keyword';
      notice?: string;
      semanticHits: SemanticHit[];
      keywordHits: KeywordHit[];
      model?: string;
      error?: string;
    }
  | null;

/**
 * Search across message history.
 *
 * `mode` is always reported honestly:
 *   semantic      — vectors were used
 *   keyword_only  — user asked for semantic, but their provider cannot embed
 *   keyword       — user chose keyword search
 * A silent downgrade would let someone believe a weak result was semantic.
 */
export async function runSearch(_prev: SearchState, formData: FormData): Promise<SearchState> {
  const { supabase, user } = await requireUser();
  if (!user) return { query: '', mode: 'keyword', semanticHits: [], keywordHits: [], error: 'Session expired. Sign in again.' };

  const query = String(formData.get('q') ?? '').trim();
  const wantSemantic = formData.get('semantic') === 'on';
  const contactId = String(formData.get('contactId') ?? '').trim() || undefined;

  if (query.length < 2) {
    return {
      query,
      mode: 'keyword',
      semanticHits: [],
      keywordHits: [],
      error: 'Type at least two characters.',
    };
  }

  // Keyword pass always runs — it is fast and catches exact names/numbers that
  // embeddings can miss.
  let kwQuery = supabase
    .from('messages')
    .select('id, conversation_id, body, sent_at, is_from_me, conversations!inner(title, contacts(display_name))')
    .eq('user_id', user.id)
    .ilike('body', `%${query.replace(/[%_]/g, '')}%`)
    .order('sent_at', { ascending: false })
    .limit(25);

  if (contactId) kwQuery = kwQuery.eq('conversations.contact_id', contactId);

  const { data: kw } = await kwQuery;

  const keywordHits: KeywordHit[] = (kw ?? []).map((r) => {
    const conv = Array.isArray(r.conversations) ? r.conversations[0] : r.conversations;
    const contact = Array.isArray(conv?.contacts) ? conv?.contacts[0] : conv?.contacts;
    return {
      messageId: r.id as string,
      conversationId: r.conversation_id as string,
      conversationTitle: (conv?.title as string) ?? 'Untitled',
      contactName: (contact?.display_name as string) ?? null,
      body: r.body as string,
      sentAt: (r.sent_at as string | null) ?? null,
      isFromMe: r.is_from_me as boolean,
    };
  });

  if (!wantSemantic) {
    return { query, mode: 'keyword', semanticHits: [], keywordHits };
  }

  const cred = await getEmbeddingCredential(user.id);
  if (!cred) {
    return {
      query,
      mode: 'keyword_only',
      notice: new NoEmbeddingProviderError().message,
      semanticHits: [],
      keywordHits,
    };
  }

  try {
    const result = await semanticSearch(user.id, query, { contactId, limit: 25 });
    if (!result) {
      return {
        query,
        mode: 'keyword_only',
        notice: new NoEmbeddingProviderError().message,
        semanticHits: [],
        keywordHits,
      };
    }

    return {
      query,
      mode: 'semantic',
      semanticHits: result.hits,
      keywordHits,
      model: result.model,
      notice:
        result.hits.length === 0
          ? 'No semantically similar messages yet. If you have not indexed your history, do that first.'
          : undefined,
    };
  } catch (e) {
    return {
      query,
      mode: 'keyword',
      semanticHits: [],
      keywordHits,
      error: (e as Error).message || 'Semantic search failed. Showing keyword results.',
    };
  }
}

export type IndexState =
  | { ok: true; progress: EmbedProgress; message: string }
  | { ok: false; message: string }
  | null;

/** Backfill vectors for messages that don't have them yet. Idempotent. */
export async function indexHistory(_prev: IndexState, _formData: FormData): Promise<IndexState> {
  const { user } = await requireUser();
  if (!user) return { ok: false, message: 'Session expired. Sign in again.' };

  try {
    const progress = await embedMissingMessages(user.id, { limit: 400 });

    revalidatePath('/conversations');

    if (progress.attempted === 0) {
      return { ok: true, progress, message: 'Everything is already indexed.' };
    }
    if (progress.failed > 0 && progress.embedded === 0) {
      return {
        ok: false,
        message: `Embedding failed for ${progress.failed} messages. Check your key and provider quota.`,
      };
    }

    return {
      ok: true,
      progress,
      message: `Indexed ${progress.embedded} of ${progress.attempted} messages${
        progress.failed > 0 ? ` · ${progress.failed} failed` : ''
      }.`,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message || 'Indexing failed.' };
  }
}

export async function embeddingAvailability(): Promise<boolean> {
  const { user } = await requireUser();
  if (!user) return false;
  return (await getEmbeddingCredential(user.id)) !== null;
}

/**
 * Turn AI auto-reply on or off for ONE person.
 *
 * Deliberately per-conversation rather than a global switch with exceptions,
 * because the failure mode of the other design is a bot speaking to a stranger.
 * Groups can never be switched on, and the check happens server-side so the UI
 * cannot be talked into it.
 */
export async function setConversationAutoReply(formData: FormData): Promise<void> {
  const { supabase, user } = await requireUser();
  if (!user) return;

  const conversationId = String(formData.get('conversationId') ?? '').trim();
  const mode = String(formData.get('mode') ?? '') === 'on' ? 'on' : 'off';
  if (!conversationId) return;

  // Read first: a group must be refused even if a crafted request says 'on',
  // and clearing a paused chat is only right when the user is re-enabling it.
  const { data: conv } = await supabase
    .from('conversations')
    .select('id, is_group')
    .eq('id', conversationId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!conv || conv.is_group) return;

  const { error } = await supabase
    .from('conversations')
    .update({
      auto_reply_mode: mode,
      // Re-enabling after a rate-limit pause should actually resume; leaving the
      // pause set would make the toggle look broken.
      auto_reply_paused_at: mode === 'on' ? null : undefined,
      auto_reply_paused_reason: mode === 'on' ? null : undefined,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
    .eq('user_id', user.id);

  if (error) return;

  revalidatePath('/conversations');
  revalidatePath(`/conversations/${conversationId}`);
}
