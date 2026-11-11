import 'server-only';
import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { decryptSecret } from '@/lib/crypto';
import { getProvider, ProviderError, type ProviderId } from './providers';

export type ActiveCredential = {
  id: string;
  provider: ProviderId;
  model: string;
  baseUrl: string | null;
  apiKey: string;
};

/**
 * Resolve the calling user's active AI credential, decrypted, server-side only.
 *
 * Ownership is enforced twice: the RLS-scoped read confirms the row belongs to
 * this user, and the service-role fetch is pinned with .eq('user_id', userId).
 * A user can never be handed another user's key.
 */
export async function getActiveCredentialForUser(userId: string): Promise<ActiveCredential | null> {
  const admin = createSupabaseAdminClient();

  const { data, error } = await admin
    .from('ai_credentials')
    .select('id, provider, model, base_url, ciphertext, iv, auth_tag')
    .eq('user_id', userId) // ← explicit owner pin; RLS is bypassed here
    .eq('is_active', true)
    .eq('status', 'valid')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  return {
    id: data.id as string,
    provider: data.provider as ProviderId,
    model: data.model as string,
    baseUrl: (data.base_url as string | null) ?? null,
    apiKey: decryptSecret({
      ciphertext: data.ciphertext as string,
      iv: data.iv as string,
      auth_tag: data.auth_tag as string,
    }),
  };
}

/** Does the current user have a usable AI credential? Used by middleware/guards. */
export async function hasValidCredential(): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const { count } = await supabase
    .from('ai_credentials')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('is_active', true)
    .eq('status', 'valid');

  return (count ?? 0) > 0;
}

/**
 * Run a one-off provider call with the user's key.
 * Never logs the key; callers must pass the decrypted key straight through.
 */
/**
 * Call the user's provider, retrying transient failures.
 *
 * Observed in practice: Gemini returns 503 "high demand" and occasional 5xx
 * under normal use. Without a retry the user sees a hard failure for something
 * that succeeds 500ms later. Only transient kinds are retried — an invalid key
 * or an exhausted quota must fail immediately, not hammer the provider.
 */
export async function callProvider(
  credential: ActiveCredential,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  opts: { temperature?: number; maxTokens?: number; attempts?: number } = {},
) {
  const provider = getProvider(credential.provider);
  const attempts = opts.attempts ?? 3;

  const req = {
    key: credential.apiKey,
    model: credential.model,
    baseUrl: credential.baseUrl ?? undefined,
    messages,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await provider.chat(req);
    } catch (e) {
      lastError = e;
      const retryable =
        e instanceof ProviderError && (e.kind === 'provider_error' || e.kind === 'rate_limited');

      if (!retryable || attempt === attempts) throw e;

      // Exponential backoff with jitter: ~600ms, ~1.5s.
      const delay = 600 * 2 ** (attempt - 1) + Math.random() * 250;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
