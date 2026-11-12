/**
 * End-to-end test of the hosted agent contract, against a running NEXORA.
 *
 * This drives the same endpoints the real agent uses, in the same order, with
 * a real database row, a real AI reply, and a real round trip. It does not mock
 * the app: every assertion is on state the app itself wrote.
 *
 *   1. create a user + integration exactly as startAgentLink does
 *   2. poll with the claim token, report a pairing code  -> code reaches the DB
 *   3. poll as 'connected'                               -> durable agent token issued
 *   4. poll with a stranger's message                    -> AI reply comes back
 *   5. ack the reply                                     -> outbound row is 'sent'
 *   6. disconnect                                        -> 401 with reason unlinked
 *
 * Run: node scripts/test-agent-loop.mjs [baseUrl]
 */
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, createCipheriv } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const BASE = (process.argv[2] || 'http://127.0.0.1:3100').replace(/\/+$/, '');
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: class {} },
});

const sha256 = (v) => createHash('sha256').update(v).digest('hex');
let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const poll = async (token, body) => {
  const res = await fetch(`${BASE}/api/whatsapp/agent/poll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, json };
};

// The reply half needs a real AI provider, so give this throwaway user the same
// key the deployment uses. Encrypted with the same helper as the app.
function encryptedKey(plaintext) {
  const raw = env.NEXORA_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : createHash('sha256').update(raw).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    auth_tag: cipher.getAuthTag().toString('base64'),
    key_last4: plaintext.slice(-4),
    key_fingerprint: createHash('sha256').update(plaintext).digest('hex').slice(0, 32),
  };
}

const email = `agentloop-${Date.now()}@example.test`;
const password = 'Test-password-123456';

const { data: created, error: createErr } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
if (createErr) throw new Error(`create user: ${createErr.message}`);
const uid = created.user.id;
await admin.from('profiles').upsert(
  {
    id: uid,
    email,
    display_name: 'Agent Loop',
    timezone: 'Asia/Kolkata',
    onboarded_at: new Date().toISOString(),
  },
  { onConflict: 'id' },
);

// Exactly the row startAgentLink writes before calling the agent.
const claim = `nxr_claim_${randomBytes(24).toString('base64url')}`;
const claimHash = sha256(claim);
const { data: integration, error: rowErr } = await admin
  .from('whatsapp_integrations')
  .upsert(
    {
      user_id: uid,
      mode: 'personal_bridge',
      status: 'pending',
      risk_acknowledged_at: new Date().toISOString(),
      risk_acknowledged_version: '2026-11-personal-bridge-v1',
      bridge_pairing_phone: '919876543210',
      bridge_pairing_at: new Date().toISOString(),
      bridge_session_state: 'pairing',
      bridge_session_state_at: new Date().toISOString(),
      agent_claim_hash: claimHash,
      agent_claim_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      agent_revoked_at: null,
      pairing_code: null,
    },
    { onConflict: 'user_id' },
  )
  .select('id')
  .single();
if (rowErr) throw new Error(`create integration: ${rowErr.message}`);

await admin.from('whatsapp_integrations').update({ auto_reply_enabled: true, auto_reply_require_approval: false, auto_reply_delay_seconds: 0 }).eq('user_id', uid);

const enc = env.GEMINI_API_KEY ? encryptedKey(env.GEMINI_API_KEY) : null;
if (enc) {
  await admin.from('ai_credentials').upsert(
    {
      user_id: uid,
      provider: 'google',
      model: 'gemini-3.1-flash-lite',
      base_url: null,
      ...enc,
      status: 'valid',
      last_error: null,
      last_validated_at: new Date().toISOString(),
      is_active: true,
    },
    { onConflict: 'user_id,provider,model' },
  );
} else {
  console.log('! GEMINI_API_KEY not set — the reply step cannot be exercised');
}

try {
  // ── 1. claim poll reports the code the agent got from WhatsApp ───────────
  console.log('\n1. claim poll carries the pairing code');
  const CODE = 'TEST-9K4M';
  const r1 = await poll(claim, { state: 'awaiting_code', pairingCode: CODE });
  check('claim token accepted (200)', r1.status === 200, `got ${r1.status}`);
  check('reply tells the agent which number is pairing', r1.json?.pairingPhone === '919876543210', JSON.stringify(r1.json));
  check('no durable token handed out before the link is up', !r1.json?.agentToken);

  const { data: afterCode } = await admin
    .from('whatsapp_integrations')
    .select('pairing_code, pairing_code_at, bridge_session_state')
    .eq('user_id', uid)
    .maybeSingle();
  check('code written to the database', afterCode?.pairing_code === CODE, JSON.stringify(afterCode));

  // ── 2. the link comes up; token upgrades ────────────────────────────────
  console.log('\n2. linked -> durable agent token issued');
  const r2 = await poll(claim, {
    state: 'connected',
    selfJid: '919876543210@s.whatsapp.net',
    selfPhone: '919876543210',
    selfName: 'Loop Tester',
  });
  check('connected poll accepted', r2.status === 200, `got ${r2.status}`);
  const agentToken = r2.json?.agentToken;
  check('durable token issued', typeof agentToken === 'string' && agentToken.startsWith('nxr_agent_'), String(agentToken));

  const { data: afterLink } = await admin
    .from('whatsapp_integrations')
    .select('status, bridge_session_state, bridge_self_number, pairing_code')
    .eq('user_id', uid)
    .maybeSingle();
  check('row is connected', afterLink?.bridge_session_state === 'connected', JSON.stringify(afterLink));
  check('code cleared once linked', afterLink?.pairing_code === null, JSON.stringify(afterLink));

  if (!agentToken) throw new Error('no agent token — cannot continue');

  // ── 3. an inbound message produces an AI reply ──────────────────────────
  console.log('\n3. inbound WhatsApp message -> AI reply handed back');
  const chatJid = '919812345678@s.whatsapp.net';

  // Auto-reply is OPT-IN PER PERSON, so this chat has to be switched on before
  // the message is looked at. Order matters and is not obvious: the poll that
  // carries a message runs the gate SYNCHRONOUSLY while the request is open, so
  // opting in after the response arrives is already too late — the gate has
  // decided and recorded "not on the auto-reply list". Create the chat first
  // (the way the app does when an inbound message lands), opt it in, then send.
  const { data: contact, error: contactErr } = await admin
    .from('contacts')
    .insert({ user_id: uid, wa_jid: chatJid, display_name: 'Priya', phone: '919812345678' })
    .select('id')
    .single();
  if (contactErr) console.log('     contact insert failed:', contactErr.message);

  const chatRow = {
    user_id: uid,
    contact_id: contact.id,
    wa_chat_id: chatJid,
    title: 'Priya',
    is_group: false,
    auto_reply_mode: 'on',
    last_message_at: new Date().toISOString(),
  };
  const { data: preConv, error: preConvErr } = await admin
    .from('conversations')
    .insert(chatRow)
    .select('id, auto_reply_mode')
    .single();
  if (preConvErr) console.log('     pre-create conversation failed:', preConvErr.message);

  const r3 = await poll(agentToken, {
    state: 'connected',
    messages: [
      {
        chat: { id: chatJid, name: 'Priya', isGroup: false },
        messages: [
          {
            id: `MSG-${Date.now()}`,
            sender: chatJid,
            senderName: 'Priya',
            body: 'Hi! Are we still meeting tomorrow at 5?',
            timestamp: Math.floor(Date.now() / 1000),
          },
        ],
      },
    ],
  });
  check('message poll accepted', r3.status === 200, `got ${r3.status}`);

  // A message is deliberately NOT answered the moment it arrives: the chat has
  // to be quiet for REPLY_SETTLE_MS (6s, counted from when NEXORA saw the
  // message) so a burst of lines produces one reply, not one per line. Poll the
  // way the real agent does — every 3s — until a reply comes back, and assert it
  // did not arrive sooner than the settle window allows.
  const pollStart = Date.now();
  let replies = [];
  let waited = 0;

  // Poll exactly like the agent does — every 3s — and record how long it takes
  // before a reply is handed back.
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const again = await poll(agentToken, { state: 'connected' });
    replies = again.json?.replies ?? [];
    waited = Date.now() - pollStart;
    if (replies.length) break;
  }

  check(
    'no reply inside the settle window',
    waited >= 6000,
    `a reply came back after only ${waited}ms — inside the 6000ms settle window`,
  );
  check('a settled, opted-in chat is eventually answered', replies.length > 0, JSON.stringify(replies).slice(0, 200));
  check(
    'it waited out the settle window before answering',
    waited >= 6000,
    `answered after ${waited}ms, expected the reply to be held >= 6000ms`,
  );
  const reply = replies[0];
  check('reply is addressed to the contact', reply?.chatId === chatJid, JSON.stringify(reply ?? {}).slice(0, 200));
  check('reply has body text', typeof reply?.body === 'string' && reply.body.length > 0, JSON.stringify(reply ?? {}).slice(0, 200));
  if (reply?.body) console.log(`     reply: "${reply.body.slice(0, 120)}"`);

  // ── 4. the message landed in the conversation history ───────────────────
  const { data: conv } = await admin
    .from('conversations')
    .select('id, messages(body, direction)')
    .eq('user_id', uid)
    .limit(5);
  const allBodies = (conv ?? []).flatMap((c) => (c.messages ?? []).map((m) => m.body));
  check('inbound text stored in a conversation', allBodies.some((b) => b?.includes('meeting tomorrow at 5')), JSON.stringify(allBodies).slice(0, 200));

  // ── 5. ack marks the outbound row sent ──────────────────────────────────
  console.log('\n4. ack marks the reply delivered');
  const r4 = await poll(agentToken, {
    state: 'connected',
    acks: [{ id: reply?.id, ok: true, providerMessageId: 'WA-MSG-123' }],
  });
  check('ack poll accepted', r4.status === 200, `got ${r4.status}`);
  const { data: sent } = await admin
    .from('whatsapp_outbound')
    .select('id, status, provider_message_id')
    .eq('id', reply?.id ?? '')
    .maybeSingle();
  check('outbound row is sent', sent?.status === 'sent', JSON.stringify(sent));

  // ── 6. disconnect is a distinguishable, terminal 401 ────────────────────
  console.log('\n5. disconnect tells the agent why');
  await admin
    .from('whatsapp_integrations')
    .update({ agent_revoked_at: new Date().toISOString(), agent_claim_hash: null })
    .eq('user_id', uid);
  const r5 = await poll(agentToken, { state: 'connected' });
  check('revoked token is rejected', r5.status === 401, `got ${r5.status}`);
  check('rejection says unlinked, not unauthorised', r5.json?.reason === 'unlinked', JSON.stringify(r5.json));

  const r6 = await poll('nxr_agent_totally-made-up', { state: 'connected' });
  check('unknown token is rejected', r6.status === 401, `got ${r6.status}`);
  check('unknown token says unauthorised', r6.json?.reason === 'unauthorised', JSON.stringify(r6.json));

  // ── 7. RECONNECT — the case that broke in production ────────────────────
  // After a disconnect the row still carries agent_revoked_at. Pressing Pair
  // again mints a fresh claim; once the link comes up that claim is upgraded to
  // a NEW durable token. If the old revocation timestamp survives the upgrade,
  // the brand-new token is born already-revoked: the very next poll answers 401
  // `unlinked` and the agent tears down a link that had just started working.
  // That is precisely how a pairing that showed no code ended with zero polls.
  console.log('\n6. reconnecting after a disconnect yields a WORKING token');
  const claim2 = `nxr_claim_${randomBytes(24).toString('base64url')}`;
  await admin
    .from('whatsapp_integrations')
    .update({
      status: 'pending',
      bridge_session_state: 'pairing',
      bridge_session_state_at: new Date().toISOString(),
      bridge_pairing_phone: '919876543210',
      agent_claim_hash: sha256(claim2),
      agent_claim_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      pairing_code: null,
      // The revocation from step 5 is deliberately left set: that is the exact
      // state a real disconnect leaves behind, and a fresh pair must survive it.
    })
    .eq('user_id', uid);

  const r7 = await poll(claim2, { state: 'awaiting_code', pairingCode: 'PAIR-2X7Q' });
  check('fresh claim accepted while the row is still revoked', r7.status === 200, `got ${r7.status} ${JSON.stringify(r7.json)}`);

  const r8 = await poll(claim2, {
    state: 'connected',
    selfJid: '919876543210@s.whatsapp.net',
    selfPhone: '919876543210',
    selfName: 'Loop Tester',
  });
  const token2 = r8.json?.agentToken;
  check('second pairing issues a durable token', typeof token2 === 'string', String(token2));

  const { data: afterReconnect } = await admin
    .from('whatsapp_integrations')
    .select('agent_revoked_at, agent_claim_hash')
    .eq('user_id', uid)
    .maybeSingle();
  check('the revocation is cleared by the upgrade', afterReconnect?.agent_revoked_at === null, JSON.stringify(afterReconnect));
  check('the one-use claim is consumed', afterReconnect?.agent_claim_hash === null, JSON.stringify(afterReconnect));

  if (token2) {
    const r9 = await poll(token2, { state: 'connected' });
    check('the new token actually authorises a poll', r9.status === 200, `got ${r9.status} ${JSON.stringify(r9.json)}`);
  }
} finally {
  await admin.from('ai_credentials').delete().eq('user_id', uid);
  await admin.from('whatsapp_outbound').delete().eq('user_id', uid);
  await admin.from('conversations').delete().eq('user_id', uid);
  await admin.from('whatsapp_integrations').delete().eq('user_id', uid);
  await admin.auth.admin.deleteUser(uid);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('failed:', fails.join(' | '));
  process.exit(1);
}
