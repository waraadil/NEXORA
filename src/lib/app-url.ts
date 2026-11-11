/**
 * Absolute base URL this app advertises to the outside world — OAuth redirects,
 * webhook endpoints, the WhatsApp bridge.
 *
 * Resolution order matters. `NEXT_PUBLIC_APP_URL` is authoritative, but it is
 * inlined at build time, so a build that forgot to set it would otherwise ship
 * "http://localhost:3000" to real users. Vercel injects the real production
 * domain at runtime, so we can recover from that misconfiguration instead of
 * handing out a dead link.
 *
 * Server-side only: both call sites (the auth server actions and the
 * integrations page) run on the server. Do not import this from a client
 * component — the Vercel env vars would be undefined there.
 */

const LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

const clean = (url: string) => url.replace(/\/+$/, '');

export function getAppUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const onVercel = Boolean(process.env.VERCEL ?? process.env.VERCEL_ENV);

  // A deployed build must never advertise localhost, even when the env var
  // says so. Prefer the domain Vercel knows it is serving.
  const explicitIsLocalhost = Boolean(explicit && LOCALHOST.test(explicit));
  if (explicit && !(onVercel && explicitIsLocalhost)) {
    return clean(explicit);
  }

  for (const key of ['VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL'] as const) {
    const value = process.env[key]?.trim();
    if (value) return clean(`https://${value}`);
  }

  // Local development, or a deployment with nothing configured.
  return explicit ? clean(explicit) : 'http://localhost:3000';
}
