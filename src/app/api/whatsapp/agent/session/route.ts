import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { resolveAgentToken } from '@/lib/whatsapp/agent-auth';
import { encryptSecret, decryptSecret } from '@/lib/crypto';

/**
 * GET/POST /api/whatsapp/agent/session
 *
 * The WhatsApp device credentials (the "session") live here, AES-256-GCM
 * encrypted, so the agent can start on a fresh host — a redeploy, a restart, a
 * machine that wiped its disk — without asking the user to pair again.
 *
 * This is the same class of secret the Cloud API access token already uses,
 * and it is readable only by the service role. The browser never sees it.
 */

function bearer(request: NextRequest): string {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export async function GET(request: NextRequest) {
  const ctx = await resolveAgentToken(bearer(request));
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from('whatsapp_sessions')
    .select('payload_ciphertext, payload_iv, payload_auth_tag, key_count, updated_at')
    .eq('user_id', ctx.userId)
    .maybeSingle();

  if (!data?.payload_ciphertext) {
    // An honest "no session yet" — the agent pairs from scratch.
    return NextResponse.json({ ok: true, session: null });
  }

  try {
    const json = decryptSecret({
      ciphertext: data.payload_ciphertext as string,
      iv: data.payload_iv as string,
      auth_tag: data.payload_auth_tag as string,
    });
    return NextResponse.json({
      ok: true,
      session: JSON.parse(json) as Record<string, string>,
      updatedAt: data.updated_at,
    });
  } catch {
    // A key rotation makes old sessions unreadable. Say so; never 500 silently.
    return NextResponse.json({ ok: false, session: null, error: 'session unreadable — re-pair' });
  }
}

export async function POST(request: NextRequest) {
  const ctx = await resolveAgentToken(bearer(request));
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let files: Record<string, string> | null = null;
  try {
    const body = (await request.json()) as { files?: Record<string, string> };
    files = body.files ?? null;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  if (!files || typeof files !== 'object') {
    return NextResponse.json({ error: 'files is required' }, { status: 400 });
  }

  // Guard the store: a runaway session object is a bug, not a use case.
  const keys = Object.keys(files);
  const serialized = JSON.stringify(files);
  if (serialized.length > 512 * 1024) {
    return NextResponse.json({ error: 'session too large' }, { status: 413 });
  }

  const enc = encryptSecret(serialized);
  const admin = createSupabaseAdminClient();

  const { error } = await admin.from('whatsapp_sessions').upsert(
    {
      user_id: ctx.userId,
      payload_ciphertext: enc.ciphertext,
      payload_iv: enc.iv,
      payload_auth_tag: enc.authTag,
      key_count: keys.length,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );

  if (error) return NextResponse.json({ error: 'could not store session' }, { status: 500 });
  return NextResponse.json({ ok: true, stored: keys.length });
}

export async function DELETE(request: NextRequest) {
  const ctx = await resolveAgentToken(bearer(request));
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const admin = createSupabaseAdminClient();
  await admin.from('whatsapp_sessions').delete().eq('user_id', ctx.userId);
  return NextResponse.json({ ok: true });
}
