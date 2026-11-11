/**
 * UI interaction tests: command palette, theme persistence, loading states,
 * 404, and accessibility basics. These assert behaviour, not appearance.
 *
 * Run: node scripts/test-ui.mjs
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter(Boolean).filter((l) => !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);

const BASE = process.env.NEXORA_BASE ?? 'http://localhost:3000';
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }, realtime: { transport: class {} },
});

const email = `ui-${Date.now()}@example.test`;
const password = 'Test-password-123456';
const { data: created } = await admin.auth.admin.createUser({
  email, password, email_confirm: true, user_metadata: { display_name: 'UI Tester' },
});
const userId = created.user.id;
await admin.from('profiles').upsert(
  { id: userId, email, display_name: 'UI Tester', timezone: 'Asia/Kolkata', onboarded_at: new Date().toISOString() },
  { onConflict: 'id' },
);

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${d}`); } };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('input[name="email"]', email);
await page.fill('input[name="password"]', password);
await page.click('form:has(input[name="email"]) button[type="submit"]');
await page.waitForTimeout(3500);

console.log('\n1. Command palette');
await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
check('palette closed initially', (await page.locator('[role="dialog"][aria-label="Command palette"]').count()) === 0);

await page.keyboard.press('Control+k');
await page.waitForTimeout(300);
const dialog = page.locator('[role="dialog"][aria-label="Command palette"]');
check('Ctrl+K opens palette', (await dialog.count()) === 1);
check('input focused on open', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Command'));

await page.keyboard.type('memo');
await page.waitForTimeout(300);
const opts = page.locator('#command-results [role="option"]');
const n = await opts.count();
check('fuzzy search filters results', n > 0 && n < 10, `got ${n} options`);
check('memory is the top hit', (await opts.first().innerText()).toLowerCase().includes('memory'));

await page.keyboard.press('Enter');
await page.waitForTimeout(1200);
check('Enter navigates to /memory', page.url().endsWith('/memory'), page.url());
check('palette closed after navigate', (await dialog.count()) === 0);

// Escape closes
await page.keyboard.press('Control+k');
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Escape closes palette', (await dialog.count()) === 0);

// Arrow navigation
await page.keyboard.press('Control+k');
await page.waitForTimeout(250);
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(200);
const selected = await page.locator('[role="option"][aria-selected="true"]').count();
check('exactly one option selected after arrowing', selected === 1, `got ${selected}`);
await page.keyboard.press('Escape');

console.log('\n2. Theme toggle');
await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'));
// NEXORA is dark-first: a visitor with no stored preference gets dark, whatever
// their OS is set to. The toggle below still has to override it both ways.
await page.evaluate(() => localStorage.removeItem('nexora-theme'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(300);
check('defaults to dark with no stored preference', (await isDark()) === true);

await page.locator('button[aria-label="Light theme"]').first().click();
await page.waitForTimeout(300);
check('light choice applied', (await isDark()) === false);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(400);
check('light persists across reload', (await isDark()) === false);
check('stored in localStorage', (await page.evaluate(() => localStorage.getItem('nexora-theme'))) === 'light');

await page.locator('button[aria-label="Dark theme"]').first().click();
await page.waitForTimeout(300);
check('back to dark after toggling', (await isDark()) === true);

console.log('\n3. 404 page');
const res404 = await page.goto(`${BASE}/this-page-does-not-exist`, { waitUntil: 'domcontentloaded' });
const body404 = await page.locator('body').innerText();
check('404 status code', res404?.status() === 404, `got ${res404?.status()}`);
check('404 shows friendly copy', /doesn.t exist|could not be found|404/i.test(body404));
check('404 offers a way back', /dashboard/i.test(body404));

console.log('\n4. Accessibility basics');
await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const checks = await page.evaluate(() => {
  const imgsNoAlt = [...document.querySelectorAll('img')].filter((i) => !i.hasAttribute('alt')).length;
  const btnsNoName = [...document.querySelectorAll('button')].filter(
    (b) => !b.textContent?.trim() && !b.getAttribute('aria-label') && !b.getAttribute('title'),
  ).length;
  const inputsNoLabel = [...document.querySelectorAll('input:not([type="hidden"])')].filter((i) => {
    const id = i.getAttribute('id');
    if (i.getAttribute('aria-label')) return false;
    if (id && document.querySelector(`label[for="${id}"]`)) return false;
    return !i.closest('label');
  }).length;
  const h1s = document.querySelectorAll('h1').length;
  return { imgsNoAlt, btnsNoName, inputsNoLabel, h1s };
});
check('every image has alt text', checks.imgsNoAlt === 0, `${checks.imgsNoAlt} missing`);
check('every button has an accessible name', checks.btnsNoName === 0, `${checks.btnsNoName} missing`);
check('every input has a label', checks.inputsNoLabel === 0, `${checks.inputsNoLabel} unlabelled`);
check('exactly one h1 per page', checks.h1s === 1, `${checks.h1s} found`);

// Keyboard focus visibility
await page.keyboard.press('Tab');
const focusInfo = await page.evaluate(() => {
  const el = document.activeElement;
  if (!el) return { tag: null, ring: '' };
  const s = getComputedStyle(el);
  return { tag: el.tagName, ring: `${s.outlineStyle} ${s.outlineWidth}` };
});
check('first Tab lands on a focusable element', !!focusInfo.tag, JSON.stringify(focusInfo));
check('focus ring is rendered', !/none 0px/.test(focusInfo.ring), focusInfo.ring);

console.log('\n5. Mobile navigation');
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const mpage = await mctx.newPage();
await mpage.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await mpage.fill('input[name="email"]', email);
await mpage.fill('input[name="password"]', password);
await mpage.click('form:has(input[name="email"]) button[type="submit"]');
await mpage.waitForTimeout(3500);
await mpage.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await mpage.waitForTimeout(500);

const bottomNav = mpage.locator('nav[aria-label="Primary"]').last();
check('bottom nav present', (await bottomNav.count()) > 0);
const navItems = await bottomNav.locator('a').count();
check('bottom nav has 5 or fewer items', navItems <= 5, `${navItems} items`);

const noHScroll = await mpage.evaluate(
  () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
);
check('no horizontal scroll on mobile', noHScroll);

// Tap targets
const smallTargets = await mpage.evaluate(() => {
  const bars = [...document.querySelectorAll('nav[aria-label="Primary"]')];
  const bottom = bars[bars.length - 1];
  if (!bottom) return 0;
  return [...bottom.querySelectorAll('a')].filter((a) => {
    const r = a.getBoundingClientRect();
    return r.width < 44 || r.height < 44;
  }).length;
});
check('bottom nav tap targets are 44px+', smallTargets === 0, `${smallTargets} too small`);

await mctx.close();
await browser.close();

for (const t of ['profiles']) await admin.from(t).delete().eq('user_id', userId);
await admin.auth.admin.deleteUser(userId);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
