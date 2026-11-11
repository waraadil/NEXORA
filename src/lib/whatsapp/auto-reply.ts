import 'server-only';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { getActiveCredentialForUser, callProvider } from '@/lib/ai/credentials';
import { loadStyleBrief } from '@/lib/ai/intelligence';
import { replyPrompt, renderTranscript, parseJsonResponse } from '@/lib/ai/prompts';

/**
 * AUTO-REPLY — NEXORA answers WhatsApp on the user's behalf.
 *
 * Every guard rail here exists because the alternative is a runaway bot
 * speaking in the user's voice to their real contacts:
 *
 *  1. Direct chats only. Never groups, never broadcast/status.
 *  2. Opt-in. Nothing happens unless the user turned it on.
 *  3. One answer per message, claimed atomically (several relay instances and
 *     the poll loop can run at once).
 *  4. Stands down if the user already replied from their phone.
 *  5. Rate limited per conversation *and* per account, so an auto-responder on
 *     the other side cannot start a machine-to-machine loop.
 *  6. Conservative content rules in the prompt: no commitments, no OTPs, no
 *     money, no addresses, no passwords.
 *  7. Auto-pauses itself after repeated failures instead of retrying forever.
 */

export const MAX_PER_CONVERSATION_PER_HOUR = 6;
export const MAX_PER_USER_PER_HOUR = 40;
export const CLAIM_STALE_MS = 5 * 60 * 1000;

const SAFETY_INSTRUCTIONS = `You are replying on the user's behalf without them reading it first.
Be conservative and never:
- promise, confirm, book, or commit to anything on the user's behalf
- share passwords, OTPs, bank details, card numbers, addresses, or ID numbers
- discuss money, payments, or make purchases
- claim to be a human if directly asked; if asked whether you are a bot, say the user will reply themselves
When the message needs a decision only the user can make, say you will get back to them shortly.`;

export type PlannedReply = {
  outboundId: string;
  chatId: string;
  toName: string;
  body: string;
};

type Claimed = {
  id: string;
  conversation_id: string;
  body: string;
  sender_name: string;
  sent_at: string | null;
  provider_message_id: string | null;
};

/**
 * Handle newly stored inbound messages for one user.
 * Returns nothing — replies are queued in `whatsapp_outbound` for the relay to
 * pick up, so a browser closing mid-flight cannot lose a drafted reply.
 */
export async function planAutoReplies(params: {
  userId: string;
  integrationId: string;
  conversationIds: string[];
}): Promise<{ queued: number; skipped: number; reason?: string }> {
  const admin = createSupabaseAdminClient();

  const { data: integration } = await admin
    .from('whatsapp_integrations')
    .select(
      'id, auto_reply_enabled, auto_reply_require_approval, auto_reply_delay_seconds, auto_reply_instructions, auto_reply_paused_at, auto_reply_paused_reason',
    )
    .eq('id', params.integrationId)
    .eq('user_id', params.userId)
    .maybeSingle();

  if (!integration?.auto_reply_enabled) return { queued: 0, skipped: 0, reason: 'disabled' };
  if (integration.auto_reply_paused_at) {
    return { queued: 0, skipped: 0, reason: `paused: ${integration.auto_reply_paused_reason ?? 'unknown'}` };
  }

  // Claim the pending inbound messages atomically.
  const { data: claimed, error: claimErr } = await admin
    .from('messages')
    .update({ auto_reply_state: 'claimed', auto_reply_claim_at: new Date().toISOString() })
    .eq('user_id', params.userId)
    .in('conversation_id', params.conversationIds)
    .eq('auto_reply_state', 'pending')
    .eq('is_from_me', false)
    .select('id, conversation_id, body, sender_name, sent_at, provider_message_id');

  if (claimErr) return { queued: 0, skipped: 0, reason: `claim failed: ${claimErr.message}` };
  if (!claimed?.length) return { queued: 0, skipped: 0 };

  const cred = await getActiveCredentialForUser(params.userId);
  if (!cred) {
    await admin
      .from('messages')
      .update({ auto_reply_state: 'failed', auto_reply_error: 'No AI provider connected' })
      .in('id', claimed.map((m) => m.id));
    return { queued: 0, skipped: claimed.length, reason: 'no_credential' };
  }

  let queued = 0;
  let skipped = 0;

  for (const message of claimed as Claimed[]) {
    const outcome = await handleOne(admin, {
      userId: params.userId,
      integrationId: params.integrationId,
      message,
      delaySeconds: (integration.auto_reply_delay_seconds as number) ?? 4,
      instructions: integration.auto_reply_instructions as string | null,
      requireApproval: integration.auto_reply_require_approval !== false,
      cred,
    });

    if (outcome === 'queued') queued++;
    else skipped++;
  }

  await maybeAutoPause(admin, params.userId, params.integrationId);

  return { queued, skipped };
}

