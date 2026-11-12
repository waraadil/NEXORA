import 'server-only';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { newClaimToken, CLAIM_TTL_MS } from './agent-auth';
import { CONSENT_VERSION } from './bridge-risks';

/**
 * The link handshake, as a library.
 *
 * Called by the app's server action (never over HTTP from the page), so there
 * is no self-call to secure and no origin check to get wrong.
 *
 *   1. mint a one-use claim token bound to the pending pairing
 *   2. ask the always-on agent to adopt it — an OUTBOUND request, so the agent
 *      needs no public address, no open port, no inbound firewall rule
 *   3. report exactly what happened
 *
 * `agentConfigured: false` means no agent is hosted for this deployment. The UI
 * then offers the user's own runner instead of pretending anything is running.
 */

export type StartLinkResult = {
  claim: string;
  expiresAt: string;
  agentConfigured: boolean;
  /** True only when the agent confirmed it adopted the claim. */
  agentAdopted: boolean;
  error?: string;
};

export async function startAgentLink(params: {
  userId: string;
  phone: string;
  appUrl: string;
}): Promise<StartLinkResult> {
  const admin = createSupabaseAdminClient();

  const { token, hash } = newClaimToken();
  const now = new Date().toISOString();

  // The consent gate lives in the server action, which is the only caller. This
  // function creates the pairing record: a pending integration plus the
  // short-lived claim an agent adopts. Upserting here means the very first
  // pairing works, not just re-pairing an existing row.
  const { data: upserted, error: upsertError } = await admin
    .from('whatsapp_integrations')
    .upsert(
      {
        user_id: params.userId,
        mode: 'personal_bridge',
        status: 'pending',
        risk_acknowledged_at: now,
        risk_acknowledged_version: CONSENT_VERSION,
        // Mirrors the form: approval is on until the owner turns it off.
        auto_reply_require_approval: true,
        updated_at: now,
      },
      { onConflict: 'user_id' },
    )
    .select('id')
    .single();

  if (upsertError || !upserted) {
    throw new Error(`Could not start pairing: ${upsertError?.message ?? 'unknown'}`);
  }

  const integration = { id: upserted.id as string };

  await admin
    .from('whatsapp_integrations')
    .update({
      agent_claim_hash: hash,
      agent_claim_expires_at: new Date(Date.now() + CLAIM_TTL_MS).toISOString(),
      bridge_pairing_phone: params.phone,
      bridge_pairing_at: new Date().toISOString(),
      bridge_session_state: 'pairing',
      bridge_session_state_at: new Date().toISOString(),
      pairing_code: null,
      pairing_code_at: null,
      last_error: null,
    })
    .eq('id', integration.id);

  const agentUrl = process.env.NEXORA_AGENT_URL?.trim();
  const secret = process.env.NEXORA_AGENT_SECRET?.trim();

  const base = {
    claim: token,
    expiresAt: new Date(Date.now() + CLAIM_TTL_MS).toISOString(),
    agentConfigured: Boolean(agentUrl && secret),
    agentAdopted: false,
  };

  if (!agentUrl || !secret) return base;

  try {
    const res = await fetch(`${agentUrl.replace(/\/+$/, '')}/adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nexora-agent-secret': secret },
      body: JSON.stringify({ base: params.appUrl, claim: token, phone: params.phone, userId: params.userId }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return { ...base, error: `The agent refused the request (HTTP ${res.status}).` };
    }
    return { ...base, agentAdopted: true };
  } catch (e) {
    return {
      ...base,
      error:
        'The WhatsApp agent did not answer. It may still be waking up — try again in a minute. ' +
        (e as Error).message.slice(0, 120),
    };
  }
}
