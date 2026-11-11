import 'server-only';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import type { ParsedWebhook, WebhookMessage } from './cloud-api';

/**
 * Turn a parsed Cloud API webhook into persisted conversation data.
 *
 * Idempotency is enforced at three levels:
 *  1. `whatsapp_webhook_events.event_key` unique — the same message id is
 *     never processed twice even if Meta retries the delivery.
 *  2. `messages.provider_message_id` unique index — a second line of defence.
 *  3. Contact and conversation are upserted by natural keys, never duplicated.
 */
export type IngestResult = {
  processed: number;
  skipped: number;
  errors: string[];
};

function eventKey(phoneNumberId: string, messageId: string) {
  return `msg:${phoneNumberId}:${messageId}`;
}

function normalisePhone(p: string) {
  return p.replace(/[^\d]/g, '');
}

export async function ingestWebhook(payloads: ParsedWebhook[]): Promise<IngestResult> {
  const admin = createSupabaseAdminClient();
  const result: IngestResult = { processed: 0, skipped: 0, errors: [] };

  for (const payload of payloads) {
    // Resolve which NEXORA user owns this business number.
    const { data: integration, error: intErr } = await admin
      .from('whatsapp_integrations')
      .select('id, user_id, status')
      .eq('phone_number_id', payload.phoneNumberId)
      .maybeSingle();

    if (intErr) {
      result.errors.push(`integration lookup failed: ${intErr.message}`);
      continue;
    }
    if (!integration) {
      result.errors.push(`no integration for phone_number_id ${payload.phoneNumberId}`);
      continue;
    }
    if (integration.status !== 'connected') {
      result.errors.push(`integration ${integration.id} is ${integration.status}, skipping`);
      continue;
    }

    const userId = integration.user_id as string;

    for (const msg of payload.messages) {
      const key = eventKey(payload.phoneNumberId, msg.id);

      // Claim the event. A duplicate insert means Meta retried — skip it.
      const { error: claimErr } = await admin.from('whatsapp_webhook_events').insert({
        event_key: key,
        user_id: userId,
        integration_id: integration.id,
        event_type: 'message',
        payload: msg as unknown as Record<string, unknown>,
      });

      if (claimErr) {
        if (claimErr.code === '23505') {
          result.skipped++;
          continue;
        }
        result.errors.push(`event claim failed: ${claimErr.message}`);
        continue;
      }

      try {
        await persistInboundMessage(admin, {
          userId,
          integrationId: integration.id as string,
          msg,
        });
        result.processed++;
      } catch (e) {
        result.errors.push((e as Error).message);
      }
    }

    // Delivery/read status updates for outbound messages
    for (const st of payload.statuses) {
      const { error } = await admin
        .from('messages')
        .update({ wa_status: st.status })
        .eq('user_id', userId)
        .eq('provider_message_id', st.id);
      if (error) result.errors.push(`status update failed: ${error.message}`);
    }
  }

  return result;
}

async function persistInboundMessage(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  ctx: { userId: string; integrationId: string; msg: WebhookMessage & { contactName?: string } },
) {
  const { userId, integrationId, msg } = ctx;

  // Only text messages carry analysable content. Others are recorded as a
  // labelled placeholder rather than invented content.
  let body: string;
  if (msg.type === 'text' && msg.text?.body) {
    body = msg.text.body;
  } else if (msg.type === 'button' || msg.type === 'interactive') {
    body = `[${msg.type} reply]`;
  } else {
    body = `[${msg.type} message]`;
  }

  const phone = normalisePhone(msg.from);
  const displayName = msg.contactName ?? `+${phone}`;
  const sentAt = new Date(parseInt(msg.timestamp, 10) * 1000).toISOString();

  // 1. Contact — upsert by (user_id, phone)
  let contactId: string;
  const { data: existingContact } = await admin
    .from('contacts')
    .select('id')
    .eq('user_id', userId)
    .eq('phone', `+${phone}`)
    .maybeSingle();

  if (existingContact) {
    contactId = existingContact.id as string;
    await admin
      .from('contacts')
      .update({ last_interaction_at: sentAt })
      .eq('id', contactId)
      .eq('user_id', userId);
  } else {
    const { data: created, error } = await admin
      .from('contacts')
      .insert({
        user_id: userId,
        display_name: displayName,
        phone: `+${phone}`,
        last_interaction_at: sentAt,
      })
      .select('id')
      .single();
    if (error || !created) throw new Error(`contact create failed: ${error?.message}`);
    contactId = created.id as string;
  }

  // 2. Conversation — one per (user, integration, wa_chat_id)
  const waChatId = `+${phone}`;
  let conversationId: string;
  const { data: existingConv } = await admin
    .from('conversations')
    .select('id')
    .eq('user_id', userId)
    .eq('wa_chat_id', waChatId)
    .eq('contact_id', contactId)
    .maybeSingle();

  if (existingConv) {
    conversationId = existingConv.id as string;
  } else {
    const { data: created, error } = await admin
      .from('conversations')
      .insert({
        user_id: userId,
        contact_id: contactId,
        title: displayName,
        source: 'whatsapp_cloud',
        integration_id: integrationId,
        wa_chat_id: waChatId,
        first_message_at: sentAt,
        last_message_at: sentAt,
      })
      .select('id')
      .single();
    if (error || !created) throw new Error(`conversation create failed: ${error?.message}`);
    conversationId = created.id as string;
  }

  // 3. Message
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(`${displayName}\u0000${sentAt}\u0000${body}`).digest('hex');

  const { error: msgErr } = await admin.from('messages').insert({
    user_id: userId,
    conversation_id: conversationId,
    sender_name: displayName,
    is_from_me: false,
    body,
    sent_at: sentAt,
    message_hash: hash,
    provider_message_id: msg.id,
    direction: 'inbound',
    wa_status: 'received',
  });

  // 23505 = the provider_message_id unique index caught a duplicate.
  if (msgErr && msgErr.code !== '23505') {
    throw new Error(`message insert failed: ${msgErr.message}`);
  }

  // 4. Roll up conversation counters
  const { data: conv } = await admin
    .from('conversations')
    .select('message_count, first_message_at')
    .eq('id', conversationId)
    .single();

  await admin
    .from('conversations')
    .update({
      message_count: (conv?.message_count ?? 0) + 1,
      last_message_at: sentAt,
      first_message_at: conv?.first_message_at ?? sentAt,
    })
    .eq('id', conversationId)
    .eq('user_id', userId);
}
