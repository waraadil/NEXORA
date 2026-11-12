/**
 * BURST HANDLING — one reply per burst, not one per message.
 *
 * People do not send a single message. They send four lines and a correction,
 * a few seconds apart. The relay polls every three seconds, so each of those
 * lines became its own "turn" with its own gate evaluation and its own model
 * call: a burst of messages produced a burst of replies, each written against a
 * slightly different half of the conversation. Reported from real use as "a
 * burst of messages getting burst of replies".
 *
 * Two rules fix it, and they are complementary:
 *
 *   1. Settle — do not answer a chat while it is still being typed into.
 *   2. Collapse — when we do answer, answer the newest message of the run and
 *      let the transcript supply the rest as context.
 *
 * Kept free of server imports so the behaviour can be tested directly
 * (scripts/test-burst-reply.ts). The planner imports from here.
 */

/**
 * How long a chat must be quiet before it is answered.
 *
 * Six seconds is longer than the gap between lines of a burst and shorter than
 * the time a person takes to notice a reply, so it costs nothing perceptible
 * and removes almost every duplicate. The floor matters: making this zero to
 * feel "snappy" is exactly what caused the problem.
 */
export const REPLY_SETTLE_MS = 6_000;

/** Give up waiting on a chat that never goes quiet. */
export const MAX_SETTLE_MS = 45_000;

/**
 * Should we hold off, because this conversation may still be being typed into?
 *
 * `firstSeenAt` is when this batch first started waiting; the cap stops a chat
 * that never settles from being ignored forever.
 */
export function shouldWaitForSettle(params: {
  newestAt: number;
  now: number;
  firstSeenAt: number | null;
  settleMs?: number;
  maxWaitMs?: number;
}): boolean {
  const settle = params.settleMs ?? REPLY_SETTLE_MS;
  const maxWait = params.maxWaitMs ?? MAX_SETTLE_MS;
  if (params.firstSeenAt !== null && params.now - params.firstSeenAt >= maxWait) return false;
  return params.now - params.newestAt < settle;
}

/**
 * A turn is the run of messages a person sent before pausing. Given everything
 * claimed, keep only the newest message per conversation; the ones before it
 * are context, and the transcript already carries them.
 *
 * Per conversation rather than per direction because relay-sent replies are
 * excluded upstream (is_from_me = false is what gets claimed).
 */
export function collapseTurns<
  T extends { id: string; conversation_id: string; sent_at: string | null },
>(messages: T[]): T[] {
  const byConversation = new Map<string, T[]>();
  for (const m of messages) {
    const list = byConversation.get(m.conversation_id) ?? [];
    list.push(m);
    byConversation.set(m.conversation_id, list);
  }

  const newestPerTurn: T[] = [];
  for (const list of byConversation.values()) {
    const sorted = [...list].sort(
      (a, b) => new Date(a.sent_at ?? 0).getTime() - new Date(b.sent_at ?? 0).getTime(),
    );
    const last = sorted[sorted.length - 1];
    if (last) newestPerTurn.push(last);
  }
  return newestPerTurn;
}
