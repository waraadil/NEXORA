import 'server-only';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { getActiveCredentialForUser } from '@/lib/ai/credentials';
import { loadStyleBrief } from '@/lib/ai/intelligence';
import { replyPrompt, renderTranscript, parseJsonResponse } from '@/lib/ai/prompts';
import { callProvider } from '@/lib/ai/credentials';

/**
 * Away Mode.
 *
 * Design constraints that come straight from the spec:
 *  - Never send without explicit authorisation. Every draft is approval-based by
 *    default; auto-reply can only happen if BOTH the global setting and the
 *    per-contact rule allow it.
 *  - Every action is logged to `away_logs` so the user can audit what happened.
 *  - If the AI provider or messaging channel is unavailable, the draft is still
 *    produced and clearly marked as unsent — never silently dropped.
 */

export type AwayStatus = {
  enabled: boolean;
  inWindow: boolean;
  startsAt: string | null;
  endsAt: string | null;
  autoReplyEnabled: boolean;
  requireApproval: boolean;
};

/**
 * `now` is passed in rather than read inside, so this stays a pure function and
 * never trips the framework's unstable-value rule during a prerender pass.
 */
function withinWindow(startsAt: string | null, endsAt: string | null, now: number): boolean {
  if (startsAt && now < new Date(startsAt).getTime()) return false;
  if (endsAt && now > new Date(endsAt).getTime()) return false;
  return true;
}

export async function getAwayStatus(userId: string): Promise<AwayStatus> {
  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from('away_settings')
    .select('enabled, starts_at, ends_at, auto_reply_enabled, require_approval')
    .eq('user_id', userId)
    .maybeSingle();

  if (!data) {
    return {
      enabled: false,
      inWindow: false,
      startsAt: null,
      endsAt: null,
      autoReplyEnabled: false,
      requireApproval: true,
    };
  }

  const startsAt = (data.starts_at as string | null) ?? null;
  const endsAt = (data.ends_at as string | null) ?? null;

  return {
    enabled: !!data.enabled,
    inWindow: !!data.enabled && withinWindow(startsAt, endsAt, Date.now()),
    startsAt,
    endsAt,
    autoReplyEnabled: !!data.auto_reply_enabled,
    requireApproval: data.require_approval !== false,
  };
}

/**
 * Generate an away-mode draft for an incoming message.
 * Called from the webhook ingest path and from the Away Mode page.
 */
export async function generateAwayDraft(params: {
  userId: string;
  conversationId: string;
  contactId: string;
}): Promise<
  | { ok: true; draft: string; logId: string; shouldAutoSend: boolean }
  | { ok: false; reason: 'not_active' | 'rule_disabled' | 'no_credential' | 'ai_error'; message: string }
> {
  const admin = createSupabaseAdminClient();

  const status = await getAwayStatus(params.userId);
  if (!status.inWindow) {
    return { ok: false, reason: 'not_active', message: 'Away Mode is not active right now.' };
  }

  // Per-contact rule gate.
  const { data: rule } = await admin
    .from('away_rules')
    .select('enabled, instructions, allow_auto_reply')
    .eq('user_id', params.userId)
    .eq('contact_id', params.contactId)
    .maybeSingle();

  if (rule && !rule.enabled) {
    return { ok: false, reason: 'rule_disabled', message: 'Away Mode is disabled for this contact.' };
  }

  const cred = await getActiveCredentialForUser(params.userId);
  if (!cred) {
    return { ok: false, reason: 'no_credential', message: 'No AI provider connected.' };
  }

  const { data: conv } = await admin
    .from('conversations')
    .select('title')
    .eq('id', params.conversationId)
    .eq('user_id', params.userId)
    .maybeSingle();

  const { data: msgs } = await admin
    .from('messages')
    .select('sender_name, body, is_from_me, sent_at')
    .eq('user_id', params.userId)
    .eq('conversation_id', params.conversationId)
    .order('sent_at', { ascending: true })
    .limit(60);

  if (!msgs?.length) {
    return { ok: false, reason: 'ai_error', message: 'No messages to reply to.' };
  }

  const { brief, relationship, relationshipDetail } = await loadStyleBrief(params.userId, params.contactId);

  const instructions = [
    rule?.instructions,
    'The user is currently unavailable. Write a short reply that acknowledges their message, ' +
      'sounds like the user, and says they will get back soon. Do not promise a specific time ' +
      'unless the user asked you to.',
  ]
    .filter(Boolean)
    .join(' ');

  try {
    const result = await callProvider(
      cred,
      replyPrompt({
        transcript: renderTranscript(
          msgs.map((m) => ({
            sender: m.sender_name as string,
            body: m.body as string,
            isFromMe: m.is_from_me as boolean,
            sentAt: m.sent_at as string | null,
          })),
          40,
        ),
        contactName: (conv?.title as string) ?? 'them',
        relationship,
        relationshipDetail,
        style: brief,
        userInstructions: instructions,
        count: 1,
      }),
      { temperature: 0.7, maxTokens: 400 },
    );

    const parsed = parseJsonResponse<{ replies: { text: string; angle: string }[] }>(result.text);
    const draft = parsed?.replies?.[0]?.text?.trim();
    if (!draft) {
      return { ok: false, reason: 'ai_error', message: 'The model returned no usable draft.' };
    }

    const { data: log } = await admin
      .from('away_logs')
      .insert({
        user_id: params.userId,
        contact_id: params.contactId,
        action: 'suggested',
        draft_text: draft,
        detail: rule?.instructions ? `instructions: ${rule.instructions}` : null,
      })
      .select('id')
      .single();

    // Auto-send requires BOTH flags — global AND per-contact. Default is approval.
    const shouldAutoSend =
      status.autoReplyEnabled && !status.requireApproval && !!rule?.allow_auto_reply;

    return { ok: true, draft, logId: (log?.id as string) ?? '', shouldAutoSend };
  } catch (e) {
    return { ok: false, reason: 'ai_error', message: (e as Error).message };
  }
}