async function handleOne(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  ctx: {
    userId: string;
    integrationId: string;
    message: Claimed;
    delaySeconds: number;
    instructions: string | null;
    requireApproval: boolean;
    cred: NonNullable<Awaited<ReturnType<typeof getActiveCredentialForUser>>>;
  },
): Promise<'queued' | 'skipped'> {
  const { userId, integrationId, message } = ctx;
  const now = Date.now();

  const skip = async (reason: string, state: 'skipped' | 'failed' = 'skipped') => {
    await admin
      .from('messages')
      .update({ auto_reply_state: state, auto_reply_error: reason })
      .eq('id', message.id)
      .eq('user_id', userId);
    return 'skipped' as const;
  };

  // ── Conversation gate: direct chats only ────────────────────────────────
  const { data: conv } = await admin
    .from('conversations')
    .select('id, title, is_group, wa_chat_id, contact_id')
    .eq('id', message.conversation_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!conv) return skip('conversation missing', 'failed');
  if (conv.is_group) return skip('group chats are never auto-answered');
  if (!conv.wa_chat_id || !String(conv.wa_chat_id).includes('@')) return skip('not a live WhatsApp chat');

  // ── Did the user already answer this themselves? ────────────────────────
  const sentAt = message.sent_at ?? new Date().toISOString();
  const { data: later } = await admin
    .from('messages')
    .select('id')
    .eq('user_id', userId)
    .eq('conversation_id', conv.id)
    .eq('is_from_me', true)
    .gt('sent_at', sentAt)
    .limit(1);

  if (later?.length) return skip('you already replied');

  // ── Rate limits ─────────────────────────────────────────────────────────
  const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();

  const [{ count: convCount }, { count: userCount }] = await Promise.all([
    admin
      .from('whatsapp_outbound')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('conversation_id', conv.id)
      .eq('source', 'auto_reply')
      .gte('created_at', hourAgo),
    admin
      .from('whatsapp_outbound')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('source', 'auto_reply')
      .gte('created_at', hourAgo),
  ]);

  if ((convCount ?? 0) >= MAX_PER_CONVERSATION_PER_HOUR) {
    return skip(`rate limit: ${MAX_PER_CONVERSATION_PER_HOUR} auto-replies per chat per hour`);
  }
  if ((userCount ?? 0) >= MAX_PER_USER_PER_HOUR) {
    return skip(`rate limit: ${MAX_PER_USER_PER_HOUR} auto-replies per hour`);
  }

  // ── Draft it in the user's voice ────────────────────────────────────────
  const { data: history } = await admin
    .from('messages')
    .select('sender_name, body, is_from_me, sent_at')
    .eq('user_id', userId)
    .eq('conversation_id', conv.id)
    .order('sent_at', { ascending: false })
    .limit(30);

  const transcript = renderTranscript(
    (history ?? []).reverse().map((m) => ({
      sender: m.sender_name as string,
      body: m.body as string,
      isFromMe: m.is_from_me as boolean,
      sentAt: m.sent_at as string | null,
    })),
    30,
  );

  let style = 'No style profile yet — infer the style from the transcript.';
  let relationship: string | null = null;
  let relationshipDetail: string | null = null;

  try {
    const brief = await loadStyleBrief(userId, (conv.contact_id as string) ?? undefined);
    style = brief.brief;
    relationship = brief.relationship;
    relationshipDetail = brief.relationshipDetail;
  } catch {
    /* a missing style profile is not fatal */
  }

  let draft: string;
  try {
    const result = await callProvider(
      ctx.cred,
      replyPrompt({
        transcript,
        contactName: (conv.title as string) ?? 'them',
        relationship,
        relationshipDetail,
        style,
        userInstructions: [SAFETY_INSTRUCTIONS, ctx.instructions].filter(Boolean).join('\n\n'),
        count: 1,
      }),
      { temperature: 0.6, maxTokens: 300 },
    );

    const parsed = parseJsonResponse<{ replies: { text: string; angle: string }[] }>(result.text);
    const text = parsed?.replies?.[0]?.text?.trim();
    if (!text) return skip('model returned no usable reply', 'failed');
    draft = text.slice(0, 1000);
  } catch (e) {
    return skip(`model error: ${(e as Error).message}`, 'failed');
  }

  // ── Queue it for the relay ──────────────────────────────────────────────
  // The pause is measured from when the reply is READY, not from when drafting
  // began: a slow model call would otherwise consume the whole delay and the
  // message would leave the instant it was written.
  const { data: outbound, error } = await admin
    .from('whatsapp_outbound')
    .insert({
      user_id: userId,
      integration_id: integrationId,
      contact_id: (conv.contact_id as string) ?? null,
      conversation_id: conv.id,
      chat_jid: conv.wa_chat_id,
      to_phone: conv.wa_chat_id,
      body: draft,
      status: ctx.requireApproval ? 'awaiting_approval' : 'approved',
      requires_approval: ctx.requireApproval,
      approved_at: ctx.requireApproval ? null : new Date().toISOString(),
      channel: 'personal',
      source: 'auto_reply',
      not_before: new Date(Date.now() + Math.max(0, ctx.delaySeconds) * 1000).toISOString(),
    })
    .select('id')
    .single();

  if (error || !outbound) return skip(`queue failed: ${error?.message ?? 'unknown'}`, 'failed');

  await admin
    .from('messages')
    .update({ auto_reply_state: 'replied', auto_reply_error: null })
    .eq('id', message.id)
    .eq('user_id', userId);

  return 'queued';
}

