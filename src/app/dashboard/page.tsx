import type { Metadata } from 'next';
import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOnboardedUser } from '@/lib/auth/guard';
import { AppShell } from '@/components/app-shell';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const metadata: Metadata = { title: 'Dashboard' };

// Auth-gated route: blocking render is intended, so the page never
// prerenders a shell it cannot legitimately produce.
export const instant = false;

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default async function DashboardPage() {
  const { user, supabase } = await requireOnboardedUser();

  const [
    { count: contacts },
    { count: conversations },
    { count: messages },
    { count: memories },
    { data: profile },
    { data: credential },
    { data: integration },
    { data: recent },
    { data: inferredMemories },
    { data: style },
    { data: away },
  ] = await Promise.all([
    supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
    supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
    supabase.from('messages').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
    supabase.from('memories').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
    supabase.from('profiles').select('display_name, timezone').eq('id', user.id).maybeSingle(),
    supabase
      .from('ai_credentials')
      .select('provider, model, status, key_last4')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .maybeSingle(),
    supabase.from('whatsapp_integrations').select('mode, status').eq('user_id', user.id).maybeSingle(),
    supabase
      .from('conversations')
      .select('id, title, source, message_count, last_message_at, contacts(display_name)')
      .eq('user_id', user.id)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(5),
    supabase
      .from('memories')
      .select('id, kind, content, provenance, confidence, contacts(display_name, id)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(4),
    supabase
      .from('user_style_profiles')
      .select('tone, formality, sample_message_count, confidence')
      .eq('user_id', user.id)
      .maybeSingle(),
    supabase.from('away_settings').select('enabled').eq('user_id', user.id).maybeSingle(),
  ]);

  const name = profile?.display_name || user.email?.split('@')[0] || 'there';
  const isNew = (messages ?? 0) === 0;

  const stats = [
    { label: 'Contacts', value: contacts ?? 0, href: '/contacts' },
    { label: 'Conversations', value: conversations ?? 0, href: '/conversations' },
    { label: 'Messages', value: messages ?? 0, href: '/conversations' },
    { label: 'Memories', value: memories ?? 0, href: '/memory' },
  ];

  // Readiness is derived from real state, never assumed.
  const steps = [
    {
      label: 'AI provider connected',
      done: Boolean(credential && credential.status === 'valid'),
      href: '/settings/ai',
      hint: credential
        ? `${credential.provider} · ${credential.model}`
        : 'Add your own key — there is no shared one.',
    },
    {
      label: 'Conversations imported',
      done: (messages ?? 0) > 0,
      href: '/conversations/import',
      hint: isNew ? 'Import a WhatsApp export to begin.' : `${messages} messages ready.`,
    },
    {
      label: 'Reply style learned',
      done: Boolean(style),
      href: '/assistant',
      hint: style
        ? `${style.tone} · ${style.sample_message_count} samples`
        : 'Derived from your own messages.',
    },
    {
      label: 'WhatsApp channel',
      done: integration?.status === 'connected',
      href: '/integrations',
      hint: integration
        ? `${integration.mode === 'cloud_api' ? 'Business number' : 'Personal bridge (import only)'}`
        : 'Optional — import alone works.',
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <AppShell
      title={`${greeting()}, ${name}`}
      subtitle={
        isNew
          ? 'Bring in your first conversation and NEXORA starts learning how you write.'
          : 'Your conversation intelligence at a glance.'
      }
      actions={
        away?.enabled ? (
          <Link href="/away">
            <Badge tone="warning">Away Mode on</Badge>
          </Link>
        ) : undefined
      }
    >
      <div className="space-y-5">
        {/* Stats */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map((s) => (
            <Link
              key={s.label}
              href={s.href}
              className="group rounded-xl border border-border bg-surface p-4 transition-colors hover:border-primary/40"
            >
              <p className="text-2xl font-semibold tabular-nums tracking-tight">{s.value}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{s.label}</p>
            </Link>
          ))}
        </div>

        {/* Setup checklist — only while incomplete */}
        {doneCount < steps.length && (
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>Set up NEXORA</CardTitle>
                <Badge tone="neutral">
                  {doneCount} of {steps.length} done
                </Badge>
              </div>
              <CardDescription>
                Each step uses real data — nothing here is simulated.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-500"
                  style={{ width: `${(doneCount / steps.length) * 100}%` }}
                />
              </div>
              <ul className="space-y-1">
                {steps.map((s) => (
                  <li key={s.label}>
                    <Link
                      href={s.href}
                      className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted"
                    >
                      <span
                        aria-hidden="true"
                        className={[
                          'flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold',
                          s.done
                            ? 'border-success/40 bg-success-subtle text-success'
                            : 'border-border-strong bg-surface text-muted-foreground',
                        ].join(' ')}
                      >
                        {s.done ? '✓' : ''}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={[
                            'block text-sm',
                            s.done ? 'text-muted-foreground line-through decoration-border-strong' : 'font-medium',
                          ].join(' ')}
                        >
                          {s.label}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">{s.hint}</span>
                      </span>
                      {!s.done && (
                        <svg
                          className="size-4 shrink-0 text-muted-foreground"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          aria-hidden="true"
                        >
                          <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Recent conversations */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">Recent conversations</CardTitle>
                <Link href="/conversations" className="text-xs font-medium text-primary hover:underline">
                  View all
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              {recent && recent.length > 0 ? (
                <ul className="-mx-1">
                  {recent.map((c) => {
                    const contact = Array.isArray(c.contacts) ? c.contacts[0] : c.contacts;
                    const label = contact?.display_name ?? c.title ?? 'Untitled';
                    return (
                      <li key={c.id}>
                        <Link
                          href={`/conversations/${c.id}`}
                          className="flex items-center gap-2.5 rounded-lg px-1 py-2 transition-colors hover:bg-muted"
                        >
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-xs font-semibold text-primary">
                            {label.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{label}</span>
                            <span className="block text-xs text-muted-foreground">
                              {c.message_count} messages
                              {c.last_message_at
                                ? ` · ${new Date(c.last_message_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
                                : ''}
                            </span>
                          </span>
                          {c.source === 'personal_bridge' && <Badge tone="warning">bridge</Badge>}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="py-4 text-center">
                  <p className="text-sm text-muted-foreground">No conversations yet.</p>
                  <Link
                    href="/conversations/import"
                    className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
                  >
                    Import a chat export →
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent memories */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">What NEXORA remembers</CardTitle>
                <Link href="/memory" className="text-xs font-medium text-primary hover:underline">
                  View all
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              {inferredMemories && inferredMemories.length > 0 ? (
                <ul className="space-y-2">
                  {inferredMemories.map((m) => {
                    const contact = Array.isArray(m.contacts) ? m.contacts[0] : m.contacts;
                    return (
                      <li key={m.id} className="rounded-lg border border-border p-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge tone={m.provenance === 'confirmed' ? 'success' : 'warning'}>
                            {m.provenance === 'confirmed' ? 'confirmed' : 'inferred'}
                          </Badge>
                          {contact && (
                            <span className="text-xs text-muted-foreground">{contact.display_name}</span>
                          )}
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm text-pretty">{m.content}</p>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="py-4 text-center">
                  <p className="text-sm text-muted-foreground">Nothing remembered yet.</p>
                  <Link
                    href="/assistant"
                    className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
                  >
                    Extract memories →
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Provider strip */}
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-2 px-4 py-3">
          {credential ? (
            <>
              <Badge tone="success">AI connected</Badge>
              <span className="text-xs text-muted-foreground">
                {credential.provider} · {credential.model} · key ····{credential.key_last4}
              </span>
            </>
          ) : (
            <>
              <Badge tone="warning">No AI provider</Badge>
              <span className="text-xs text-muted-foreground">
                Reply drafting and memory extraction stay disabled until you add a key.
              </span>
            </>
          )}
          <Link
            href="/settings/ai"
            className="ml-auto text-xs font-medium text-primary hover:underline"
          >
            {credential ? 'Manage' : 'Connect'} →
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
