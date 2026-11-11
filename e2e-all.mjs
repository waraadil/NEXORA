import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:3100';
const pass = [], fail = [];
const ok = (n, d='') => { pass.push(n); console.log(`  PASS  ${n}${d ? ' — ' + d : ''}`); };
const no = (n, d='') => { fail.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); };
const J = s => JSON.stringify(s).slice(0, 60);

const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await ctx.newPage();
const jsErr = [];
page.on('pageerror', e => jsErr.push(e.message.slice(0, 90)));

async function waitH1() {
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: 30000 });
  return (await page.locator('h1').first().innerText()).trim();
}

console.log('\n[1. PUBLIC + LANDING]');
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
(await page.getByText('Your conversations have a voice').count()) ? ok('hero renders') : no('hero');
(await page.getByText('Deploy Now').count()) === 0 ? ok('starter gone') : no('starter still there');
const featCount = await page.locator('section').nth(1).locator('h2').count();
featCount >= 6 ? ok(`feature grid (${featCount} cards)`) : no(`feature grid`, String(featCount));
await page.getByRole('link', { name: 'Get started' }).first().click();
await page.waitForURL('**/signup'); ok('CTA -> /signup');

await page.goto(BASE + '/forgot-password', { waitUntil: 'networkidle' });
(await page.getByText('Password resets are not enabled yet').count()) ? ok('forgot-password honest') : no('forgot-password');
await page.goto(BASE + '/nope-xyz', { waitUntil: 'networkidle' });
(await page.getByText("That page doesn't exist").count()) ? ok('404 page') : no('404 page');

console.log('\n[2. AUTH]');
await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
await page.locator('input[type="email"]').fill('demo@nexora.app');
await page.locator('input[type="password"]').fill('nope-nope-nope');
await page.locator('form button[type="submit"]').last().click();
await page.getByText(/invalid|credentials|incorrect/i).first().waitFor({ timeout: 15000 }).then(()=>ok('bad password rejected')).catch(()=>no('bad password'));
await page.locator('input[type="email"]').fill('demo@nexora.app');
await page.locator('input[type="password"]').fill('Demo-nexora-2026');
await page.locator('form button[type="submit"]').last().click();
await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 45000 });
ok('signed in');

console.log('\n[3. DASHBOARD]');
await page.goto(BASE + '/dashboard', { waitUntil: 'networkidle' });
await page.getByText('Your conversation intelligence at a glance.').waitFor({ timeout: 20000 });
const dash = await page.locator('body').innerText();
['63','14','Priya Sharma','Ananya Iyer'].every(t => dash.includes(t)) ? ok('stats + recent rows real data') : no('dashboard data');
(await page.getByText('Reply style learned').count()) ? ok('setup checklist resolves against real state') : no('setup checklist');

console.log('\n[4. SIDEBAR NAV — every item]');
const NAV = [['Conversations','/conversations'],['Contacts','/contacts'],['AI Assistant','/assistant'],
             ['Memory','/memory'],['Away Mode','/away'],['Integrations','/integrations'],['Settings','/settings']];
for (const [item, expect] of NAV) {
  await page.goto(BASE + '/dashboard', { waitUntil: 'networkidle' });
  await page.getByRole('link', { name: item, exact: true }).first().click();
  await page.waitForURL('**' + expect + '**', { timeout: 20000 }).then(()=>ok(`nav ${item} -> ${expect}`)).catch(()=>no(`nav ${item}`, page.url()));
}

console.log('\n[5. CONVERSATIONS]');
await page.goto(BASE + '/conversations', { waitUntil: 'networkidle' });
const convRows = await page.getByRole('link', { name: /messages/ }).count();
convRows > 0 ? ok(`conversation list (${convRows} rows)`) : no('conversation rows');
await page.getByRole('link', { name: /Priya/i }).first().click();
await page.waitForURL(/\/conversations\/[0-9a-f-]{8}/, { timeout: 20000 });
const chatText = await page.locator('body').innerText();
chatText.length > 500 ? ok('conversation detail renders transcript', `${chatText.length} chars`) : no('conversation detail');
(await page.getByRole('textbox').count()) > 0 ? ok('conversation detail has search box') : no('conversation search box');

