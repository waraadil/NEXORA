import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { PAIRING_TTL_MS } from '@/lib/whatsapp/relay';
import { requireRelay, relayError } from '../_lib';

/**
 * POST /api/whatsapp/relay/pairing-read
 *
 * Hands the relay the phone number the user typed in the browser, so pairing
 * is one field in NEXORA and nothing is typed into a terminal. The number was
 * already provided by the account owner, so this is not new disclosure.
 */


export async function POST(request: NextRequest) {
  try {
    const { owner } = await requireRelay(request);

    const admin = createSupabaseAdminClient();
    const { data } = await admin
      .from('whatsapp_integrations')
      .select('bridge_pairing_phone, bridge_pairing_at')
      .eq('id', owner.integrationId)
      .maybeSingle();

    const pairingAt = data?.bridge_pairing_at ? new Date(data.bridge_pairing_at as string).getTime() : 0;
    const expired = !pairingAt || Date.now() - pairingAt > PAIRING_TTL_MS;

    return NextResponse.json({
      ok: true,
      pairingPhone: expired ? null : ((data?.bridge_pairing_phone as string | null) ?? null),
      expired,
    });
  } catch (error) {
    return relayError(error);
  }
}
