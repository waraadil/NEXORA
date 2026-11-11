import 'server-only';

/**
 * WhatsApp Cloud API client (Meta Graph API).
 *
 * This is the OFFICIAL business integration. It works on a dedicated WhatsApp
 * Business number — not a personal number — and only exchanges messages with
 * that business number. Everything here is a real Graph API call.
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */

const GRAPH = 'https://graph.facebook.com/v21.0';
const TIMEOUT_MS = 20_000;

export type CloudApiError = {
  kind:
    | 'invalid_token'
    | 'not_configured'
    | 'window_closed'
    | 'rate_limited'
    | 'invalid_recipient'
    | 'network'
    | 'provider_error';
  message: string;
  code?: number;
};

export class WhatsAppError extends Error {
  constructor(
    public kind: CloudApiError['kind'],
    message: string,
    public code?: number,
  ) {
    super(message);
    this.name = 'WhatsAppError';
  }
}

function classifyGraphError(status: number, body: unknown): CloudApiError {
  const err = (body as { error?: { message?: string; code?: number; type?: string } })?.error;
  const msg = err?.message ?? `HTTP ${status}`;
  const code = err?.code;

  // Meta error codes worth naming explicitly
  if (code === 190 || status === 401) {
    return { kind: 'invalid_token', message: 'Access token is invalid or expired.', code };
  }
  if (code === 131047 || /re-engagement|24 hour|window/i.test(msg)) {
    return {
      kind: 'window_closed',
      message:
        'The 24-hour customer service window has closed. WhatsApp requires a pre-approved template message to re-open a conversation.',
      code,
    };
  }
  if (code === 131026 || /not a valid whatsapp/i.test(msg)) {
    return { kind: 'invalid_recipient', message: 'That number is not a valid WhatsApp account.', code };
  }
  if (status === 429 || code === 130429) {
    return { kind: 'rate_limited', message: 'WhatsApp rate limit reached. Retry shortly.', code };
  }
  if (status >= 500) {
    return { kind: 'provider_error', message: `WhatsApp server error (HTTP ${status}).`, code };
  }
  return { kind: 'provider_error', message: msg, code };
}

async function graphFetch(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${GRAPH}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const c = classifyGraphError(res.status, json);
      throw new WhatsAppError(c.kind, c.message, c.code);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** Verify a token + phone number id pair. Used by the connect flow. */
export async function verifyCredentials(
  phoneNumberId: string,
  accessToken: string,
): Promise<{ ok: true; displayPhone: string; verifiedName: string } | { ok: false; error: CloudApiError }> {
  try {
    const data = (await graphFetch(
      `/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`,
      accessToken,
    )) as { display_phone_number?: string; verified_name?: string };

    return {
      ok: true,
      displayPhone: data.display_phone_number ?? '',
      verifiedName: data.verified_name ?? '',
    };
  } catch (e) {
    if (e instanceof WhatsAppError) {
      return { ok: false, error: { kind: e.kind, message: e.message, code: e.code } };
    }
    return { ok: false, error: { kind: 'network', message: (e as Error).message } };
  }
}

export type SendResult = { messageId: string };

/**
 * Send a plain text message.
 * Only valid inside an open 24-hour customer service window — outside it,
 * Meta requires a pre-approved template, and we surface that honestly.
 */
export async function sendText(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  body: string,
): Promise<SendResult> {
  const normalised = to.replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (!/^\d{8,15}$/.test(normalised)) {
    throw new WhatsAppError('invalid_recipient', 'Recipient must be a phone number in international format.');
  }
  if (!body.trim()) throw new WhatsAppError('provider_error', 'Message body is empty.');
  if (body.length > 4096) {
    throw new WhatsAppError('provider_error', 'WhatsApp text messages are limited to 4096 characters.');
  }

  const data = (await graphFetch(`/${encodeURIComponent(phoneNumberId)}/messages`, accessToken, {
    method: 'POST',
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalised,
      type: 'text',
      text: { preview_url: false, body },
    },
  })) as { messages?: { id: string }[] };

  const id = data.messages?.[0]?.id;
  if (!id) throw new WhatsAppError('provider_error', 'WhatsApp accepted the request but returned no message id.');
  return { messageId: id };
}

/** Mark an inbound message as read (shows blue ticks to the sender). */
export async function markRead(
  phoneNumberId: string,
  accessToken: string,
  messageId: string,
): Promise<void> {
  await graphFetch(`/${encodeURIComponent(phoneNumberId)}/messages`, accessToken, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
  });
}

// ───────────────────────── Webhook payload shapes ─────────────────────────

export type WebhookMessage = {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  fromName?: string;
};

export type WebhookStatus = {
  id: string;
  status: string;
  timestamp: string;
  recipientId: string;
};

export type ParsedWebhook = {
  phoneNumberId: string;
  displayPhone: string;
  messages: (WebhookMessage & { contactName?: string })[];
  statuses: WebhookStatus[];
};

/**
 * Parse a Meta webhook payload into normalised messages/statuses.
 * Tolerant of shape drift — Meta has changed this structure before.
 */
export function parseWebhook(payload: unknown): ParsedWebhook[] {
  const out: ParsedWebhook[] = [];
  const body = payload as {
    object?: string;
    entry?: {
      changes?: {
        field?: string;
        value?: {
          messaging_product?: string;
          metadata?: { phone_number_id?: string; display_phone_number?: string };
          contacts?: { profile?: { name?: string }; wa_id?: string }[];
          messages?: WebhookMessage[];
          statuses?: WebhookStatus[];
        };
      }[];
    }[];
  };

  if (body?.object !== 'whatsapp_business_account') return out;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const v = change.value;
      if (!v?.metadata?.phone_number_id) continue;

      const nameByWaId = new Map<string, string>();
      for (const c of v.contacts ?? []) {
        if (c.wa_id && c.profile?.name) nameByWaId.set(c.wa_id, c.profile.name);
      }

      out.push({
        phoneNumberId: v.metadata.phone_number_id,
        displayPhone: v.metadata.display_phone_number ?? '',
        messages: (v.messages ?? []).map((m) => ({
          ...m,
          contactName: nameByWaId.get(m.from),
        })),
        statuses: v.statuses ?? [],
      });
    }
  }

  return out;
}

/** HMAC-SHA256 signature check for X-Hub-Signature-256. Constant-time compare. */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith('sha256=')) return false;

  const { createHmac, timingSafeEqual } = await import('node:crypto');
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const provided = signatureHeader.slice('sha256='.length);

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
