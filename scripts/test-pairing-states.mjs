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
