/**
 * Tests for the two rules that keep the AI from embarrassing its owner:
 * the per-person allowlist, and the emoji ceiling.
 *
 * These are pure functions on purpose. The behaviour they encode was reported
 * from a real phone ("it replied to my partner", "it uses emoji every message"),
 * and the regression that matters is silent: a future refactor quietly widening
 * the allowlist back to "everyone" would look like nothing at all in a diff.
 *
 * Run: npx tsx scripts/test-auto-reply-policy.ts
 */
import { canAutoReply, parseMode, MAX_PER_CONVERSATION_PER_HOUR } from '../src/lib/whatsapp/auto-reply-scope';
import { applyEmojiPolicy, hasEmoji, countEmoji, stripEmoji, emojiInstruction } from '../src/lib/whatsapp/emoji';

let pass = 0;
let fail = 0;

function ok(name: string) {
  pass++;
  console.log(`  PASS  ${name}`);
}
function no(name: string, detail?: string) {
  fail++;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(actual: unknown, expected: unknown, name: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(name);
  else no(name, `got ${a}, expected ${e}`);
}

const conv = (mode: 'off' | 'on', paused: string | null = null) => ({
  auto_reply_mode: mode,
  auto_reply_paused_at: paused,
  auto_reply_paused_reason: paused ? 'rate limited earlier' : null,
});

// ─────────────────────────── allowlist ───────────────────────────
console.log('\n[Who gets answered]');

{
  // The headline behaviour: switched on globally, but this person was never
  // added. Before this fix this exact case sent a reply.
  const d = canAutoReply({ isGroup: false, conversation: conv('off'), usedThisHour: 0, globallyEnabled: true });
  eq(d.allowed, false, 'a contact not on the list is NOT answered (the reported bug)');
  if (!d.allowed && d.reason === 'not_allowed') ok('says why: not on the list');
  else no('wrong reason', JSON.stringify(d));
}

eq(
  canAutoReply({ isGroup: false, conversation: conv('on'), usedThisHour: 0, globallyEnabled: true }).allowed,
  true,
  'an allowed contact IS answered',
);

eq(
  canAutoReply({ isGroup: true, conversation: conv('on'), usedThisHour: 0, globallyEnabled: true }).allowed,
  false,
  'a group is refused even if a crafted request marks it allowed',
);

eq(
  canAutoReply({ isGroup: false, conversation: null, usedThisHour: 0, globallyEnabled: true }).allowed,
  false,
  'a missing conversation is refused rather than defaulted open',
);

eq(
  canAutoReply({ isGroup: false, conversation: conv('on'), usedThisHour: 0, globallyEnabled: false }).allowed,
  false,
  'global switch off wins over a per-person allow',
);

{
  const d = canAutoReply({ isGroup: false, conversation: conv('on', '2026-01-01T00:00:00Z'), usedThisHour: 0, globallyEnabled: true });
  eq(d.allowed, false, 'a paused chat stays paused');
  if (!d.allowed && d.reason === 'chat_paused') ok('explains the pause');
  else no('pause reason wrong', JSON.stringify(d));
}

{
  const d = canAutoReply({
    isGroup: false,
    conversation: conv('on'),
    usedThisHour: MAX_PER_CONVERSATION_PER_HOUR,
    globallyEnabled: true,
  });
  eq(d.allowed, false, 'hourly ceiling per chat is enforced');
  if (!d.allowed && d.reason === 'rate_limited') ok('distinguishes rate limit from "not allowed"');
  else no('rate limit reason wrong', JSON.stringify(d));
}

eq(parseMode('on'), 'on', 'parseMode accepts "on"');
eq(parseMode('ON'), 'off', 'parseMode is case-sensitive, not eager');
eq(parseMode(undefined), 'off', 'parseMode defaults to off');
eq(parseMode('yes'), 'off', 'parseMode refuses anything it does not recognise');

// ─────────────────────────── emoji ───────────────────────────
console.log('\n[Emoji]');

eq(countEmoji('i love you ❤️'), 1, 'counts a basic emoji');
eq(countEmoji('👨‍👩‍👧 family'), 1, 'counts a ZWJ sequence once, not three times');
eq(countEmoji('🇮🇳 flag'), 1, 'counts a flag as one');
eq(countEmoji('thik hai'), 0, 'no emoji is zero');
eq(hasEmoji('ok 👍'), true, 'detects emoji');
eq(hasEmoji('plain text'), false, 'detects absence');

{
  // The exact kind of message that caused the complaint.
  const original = 'i love you moreee meri motii 🥰 jnuuuuuuuu ❤️';
  const d = applyEmojiPolicy({ text: original, preference: 'never' });
  eq(d.text, 'i love you moreee meri motii jnuuuuuuuu', '"never" strips every emoji and leaves clean text');
  eq(d.changed, true, 'reports that it changed something');
}

eq(
  applyEmojiPolicy({ text: 'sent from the airport 🛫 at 6', preference: 'never' }).text,
  'sent from the airport at 6',
  'removal does not leave a double space',
);

{
  const d = applyEmojiPolicy({ text: 'kya kr rhi ho meri motii 🥹🫶', preference: 'auto' });
  eq(countEmoji(d.text), 1, '"auto" allows at most one emoji');
  eq(d.changed, true, 'trims the extras');
  if (d.text.includes('🥹')) ok('keeps the first emoji rather than a random one');
  else no('kept the wrong emoji', d.text);
}

eq(
  applyEmojiPolicy({ text: 'theek hai bhai', preference: 'auto' }).changed,
  false,
  'leaves a reply with no emoji untouched',
);

eq(
  applyEmojiPolicy({ text: 'haha 🥰', preference: 'match', incoming: 'tum kahan ho' }).text,
  'haha',
  '"match" removes emoji when the other person used none',
);

eq(
  applyEmojiPolicy({ text: 'haha 🥰❤️', preference: 'match', incoming: 'miss you ❤️' }).text,
  'haha 🥰',
  '"match" keeps one when the other person used one',
);

{
  // An emoji-only reply is a real reply in a chat. Sending "" would be worse
  // than sending one emoji the user might not have picked.
  const d = applyEmojiPolicy({ text: '😭😭😭', preference: 'never' });
  eq(d.text, '😭😭😭', 'an emoji-only reaction is not blanked into silence');
}

{
  const d = applyEmojiPolicy({ text: 'ok ❤️', preference: 'never' });
  eq(d.text, 'ok', 'trailing emoji removal tidies the space');
}

eq(
  stripEmoji('  hello   there 🥰 '),
  'hello there',
  'stripEmoji collapses runs and trims',
);

{
  const never = emojiInstruction('never');
  if (/any emoji/i.test(never)) ok('the prompt instruction for "never" is unambiguous');
  else no('weak never-instruction', never);
  const matchEmpty = emojiInstruction('match', 'no emoji here');
  if (/none/i.test(matchEmpty)) ok('"match" is told to use none when the other person did not');
  else no('bad match instruction', matchEmpty);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log(`failed: ${pass + fail} checks, ${fail} bad`);
  process.exit(1);
}
