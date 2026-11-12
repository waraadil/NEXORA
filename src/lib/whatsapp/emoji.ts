/**
 * EMOJI POLICY — what we may write as the user.
 *
 * A real complaint, in the user's own words: the AI "uses emoji with every
 * message that's not my style". That is the failure mode of style matching in
 * general — the transcript said "🥰❤️" once during a romantic exchange, and the
 * model read that as permission to decorate every message forever.
 *
 * So the rule stops being a suggestion to the model and becomes a guarantee
 * applied to its output. The prompt still asks nicely (cheap, and it produces
 * better text), but whatever comes back passes through here before it can be
 * sent under someone's name.
 *
 * Kept deliberately dependency-free and free of server imports so it can be
 * tested directly — see scripts/test-emoji-policy.ts.
 */

export type EmojiPreference = 'auto' | 'never' | 'match';

/**
 * Emoji, pictographs, dingbats, and the invisible joinery that holds sequences
 * together (ZWJ, variation selectors, keycaps). Regional indicators are matched
 * as a pair so a single flag is treated as one unit rather than two letters.
 */
const EMOJI_SOURCE =
  '(?:\\p{Regional_Indicator}{2})|\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E)?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E)?)*|[#*0-9]\\uFE0F?\\u20E3';

/** Sticky-free builder so each caller owns its own lastIndex state. */
const emojiRe = (flags: string) => new RegExp(EMOJI_SOURCE, flags);

const PRESENTATION_SELECTORS = /[\uFE0E\uFE0F\u200D]/g;

/** Does this text contain at least one emoji? */
export function hasEmoji(text: string): boolean {
  return emojiRe('u').test(text ?? '');
}

/** How many emoji, counting a joined sequence (👨‍👩‍👧) once. */
export function countEmoji(text: string): number {
  return (text ?? '').match(emojiRe('gu'))?.length ?? 0;
}

/** Every distinct emoji used in a text, in order of first appearance. */
export function emojiIn(text: string): string[] {
  const found = (text ?? '').match(emojiRe('gu')) ?? [];
  return [...new Set(found)];
}

/**
 * Remove every emoji, then tidy the wreckage they leave behind.
 *
 * Deleting "❤️" from "i love you ❤️" must not leave "i love you " or the
 * double spaces from "wow 🥰 so good". The cleanup is deliberately conservative:
 * it collapses repeated whitespace and trims, and removes spaces that were left
 * directly before punctuation. It never rewrites words.
 */
export function stripEmoji(text: string): string {
  let out = (text ?? '').replace(emojiRe('gu'), '');
  out = out.replace(PRESENTATION_SELECTORS, '');
  out = out.replace(/[ \t]{2,}/g, ' '); // collapse runs left by removals
  out = out.replace(/[ \t]+([,.!?;:])/g, '$1'); // "hello ," → "hello,"
  out = out.replace(/[ \t]+$/gm, ''); // trailing spaces per line
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/**
 * Would stripping emoji destroy the message?
 *
 * "🥰" on its own, or "😭😭😭", is a complete reply in a chat. Blanking it
 * would turn a reply into an empty string, and sending nothing is worse than
 * sending one emoji the user might not have chosen. When there is nothing left
 * but punctuation, we keep the original rather than send "".
 */
function survivesStripping(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(stripEmoji(text));
}

export type EmojiDecision = {
  text: string;
  /** True when the policy changed what the model produced. */
  changed: boolean;
  /** What was applied, for logs and for the UI's explanation. */
  applied: EmojiPreference;
};

/**
 * Apply the user's emoji policy to a drafted reply.
 *
 * - `never` — the user said they do not write this way. Every emoji goes, and
 *   the prompt is expected to have already been told not to use them, so a
 *   change here means the model ignored the instruction.
 * - `match` — mirror the other person, capped at one so a heavy emoji user
 *   cannot turn the user's reply into a sticker sheet.
 * - `auto` — trust the style profile, but enforce a ceiling of one emoji per
 *   message. This is the guard that would have caught the original complaint:
 *   the model had already been told "emoji: rare" and still put one on every
 *   line. One emoji reads like a person; five reads like a bot.
 *
 * `incoming` is the message being replied to, used only by `match`.
 */
export function applyEmojiPolicy(params: {
  text: string;
  preference: EmojiPreference;
  incoming?: string | null;
}): EmojiDecision {
  const { preference, incoming } = params;
  const text = (params.text ?? '').trim();
  if (!text) return { text, changed: false, applied: preference };

  if (preference === 'never') {
    if (!hasEmoji(text)) return { text, changed: false, applied: preference };
    if (!survivesStripping(text)) return { text, changed: false, applied: preference };
    return { text: stripEmoji(text), changed: true, applied: preference };
  }

  const allowed = preference === 'match' ? (hasEmoji(incoming ?? '') ? 1 : 0) : 1;

  if (!hasEmoji(text)) return { text, changed: false, applied: preference };
  if (allowed === 0) {
    if (!survivesStripping(text)) return { text, changed: false, applied: preference };
    return { text: stripEmoji(text), changed: true, applied: preference };
  }

  // Keep the first `allowed` emoji, drop the rest.
  const total = countEmoji(text);
  if (total <= allowed) return { text, changed: false, applied: preference };

  let kept = 0;
  const trimmed = text.replace(emojiRe('gu'), (m) => {
    kept += 1;
    return kept <= allowed ? m : '';
  });
  const cleaned = survivesStripping(trimmed)
    ? trimmed.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.!?;:])/g, '$1').trim()
    : text;

  return { text: cleaned, changed: cleaned !== text, applied: preference };
}

/**
 * The prompt-side instruction for a policy.
 *
 * Saying this once, plainly, in the user's own terms is worth more than any
 * amount of "match the style profile" ambiguity. The output filter above is the
 * backstop, not the plan.
 */
export function emojiInstruction(preference: EmojiPreference, incoming?: string | null): string {
  switch (preference) {
    case 'never':
      return 'Do not use any emoji at all. Not one, not even a heart — the user does not write that way.';
    case 'match':
      return hasEmoji(incoming ?? '')
        ? 'Use at most one emoji, and only because the other person used one.'
        : 'The other person used no emoji, so use none.';
    default:
      return 'Use at most one emoji in the whole message, and only if it genuinely fits. Most replies should have none.';
  }
}
