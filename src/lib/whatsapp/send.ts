import 'server-only';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { decryptSecret } from '@/lib/crypto';
import { sendText, WhatsAppError, markRead } from './cloud-api';

/**
 * Send an outbound WhatsApp message on behalf of a user, honouring the
 * 24-hour customer service window that Meta enforces.
 *
 * Rules we enforce (and surface, never silently swallow):
 *  - Outside 24h of the contact's last inbound message, WhatsApp rejects free
 *    text. We refuse before calling the API and explain why.
 *  - Every outbound message is written to `whatsapp_outbound` for audit.
 */

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export type WindowState = { open: boolean; lastInboundAt: string | null; expiresAt: string | null };

export async function getConversationWindow(
  userId: string,
  conversationId: string,
): Promise<WindowState> {
  const admin = createSupabaseAdminClient();

  const { data } = await admin
    .from('messages')
    .select('sent_at')
    .eq('user_id', userId)
    .eq('conversation_id', conversationId)
    .eq('is_from_me', false)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const lastInboundAt = (data?.sent_at as string | null) ?? null;
  if (!lastInboundAt) return { open: false, lastInboundAt: null, expiresAt: null };

  const expires = new Date(new Date(lastInboundAt).getTime() + WINDOW_MS);
  return {
    open: Date.now() < expires.getTime(),
    lastInboundAt,
    expiresAt: expires.toISOString(),
  };
}

export type SendOutcome =
  | { ok: true; messageId: string; outboundId: string }
  | { ok: false; reason: 'window_closed' | 'not_connected' | 'invalid' | 'provider_error'; message: string };

export async function sendWhatsAppMessage(params: {
  userId: string;
  conversationId: string;
  toPhone: string;
  body: string;
  contactId?: string;
  bypassWindowCheck?: boolean;
}): Promise<SendOutcome> {
  const { userId, conversationId, toPhone, body, contactId } = params;
  const admin = createSupabaseAdminClient();

  // 1. Resolve the user's connected integration.
  const { data: integration } = await admin
    .from('whatsapp_integrations')
    .select('id, phone_number_id, access_token_ciphertext, access_token_iv, access_token_auth_tag, status')
    .eq('user_id', userId)
    .eq('status', 'connected')
    .maybeSingle();

  if (!integration?.access_token_ciphertext) {
    return {
      ok: false,
      reason: 'not_connected',
      message: 'No connected WhatsApp Business number. Connect one in Integrations.',
    };
  }

  // 2. Enforce the messaging window.
  if (!params.bypassWindowCheck) {
    const win = await getConversationWindow(userId, conversationId);
    if (!win.open) {
      return {
        ok: false,
        reason: 'window_closed',
        message: win.lastInboundAt
          ? `The 24-hour reply window closed ${new Date(win.expiresAt!).toLocaleString()}. WhatsApp requires a pre-approved template to message first.`
          : 'This contact has not messaged you, so WhatsApp will not deliver free-form text. A pre-approved template is required.',
      };
    }
  }

  // 3. Record the attempt before calling out, so failures are auditable.
  const { data: outbound, error: outErr } = await admin
    .from('whatsapp_outbound')
    .insert({
      user_id: userId,
      integration_id: integration.id,
      contact_id: contactId ?? null,
      to_phone: toPhone,
      body,
      status: 'approved',
      requires_approval: false,
      approved_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (outErr || !outbound) {
    return { ok: false, reason: 'provider_error', message: 'Could not queue the message.' };
  }

  // 4. Call WhatsApp.
  try {
    const token = decryptSecret({
      ciphertext: integration.access_token_ciphertext,
      iv: integration.access_token_iv,
      auth_tag: integration.access_token_auth_tag,
    });

    const { messageId } = await sendText(integration.phone_number_id as string, token, toPhone, body);

    // 5. Persist the outbound message into the conversation thread.
    const { createHash } = await import('node:crypto');
    const sentAt = new Date().toISOString();
    const hash = createHash('sha256')
      .update(`me\u0000${sentAt}\u0000${body}`)
      .digest('hex');

    await admin.from('messages').insert({
      user_id: userId,
      conversation_id: conversationId,
      sender_name: 'You',
      is_from_me: true,
      body,
      sent_at: sentAt,
      message_hash: hash,
      provider_message_id: messageId,
      direction: 'outbound',
      wa_status: 'sent',
    });

    await admin
      .from('whatsapp_outbound')
      .update({ status: 'sent', provider_message_id: messageId, sent_at: sentAt })
      .eq('id', outbound.id);

    return { ok: true, messageId, outboundId: outbound.id as string };
  } catch (e) {
    const message =
      e instanceof WhatsAppError ? e.message : `Unexpected error: ${(e as Error).message}`;

    await admin
      .from('whatsapp_outbound')
      .update({ status: 'failed', error: message })
      .eq('id', outbound.id);

    const reason =
      e instanceof WhatsAppError && e.kind === 'window_closed'
        ? 'window_closed'
        : e instanceof WhatsAppError && e.kind === 'invalid_recipient'
          ? 'invalid'
          : 'provider_error';

    return { ok: false, reason, message };
  }
}

/** Mark an inbound message read on WhatsApp's side. Best-effort. */
export async function markConversationRead(userId: string, messageId: string) {
  const admin = createSupabaseAdminClient();
  const { data: integration } = await admin
    .from('whatsapp_integrations')
    .select('phone_number_id, access_token_ciphertext, access_token_iv, access_token_auth_tag')
    .eq('user_id', userId)
    .eq('status', 'connected')
    .maybeSingle();

  if (!integration?.access_token_ciphertext) return;

  try {
    const token = decryptSecret({
      ciphertext: integration.access_token_ciphertext,
      iv: integration.access_token_iv,
      auth_tag: integration.access_token_auth_tag,
    });
    await markRead(integration.phone_number_id as string, token, messageId);
  } catch {
    // Read receipts are cosmetic; never fail the user's request over them.
  }
}
