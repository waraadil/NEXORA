import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOnboardedUser } from '@/lib/auth/guard';
import { AppShell } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';

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

  const { data: conv } = await supabase
    .from('conversations')
    .select('id, title, source, is_group, message_count, first_message_at, last_message_at, contacts(id, display_name, relationship)')
    .eq('id', id)
    .eq('user_id', user.id) // ownership pinned — a wrong id 404s, never leaks
    .maybeSingle();

  if (!conv) notFound();

  const PAGE = 100;
  let query = supabase
    .from('messages')
    .select('id, sender_name, is_from_me, body, sent_at')
    .eq('conversation_id', id)
    .eq('user_id', user.id)
    .order('sent_at', { ascending: false })
    .limit(PAGE);

  if (before) query = query.lt('sent_at', before);

  const { data: rows } = await query;
  const messages = (rows ?? []).slice().reverse();
  const hasMore = (rows?.length ?? 0) === PAGE;
  const oldest = messages[0]?.sent_at;

  const contactRel = Array.isArray(conv.contacts) ? conv.contacts[0] : conv.contacts;

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
