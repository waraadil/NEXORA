import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { syncChat, MAX_BATCH, type InboundChat, type InboundMessage } from '@/lib/whatsapp/relay-sync';
import { planAutoReplies, releaseStaleClaims } from '@/lib/whatsapp/auto-reply';
import { heartbeatRelay } from '@/lib/whatsapp/relay';
import { requireRelay, relayError, readJson } from '../_lib';

/**
 * POST /api/whatsapp/relay/sync
 *
 * The relay pushes a batch of messages from one WhatsApp chat. The response can
 * carry replies to send immediately, so an auto-answer does not have to wait
 * for the relay's next poll.
 */


type Body = {
  chat?: InboundChat;
  messages?: InboundMessage[];
  history?: boolean;
};

type QueuedReply = { id: string; chatId: string; toName: string; body: string };

/**
 * Pull approved, due replies for a conversation and claim them.
 * Claiming is a conditional update on `status = 'approved'`, so when two relay
 * instances race for the same row exactly one of them gets it back.
 */
async function claimDueReplies(userId: string, conversationId: string, toName: string) {
  const admin = createSupabaseAdminClient();
  const claimed: QueuedReply[] = [];

  const { data: due } = await admin
    .from('whatsapp_outbound')
    .select('id, chat_jid, body')
    .eq('user_id', userId)
    .eq('conversation_id', conversationId)
    .eq('status', 'approved')
    .lte('not_before', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(3);

  for (const row of due ?? []) {
    const { data: won } = await admin
      .from('whatsapp_outbound')
      .update({ status: 'queued' })
      .eq('id', row.id)
      .eq('status', 'approved')
      .select('id')
      .maybeSingle();

    if (won) {
      claimed.push({ id: row.id as string, chatId: row.chat_jid as string, toName, body: row.body as string });
    }
  }

  return claimed;
}

export async function POST(request: NextRequest) {
  try {
    const { owner } = await requireRelay(request);
    const body = await readJson<Body>(request);

    if (!body?.chat?.id || !Array.isArray(body.messages)) {
      return NextResponse.json({ error: 'chat.id and messages[] are required' }, { status: 400 });
    }
    if (body.messages.length > MAX_BATCH) {
      return NextResponse.json(
        { error: `send at most ${MAX_BATCH} messages per batch` },
        { status: 413 },
      );
    }

    const result = await syncChat({
      userId: owner.userId,
      integrationId: owner.integrationId,
      chat: body.chat,
      messages: body.messages,
      // A history replay is provenance-tagged differently and never triggers
      // the AI — otherwise linking an account would answer a year-old backlog.
      source: body.history ? 'importer' : 'personal_bridge',
      skipRollup: !!body.history,
    });

    await heartbeatRelay(owner.userId);

    let replies: QueuedReply[] = [];

    if (!body.history && result.inserted > 0 && owner.autoReplyEnabled) {
      await releaseStaleClaims(owner.userId);
      await planAutoReplies({
        userId: owner.userId,
        integrationId: owner.integrationId,
        conversationIds: [result.conversationId],
      });
      replies = await claimDueReplies(owner.userId, result.conversationId, body.chat.name);
    }

    return NextResponse.json({
      ok: true,
      conversationId: result.conversationId,
      inserted: result.inserted,
      duplicates: result.duplicates,
      replies,
    });
  } catch (error) {
    return relayError(error);
  }
}
