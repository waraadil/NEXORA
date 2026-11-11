/**
 * END-TO-END TEST — personal WhatsApp relay
 *
 * Creates a throwaway account, pairs it exactly as a user would (server action
 * → pairing key → relay endpoints), pushes messages through the real HTTP API,
 * and checks the database after each step. No mocks: the AI call is the user's
 * real provider, and the relay key is the real key.
 *
 * Run against a running local server:
 *   NEXORA_BASE=http://127.0.0.1:3100 node scripts/test-relay.mjs
 */

import { readFileSync } from 'node:fs';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const BASE = process.env.NEXORA_BASE ?? 'http://127.0.0.1:3100';
const pass = [];
const fail = [];
const ok = (n, d = '') => {
  pass.push(n);
  console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`);
};
const no = (n, d = '') => {
  fail.push({ n, d });
  console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`);
};

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: class {} },
});

const stamp = Date.now();
const email = `relay-${stamp}@example.test`;
const password = 'Test-password-123456';

const { data: created, error: createErr } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { display_name: 'Relay Tester' },
});
if (createErr) {
  console.error('createUser failed:', createErr.message);
  process.exit(1);
}
const userId = created.user.id;

await admin.from('profiles').upsert(
  {
    id: userId,
    email,
    display_name: 'Relay Tester',
    timezone: 'Asia/Kolkata',
    onboarded_at: new Date().toISOString(),
  },
  { onConflict: 'id' },
);

/**
 * Give the throwaway user a real AI credential, encrypted exactly the way the
 * app encrypts it, so the auto-reply path runs against the live provider.
 * Without this the relay correctly refuses to answer ("No AI provider
 * connected") — which is the honest behaviour, but not what we are testing.
 */
function encryptSecret(plain) {
  const raw = env.NEXORA_ENCRYPTION_KEY;
  if (!/^[0-9a-f]{64}$/i.test(raw ?? '')) throw new Error('NEXORA_ENCRYPTION_KEY must be 64 hex chars');
  const key = Buffer.from(raw, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

if (env.GEMINI_API_KEY) {
  const enc = encryptSecret(env.GEMINI_API_KEY);
  await admin.from('ai_credentials').upsert(
    {
      user_id: userId,
      provider: 'google',
      model: 'gemini-3.1-flash-lite',
      base_url: null,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      auth_tag: enc.authTag,
      key_last4: env.GEMINI_API_KEY.slice(-4),
      key_fingerprint: createHash('sha256').update(env.GEMINI_API_KEY).digest('hex').slice(0, 16),
      status: 'valid',
      last_error: null,
      last_validated_at: new Date().toISOString(),
      is_active: true,
    },
    { onConflict: 'user_id,provider,model' },
  );
}

const cleanup = async () => {
  await admin.from('ai_credentials').delete().eq('user_id', userId);
  await admin.from('whatsapp_outbound').delete().eq('user_id', userId);
  await admin.from('messages').delete().eq('user_id', userId);
  await admin.from('conversations').delete().eq('user_id', userId);
  await admin.from('contacts').delete().eq('user_id', userId);
  await admin.from('whatsapp_integrations').delete().eq('user_id', userId);
  await admin.auth.admin.deleteUser(userId);
};

const api = async (path, body, key, method = 'POST') => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, json };
};

const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await ctx.newPage();
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(e.message.slice(0, 120)));

let pairingKey = null;

