import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOnboardedUser } from '@/lib/auth/guard';
import { AppShell } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { SettingsClient } from './settings-client';
import { SecurityClient } from './security-client';

export const metadata: Metadata = { title: 'Settings' };

// Auth-gated route: blocking render is intended, so the page never
// prerenders a shell it cannot legitimately produce.
export const instant = false;
export default async function SettingsPage() {
  const { user, supabase } = await requireOnboardedUser();

  const [{ data: profile }, { data: creds }, { data: integration }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user.id).maybeSingle(),
    supabase
      .from('ai_credentials')
      .select('id, provider, model, status, key_last4, last_validated_at, last_error')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
    supabase.from('whatsapp_integrations').select('mode, status, display_phone').eq('user_id', user.id).maybeSingle(),
  ]);

  const providers = (user.app_metadata?.providers as string[] | undefined) ?? [];
  const identities = user.identities?.map((i) => i.provider) ?? [];

  return (
    <AppShell title="Settings" subtitle="Your account, AI provider and data">
      <div className="space-y-6">
        <SettingsClient profile={profile ?? null} email={user.email ?? ''} />

        {/* AI provider summary */}
        <div className="rounded-xl border border-border bg-surface p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">AI provider</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Your key, encrypted at rest. NEXORA never uses a shared key.
              </p>
            </div>
            <Link
              href="/settings/ai"
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Manage →
            </Link>
          </div>

          {creds && creds.length > 0 ? (
            <ul className="mt-3 space-y-1.5">
              {creds.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                  <span className="font-medium">{c.provider}</span>
                  <span className="text-muted-foreground">{c.model}</span>
                  <span className="text-xs text-muted-foreground">·{c.key_last4}</span>
                  <Badge tone={c.status === 'valid' ? 'success' : 'destructive'}>{c.status}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">No provider connected yet.</p>
          )}
        </div>

        {/* Integrations summary */}
        <div className="rounded-xl border border-border bg-surface p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">WhatsApp</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {integration
                  ? `${integration.mode === 'cloud_api' ? 'Business number' : 'Personal bridge'} · ${integration.display_phone ?? 'connected'}`
                  : 'No integration connected'}
              </p>
            </div>
            <Link href="/integrations" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
              Manage →
            </Link>
          </div>
        </div>

        <SecurityClient
          email={user.email ?? ''}
          providers={[...new Set([...providers, ...identities])]}
          createdAt={user.created_at}
        />
      </div>
    </AppShell>
  );
}
