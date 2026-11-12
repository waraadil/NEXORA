import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { encryptSecret, decryptSecret } from '@/lib/crypto';

/**
 * PERSONAL WHATSAPP — pairing and relay keys
 * ──────────────────────────────────────────
 * NEXORA links your personal WhatsApp the same way WhatsApp Web does: as an
 * extra linked device. Your phone stays the primary device and keeps working
 * normally. You never give NEXORA your password, your two-step PIN, or any
 * backup or encryption key.
 *
 * ── WHAT NEXORA STORES ───────────────────────────────────────────────────
 *   • a SHA-256 hash of a relay key (never the key itself)
 *   • the phone number you chose to pair
 *   • the device name and last-seen time
 * It does NOT store your WhatsApp session, your messages' encryption keys, or
 * anything that would let it act as your phone.
 *
 * ── WHAT IT STILL IS ─────────────────────────────────────────────────────
 * Not an official Meta integration. Automating a personal account breaks
 * WhatsApp's Terms of Service and can get the number banned. The UI requires
 * explicit, versioned consent before a key is issued, labels every message
 * with provenance, and can revoke the key instantly.
 */

export { CONSENT_VERSION, BRIDGE_RISKS, REQUIRED_ACKNOWLEDGEMENTS, CONFIRMATION_PHRASE } from './bridge-risks';
import { CONSENT_VERSION } from './bridge-risks';

export const PAIRING_TTL_MS = 15 * 60 * 1000; // a code is good for 15 minutes

