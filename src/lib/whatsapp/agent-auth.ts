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
      // A brand-new token is by definition not revoked. Leaving the old
      // revocation timestamp behind made every freshly issued token inert: the
      // next poll matched its hash, saw agent_revoked_at, answered 401
      // `unlinked`, and the agent tore a working link down seconds after it
      // came up. Clearing it here is what makes Reconnect actually reconnect.
      agent_revoked_at: null,
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

/**
 * The agent gave up on a pairing that was never completed.
 *
 * Drop the stale code and the claim so the page stops pretending a code is
 * coming, and record why in last_error — that is what the user is shown. The
 * row goes back to 'unpaired' rather than sitting at 'pending' forever.
 */
export async function markPairingFailed(userId: string, reason: string): Promise<void> {
  const admin = createSupabaseAdminClient();

  // If this account was already linked, failing a *re*-pairing must not erase
  // the link's history: put it back to "offline" so the Reconnect card stays.
  // Only a first-ever pairing falls all the way back to unpaired.
  const { data } = await admin
    .from('whatsapp_integrations')
    .select('bridge_self_number')
    .eq('user_id', userId)
    .maybeSingle();

  const previouslyLinked = Boolean(data?.bridge_self_number);

  await admin
    .from('whatsapp_integrations')
    .update({
      status: previouslyLinked ? 'connected' : 'disabled',
      bridge_session_state: previouslyLinked ? 'offline' : 'unpaired',
      bridge_session_state_at: new Date().toISOString(),
      agent_claim_hash: null,
      agent_claim_expires_at: null,
      // The pairing that was holding this revocation open is over. A stale
      // revocation here poisons the NEXT token too, because upgradeClaimToAgent
      // writes a token that already has a revocation timestamp against the row.
      agent_revoked_at: null,
      pairing_code: null,
      pairing_code_at: null,
      last_error: reason,
    })
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
 * Resolve a DURABLE agent token only. Claims are deliberately rejected: resuming
 * existing links is not a pairing, and a 15-minute claim must never be able to
 * enumerate somebody's links.
 */
export async function resolveDurableAgentToken(token: string): Promise<AgentContext | null> {
  if (!token?.startsWith('nxr_agent_')) return null;
  const admin = createSupabaseAdminClient();
  const hash = sha256(token);
  const { data } = await admin
    .from('whatsapp_integrations')
    .select('id, user_id, agent_token_hash, agent_revoked_at')
    .eq('agent_token_hash', hash)
    .maybeSingle();
  if (!data?.agent_token_hash) return null;
  if (!constantTimeEqual(hash, data.agent_token_hash as string)) return null;
  if (data.agent_revoked_at) return null;
  return { userId: data.user_id as string, integrationId: data.id as string, via: 'agent' };
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
