'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createSupabaseServerClient, createSupabaseAdminClient } from '@/lib/supabase/server';
import { encryptSecret, fingerprint, redactSecrets } from '@/lib/crypto';
import { getProvider, PROVIDERS, type ProviderId } from '@/lib/ai/providers';

export type SetupState =
  | { error?: string; fieldErrors?: Record<string, string>; ok?: boolean; detail?: string }
  | null;

const providerIds = Object.keys(PROVIDERS) as ProviderId[];

const credentialSchema = z.object({
  provider: z.enum(providerIds as [ProviderId, ...ProviderId[]]),
  model: z.string().trim().min(1, 'Choose a model'),
  apiKey: z
    .string()
    .trim()
    .min(16, 'That key looks too short')
    .max(400, 'That key looks too long'),
  baseUrl: z.string().trim().url('Enter a valid URL').optional().or(z.literal('')),
});

/**
 * Validate a user-supplied provider key against the real provider API,
 * then store it AES-256-GCM encrypted. The plaintext key is never persisted,
 * never logged, and never returned to the client.
 */
export async function saveAiCredential(
  _prev: SetupState,
  formData: FormData,
): Promise<SetupState> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { error: 'Your session expired. Sign in again.' };

  const parsed = credentialSchema.safeParse({
    provider: formData.get('provider'),
    model: formData.get('model'),
    apiKey: formData.get('apiKey'),
    baseUrl: (formData.get('baseUrl') as string) || undefined,
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = issue.message;
    return { fieldErrors };
  }

  const { provider, model, apiKey, baseUrl } = parsed.data;

  if (provider === 'openai_compatible' && !baseUrl) {
    return { fieldErrors: { baseUrl: 'A base URL is required for a custom endpoint.' } };
  }

  // ── Real validation call against the provider ──
  let validation;
  try {
    validation = await getProvider(provider).validate(apiKey, baseUrl || undefined);
  } catch (e) {
    return { error: redactSecrets(`Validation failed: ${(e as Error).message}`, [apiKey]) };
  }

  const status = validation.ok
    ? 'valid'
    : validation.kind === 'insufficient_quota'
      ? 'quota_exhausted'
      : validation.kind === 'rate_limited'
        ? 'rate_limited'
        : validation.kind === 'invalid_key'
          ? 'invalid'
          : 'error';

  const admin = createSupabaseAdminClient();
  const encrypted = encryptSecret(apiKey);

  const { error: upsertError } = await admin.from('ai_credentials').upsert(
    {
      user_id: user.id,
      provider,
      model,
      base_url: baseUrl || null,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      auth_tag: encrypted.authTag,
      key_last4: encrypted.last4,
      key_fingerprint: fingerprint(apiKey),
      status,
      last_error: validation.ok ? null : redactSecrets(validation.message, [apiKey]),
      last_validated_at: new Date().toISOString(),
      is_active: true,
    },
    { onConflict: 'user_id,provider,model' },
  );

  if (upsertError) {
    // Never surface raw DB errors — they can contain row fragments.
    return { error: 'Could not save the credential. Please try again.' };
  }

  if (!validation.ok) {
    return { error: redactSecrets(validation.message, [apiKey]) };
  }

  revalidatePath('/onboarding');
  return { ok: true, detail: validation.detail };
}

/** Step 3: profile details. Marks the account onboarded once a key is valid. */
export async function completeProfile(
  _prev: SetupState,
  formData: FormData,
): Promise<SetupState> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Your session expired. Sign in again.' };

  const parsed = z
    .object({
      displayName: z.string().trim().min(1, 'Tell us what to call you').max(80),
      timezone: z.string().trim().min(1).max(64),
    })
    .safeParse({
      displayName: formData.get('displayName'),
      timezone: formData.get('timezone'),
    });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = issue.message;
    return { fieldErrors };
  }

  // Gate: a profile cannot be completed without a validated AI credential.
  const { count } = await supabase
    .from('ai_credentials')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('status', 'valid')
    .eq('is_active', true);

  if (!count) {
    return { error: 'Connect and validate an AI provider before continuing.' };
  }

  const { error } = await supabase
    .from('profiles')
    .update({
      display_name: parsed.data.displayName,
      timezone: parsed.data.timezone,
      onboarded_at: new Date().toISOString(),
    })
    .eq('id', user.id);

  if (error) return { error: 'Could not save your profile.' };

  revalidatePath('/', 'layout');
  return { ok: true };
}

/** Re-run a validation against a stored key without re-entering it. */
export async function retestCredential(credentialId: string): Promise<SetupState> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Session expired.' };

  const { getActiveCredentialForUser } = await import('@/lib/ai/credentials');
  const cred = await getActiveCredentialForUser(user.id);
  if (!cred) return { error: 'No active credential found.' };

  void credentialId;
  const result = await getProvider(cred.provider).validate(cred.apiKey, cred.baseUrl ?? undefined);

  const admin = createSupabaseAdminClient();
  await admin
    .from('ai_credentials')
    .update({
      status: result.ok ? 'valid' : 'error',
      last_error: result.ok ? null : redactSecrets(result.message, [cred.apiKey]),
      last_validated_at: new Date().toISOString(),
    })
    .eq('id', cred.id)
    .eq('user_id', user.id);

  revalidatePath('/settings/ai');
  return result.ok ? { ok: true, detail: result.detail } : { error: result.message };
}
