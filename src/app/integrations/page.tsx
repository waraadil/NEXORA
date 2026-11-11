import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOnboardedUser } from '@/lib/auth/guard';
import { AppShell } from '@/components/app-shell';
import { IntegrationsClient } from './integrations-client';

export const metadata: Metadata = { title: 'Integrations' };

// Auth-gated route: blocking render is intended, so the page never
// prerenders a shell it cannot legitimately produce.
export const instant = false;

export default async function IntegrationsPage() {
  const { user, supabase } = await requireOnboardedUser();

  const { data: integration } = await supabase
    .from('whatsapp_integrations')
    .select('mode, status, display_phone, phone_number_id, bridge_last_seen_at, last_error, risk_acknowledged_at')
    .eq('user_id', user.id)
    .maybeSingle();

  // Count messages by provenance so the user can see what came from where.
  const [{ count: cloudCount }, { count: bridgeCount }] = await Promise.all([
    supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('source', 'whatsapp_cloud'),
    supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('source', 'personal_bridge'),
  ]);

  return (
    <AppShell title="Integrations" subtitle="Connect WhatsApp to NEXORA">
      <IntegrationsClient
        integration={integration ?? null}
        cloudConversations={cloudCount ?? 0}
        bridgeConversations={bridgeCount ?? 0}
        appUrl={process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}
      />
    </AppShell>
  );
}
