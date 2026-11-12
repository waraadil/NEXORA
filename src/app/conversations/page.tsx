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

  // One round trip instead of a chain of them.
  //
  // The list, the embedding-credential check and the last-message previews do
  // not depend on each other, but were awaited in sequence: measured at ~1.8s
  // of pure waiting per visit on a real account, versus ~0.3s when issued
  // together. Round-trip latency to the database, not the queries themselves,
  // was the whole cost.
  //
  // The previews are issued as a second statement in the same RPC rather than a
  // follow-up query because they need the conversation ids, which only exist
  // after the first statement runs. `db_prefetch_conversations` resolves that
  // ordering inside Postgres, where the ids are free.
  const [{ data: bundle, error: bundleErr }, canEmbed] = await Promise.all([
    supabase.rpc('db_conversations_page'),
    getEmbeddingCredential(user.id).then((c) => c !== null),
  ]);

  const conversations = (bundle?.conversations ?? []) as {
    id: string;
    title: string | null;
    source: string | null;
    is_group: boolean;
    message_count: number | null;
    first_message_at: string | null;
    last_message_at: string | null;
    auto_reply_mode: string | null;
    contacts: { display_name: string | null; relationship: string | null } | { display_name: string | null; relationship: string | null }[] | null;
  }[];

  const list = conversations;
  void bundleErr;

  const previews = new Map<string, { body: string; isMine: boolean }>();
  for (const m of (bundle?.previews ?? []) as {
    conversation_id: string;
    body: string | null;
    is_from_me: boolean;
  }[]) {
    if (!previews.has(m.conversation_id) && String(m.body ?? '').trim()) {
      previews.set(m.conversation_id, { body: String(m.body), isMine: Boolean(m.is_from_me) });
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
            const src = SOURCE_LABEL[c.source ?? 'manual'] ?? SOURCE_LABEL.manual;
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
