import 'server-only';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { getActiveCredentialForUser, callProvider } from '@/lib/ai/credentials';
import { replyPrompt, renderTranscript, parseJsonResponse } from '@/lib/ai/prompts';
import { canAutoReply, MAX_PER_CONVERSATION_PER_HOUR } from '@/lib/whatsapp/auto-reply-scope';
import { collapseTurns, shouldWaitForSettle } from '@/lib/whatsapp/burst';
import { applyEmojiPolicy, emojiInstruction, type EmojiPreference } from '@/lib/whatsapp/emoji';
import { composeStyleBrief } from '@/lib/whatsapp/intelligence';

/**
 * AUTO-REPLY — NEXORA answers WhatsApp on the user's behalf.
 *
 * Every guard rail here exists because the alternative is a runaway bot
 * speaking in the user's voice to their real contacts:
 *
 *  1. Direct chats only. Never groups, never broadcast/status.
 *  2. Opt-in per person, not just per account. Turning auto-reply on answers
 *     nobody; the user must add each contact to the list. The default is
 *     silence, because an unwanted message cannot be recalled.
 *  3. One answer per TURN, not per message. A burst of four lines is one turn
 *     and gets one reply, after the person has stopped typing. Claimed
 *     atomically, because several relay instances and the poll loop can run at
 *     the same time.
 *  4. Stands down if the user already replied from their phone — checked again
 *     immediately before queuing, not just before drafting.
 *  5. Rate limited per conversation *and* per account, so an auto-responder on
 *     the other side cannot start a machine-to-machine loop.
 *  6. Conservative content rules in the prompt: no commitments, no OTPs, no
 *     money, no addresses, no passwords.
 *  7. Auto-pauses itself after repeated failures instead of retrying forever.
 */

export { MAX_PER_CONVERSATION_PER_HOUR };

export const MAX_PER_USER_PER_HOUR = 40;
export const CLAIM_STALE_MS = 5 * 60 * 1000;

const SAFETY_INSTRUCTIONS = `You are replying on the user's behalf without them reading it first.
Be conservative and never:
- promise, confirm, book, or commit to anything on the user's behalf
- share passwords, OTPs, bank details, card numbers, addresses, or ID numbers
- discuss money, payments, or make purchases
- claim to be a human if directly asked; if asked whether you are a bot, say the user will reply themselves
When the message needs a decision only the user can make, say you will get back to them shortly.`;

// Burst handling lives in its own module (no server imports) so it can be
// tested directly; re-exported here because callers expect it from the planner.
export { collapseTurns, shouldWaitForSettle, REPLY_SETTLE_MS, MAX_SETTLE_MS } from '@/lib/whatsapp/burst';

type Claimed = {
  id: string;
  conversation_id: string;
  body: string;
  sender_name: string;
  sent_at: string | null;
  provider_message_id: string | null;
  /** When this batch was claimed — the reference for the settle cap. */
  auto_reply_claim_at: string | null;
};

