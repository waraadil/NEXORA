#!/usr/bin/env node
/**
 * NEXORA — agent keep-alive pinger.
 *
 * Render's free tier spins a web service down after ~15 minutes without an
 * inbound request, which drops the WhatsApp socket. This process pings the
 * agent's /health every NEXORA_PING_MINUTES (default 10) so it never idles long
 * enough to sleep.
 *
 * You probably do not need this file. relay/agent.mjs now pings its own public
 * URL every 10 minutes whenever it runs on Render (which injects
 * RENDER_EXTERNAL_URL), so the deployed agent keeps itself awake with nothing
 * external to run, pay for, or maintain.
 *
 * Keep this around for the cases where a SECOND, independent clock is wanted —
 * for instance if Render's self-request ever stops counting as traffic:
 *   • an external cron service (cron-job.org etc.) hitting /health directly
 *   • Fly.io / Oracle / any VPS — `node pinger.mjs`
 *   • a laptop on a shelf (not recommended, but it works)
 *
 * A second Render free service does NOT work: it sleeps too.
 *
 * Design notes that matter in practice:
 *   • Pings /health, not /wake. /wake on Vercel costs a function invocation and
 *     its own cold start; /health is the cheapest possible proof of life and is
 *     the exact thing Render measures.
 *   • Jitter, so a fixed 10:00.000 every ten minutes does not look like a bot.
 *   • Retries with backoff: a cold start can take ~50s, and a single failed
 *     ping must not be reported as "down".
 *   • Never throws. A pinger that crashes is a pinger that stopped pinging.
 *
 *   NEXORA_AGENT_URL=https://nexora-whatsapp-agent.onrender.com node pinger.mjs
 *   NEXORA_AGENT_URL=... NEXORA_PING_ONCE=1 node pinger.mjs   # cron-style
 */
const BASE = (process.env.NEXORA_AGENT_URL ?? '').replace(/\/+$/, '');
const MINUTES = Math.max(1, Number(process.env.NEXORA_PING_MINUTES ?? 10));
const ONCE = process.env.NEXORA_PING_ONCE === '1';
const TIMEOUT_MS = Number(process.env.NEXORA_PING_TIMEOUT_MS ?? 60000);

if (!BASE) {
  console.error('Set NEXORA_AGENT_URL (e.g. https://nexora-whatsapp-agent.onrender.com)');
  process.exit(2);
}

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

/**
 * One ping, with retries. A deliberately cold instance can take most of a
 * minute to answer, so a single slow reply is not a failure.
 */
async function ping(attempts = 3) {
  for (let i = 1; i <= attempts; i += 1) {
    const started = Date.now();
    try {
      const res = await fetch(`${BASE}/health`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': 'nexora-keepalive/1' },
      });
      const ms = Date.now() - started;
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok) {
        // links is proof the agent is not merely up but holding its sessions.
        log(`ok ${res.status} in ${ms}ms — links: ${Array.isArray(body.links) ? body.links.length : 0}`);
        return true;
      }
      log(`bad answer ${res.status} in ${ms}ms (attempt ${i}/${attempts})`);
    } catch (e) {
      // A timeout on the first attempt usually means it was asleep and is now
      // waking — which is exactly what this job exists to prevent.
      log(`no answer in ${Date.now() - started}ms: ${e.message} (attempt ${i}/${attempts})`);
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, 5000 * i));
  }
  return false;
}

if (ONCE) {
  const ok = await ping();
  process.exit(ok ? 0 : 1);
}

// Jitter keeps the pattern from landing on the same second forever, and stops
// GitHub's scheduler (which fires late under load) from stacking runs.
const jitter = (ms) => Math.floor(ms * (0.9 + Math.random() * 0.2));
const interval = jitter(MINUTES * 60 * 1000);

log(`keeping ${BASE} awake every ~${MINUTES} min (this run: ${Math.round(interval / 1000)}s)`);
await ping();
setInterval(() => {
  ping().catch(() => {});
}, interval);

process.on('SIGTERM', () => {
  log('stopping');
  process.exit(0);
});
