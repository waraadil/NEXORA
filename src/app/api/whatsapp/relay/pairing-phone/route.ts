import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { normalizePairingPhone } from '@/lib/whatsapp/relay';
import { requireRelay, relayError, readJson } from '../_lib';

/**
 * POST /api/whatsapp/relay/pairing-phone
 *
 * Fallback path: if the user runs the relay without the browser field filled
 * in, the relay prompts in the terminal and saves the number here. Both routes
 * end up in the same column, so the pairing window behaves identically.
 */


export async function POST(request: NextRequest) {
  try {
    const { owner } = await requireRelay(request);
    const body = await readJson<{ phone?: string }>(request);

    const phone = normalizePairingPhone(body?.phone ?? '');
    if (!phone) {
      return NextResponse.json({ error: 'Enter country code + number, digits only.' }, { status: 400 });
    }

    const admin = createSupabaseAdminClient();
    await admin
      .from('whatsapp_integrations')
      .update({
        bridge_pairing_phone: phone,
        bridge_pairing_at: new Date().toISOString(),
        bridge_session_state: 'pairing',
        bridge_session_state_at: new Date().toISOString(),
      })
      .eq('id', owner.integrationId)
      .eq('user_id', owner.userId);

    return NextResponse.json({ ok: true, phone });
  } catch (error) {
    return relayError(error);
  }
}
