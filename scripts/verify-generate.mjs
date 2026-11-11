/** Drives the actual Generate button in a browser and captures the result. */
import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('input[name="email"]', 'demo@nexora.app');
await page.fill('input[name="password"]', 'Demo-nexora-2026');
await page.locator('form:has(input[name="email"]) button[type="submit"]').click();
await page.waitForTimeout(6000);
console.log('signed in →', page.url());

await page.goto(`${BASE}/assistant`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(1500);

// Pick Priya (has the richest thread) and ask for a specific intent.
// Target the conversation select by id — the page has several selects
// (count, memory-extraction conversation) and `selectOption` matches by value
// across all of them, so picking value 3 on the wrong one silently did nothing.
const convSel = page.locator('select#conversationId');
const opts = await convSel.locator('option').allInnerTexts();
const priyaIdx = opts.findIndex((o) => /Priya/i.test(o));
const priyaValue = await convSel.locator('option').nth(priyaIdx).getAttribute('value');
await convSel.selectOption(priyaValue);
console.log('selected:', await convSel.locator('option:checked').innerText());
await page.fill('textarea', 'Confirm Saturday and ask if she is still bringing him.');
await page.locator('button:has-text("Generate")').click();

console.log('waiting for model...');
const start = Date.now();
// Wait for the drafts themselves, not for the absence of "Generating…" —
// the counter had not rendered yet, so "not generating" was true immediately
// and the screenshot was taken before any reply existed.
await page.waitForSelector('text=/^draft$/i', { timeout: 180000 });
await page.waitForTimeout(1200);
console.log(`elapsed ${Math.round((Date.now()-start)/1000)}s`);

await page.screenshot({ path: 'screenshots/demo/generated-replies.png', animations: 'disabled', fullPage: true });
const body = await page.locator('body').innerText();
const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
const idx = lines.findIndex(l => /draft|option|angle|copy/i.test(l));
console.log('--- rendered text after Generate ---');
console.log(lines.slice(Math.max(0, idx - 2), idx + 30).join('\n'));
await browser.close();