/** Digits only, no plus. WhatsApp rejects anything else. */
export function normalizePairingPhone(input: string): string | null {
  const digits = String(input ?? '').replace(/[^\d]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  // A stray leading 0 (national format) produces a number WhatsApp can never
  // match. Strip exactly one so "+91 0987…" style typos still work.
  return digits.replace(/^0+/, '') === digits ? digits : digits.replace(/^0+/, '');
}

function hashKey(key: string) {
  return createHash('sha256').update(key).digest('hex');
}

export type IssuedKey = { key: string; prefix: string };

/**
 * Start pairing. Issues a relay key (shown once) and opens a short window in
 * which a code will be accepted for `phone`.
 */
export async function startPairing(userId: string, phone: string): Promise<IssuedKey> {
  const admin = createSupabaseAdminClient();
  const normalized = normalizePairingPhone(phone);
  if (!normalized) throw new Error('That phone number is not valid. Include the country code.');

  const key = `nxr_relay_${randomBytes(32).toString('base64url')}`;
  // Encrypted copy so the owner can be shown their own command again after a
  // reload. Without it, a page refresh mid-pairing strands the user with a
  // pending window they can no longer drive.
  const enc = encryptSecret(key);

  const { error } = await admin.from('whatsapp_integrations').upsert(
    {
      user_id: userId,
      mode: 'personal_bridge',
      status: 'pending',
      bridge_token_hash: hashKey(key),
      bridge_token_ciphertext: enc.ciphertext,
      bridge_token_iv: enc.iv,
      bridge_token_auth_tag: enc.authTag,
      bridge_pairing_phone: normalized,
      bridge_pairing_at: new Date().toISOString(),
      bridge_session_state: 'pairing',
      bridge_session_state_at: new Date().toISOString(),
      bridge_self_jid: null,
      bridge_self_number: null,
      bridge_self_name: null,
      risk_acknowledged_at: new Date().toISOString(),
      risk_acknowledged_version: CONSENT_VERSION,
      last_error: null,
    },
    { onConflict: 'user_id' },
  );

  if (error) throw new Error(`Could not start pairing: ${error.message}`);

  return { key, prefix: key.slice(0, 16) };
}

/**
 * The owner's own relay key, decrypted for re-display. Only ever called from a
 * server-side path that has already authenticated the user as that owner.
 */
export async function revealRelayKey(userId: string): Promise<string | null> {
  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from('whatsapp_integrations')
    .select('bridge_token_ciphertext, bridge_token_iv, bridge_token_auth_tag')
    .eq('user_id', userId)
    .maybeSingle();

  if (!data?.bridge_token_ciphertext) return null;

  try {
    return decryptSecret({
      ciphertext: data.bridge_token_ciphertext as string,
      iv: data.bridge_token_iv as string,
      auth_tag: data.bridge_token_auth_tag as string,
    });
  } catch {
    return null;
  }
}

/** Revoke: clears the hash so any held key stops working immediately. */
export async function revokeRelay(userId: string): Promise<void> {
  const admin = createSupabaseAdminClient();
  await admin
    .from('whatsapp_integrations')
    .update({
      status: 'disabled',
      bridge_token_hash: null,
      bridge_token_ciphertext: null,
      bridge_token_iv: null,
      bridge_token_auth_tag: null,
      bridge_pairing_phone: null,
      bridge_pairing_at: null,
      bridge_session_state: 'unpaired',
      bridge_session_state_at: new Date().toISOString(),
      bridge_self_jid: null,
      bridge_relay_lock: null,
      bridge_relay_lock_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId);
}

export type RelayOwner = {
  userId: string;
  integrationId: string;
  status: string;
  autoReplyEnabled: boolean;
  requireApproval: boolean;
};

/**
 * Resolve a relay key to its owner.
 *
 * Looks the key up BY HASH (indexed). The previous implementation selected a
 * single integration row across all users and compared, which both scanned the
 * table and would throw as soon as a second account connected.
 */
export async function resolveRelayKey(key: string): Promise<RelayOwner | null> {
  if (!key || !key.startsWith('nxr_')) return null;

  const admin = createSupabaseAdminClient();
  const hash = hashKey(key);

  const { data } = await admin
    .from('whatsapp_integrations')
    .select('id, user_id, status, bridge_token_hash, auto_reply_enabled, auto_reply_require_approval')
    .eq('bridge_token_hash', hash)
    .maybeSingle();

  if (!data?.bridge_token_hash) return null;

  // Belt and braces: the lookup is already keyed, but compare constant-time so
  // a (theoretical) index timing leak cannot confirm a prefix.
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(data.bridge_token_hash as string, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  if (data.status !== 'connected' && data.status !== 'pending') return null;

  return {
    userId: data.user_id as string,
    integrationId: data.id as string,
    status: data.status as string,
    autoReplyEnabled: !!data.auto_reply_enabled,
    requireApproval: data.auto_reply_require_approval !== false,
  };
}

/**
 * Heartbeat only — proves the relay process is running, nothing more.
 *
 * Kept separate from `touchRelay` on purpose. The relay polls for work while it
 * is still showing a pairing QR/code, so treating "it polled" as "it connected"
 * marked accounts live before the user had typed anything into their phone.
 */
export async function heartbeatRelay(userId: string): Promise<void> {
  const admin = createSupabaseAdminClient();
  const now = new Date().toISOString();
  await admin
    .from('whatsapp_integrations')
    .update({ bridge_last_seen_at: now, updated_at: now })
    .eq('user_id', userId);
}

/** Mark the relay alive; called on connect and on a 60s heartbeat. */
export async function touchRelay(
  userId: string,
  patch: {
    state?: 'connected' | 'pairing' | 'offline' | 'unpaired';
    selfJid?: string | null;
    selfPhone?: string | null;
    selfName?: string | null;
    reason?: string | null;
  } = {},
): Promise<void> {
  const admin = createSupabaseAdminClient();
  const now = new Date().toISOString();

  const update: Record<string, unknown> = {
    bridge_last_seen_at: now,
    bridge_session_state_at: now,
    updated_at: now,
  };

  if (patch.state) {
    update.bridge_session_state = patch.state;
    // First successful link promotes the integration to fully connected.
    if (patch.state === 'connected') {
      update.status = 'connected';
      update.last_connected_at = now;
    }
    if (patch.state === 'unpaired') {
      update.status = 'disabled';
      update.bridge_token_hash = null;
    }
  }
  if (patch.selfJid !== undefined) update.bridge_self_jid = patch.selfJid;
  if (patch.selfPhone !== undefined) update.bridge_self_number = patch.selfPhone;
  if (patch.selfName !== undefined) update.bridge_self_name = patch.selfName;
  if (patch.reason !== undefined) update.last_error = patch.reason;

  await admin.from('whatsapp_integrations').update(update).eq('user_id', userId);
}

/** Human-readable state for the UI, derived from stored facts only. */
export type RelayState = {
  /**
   * UI vocabulary. 'live' means connected AND heartbeating recently.
   * 'expired' means a pairing was started but its 15-minute window closed
   * without a link — distinct from 'unpaired' so the page can say what happened
   * instead of silently showing the first-time form again.
   */
  status: 'unpaired' | 'waiting' | 'connecting' | 'live' | 'offline' | 'unpaired_remote' | 'expired';
  lastSeenAt: string | null;
  selfNumber: string | null;
  selfName: string | null;
  deviceName: string | null;
  pairingPhone: string | null;
  pairingExpiresAt: string | null;
  /** Code WhatsApp issued, rendered in the app. Null until the agent reports it. */
  pairingCode: string | null;
  lastError: string | null;
  autoReplyEnabled: boolean;
  requireApproval: boolean;
  delaySeconds: number;
  instructions: string | null;
  emojiPreference: 'auto' | 'never' | 'match';
  paused: boolean;
  pausedReason: string | null;
};

export const RELAY_OFFLINE_AFTER_MS = 3 * 60 * 1000;

export function describeRelay(row: Record<string, unknown> | null): RelayState {
  const base: RelayState = {
    status: 'unpaired',
    lastSeenAt: null,
    selfNumber: null,
    selfName: null,
    deviceName: null,
    pairingPhone: null,
    pairingExpiresAt: null,
    pairingCode: null,
    lastError: null,
    autoReplyEnabled: false,
    requireApproval: false,
    delaySeconds: 4,
    instructions: null,
    emojiPreference: 'auto',
    paused: false,
    pausedReason: null,
  };

  if (!row) return base;

  const lastSeenAt = (row.bridge_last_seen_at as string | null) ?? null;
  const pairingAt = row.bridge_pairing_at ? new Date(row.bridge_pairing_at as string).getTime() : null;

  // A pairing window is 15 minutes. Anything older is not "waiting" — it is a
  // dead attempt, and rendering it as waiting is a trap: the card shows a
  // spinner and an "expired" badge at the same time, the form that would start
  // a fresh pairing is never rendered, and there is no way out but a hidden
  // advanced block. Age it out and let the page offer a real restart.
  // What the countdown actually measures.
  //
  // The 15-minute window belongs to the CODE, not to the click that started it.
  // The agent has to wake, open a socket and ask WhatsApp, which can take most
  // of a minute, and it may retry up to three times. Starting the clock at
  // `bridge_pairing_at` meant a user could be given a brand-new code with a
  // countdown already reading a few seconds — and be told it expired while the
  // code was still perfectly good. Use the moment the code reached us, falling
  // back to the click only while no code has arrived yet.
  const codeAt = row.pairing_code_at ? new Date(row.pairing_code_at as string).getTime() : null;
  const windowStart = codeAt ?? pairingAt;
  const pairingStale = windowStart !== null && Date.now() - windowStart > PAIRING_TTL_MS;

  // A code whose own 15 minutes are up is rejected by WhatsApp, so it must not
  // be shown even if the claim window is somehow still open.
  const codeStale = codeAt !== null && Date.now() - codeAt > PAIRING_TTL_MS;
  const storedStatus = (row.status as string) ?? null;
  const storedSession = (row.bridge_session_state as string | null) ?? null;

  const status =
    pairingStale && !row.bridge_self_number
      ? ('expired' as const)
      : storedToUiStatus(storedStatus, storedSession);

  return {
    ...base,
    status,
    lastSeenAt,
    selfNumber: (row.bridge_self_number as string | null) ?? null,
    selfName: (row.bridge_self_name as string | null) ?? null,
    deviceName: (row.bridge_device_name as string | null) ?? null,
    pairingPhone: (row.bridge_pairing_phone as string | null) ?? null,
    pairingExpiresAt:
      windowStart && !pairingStale ? new Date(windowStart + PAIRING_TTL_MS).toISOString() : null,
    // A dead code is worse than no code: WhatsApp rejects it and the user types
    // a stale string into their phone.
    pairingCode: codeStale ? null : ((row.pairing_code as string | null) ?? null),
    lastError: (row.last_error as string | null) ?? null,
    autoReplyEnabled: !!row.auto_reply_enabled,
    requireApproval: !!row.auto_reply_require_approval,
    delaySeconds: (row.auto_reply_delay_seconds as number | null) ?? 4,
    emojiPreference:
      ((row.emoji_preference as string | null) === 'never'
        ? 'never'
        : (row.emoji_preference as string | null) === 'match'
          ? 'match'
          : 'auto') as 'auto' | 'never' | 'match',
    instructions: (row.auto_reply_instructions as string | null) ?? null,
    paused: !!row.auto_reply_paused_at,
    pausedReason: (row.auto_reply_paused_reason as string | null) ?? null,
  };
}

/**
 * Stored session words vs the words the UI uses. Kept in one function so a new
 * stored value can never silently fall through to "unpaired" in one place and
 * "live" in another.
 */
export function storedToUiStatus(
  status: string | null,
  sessionState: string | null,
): RelayState['status'] {
  if (status === 'disabled') return 'unpaired';
  switch (sessionState) {
    case 'connected':
      return 'live';
    case 'pairing':
      return 'waiting';
    case 'offline':
      return 'offline';
    case 'unpaired':
      return 'unpaired';
    default:
      return status === 'connected' ? 'live' : 'unpaired';
  }
}

/** What the relay may report as its own state. */
export type RelayReportedState = 'connected' | 'pairing' | 'offline' | 'unpaired';

/**
 * Is the relay alive right now? Based on its last heartbeat, which is the only
 * honest signal we have — a stored "connected" flag would keep claiming a live
 * link long after the user closed the terminal.
 */
export function isRelayLive(lastSeenAt: string | null, now = Date.now()): boolean {
  if (!lastSeenAt) return false;
  return now - new Date(lastSeenAt).getTime() < RELAY_OFFLINE_AFTER_MS;
}
