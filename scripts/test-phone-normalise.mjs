/**
 * UNIT TEST — pairing phone numbers
 *
 * The bug this exists for: someone typed `9149400036`, their 10-digit Indian
 * mobile with no `91` in front. It passed validation, the agent asked WhatsApp
 * for a pairing code against it, WhatsApp issued one, the app displayed it, and
 * it could never link. The phone said "couldn't link device" and the only thing
 * wrong was a missing prefix — invisible to the person, and impossible to
 * diagnose from the screen.
 *
 * The trap in fixing it is length. A blanket "reject anything under 11 digits"
 * reads as a fair rule and quietly breaks Singapore (+65 and 8 digits is 10 in
 * total), Denmark and Norway, all of which are real. So the length of the whole
 * string is not the signal — whether it fits a country code is.
 *
 * Runs without a server: the functions are extracted from the source so the
 * test cannot drift from the implementation.
 */

import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/lib/whatsapp/relay.ts', import.meta.url), 'utf8');

function extract(name, endMarker) {
  const start = src.indexOf(`export function ${name}`);
  if (start === -1) throw new Error(`${name} not found in relay.ts`);
  const body = endMarker ? src.slice(start, src.indexOf(endMarker, start)) : src.slice(start);
  return body.slice(0, body.indexOf('\n}') + 2);
}

const source =
  extract('normalizePairingPhone', 'export function pairingPhoneProblem') +
  extract('pairingPhoneProblem', 'function hashKey');

const code = source
  .replace(/export function/g, 'function')
  .replace(/: string \| null/g, '')
  .replace(/: string/g, '');

const { normalizePairingPhone, pairingPhoneProblem } = new Function(
  `${code}; return { normalizePairingPhone, pairingPhoneProblem };`,
)();

let passed = 0;
let failed = 0;
const failures = [];

function check(ok, label, detail) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    failures.push(detail ? `${label} (${detail})` : label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('[A number with a country code is accepted]');
for (const [input, label] of [
  ['919149400036', 'India, 12 digits'],
  ['919797000781', 'India, the number used in testing'],
  ['+91 98765 43210', 'India written with a plus and spaces'],
  ['0919797000781', 'India with a stray leading zero'],
  ['6581234567', 'Singapore, 10 digits — the case a length rule breaks'],
  ['4598765432', 'Denmark, 10 digits'],
  ['14155552671', 'United States, 11 digits'],
]) {
  const problem = pairingPhoneProblem(input);
  check(problem === null, label, problem ?? undefined);
  check(normalizePairingPhone(input) === String(input).replace(/\D/g, '').replace(/^0+/, ''),
    `${label} — normalises to digits`);
}

console.log('\n[The reported mistake is named, not silently accepted]');
{
  const problem = pairingPhoneProblem('9149400036');
  check(problem !== null, 'a bare 10-digit Indian number is refused');
  check(/country code/i.test(problem ?? ''), 'the message says the country code is missing');
  check(
    (problem ?? '').includes('919149400036'),
    'and shows the corrected number rather than repeating the rule',
  );
  // The dangerous part was never the wrong number — it was that a code got
  // issued for it anyway. Refusing here is what prevents the dead code.
  check(
    normalizePairingPhone('9149400036') !== null,
    'the normaliser still yields digits, so the guard must be in the caller',
  );
}

console.log('\n[Lengths that cannot be international numbers]');
check(pairingPhoneProblem('123456') !== null, 'six digits is too short');
check(pairingPhoneProblem('1234567890123456') !== null, 'sixteen digits is too long');
check(pairingPhoneProblem('') !== null, 'an empty field says what to enter');
check(pairingPhoneProblem('   ') !== null, 'whitespace only is still empty');

console.log('\n[Non-Indian 10-digit numbers are not caught by the Indian rule]');
for (const input of ['6581234567', '4598765432', '4798765432']) {
  check(pairingPhoneProblem(input) === null, `${input} passes`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`failed: ${failures.join(' | ')}`);
  process.exit(1);
}