export async function planAutoReplies(params: {
  userId: string;
  integrationId: string;
  conversationIds: string[];
}): Promise<{ queued: number; skipped: number; waiting?: number; reason?: string }> {
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
    .select('id, conversation_id, body, sender_name, sent_at, provider_message_id, auto_reply_claim_at');

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
  let waiting = 0;
  const settled: Claimed[] = [];
  // Carries each conversation's already-resolved facts to the drafting step.
  const gateInfo = new Map<string, { title: string | null; contact_id: string | null; chatId: string }>();

  for (const conversationId of new Set((claimed as Claimed[]).map((m) => m.conversation_id))) {
    const messages = (claimed as Claimed[]).filter((m) => m.conversation_id === conversationId);

    // Read the conversation once and decide once. Every check below is about
    // the conversation, not about an individual message, so running it per
    // message meant five messages bought five identical gate evaluations and
    // five model calls.
    const gate = await gateConversation(admin, {
      userId: params.userId,
      conversationId,
      messages,
      cred,
    });

    if (gate.verdict === 'skip') {
      await markAll(admin, params.userId, messages.map((m) => m.id), 'skipped', gate.detail);
      skipped += messages.length;
      continue;
    }
    if (gate.verdict === 'fail') {
      await markAll(admin, params.userId, messages.map((m) => m.id), 'failed', gate.detail);
      skipped += messages.length;
      continue;
    }
    if (gate.verdict === 'wait') {
      // Hand them back as pending so the next poll picks them up when the
      // person has stopped typing. Not an error, so no auto-pause.
      await releaseToPending(admin, params.userId, messages.map((m) => m.id));
      waiting += messages.length;
      continue;
    }

    gateInfo.set(conversationId, {
      title: gate.conv.title,
      contact_id: gate.conv.contact_id,
      chatId: gate.allowedChatId,
    });
    settled.push(...collapseTurns(messages));
  }

  for (const message of settled) {
    const outcome = await handleOne(admin, {
      userId: params.userId,
      integrationId: params.integrationId,
      message,
      conv: { id: message.conversation_id, ...gateInfo.get(message.conversation_id)! },
      chatId: gateInfo.get(message.conversation_id)!.chatId,
      delaySeconds: (integration.auto_reply_delay_seconds as number) ?? 4,
      instructions: integration.auto_reply_instructions as string | null,
      requireApproval: integration.auto_reply_require_approval !== false,
      cred,
    });

    if (outcome === 'queued') queued++;
    else skipped++;
  }

  await maybeAutoPause(admin, params.userId, params.integrationId);

  return { queued, skipped, waiting };
}

/** Bulk state change for a batch, in one statement rather than one per row. */
async function markAll(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  userId: string,
  ids: string[],
  state: 'skipped' | 'failed',
  detail: string,
) {
  if (!ids.length) return;
  await admin
    .from('messages')
    .update({ auto_reply_state: state, auto_reply_error: detail.slice(0, 500) })
    .eq('user_id', userId)
    .in('id', ids);
}

/** Put messages back in the queue, untouched, for the next poll. */
async function releaseToPending(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  userId: string,
  ids: string[],
) {
  if (!ids.length) return;
  await admin
    .from('messages')
    .update({ auto_reply_state: 'pending', auto_reply_claim_at: null })
    .eq('user_id', userId)
    .in('id', ids);
}

type GateResult =
  | { verdict: 'proceed'; conv: ConversationRow; allowedChatId: string }
  | { verdict: 'skip'; detail: string }
  | { verdict: 'fail'; detail: string }
  | { verdict: 'wait'; detail: string };

type ConversationRow = {
  id: string;
  title: string | null;
  is_group: boolean;
  wa_chat_id: string | null;
  contact_id: string | null;
  auto_reply_mode: string | null;
  auto_reply_paused_at: string | null;
  auto_reply_paused_reason: string | null;
};

/**
 * Everything that decides whether this conversation may be answered, decided
 * once.
 *
 * The three questions are cheap to answer together and expensive to answer
 * repeatedly: the allowlist, whether the user is already handling it, and
 * whether the person has stopped typing. Doing this per conversation instead of
 * per message is what turns a five-message burst into one decision rather than
 * five.
 */
