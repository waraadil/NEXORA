/**
 * PAIRING STATES — the page must never trap the user.
 *
 * A real person hit this: they started a pairing, the 15-minute window closed
 * without a link, and the page kept showing a spinner under an "expired" badge.
 * The form that starts a new pairing was never rendered, so there was no way out
 * except a hidden "run this command in a terminal" block — the exact thing this
 * whole flow exists to remove.
 *
 * This suite seeds the states that matter and asserts what the page shows, in a
 * real browser, against a real server.
 *
 *   NEXORA_BASE=http://127.0.0.1:3100 node scripts/test-pairing-states.mjs
 *
 * Needs a server with NO agent attached (NEXORA_AGENT_URL unset), because the
 * "generating" state must be reached without an agent answering.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);

const BASE = (process.env.NEXORA_BASE ?? 'http://127.0.0.1:3100').replace(/\/+$/, '');
const pass = [], fail = [];
const ok = (n, d = '') => { pass.push(n); console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const no = (n, d = '') => { fail.push([n, d]); console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); };

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }, realtime: { transport: class {} },
});

const MINUTE = 60 * 1000;
const email = `states-${Date.now()}@example.test`;
const password = 'Test-password-123456';
const PHONE = '919797000781'; // the number from the screenshot

const { data: created } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
const userId = created.user.id;
await admin.from('profiles').upsert(
  { id: userId, email, display_name: 'State Tester', timezone: 'Asia/Kolkata', onboarded_at: new Date().toISOString() },
  { onConflict: 'id' },
);

/** Write the integration row exactly as the app would have left it. */
async function seed({
  sessionState,
  pairingMinutesAgo,
  code = null,
  codeMinutesAgo = null, // defaults to the same age as the claim
  status = 'pending',
  selfNumber = null,
}) {
  const when = new Date(Date.now() - pairingMinutesAgo * MINUTE).toISOString();
  const codeWhen = new Date(Date.now() - (codeMinutesAgo ?? pairingMinutesAgo) * MINUTE).toISOString();
  await admin.from('whatsapp_integrations').upsert(
    {
      user_id: userId,
      mode: 'personal_bridge',
      status,
      risk_acknowledged_at: new Date().toISOString(),
      risk_acknowledged_version: 'test',
      bridge_session_state: sessionState,
      bridge_session_state_at: when,
      bridge_pairing_phone: PHONE,
      bridge_pairing_at: when,
      pairing_code: code,
      pairing_code_at: code ? codeWhen : null,
      bridge_self_number: selfNumber,
      updated_at: when,
    },
    { onConflict: 'user_id' },
  );
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(e.message.slice(0, 120)));

const bodyText = () => page.locator('body').innerText();
const has = async (re) => re.test(await bodyText());

