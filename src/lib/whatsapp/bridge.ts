import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

/**
 * PERSONAL WHATSAPP BRIDGE — self-hosted, opt-in, explicitly risky.
 *
 * ── WHAT THIS IS ──────────────────────────────────────────────────────────
 * NEXORA does not embed an unofficial WhatsApp library. Instead it exposes a
 * token-authenticated ingest endpoint that a *user-run* bridge process can push
 * messages to. The bridge runs on the user's own machine with their own
 * WhatsApp account and their own session credentials.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
 * It is not an official Meta integration. WhatsApp's Terms of Service prohibit
 * unauthorised automation of personal accounts. Account suspension/ban is a
 * real and documented outcome. NEXORA therefore:
 *   • requires an explicit, versioned consent record before a token is issued
 *   • never ships the automation code itself
 *   • labels every bridged message with provenance so it is never mistaken
 *     for an official integration
 *   • can be disabled instantly, revoking the token
 */

export { CONSENT_VERSION, BRIDGE_RISKS, REQUIRED_ACKNOWLEDGEMENTS, CONFIRMATION_PHRASE } from './bridge-risks';
import { CONSENT_VERSION } from './bridge-risks';

/** Issue a bridge token. Returned ONCE — only its hash is stored. */
export async function issueBridgeToken(userId: string): Promise<{ token: string; prefix: string }> {
  const admin = createSupabaseAdminClient();

  const token = `nxr_br_${randomBytes(32).toString('base64url')}`;
  const hash = createHash('sha256').update(token).digest('hex');

  const { error } = await admin
    .from('whatsapp_integrations')
    .upsert(
      {
        user_id: userId,
        mode: 'personal_bridge',
        status: 'connected',
        bridge_token_hash: hash,
        bridge_last_seen_at: null,
        risk_acknowledged_at: new Date().toISOString(),
        risk_acknowledged_version: CONSENT_VERSION,
        last_connected_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );

  if (error) throw new Error(`Could not issue bridge token: ${error.message}`);

  return { token, prefix: token.slice(0, 12) };
}

/** Revoke the bridge: clears the hash so any held token stops working. */
export async function revokeBridge(userId: string): Promise<void> {
  const admin = createSupabaseAdminClient();
  await admin
    .from('whatsapp_integrations')
    .update({
      status: 'disabled',
      bridge_token_hash: null,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('mode', 'personal_bridge');
}

/** Constant-time lookup of a bridge token to its owner. */
export async function resolveBridgeToken(token: string): Promise<{ userId: string; integrationId: string } | null> {
  if (!token.startsWith('nxr_br_')) return null;

  const admin = createSupabaseAdminClient();
  const hash = createHash('sha256').update(token).digest('hex');

  const { data } = await admin
    .from('whatsapp_integrations')
    .select('id, user_id, bridge_token_hash, status')
    .eq('status', 'connected')
    .eq('mode', 'personal_bridge')
    .maybeSingle();

  if (!data?.bridge_token_hash) return null;

  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(data.bridge_token_hash as string, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Touch last-seen for the health indicator.
  await admin
    .from('whatsapp_integrations')
    .update({ bridge_last_seen_at: new Date().toISOString() })
    .eq('id', data.id);

  return { userId: data.user_id as string, integrationId: data.id as string };
}

/** Shape of what a bridge process POSTs to /api/whatsapp/bridge/ingest. */
export type BridgePayload = {
  chat: {
    id: string; // bridge-local chat id, e.g. "919876543210@c.us"
    name: string;
    isGroup: boolean;
  };
  messages: {
    id: string;
    fromMe: boolean;
    senderName: string;
    body: string;
    timestamp: number; // unix seconds
  }[];
};
