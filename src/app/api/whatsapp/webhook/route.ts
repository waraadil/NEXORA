import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { decryptSecret } from '@/lib/crypto';
import { parseWebhook, verifyWebhookSignature } from '@/lib/whatsapp/cloud-api';
import { ingestWebhook } from '@/lib/whatsapp/ingest';

/**
 * Meta webhook endpoint.
 *
 * GET  — one-time verification handshake (hub.challenge echo).
 * POST — message + status deliveries, HMAC-verified per integration.
 *
 * This route is unauthenticated by design (Meta calls it), so the app secret
 * signature is the authentication. We resolve which integration a payload
 * belongs to by phone_number_id, then verify against THAT integration's secret.
 */

// GET /api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=X&hub.challenge=Y
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode !== 'subscribe' || !token) {
    return new NextResponse('Bad request', { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from('whatsapp_integrations')
    .select('id, verify_token')
    .eq('verify_token', token)
    .maybeSingle();

  if (!data) {
    // Do not reveal whether the token exists.
    return new NextResponse('Forbidden', { status: 403 });
  }

  return new NextResponse(challenge ?? '', {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });
}

// POST /api/whatsapp/webhook
export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const payloads = parseWebhook(parsed);
  if (payloads.length === 0) {
    // Not a WhatsApp payload — acknowledge so Meta doesn't retry forever.
    return NextResponse.json({ ok: true, ignored: true });
  }

  const admin = createSupabaseAdminClient();
  const signature = request.headers.get('x-hub-signature-256');

  // Verify per-integration. Each payload names its phone_number_id.
  for (const payload of payloads) {
    const { data: integration } = await admin
      .from('whatsapp_integrations')
      .select('app_secret_ciphertext, app_secret_iv, app_secret_auth_tag, status')
      .eq('phone_number_id', payload.phoneNumberId)
      .maybeSingle();

    if (!integration?.app_secret_ciphertext) {
      // Unknown number or no secret stored — reject rather than trust the body.
      return NextResponse.json({ error: 'unknown integration' }, { status: 404 });
    }

    let appSecret: string;
    try {
      appSecret = decryptSecret({
        ciphertext: integration.app_secret_ciphertext,
        iv: integration.app_secret_iv,
        auth_tag: integration.app_secret_auth_tag,
      });
    } catch {
      return NextResponse.json({ error: 'integration misconfigured' }, { status: 500 });
    }

    const valid = await verifyWebhookSignature(rawBody, signature, appSecret);
    if (!valid) {
      return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
    }
  }

  const result = await ingestWebhook(payloads);

  // Always 200 once the signature is valid — a non-200 makes Meta retry
  // deliveries we have already recorded, and can disable the webhook.
  return NextResponse.json({ ok: true, ...result });
}
