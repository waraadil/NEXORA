'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createSupabaseServerClient, createSupabaseAdminClient } from '@/lib/supabase/server';
import { encryptSecret, decryptSecret, redactSecrets } from '@/lib/crypto';
import { PROVIDERS, getProvider, type ErrorKind, type ProviderId } from '@/lib/ai/providers';

export type SettingsState =
  | { error?: string; success?: string; fieldErrors?: Record<string, string> }
  | null;

async function currentUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

function isProviderId(v: string): v is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, v);
}

/** Stored status mirrors the failure kind so Settings can render an accurate badge. */
function statusFor(kind: ErrorKind): string {
  switch (kind) {
    case 'invalid_key':
      return 'invalid';
    case 'insufficient_quota':
      return 'quota_exhausted';
    case 'rate_limited':
      return 'rate_limited';
    default:
      return 'error';
  }
}

export async function updateProfile(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const user = await currentUser();
  if (!user) return { error: 'Session expired. Sign in again.' };

  const parsed = z
    .object({
      displayName: z.string().trim().min(1, 'Name is required').max(80),
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

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('profiles')
    .upsert(
      { id: user.id, display_name: parsed.data.displayName, timezone: parsed.data.timezone },
      { onConflict: 'id' },
    );

  if (error) return { error: 'Could not save your profile.' };

  revalidatePath('/settings');
  revalidatePath('/dashboard');
  return { success: 'Profile updated.' };
}

/**
 * Add or replace an AI credential.
 * The key is validated against the provider's real API *before* it is persisted,
 * so an invalid key never reaches the database.
 */
export async function saveAiCredential(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const user = await currentUser();
  if (!user) return { error: 'Session expired. Sign in again.' };

  const providerId = String(formData.get('provider') ?? '').trim();
  const model = String(formData.get('model') ?? '').trim();
  const apiKey = String(formData.get('apiKey') ?? '').trim();
  const baseUrl = String(formData.get('baseUrl') ?? '').trim();

  if (!isProviderId(providerId)) {
    return { fieldErrors: { provider: 'Choose a supported provider.' } };
  }
  if (!model) return { fieldErrors: { model: 'Choose a model.' } };
  if (apiKey.length < 16) return { fieldErrors: { apiKey: 'That key looks too short — paste the full key.' } };
  if (apiKey.length > 500) return { fieldErrors: { apiKey: 'That looks too long to be an API key.' } };
  if (PROVIDERS[providerId].requiresBaseUrl && !baseUrl) {
    return { fieldErrors: { baseUrl: 'A base URL is required for a custom endpoint.' } };
  }
  if (baseUrl && !/^https:\/\//i.test(baseUrl)) {
    return { fieldErrors: { baseUrl: 'Use an https:// URL.' } };
  }
  if (baseUrl && !PROVIDERS[providerId].requiresBaseUrl) {
    return { fieldErrors: { baseUrl: 'This provider has a fixed endpoint — leave the base URL blank.' } };
  }

  const provider = getProvider(providerId);

  let validation;
  try {
    validation = await provider.validate(apiKey, baseUrl || undefined);
  } catch (e) {
    return { error: redactSecrets((e as Error).message ?? 'The provider could not be reached.', [apiKey]) };
  }

  if (!validation.ok) {
    // Never echo the key back, even inside an error string.
    return { error: redactSecrets(validation.message, [apiKey]) };
  }

  const admin = createSupabaseAdminClient();
  const enc = encryptSecret(apiKey);

  // Exactly one active credential: deactivate the rest first.
  await admin.from('ai_credentials').update({ is_active: false }).eq('user_id', user.id);

  const { error } = await admin.from('ai_credentials').upsert(
    {
      user_id: user.id,
      provider: providerId,
      model,
      base_url: baseUrl || null,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      auth_tag: enc.authTag,
      key_last4: enc.last4,
      key_fingerprint: enc.fingerprint,
      status: 'valid',
      last_error: null,
      last_validated_at: new Date().toISOString(),
      is_active: true,
    },
    { onConflict: 'user_id,provider,model' },
  );

  if (error) return { error: 'The key was valid but could not be saved. Try again.' };

  revalidatePath('/settings');
  revalidatePath('/settings/ai');
  revalidatePath('/dashboard');
  return { success: `${provider.name} · ${model} validated and saved, encrypted at rest.` };
}

/** Re-run the live validation against the stored key. */
export async function testCredential(
  credentialId: string,
  _prev: SettingsState,
  _formData: FormData,
): Promise<SettingsState> {
  const user = await currentUser();
  if (!user) return { error: 'Session expired. Sign in again.' };

  const admin = createSupabaseAdminClient();
  const { data: cred } = await admin
    .from('ai_credentials')
    .select('id, provider, model, base_url, ciphertext, iv, auth_tag')
    .eq('id', credentialId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!cred) return { error: 'That credential no longer exists.' };

  let ok = false;
  let message = '';

  try {
    const key = decryptSecret({ ciphertext: cred.ciphertext, iv: cred.iv, auth_tag: cred.auth_tag });
    const result = await getProvider(cred.provider as ProviderId).validate(key, cred.base_url ?? undefined);
    ok = result.ok;
    message = result.ok ? result.detail : result.message;

    await admin
      .from('ai_credentials')
      .update({
        status: result.ok ? 'valid' : statusFor(result.kind),
        last_error: result.ok ? null : redactSecrets(result.message),
        last_validated_at: new Date().toISOString(),
        ...(result.ok ? { is_active: true } : {}),
      })
      .eq('id', credentialId)
      .eq('user_id', user.id);
  } catch (e) {
    message = redactSecrets((e as Error).message || 'Could not decrypt the stored key.');
    await admin
      .from('ai_credentials')
      .update({ status: 'error', last_error: message, last_validated_at: new Date().toISOString() })
      .eq('id', credentialId)
      .eq('user_id', user.id);
  }

  revalidatePath('/settings/ai');
  revalidatePath('/settings');
  return ok ? { success: message || 'Connection works.' } : { error: message || 'Connection failed.' };
}

export async function deleteCredential(
  credentialId: string,
  _prev: SettingsState,
  _formData: FormData,
): Promise<SettingsState> {
  const user = await currentUser();
  if (!user) return { error: 'Session expired. Sign in again.' };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('ai_credentials')
    .delete()
    .eq('id', credentialId)
    .eq('user_id', user.id);

  if (error) return { error: 'Could not remove that credential.' };

  revalidatePath('/settings');
  revalidatePath('/settings/ai');
  revalidatePath('/dashboard');
  return { success: 'Credential removed. AI features are paused until you add another key.' };
}

/**
 * Delete the account and every row it owns.
 * Auth deletion cascades through all `references auth.users` foreign keys,
 * which is why every table was built with `on delete cascade`.
 */
export async function deleteAccount(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const user = await currentUser();
  if (!user) return { error: 'Session expired.' };

  const confirmation = String(formData.get('confirm') ?? '').trim();
  if (confirmation !== 'DELETE MY ACCOUNT') {
    return { fieldErrors: { confirm: 'Type DELETE MY ACCOUNT exactly to confirm.' } };
  }

  const admin = createSupabaseAdminClient();

  // Belt and braces: remove data explicitly, then the auth user (which cascades).
  const tables = [
    'whatsapp_outbound',
    'whatsapp_webhook_events',
    'whatsapp_integrations',
    'away_logs',
    'away_rules',
    'away_settings',
    'message_embeddings',
    'memories',
    'messages',
    'conversations',
    'contacts',
    'import_batches',
    'user_style_profiles',
    'ai_credentials',
    'profiles',
  ] as const;

  for (const table of tables) {
    await admin.from(table).delete().eq('user_id', user.id);
  }

  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) return { error: 'Could not delete the account. Contact support.' };

  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  redirect('/?deleted=1');
}
