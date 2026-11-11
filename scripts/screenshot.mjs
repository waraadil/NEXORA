/**
 * Visual check: renders every key screen in light + dark and saves PNGs,
 * so UI regressions are seen rather than assumed.
 *
 * Run: node scripts/screenshot.mjs
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

const BASE = 'http://localhost:3000';
const OUT = 'screenshots';
fs.mkdirSync(OUT, { recursive: true });

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: class {} },
});

const email = `shot-${Date.now()}@example.test`;
const password = 'Test-password-123456';
const stamp = Date.now();

const { data: created } = await admin.auth.admin.createUser({
  email, password, email_confirm: true, user_metadata: { display_name: 'Aarav Mehta' },
});
const userId = created.user.id;

await admin.from('profiles').upsert(
  { id: userId, email, display_name: 'Aarav Mehta', timezone: 'Asia/Kolkata', onboarded_at: new Date().toISOString() },
  { onConflict: 'id' },
);

const people = [
  { display_name: 'Priya Sharma', phone: '+919876543210', relationship: 'friend', relationship_detail: 'College friend, Pune' },
  { display_name: 'Rahul Verma', phone: '+919812345678', relationship: 'colleague', relationship_detail: 'Design lead at work' },
  { display_name: 'Ananya Iyer', phone: '+919900112233', relationship: 'family', relationship_detail: 'Sister' },
];

const contactIds = [];
for (const p of people) {
  const { data: c } = await admin.from('contacts').insert({ user_id: userId, is_group: false, ...p }).select('id').single();
  contactIds.push(c.id);
}

const convIds = [];
for (let i = 0; i < people.length; i++) {
  const { data: cv } = await admin
    .from('conversations')
    .insert({
      user_id: userId,
      contact_id: contactIds[i],
      title: people[i].display_name,
      source: i === 0 ? 'manual' : 'whatsapp_cloud',
      message_count: 4,
      last_message_at: new Date(Date.now() - i * 3600000).toISOString(),
    })
    .select('id')
    .single();
  convIds.push(cv.id);

  await admin.from('messages').insert([
    { user_id: userId, conversation_id: cv.id, sender_name: people[i].display_name, message_hash: `a-${stamp}-${i}`, body: 'Are we still on for the weekend?', is_from_me: false, direction: 'inbound', sent_at: new Date(Date.now() - 5400000).toISOString() },
    { user_id: userId, conversation_id: cv.id, sender_name: 'Me', message_hash: `b-${stamp}-${i}`, body: 'Yes — booked the tickets this morning 🎟️', is_from_me: true, direction: 'outbound', sent_at: new Date(Date.now() - 4800000).toISOString() },
    { user_id: userId, conversation_id: cv.id, sender_name: people[i].display_name, message_hash: `c-${stamp}-${i}`, body: 'Perfect. Ill reach by 6, traffic permitting.', is_from_me: false, direction: 'inbound', sent_at: new Date(Date.now() - 3000000).toISOString() },
    { user_id: userId, conversation_id: cv.id, sender_name: 'Me', message_hash: `d-${stamp}-${i}`, body: 'No rush, Ill grab us a table 🍜', is_from_me: true, direction: 'outbound', sent_at: new Date(Date.now() - 1800000).toISOString() },
  ]);
}

await admin.from('memories').insert([
  { user_id: userId, contact_id: contactIds[0], conversation_id: convIds[0], kind: 'event', content: 'Concert with Priya on Saturday at 6pm.', normalized: 'concert priya saturday 6pm', confidence: 0.72, provenance: 'inferred' },
  { user_id: userId, contact_id: contactIds[1], conversation_id: convIds[1], kind: 'preference', content: 'Rahul prefers async design reviews over meetings.', normalized: 'rahul prefers async design reviews', confidence: 1, provenance: 'confirmed' },
  { user_id: userId, contact_id: contactIds[2], conversation_id: convIds[2], kind: 'fact', content: 'Ananya moved to Bengaluru in October.', normalized: 'ananya moved bengaluru october', confidence: 0.9, provenance: 'confirmed' },
]);

await admin.from('user_style_profiles').insert({
  user_id: userId, tone: 'casual-warm', average_message_length: 24, emoji_usage: 'occasional',
  formality: 'low', humour: 'dry', sample_message_count: 48, confidence: 0.68, derived_at: new Date().toISOString(),
});

const browser = await chromium.launch();

async function shoot(label, path, theme) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: theme,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.addInitScript((t) => {
    if (t === 'dark') localStorage.setItem('nexora-theme', 'dark');
    else if (t === 'light') localStorage.setItem('nexora-theme', 'light');
    else localStorage.removeItem('nexora-theme');
  }, theme);

  if (label !== 'login') {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('form:has(input[name="email"]) button[type="submit"]');
    await page.waitForTimeout(2500);
  }

  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const file = `${OUT}/${label}-${theme}.png`;
  // Infinite pulse animations never 'settle', so animations must be disabled
  // for the screenshot to be captured deterministically.
  await page.screenshot({ path: file, fullPage: false, animations: 'disabled', timeout: 60000 });
  console.log('saved', file);
  await ctx.close();
}

const screens = [
  ['login', '/login'],
  ['dashboard', '/dashboard'],
  ['conversations', '/conversations'],
  ['conversation', `/conversations/${convIds[0]}`],
  ['contacts', '/contacts'],
  ['assistant', '/assistant'],
  ['memory', '/memory'],
  ['away', '/away'],
  ['integrations', '/integrations'],
  ['settings', '/settings'],
  ['settings-ai', '/settings/ai'],
];

for (const [label, path] of screens) {
  await shoot(label, path, 'light');
}
for (const [label, path] of [['dashboard', '/dashboard'], ['conversations', '/conversations'], ['memory', '/memory'], ['settings', '/settings/ai']]) {
  await shoot(label, path, 'dark');
}

// Mobile
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const mpage = await mctx.newPage();
await mpage.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await mpage.fill('input[name="email"]', email);
await mpage.fill('input[name="password"]', password);
await mpage.click('form:has(input[name="email"]) button[type="submit"]');
await mpage.waitForTimeout(2500);
await mpage.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await mpage.waitForTimeout(700);
await mpage.screenshot({ path: `${OUT}/mobile-dashboard.png`, animations: 'disabled', timeout: 60000 });
console.log('saved', `${OUT}/mobile-dashboard.png`);
await mctx.close();

// Command palette open
const pctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const ppage = await pctx.newPage();
await ppage.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await ppage.fill('input[name="email"]', email);
await ppage.fill('input[name="password"]', password);
await ppage.click('form:has(input[name="email"]) button[type="submit"]');
await ppage.waitForTimeout(2500);
await ppage.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await ppage.keyboard.press('Control+k');
await ppage.waitForTimeout(400);
await ppage.keyboard.type('mem');
await ppage.waitForTimeout(400);
await ppage.screenshot({ path: `${OUT}/palette-light.png`, animations: 'disabled', timeout: 60000 });
console.log('saved', `${OUT}/palette-light.png`);
await pctx.close();

await browser.close();

// Cleanup
for (const t of ['contacts', 'memories', 'user_style_profiles']) {
  await admin.from(t).delete().eq('user_id', userId);
}
await admin.auth.admin.deleteUser(userId);
console.log('done');
