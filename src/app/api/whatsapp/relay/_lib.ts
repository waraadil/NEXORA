import { NextResponse, type NextRequest } from 'next/server';
import { resolveRelayKey, type RelayOwner } from '@/lib/whatsapp/relay';

/**
 * Shared auth for the relay endpoints.
 *
 * The relay holds a key, not a browser session, so these routes authenticate on
 * that key alone. Every handler must go through here — an unauthenticated relay
 * route would let anyone write messages into any account.
 */

export type RelayContext = { owner: RelayOwner; key: string };

export class RelayAuthError extends Error {}

export function relayKeyFrom(request: NextRequest): string {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) throw new RelayAuthError('missing bearer key');
  const key = header.slice(7).trim();
  if (!key) throw new RelayAuthError('empty bearer key');
  return key;
}

export async function requireRelay(request: NextRequest): Promise<RelayContext> {
  const key = relayKeyFrom(request);
  const owner = await resolveRelayKey(key);
  if (!owner) throw new RelayAuthError('invalid or revoked relay key');
  return { owner, key };
}

export function relayError(error: unknown) {
  if (error instanceof RelayAuthError) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : 'unexpected error';
  return NextResponse.json({ error: message }, { status: 500 });
}

/** Relay bodies can be large (a history replay), so parse defensively. */
export async function readJson<T>(request: NextRequest): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
