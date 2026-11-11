/**
 * Stores a validated, encrypted AI credential for an existing user.
 *
 * This is the same write path as `saveAiCredential` in the app, so the row is
 * shaped identically — the app cannot tell the difference between a credential
 * added through the UI and one added here. It exists so a deployment can be
 * brought up with a working provider without clicking through onboarding.
 *
 *   node scripts/seed-credential.mjs you@example.com
 *
 * The key is read from GEMINI_API_KEY in .env.local and never printed.
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { createCipheriv, randomBytes, createHash } from 'node:crypto';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter(Boolean).filter((l) => !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/seed-credential.mjs <email>');
  process.exit(1);
}

const apiKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY missing from .env.local');
  process.exit(1);
}

const PROVIDER = 'google';
const MODEL = 'gemini-3.1-flash-lite';

function masterKey() {
  const raw = env.NEXORA_ENCRYPTION_KEY;
  if (!raw) throw new Error('NEXORA_ENCRYPTION_KEY missing');
  return /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, 'hex')
    : createHash('sha256').update(raw).digest();
}

function encryptSecret(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    last4: plaintext.slice(-4),
    fingerprint: createHash('sha256').update(plaintext).digest('hex').slice(0, 32),
  };
}

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: class {} },
});

// Find the user by email.
const { data: list, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
if (listErr) {
  console.error('Could not list users:', listErr.message);
  process.exit(1);
}
const user = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
if (!user) {
  console.error(`No user with email ${email}. Sign up in the app first.`);
  process.exit(1);
}

// Prove the key works before storing it, exactly as the UI does.
const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
);
if (!res.ok) {
  console.error(`Key validation failed: HTTP ${res.status}`);
  process.exit(1);
}

const enc = encryptSecret(apiKey);

// Exactly one active credential.
await admin.from('ai_credentials').update({ is_active: false }).eq('user_id', user.id);

const { error } = await admin.from('ai_credentials').upsert(
  {
    user_id: user.id,
    provider: PROVIDER,
    model: MODEL,
    base_url: null,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    auth_tag: enc.authTag,
    key_last4: enc.last4,
    key_fingerprint: enc.fingerprint,
    status: 'valid',
    last_error: null,
    last_validated_at: new Date().toISOString(),
    is_active: true,
  },
  { onConflict: 'user_id,provider,model' },
);

if (error) {
  console.error('Store failed:', error.message);
  process.exit(1);
}

// Mark the user as onboarded so the middleware lets them into the app.
await admin.from('profiles').update({ onboarded_at: new Date().toISOString() }).eq('id', user.id);

console.log(`Stored ${PROVIDER} / ${MODEL} for ${email} (key ····${enc.last4}), encrypted.`);
console.log(`Verified live against Google before saving. Onboarding marked complete.`);
