import { connection, NextResponse, type NextRequest } from 'next/server';

/**
 * GET /api/whatsapp/agent/wake
 *
 * Keeps a free-tier agent awake, and is safe to call from anything — a cron, an
 * open tab, a curl loop, Render's own health check.
 *
 * Why this exists: Render spins a free web service down after 15 minutes
 * without inbound traffic. Vercel's Hobby cron can only run once a day, which
 * is nowhere near often enough, so the app cannot be the only clock. Any caller
 * — including the browser of someone using NEXORA — can top the agent up.
 *
 * It is deliberately dumb: a GET to the agent's /health, no side effects, no
 * auth. It reveals nothing beyond whether the agent answered, which /health
 * already says publicly on the agent itself.
 */

export async function GET(_request: NextRequest) {
  // This route talks to another service, so it must run per-request. The project
  // enables cacheComponents, which makes `export const dynamic` a build error;
  // `connection()` is how a route opts out of prerendering instead. Without it
  // the build prerenders this handler once and every live call answers 500 with
  // DYNAMIC_SERVER_USAGE — silently killing the keep-alive it exists for.
  await connection();

  const agentUrl = process.env.NEXORA_AGENT_URL?.trim();

  if (!agentUrl) {
    return NextResponse.json(
      { ok: false, reason: 'no_agent_configured' },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  }

  const started = Date.now();
  try {
    const res = await fetch(`${agentUrl.replace(/\/+$/, '')}/health`, {
      method: 'GET',
      // The point is to be a real request from outside; never let the CDN serve
      // it from cache, or Render sees nothing and still spins the service down.
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { ok: false, reason: 'agent_unreachable', status: res.status, ms: Date.now() - started },
        { headers: { 'cache-control': 'no-store' } },
      );
    }

    const body = (await res.json().catch(() => null)) as { ok?: boolean; links?: unknown[] } | null;

    return NextResponse.json(
      {
        ok: true,
        // Honest: an empty link list means the agent is up and holds no
        // WhatsApp session. It is not proof that anyone is linked.
        links: Array.isArray(body?.links) ? body.links.length : 0,
        ms: Date.now() - started,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        reason: 'agent_did_not_answer',
        detail: (e as Error).message.slice(0, 120),
        ms: Date.now() - started,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  }
}