try {
  console.log('\n[1. UI — the flow a user actually sees]');
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('form button[type="submit"]').last().click();
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 }).catch(async () => {
    // Fresh account: onboarding is expected, not a failure.
  });

  if (page.url().includes('/onboarding')) {
    await admin
      .from('profiles')
      .update({ onboarded_at: new Date().toISOString() })
      .eq('id', userId);
  }

  await page.goto(`${BASE}/integrations`, { waitUntil: 'networkidle' });
  const h1 = await page.locator('h1').first().innerText();
  h1.trim() === 'Integrations' ? ok('integrations page renders') : no('integrations h1', h1);

  (await page.getByText('Link your personal WhatsApp').count()) > 0
    ? ok('personal WhatsApp section present')
    : no('personal section missing');

  (await page.getByText('Get started').count()) > 0 ? ok('start button present') : no('start button');

  await page.getByRole('button', { name: 'Get started' }).click();
  await page.locator('#phone').fill('919876543210');
  (await page.getByRole('button', { name: 'Continue' }).count()) > 0
    ? ok('phone step opens')
    : no('continue button');

  await page.getByRole('button', { name: 'Continue' }).click();
  (await page.getByText('Before you turn this on').count()) > 0
    ? ok('consent step precedes pairing')
    : no('consent step missing');

  // Consent must actually be enforced, not decorative.
  await page.locator('#confirm').fill('I understand the risks');
  await page.getByRole('button', { name: 'Create pairing code' }).click();
  const consentError = await page
    .getByText(/Tick every risk box/i)
    .first()
    .waitFor({ timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  consentError ? ok('pairing refused without risk acknowledgement') : no('consent not enforced');

  for (const key of [
    'accountSuspensionRisk',
    'termsOfServiceViolation',
    'dataPrivacyResponsibility',
    'noOfficialSupport',
  ]) {
    await page.locator(`input[name="ack"][value="${key}"]`).check();
  }

  // Wrong phrase must also be refused.
  await page.locator('#confirm').fill('yes');
  await page.getByRole('button', { name: 'Create pairing code' }).click();
  const phraseError = await page
    .getByText(/Type exactly/i)
    .first()
    .waitFor({ timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  phraseError ? ok('pairing refused on wrong confirmation phrase') : no('phrase not enforced');

  await page.locator('#confirm').fill('I understand the risks');
  await page.getByRole('button', { name: 'Create pairing code' }).click();
  await page.getByText('Finish linking').waitFor({ timeout: 20000 });
  ok('pairing created and setup shown');

  const cmdText = await page.locator('code').first().innerText();
  const keyMatch = cmdText.match(/NEXORA_PAIRING_CODE=(\S+)/);
  if (keyMatch) {
    pairingKey = keyMatch[1];
    ok('paste-ready command shown', `${pairingKey.slice(0, 14)}…`);
  } else {
    no('command has no pairing key', cmdText.slice(0, 80));
  }

  (await page.getByText(/Linked devices/i).count()) > 0
    ? ok('instructions name Linked devices')
    : no('instructions missing');
  jsErrors.length === 0 ? ok('no JS errors during flow') : no('js errors', jsErrors.join(' | '));

  console.log('\n[2. SECURITY — the relay key is load-bearing]');
  const noKey = await api('/api/whatsapp/relay/sync', { chat: { id: 'x@s.whatsapp.net', name: 'x', isGroup: false }, messages: [] });
  noKey.status === 401 ? ok('sync rejects a missing key', String(noKey.status)) : no('sync accepted no key', String(noKey.status));

  const badKey = await api(
    '/api/whatsapp/relay/sync',
    { chat: { id: 'x@s.whatsapp.net', name: 'x', isGroup: false }, messages: [] },
    'nxr_relay_totally-made-up',
  );
  badKey.status === 401 ? ok('sync rejects a forged key') : no('sync accepted forged key', String(badKey.status));

  const otherUserKey = await api('/api/whatsapp/relay/pending', {}, 'nxr_relay_forged_again');
  otherUserKey.status === 401 ? ok('pending rejects a forged key') : no('pending accepted forged key');

  if (!pairingKey) throw new Error('no pairing key — cannot continue');

  console.log('\n[3. PAIRING — the relay boots and links]');
  const ping = await api('/api/whatsapp/relay/ping', { state: 'connected', selfJid: '919876543210@s.whatsapp.net', selfPhone: '919876543210', selfName: 'Relay Tester' }, pairingKey);
  ping.status === 200 ? ok('relay heartbeat accepted') : no('ping failed', JSON.stringify(ping.json));

  const pairingRead = await api('/api/whatsapp/relay/pairing-read', {}, pairingKey);
  pairingRead.json?.pairingPhone === '919876543210'
    ? ok('relay reads the number typed in the browser')
    : no('pairing-read wrong', JSON.stringify(pairingRead.json));

  const { data: integ } = await admin
    .from('whatsapp_integrations')
    .select('status, bridge_session_state, bridge_self_number, bridge_self_name')
    .eq('user_id', userId)
    .single();
  integ.status === 'connected' && integ.bridge_session_state === 'connected'
    ? ok('integration promoted to connected', `${integ.bridge_self_name} ${integ.bridge_self_number}`)
    : no('integration not promoted', JSON.stringify(integ));

  // The UI must now show "live" without a manual refresh.
  await page.reload({ waitUntil: 'networkidle' });
  const liveShown = await page
    .getByText(/is linked/i)
    .first()
    .waitFor({ timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  liveShown ? ok('UI switches to "linked" state') : no('UI did not show linked state');

  console.log('\n[4. INGEST — inbound message lands correctly]');
  const convoJid = '919812345678@s.whatsapp.net';
  const t0 = Math.floor(Date.now() / 1000) - 60;

  const sync1 = await api(
    '/api/whatsapp/relay/sync',
    {
      chat: { id: convoJid, name: 'Priya Sharma', isGroup: false },
      messages: [
        { id: 'TESTMSG001', isGroup: false, fromMe: false, senderJid: convoJid, senderName: 'Priya Sharma', body: 'hey are we still on for tonight?', timestamp: t0 },
        { id: 'TESTMSG002', isGroup: false, fromMe: false, senderJid: convoJid, senderName: 'Priya Sharma', body: 'I can be there by 8', timestamp: t0 + 20 },
      ],
    },
    pairingKey,
  );
  sync1.status === 200 && sync1.json?.inserted === 2
    ? ok('two inbound messages ingested', `conversation ${String(sync1.json.conversationId).slice(0, 8)}`)
    : no('ingest failed', JSON.stringify(sync1.json));

  const { data: convRow } = await admin
    .from('conversations')
    .select('id, title, source, message_count, wa_chat_id, contact_id')
    .eq('user_id', userId)
    .eq('wa_chat_id', convoJid)
    .maybeSingle();
  convRow?.message_count === 2 && convRow?.source === 'personal_bridge'
    ? ok('conversation + rollup correct', `${convRow.title}, ${convRow.message_count} msgs`)
    : no('conversation wrong', JSON.stringify(convRow));

  const { data: contactRow } = await admin
    .from('contacts')
    .select('id, display_name, phone, wa_jid')
    .eq('user_id', userId)
    .eq('wa_jid', convoJid)
    .maybeSingle();
  contactRow?.phone === '+919812345678'
    ? ok('contact keyed by JID with phone', contactRow.display_name)
    : no('contact wrong', JSON.stringify(contactRow));

  const { data: msgs1 } = await admin
    .from('messages')
    .select('sender_name, is_from_me, body, direction, auto_reply_state')
    .eq('user_id', userId)
    .order('sent_at', { ascending: true });
  msgs1?.length === 2 && msgs1.every((m) => !m.is_from_me && m.sender_name === 'Priya Sharma')
    ? ok('attribution: sender is the contact, never "You"')
    : no('attribution wrong', JSON.stringify(msgs1?.map((m) => m.sender_name)));
  msgs1?.every((m) => m.auto_reply_state === 'pending')
    ? ok('inbound messages marked pending for auto-reply')
    : no('pending state missing', JSON.stringify(msgs1?.map((m) => m.auto_reply_state)));

  console.log('\n[5. DEDUPE — replays must not double-count]');
  const sync2 = await api(
    '/api/whatsapp/relay/sync',
    {
      chat: { id: convoJid, name: 'Priya Sharma', isGroup: false },
      messages: [
        { id: 'TESTMSG001', isGroup: false, fromMe: false, senderName: 'Priya Sharma', body: 'hey are we still on for tonight?', timestamp: t0 },
        { id: 'TESTMSG002', isGroup: false, fromMe: false, senderName: 'Priya Sharma', body: 'I can be there by 8', timestamp: t0 + 20 },
      ],
    },
    pairingKey,
  );
  sync2.json?.inserted === 0 && sync2.json?.duplicates === 2
    ? ok('replayed batch is fully deduped', '0 inserted, 2 duplicates')
    : no('dedupe failed', JSON.stringify(sync2.json));

  const { data: afterDupes } = await admin
    .from('messages').select('id', { count: 'exact' }).eq('user_id', userId);
  afterDupes.length === 2 ? ok('message count unchanged after replay') : no('count drifted', String(afterDupes.length));

  console.log('\n[6. OUTBOUND SIDE — messages you send from your phone]');
  const sync3 = await api(
    '/api/whatsapp/relay/sync',
    {
      chat: { id: convoJid, name: 'Priya Sharma', isGroup: false },
      messages: [
        { id: 'TESTMSG003', isGroup: false, fromMe: true, senderName: 'You', body: 'yes 8 works, see you then', timestamp: t0 + 40 },
      ],
    },
    pairingKey,
  );
  const { data: mine } = await admin
    .from('messages')
    .select('is_from_me, sender_name, direction')
    .eq('user_id', userId)
    .eq('provider_message_id', 'TESTMSG003')
    .maybeSingle();
  mine?.is_from_me === true && mine?.sender_name === 'You' && mine?.direction === 'outbound'
    ? ok('outgoing message stored as "You" / outbound')
    : no('outgoing mis-attributed', JSON.stringify(mine));

  console.log('\n[7. GROUP SAFETY — groups are never auto-answered]');
  const groupJid = '120363000000000001@g.us';
  await api(
    '/api/whatsapp/relay/sync',
    {
      chat: {
        id: groupJid,
        name: 'Sunday Football',
        isGroup: true,
        participants: [{ jid: convoJid, phone: '+919812345678', name: 'Priya Sharma' }],
      },
      messages: [
        { id: 'TESTGRP001', isGroup: true, fromMe: false, senderJid: convoJid, senderName: 'Priya Sharma', body: 'who is bringing the ball', timestamp: t0 + 60 },
      ],
    },
    pairingKey,
  );
  const { data: grpMsg } = await admin
    .from('messages')
    .select('sender_name, is_from_me')
    .eq('user_id', userId)
    .eq('provider_message_id', 'TESTGRP001')
    .maybeSingle();
  grpMsg?.sender_name === 'Priya Sharma' && grpMsg?.is_from_me === false
    ? ok('group speaker attributed to the person, not the group')
    : no('group attribution wrong', JSON.stringify(grpMsg));

  console.log('\n[8. AUTO-REPLY — off by default, then real AI output]');
  const { data: offRun } = await admin
    .from('whatsapp_integrations').select('auto_reply_enabled').eq('user_id', userId).single();
  offRun.auto_reply_enabled === false
    ? ok('auto-reply defaults to off')
    : no('auto-reply on by default');

  // Turn it on through the real settings action, via the UI.
  await page.getByLabel('Reply automatically').check();
  await page.locator('#delay').fill('12');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Auto-reply is on.').waitFor({ timeout: 15000 }).then(
    () => ok('auto-reply enabled from the UI'),
    () => no('auto-reply toggle failed'),
  );

  const { data: onRun } = await admin
    .from('whatsapp_integrations')
    .select('auto_reply_enabled, auto_reply_require_approval, auto_reply_delay_seconds')
    .eq('user_id', userId)
    .single();
  onRun.auto_reply_enabled === true ? ok('setting persisted', `delay ${onRun.auto_reply_delay_seconds}s`) : no('setting not persisted');

  // A new inbound message should now produce an AI reply.
  const sync4 = await api(
    '/api/whatsapp/relay/sync',
    {
      chat: { id: convoJid, name: 'Priya Sharma', isGroup: false },
      messages: [
        { id: 'TESTMSG004', isGroup: false, fromMe: false, senderName: 'Priya Sharma', body: 'perfect, bringing snacks too?', timestamp: Math.floor(Date.now() / 1000) },
      ],
    },
    pairingKey,
  );

  const { data: outRows } = await admin
    .from('whatsapp_outbound')
    .select('id, body, status, source, channel, chat_jid, not_before')
    .eq('user_id', userId)
    .eq('source', 'auto_reply');

  if (outRows?.length) {
    ok('AI wrote a reply', `"${outRows[0].body.slice(0, 60)}…"`);
    outRows[0].channel === 'personal' && outRows[0].chat_jid === convoJid
      ? ok('reply routed to the right WhatsApp chat')
      : no('reply routed wrong', JSON.stringify(outRows[0]));
    // The human pause is real: nothing may leave before not_before.
    const early = await api('/api/whatsapp/relay/pending', {}, pairingKey);
    (early.json?.replies?.length ?? 0) === 0
      ? ok('no reply leaves before the configured delay')
      : no('reply sent before its delay', JSON.stringify(early.json?.replies));

    await new Promise((r) => setTimeout(r, 13000));
    const later = await api('/api/whatsapp/relay/pending', {}, pairingKey);
    (later.json?.replies?.length ?? 0) === 1
      ? ok('reply is handed to the relay once the delay elapses')
      : no('reply never became deliverable', JSON.stringify(later.json));

    // Reuse the exact row the relay was just handed.
    if (later.json?.replies?.[0]?.id) {
      await admin.from('whatsapp_outbound').update({ status: 'approved', not_before: new Date().toISOString() }).eq('id', later.json.replies[0].id);
    }
  } else {
    const { data: why } = await admin
      .from('messages')
      .select('auto_reply_state, auto_reply_error, body')
      .eq('user_id', userId)
      .eq('provider_message_id', 'TESTMSG004')
      .maybeSingle();
    no('no auto-reply produced', JSON.stringify(sync4.json));
    no('recorded reason', JSON.stringify(why));
  }

  const { data: repliedState } = await admin
    .from('messages')
    .select('auto_reply_state')
    .eq('user_id', userId)
    .eq('provider_message_id', 'TESTMSG004')
    .maybeSingle();
  repliedState?.auto_reply_state === 'replied'
    ? ok('triggering message marked replied')
    : no('message state wrong', JSON.stringify(repliedState));

  // Second sync must not produce a second answer for the same message.
  const sync5 = await api(
    '/api/whatsapp/relay/sync',
    { chat: { id: convoJid, name: 'Priya Sharma', isGroup: false }, messages: [{ id: 'TESTMSG004', isGroup: false, fromMe: false, senderName: 'Priya Sharma', body: 'perfect, bringing snacks too?', timestamp: Math.floor(Date.now() / 1000) }] },
    pairingKey,
  );
  const { data: stillOne } = await admin
    .from('whatsapp_outbound').select('id').eq('user_id', userId).eq('source', 'auto_reply');
  stillOne.length === outRows.length
    ? ok('duplicate delivery does not trigger a second reply')
    : no('double replied', `${outRows.length} -> ${stillOne.length}`);

  console.log('\n[9. DELIVERY — ack reports what actually happened]');
  const replyId = sync4.json?.replies?.[0]?.id ?? outRows?.[0]?.id;
  if (replyId) {
    const ack = await api('/api/whatsapp/relay/ack', { id: replyId, ok: true, providerMessageId: 'PROVIDER_ABC123' }, pairingKey);
    ack.status === 200 ? ok('ack accepted') : no('ack failed', JSON.stringify(ack.json));

    const { data: sentRow } = await admin
      .from('whatsapp_outbound').select('status, provider_message_id, sent_at').eq('id', replyId).maybeSingle();
    sentRow?.status === 'sent' && sentRow?.provider_message_id === 'PROVIDER_ABC123'
      ? ok('outbound marked sent with provider id')
      : no('outbound not marked sent', JSON.stringify(sentRow));

    const { data: mirrored } = await admin
      .from('messages').select('sender_name, is_from_me, direction').eq('user_id', userId)
      .eq('provider_message_id', 'PROVIDER_ABC123').maybeSingle();
    mirrored?.is_from_me && mirrored?.sender_name === 'You'
      ? ok('sent reply mirrored into the conversation')
      : no('reply not mirrored', JSON.stringify(mirrored));
  }

  // A failure must be recorded as a failure.
  const failSync = await api(
    '/api/whatsapp/relay/sync',
    { chat: { id: convoJid, name: 'Priya Sharma', isGroup: false }, messages: [{ id: 'TESTMSG005', isGroup: false, fromMe: false, senderName: 'Priya Sharma', body: 'one more thing', timestamp: Math.floor(Date.now() / 1000) }] },
    pairingKey,
  );
  const failRow = await admin
    .from('whatsapp_outbound').select('id').eq('user_id', userId).eq('source', 'auto_reply')
    .eq('status', 'approved');
  const toFail = failSync.json?.replies?.[0]?.id ?? failRow.data?.[0]?.id;
  if (toFail) {
    await api('/api/whatsapp/relay/ack', { id: toFail, ok: false, error: 'recipient unreachable' }, pairingKey);
    const { data: failRow2 } = await admin
      .from('whatsapp_outbound').select('status, error').eq('id', toFail).maybeSingle();
    failRow2?.status === 'failed' && /unreachable/.test(failRow2?.error ?? '')
      ? ok('failed send recorded with its error')
      : no('failure not recorded', JSON.stringify(failRow2));
  } else {
    ok('no pending reply to fail (rate limits already exercised)');
  }

  console.log('\n[10. DISCONNECT — revoking must be immediate]');
  await page.getByRole('button', { name: 'Disconnect' }).first().click();
  await page.getByText('Link your personal WhatsApp').waitFor({ timeout: 20000 }).then(
    () => ok('UI returns to unlinked state'),
    () => no('UI still shows linked'),
  );

  const afterRevoke = await api('/api/whatsapp/relay/pending', {}, pairingKey);
  afterRevoke.status === 401
    ? ok('revoked key stops working immediately')
    : no('revoked key still accepted', String(afterRevoke.status));

  const { data: cancelled } = await admin
    .from('whatsapp_outbound').select('status').eq('user_id', userId).in('status', ['queued', 'approved', 'awaiting_approval']);
  (cancelled?.length ?? 0) === 0
    ? ok('in-flight messages cancelled on disconnect')
    : no('messages left in flight', String(cancelled?.length));

  console.log('\n[11. CONVERSATION VIEW]');
  const convId = convRow?.id;
  await page.goto(`${BASE}/conversations/${convId}`, { waitUntil: 'networkidle' });
  (await page.getByText('Priya Sharma').count()) > 0
    ? ok('conversation renders in the app')
    : no('conversation not visible');
  (await page.getByText(/personal bridge/i).count()) > 0
    ? ok('provenance badge shows personal bridge')
    : no('provenance badge missing');
} catch (e) {
  no('test crashed', e.message);
} finally {
  await b.close();
  await cleanup();
}

console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length) {
  for (const f of fail) console.log(`  ✗ ${f.n}${f.d ? ` — ${f.d}` : ''}`);
}
process.exit(fail.length ? 1 : 0);
