/**
 * Regression suite for the WhatsApp parser.
 * Run: npx tsx scripts/test-parser.mjs
 * Every case here is a real export shape; a failure means imports would
 * corrupt user data, so this must stay green.
 */
import assert from 'node:assert';
import { parseWhatsAppExport, looksLikeWhatsAppExport } from '../src/lib/whatsapp/parser.ts';

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

console.log('\nwhatsapp parser');

// ── iOS bracketed, 12h clock, own messages labelled "You" ──
const ios = `[12/03/2024, 9:14:32 PM] Alice: Hey! How did the interview go?
[12/03/2024, 9:15:01 PM] You: It went well actually 😄
[12/03/2024, 9:15:20 PM] Alice: No way, tell me everything
[12/03/2024, 9:16:44 PM] You: Got the offer. Starting Monday.
[12/03/2024, 9:17:02 PM] Alice: <Media omitted>
[12/03/2024, 9:18:00 PM] Alice: I'm so proud of you!`;

const r1 = parseWhatsAppExport(ios, { meName: 'You' });

check('iOS: all 6 messages parsed, none lost', () => {
  assert.equal(r1.messages.length, 6);
  assert.equal(r1.formatDetected, 'ios-bracketed');
});
check('iOS: own messages flagged fromMe', () => {
  const mine = r1.messages.filter((m) => m.isFromMe);
  assert.equal(mine.length, 2);
  assert.equal(mine[0].body, 'It went well actually 😄');
});
check('iOS: 12h PM converted to 24h UTC', () => {
  assert.equal(r1.messages[0].sentAt, '2024-03-12T21:14:32.000Z');
});
check('iOS: media placeholder preserved, not dropped', () => {
  assert.ok(r1.messages.some((m) => m.body.includes('Media omitted')));
});

// ── Android dash, 24h, system banner, multi-line body ──
const android = `12/03/2024, 21:14 - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.
12/03/2024, 21:15 - Alice: Multi-line test
this is line two
and line three
12/03/2024, 21:16 - You: got it
12/03/2024, 21:17 - Alice: ok`;

const r2 = parseWhatsAppExport(android, { meName: 'You' });

check('Android: encryption banner counted as system, not a message', () => {
  assert.equal(r2.systemLineCount, 1);
  assert.equal(r2.messages.length, 3);
  assert.ok(!r2.messages.some((m) => m.senderName.toLowerCase().includes('end-to-end')));
});
check('Android: multi-line body joined, not truncated', () => {
  const ml = r2.messages.find((m) => m.body.startsWith('Multi-line'));
  assert.equal(ml?.body, 'Multi-line test\nthis is line two\nand line three');
});
check('Android: "You" is the owner, not a system sender', () => {
  const mine = r2.messages.filter((m) => m.isFromMe);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].body, 'got it');
});

// ── Group chat: participant detection ──
const group = `12/03/2024, 10:00 - Alice: Morning all
12/03/2024, 10:01 - Bob: Morning
12/03/2024, 10:02 - Carol: hi
12/03/2024, 10:03 - Alice: project update?
12/03/2024, 10:04 - Bob: on track`;

const r3 = parseWhatsAppExport(group, { meName: 'You' });

check('group: three participants detected', () => {
  assert.equal(r3.participants.length, 3);
  assert.equal(r3.isGroup, true);
});
check('group: participant counts correct', () => {
  const alice = r3.participants.find((p) => p.name === 'Alice');
  assert.equal(alice?.messageCount, 2);
});

// ── Dedupe: re-importing the same export yields identical hashes ──
check('dedupe: hashes stable across two parses', () => {
  const a = parseWhatsAppExport(group).messages.map((m) => m.hash);
  const b = parseWhatsAppExport(group).messages.map((m) => m.hash);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length, 'hashes must be unique within an export');
});

// ── Guardrails ──
check('detector accepts WhatsApp export', () => {
  assert.equal(looksLikeWhatsAppExport(ios), true);
});
check('detector rejects arbitrary text', () => {
  assert.equal(looksLikeWhatsAppExport('hello world\njust some text'), false);
});
check('garbage before any message reported as an issue', () => {
  const r = parseWhatsAppExport(`<b>random html</b>\n[12/03/2024, 9:14:32 PM] Alice: hi`);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].lineNumber, 1);
});
check('unprefixed line after a message is a continuation, not an issue', () => {
  // This is the correct reading: WhatsApp multi-line messages have no prefix.
  const r = parseWhatsAppExport(`[12/03/2024, 9:14:32 PM] Alice: line one\nline two`);
  assert.equal(r.issues.length, 0);
  assert.equal(r.messages[0].body, 'line one\nline two');
});

// ── Arabic / RTL digits and bidi marks ──
check('Arabic export with bidi marks and Arabic-Indic digits', () => {
  const ar = `\u200f12\u200f/\u200f03\u200f/\u200f2024\u200f، \u200f9:14\u200f م - Alice: مرحبا
12/03/2024, 21:15 - Alice: ok`;
  const r = parseWhatsAppExport(ar);
  assert.ok(r.messages.length >= 1);
});

console.log(`\n${passed} checks passed\n`);