async function gateConversation(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  params: {
    userId: string;
    conversationId: string;
    messages: Claimed[];
    cred: unknown;
  },
): Promise<GateResult> {
  const { userId, conversationId, messages } = params;

  const { data: conv } = await admin
    .from('conversations')
    .select(
      'id, title, is_group, wa_chat_id, contact_id, auto_reply_mode, auto_reply_paused_at, auto_reply_paused_reason',
    )
    .eq('id', conversationId)
    .eq('user_id', userId)
    .maybeSingle<ConversationRow>();

  if (!conv) return { verdict: 'fail', detail: 'conversation missing' };
  if (!conv.wa_chat_id || !String(conv.wa_chat_id).includes('@')) {
    return { verdict: 'skip', detail: 'not a live WhatsApp chat' };
  }

  // ── Has the user taken over? ────────────────────────────────────────────
  const earliest = messages
    .map((m) => m.sent_at)
    .filter(Boolean)
    .sort()[0] ?? new Date().toISOString();
  if (await userRepliedSince(admin, userId, conversationId, earliest)) {
    return { verdict: 'skip', detail: 'you already replied' };
  }

  // ── Rate limits ─────────────────────────────────────────────────────────
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const [{ count: convCount }, { count: userCount }] = await Promise.all([
    admin
      .from('whatsapp_outbound')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('conversation_id', conversationId)
      .eq('source', 'auto_reply')
      .gte('created_at', hourAgo),
    admin
      .from('whatsapp_outbound')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('source', 'auto_reply')
      .gte('created_at', hourAgo),
  ]);

  const scope = canAutoReply({
    isGroup: !!conv.is_group,
    conversation: {
      auto_reply_mode: (conv.auto_reply_mode as 'off' | 'on') ?? 'off',
      auto_reply_paused_at: conv.auto_reply_paused_at,
      auto_reply_paused_reason: conv.auto_reply_paused_reason,
    },
    usedThisHour: convCount ?? 0,
    globallyEnabled: true, // checked at the top of planAutoReplies
  });
  if (!scope.allowed) {
    // A paused chat or a spent allowance is not worth waiting for; only the
    // settle check below should ever ask to be retried.
    return { verdict: 'skip', detail: scope.detail };
  }
  if ((userCount ?? 0) >= MAX_PER_USER_PER_HOUR) {
    return { verdict: 'skip', detail: `rate limit: ${MAX_PER_USER_PER_HOUR} auto-replies per hour` };
  }

  // ── Have they finished typing? ──────────────────────────────────────────
  const newestAt = Math.max(
    ...messages.map((m) => new Date(m.sent_at ?? Date.now()).getTime()),
  );
  const firstSeenAt = Math.min(
    ...messages.map((m) => new Date(m.auto_reply_claim_at ?? Date.now()).getTime()),
  );
  if (
    shouldWaitForSettle({
      newestAt,
      now: Date.now(),
      firstSeenAt: Number.isFinite(firstSeenAt) ? firstSeenAt : null,
    })
  ) {
    return { verdict: 'wait', detail: 'still typing' };
  }

  return { verdict: 'proceed', conv, allowedChatId: conv.wa_chat_id as string };
}

/**
 * Has the user answered this conversation themselves since `sinceIso`?
 *
 * Deliberately strict about one thing: a message the *relay* sent on the user's
 * behalf does not count as the user replying. The relay writes rows with
 * is_from_me = true for both, so counting them would let the machine conclude
 * "a human is handling this" after its own message and go quiet.
 */
async function userRepliedSince(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  userId: string,
  conversationId: string,
  sinceIso: string,
): Promise<boolean> {
  const { data } = await admin
    .from('messages')
    .select('id')
    .eq('user_id', userId)
    .eq('conversation_id', conversationId)
    .eq('is_from_me', true)
    .gt('sent_at', sinceIso)
    .limit(1);
  return !!data?.length;
}

