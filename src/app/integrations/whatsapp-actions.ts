'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createSupabaseServerClient, createSupabaseAdminClient } from '@/lib/supabase/server';
import { revokeRelay, normalizePairingPhone } from '@/lib/whatsapp/relay';
import { revokeAgent } from '@/lib/whatsapp/agent-auth';
import { startAgentLink } from '@/lib/whatsapp/agent-link';
import { REQUIRED_ACKNOWLEDGEMENTS, CONFIRMATION_PHRASE } from '@/lib/whatsapp/bridge-risks';
import { isRelayLive } from '@/lib/whatsapp/relay';

/**
 * Server actions for linking a personal WhatsApp account.
 *
 * Two steps, deliberately:
 *   1. `beginPairing`  — after explicit consent, issues the relay key and opens
 *                        a 15-minute window for the phone number.
 *   2. `confirmPairing`— once the relay reports "connected", stores the account
 *                        identity and switches the link to live.
 *
 * Splitting them keeps the consent gate impossible to skip: no key without it.
 */

export type PairingState =
  | {
      error?: string;
      fieldErrors?: Record<string, string>;
      step?: 'idle' | 'ready' | 'linked';
      phone?: string;
      /** True when an always-on agent adopted the pairing and will post a code. */
      agentAdopted?: boolean;
    }
  | null;

/** Absolute URL the agent should talk to. */
async function appBaseUrl(): Promise<string> {
  const { getAppUrl } = await import('@/lib/app-url');
  return getAppUrl();
}

async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function beginPairing(
  _prev: PairingState,
  formData: FormData,
): Promise<PairingState> {
  const user = await requireUser();
  if (!user) return { error: 'Session expired. Sign in again.' };

  const parsed = z
    .object({
      phone: z.string().trim().min(7, 'Enter your number with the country code'),
      confirm: z.string().trim(),
    })
    .safeParse({
      phone: formData.get('phone'),
      confirm: formData.get('confirm'),
    });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = issue.message;
    return { fieldErrors };
  }

  const acknowledged = formData.getAll('ack').map(String);
  const missing = REQUIRED_ACKNOWLEDGEMENTS.filter((r) => !acknowledged.includes(r));
  if (missing.length > 0) {
    return { error: 'Tick every risk box. They are not decoration — the last one is a real ban risk.' };
  }
  if (parsed.data.confirm !== CONFIRMATION_PHRASE) {
    return { error: `Type exactly: ${CONFIRMATION_PHRASE}` };
  }

  const phone = normalizePairingPhone(parsed.data.phone);
  if (!phone) {
    return {
      fieldErrors: {
        phone: 'That is not a valid international number. Example: 91 98765 43210 for an Indian number.',
      },
    };
  }

  try {
    // Hand the pairing to the always-on agent. It asks WhatsApp for the code and
    // posts it back, so the next render shows the code — no command to run.
    const link = await startAgentLink({
      userId: user.id,
      phone,
      appUrl: await appBaseUrl(),
    });

    revalidatePath('/integrations');

    if (link.error) {
      return {
        error: link.agentConfigured
          ? link.error
          : 'No WhatsApp agent is running for this deployment, so there is nothing to hold the connection. An admin needs to start the agent once — after that this button works for everyone.',
      };
    }

    return { step: 'ready', phone, agentAdopted: link.agentAdopted };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Called by the page/refresh button once the relay says it is connected. */
export async function confirmPairing(): Promise<PairingState> {
  const user = await requireUser();
  if (!user) return { error: 'Session expired. Sign in again.' };

  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from('whatsapp_integrations')
    .select('status, bridge_session_state, bridge_last_seen_at, bridge_self_number')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!data) return { error: 'No pairing in progress. Start again.' };

  const live =
    data.bridge_session_state === 'connected' ||
    ((data.status as string) === 'connected' && isRelayLive(data.bridge_last_seen_at as string | null));

  if (!live) {
    return {
      error:
        'The relay has not connected yet. Keep the terminal window open — it links within about 20 seconds of the code being entered.',
    };
  }

  revalidatePath('/integrations');
  return { step: 'linked', phone: (data.bridge_self_number as string | null) ?? undefined };
}

