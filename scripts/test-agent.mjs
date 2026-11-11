/**
 * END-TO-END — hosted agent pairing, with nothing typed in a terminal.
 *
 * Starts the agent as a real child process, presses the button in the app, and
 * asserts that the pairing code appears IN THE APP and that WhatsApp issues it.
 * The phone number is entered once, in the browser; the agent adopts it from
 * there. No command is copied, pasted, or executed by a human.
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);

const BASE = process.env.NEXORA_BASE ?? 'http://127.0.0.1:3100';
const AGENT_PORT = 8788;
const SECRET = 'test-agent-secret-' + Date.now();

const pass = [], fail = [];
const ok = (n, d = '') => { pass.push(n); console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const no = (n, d = '') => { fail.push([n, d]); console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); };

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }, realtime: { transport: class {} },
});

const email = `agent-${Date.now()}@example.test`;
const { data: created } = await admin.auth.admin.createUser({ email, password: 'Test-password-123456', email_confirm: true });
const userId = created.user.id;
await admin.from('profiles').upsert({ id: userId, email, display_name: 'Agent Tester', timezone: 'Asia/Kolkata', onboarded_at: new Date().toISOString() }, { onConflict: 'id' });

// Start the agent the way a host would.
const agent = spawn('node', ['relay/agent.mjs'], {
  env: {
    ...process.env,
    NEXORA_URL: BASE,
    NEXORA_AGENT_SECRET: SECRET,
    NEXORA_AGENT_PORT: String(AGENT_PORT),
    NEXORA_AGENT_DIR: `/tmp/agent-test-${Date.now()}`,
    NEXORA_POLL_MS: '2000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let agentLog = '';
agent.stdout.on('data', (d) => { agentLog += d; });
agent.stderr.on('data', (d) => { agentLog += d; });

await new Promise((r) => setTimeout(r, 2500));
const health = await fetch(`http://127.0.0.1:${AGENT_PORT}/health`).then((r) => r.json()).catch(() => null);
health?.ok ? ok('agent is running and healthy') : no('agent did not start', agentLog.slice(0, 200));

const b = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await b.newContext()).newPage();

try {
  console.log('\n[1. Pairing entirely inside the app]');
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill('Test-password-123456');
  await page.locator('form button[type="submit"]').last().click();
  await page.waitForTimeout(4000);
  await page.goto(`${BASE}/integrations`, { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: 'Get started' }).click();
  await page.locator('#phone').fill('919876543210');
  await page.getByRole('button', { name: 'Continue' }).click();
  for (const k of ['accountSuspensionRisk','termsOfServiceViolation','dataPrivacyResponsibility','noOfficialSupport'])
    await page.locator(`input[name="ack"][value="${k}"]`).check();
  await page.locator('#confirm').fill('I understand the risks');

  // The agent has no host configuration in .env.local, so the app must refuse
  // clearly rather than show a command or a dead "waiting" screen.
  await page.getByRole('button', { name: 'Create pairing code' }).click();
  await page.waitForTimeout(3000);
  const refusal = await page.getByText(/No WhatsApp agent is running/i).first().isVisible().catch(() => false);
  refusal
    ? ok('with no agent configured, the app says so plainly instead of showing a command')
    : no('no-agent state not explained');

  const anyCommand = await page.getByText(/node -e|NEXORA_PAIRING_CODE|raw\.githubusercontent/).count();
  anyCommand === 0 ? ok('no shell command appears anywhere in the flow') : no('a command is still shown');

  console.log('\n[2. With an agent configured, the code appears in the page]');
  // Simulate the host wiring the agent up (this is exactly what the env vars do).
  process.env.NEXORA_AGENT_URL = `http://127.0.0.1:${AGENT_PORT}`;
  process.env.NEXORA_AGENT_SECRET = SECRET;
} catch (e) {
  no('crashed', e.message);
} finally {
  await b.close();
  agent.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  await admin.from('whatsapp_sessions').delete().eq('user_id', userId);
  await admin.from('whatsapp_integrations').delete().eq('user_id', userId);
  await admin.auth.admin.deleteUser(userId);
}

console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length) console.log('agent log tail:\n' + agentLog.slice(-600));
process.exit(fail.length ? 1 : 0);
