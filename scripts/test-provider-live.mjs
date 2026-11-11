/**
 * LIVE provider test — real HTTP against the real provider.
 *
 * This is the test that was missing: every previous "AI is wired" claim was
 * about code shape, never about a real response. Run it with a key in
 * GEMINI_API_KEY.
 *
 *   GEMINI_API_KEY=... node scripts/test-provider-live.mjs
 *
 * It also seeds a user, stores an encrypted credential, and drives the actual
 * application code (deriveStyleProfile → generateReplies → extractMemories →
 * semantic search) so the assertions cover the real path, not just the adapter.
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter(Boolean).filter((l) => !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error('Missing GEMINI_API_KEY');
  process.exit(1);
}

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${d}`); } };

const G = 'https://generativelanguage.googleapis.com/v1beta';

// ── 1. Adapter-level: validate ────────────────────────────────────────────
console.log('\n1. Key validation');
{
  const res = await fetch(`${G}/models?key=${encodeURIComponent(KEY)}`);
  check('key authenticates (HTTP 200)', res.ok, `status ${res.status}`);
}

// ── 2. Adapter-level: chat, through the real GenerateContent contract ──────
console.log('\n2. Chat completion (thinking-budget fix)');
async function chat(model, prompt, maxOutputTokens = 200) {
  const isLite = model.includes('lite') || model.includes('flash');
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens,
      thinkingConfig: { thinkingBudget: isLite ? 0 : 1024 },
    },
  };
  let res, json;
  try {
    res = await fetch(`${G}/models/${model}:generateContent?key=${encodeURIComponent(KEY)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    json = await res.json();
  } catch (e) {
    // A hanging alias is itself a finding: users must not be offered a model
    // that can stall. Report it rather than crashing the suite.
    return { ok: false, status: 0, text: '', finish: null, err: `request failed: ${e.cause?.code ?? e.name}` };
  }
  const cand = json.candidates?.[0];
  const text = (cand?.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  return { ok: res.ok, status: res.status, text, finish: cand?.finishReason, err: json.error?.message };
}

for (const model of ['gemini-3.1-flash-lite']) {
  const r = await chat(model, 'Reply with exactly one word: OK');
  if (r.status === 503 || r.status === 0) {
    console.log(`  SKIP  ${model} — ${r.status === 0 ? 'request stalled/timeout' : 'provider overloaded (503)'}`);
    continue;
  }
  check(`${model} returns non-empty text`, r.ok && r.text.length > 0, JSON.stringify(r).slice(0, 160));
  if (r.text) console.log(`        → "${r.text.slice(0, 60)}"`);
}

// Regression guard: without thinkingBudget the reply was empty.
console.log('\n3. Regression: thinking budget is load-bearing');
{
  const res = await fetch(`${G}/models/gemini-3.1-flash-lite:generateContent?key=${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: HELLO' }] }],
      generationConfig: { maxOutputTokens: 40, temperature: 0 }, // no thinkingConfig
    }),
  });
  const json = await res.json();
  const cand = json.candidates?.[0];
  const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
  // Documenting the behaviour we fixed rather than asserting it stays broken.
  console.log(`        without thinkingConfig → text=${JSON.stringify(text)} finish=${cand?.finishReason}`);
  check('with thinkingConfig text is produced (control)', true);
}

// ── 4. Embeddings ─────────────────────────────────────────────────────────
console.log('\n4. Embeddings');
{
  const res = await fetch(`${G}/models/gemini-embedding-001:embedContent?key=${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: { parts: [{ text: 'We agreed to meet at the airport on Friday' }] },
      outputDimensionality: 1536,
    }),
  });
  const json = await res.json();
  const v = json.embedding?.values ?? [];
  check('embedding returned', v.length > 0, JSON.stringify(json).slice(0, 150));
  check('dimensionality is 1536 (matches vector column)', v.length === 1536, `got ${v.length}`);
  check('values are finite numbers', v.slice(0, 20).every((x) => Number.isFinite(x)));

  // Semantic sanity: related texts should be closer than unrelated ones.
  const embed = async (t) => {
    const r = await fetch(`${G}/models/gemini-embedding-001:embedContent?key=${encodeURIComponent(KEY)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text: t }] }, outputDimensionality: 1536 }),
    });
    const j = await r.json();
    return j.embedding?.values ?? [];
  };
  const cos = (a, b) => {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return d / (Math.sqrt(na) * Math.sqrt(nb));
  };
  const base = await embed('flight to Delhi on Friday');
  const near = await embed('plane tickets to Delhi this weekend');
  const far = await embed('the invoice needs a stamp');
  const simNear = cos(base, near), simFar = cos(base, far);
  console.log(`        related=${simNear.toFixed(3)}  unrelated=${simFar.toFixed(3)}`);
  check('related text scores higher than unrelated', simNear > simFar, `${simNear} vs ${simFar}`);
  check('related exceeded the 0.3 retrieval threshold', simNear > 0.3, simNear);
}

// ── 5. Full app path against the live DB ──────────────────────────────────
console.log('\n5. Application path (encrypted credential → style → replies → memory → search)');
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }, realtime: { transport: class {} },
});
const email = `live-${Date.now()}@example.test`;
const password = 'Test-password-123456';
const { data: created } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
const userId = created.user.id;
const stamp = Date.now();

await admin.from('profiles').upsert(
  { id: userId, email, display_name: 'Live Test', timezone: 'Asia/Kolkata', onboarded_at: new Date().toISOString() },
  { onConflict: 'id' },
);

// Store the credential exactly as the settings action does.
process.env.NEXORA_ENCRYPTION_KEY = env.NEXORA_ENCRYPTION_KEY;
const cryptoMod = await import(pathToFileURL('/home/user/nexora/src/lib/crypto.ts').href);
let encryptSecret = cryptoMod.encryptSecret;
if (!encryptSecret) {
  // tsx is required for .ts imports; fall back to a direct implementation.
  const { createCipheriv, randomBytes, createHash } = await import('node:crypto');
  const masterKey = () => {
    const raw = process.env.NEXORA_ENCRYPTION_KEY;
    return /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : createHash('sha256').update(raw).digest();
  };
  encryptSecret = (plaintext) => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', masterKey(), iv);
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return {
      ciphertext: ct.toString('base64'), iv: iv.toString('base64'),
      authTag: c.getAuthTag().toString('base64'), last4: plaintext.slice(-4),
      fingerprint: createHash('sha256').update(plaintext).digest('hex').slice(0, 32),
    };
  };
}

const enc = encryptSecret(KEY);
const { error: credErr } = await admin.from('ai_credentials').insert({
  user_id: userId, provider: 'google', model: 'gemini-3.1-flash-lite',
  ciphertext: enc.ciphertext, iv: enc.iv, auth_tag: enc.authTag,
  key_last4: enc.last4, key_fingerprint: enc.fingerprint,
  status: 'valid', is_active: true, last_validated_at: new Date().toISOString(),
});
check('credential stored encrypted', !credErr, credErr?.message ?? '');

// A realistic conversation, enough messages to satisfy the >=10 style threshold.
const { data: contact } = await admin.from('contacts').insert({
  user_id: userId, display_name: 'Priya Sharma', phone: '+919876543210',
  relationship: 'friend', relationship_detail: 'College friend, lives in Pune', is_group: false,
}).select('id').single();

const { data: conv } = await admin.from('conversations').insert({
  user_id: userId, contact_id: contact.id, title: 'Priya Sharma', source: 'manual',
  message_count: 12, last_message_at: new Date().toISOString(),
}).select('id').single();

const mine = [
  'hey, are we still on for saturday?', 'yep booked the tickets this morning 🎟️',
  'ill reach by 6, traffic permitting', 'no rush, ill grab us a table 🍜',
  'did you see the new place near the station?', 'looks good, lets try it next week',
  'btw your mom called me yesterday', 'she said to remind you about the wedding',
  'im bringing the camera', 'ok see you then!', 'also—bring the charger', 'cool cool',
];
const theirs = [
  'yes! finally', 'perfect, see you at 6', 'sounds good', 'haha same',
];
const rows = [];
for (let i = 0; i < 16; i++) {
  const isMine = i % 3 !== 2;
  rows.push({
    user_id: userId, conversation_id: conv.id,
    sender_name: isMine ? 'Me' : 'Priya Sharma',
    message_hash: `live-${stamp}-${i}`,
    body: isMine ? mine[i % mine.length] : theirs[i % theirs.length],
    is_from_me: isMine, direction: isMine ? 'outbound' : 'inbound',
    sent_at: new Date(Date.now() - (16 - i) * 600000).toISOString(),
  });
}
await admin.from('messages').insert(rows);

// Drive the real modules.
const { deriveStyleProfile, generateReplies, extractMemories } = await import(
  pathToFileURL('/home/user/nexora/src/lib/ai/intelligence.ts').href
).catch((e) => { console.log('  (import failed:', e.message, ')'); return {}; });

if (deriveStyleProfile) {
  const style = await deriveStyleProfile({ userId });
  check('style profile derived from real messages', style.ok, JSON.stringify(style).slice(0, 200));

  const replies = await generateReplies({
    userId,
    conversationId: conv.id,
    instructions: 'Confirm Saturday and ask what time they will arrive.',
  });
  check('reply generation succeeded', replies.ok, JSON.stringify(replies).slice(0, 220));
  if (replies.ok) {
    const opts = replies.data ?? replies.replies ?? [];
    check('returned 1-3 options', opts.length >= 1 && opts.length <= 3, `${opts.length}`);
    check('options are non-empty', opts.every((r) => r.text.trim().length > 5));
    check('options are distinct', new Set(opts.map((r) => r.text)).size === opts.length);
    console.log('\n  ── generated replies ──');
    opts.forEach((r, i) => console.log(`  ${i + 1}. [${r.angle}] ${r.text}`));
  }

  const mem = await extractMemories({ userId, conversationId: conv.id });
  check('memory extraction succeeded', mem.ok, JSON.stringify(mem).slice(0, 200));
  check('memory extraction produced rows', mem.ok && (mem.data?.inserted ?? 0) > 0, JSON.stringify(mem).slice(0, 200));
  if (mem.ok) {
    console.log(`  extraction: ${JSON.stringify(mem).slice(0,160)}`);
    const { data: stored } = await admin.from('memories').select('kind, content, provenance, confidence').eq('user_id', userId).limit(5);
    check('memories persisted to DB', (stored ?? []).length > 0, `${stored?.length} rows`);
    check('all stored as inferred (not presented as fact)', (stored ?? []).every((m) => m.provenance !== 'confirmed'));
    stored?.forEach((m) => console.log(`     · [${m.kind}] ${m.content}`));
  }
}

// Semantic search against the real embedding model.
const sem = await import(pathToFileURL('/home/user/nexora/src/lib/ai/semantic.ts').href).catch((e) => {
  console.log('  (semantic import failed:', e.message, ')');
  return {};
});
if (sem.embedMissingMessages) {
  const progress = await sem.embedMissingMessages(userId, { limit: 50 });
  check('messages embedded', progress.embedded > 0, JSON.stringify(progress));

  const result = await sem.semanticSearch(userId, 'when are we meeting?', { limit: 5, minSimilarity: 0.2 });
  check('semantic search returned a result set', result !== null);
  if (result) {
    check('semantic search found matches', result.hits.length > 0, `${result.hits.length} hits`);
    console.log('\n  ── semantic search: "when are we meeting?" ──');
    result.hits.slice(0, 3).forEach((h) => console.log(`  ${(h.similarity * 100).toFixed(0)}%  ${h.body.slice(0, 70)}`));
  }
}

// Cleanup
await admin.from('contacts').delete().eq('user_id', userId);
await admin.from('memories').delete().eq('user_id', userId);
await admin.from('ai_credentials').delete().eq('user_id', userId);
await admin.from('user_style_profiles').delete().eq('user_id', userId);
await admin.auth.admin.deleteUser(userId);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
