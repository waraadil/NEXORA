/**
 * END-TO-END — pairing a personal WhatsApp with nothing typed in a terminal.
 *
 * This is the only test that runs the whole thing the way a user meets it:
 *
 *   real NEXORA server  +  real agent process  +  real browser
 *
 * It starts both, signs up, clicks through the flow, and asserts that WhatsApp
 * issues a pairing code AND that the code appears in the page. The phone number
 * is entered once, in the browser. No command is copied, pasted, or executed.
 *
 * Requires relay/node_modules (run `npm install` in relay/ first).
 *
 *   node scripts/test-agent.mjs [baseUrl]
 *
 * If no server is listening on the base URL it builds nothing — start one:
 *   NEXORA_AGENT_URL=http://127.0.0.1:8788 \
 *   NEXORA_AGENT_SECRET=... npx next start -p 3100
 *
 * and run this with the same secret:
 *   NEXORA_AGENT_SECRET=... node scripts/test-agent.mjs
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const BASE = (process.argv[2] ?? process.env.NEXORA_BASE ?? 'http://127.0.0.1:3100').replace(/\/+$/, '');
const AGENT_PORT = Number(process.env.NEXORA_TEST_AGENT_PORT ?? 8899);
const SECRET = process.env.NEXORA_AGENT_SECRET ?? 'test-agent-secret-' + Date.now();
const PHONE = process.env.NEXORA_TEST_PHONE ?? '919876543210';

const pass = [];
const fail = [];
const ok = (n, d = '') => {
  pass.push(n);
  console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`);
};
const no = (n, d = '') => {
  fail.push([n, d]);
  console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`);
};

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: class {} },
});

// ── The app must already be reachable and pointed at this agent ────────────
const reachable = await fetch(`${BASE}/login`)
  .then((r) => r.ok || r.status === 307 || r.status === 200)
  .catch(() => false);
if (!reachable) {
  console.error(`No server at ${BASE}. Start one with NEXORA_AGENT_URL/NEXORA_AGENT_SECRET set.`);
  process.exit(2);
}

// ── Start the agent exactly as a host would ────────────────────────────────
const agent = spawn('node', ['relay/agent.mjs'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    NEXORA_URL: BASE,
    NEXORA_AGENT_SECRET: SECRET,
    NEXORA_AGENT_PORT: String(AGENT_PORT),
    NEXORA_AGENT_DIR: `/tmp/agent-test-${Date.now()}`,
    NEXORA_POLL_MS: '1500',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let agentLog = '';
agent.stdout.on('data', (d) => (agentLog += d));
agent.stderr.on('data', (d) => (agentLog += d));

await new Promise((r) => setTimeout(r, 2500));
const health = await fetch(`http://127.0.0.1:${AGENT_PORT}/health`)
  .then((r) => r.json())
  .catch(() => null);
health?.ok
  ? ok('agent process is up and answering /health')
  : no('agent did not start', agentLog.slice(0, 300));

const email = `agent-${Date.now()}@example.test`;
const password = 'Test-password-123456';
const { data: created } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
const userId = created.user.id;
await admin.from('profiles').upsert(
  { id: userId, email, display_name: 'Agent Tester', timezone: 'Asia/Kolkata', onboarded_at: new Date().toISOString() },
  { onConflict: 'id' },
);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(e.message));

try {
  console.log('\n[1. The user only ever touches the browser]');
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('form button[type="submit"]').last().click();
  await page.waitForTimeout(4000);
  await page.goto(`${BASE}/integrations`, { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: 'Get started' }).click();
  await page.locator('#phone').fill(PHONE);
  await page.getByRole('button', { name: 'Continue' }).click();
  for (const k of ['accountSuspensionRisk', 'termsOfServiceViolation', 'dataPrivacyResponsibility', 'noOfficialSupport'])
    await page.locator(`input[name="ack"][value="${k}"]`).check();
  await page.locator('#confirm').fill('I understand the risks');

  await page.getByRole('button', { name: 'Create pairing code' }).click();

  const waiting = await page
    .getByText(/Enter this code in WhatsApp/i)
    .waitFor({ timeout: 25000 })
    .then(() => true)
    .catch(() => false);
  waiting ? ok('the waiting step opens right after consent') : no('waiting step never opened');

  console.log('\n[2. The code arrives in the page by itself]');
  let code = null;
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    const m = (await page.locator('body').innerText()).match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
    if (m) {
      code = m[1];
      break;
    }
    await page.waitForTimeout(1500);
  }
  code ? ok('pairing code rendered without a refresh', code) : no('no pairing code appeared');

  agentLog.includes(`pairing code for ${PHONE}`)
    ? ok('the agent is the one that asked WhatsApp for it')
    : no('agent log has no code line', agentLog.slice(-300));

  console.log('\n[3. Nothing was pasted into a terminal]');
  const body = await page.locator('body').innerText();
  /node -e|NEXORA_PAIRING_CODE|raw\.githubusercontent|npm (i|install)|cd nexora/.test(body)
    ? no('a shell command is visible in the flow')
    : ok('no shell command anywhere on the page');

  const { data: row } = await admin
    .from('whatsapp_integrations')
    .select('pairing_code, pairing_code_at, bridge_pairing_phone, bridge_session_state')
    .eq('user_id', userId)
    .maybeSingle();
  row?.pairing_code === code
    ? ok('the code shown is the one stored for this user')
    : no('page code does not match the stored code', JSON.stringify(row));
  row?.bridge_pairing_phone === PHONE ? ok('the number on file is the one typed in the browser') : no('number mismatch');

  console.log('\n[4. Consent is on record, not decorative]');
  const { data: consent } = await admin
    .from('whatsapp_integrations')
    .select('risk_acknowledged_at, risk_acknowledged_version, mode')
    .eq('user_id', userId)
    .maybeSingle();
  Boolean(consent?.risk_acknowledged_at) && consent?.mode === 'personal_bridge'
    ? ok('consent timestamp and bridge mode stored')
    : no('consent not recorded', JSON.stringify(consent));

  jsErrors.length === 0 ? ok('no JS errors during the flow') : no('js errors', jsErrors.join(' | '));
} catch (e) {
  no('crashed', e.message);
} finally {
  await browser.close();
  agent.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
  await admin.from('whatsapp_sessions').delete().eq('user_id', userId);
  await admin.from('whatsapp_outbound').delete().eq('user_id', userId);
  await admin.from('whatsapp_integrations').delete().eq('user_id', userId);
  await admin.auth.admin.deleteUser(userId);
}

console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length) console.log('\nagent log tail:\n' + agentLog.slice(-800));

// The child must be gone before this process exits, otherwise the port stays
// held and the next run's adopt is refused by the previous run's agent.
agent.kill('SIGKILL');
await new Promise((r) => setTimeout(r, 300));
process.exit(fail.length ? 1 : 0);
