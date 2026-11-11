/**
 * Proves the SHIPPED relay binary works against real WhatsApp.
 *
 * It pairs the real relay process to a real number (this test never learns the
 * number: the browser supplies it, exactly as a user's would), waits for the
 * pairing code WhatsApp issues, and checks that NEXORA recorded the device.
 *
 * A human must type the code into WhatsApp on the phone. Everything up to that
 * point — and the "it never connected" honesty afterwards — is verified here.
 *
 *   NEXORA_BASE=https://nexora-zeta-red.vercel.app \
 *   NEXORA_TEST_PHONE=91XXXXXXXXXX node scripts/test-relay-binary.mjs
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
const PHONE = process.env.NEXORA_TEST_PHONE;
if (!PHONE) { console.error('Set NEXORA_TEST_PHONE (digits, country code first)'); process.exit(1); }

const pass = [], fail = [];
const ok = (n, d = '') => { pass.push(n); console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const no = (n, d = '') => { fail.push([n, d]); console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); };

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }, realtime: { transport: class {} },
});

const email = `relaybin-${Date.now()}@example.test`;
const { data: created } = await admin.auth.admin.createUser({ email, password: 'Test-password-123456', email_confirm: true });
const userId = created.user.id;
await admin.from('profiles').upsert({ id: userId, email, display_name: 'Relay Binary', timezone: 'Asia/Kolkata', onboarded_at: new Date().toISOString() }, { onConflict: 'id' });

const b = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await b.newContext()).newPage();
let key = null;

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill('Test-password-123456');
  await page.locator('form button[type="submit"]').last().click();
  await page.waitForTimeout(4000);
  await page.goto(`${BASE}/integrations`, { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: 'Get started' }).click();
  await page.locator('#phone').fill(PHONE);
  await page.getByRole('button', { name: 'Continue' }).click();
  for (const k of ['accountSuspensionRisk','termsOfServiceViolation','dataPrivacyResponsibility','noOfficialSupport'])
    await page.locator(`input[name="ack"][value="${k}"]`).check();
  await page.locator('#confirm').fill('I understand the risks');
  await page.getByRole('button', { name: 'Create pairing code' }).click();
  await page.getByText('Finish linking').waitFor({ timeout: 25000 });
  ok('pairing window opened through the UI');

  const cmd = await page.locator('code').first().innerText();
  key = cmd.match(/NEXORA_PAIRING_CODE=(\S+)/)?.[1];
  if (!key) throw new Error('no key in command');
  ok('command carries a key', `${key.slice(0, 16)}…`);

  // Run the shipped relay exactly as the user would.
  const relay = spawn('node', ['relay/relay.mjs'], {
    env: { ...process.env, NEXORA_URL: BASE, NEXORA_PAIRING_CODE: key, NEXORA_AUTH_DIR: `/tmp/relaytest-${Date.now()}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  relay.stdout.on('data', (d) => { out += d; process.stdout.write(`      relay │ ${d}`); });
  relay.stderr.on('data', (d) => { out += d; });

  const deadline = Date.now() + 75000;
  let code = null;
  while (Date.now() < deadline) {
    const m = out.match(/pairing code:\s*([A-Z0-9]{4}-?[A-Z0-9]{4})/i);
    if (m) { code = m[1]; break; }
    if (/pairing code request failed/i.test(out)) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (code) ok('WhatsApp issued a live pairing code', code);
  else if (/pairing code request failed/i.test(out)) no('pairing code request failed', out.split('\n').filter(l=>/failed/i.test(l)).join(' ').slice(0,200));
  else no('no pairing code issued in 75s');

  // Without the code being typed on the phone it must NOT claim to be linked.
  await page.reload({ waitUntil: 'networkidle' });
  const stillWaiting = await page.getByText('Finish linking').count();
  stillWaiting > 0 ? ok('UI stays honest: still "finish linking", not "linked"') : no('UI claimed success before pairing');

  const { data: row } = await admin.from('whatsapp_integrations').select('status, bridge_session_state, bridge_pairing_phone').eq('user_id', userId).single();
  row.status === 'pending' && row.bridge_session_state === 'pairing'
    ? ok('DB records pairing in progress, not connected', row.bridge_pairing_phone)
    : no('DB state wrong', JSON.stringify(row));

  relay.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
} catch (e) {
  no('crashed', e.message);
} finally {
  await b.close();
  await admin.from('whatsapp_outbound').delete().eq('user_id', userId);
  await admin.from('whatsapp_integrations').delete().eq('user_id', userId);
  await admin.auth.admin.deleteUser(userId);
}

console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
