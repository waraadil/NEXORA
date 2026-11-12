/**
 * AUTO-REPLY SCOPE — who is allowed to be answered in the user's voice.
 *
 * This is the most consequential decision in the whole integration, and for a
 * while it was not a decision at all: every one-to-one chat was eligible. A
 * user reasonably read "connect your WhatsApp and the AI replies for you" and
 * then found it answering their partner — and would have been equally
 * surprised, and far less amused, to find it answering a client.
 *
 * The rule is now the other way round: answer nobody unless the user has
 * explicitly allowed *that person*. The default is silence. Silence is a bug
 * users report; unwanted speech is a bug users cannot un-send.
 *
 * Kept free of server imports so the policy can be tested directly.
 */

export type AutoReplyMode = 'off' | 'on';

export type ConversationScope = {
  id: string;
  title: string | null;
  auto_reply_mode: AutoReplyMode;
  auto_reply_paused_at: string | null;
  auto_reply_paused_reason: string | null;
  auto_reply_used: number;
};

/** Per-chat ceiling per hour. Mirrors MAX_PER_CONVERSATION_PER_HOUR. */
export const MAX_PER_CONVERSATION_PER_HOUR = 6;

export type ScopeDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'not_allowed' // user has not opted this person in — the common case
        | 'chat_paused' // this chat tripped its own rate limit
        | 'rate_limited'; // hour's allowance spent
      detail: string;
    };

/**
 * Should this chat be answered at all?
 *
 * `isGroup` is checked again here rather than trusted from the caller: the
 * allowlist is a safety control, and a safety control that only works when
 * other code remembered to filter first is not a control.
 */
export function canAutoReply(params: {
  isGroup: boolean;
  conversation: Pick<
    ConversationScope,
    'auto_reply_mode' | 'auto_reply_paused_at' | 'auto_reply_paused_reason'
  > | null;
  usedThisHour: number;
  /** False when the user has not switched auto-reply on at all. */
  globallyEnabled: boolean;
}): ScopeDecision {
  if (params.isGroup) {
    return { allowed: false, reason: 'not_allowed', detail: 'group chats are never auto-answered' };
  }
  if (!params.globallyEnabled) {
    return { allowed: false, reason: 'not_allowed', detail: 'auto-reply is off' };
  }
  if (!params.conversation) {
    return { allowed: false, reason: 'not_allowed', detail: 'conversation missing' };
  }
  if (params.conversation.auto_reply_paused_at) {
    return {
      allowed: false,
      reason: 'chat_paused',
      detail:
        params.conversation.auto_reply_paused_reason ??
        `auto-reply to this person is paused (${MAX_PER_CONVERSATION_PER_HOUR} per hour)`,
    };
  }
  if (params.conversation.auto_reply_mode !== 'on') {
    return {
      allowed: false,
      reason: 'not_allowed',
      detail: 'this person is not on the auto-reply list',
    };
  }
  if (params.usedThisHour >= MAX_PER_CONVERSATION_PER_HOUR) {
    return {
      allowed: false,
      reason: 'rate_limited',
      detail: `rate limit: ${MAX_PER_CONVERSATION_PER_HOUR} auto-replies per chat per hour`,
    };
  }
  return { allowed: true };
}

/**
 * Human-readable label for the conversation list, so the user can see at a
 * glance who is answered and who is not.
 */
export function scopeLabel(mode: AutoReplyMode): 'AI on' | 'AI off' {
  return mode === 'on' ? 'AI on' : 'AI off';
}

/**
 * Parses what a request asked for. Anything unrecognised is 'off' — an
 * allowlist that can be enabled by a typo is not an allowlist.
 */
export function parseMode(value: unknown): AutoReplyMode {
  return value === 'on' ? 'on' : 'off';
}
