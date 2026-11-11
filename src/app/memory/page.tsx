import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOnboardedUser } from '@/lib/auth/guard';
import { AppShell } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { MemoryList } from './memory-client';

export const metadata: Metadata = { title: 'Memory' };

// Auth-gated route: blocking render is intended, so the page never
// prerenders a shell it cannot legitimately produce.
export const instant = false;

const KIND_TONE: Record<string, 'neutral' | 'primary' | 'accent' | 'warning' | 'success'> = {
  fact: 'neutral',
  preference: 'primary',
  event: 'accent',
  topic: 'neutral',
  promise: 'warning',
  relationship: 'success',
};

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;

  const { user, supabase } = await requireOnboardedUser();

  let query = supabase
    .from('memories')
    .select('id, kind, content, provenance, confidence, event_date, created_at, contacts(display_name, id)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(100);

  if (q?.trim()) query = query.ilike('content', `%${q.trim()}%`);

  const { data: memories } = await query;
  const list = memories ?? [];

  const inferred = list.filter((m) => m.provenance !== 'confirmed').length;
  const confirmed = list.length - inferred;

  return (
    <AppShell
      title="Memory"
      subtitle="What NEXORA remembers. Inferred items are marked — never presented as fact."
    >
      <div className="space-y-4">
        <form method="get" className="flex gap-2">
          <label htmlFor="q" className="sr-only">Search memories</label>
          <input
            id="q"
            name="q"
            defaultValue={q ?? ''}
            placeholder="Search memories…"
            className="h-11 w-full rounded-lg border border-border-strong bg-surface px-3 text-sm placeholder:text-muted-foreground/70"
          />
          <button type="submit" className="h-11 shrink-0 rounded-lg border border-border-strong bg-surface px-4 text-sm font-medium hover:bg-muted">
            Search
          </button>
        </form>

        {list.length > 0 && (
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <Badge tone="success">{confirmed} confirmed</Badge>
            <Badge tone="warning">{inferred} inferred</Badge>
          </div>
        )}

        {list.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border-strong bg-surface p-10 text-center">
            <h2 className="text-base font-semibold">Nothing remembered yet</h2>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground text-pretty">
              {q
                ? 'No memory matches that search.'
                : 'Memories are extracted from your conversations. Run extraction from the Assistant page.'}
            </p>
            {!q && (
              <Link href="/assistant" className="mt-4 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline">
                Go to AI Assistant →
              </Link>
            )}
          </div>
        ) : (
          <MemoryList
            memories={list.map((m) => {
              const contact = Array.isArray(m.contacts) ? m.contacts[0] : m.contacts;
              return {
                id: m.id as string,
                kind: m.kind as string,
                content: m.content as string,
                provenance: m.provenance as string,
                confidence: m.confidence as number | string,
                event_date: (m.event_date as string | null) ?? null,
                created_at: m.created_at as string,
                contact: contact
                  ? { id: contact.id as string, display_name: contact.display_name as string }
                  : null,
              };
            })}
          />
        )}
      </div>
    </AppShell>
  );
}
