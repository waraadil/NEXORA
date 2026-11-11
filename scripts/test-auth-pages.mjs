/**
 * Verifies the auth pages never render a dead OAuth button.
 *
 * Run: node scripts/test-auth-pages.mjs
 */
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.NEXORA_BASE ?? 'http://localhost:3000';

// The correct behaviour depends on whether Google is enabled on the Supabase
// project, so read that rather than hardcoding an assumption. A previous
// version of this test asserted "no Google button", which started failing the
// moment Google was switched on even though the UI was doing the right thing.
const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter(Boolean).filter((l) => !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);
const settings = await (
  await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`, {
    headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
  })
).json();
const googleEnabled = settings?.external?.google === true;
console.log(`Supabase reports google OAuth: ${googleEnabled ? 'ENABLED' : 'DISABLED'}`);
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${d}`); } };

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();

for (const path of ['/login', '/signup']) {
  console.log(`\n${path}`);
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200); // let the provider probe resolve

  const body = await page.locator('body').innerText();

  // Either the button is offered, or its absence is explained. Never a button
  // that looks clickable and does nothing, and never silence.
  const googleBtn = page.locator('button:has-text("Continue with Google")');
  const count = await googleBtn.count();

  if (googleEnabled) {
    check('Google button is offered when the provider is enabled', count === 1, `${count} found`);
    check('Google button is enabled (not a dead control)', (await googleBtn.first().isEnabled()));
    check('no contradictory "not enabled" notice', !/google[^.]{0,40}not enabled/i.test(body));
  } else {
    check('no dead Google button', count === 0);
    check('explains why, rather than hiding silently', /not enabled/i.test(body));
  }

  // Email auth must still be fully usable.
  check('email field present', (await page.locator('input[name="email"]').count()) === 1);
  check('password field present', (await page.locator('input[name="password"]').count()) === 1);
  check('submit button present', (await page.locator('form:has(input[name="email"]) button[type="submit"]').count()) === 1);

  // No layout jump / placeholder remnants
  check('no spinner left behind', (await page.locator('[aria-busy="true"]').count()) === 0);
}

console.log('\n/auth/callback guards');
const res = await page.goto(`${BASE}/auth/callback`, { waitUntil: 'domcontentloaded' });
check('missing code redirects to login with an error', page.url().includes('/login'), page.url());
check('error is explained', /error=/i.test(page.url()));

// Open-redirect protection
const evil = await page.goto(`${BASE}/auth/callback?code=fake&next=https://evil.example.com`, {
  waitUntil: 'domcontentloaded',
});
check('off-site next is not honoured', !page.url().includes('evil.example.com'), page.url());

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
