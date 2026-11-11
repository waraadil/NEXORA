/**
 * Proves a real end-user JWT cannot read secret columns from PostgREST,
 * while still being able to read the safe metadata columns it needs.
 *
 * Run: node scripts/test-column-lockdown.mjs
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

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

const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

const admin = createClient(URL, SERVICE, { auth: { persistSession: false }, realtime: { transport: class {} } });

const email = `lockdown-${Date.now()}@example.test`;
const password = 'Test-password-123456';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

const { data: created, error: createErr } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
if (createErr) {
  console.error('could not create test user:', createErr.message);
  process.exit(1);
}
const userId = created.user.id;

// Seed a credential row as the service role (as the server action would).
await admin.from('ai_credentials').insert({
  user_id: userId,
  provider: 'openai',
  model: 'gpt-4o-mini',
  ciphertext: 'FAKE_CIPHERTEXT_BLOB',
  iv: 'FAKE_IV',
  auth_tag: 'FAKE_TAG',
  key_last4: 'abcd',
  key_fingerprint: 'deadbeef',
  status: 'valid',
  is_active: true,
});

// Sign in as that real user — this is the same JWT a browser would hold.
const userClient = createClient(URL, ANON, { auth: { persistSession: false }, realtime: { transport: class {} } });
const { error: signInErr } = await userClient.auth.signInWithPassword({ email, password });
if (signInErr) {
  console.error('sign-in failed:', signInErr.message);
  process.exit(1);
}

console.log('\n1. Authenticated user reads secret columns');
for (const col of ['ciphertext', 'iv', 'auth_tag']) {
  const { data, error } = await userClient.from('ai_credentials').select(col).eq('user_id', userId);
  check(`select ${col} is denied`, !!error, `got data: ${JSON.stringify(data)}`);
}

console.log('\n2. Authenticated user reads safe metadata');
const { data: safe, error: safeErr } = await userClient
  .from('ai_credentials')
  .select('id, provider, model, key_last4, status')
  .eq('user_id', userId);
check('select safe columns works', !safeErr && safe?.length === 1, safeErr?.message ?? '');
check('safe row has no ciphertext field', !('ciphertext' in (safe?.[0] ?? {})));

console.log('\n3. Authenticated user cannot forge/overwrite their own secret');
const { error: updErr } = await userClient
  .from('ai_credentials')
  .update({ ciphertext: 'ATTACKER_VALUE' })
  .eq('user_id', userId);
check('update ciphertext is denied', !!updErr, updErr ? '' : 'update unexpectedly succeeded');

console.log('\n4. Cross-user isolation still holds');
const other = await admin.auth.admin.createUser({
  email: `lockdown-other-${Date.now()}@example.test`,
  password,
  email_confirm: true,
});
const otherClient = createClient(URL, ANON, { auth: { persistSession: false }, realtime: { transport: class {} } });
await otherClient.auth.signInWithPassword({
  email: other.data.user.email,
  password,
});
const { data: leaked } = await otherClient.from('ai_credentials').select('id').eq('user_id', userId);
check('second user sees zero rows', (leaked ?? []).length === 0, JSON.stringify(leaked));

console.log('\n5. Service role can still read ciphertext (server needs it)');
const { data: serverRead, error: serverErr } = await admin
  .from('ai_credentials')
  .select('ciphertext')
  .eq('user_id', userId);
check('service role reads ciphertext', !serverErr && serverRead?.[0]?.ciphertext === 'FAKE_CIPHERTEXT_BLOB', serverErr?.message ?? '');

// Cleanup
for (const t of ['ai_credentials', 'profiles']) {
  await admin.from(t).delete().eq('user_id', userId);
}
await admin.auth.admin.deleteUser(userId);
await admin.auth.admin.deleteUser(other.data.user.id);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
