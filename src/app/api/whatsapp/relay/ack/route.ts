import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { requireRelay, relayError, readJson } from '../_lib';

/**
 * POST /api/whatsapp/relay/ack
 *
 * The relay reports what happened to a queued reply. Stored exactly as
 * reported: a send that failed is recorded as failed with its error, never
 * quietly marked sent.
 */


type AckBody = {
  id?: string;
  ok?: boolean;
  providerMessageId?: string | null;
  error?: string | null;
};

export async function POST(request: NextRequest) {
  try {
    const { owner } = await requireRelay(request);
    const body = await readJson<AckBody>(request);

    if (!body?.id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    const admin = createSupabaseAdminClient();
    const now = new Date().toISOString();

    // Ownership is part of the filter: a relay can only acknowledge its own rows.
    const { data: row, error: readErr } = await admin
      .from('whatsapp_outbound')
      .select('id, body, conversation_id, channel')
      .eq('id', body.id)
      .eq('user_id', owner.userId)
      .maybeSingle();

    if (readErr || !row) {
      return NextResponse.json({ error: 'unknown outbound message' }, { status: 404 });
    }

    if (body.ok) {
      await admin
        .from('whatsapp_outbound')
        .update({
          status: 'sent',
          provider_message_id: body.providerMessageId ?? null,
          sent_at: now,
          error: null,
        })
        .eq('id', row.id)
        .eq('user_id', owner.userId);

      // Mirror it into the thread so the conversation shows what was actually
      // sent. The relay reports the provider id WhatsApp assigned.
      if (row.conversation_id) {
        const { createHash } = await import('node:crypto');
        const sentAt = now;
        const hash = createHash('sha256')
          .update(`You\u0000${sentAt}\u0000${row.body}`)
          .digest('hex');

        await admin.from('messages').upsert(
          {
            user_id: owner.userId,
            conversation_id: row.conversation_id,
            sender_name: 'You',
            is_from_me: true,
            body: row.body as string,
            sent_at: sentAt,
            message_hash: hash,
            provider_message_id: body.providerMessageId ?? null,
            direction: 'outbound',
            wa_status: 'sent',
            auto_reply_state: null,
          },
          { onConflict: 'conversation_id,message_hash', ignoreDuplicates: true },
        );
      }
    } else {
      await admin
        .from('whatsapp_outbound')
        .update({
          status: 'failed',
          error: (body.error ?? 'send failed').slice(0, 500),
        })
        .eq('id', row.id)
        .eq('user_id', owner.userId);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return relayError(error);
  }
}
