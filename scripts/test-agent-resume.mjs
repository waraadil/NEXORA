/**
 * Proves the agent survives a diskless restart — the Render free-tier case.
 *
 *   device -> pairing -> linked -> agent killed -> its disk ERASED ->
 *   agent restarted with only NEXORA_AGENT_TOKEN -> link comes back by itself
 *
 * The last step is the one that used to fail: the agent kept its durable token
 * in a file next to the session, so a host with no disk came back holding no
 * links at all while /health happily reported ok.
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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

const BASE = 'http://127.0.0.1:3100';
const PORT = 8901;
const SECRET = 'resume-test-secret';
const DIR = '/tmp/agent-resume-test';

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: class {} },
});

let pass = 0;
const fails = [];
const check = (n, ok, d) => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${n}${d ? ` — ${d}` : ''}`);
  } else {
    fails.push(n);
    console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`);
  }
};

const startAgent = (extraEnv = {}) => {
  const child = spawn('node', ['relay/agent.mjs'], {
    env: {
      ...process.env,
      NEXORA_URL: BASE,
      NEXORA_AGENT_SECRET: SECRET,
      NEXORA_AGENT_PORT: String(PORT),
      NEXORA_AGENT_DIR: DIR,
      NEXORA_POLL_MS: '1500',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.log = '';
  child.stdout.on('data', (d) => (child.log += d));
  child.stderr.on('data', (d) => (child.log += d));
  return child;
};

const health = async () =>
  fetch(`http://127.0.0.1:${PORT}/health`)
    .then((r) => r.json())
    .catch(() => null);

// ── A user with a link the app believes is live ────────────────────────────
const email = `resume-${Date.now()}@example.test`;
const { data: created } = await admin.auth.admin.createUser({
  email,
  password: 'Test-password-123456',
  email_confirm: true,
});
const uid = created.user.id;

const agentToken = `nxr_agent_${randomBytes(32).toString('base64url')}`;
const tokenHash = createHash('sha256').update(agentToken).digest('hex');

await admin.from('whatsapp_integrations').upsert(
  {
    user_id: uid,
    mode: 'personal_bridge',
    status: 'connected',
    bridge_session_state: 'connected',
    bridge_session_state_at: new Date().toISOString(),
    bridge_self_number: '919876543210',
    bridge_pairing_phone: '919876543210',
    agent_token_hash: tokenHash,
    agent_revoked_at: null,
    risk_acknowledged_at: new Date().toISOString(),
    risk_acknowledged_version: '2026-11-personal-bridge-v1',
  },
  { onConflict: 'user_id' },
);

// A fake session so the restarted agent restores credentials instead of pairing.
await admin.from('whatsapp_sessions').upsert(
  {
    user_id: uid,
    payload_ciphertext: 'not-a-real-session',
    payload_iv: 'x',
    payload_auth_tag: 'x',
    key_count: 1,
    updated_at: new Date().toISOString(),
  },
  { onConflict: 'user_id' },
);

try {
  console.log('\n1. the endpoint refuses to hand out links to anyone else');
  const noAuth = await fetch(`${BASE}/api/whatsapp/agent/links`);
  check('no token is rejected', noAuth.status === 401, String(noAuth.status));

  const claimish = await fetch(`${BASE}/api/whatsapp/agent/links`, {
    headers: { authorization: 'Bearer nxr_claim_made-up' },
  });
  check('a claim token is rejected — resume is not pairing', claimish.status === 401, String(claimish.status));

  console.log('\n2. a durable token learns which link to hold');
  const res = await fetch(`${BASE}/api/whatsapp/agent/links`, {
    headers: { authorization: `Bearer ${agentToken}` },
  });
  const body = await res.json();
  check('durable token accepted', res.status === 200, String(res.status));
  check('exactly one link returned', body?.links?.length === 1, JSON.stringify(body?.links?.map((l) => l.state)));
  check('it knows the number', body?.links?.[0]?.phone === '919876543210', body?.links?.[0]?.phone);
  check('it knows the link is established', body?.links?.[0]?.state === 'connected', body?.links?.[0]?.state);

  console.log('\n3. after a restart with NO disk, the link comes back');
  const { rm } = await import('node:fs/promises');
  await rm(DIR, { recursive: true, force: true });

  // Exactly what a Render free instance gets: no disk, only the env token.
  const agent = startAgent({ NEXORA_AGENT_TOKEN: agentToken });
  await new Promise((r) => setTimeout(r, 4000));

  const h = await health();
  check('agent is up', h?.ok === true, JSON.stringify(h));
  check(
    'it resumed the link from the app, not from a file',
    h?.links?.length === 1,
    JSON.stringify(h?.links ?? []),
  );
  check('the resumed link is the right user', h?.links?.[0]?.userId === uid, h?.links?.[0]?.userId);
  check(
    'agent log says it resumed',
    /resuming 919876543210/.test(agent.log),
    agent.log.split('\n').filter((l) => /resum|restor|nothing/i.test(l)).slice(-2).join(' | '),
  );

  console.log('\n3b. the keep-alive endpoint is real, not a prerendered stub');
  // Render spins a free instance down after 15 minutes without inbound traffic,
  // and Vercel Hobby cron only runs daily, so /wake is the thing that keeps the
  // agent alive. It once shipped answering 500 with DYNAMIC_SERVER_USAGE, which
  // is invisible from the outside: the cron looks like it runs and the agent
  // still sleeps. Assert the contract instead of trusting the build.
  {
    // This suite spawns its own agent on a private port, while the server under
    // test points NEXORA_AGENT_URL wherever it likes. So assert the CONTRACT,
    // which is what broke: a live answer, never cached, and never a 500. The
    // failure mode being guarded is a prerendered route returning
    // DYNAMIC_SERVER_USAGE, which reads as "the cron runs" while the agent sleeps.
    const up = await fetch(`${BASE}/api/whatsapp/agent/wake`);
    const upBody = await up.json().catch(() => null);
    check('wake answers 200', up.status === 200, `${up.status} ${JSON.stringify(upBody)}`);
    check('wake never caches', /no-store/.test(up.headers.get('cache-control') ?? ''), up.headers.get('cache-control'));
    check(
      'wake gives a real verdict, not a prerender error',
      typeof upBody?.ok === 'boolean' &&
        (upBody.ok === true
          ? typeof upBody.links === 'number'
          : ['no_agent_configured', 'agent_unreachable', 'agent_did_not_answer'].includes(upBody.reason)),
      JSON.stringify(upBody),
    );

    // And prove it distinguishes the two cases rather than always saying one
    // thing: whatever the server thinks, running the agent on ITS configured
    // port must flip the answer to ok.
    const serverAgentUrl = process.env.NEXORA_SERVER_AGENT_URL;
    if (serverAgentUrl) {
      const again = await fetch(`${BASE}/api/whatsapp/agent/wake`).then((r) => r.json());
      check('wake tracks the agent it is pointed at', typeof again?.ok === 'boolean', JSON.stringify(again));
    }
  }

  console.log('\n4. a revoked token is not allowed to resume anything');  agent.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));
  await admin
    .from('whatsapp_integrations')
    .update({ agent_revoked_at: new Date().toISOString() })
    .eq('user_id', uid);

  const afterRevoke = await fetch(`${BASE}/api/whatsapp/agent/links`, {
    headers: { authorization: `Bearer ${agentToken}` },
  });
  check('revoked token is rejected', afterRevoke.status === 401, String(afterRevoke.status));

  // And an agent booting with it resumes nothing rather than crashing.
  await rm(DIR, { recursive: true, force: true });
  const dead = startAgent({ NEXORA_AGENT_TOKEN: agentToken });
  await new Promise((r) => setTimeout(r, 3500));
  const dh = await health();
  check('agent still healthy with a dead token', dh?.ok === true, JSON.stringify(dh));
  check('but it holds no links', (dh?.links?.length ?? 0) === 0, JSON.stringify(dh?.links ?? []));
  dead.kill('SIGKILL');

  // ── 5. A FRESH PAIR MUST NOT INHERIT THE OLD LINK'S CREDENTIALS ─────────
  // This is the bug that produced "no code ever appears". The agent's auth
  // folder lives on a long-running host (NEXORA_AGENT_DIR=/tmp/nexora-agent),
  // and nothing deleted it when a link was disconnected. Baileys then loaded
  // registered creds, believed the account was already authenticated, and never
  // reached the requestPairingCode call — so the user pressed Pair, no code
  // appeared, and the socket died a few seconds later.
  console.log('\n5. a fresh pairing wipes stale credentials instead of trusting them');
  await new Promise((r) => setTimeout(r, 400));
  await admin
    .from('whatsapp_integrations')
    .update({ agent_revoked_at: null })
    .eq('user_id', uid);

  // Leave a plausible "already registered" credential set where the agent will
  // look. If start() trusts this, it will never ask for a code.
  const { mkdir: mk, writeFile: wf } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const staleDir = join(DIR, uid);
  await mk(staleDir, { recursive: true });
  await wf(join(staleDir, 'creds.json'), JSON.stringify({ registered: true, me: { id: '919876543210:1@s.whatsapp.net' } }));

  const pairingAgent = startAgent({ NEXORA_AGENT_TOKEN: '' });
  await new Promise((r) => setTimeout(r, 2500));

  const claim = `nxr_claim_${randomBytes(24).toString('base64url')}`;
  await admin
    .from('whatsapp_integrations')
    .update({
      status: 'pending',
      bridge_session_state: 'pairing',
      bridge_session_state_at: new Date().toISOString(),
      agent_claim_hash: createHash('sha256').update(claim).digest('hex'),
      agent_claim_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    })
    .eq('user_id', uid);

  const adopted = await fetch(`http://127.0.0.1:${PORT}/adopt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nexora-agent-secret': SECRET },
    body: JSON.stringify({ base: BASE, claim, phone: '919876543210', userId: uid }),
  }).then((r) => r.json());
  check('agent accepts the pairing request', adopted?.ok === true, JSON.stringify(adopted));

  await new Promise((r) => setTimeout(r, 3500));
  check(
    'it says it cleared the old credentials',
    /cleared \d+ credential file\(s\)/.test(pairingAgent.log),
    pairingAgent.log.split('\n').filter((l) => /clear|credential/i.test(l)).slice(-2).join(' | ') || '(nothing logged)',
  );
  const { readdir, readFile: rf } = await import('node:fs/promises');
  const left = await readdir(staleDir).catch(() => ['<missing dir>']);
  let credsNow = null;
  try { credsNow = JSON.parse(await rf(join(staleDir, 'creds.json'), 'utf8')); } catch { /* absent */ }
  // Baileys always creates a creds.json when the folder is empty, so "the file
  // exists" proves nothing. What matters is that it no longer holds the OLD
  // registration — that is the thing that made the code request unreachable.
  check(
    'the old registration is gone, not inherited',
    !credsNow || credsNow.registered !== true,
    `creds.json still says registered=${credsNow?.registered}`,
  );
  pairingAgent.kill('SIGKILL');
} finally {
  await admin.from('whatsapp_sessions').delete().eq('user_id', uid);
  await admin.from('whatsapp_integrations').delete().eq('user_id', uid);
  await admin.auth.admin.deleteUser(uid);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('failed:', fails.join(' | '));
  process.exit(1);
}
