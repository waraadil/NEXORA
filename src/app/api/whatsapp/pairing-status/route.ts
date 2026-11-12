import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/guard';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { describeRelay, PAIRING_COLUMNS } from '@/lib/whatsapp/relay';

/**
 * GET /api/whatsapp/pairing-status
 *
 * What the pairing card is allowed to know, for the signed-in user only.
 *
 * This exists because `router.refresh()` is not a reliable way to watch a
 * pairing come up. The code really does reach the browser — the refresh payload
 * carries it — but React keeps rendering the old props, so the card sat on
 * "Generating your code…" indefinitely while the code was in the database and
 * on the wire. Reloading the page showed it immediately, which is exactly the
 * bug the user reported.
 *
 * A plain request that returns JSON, and state the component holds itself, has
 * no such layer to lose the update through. The card polls this while it is
 * waiting; the page's own server render stays the source of truth for the first
 * paint.
 *
 * No `dynamic` segment config here: it is a build error under cacheComponents.
 * A GET handler that reads the session and the database per request is not
 * prerendered, and the response is marked `no-store` below.
 *
 * It returns the same `describeRelay` view the page renders from, so the poll
 * cannot disagree with a reload. Only the code and the status are needed by the
 * card, and both are already rendered on this page for this user, so nothing
 * new is disclosed. The relay key stays hidden — that is what `revealRelayKey`
 * is for, and it is not called here.
 */

export async function GET() {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Read through the service-role client: the browser session is not granted
  // the bridge columns, and this route speaks for the server, not the browser.
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('whatsapp_integrations')
    .select(PAIRING_COLUMNS)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: 'lookup failed' }, { status: 500 });

  const relay = describeRelay((data ?? null) as Record<string, unknown> | null);

  // Deliberately narrow. The card needs these fields and nothing else; sending
  // the whole row would push auto-reply settings through a poll every 2 seconds.
  return NextResponse.json(
    {
      status: relay.status,
      pairingCode: relay.pairingCode,
      pairingExpiresAt: relay.pairingExpiresAt,
      lastError: relay.lastError,
      selfNumber: relay.selfNumber,
      selfName: relay.selfName,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
