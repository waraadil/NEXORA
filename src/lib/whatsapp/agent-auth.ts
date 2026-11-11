import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

/**
 * AGENT AUTH
 * ──────────
 * The always-on agent is not a browser and has no Supabase session, so it
 * authenticates with tokens issued here.
 *
 *  • claim token  — short lived (15 min), one use. Lets the agent adopt a
 *                   pending pairing without the user copying a secret into a
 *                   terminal. The user pastes ONE thing: a WhatsApp code.
 *  • agent token  — long lived, issued on first successful claim, revocable
 *                   from the app. Stored only as a SHA-256 hash.
 *
 * Every lookup is an indexed equality on a hash, never a scan, and compared
 * constant-time so a timing side channel cannot confirm a prefix.
 */

export const CLAIM_TTL_MS = 15 * 60 * 1000;

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

function constantTimeEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Created by the app when the user starts pairing. Returned to the agent. */
export function newClaimToken(): { token: string; hash: string } {
  const token = `nxr_claim_${randomBytes(24).toString('base64url')}`;
  return { token, hash: sha256(token) };
}

export function newAgentToken(): { token: string; hash: string } {
  const token = `nxr_agent_${randomBytes(32).toString('base64url')}`;
  return { token, hash: sha256(token) };
}

export type AgentContext = {
  userId: string;
  integrationId: string;
  via: 'claim' | 'agent';
};

/**
 * Resolve a bearer token to its integration. Accepts either a live claim token
 * (first contact after pairing) or an issued agent token (every poll after).
 */
export async function resolveAgentToken(token: string): Promise<AgentContext | null> {
  if (!token?.startsWith('nxr_')) return null;

  const admin = createSupabaseAdminClient();
  const hash = sha256(token);

  // Agent token: long-lived path, taken on every poll.
  const { data: byAgent } = await admin
    .from('whatsapp_integrations')
    .select('id, user_id, agent_token_hash, agent_revoked_at')
    .eq('agent_token_hash', hash)
    .maybeSingle();

  if (byAgent?.agent_token_hash && constantTimeEqual(hash, byAgent.agent_token_hash as string)) {
    // A revoked token still matches its hash — that is how we recognise it. It
    // just does not authorise anything any more.
    if (byAgent.agent_revoked_at) return null;
    return { userId: byAgent.user_id as string, integrationId: byAgent.id as string, via: 'agent' };
  }

  // Claim token: short-lived, and only while the pairing window is open.
  const { data: byClaim } = await admin
    .from('whatsapp_integrations')
    .select('id, user_id, agent_claim_hash, agent_claim_expires_at')
    .eq('agent_claim_hash', hash)
    .maybeSingle();

  if (!byClaim?.agent_claim_hash) return null;
  if (!constantTimeEqual(hash, byClaim.agent_claim_hash as string)) return null;
  if (!byClaim.agent_claim_expires_at) return null;
  if (Date.now() > new Date(byClaim.agent_claim_expires_at as string).getTime()) return null;

  return { userId: byClaim.user_id as string, integrationId: byClaim.id as string, via: 'claim' };
}

/**
 * First successful claim: swap the one-use claim token for a durable agent
 * token. Called only when the agent reports the link is actually up, so a
 * token is never handed out before pairing works.
 */
export async function upgradeClaimToAgent(ctx: AgentContext): Promise<string | null> {
  if (ctx.via !== 'claim') return null;

  const admin = createSupabaseAdminClient();
  const { token, hash } = newAgentToken();

  const { error } = await admin
    .from('whatsapp_integrations')
    .update({
      agent_token_hash: hash,
      agent_claim_hash: null,
      agent_claim_expires_at: null,
      agent_last_seen_at: new Date().toISOString(),
    })
    .eq('id', ctx.integrationId)
    .eq('user_id', ctx.userId);

  return error ? null : token;
}

/** Store the code WhatsApp issued, so the user reads it in the app. */
export async function storePairingCode(userId: string, code: string): Promise<void> {
  const admin = createSupabaseAdminClient();
  await admin
    .from('whatsapp_integrations')
    .update({ pairing_code: code, pairing_code_at: new Date().toISOString() })
    .eq('user_id', userId);
}

export async function clearPairingCode(userId: string): Promise<void> {
  const admin = createSupabaseAdminClient();
  await admin
    .from('whatsapp_integrations')
    .update({ pairing_code: null, pairing_code_at: null })
    .eq('user_id', userId);
}

/** Revoke: the agent's next poll is rejected and it stops. */
export async function revokeAgent(userId: string): Promise<void> {
  const admin = createSupabaseAdminClient();
  await admin
    .from('whatsapp_integrations')
    .update({
      // The hash intentionally survives: it is the only way to tell the agent
      // "you were disconnected on purpose" instead of "your token is unknown".
      // agent_revoked_at makes it inert.
      agent_revoked_at: new Date().toISOString(),
      agent_claim_hash: null,
      agent_claim_expires_at: null,
      pairing_code: null,
      pairing_code_at: null,
    })
    .eq('user_id', userId);
}

/**
 * Was this exact token revoked by its owner?
 *
 * The agent needs a truthful answer when it gets a 401: revoked means shut the
 * WhatsApp session down, anything else means retry. Without this the two cases
 * look identical and a transient mismatch logs the user out of WhatsApp.
 */
export async function wasRevoked(token: string): Promise<boolean> {
  if (!token?.startsWith('nxr_')) return false;
  const admin = createSupabaseAdminClient();
  const hash = sha256(token);
  const { data } = await admin
    .from('whatsapp_integrations')
    .select('agent_token_hash, agent_revoked_at')
    .eq('agent_token_hash', hash)
    .maybeSingle();
  return Boolean(data?.agent_revoked_at);
}
