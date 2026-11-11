import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOnboardedUser } from '@/lib/auth/guard';
import { AppShell } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';

export const metadata: Metadata = { title: 'Contacts' };

// Auth-gated route: blocking render is intended, so the page never
// prerenders a shell it cannot legitimately produce.
export const instant = false;

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;

  const { user, supabase } = await requireOnboardedUser();

  let query = supabase
    .from('contacts')
    .select('id, display_name, relationship, phone, is_group, last_interaction_at, conversations(message_count)')
    .eq('user_id', user.id)
    .order('last_interaction_at', { ascending: false, nullsFirst: false });

  if (q?.trim()) query = query.ilike('display_name', `%${q.trim()}%`);

  const { data: contacts } = await query;
  const list = contacts ?? [];

  return (
    <AppShell
      title="Contacts"
      subtitle={list.length > 0 ? `${list.length} contact${list.length === 1 ? '' : 's'}` : undefined}
    >
      <div className="space-y-4">
        <form method="get" className="flex gap-2">
          <label htmlFor="q" className="sr-only">Search contacts</label>
          <input
            id="q"
            name="q"
            defaultValue={q ?? ''}
            placeholder="Search by name…"
            className="h-11 w-full rounded-lg border border-border-strong bg-surface px-3 text-sm placeholder:text-muted-foreground/70"
          />
          <button
            type="submit"
            className="h-11 shrink-0 rounded-lg border border-border-strong bg-surface px-4 text-sm font-medium hover:bg-muted"
          >
            Search
          </button>
        </form>

        {list.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border-strong bg-surface p-10 text-center">
            <h2 className="text-base font-semibold">No contacts yet</h2>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground text-pretty">
              {q
                ? 'No contact matches that search.'
                : 'Contacts are created when you import a conversation or receive a message.'}
            </p>
            {!q && (
              <Link href="/conversations/import" className="mt-4 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline">
                Import a conversation →
              </Link>
            )}
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {list.map((c) => {
              const convs = Array.isArray(c.conversations) ? c.conversations : [];
              const msgs = convs.reduce((sum, x) => sum + (x.message_count ?? 0), 0);
              return (
                <li key={c.id}>
                  <Link
                    href={`/contacts/${c.id}`}
                    className="flex h-full items-start gap-3 rounded-xl border border-border bg-surface p-4 transition-colors hover:border-primary/40"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-sm font-semibold text-primary">
                      {c.display_name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{c.display_name}</span>
                        {c.is_group && <Badge tone="neutral">group</Badge>}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {c.relationship ?? 'Relationship not set'}
                        {msgs > 0 && ` · ${msgs} messages`}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </AppShell>
  );
}