async function handleOne(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  ctx: {
    userId: string;
    integrationId: string;
    message: Claimed;
    /** Resolved once by the gate; avoids a second conversation read. */
    conv: { id: string; title: string | null; contact_id: string | null };
    chatId: string;
    delaySeconds: number;
    instructions: string | null;
    requireApproval: boolean;
    cred: NonNullable<Awaited<ReturnType<typeof getActiveCredentialForUser>>>;
  },
): Promise<'queued' | 'skipped'> {
  const { userId, integrationId, message, conv, chatId } = ctx;

  const skip = async (reason: string, state: 'skipped' | 'failed' = 'skipped') => {
    await admin
      .from('messages')
      .update({ auto_reply_state: state, auto_reply_error: reason })
      .eq('id', message.id)
      .eq('user_id', userId);
    return 'skipped' as const;
  };

  // The allowlist, "did they take over?", and the rate limits were all settled
  // once per conversation in gateConversation before we got here. Repeating
  // them per message was pure latency: the same five questions asked five
  // times, plus five model calls, for five lines sent in one burst.
  const sentAt = message.sent_at ?? new Date().toISOString();

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

  // The brief is layered: the person's baseline, then how they write to THIS
  // contact, then the transcript (which the prompt already carries). The old
  // version injected the baseline alone — a profile derived from one romantic
  // conversation — and applied it to everyone, which is exactly what the user
  // saw: endearments and emoji in messages to people they write to formally.
  let style = 'No style profile yet — infer the style from the transcript.';
  let relationship: string | null = null;
  let relationshipDetail: string | null = null;

  try {
    const [globalProfile, contactRow] = await Promise.all([
      admin
        .from('user_style_profiles')
        .select('tone, formality, emoji_usage, humour, vocabulary_notes, signature_phrases, punctuation_habits, average_message_length')
        .eq('user_id', userId)
        .maybeSingle(),
      conv.contact_id
        ? admin
            .from('contacts')
            .select('display_name, relationship, relationship_detail, communication_style')
            .eq('id', conv.contact_id)
            .eq('user_id', userId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const gp = globalProfile.data;
    const ct = contactRow.data;

    style = composeStyleBrief({
      global: gp
        ? {
            tone: gp.tone as string | null,
            formality: gp.formality as string | null,
            emojiUsage: gp.emoji_usage as string | null,
            humour: gp.humour as string | null,
            vocabularyNotes: gp.vocabulary_notes as string | null,
            signaturePhrases: gp.signature_phrases as string[] | null,
            punctuationHabits: gp.punctuation_habits as string | null,
            averageMessageLength: gp.average_message_length as number | null,
          }
        : null,
      contact: ct
        ? {
            displayName: ct.display_name as string | null,
            relationship: ct.relationship as string | null,
            relationshipDetail: ct.relationship_detail as string | null,
            communicationStyle: ct.communication_style as string | null,
          }
        : null,
      instructions: ctx.instructions,
    });

    relationship = (ct?.relationship as string | null) ?? null;
    relationshipDetail = (ct?.relationship_detail as string | null) ?? null;
  } catch {
    /* a missing style profile is not fatal */
  }

  // The user's explicit emoji instruction outranks anything inferred. Read it
  // separately from the brief so a missing profile degrades to 'auto' (the
  // conservative ceiling of one) rather than to "no policy at all".
  let emojiPreference: EmojiPreference = 'auto';
  try {
    const { data: prefs } = await admin
      .from('user_style_profiles')
      .select('emoji_preference')
      .eq('user_id', userId)
      .maybeSingle();
    const p = prefs?.emoji_preference as EmojiPreference | undefined;
    if (p === 'never' || p === 'match' || p === 'auto') emojiPreference = p;
  } catch {
    /* keep the ceiling */
  }

  const incoming = (message.body as string) ?? '';

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
        userInstructions: [SAFETY_INSTRUCTIONS, emojiInstruction(emojiPreference, incoming), ctx.instructions]
          .filter(Boolean)
          .join('\n\n'),
        count: 1,
      }),
      { temperature: 0.6, maxTokens: 300 },
    );

    const parsed = parseJsonResponse<{ replies: { text: string; angle: string }[] }>(result.text);
    const text = parsed?.replies?.[0]?.text?.trim();
    if (!text) return skip('model returned no usable reply', 'failed');
    // The prompt asked; this is the guarantee. Whatever the model wrote, what
    // leaves here obeys the user's emoji preference.
    draft = applyEmojiPolicy({ text, preference: emojiPreference, incoming }).text.slice(0, 1000);
    if (!draft.trim()) return skip('reply was empty after removing emoji', 'failed');
  } catch (e) {
    return skip(`model error: ${(e as Error).message}`, 'failed');
  }

  // ── Last look before it leaves ──────────────────────────────────────────
  // Drafting takes a model round trip, and the user is very likely holding the
  // phone at that moment. Checking only before drafting meant a reply written
  // over the user's own answer still went out. If they have said anything since
  // this message arrived, they are handling it and the draft is thrown away.
  if (await userRepliedSince(admin, userId, conv.id, sentAt)) return skip('you already replied');

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
      chat_jid: chatId,
      to_phone: chatId,
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
