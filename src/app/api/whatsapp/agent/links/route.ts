import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { resolveDurableAgentToken } from '@/lib/whatsapp/agent-auth';

/**
 * GET /api/whatsapp/agent/links
 *
 * "Which links should I be holding right now?"
 *
 * The agent needs this after a restart on a host that gives it no disk — a
 * free Render instance, a redeploy, a container that was replaced. It used to
 * answer the question by reading `*.token` files it had written locally, which
 * works on a VPS and fails silently everywhere else: the process comes back,
 * `/health` says fine, and no WhatsApp session is ever restored.
 *
 * Authority lives in the database, so ask the database. Only a durable agent
 * token may call this (never a claim), and it returns nothing but the owner's
 * own id and token — which the caller already holds.
 */

function bearer(request: NextRequest): string {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export async function GET(request: NextRequest) {
  const ctx = await resolveDurableAgentToken(bearer(request));
  if (!ctx) {
    return NextResponse.json(
      { error: 'invalid or expired agent token', reason: 'unauthorised' },
      { status: 401 },
    );
  }

  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from('whatsapp_integrations')
    .select('user_id, bridge_self_number, bridge_pairing_phone, bridge_session_state, status, pairing_code, agent_revoked_at')
    .eq('user_id', ctx.userId)
    .maybeSingle();

  // Revoked between the token lookup and now, or the row is gone.
  if (!data || data.agent_revoked_at) {
    return NextResponse.json({ ok: true, links: [] });
  }

  const linked = data.bridge_session_state === 'connected' || data.status === 'connected';
  const pairing = data.bridge_session_state === 'pairing' || Boolean(data.pairing_code);

  // A link we should hold: an established session, or a pairing still in flight
  // (the user may be typing the code right now, so it must survive the restart).
  if (!linked && !pairing) {
    return NextResponse.json({ ok: true, links: [] });
  }

  return NextResponse.json({
    ok: true,
    links: [
      {
        userId: data.user_id,
        // The number to request a code for, if this link is still pairing.
        phone: (data.bridge_pairing_phone as string | null) ?? (data.bridge_self_number as string | null),
        state: linked ? 'connected' : 'pairing',
        token: bearer(request),
      },
    ],
  });
}
