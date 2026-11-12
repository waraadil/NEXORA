import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOnboardedUser } from '@/lib/auth/guard';
import { AppShell } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { setConversationAutoReply, deriveContactStyle } from '../actions';
import { registerFor } from '@/lib/whatsapp/intelligence';

export const metadata: Metadata = { title: 'Conversation' };

// Auth-gated route: blocking render is intended, so the page never
// prerenders a shell it cannot legitimately produce.
export const instant = false;

export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ before?: string }>;
}) {
  const { id } = await params;
  const { before } = await searchParams;

  const { user, supabase } = await requireOnboardedUser();

  const PAGE = 100;

  // Both reads are pinned to the same id and neither needs the other's result,
  // so they are issued together. Serially they cost two round trips before the
  // first pixel can be painted.
  const [convRes, rowsRes] = await Promise.all([
    supabase
      .from('conversations')
      .select(
        'id, title, source, is_group, contact_id, message_count, first_message_at, last_message_at, auto_reply_mode, auto_reply_paused_at, auto_reply_paused_reason, contacts(id, display_name, relationship)',
      )
      .eq('id', id)
      .eq('user_id', user.id) // ownership pinned — a wrong id 404s, never leaks
      .maybeSingle(),
    (() => {
      let query = supabase
        .from('messages')
        .select('id, sender_name, is_from_me, body, sent_at')
        .eq('conversation_id', id)
        .eq('user_id', user.id)
        .order('sent_at', { ascending: false })
        .limit(PAGE);
      if (before) query = query.lt('sent_at', before);
      return query;
    })(),
  ]);

  const conv = convRes.data;
  if (!conv) notFound();

  const rows = rowsRes.data;
  const messages = (rows ?? []).slice().reverse();
  const hasMore = (rows?.length ?? 0) === PAGE;
  const oldest = messages[0]?.sent_at;

  const contactRel = Array.isArray(conv.contacts) ? conv.contacts[0] : conv.contacts;
  const register = registerFor((contactRel as { relationship?: string | null } | null)?.relationship);

  // How the model will address this person: a specific register, and whether it
  // has learned this particular relationship rather than guessing from a
  // profile built somewhere else.
  const { data: contactStyle } = conv.contact_id
    ? await supabase
        .from('contacts')
        .select('communication_style')
        .eq('id', conv.contact_id as string)
        .eq('user_id', user.id)
        .maybeSingle()
    : { data: null };

  return (
    <AppShell
      title={conv.title ?? 'Conversation'}
      subtitle={[
        conv.message_count && `${conv.message_count} messages`,
        contactRel?.relationship,
        conv.first_message_at && `since ${new Date(conv.first_message_at).toLocaleDateString()}`,
      ]
        .filter(Boolean)
        .join(' · ')}
      actions={
        <Link href="/conversations" className="text-sm text-muted-foreground hover:text-foreground">
          ← All conversations
        </Link>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone={conv.source === 'personal_bridge' ? 'warning' : conv.source === 'whatsapp_cloud' ? 'primary' : 'neutral'}>
          {conv.source === 'personal_bridge' ? 'personal bridge' : conv.source === 'whatsapp_cloud' ? 'business number' : 'imported'}
        </Badge>
        {conv.is_group && <Badge tone="neutral">group</Badge>}
        {contactRel && (
          <Link href={`/contacts/${contactRel.id}`} className="text-xs text-primary underline-offset-4 hover:underline">
            View contact
          </Link>
        )}
      </div>

      {/* What the AI thinks this person is to you, and whether it has learned
          how you actually write to them. Stated because a register guessed from
          a global profile is the reason a message to a client once read like a
          message to a partner. */}
      {!conv.is_group && (
        <div className="mb-4 rounded-xl border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">Writing style here</span>
            <Badge tone={register === 'close' ? 'primary' : register === 'formal' ? 'neutral' : 'neutral'}>
              {register}
            </Badge>
            {contactStyle?.communication_style ? (
              <Badge tone="success">learned</Badge>
            ) : (
              <Badge tone="neutral">not learned yet</Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {contactStyle?.communication_style
              ? contactStyle.communication_style
              : register === 'formal'
                ? 'Replies stay plain and courteous until it has seen enough of how you write to this person.'
                : 'Replies follow your overall style until it has seen enough of how you write here.'}
          </p>
          {!contactStyle?.communication_style && (
            <form action={deriveContactStyle} className="mt-2">
              <input type="hidden" name="conversationId" value={conv.id} />
              <Button type="submit" size="sm" variant="outline">
                Learn from this chat
              </Button>
            </form>
          )}
        </div>
      )}

      {/* Who may be answered here. Stated plainly at the top of the person's own
          conversation, because "the AI replies to some people" is only reassuring
          when the user can see which. */}
      {!conv.is_group && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              AI replies to {conv.title ?? 'this person'}:{' '}
              <span className={conv.auto_reply_mode === 'on' ? 'text-primary' : 'text-muted-foreground'}>
                {conv.auto_reply_mode === 'on' ? 'on' : 'off'}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              {conv.auto_reply_paused_at
                ? (conv.auto_reply_paused_reason ?? 'Paused after too many replies in an hour.')
                : conv.auto_reply_mode === 'on'
                  ? 'NEXORA may answer while your phone is away. It never answers first.'
                  : 'NEXORA will never answer them. Nobody is answered unless you allow it here.'}
            </p>
          </div>
          <form action={setConversationAutoReply}>
            <input type="hidden" name="conversationId" value={conv.id} />
            <input type="hidden" name="mode" value={conv.auto_reply_mode === 'on' ? 'off' : 'on'} />
            <Button type="submit" size="sm" variant={conv.auto_reply_mode === 'on' ? 'outline' : 'primary'}>
              {conv.auto_reply_mode === 'on' ? 'Stop replying to them' : 'Allow AI replies'}
            </Button>
          </form>
        </div>
      )}

      {hasMore && oldest && (
        <div className="mb-3 text-center">
          <Link
            href={`/conversations/${id}?before=${encodeURIComponent(oldest)}`}
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            Load earlier messages
          </Link>
        </div>
      )}

      <div className="space-y-2">
        {messages.length === 0 && (
          <p className="rounded-xl border border-dashed border-border-strong bg-surface p-8 text-center text-sm text-muted-foreground">
            No messages in this conversation.
          </p>
        )}

        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const showDate =
            !prev ||
            (m.sent_at && prev.sent_at &&
              new Date(m.sent_at).toDateString() !== new Date(prev.sent_at).toDateString());

          return (
            <div key={m.id}>
              {showDate && m.sent_at && (
                <div className="my-4 flex items-center gap-3">
                  <span className="h-px flex-1 bg-border" />
                  <span className="text-xs font-medium text-muted-foreground">
                    {new Date(m.sent_at).toLocaleDateString(undefined, {
                      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
                    })}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}

              <div className={`flex ${m.is_from_me ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={[
                    'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed sm:max-w-[min(70%,34rem)]',
                    m.is_from_me
                      ? 'rounded-br-sm bg-primary text-primary-foreground'
                      : 'rounded-bl-sm border border-border bg-surface',
                  ].join(' ')}
                >
                  {!m.is_from_me && conv.is_group && (
                    <p className="mb-0.5 text-xs font-semibold text-primary">{m.sender_name}</p>
                  )}
                  <p className="whitespace-pre-wrap break-words text-pretty">{m.body}</p>
                  {m.sent_at && (
                    <p
                      className={[
                        'mt-1 text-[10px]',
                        m.is_from_me ? 'text-primary-foreground/70' : 'text-muted-foreground',
                      ].join(' ')}
                    >
                      {new Date(m.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </AppShell>
  );
}
