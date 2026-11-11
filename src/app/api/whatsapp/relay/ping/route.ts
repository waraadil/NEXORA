import { NextResponse, type NextRequest } from 'next/server';
import { touchRelay, type RelayReportedState } from '@/lib/whatsapp/relay';
import { requireRelay, relayError, readJson } from '../_lib';

/**
 * POST /api/whatsapp/relay/ping
 *
 * Heartbeat + identity. Called when the relay connects, every 60s while it is
 * alive, and when it loses or is removed from the account. This is the only
 * source of the "live" indicator in the UI — no stored boolean that keeps
 * claiming success after the user closes the terminal.
 */


type PingBody = {
  state?: RelayReportedState;
  selfJid?: string | null;
  selfPhone?: string | null;
  selfName?: string | null;
  reason?: string | null;
};

const ALLOWED: RelayReportedState[] = ['connected', 'pairing', 'offline', 'unpaired'];

export async function POST(request: NextRequest) {
  try {
    const { owner } = await requireRelay(request);
    const body = await readJson<PingBody>(request);

    const state = body?.state && ALLOWED.includes(body.state) ? body.state : undefined;

    await touchRelay(owner.userId, {
      state,
      selfJid: body?.selfJid,
      selfPhone: body?.selfPhone,
      selfName: body?.selfName,
      reason: body?.reason ?? null,
    });

    return NextResponse.json({ ok: true, state: state ?? 'connected' });
  } catch (error) {
    return relayError(error);
  }
}