export async function unlinkWhatsApp(): Promise<void> {
  const user = await requireUser();
  if (!user) return;

  await revokeRelay(user.id);

  // Tell the hosted agent to drop its WhatsApp session too, and leave a marker
  // so its next poll can see this was deliberate rather than a bad token.
  await revokeAgent(user.id);

  // Anything mid-flight is cancelled, so the relay cannot deliver a message
  // moments after the user disconnected.
  const admin = createSupabaseAdminClient();
  await admin
    .from('whatsapp_outbound')
    .update({ status: 'cancelled', error: 'Disconnected by user' })
    .eq('user_id', user.id)
    .in('status', ['queued', 'approved', 'awaiting_approval']);

  revalidatePath('/integrations');
}

export async function updateAutoReply(formData: FormData): Promise<PairingState & { success?: string }> {
  const user = await requireUser();
  if (!user) return { error: 'Session expired. Sign in again.' };

  const enabled = formData.get('enabled') === 'on';
  const approval = formData.get('approval') === 'on';
  const delayRaw = Number(formData.get('delay') ?? 4);
  const instructions = String(formData.get('instructions') ?? '').trim();

  const delay = Number.isFinite(delayRaw) ? Math.min(Math.max(Math.round(delayRaw), 0), 120) : 4;

  const admin = createSupabaseAdminClient();
  const { error } = await admin
    .from('whatsapp_integrations')
    .update({
      auto_reply_enabled: enabled,
      auto_reply_require_approval: approval,
      auto_reply_delay_seconds: delay,
      auto_reply_instructions: instructions || null,
      // Turning it back on clears a previous auto-pause.
      auto_reply_paused_at: enabled ? null : undefined,
      auto_reply_paused_reason: enabled ? null : undefined,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', user.id);

  if (error) return { error: 'Could not save auto-reply settings.' };

  revalidatePath('/integrations');
  return { success: enabled ? 'Auto-reply is on.' : 'Auto-reply is off.' };
}

/** Approve or reject a draft the AI wrote, before it is sent. */
export async function decideDraft(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!user) return;

  const id = String(formData.get('id') ?? '');
  const decision = String(formData.get('decision') ?? '');
  if (!id || !['approve', 'reject'].includes(decision)) return;

  const admin = createSupabaseAdminClient();
  await admin
    .from('whatsapp_outbound')
    .update(
      decision === 'approve'
        ? { status: 'approved', approved_at: new Date().toISOString(), not_before: new Date().toISOString() }
        : { status: 'cancelled', error: 'Rejected by user' },
    )
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('status', 'awaiting_approval');

  revalidatePath('/integrations');
}

/** Send a message the user typed in NEXORA, through their own WhatsApp. */
export async function queueManualSend(formData: FormData): Promise<{ error?: string; success?: string }> {
  const user = await requireUser();
  if (!user) return { error: 'Session expired. Sign in again.' };

  const conversationId = String(formData.get('conversationId') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  if (!conversationId || !body) return { error: 'Write a message first.' };
  if (body.length > 4000) return { error: 'Keep it under 4000 characters.' };

  const admin = createSupabaseAdminClient();
  const { data: conv } = await admin
    .from('conversations')
    .select('id, wa_chat_id, contact_id, source, integration_id')
    .eq('id', conversationId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!conv?.wa_chat_id) return { error: 'This conversation is not linked to WhatsApp.' };
  if (conv.source === 'whatsapp_cloud') {
    return { error: 'This is a business-number conversation. Use the Cloud API reply path.' };
  }

  const { error } = await admin.from('whatsapp_outbound').insert({
    user_id: user.id,
    integration_id: conv.integration_id ?? null,
    contact_id: conv.contact_id ?? null,
    conversation_id: conv.id,
    chat_jid: conv.wa_chat_id,
    to_phone: conv.wa_chat_id,
    body,
    status: 'approved',
    requires_approval: false,
    approved_at: new Date().toISOString(),
    channel: 'personal',
    source: 'user',
  });

  if (error) return { error: 'Could not queue the message.' };

  revalidatePath(`/conversations/${conversationId}`);
  return { success: 'Queued — your relay will send it within a few seconds.' };
}
