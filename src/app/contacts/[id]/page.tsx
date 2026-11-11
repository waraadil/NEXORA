import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOnboardedUser } from '@/lib/auth/guard';
import { AppShell } from '@/components/app-shell';
import { ContactForm } from './contact-form';

export const metadata: Metadata = { title: 'Contact' };

// Auth-gated route: blocking render is intended, so the page never
// prerenders a shell it cannot legitimately produce.
export const instant = false;

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const { user, supabase } = await requireOnboardedUser();

  const { data: contact } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!contact) notFound();

  const [{ data: conversations }, { data: memories }] = await Promise.all([
    supabase
      .from('conversations')
      .select('id, title, message_count, last_message_at')
      .eq('user_id', user.id)
      .eq('contact_id', id)
      .order('last_message_at', { ascending: false, nullsFirst: false }),
    supabase
      .from('memories')
      .select('id, kind, content, provenance, confidence, created_at')
      .eq('user_id', user.id)
      .eq('contact_id', id)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  return (
    <AppShell
      title={contact.display_name}
      subtitle={[contact.relationship, contact.phone].filter(Boolean).join(' · ')}
    >
      <div className="space-y-6">
        <ContactForm contact={contact} />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-surface p-4">
            <h2 className="text-sm font-semibold">Conversations</h2>
            {conversations && conversations.length > 0 ? (
              <ul className="mt-2 divide-y divide-border">
                {conversations.map((c) => (
                  <li key={c.id}>
                    <a href={`/conversations/${c.id}`} className="flex items-center justify-between gap-2 py-2 text-sm hover:opacity-80">
                      <span className="truncate">{c.title ?? 'Untitled'}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{c.message_count} msgs</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">No conversations yet.</p>
            )}
          </div>

          <div className="rounded-xl border border-border bg-surface p-4">
            <h2 className="text-sm font-semibold">What NEXORA remembers</h2>
            {memories && memories.length > 0 ? (
              <ul className="mt-2 space-y-2">
                {memories.map((m) => (
                  <li key={m.id} className="rounded-lg bg-surface-2 p-2.5 text-sm">
                    <p className="text-pretty">{m.content}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {m.kind} · {m.provenance === 'confirmed' ? 'confirmed' : 'inferred'} ·{' '}
                      {Math.round(Number(m.confidence) * 100)}% confidence
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                Nothing extracted yet. Memories appear once conversations are analysed.
              </p>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
