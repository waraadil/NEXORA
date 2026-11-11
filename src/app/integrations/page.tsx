import type { Metadata } from 'next';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOnboardedUser } from '@/lib/auth/guard';
import { AppShell } from '@/components/app-shell';
import { getAppUrl } from '@/lib/app-url';
import { describeRelay, isRelayLive, revealRelayKey } from '@/lib/whatsapp/relay';
import { IntegrationsClient } from './integrations-client';
import { WhatsappPersonal, type DraftRow } from './whatsapp-personal';

export const metadata: Metadata = { title: 'Integrations' };

// Auth-gated route: blocking render is intended, so the page never
// prerenders a shell it cannot legitimately produce.
export const instant = false;

export default async function IntegrationsPage() {
  const { user, supabase } = await requireOnboardedUser();

  // Explicit column list. `select('*')` breaks the moment a secret-bearing
  // column exists, because those are intentionally not granted to the browser
  // session — which silently downgraded the whole page to "not linked".
  const { data: integration, error: integrationError } = await supabase
    .from('whatsapp_integrations')
    .select(
      [
        'mode',
        'status',
        'display_phone',
        'phone_number_id',
        'bridge_last_seen_at',
        'bridge_device_name',
        'risk_acknowledged_at',
        'bridge_pairing_phone',
        'bridge_pairing_at',
        'bridge_self_jid',
        'bridge_self_number',
        'bridge_self_name',
        'bridge_session_state',
        'last_error',
        'auto_reply_enabled',
        'auto_reply_require_approval',
        'auto_reply_delay_seconds',
        'auto_reply_instructions',
        'auto_reply_paused_at',
        'auto_reply_paused_reason',
      ].join(', '),
    )
    .eq('user_id', user.id)
    .maybeSingle();

  const integrationRow = (integration ?? null) as Record<string, unknown> | null;

  if (integrationError) {
    // Surface it instead of rendering "not linked" over a broken query.
    console.error('integrations query failed:', integrationError.message);
  }

  const { count: cloudCount } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('source', 'whatsapp_cloud');

  // Drafts awaiting approval, with the contact they are addressed to.
  const { data: pending } = await supabase
    .from('whatsapp_outbound')
    .select('id, body, created_at, conversation_id, conversations(title)')
    .eq('user_id', user.id)
    .eq('status', 'awaiting_approval')
    .order('created_at', { ascending: true })
    .limit(10);

  const drafts: DraftRow[] = (pending ?? []).map((row) => {
    const conv = Array.isArray(row.conversations) ? row.conversations[0] : row.conversations;
    return {
      id: row.id as string,
      body: row.body as string,
      toName: (conv?.title as string | undefined) ?? 'a contact',
      createdAt: row.created_at as string,
    };
  });

  const relay = describeRelay(integrationRow);

  // The stored status is a claim; the heartbeat is evidence. If the relay has
  // gone quiet, say so instead of showing a green dot for a dead process.
  const status =
    relay.status === 'live' && !isRelayLive(relay.lastSeenAt)
      ? ('offline' as const)
      : relay.status;

  // The owner's own key, so a refresh never strands a pairing in progress.
  const relayKey = status === 'waiting' ? await revealRelayKey(user.id) : null;

  const view = { ...relay, status, relayKey };

  return (
    <AppShell title="Integrations" subtitle="Connect WhatsApp to NEXORA">
      <div className="space-y-8">
        <section>
          <h2 className="mb-3 text-lg font-semibold">Personal WhatsApp</h2>
          <WhatsappPersonal relay={{ ...view }} drafts={drafts} baseUrl={getAppUrl()} />
        </section>

        <section>
          <h2 className="mb-3 text-lg font-semibold">WhatsApp Business number</h2>
          <IntegrationsClient
            integration={
              integrationRow
                ? {
                    mode: integrationRow.mode as string,
                    status: integrationRow.status as string,
                    display_phone: (integrationRow.display_phone as string | null) ?? null,
                    phone_number_id: (integrationRow.phone_number_id as string | null) ?? null,
                    bridge_last_seen_at: (integrationRow.bridge_last_seen_at as string | null) ?? null,
                    last_error: (integrationRow.last_error as string | null) ?? null,
                    risk_acknowledged_at: (integrationRow.risk_acknowledged_at as string | null) ?? null,
                  }
                : null
            }
            cloudConversations={cloudCount ?? 0}
            appUrl={getAppUrl()}
          />
        </section>
      </div>
    </AppShell>
  );
}