try {
  console.log('\n[1. Sign in and load the page]');
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('form button[type="submit"]').last().click();
  await page.waitForTimeout(4000);

  // ── 2. The exact state that trapped the user ──────────────────────────────
  console.log('\n[2. A pairing that expired a day ago (the reported bug)]');
  await seed({ sessionState: 'pairing', pairingMinutesAgo: 24 * 60, code: null });
  await page.goto(`${BASE}/integrations`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/Enter this code in WhatsApp/i).waitFor({ timeout: 20000 }).catch(() => {});

  (await has(/ran out of time|attempt has expired/i))
    ? ok('says the attempt ran out of time instead of spinning forever')
    : no('still does not say the pairing expired');
  (await has(/Generating your code/i))
    ? no('shows a spinner that can never resolve')
    : ok('no fake "generating" spinner');
  (await page.getByRole('button', { name: 'Get a new code' }).count()) > 0
    ? ok('offers "Get a new code" — a way out without a terminal')
    : no('no way to start a fresh pairing');
  (await has(/node relay\/agent\.mjs|NEXORA_AGENT_SECRET=/))
    ? no('a shell command is shown to the user')
    : ok('no shell command anywhere on the page');

  // ── 3. A live window must look live ──────────────────────────────────────
  console.log('\n[3. A pairing started two minutes ago with a code]');
  await seed({ sessionState: 'pairing', pairingMinutesAgo: 2, code: 'ABCD-1234' });
  await page.goto(`${BASE}/integrations`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/Enter this code in WhatsApp/i).waitFor({ timeout: 20000 }).catch(() => {});
  (await has(/ABCD-1234/))
    ? ok('renders the code')
    : no('code not rendered', (await bodyText()).slice(0, 160).replace(/\s+/g, ' '));
  (await has(/This attempt has expired/i))
    ? no('called a fresh pairing expired')
    : ok('does not call a fresh pairing expired');
  (await page.getByText(/left/i).count()) > 0
    ? ok('shows time remaining')
    : no('no countdown');

  // ── 3b. The clock must follow the CODE, not the click ────────────────────
  //
  // The original bug's other half: the agent can take a minute to get a code
  // and may retry. Timing the window from the click meant a brand-new code
  // could arrive with the countdown already near zero — and then be declared
  // expired while it was still perfectly good.
  console.log('\n[3b. A code that arrived a minute ago, from a claim 20 minutes old]');
  await seed({ sessionState: 'pairing', pairingMinutesAgo: 20, code: 'FRESH-777', codeMinutesAgo: 1 });
  await page.goto(`${BASE}/integrations`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/Enter this code in WhatsApp/i).waitFor({ timeout: 20000 }).catch(() => {});
  (await has(/FRESH-777/))
    ? ok('shows a fresh code even though the claim is old')
    : no('hid a code that WhatsApp would still accept', (await bodyText()).slice(0, 140).replace(/\s+/g, ' '));
  (await has(/ran out of time|attempt has expired/i))
    ? no('declared a live code expired')
    : ok('does not declare a live code expired');
  (await has(/1[0-5]:[0-5][0-9] left/))
    ? ok('countdown reflects the code’s own 15 minutes')
    : no('countdown does not track the code', (await bodyText()).match(/[0-9]+:[0-9]{2} left/)?.[0] ?? 'none');

  // ── 4. A dead code must not be offered ───────────────────────────────────
  console.log('\n[4. An expired window that still has a stale code stored]');
  await seed({ sessionState: 'pairing', pairingMinutesAgo: 40, code: 'STALE-9999' });
  await page.goto(`${BASE}/integrations`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/Enter this code in WhatsApp/i).waitFor({ timeout: 20000 }).catch(() => {});
  (await has(/STALE-9999/))
    ? no('showed a code WhatsApp would reject')
    : ok('hides a code from a closed window');
  (await has(/ran out of time|attempt has expired/i))
    ? ok('explains why')
    : no('does not explain');

  // ── 5. Not started at all ────────────────────────────────────────────────
  console.log('\n[5. Nothing started]');
  await seed({ sessionState: 'unpaired', pairingMinutesAgo: 0, code: null, status: 'disabled' });
  await page.goto(`${BASE}/integrations`, { waitUntil: 'domcontentloaded' });
  // The page streams; wait for the card rather than sampling "Loading".
  await page.getByText(/Link your personal WhatsApp/i).waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  // 'unpaired' renders the first-time card. Depending on how many times this
  // suite has run, the inline form may already be open — so accept the button
  // OR the number field as proof the user can start.
  (await page.getByRole('button', { name: 'Get started' }).count()) > 0 ||
  (await page.locator('#phone').count()) > 0
    ? ok('offers a way to start a pairing')
    : no('no way to start', (await bodyText()).slice(0, 160).replace(/\s+/g, ' '));
  (await has(/ran out of time|attempt has expired/i))
    ? no('called a never-started pairing expired')
    : ok('does not invent an expiry');

  // ── The case that made the button look dead ──────────────────────────────
  // A pairing has just started: the session state is 'pairing' and a real code
  // is stored, but the row's status still reads 'disabled' from its earlier
  // life. The page used to short-circuit on 'disabled' and render the
  // first-time card, so the code was fetched, stored, and never shown — the user
  // pressed the button and appeared to get nothing back. Session state is the
  // more specific signal and must win.
  console.log('\n[6. A live pairing behind a stale disabled status]');
  await seed({
    sessionState: 'pairing',
    pairingMinutesAgo: 1,
    code: 'ABCD-1234',
    status: 'disabled',
  });
  await page.goto(`${BASE}/integrations`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/Enter this code in WhatsApp/i).waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  (await has(/Enter this code in WhatsApp/i))
    ? ok('a live pairing is shown even when status says disabled')
    : no('hid a live pairing behind a stale status', (await bodyText()).slice(0, 200).replace(/\s+/g, ' '));
  (await has(/ABCD-1234/))
    ? ok('and the code it already has is on the page')
    : no('did not show the stored code');
  (await has(/Get started/) && !(await has(/Enter this code/i)))
    ? no('offered Get started while a pairing was live')
    : ok('does not offer to start over while it is live');

  // ── 7. The code must arrive while the tab is open ────────────────────────
  // The reported bug, twice: press Pair, the agent really does fetch a code and
  // store it, and the card keeps saying "Generating your code…" until the user
  // reloads. The cause was that the card watched for the code with
  // router.refresh(), the refreshed payload genuinely contained the code, and
  // React still rendered the props it already had. Nothing was wrong with the
  // data — only with the way the screen was told about it.
  //
  // So this does what a person does and nothing else: loads the page, waits for
  // the spinner, then lets the code land in the database from outside the
  // browser. No reload, no interaction. It has to show up on its own.
  console.log('\n[7. A code that arrives after the page is already open]');
  await seed({
    status: 'pending',
    sessionState: 'pairing',
    pairingMinutesAgo: 1,
    code: null,
    codeMinutesAgo: null,
  });
  await page.goto(`${BASE}/integrations`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const spinnerFirst = await has(/Generating your code/i);
  spinnerFirst ? ok('shows it is working on the code') : no('no spinner while the code is missing');

  await admin
    .from('whatsapp_integrations')
    .update({ pairing_code: 'LATE-7788', pairing_code_at: new Date().toISOString() })
    .eq('user_id', userId);

  let appeared = false;
  for (let i = 0; i < 8 && !appeared; i += 1) {
    await page.waitForTimeout(1000);
    appeared = await has(/LATE-7788/);
  }
  appeared
    ? ok('the code appeared on its own, with no reload')
    : no('needed a reload to show the code', (await bodyText()).slice(0, 200).replace(/\s+/g, ' '));
  appeared && !(await has(/Generating your code/i))
    ? ok('and the spinner is gone once the code is there')
    : appeared ? no('left the spinner up under a real code') : null;

  // ── 8. The first-ever pairing, driven through the form ───────────────────
  // Every case above starts from a seeded "pairing" row, so the server props
  // already say waiting and it is easy to believe the flow works. The real
  // first-time user starts from a page that says "Get started" and `unpaired`.
  // In that state the poll never began, because it was gated on those stale
  // props — which is why the bug survived a fix and a passing suite.
  //
  // This drives the actual form. The phone field is controlled, so it must be
  // typed rather than filled: `fill()` does not fire React's onChange and the
  // number silently stays empty, which makes the submit fail validation and the
  // test lie about what it proved. The code arriving is faked by the database
  // write below, because no agent runs against this server; everything else —
  // the click, the claim, the poll, the render — is real.
  console.log('\n[8. A first-ever pairing, from Get started]');
  await admin.from('whatsapp_integrations').delete().eq('user_id', userId);
  await page.goto(`${BASE}/integrations`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  (await has(/Get started/))
    ? ok('a fresh account is offered Get started')
    : no('a fresh account did not offer Get started');

  await page.getByRole('button', { name: 'Get started' }).click();
  await page.waitForTimeout(1200);
  await page.locator('input[name=phone]').click();
  await page.keyboard.type(PHONE, { delay: 15 });
  await page.getByRole('button', { name: /continue/i }).first().click();
  await page.waitForTimeout(1200);
  for (const box of await page.$$('input[name=ack]')) await box.click();
  await page.locator('input[name=confirm]').click();
  await page.keyboard.type('I understand the risks', { delay: 10 });
  await page.waitForTimeout(300);

  let startedPolls = 0;
  const countPoll = (r) => {
    if (r.url().includes('/api/whatsapp/pairing-status')) startedPolls += 1;
  };
  page.on('response', countPoll);

  await page.getByRole('button', { name: /create pairing code/i }).click();
  await page.waitForTimeout(5000);

  // This server has no agent configured, so the action must refuse and say so
  // rather than leaving a spinner up — the silent failure this page exists to
  // avoid. That refusal is the correct outcome here, and asserting it keeps the
  // suite honest about what this environment can actually prove.
  const refused = await has(/WhatsApp agent is not running/i);
  if (refused) {
    ok('with no agent configured, it says so instead of spinning forever');
    startedPolls === 0
      ? ok('and does not pretend to be waiting on a code')
      : no('polled even though the pairing was refused');

    // Now prove the gate itself: a pairing the action has accepted must start
    // polling immediately, even though these server props still say unpaired.
    // The row is seeded here because the agent that would create it is absent.
    await seed({ status: 'pending', sessionState: 'pairing', pairingMinutesAgo: 0, code: null });
    await page.goto(`${BASE}/integrations`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const pollsBefore = startedPolls;
    await admin
      .from('whatsapp_integrations')
      .update({ pairing_code: 'F1RS-T777', pairing_code_at: new Date().toISOString() })
      .eq('user_id', userId);
    let firstSeen = false;
    for (let i = 0; i < 7 && !firstSeen; i += 1) {
      await page.waitForTimeout(1000);
      firstSeen = await has(/F1RS-T777/);
    }
    startedPolls > pollsBefore
      ? ok('a live pairing card polls for the code', `${startedPolls - pollsBefore} polls`)
      : no('a live pairing card did not poll');
    firstSeen
      ? ok('and shows the code with no reload')
      : no('did not show the code', (await bodyText()).slice(0, 160).replace(/\s+/g, ' '));
  } else {
    // An agent is configured: the real thing must happen end to end.
    startedPolls > 0
      ? ok('it starts looking for the code without waiting for a reload', `${startedPolls} polls`)
      : no('never polled after the submit — it is gated on stale props again');
    let firstSeen = false;
    for (let i = 0; i < 10 && !firstSeen; i += 1) {
      await page.waitForTimeout(1000);
      firstSeen = await has(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
    }
    firstSeen
      ? ok('the first-ever code appeared with no reload')
      : no('the first-ever pairing still needs a reload');
  }
  page.off('response', countPoll);

  // ── 9. A dead re-pairing on a previously-linked account ──────────────────
  // Reported as "it's not giving me a pairing code, I think because the page
  // wasn't updated from last time". The row still carried bridge_self_number
  // from an older link, and describeRelay used that to decide the CURRENT
  // attempt could not be expired. So the stored status said 'pairing', the stale
  // code was correctly withheld, the expiry branch was skipped, and the card
  // rendered a spinner over a window that had closed 22 minutes earlier.
  //
  // A previous link is not evidence that the pairing in front of the user is
  // alive. With the account history present the card must still stand down.
  console.log('\n[9. A dead attempt on an account that was linked before]');
  await seed({
    status: 'pending',
    sessionState: 'pairing',
    pairingMinutesAgo: 37,
    code: 'DEAD-5555',
    codeMinutesAgo: 28,
    selfNumber: PHONE,
  });
  await page.goto(`${BASE}/integrations`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  !(await has(/Generating your code/i))
    ? ok('does not spin over a window that has closed')
    : no('still spinning on a dead attempt after a previous link');
  (await has(/ran out of time/i))
    ? ok('says the attempt ran out of time')
    : no('does not admit the attempt is over');
  !(await has(/DEAD-5555/))
    ? ok('withholds the expired code')
    : no('offered a code WhatsApp would reject');
  (await has(/Get a new code/i))
    ? ok('offers a fresh code')
    : no('no way back to a working pairing');
  (await has(/different number/i))
    ? ok('offers a different number')
    : no('no way to correct the number');

  jsErrors.length === 0 ? ok('no JS errors') : no('JS errors', jsErrors.join(' | '));
} catch (e) {
  no('crashed', e.message);
} finally {
  await browser.close();
  await admin.from('whatsapp_outbound').delete().eq('user_id', userId);
  await admin.from('whatsapp_integrations').delete().eq('user_id', userId);
  await admin.auth.admin.deleteUser(userId);
}

console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length) { console.log('failed:', fail.map(([n, d]) => `${n}${d ? ` (${d})` : ''}`).join(' | ')); process.exit(1); }
