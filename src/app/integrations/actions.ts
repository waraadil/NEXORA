'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { createSupabaseServerClient, createSupabaseAdminClient } from '@/lib/supabase/server';
import { encryptSecret, redactSecrets } from '@/lib/crypto';
import { verifyCredentials } from '@/lib/whatsapp/cloud-api';
import { revokeRelay } from '@/lib/whatsapp/relay';

export type IntegrationState =
  | { error?: string; success?: string; fieldErrors?: Record<string, string> }
  | null;

async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** Connect an official WhatsApp Business number via Cloud API. */
export async function connectCloudApi(
  _prev: IntegrationState,
  formData: FormData,
): Promise<IntegrationState> {
  const user = await requireUser();
  if (!user) return { error: 'Session expired. Sign in again.' };

  const parsed = z
    .object({
      phoneNumberId: z.string().trim().min(5, 'Phone number ID is required'),
      wabaId: z.string().trim().optional(),
      accessToken: z.string().trim().min(20, 'Access token is required'),
      appSecret: z.string().trim().min(10, 'App secret is required'),
    })
    .safeParse({
      phoneNumberId: formData.get('phoneNumberId'),
      wabaId: formData.get('wabaId') || undefined,
      accessToken: formData.get('accessToken'),
      appSecret: formData.get('appSecret'),
    });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = issue.message;
    return { fieldErrors };
  }

  const { phoneNumberId, wabaId, accessToken, appSecret } = parsed.data;

  // Real Graph API verification before anything is stored.
  const check = await verifyCredentials(phoneNumberId, accessToken);
  if (!check.ok) {
    return {
      error: redactSecrets(`${check.error.message}`, [accessToken, appSecret]),
    };
  }

  const admin = createSupabaseAdminClient();
  const tokenEnc = encryptSecret(accessToken);
  const secretEnc = encryptSecret(appSecret);
  const verifyToken = `nxr_${randomBytes(16).toString('hex')}`;

  const { error } = await admin.from('whatsapp_integrations').upsert(
    {
      user_id: user.id,
      mode: 'cloud_api',
      status: 'connected',
      waba_id: wabaId ?? null,
      phone_number_id: phoneNumberId,
      display_phone: check.displayPhone,
      access_token_ciphertext: tokenEnc.ciphertext,
      access_token_iv: tokenEnc.iv,
      access_token_auth_tag: tokenEnc.authTag,
      app_secret_ciphertext: secretEnc.ciphertext,
      app_secret_iv: secretEnc.iv,
      app_secret_auth_tag: secretEnc.authTag,
      verify_token: verifyToken,
      last_connected_at: new Date().toISOString(),
      last_error: null,
    },
    { onConflict: 'user_id' },
  );

  if (error) return { error: 'Could not save the integration.' };

  revalidatePath('/integrations');
  return {
    success: `Connected ${check.displayPhone || phoneNumberId} as ${check.verifiedName || 'your business'}.`,
  };
}

export async function disableIntegration(): Promise<void> {
  const user = await requireUser();
  if (!user) return;

  const admin = createSupabaseAdminClient();
  await revokeRelay(user.id);

  await admin
    .from('whatsapp_integrations')
    .update({
      status: 'disabled',
      access_token_ciphertext: null,
      access_token_iv: null,
      access_token_auth_tag: null,
      app_secret_ciphertext: null,
      app_secret_iv: null,
      app_secret_auth_tag: null,
      verify_token: null,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', user.id);

  revalidatePath('/integrations');
}
