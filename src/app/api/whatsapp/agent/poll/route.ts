import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import {
  resolveAgentToken,
  upgradeClaimToAgent,
  storePairingCode,
  clearPairingCode,
  wasRevoked,
} from '@/lib/whatsapp/agent-auth';
import { heartbeatRelay, touchRelay } from '@/lib/whatsapp/relay';
import { syncChat, MAX_BATCH, type InboundChat, type InboundMessage } from '@/lib/whatsapp/relay-sync';
import { planAutoReplies, releaseStaleClaims } from '@/lib/whatsapp/auto-reply';

/**
 * POST /api/whatsapp/agent/poll
 *
 * One endpoint the agent calls every few seconds. It is deliberately the only
 * way the agent talks to NEXORA: a poll carries outbound state (messages it
 * received) and pulls back inbound work (replies and codes to show the user).
 *
 * The agent only ever makes OUTBOUND https requests, so it needs no public
 * address, no port forwarding and no inbound firewall rule. That is what makes
 * a hosted always-on agent practical.
 */

function bearer(request: NextRequest): string {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

type PollBody = {
  /** The agent's own view: connecting, awaiting_code, waiting_scan, connected, offline. */
  state?: 'starting' | 'awaiting_code' | 'waiting_scan' | 'connected' | 'offline';
  /** Code WhatsApp issued for the number the user typed in the app. */
  pairingCode?: string | null;
  selfJid?: string | null;
  selfPhone?: string | null;
  selfName?: string | null;
  reason?: string | null;
  /** Messages the agent collected since its last successful poll. */
  messages?: {
    chat: InboundChat;
    messages: InboundMessage[];
    history?: boolean;
  }[];
  /** Results for replies handed out on the previous poll. */
  acks?: { id: string; ok: boolean; providerMessageId?: string; error?: string }[];
};

export async function POST(request: NextRequest) {
  const token = bearer(request);
  const ctx = await resolveAgentToken(token);

  if (!ctx) {
    // Distinguish the two kinds of 401. 'unlinked' means the owner pressed
    // Disconnect and the agent's WhatsApp session must go away. 'unauthorised'
    // means this token is simply unknown here — an expired claim, or a token
    // written a moment after the agent started polling. The agent retries the
    // second case instead of dropping the user's link.
    const revoked = await wasRevoked(token);
    return NextResponse.json(
      revoked
        ? { error: 'unlinked', reason: 'unlinked' }
        : { error: 'invalid or expired agent token', reason: 'unauthorised' },
      { status: 401 },
    );
  }

  let body: PollBody = {};
  try {
    body = (await request.json()) as PollBody;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const { data: integration } = await admin
    .from('whatsapp_integrations')
    .select(
      'id, auto_reply_enabled, auto_reply_require_approval, auto_reply_delay_seconds, status',
    )
    .eq('id', ctx.integrationId)
    .maybeSingle();

  if (!integration) {
    return NextResponse.json({ error: 'integration missing' }, { status: 401 });
  }

  // ── 1. Record what the agent told us about itself ────────────────────────
  if (body.state === 'connected') {
    await touchRelay(ctx.userId, {
      state: 'connected',
      selfJid: body.selfJid ?? undefined,
      selfPhone: body.selfPhone ?? undefined,
      selfName: body.selfName ?? undefined,
      reason: null,
    });
    await clearPairingCode(ctx.userId);
  } else {
    // Still pairing (or dropped). Never claim "connected" from a heartbeat.
    await heartbeatRelay(ctx.userId);
  }

  if (body.pairingCode) await storePairingCode(ctx.userId, body.pairingCode);

  if (body.state === 'offline' && body.reason) {
    await touchRelay(ctx.userId, { reason: body.reason });
  }

  // First successful contact: exchange the one-use claim for a durable token.
  let issuedAgentToken: string | null = null;
  if (ctx.via === 'claim' && body.state === 'connected') {
    issuedAgentToken = await upgradeClaimToAgent(ctx);
  }

  // ── 2. Store the messages it brought us ─────────────────────────────────
  const conversationIds: string[] = [];

  for (const batch of body.messages ?? []) {
    if (!batch?.chat?.id || !Array.isArray(batch.messages)) continue;
    if (batch.messages.length > MAX_BATCH) continue;

    try {
      const result = await syncChat({
        userId: ctx.userId,
        integrationId: ctx.integrationId,
        chat: batch.chat,
        messages: batch.messages,
        source: batch.history ? 'importer' : 'personal_bridge',
        skipRollup: !!batch.history,
      });
      if (!batch.history && result.inserted > 0) conversationIds.push(result.conversationId);
    } catch (e) {
      // Keep going: one malformed chat must not block the rest of the batch.
      console.error('agent sync failed:', (e as Error).message);
    }
  }

  // ── 3. Acknowledge the agent's send results ─────────────────────────────
  for (const ack of body.acks ?? []) {
    if (!ack?.id) continue;
    const now = new Date().toISOString();

    if (ack.ok) {
      const { data: row } = await admin
        .from('whatsapp_outbound')
        .select('id, body, conversation_id')
        .eq('id', ack.id)
        .eq('user_id', ctx.userId)
        .maybeSingle();

      await admin
        .from('whatsapp_outbound')
        .update({
          status: 'sent',
          provider_message_id: ack.providerMessageId ?? null,
          sent_at: now,
          error: null,
        })
        .eq('id', ack.id)
        .eq('user_id', ctx.userId);

      if (row?.conversation_id) {
        const { createHash } = await import('node:crypto');
        await admin.from('messages').upsert(
          {
            user_id: ctx.userId,
            conversation_id: row.conversation_id,
            sender_name: 'You',
            is_from_me: true,
            body: row.body as string,
            sent_at: now,
            message_hash: createHash('sha256')
              .update(`You\u0000${now}\u0000${row.body}`)
              .digest('hex'),
            provider_message_id: ack.providerMessageId ?? null,
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
        .update({ status: 'failed', error: (ack.error ?? 'send failed').slice(0, 500) })
        .eq('id', ack.id)
        .eq('user_id', ctx.userId);
    }
  }

  // ── 4. Generate replies for genuinely new inbound messages ──────────────
  if (conversationIds.length && integration.auto_reply_enabled) {
    await releaseStaleClaims(ctx.userId);
    for (const conversationId of conversationIds) {
      await planAutoReplies({
        userId: ctx.userId,
        integrationId: ctx.integrationId,
        conversationIds: [conversationId],
      });
    }
  }

  // ── 5. Hand back work: replies to send, and the pairing number ──────────
  const replies: { id: string; chatId: string; toName: string; body: string }[] = [];

  const staleCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { data: due } = await admin
    .from('whatsapp_outbound')
    .select('id, chat_jid, body, conversation_id, status, created_at')
    .eq('user_id', ctx.userId)
    .or(
      `and(status.eq.approved,not_before.lte.${new Date().toISOString()}),and(status.eq.queued,created_at.lte.${staleCutoff})`,
    )
    .order('created_at', { ascending: true })
    .limit(10);

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

    let toName = (row.chat_jid as string) ?? '';
    if (row.conversation_id) {
      const { data: conv } = await admin
        .from('conversations')
        .select('title')
        .eq('id', row.conversation_id)
        .eq('user_id', ctx.userId)
        .maybeSingle();
      if (conv?.title) toName = conv.title as string;
    }

    replies.push({
      id: row.id as string,
      chatId: row.chat_jid as string,
      toName,
      body: row.body as string,
    });
  }

  // ── 6. Tell the agent what the user typed in the browser ────────────────
  const { data: pairing } = await admin
    .from('whatsapp_integrations')
    .select('bridge_pairing_phone, auto_reply_enabled, auto_reply_require_approval, auto_reply_delay_seconds')
    .eq('id', ctx.integrationId)
    .maybeSingle();

  return NextResponse.json({
    ok: true,
    agentToken: issuedAgentToken ?? undefined,
    pairingPhone: (pairing?.bridge_pairing_phone as string | null) ?? null,
    replies,
  });
}
