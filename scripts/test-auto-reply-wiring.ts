/**
 * Contract checks on the planner itself.
 *
 * The rules are unit-tested separately; this asserts the planner actually
 * *calls* them, in the right order. A refactor that drops the allowlist call
 * would still pass every unit test — that is precisely the regression worth
 * guarding, because it is silent.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('src/lib/whatsapp/auto-reply.ts', 'utf8');
let pass = 0;
let fail = 0;
const ok = (n: string) => { pass++; console.log(`  PASS  ${n}`); };
const no = (n: string) => { fail++; console.log(`  FAIL  ${n}`); };
const check = (cond: boolean, n: string) => (cond ? ok(n) : no(n));

console.log('\n[Planner wiring]');

check(src.includes('canAutoReply('), 'planner calls the allowlist gate');
check(/auto_reply_mode/.test(src), 'planner reads the per-conversation mode');
check(/isGroup: !!conv\.is_group/.test(src), 'planner passes group status into the gate');
check(/if \(!scope\.allowed\) return skip\(scope\.detail\)/.test(src), 'a refused gate stops before drafting');
check(src.indexOf('canAutoReply(') < src.indexOf('callProvider('), 'the gate runs BEFORE the model is called');

// The allowlist must be checked before any AI spend, otherwise "off" still
// costs money and still burns rate limit.
check(
  src.indexOf('auto-reply-scope') < src.indexOf('replyPrompt('),
  'scope module is imported and used before drafting',
);

check(src.includes('applyEmojiPolicy('), 'the emoji policy is applied to model output');
check(
  src.indexOf('applyEmojiPolicy(') > src.indexOf('callProvider('),
  'emoji policy is applied AFTER the model answers (it is a guarantee, not a request)',
);
check(src.includes('emojiInstruction('), 'the model is also told the policy up front');

// The re-check before sending is what fixes "it kept quiet after I replied".
const recheck = src.lastIndexOf('userRepliedSince(');
check(recheck > src.indexOf('callProvider('), 'the "did they reply themselves?" check runs again after drafting');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
