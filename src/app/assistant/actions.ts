'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { generateReplies, deriveStyleProfile, extractMemories } from '@/lib/ai/intelligence';

export type AssistantState =
  | {
      error?: string;
      replies?: { text: string; angle: string }[];
      instructions?: string;
      /** Echoed back so the form can re-select the conversation it used. */
      conversationId?: string;
    }
  | { notice?: string }
  | null;

async function currentUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function draftReplies(
  _prev: AssistantState,
  formData: FormData,
): Promise<AssistantState> {
  const user = await currentUser();
  if (!user) return { error: 'Your session expired. Sign in again.' };

  const parsed = z
    .object({
      conversationId: z.string().uuid(),
      instructions: z.string().trim().max(500).optional(),
      count: z.coerce.number().min(1).max(3).default(3),
    })
    .safeParse({
      conversationId: formData.get('conversationId'),
      instructions: formData.get('instructions') || undefined,
      count: formData.get('count') ?? 3,
    });

  if (!parsed.success) return { error: 'Pick a conversation first.' };

  const result = await generateReplies({
    userId: user.id,
    conversationId: parsed.data.conversationId,
    instructions: parsed.data.instructions ?? null,
    count: parsed.data.count,
  });

  if (!result.ok) {
    return {
      error:
        result.reason === 'no_credential'
          ? result.message
          : result.message,
      instructions: parsed.data.instructions,
      conversationId: parsed.data.conversationId,
    };
  }

  return {
    replies: result.data,
    instructions: parsed.data.instructions,
    conversationId: parsed.data.conversationId,
  };
}

export async function refreshStyleProfile(
  _prev: AssistantState,
  formData: FormData,
): Promise<AssistantState> {
  const user = await currentUser();
  if (!user) return { error: 'Session expired.' };

  const result = await deriveStyleProfile({ userId: user.id });

  if (!result.ok) return { error: result.message };

  revalidatePath('/assistant');
  return {
    notice: `Style profile updated from your messages — ${result.data.tone}, ${result.data.formality}. Confidence ${Math.round(result.data.confidence * 100)}%.`,
  };
}

export async function runMemoryExtraction(
  _prev: AssistantState,
  formData: FormData,
): Promise<AssistantState> {
  const user = await currentUser();
  if (!user) return { error: 'Session expired.' };

  const conversationId = String(formData.get('conversationId') ?? '');
  if (!conversationId) return { error: 'Pick a conversation.' };

  const result = await extractMemories({ userId: user.id, conversationId });
  if (!result.ok) return { error: result.message };

  revalidatePath('/memory');
  return {
    notice: `Extracted ${result.data.inserted} new memor${result.data.inserted === 1 ? 'y' : 'ies'}${
      result.data.skipped ? `, ${result.data.skipped} already known` : ''
    }.`,
  };
}

export type SendState =
  | { ok: true; message: string }
  | { ok: false; message: string; reason?: string }
  | null;

/**
 * Send an approved draft through the user's genuinely connected WhatsApp channel.
 *
 * Deliberately refuses rather than degrades: if there is no connected integration,
 * no phone number, or the 24-hour window is closed, the user is told why and told
 * to copy instead. There is no "pretend send" branch anywhere in this path.
 */
export async function sendApprovedReply(
  _prev: SendState,
  formData: FormData,
): Promise<SendState> {
  const user = await currentUser();
  if (!user) return { ok: false, message: 'Your session expired. Sign in again.' };

  const conversationId = String(formData.get('conversationId') ?? '');
  const text = String(formData.get('text') ?? '').trim();

  if (!conversationId || !text) return { ok: false, message: 'Nothing to send.' };
  if (text.length > 4096) return { ok: false, message: 'Message is too long for WhatsApp (4096 max).' };

  const supabase = await createSupabaseServerClient();

  // Ownership-checked read: RLS plus an explicit user filter.
  const { data: conv } = await supabase
    .from('conversations')
    .select('id, contact_id, contacts(phone, display_name)')
    .eq('id', conversationId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!conv) return { ok: false, message: 'That conversation no longer exists.' };

  const contact = Array.isArray(conv.contacts) ? conv.contacts[0] : conv.contacts;
  const phone = contact?.phone;

  if (!phone) {
    return {
      ok: false,
      reason: 'no_phone',
      message:
        'This contact has no phone number on file, so NEXORA cannot send for you. Copy the reply and send it yourself.',
    };
  }

  const { data: integration } = await supabase
    .from('whatsapp_integrations')
    .select('mode, status')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!integration || integration.status !== 'connected') {
    return {
      ok: false,
      reason: 'not_connected',
      message:
        'No connected WhatsApp channel. Connect a business number in Integrations, or copy the reply and send it yourself.',
    };
  }

  if (integration.mode === 'personal_bridge') {
    return {
      ok: false,
      reason: 'bridge_no_send',
      message:
        'Personal bridge mode imports messages but cannot send on your behalf — the bridge is read-only by design. Copy the reply and send it from your phone.',
    };
  }

  const { sendWhatsAppMessage } = await import('@/lib/whatsapp/send');

  const outcome = await sendWhatsAppMessage({
    userId: user.id,
    conversationId,
    toPhone: phone,
    body: text,
    contactId: (conv.contact_id as string) ?? undefined,
  });

  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason, message: outcome.message };
  }

  revalidatePath(`/conversations/${conversationId}`);
  revalidatePath('/conversations');
  return { ok: true, message: 'Sent through your connected WhatsApp business number.' };
}