/**
 * Stop the whole thing if recent replies keep failing. A dead relay or a bad
 * session would otherwise burn through the rate limit silently.
 */
async function maybeAutoPause(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  userId: string,
  integrationId: string,
) {
  const { data: recent } = await admin
    .from('whatsapp_outbound')
    .select('status')
    .eq('user_id', userId)
    .eq('source', 'auto_reply')
    .order('created_at', { ascending: false })
    .limit(5);

  if (!recent?.length || recent.length < 5) return;
  if (!recent.every((r) => r.status === 'failed')) return;

  await admin
    .from('whatsapp_integrations')
    .update({
      auto_reply_paused_at: new Date().toISOString(),
      auto_reply_paused_reason: 'Auto-reply paused: the last 5 replies could not be sent.',
    })
    .eq('id', integrationId)
    .eq('user_id', userId);
}

/** Clear rows stuck in 'claimed' by a crashed server. */
export async function releaseStaleClaims(userId: string): Promise<void> {
  const admin = createSupabaseAdminClient();
  const cutoff = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  await admin
    .from('messages')
    .update({ auto_reply_state: 'failed', auto_reply_error: 'Reply generation timed out' })
    .eq('user_id', userId)
    .eq('auto_reply_state', 'claimed')
    .lt('auto_reply_claim_at', cutoff);
}
