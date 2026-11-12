/**
 * Burst handling: five messages in a row must produce ONE reply, not five.
 *
 * Reported from real use ("a burst of messages getting burst of replies"). The
 * cause was structural, not a tuning problem: the planner claimed every pending
 * message and ran a full gate + model call for each one. Two separate fixes are
 * tested here — collapsing the turn, and waiting for the person to stop typing
 * before answering — so that a future change to either cannot silently bring
 * the machine-gun replies back.
 *
 * Run: npx tsx scripts/test-burst-reply.ts
 */
import {
  collapseTurns,
  shouldWaitForSettle,
  REPLY_SETTLE_MS,
  MAX_SETTLE_MS,
} from '../src/lib/whatsapp/burst';

let pass = 0;
let fail = 0;
const ok = (n: string, x = '') => {
  pass++;
  console.log(`  PASS  ${n}${x ? ` — ${x}` : ''}`);
};
const no = (n: string, x = '') => {
  fail++;
  console.log(`  FAIL  ${n}${x ? ` — ${x}` : ''}`);
};
const eq = (a: unknown, e: unknown, n: string) => {
  const A = JSON.stringify(a);
  const E = JSON.stringify(e);
  A === E ? ok(n) : no(n, `got ${A}, expected ${E}`);
};

const msg = (id: string, conv: string, secondsAgo: number) => ({
  id,
  conversation_id: conv,
  sent_at: new Date(Date.now() - secondsAgo * 1000).toISOString(),
});

console.log('\n[One reply per burst]');

{
  // The exact shape of the complaint: four lines, one after another.
  const burst = [msg('m1', 'c1', 30), msg('m2', 'c1', 24), msg('m3', 'c1', 18), msg('m4', 'c1', 12)];
  const turns = collapseTurns(burst);
  eq(turns.length, 1, 'four messages in one burst become a single turn');
  eq(turns[0]?.id, 'm4', 'the turn is represented by its newest message');
}

{
  const twoPeople = [msg('a1', 'c1', 40), msg('a2', 'c1', 30), msg('b1', 'c2', 20)];
  const turns = collapseTurns(twoPeople);
  eq(turns.length, 2, 'two conversations stay independent');
  eq(turns.map((t) => t.id).sort(), ['a2', 'b1'], 'each conversation contributes its newest');
}

{
  eq(collapseTurns([]).length, 0, 'an empty batch is empty');
  const one = collapseTurns([msg('x', 'c1', 5)]);
  eq(one.length, 1, 'a single message is still a turn');
}

{
  // Missing timestamps must not collapse everything into one arbitrary row.
  const noTimes = [
    { id: 'n1', conversation_id: 'c1', sent_at: null },
    { id: 'n2', conversation_id: 'c1', sent_at: null },
  ];
  eq(collapseTurns(noTimes).length, 1, 'rows without timestamps still yield one turn, not a crash');
}

console.log('\n[Wait for them to stop typing]');

{
  const now = Date.now();
  eq(
    shouldWaitForSettle({ newestAt: now - 1000, now, firstSeenAt: now - 2000 }),
    true,
    'a message one second old is too fresh to answer',
  );
  eq(
    shouldWaitForSettle({ newestAt: now - REPLY_SETTLE_MS - 500, now, firstSeenAt: now - 20000 }),
    false,
    'a message older than the settle window is answered',
  );
  eq(
    shouldWaitForSettle({ newestAt: now - 1000, now, firstSeenAt: now - MAX_SETTLE_MS - 1000 }),
    false,
    'waiting is capped so a chat that never goes quiet still gets an answer',
  );
  eq(
    shouldWaitForSettle({ newestAt: now - 3000, now, firstSeenAt: null }),
    true,
    'a missing first-seen time does not disable the wait',
  );
}

{
  // The wait must be shorter than the time a person takes to type three lines,
  // but long enough to cover the relay's own polling jitter. Guarding the
  // constant itself, because "just make it 0 to be snappy" is the regression.
  REPLY_SETTLE_MS >= 3000 && REPLY_SETTLE_MS <= 15000
    ? ok('the settle window is sane for a chat', `${REPLY_SETTLE_MS}ms`)
    : no('settle window outside a sane range', String(REPLY_SETTLE_MS));
  MAX_SETTLE_MS > REPLY_SETTLE_MS
    ? ok('the cap is longer than the window', `${MAX_SETTLE_MS}ms`)
    : no('cap shorter than the window');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
