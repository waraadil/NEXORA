'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createSupabaseServerClient, createSupabaseAdminClient } from '@/lib/supabase/server';
import { generateAwayDraft } from '@/lib/away/mode';
import { sendWhatsAppMessage } from '@/lib/whatsapp/send';

export type AwayState =
  | { error?: string; success?: string; fieldErrors?: Record<string, string> }
  | { draft?: { text: string; logId: string; conversationId: string; canSend: boolean; reason?: string } }
  | null;

async function currentUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function saveAwaySettings(_prev: AwayState, formData: FormData): Promise<AwayState> {
  const user = await currentUser();
  if (!user) return { error: 'Session expired. Sign in again.' };

  const parsed = z
    .object({
      enabled: z.coerce.boolean(),
      startsAt: z.string().optional(),
      endsAt: z.string().optional(),
      defaultInstructions: z.string().trim().max(1000).optional(),
      autoReplyEnabled: z.coerce.boolean(),
      requireApproval: z.coerce.boolean(),
    })
    .safeParse({
      enabled: formData.get('enabled') === 'on',
      startsAt: (formData.get('startsAt') as string) || undefined,
      endsAt: (formData.get('endsAt') as string) || undefined,
      defaultInstructions: (formData.get('defaultInstructions') as string) || undefined,
      autoReplyEnabled: formData.get('autoReplyEnabled') === 'on',
      requireApproval: formData.get('requireApproval') === 'on',
    });

  if (!parsed.success) return { error: 'Check the form values.' };

  const { enabled, startsAt, endsAt, defaultInstructions, autoReplyEnabled, requireApproval } = parsed.data;

  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
    return { fieldErrors: { endsAt: 'End time must be after the start time.' } };
  }

  const admin = createSupabaseAdminClient();
  const { error } = await admin.from('away_settings').upsert(
    {
      user_id: user.id,
      enabled,
      starts_at: startsAt ? new Date(startsAt).toISOString() : null,
      ends_at: endsAt ? new Date(endsAt).toISOString() : null,
      default_instructions: defaultInstructions ?? null,
      auto_reply_enabled: autoReplyEnabled,
      require_approval: requireApproval,
    },
    { onConflict: 'user_id' },
  );

  if (error) return { error: 'Could not save Away Mode settings.' };

  revalidatePath('/away');
  return { success: enabled ? 'Away Mode saved and enabled.' : 'Away Mode saved (currently off).' };
}

export async function setContactRule(_prev: AwayState, formData: FormData): Promise<AwayState> {
  const user = await currentUser();
  if (!user) return { error: 'Session expired.' };

  const parsed = z
    .object({
      contactId: z.string().uuid(),
      enabled: z.coerce.boolean(),
      instructions: z.string().trim().max(500).optional(),
      allowAutoReply: z.coerce.boolean(),
    })
    .safeParse({
      contactId: formData.get('contactId'),
      enabled: formData.get('enabled') === 'on',
      instructions: (formData.get('instructions') as string) || undefined,
      allowAutoReply: formData.get('allowAutoReply') === 'on',
    });

  if (!parsed.success) return { error: 'Pick a contact.' };

  const admin = createSupabaseAdminClient();
  const { error } = await admin.from('away_rules').upsert(
    {
      user_id: user.id,
      contact_id: parsed.data.contactId,
      enabled: parsed.data.enabled,
      instructions: parsed.data.instructions ?? null,
      allow_auto_reply: parsed.data.allowAutoReply,
    },
    { onConflict: 'user_id,contact_id' },
  );

  if (error) return { error: 'Could not save that rule.' };

  revalidatePath('/away');
  return { success: 'Contact rule saved.' };
}

export async function draftAwayReply(_prev: AwayState, formData: FormData): Promise<AwayState> {
  const user = await currentUser();
  if (!user) return { error: 'Session expired.' };

  const conversationId = String(formData.get('conversationId') ?? '');
  if (!conversationId) return { error: 'Pick a conversation.' };

  const admin = createSupabaseAdminClient();
  const { data: conv } = await admin
    .from('conversations')
    .select('contact_id')
    .eq('id', conversationId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!conv) return { error: 'Conversation not found.' };

  const result = await generateAwayDraft({
    userId: user.id,
    conversationId,
    contactId: conv.contact_id as string,
  });

  if (!result.ok) return { error: result.message };

  const { data: integration } = await admin
    .from('whatsapp_integrations')
    .select('mode, status')
    .eq('user_id', user.id)
    .maybeSingle();

  return {
    draft: {
      text: result.draft,
      logId: result.logId,
      conversationId,
      canSend: integration?.status === 'connected' && integration.mode === 'cloud_api',
      reason:
        integration?.status === 'connected' && integration.mode === 'cloud_api'
          ? undefined
          : 'Sending requires a connected business number. You can still copy the draft.',
    },
  };
}

/** Approve a draft and send it over the connected WhatsApp business number. */
export async function approveAndSend(_prev: AwayState, formData: FormData): Promise<AwayState> {
  const user = await currentUser();
  if (!user) return { error: 'Session expired.' };

  const conversationId = String(formData.get('conversationId') ?? '');
  const text = String(formData.get('text') ?? '').trim();
  const logId = String(formData.get('logId') ?? '');

  if (!conversationId || !text) return { error: 'Nothing to send.' };

  const admin = createSupabaseAdminClient();
  const { data: conv } = await admin
    .from('conversations')
    .select('contact_id, contacts(phone)')
    .eq('id', conversationId)
    .eq('user_id', user.id)
    .maybeSingle();

  const contact = conv && (Array.isArray(conv.contacts) ? conv.contacts[0] : conv.contacts);
  const phone = contact?.phone;
  if (!phone) {
    return { error: 'This contact has no phone number, so it cannot be messaged. Copy the draft instead.' };
  }

  const outcome = await sendWhatsAppMessage({
    userId: user.id,
    conversationId,
    toPhone: phone,
    body: text,
    contactId: (conv?.contact_id as string) ?? undefined,
  });

  if (!outcome.ok) {
    await admin.from('away_logs').insert({
      user_id: user.id,
      contact_id: (conv?.contact_id as string) ?? null,
      action: outcome.reason === 'window_closed' ? 'blocked' : 'error',
      final_text: text,
      detail: outcome.message,
    });
    revalidatePath('/away');
    return { error: outcome.message };
  }

  if (logId) {
    await admin
      .from('away_logs')
      .update({ action: 'sent', final_text: text })
      .eq('id', logId)
      .eq('user_id', user.id);
  } else {
    await admin.from('away_logs').insert({
      user_id: user.id,
      contact_id: (conv?.contact_id as string) ?? null,
      action: 'sent',
      final_text: text,
    });
  }

  revalidatePath('/away');
  return { success: 'Sent.' };
}

/** Immediately stop Away Mode — the spec's "pause instantly" requirement. */
export async function pauseAwayMode(): Promise<void> {
  const user = await currentUser();
  if (!user) return;

  const admin = createSupabaseAdminClient();
  await admin
    .from('away_settings')
    .update({ enabled: false })
    .eq('user_id', user.id);

  revalidatePath('/away');
}
