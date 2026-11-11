/** Signs in as the demo user and captures every main screen with real data. */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:3000';
fs.mkdirSync('screenshots/demo', { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('input[name="email"]', 'demo@nexora.app');
await page.fill('input[name="password"]', 'Demo-nexora-2026');
await page.locator('form:has(input[name="email"]) button[type="submit"]').click();
await page.waitForTimeout(6000);
if (!/dashboard|onboarding/.test(page.url())) {
  const err = await page.locator('[role="alert"], .text-red-600, [data-error]').allInnerTexts().catch(() => []);
  console.log('STAYED ON', page.url(), 'errors:', err.filter(Boolean).slice(0,3));
  process.exit(1);
}
console.log('signed in →', page.url());

const pages = [
  ['dashboard', '/dashboard'],
  ['conversations', '/conversations'],
  ['contacts', '/contacts'],
  ['memory', '/memory'],
  ['assistant', '/assistant'],
  ['settings-ai', '/settings/ai'],
];

for (const [name, path] of pages) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `screenshots/demo/${name}.png`, animations: 'disabled' });
  const text = await page.locator('body').innerText();
  console.log(`${name}: ${text.length} chars, first line: ${text.split('\n').filter(Boolean)[0]?.slice(0,70)}`);
}

await browser.close();
