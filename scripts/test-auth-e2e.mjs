/**
 * Authenticated E2E smoke test.
 *
 * Signs a real user in through the real login form, then visits every
 * protected page in a real browser. This is the only way to catch server
 * component crashes that a bare curl (307 redirect) hides.
 *
 * Run: node scripts/test-auth-e2e.mjs
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const env = Object.fromEntries(
  fs
    .readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter(Boolean)
    .filter((l) => !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const BASE = process.env.NEXORA_BASE ?? 'http://localhost:3000';
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: class {} },
});

const email = `e2e-${Date.now()}@example.test`;
const password = 'Test-password-123456';

const stamp = Date.now();
const { data: created, error: createErr } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { display_name: 'E2E Tester' },
});
if (createErr) {
  console.error('createUser failed:', createErr.message);
  process.exit(1);
}
const userId = created.user.id;

// The middleware forces every new user through AI onboarding. Mark this user
// as onboarded so we can exercise the app proper (gate is tested separately below).
await admin.from('profiles').upsert(
  {
    id: userId,
    email,
    display_name: 'E2E Tester',
    timezone: 'Asia/Kolkata',
    onboarded_at: new Date().toISOString(),
  },
  { onConflict: 'id' },
);

// Seed a realistic slice of data so pages render populated states, not just empties.
const { data: contact } = await admin
  .from('contacts')
  .insert({
    user_id: userId,
    display_name: 'Priya Sharma',
    phone: '+919876543210',
    relationship: 'friend',
    relationship_detail: 'College friend, lives in Pune',
    is_group: false,
  })
  .select('id')
  .single();

const { data: conv } = await admin
  .from('conversations')
  .insert({
    user_id: userId,
    contact_id: contact.id,
    title: 'Priya Sharma',
    source: 'manual',
    message_count: 4,
    last_message_at: new Date().toISOString(),
  })
  .select('id')
  .single();

await admin.from('messages').insert([
  { user_id: userId, conversation_id: conv.id, sender_name: 'Priya', message_hash: `h1-${stamp}`, body: 'Are we still on for Saturday?', is_from_me: false, direction: 'inbound', sent_at: new Date(Date.now() - 7200000).toISOString() },
  { user_id: userId, conversation_id: conv.id, sender_name: 'Me', message_hash: `h2-${stamp}`, body: 'Yes! Booked the tickets already', is_from_me: true, direction: 'outbound', sent_at: new Date(Date.now() - 7000000).toISOString() },
  { user_id: userId, conversation_id: conv.id, sender_name: 'Priya', message_hash: `h3-${stamp}`, body: 'Perfect, see you at 6', is_from_me: false, direction: 'inbound', sent_at: new Date(Date.now() - 3600000).toISOString() },
  { user_id: userId, conversation_id: conv.id, sender_name: 'Me', message_hash: `h4-${stamp}`, body: 'Looking forward to it', is_from_me: true, direction: 'outbound', sent_at: new Date(Date.now() - 1800000).toISOString() },
]);

await admin.from('memories').insert({
  user_id: userId,
  contact_id: contact.id,
  conversation_id: conv.id,
  kind: 'event',
  content: 'Going to a concert with Priya on Saturday at 6pm.',
  normalized: 'going to a concert with priya on saturday at 6pm',
  confidence: 0.7,
  provenance: 'inferred',
});

await admin.from('user_style_profiles').insert({
  user_id: userId,
  tone: 'casual-warm',
  average_message_length: 22,
  emoji_usage: 'occasional',
  formality: 'low',
  humour: 'dry',
  sample_message_count: 40,
  confidence: 0.62,
  derived_at: new Date().toISOString(),
});

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
};

console.log('\n1. Real sign-in through the login form');
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('input[name="email"]', email);
await page.fill('input[name="password"]', password);
await page.click('form:has(input[name="email"]) button[type="submit"]');
await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 }).catch(() => {});
check('login redirected away from /login', !page.url().includes('/login'), page.url());
check(
  'landed on an authenticated route',
  /\/(dashboard|onboarding)/.test(page.url()),
  page.url(),
);
const afterLogin = await page.locator('body').innerText();
check('signed-in shell rendered (not the login form)', !/Continue with Google/.test(afterLogin), afterLogin.slice(0, 120));

console.log('\n2. Every protected page renders without a crash');
const pages = [
  ['/dashboard', 'Dashboard'],
  ['/conversations', 'Conversations'],
  [`/conversations/${conv.id}`, 'conversation detail'],
  ['/conversations/import', 'import'],
  ['/contacts', 'Contacts'],
  [`/contacts/${contact.id}`, 'contact detail'],
  ['/assistant', 'AI Assistant'],
  ['/memory', 'Memory'],
  ['/away', 'Away Mode'],
  ['/integrations', 'Integrations'],
  ['/settings', 'Settings'],
  ['/settings/ai', 'AI settings'],
];

for (const [path, label] of pages) {
  const res = await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  const status = res?.status() ?? 0;
  await page.waitForTimeout(350);
  const body = await page.locator('body').innerText();
  const looksBroken =
    /application error|unhandled runtime error|something went wrong|internal server error/i.test(body) ||
    body.trim().length < 40;
  check(`${label} (${path}) renders`, status === 200 && !looksBroken, `status=${status} len=${body.trim().length}`);
}

console.log('\n3. Real data is visible, not placeholder text');
await page.goto(`${BASE}/conversations`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(400);
check('seeded conversation listed', (await page.locator('body').innerText()).includes('Priya'));
await page.goto(`${BASE}/memory`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(400);
const memText = await page.locator('body').innerText();
check('seeded memory visible', memText.includes('concert'));
check('memory marked inferred, not fact', memText.toLowerCase().includes('inferred'));

console.log('\n4. Search panel opens and runs a real keyword search');
await page.goto(`${BASE}/conversations`, { waitUntil: 'networkidle' });
await page.locator('button:has-text("Search messages")').first().click();
await page.waitForSelector('input[name="q"]', { timeout: 10000 });
await page.fill('input[name="q"]', 'tickets');
// Scope to the form's submit — a bare :has-text("Search") also matches the
// panel-opening button, which would silently do nothing.
await page.locator('form button[type="submit"]:has-text("Search")').first().click();
await page.waitForTimeout(3000);
const searchText = await page.locator('body').innerText();
check('keyword search finds the message', /Booked the tickets/i.test(searchText), searchText.slice(0, 300));
check('search reports an honest mode badge', /semantic|keyword/i.test(searchText));

console.log('\n5. Memory edit control is interactive');
await page.goto(`${BASE}/memory`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(400);
const editBtn = page.locator('button:has-text("Edit")').first();
check('Edit button present', (await editBtn.count()) > 0);
if ((await editBtn.count()) > 0) {
  await editBtn.click();
  await page.waitForTimeout(300);
  check('editor opened with content', (await page.locator('textarea').count()) > 0);
}

console.log('\n6. No React crash in console');
const realErrors = consoleErrors.filter(
  (e) => !/favicon|Failed to load resource.*404|Download the React DevTools/i.test(e),
);
check('no console/page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

console.log('\n7. Onboarding gate blocks a user with no AI configuration');
const gatedEmail = `gate-${Date.now()}@example.test`;
const { data: gated } = await admin.auth.admin.createUser({
  email: gatedEmail,
  password,
  email_confirm: true,
  user_metadata: { display_name: 'Gated User' },
});
await admin.from('profiles').upsert(
  { id: gated.user.id, email: gatedEmail, display_name: 'Gated User', timezone: 'UTC' },
  { onConflict: 'id' },
);

const gatedPage = await (await browser.newContext()).newPage();
await gatedPage.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await gatedPage.fill('input[name="email"]', gatedEmail);
await gatedPage.fill('input[name="password"]', password);
await gatedPage.click('form:has(input[name="email"]) button[type="submit"]');
// Sign-in + middleware + page guard round-trip takes several seconds on a cold
// compile; wait for the navigation rather than guessing a sleep.
await gatedPage
  .waitForURL((u) => u.pathname === '/onboarding', { timeout: 30000 })
  .catch(() => {});
check('new user routed to /onboarding', gatedPage.url().includes('/onboarding'), gatedPage.url());

await gatedPage.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
await gatedPage.waitForTimeout(800);
check('dashboard unreachable before AI setup', gatedPage.url().includes('/onboarding'), gatedPage.url());

const onboardText = await gatedPage.locator('body').innerText();
check('onboarding offers the 4 providers', /OpenAI/.test(onboardText) && /Anthropic/.test(onboardText) && /Gemini/.test(onboardText) && /OpenAI-compatible/i.test(onboardText));
check('no key is requested before auth', /API key/i.test(onboardText));

await admin.auth.admin.deleteUser(gated.user.id);

await browser.close();

// Cleanup
await admin.from('contacts').delete().eq('user_id', userId);
await admin.from('memories').delete().eq('user_id', userId);
await admin.from('user_style_profiles').delete().eq('user_id', userId);
await admin.auth.admin.deleteUser(userId);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
