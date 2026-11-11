import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { heartbeatRelay } from '@/lib/whatsapp/relay';
import { requireRelay, relayError, readJson } from '../_lib';

/**
 * POST /api/whatsapp/relay/pending
 *
 * Called by the relay every few seconds. Returns work created inside NEXORA:
 *   • auto-replies the AI wrote and the user approved
 *   • anything the user typed in the app and sent
 * and records a heartbeat so the UI can tell "live" from "the terminal closed".
 */


export async function POST(request: NextRequest) {
  try {
    const { owner } = await requireRelay(request);
    await readJson(request).catch(() => null);

    // Polling for work is not proof of a link. Only `/ping` may change state.
    await heartbeatRelay(owner.userId);

    const admin = createSupabaseAdminClient();

    // Two kinds of work:
    //  • approved and due
    //  • 'queued' but never acknowledged — the relay went offline mid-send. Re-offer
    //    these after a grace period so a dropped connection delays a reply
    //    instead of losing it. The relay sends them from its own phone, so a
    //    duplicate delivery is vanishingly unlikely and the alternative is
    //    silence.
    const staleCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: due } = await admin
      .from('whatsapp_outbound')
      .select('id, chat_jid, body, conversation_id, status, created_at')
      .eq('user_id', owner.userId)
      .or(`and(status.eq.approved,not_before.lte.${new Date().toISOString()}),and(status.eq.queued,created_at.lte.${staleCutoff})`)
      .order('created_at', { ascending: true })
      .limit(10);

    const replies: { id: string; chatId: string; toName: string; body: string }[] = [];

    for (const row of due ?? []) {
      if (row.status === 'approved') {
        const { data: won } = await admin
          .from('whatsapp_outbound')
          .update({ status: 'queued' })
          .eq('id', row.id)
          .eq('status', 'approved')
          .select('id')
          .maybeSingle();
        if (!won) continue;
      }

      // Resolve the display name for the log line the user sees in the terminal.
      let toName = row.chat_jid as string;
      if (row.conversation_id) {
        const { data: conv } = await admin
          .from('conversations')
          .select('title')
          .eq('id', row.conversation_id)
          .eq('user_id', owner.userId)
          .maybeSingle();
        if (conv?.title) toName = conv.title as string;
      }

      replies.push({ id: row.id as string, chatId: row.chat_jid as string, toName, body: row.body as string });
    }

    return NextResponse.json({ ok: true, replies });
  } catch (error) {
    return relayError(error);
  }
}
