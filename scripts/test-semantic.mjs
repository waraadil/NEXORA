/**
 * Verifies the pgvector path end-to-end WITHOUT needing a real embedding provider:
 * we synthesise deterministic vectors and push them through the same
 * `match_messages` RPC the app calls, using the same serialisation.
 *
 * This proves: RPC signature, vector text format, credential pinning,
 * user isolation, similarity ordering and threshold filtering.
 *
 * Run: node scripts/test-semantic.mjs
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

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: class {} },
});

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
};

const DIM = 1536;

const { data: u } = await admin.auth.admin.createUser({
  email: `semantic-${Date.now()}@example.test`,
  password: 'Test-password-123456',
  email_confirm: true,
});
const userId = u.user.id;

// Two contacts, two conversations, three messages with known geometry.
const { data: alice } = await admin
  .from('contacts')
  .insert({ user_id: userId, display_name: 'Alice', is_group: false })
  .select('id')
  .single();
const { data: bob } = await admin
  .from('contacts')
  .insert({ user_id: userId, display_name: 'Bob', is_group: false })
  .select('id')
  .single();

const { data: ca } = await admin
  .from('conversations')
  .insert({ user_id: userId, contact_id: alice.id, title: 'Alice', source: 'manual', message_count: 2 })
  .select('id')
  .single();
const { data: cb } = await admin
  .from('conversations')
  .insert({ user_id: userId, contact_id: bob.id, title: 'Bob', source: 'manual', message_count: 1 })
  .select('id')
  .single();

const mkVec = (axis, weight = 1) =>
  Array.from({ length: DIM }, (_, i) => (i === axis ? weight : 0));

const { data: msgs, error: msgErr } = await admin
  .from('messages')
  .insert([
    // near the query vector (axis 0)
    { user_id: userId, conversation_id: ca.id, sender_name: 'Me', message_hash: 'h-alice-me', body: 'We agreed to meet at the airport on Friday', is_from_me: true, direction: 'outbound', sent_at: new Date().toISOString() },
    // orthogonal-ish — should fall below threshold
    { user_id: userId, conversation_id: ca.id, sender_name: 'Alice', message_hash: 'h-alice-them', body: 'The invoice needs a stamp', is_from_me: false, direction: 'inbound', sent_at: new Date().toISOString() },
    // Bob's message, also near the query
    { user_id: userId, conversation_id: cb.id, sender_name: 'Bob', message_hash: 'h-bob-them', body: 'Friday at the airport works for me', is_from_me: false, direction: 'inbound', sent_at: new Date().toISOString() },
  ])
  .select('id, body');

if (!msgs) {
  console.error('FATAL: message insert failed:', msgErr?.message, msgErr?.details, msgErr?.hint);
  await admin.from('contacts').delete().eq('user_id', userId);
  await admin.auth.admin.deleteUser(userId);
  process.exit(1);
}

const credId = crypto.randomUUID();
// Store the credential row so the FK from message_embeddings resolves.
const { error: credErr } = await admin.from('ai_credentials').insert({
  id: credId,
  user_id: userId,
  provider: 'openai',
  model: 'text-embedding-3-small',
  ciphertext: 'x',
  iv: 'x',
  auth_tag: 'x',
  key_last4: 'test',
  key_fingerprint: 'fp',
  status: 'valid',
  is_active: true,
});
check('seed credential row', !credErr, credErr?.message ?? '');

const vec0 = mkVec(0);
const vec1 = mkVec(1);

const { error: embErr } = await admin.from('message_embeddings').insert(
  msgs.map((m, i) => ({
    user_id: userId,
    message_id: m.id,
    conversation_id: i === 2 ? cb.id : ca.id,
    embedding: JSON.stringify(i === 1 ? vec1 : vec0),
    model: 'text-embedding-3-small',
    credential_id: credId,
  })),
);
check('seed embeddings', !embErr, embErr?.message ?? '');

// The exact call shape src/lib/ai/semantic.ts uses.
const call = (extra = {}) =>
  admin.rpc('match_messages', {
    p_user_id: userId,
    p_credential_id: credId,
    p_query: JSON.stringify(mkVec(0)),
    p_limit: 20,
    p_min_similarity: 0.3,
    ...extra,
  });

console.log('\n1. Vector param round-trip');
const { data: hits, error: rpcErr } = await call();
check('rpc accepts JSON-string vector', !rpcErr, rpcErr?.message ?? JSON.stringify(rpcErr));

console.log('\n2. Similarity + threshold');
check('orthogonal message filtered out (3 messages -> 2 hits)', hits?.length === 2, `got ${hits?.length}`);
check('identical vectors score ~1.0', Number(hits?.[0]?.similarity) > 0.99, `got ${hits?.[0]?.similarity}`);
check('results ordered by similarity desc', (hits?.[0]?.similarity ?? 0) >= (hits?.[1]?.similarity ?? 0));

console.log('\n3. Contact filter');
const { data: onlyAlice } = await call({ p_contact_id: alice.id });
check('contact filter returns only Alice', onlyAlice?.length === 1 && onlyAlice[0].contact_name === 'Alice', JSON.stringify(onlyAlice?.map((r) => r.contact_name)));

console.log('\n4. Credential pinning (vectors from another model are excluded)');
const { data: otherCred } = await call({ p_credential_id: crypto.randomUUID() });
check('unknown credential yields zero hits', (otherCred ?? []).length === 0, `got ${otherCred?.length}`);

console.log('\n5. Cross-user isolation');
const { data: otherUser } = await call({ p_user_id: crypto.randomUUID() });
check('other user id yields zero hits', (otherUser ?? []).length === 0, `got ${otherUser?.length}`);

console.log('\n6. Raising the threshold drops partial matches');
const { data: strict } = await call({ p_min_similarity: 0.99 });
check('0.99 threshold returns only exact', (strict ?? []).length === 2, `got ${strict?.length}`);

// Cleanup (contacts cascade to conversations/messages/embeddings)
await admin.from('contacts').delete().eq('user_id', userId);
await admin.from('ai_credentials').delete().eq('user_id', userId);
await admin.auth.admin.deleteUser(userId);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