console.log('\n[6. CONTACTS]');
await page.goto(BASE + '/contacts', { waitUntil: 'networkidle' });
const cRows = await page.getByRole('link', { name: /Priya|Rahul|Ananya|Dev/ }).count();
cRows > 0 ? ok(`contacts list (${cRows} rows)`) : no('contacts rows');
await page.getByRole('link', { name: /Dev Kapoor/ }).first().click();
await page.waitForURL(/\/contacts\/[0-9a-f-]{8}/, { timeout: 20000 });
await page.locator('h1').first().waitFor();
ok('contact detail loads', J((await page.locator('h1').first().innerText()).trim()));

console.log('\n[7. MEMORY — search, edit, confirm]');
await page.goto(BASE + '/memory', { waitUntil: 'networkidle' });
await page.getByText('Ananya Iyer is the mother').first().waitFor({ timeout: 20000 });
ok('memories render with provenance');
const search = page.getByPlaceholder('Search memories…');
await search.fill('Jaipur');
await page.waitForTimeout(1500);
const filtered = await page.locator('body').innerText();
filtered.includes('Jaipur') && !filtered.includes('mother of the user') ? ok('memory search filters') : no('memory search filter');
await search.fill('');
await page.waitForTimeout(1000);

console.log('\n[8. ASSISTANT — real model call]');
await page.goto(BASE + '/assistant', { waitUntil: 'networkidle' });
await page.getByText(/key ending/).first().waitFor({ timeout: 20000 });
ok('provider + key resolved', J((await page.getByText(/goog|openai|anthropic/).first().innerText()).trim()));
const intent = page.locator('textarea').first();
await intent.fill('Say hello in one short sentence.');
const t0 = Date.now();
await page.locator('form').filter({ has: intent }).locator('button[type="submit"]').first().click();
let drafts = 0;
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(1000);
  drafts = await page.getByText('draft', { exact: true }).count();
  if (drafts > 0) break;
}
drafts > 0 ? ok(`live model produced ${drafts} drafts`, `${((Date.now()-t0)/1000).toFixed(0)}s`) : no('live model drafts');

console.log('\n[9. SETTINGS + INTEGRATIONS]');
await page.goto(BASE + '/settings/ai', { waitUntil: 'networkidle' });
const aiTxt = await page.locator('body').innerText();
/60AQ/.test(aiTxt) ? ok('settings/ai shows stored key tail') : no('settings/ai key');
await page.goto(BASE + '/integrations', { waitUntil: 'networkidle' });
const intTxt = await page.locator('body').innerText();
intTxt.includes('nexora-zeta-red.vercel.app') ? ok('integrations uses production APP_URL') : no('integrations app url', intTxt.match(/https?:\/\/[^\s]+/)?.[0]);

console.log('\n[10. CHROME — palette, theme]');
await page.goto(BASE + '/dashboard', { waitUntil: 'networkidle' });
await page.keyboard.press('Meta+k').catch(()=>{});
await page.waitForTimeout(1200);
const pOpen = await page.getByRole('dialog').count();
if (!pOpen) { await page.keyboard.press('Control+k'); await page.waitForTimeout(1200); }
(await page.getByRole('dialog').count()) > 0 ? ok('command palette opens') : no('command palette');
if (await page.getByRole('dialog').count()) {
  await page.keyboard.type('memo');
  await page.waitForTimeout(900);
  (await page.getByRole('option').count()) > 0 ? ok('palette filters results') : no('palette filtering');
  await page.keyboard.press('Escape');
}
const before = await page.evaluate(() => document.documentElement.classList.contains('dark'));
await page.locator('[aria-label*="theme" i], [title*="theme" i]').first().click({ timeout: 8000 }).catch(()=>{});
await page.waitForTimeout(900);
const afterDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
before !== afterDark ? ok('theme toggle switches mode') : no('theme toggle');

await b.close();
console.log(`\n=== ${pass.length} PASSED / ${fail.length} FAILED ===`);
if (fail.length) console.log('FAILED: ' + fail.join(' | '));
if (jsErr.length) console.log('JS ERRORS: ' + [...new Set(jsErr)].slice(0,6).join(' | '));
