import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOnboardedUser } from '@/lib/auth/guard';
import { AppShell } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SearchPanel } from './search-client';
import { getEmbeddingCredential } from '@/lib/ai/semantic';

export const metadata: Metadata = { title: 'Conversations' };

// Auth-gated route: blocking render is intended, so the page never
// prerenders a shell it cannot legitimately produce.
export const instant = false;

// Labels describe *provenance*, not account type — "business" read as though the
// contact were a business, which is wrong for a conversation that arrived via
// a WhatsApp Business number.
const SOURCE_LABEL: Record<
  string,
  { label: string; tone: 'neutral' | 'primary' | 'warning'; title: string }
> = {
  manual: { label: 'imported', tone: 'neutral', title: 'Imported from a chat export' },
  whatsapp_cloud: {
    label: 'live',
    tone: 'primary',
    title: 'Received through your connected WhatsApp Business number',
  },
  personal_bridge: {
    label: 'bridge',
    tone: 'warning',
    title: 'Synced by your self-hosted personal bridge',
  },
  api: { label: 'api', tone: 'neutral', title: 'Added through the API' },
};

export default async function ConversationsPage() {
  const { user, supabase } = await requireOnboardedUser();

  const { data: conversations } = await supabase
    .from('conversations')
    .select(
      'id, title, source, is_group, message_count, first_message_at, last_message_at, auto_reply_mode, contacts(display_name, relationship)',
    )
    .eq('user_id', user.id)
    .order('last_message_at', { ascending: false, nullsFirst: false });

  const list = conversations ?? [];
  const canEmbed = (await getEmbeddingCredential(user.id)) !== null;

  // One extra query gives every row a real last-message preview instead of
  // only a count. Cheap: bounded by the number of listed conversations.
  const previews = new Map<string, { body: string; isMine: boolean }>();
  if (list.length > 0) {
    const { data: lastMsgs } = await supabase
      .from('messages')
      .select('conversation_id, body, is_from_me, sent_at')
      .eq('user_id', user.id)
      .in('conversation_id', list.map((c) => c.id))
      .order('sent_at', { ascending: false })
      .limit(list.length * 4);

    for (const m of lastMsgs ?? []) {
      const key = m.conversation_id as string;
      if (!previews.has(key) && String(m.body ?? '').trim()) {
        previews.set(key, { body: String(m.body), isMine: Boolean(m.is_from_me) });
      }
    }
  }

  return (
    <AppShell
      title="Conversations"
      subtitle={list.length > 0 ? `${list.length} thread${list.length === 1 ? '' : 's'}` : undefined}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <SearchPanel canEmbed={canEmbed} />
        <Link href="/conversations/import">
          <Button>
            <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
            Import chat
          </Button>
        </Link>
        </div>
      }
    >
      {list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-strong bg-surface p-10 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary-subtle">
            <svg className="size-6 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h2 className="text-base font-semibold">No conversations yet</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground text-pretty">
            Import a WhatsApp export to bring your first conversation in. NEXORA needs real
            messages before it can learn how you write.
          </p>
          <div className="mt-4">
            <Link href="/conversations/import">
              <Button>Import your first chat</Button>
            </Link>
          </div>
        </div>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-border bg-surface">
          {list.map((c) => {
            const src = SOURCE_LABEL[c.source] ?? SOURCE_LABEL.manual;
            const contactRel = Array.isArray(c.contacts) ? c.contacts[0] : c.contacts;
            return (
              <li key={c.id} className="border-b border-border last:border-b-0">
                <Link
                  href={`/conversations/${c.id}`}
                  className="flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-muted/60"
                >
                  <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-sm font-semibold text-primary">
                    {(c.title ?? '?').slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{c.title ?? 'Untitled'}</span>
                      {c.is_group && <Badge tone="neutral">group</Badge>}
                      {/* Visible per row so "who does it answer?" is answerable
                          without opening each conversation. */}
                      {!c.is_group && c.auto_reply_mode === 'on' && (
                        <span title="NEXORA may answer this person">
                          <Badge tone="success">AI on</Badge>
                        </span>
                      )}
                      <span title={src.title}>
                        <Badge tone={src.tone}>{src.label}</Badge>
                      </span>
                    </span>
                    {previews.get(c.id) && (
                      <span className="mt-1 block truncate text-sm text-muted-foreground">
                        <span className="text-muted-foreground/70">
                          {previews.get(c.id)!.isMine ? 'You: ' : ''}
                        </span>
                        {previews.get(c.id)!.body}
                      </span>
                    )}
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {c.message_count} messages
                      {contactRel?.relationship && ` · ${contactRel.relationship}`}
                      {c.last_message_at && ` · ${new Date(c.last_message_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}
                    </span>
                  </span>
                  <svg className="mt-2.5 size-4 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </AppShell>
  );
}
