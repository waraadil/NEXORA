import type { Metadata } from 'next';
import { connection } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOnboardedUser } from '@/lib/auth/guard';
import { AppShell } from '@/components/app-shell';
import { getAppUrl } from '@/lib/app-url';
import {
  describeRelay,
  isRelayLive,
  revealRelayKey,
  PAIRING_COLUMNS,
} from '@/lib/whatsapp/relay';
import { IntegrationsClient } from './integrations-client';
import { WhatsappPersonal, type DraftRow } from './whatsapp-personal';

export const metadata: Metadata = { title: 'Integrations' };

// Auth-gated route: blocking render is intended, so the page never
// prerenders a shell it cannot legitimately produce.
export const instant = false;

export default async function IntegrationsPage() {
  // This page must be rendered per-request, not once and reused.
  //
  // The project enables cacheComponents. Without an explicit opt-out, a page
  // that reads the database can still be prerendered, and `router.refresh()` —
  // which the pairing card uses to look for the code the agent is fetching —
  // then re-serves that same prerendered output. The card refreshed 39 times in
  // a row while the code sat in the database, showing "Generating your code…"
  // forever: the exact report of pressing Pair and getting nothing.
  //
  // `connection()` is the supported way to opt a route out of prerendering under
  // cacheComponents; `export const dynamic` is a build error in this setup. The
  // same line already keeps /api/whatsapp/agent/wake honest, for the same reason.
  await connection();

  const { user, supabase } = await requireOnboardedUser();

  // Explicit column list. `select('*')` breaks the moment a secret-bearing
  // column exists, because those are intentionally not granted to the browser
  // session — which silently downgraded the whole page to "not linked".
  const { data: integration, error: integrationError } = await supabase
    .from('whatsapp_integrations')
    .select(PAIRING_COLUMNS)
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

  // Emoji preference lives on the style profile (it is about how the user
  // writes, not how WhatsApp is configured), so it is read separately and
  // merged in here rather than being part of describeRelay's row.
  const { data: stylePrefs } = await supabase
    .from('user_style_profiles')
    .select('emoji_preference')
    .eq('user_id', user.id)
    .maybeSingle();

  const storedEmoji = stylePrefs?.emoji_preference as string | undefined;
  const emojiPreference: 'auto' | 'never' | 'match' =
    storedEmoji === 'never' || storedEmoji === 'match' ? storedEmoji : 'auto';

  // Who the switch would actually speak to. Nearly always nobody, and the
  // panel says so rather than leaving the user to guess.
  const { data: allowed } = await supabase
    .from('conversations')
    .select('id, title')
    .eq('user_id', user.id)
    .eq('auto_reply_mode', 'on')
    .eq('is_group', false)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(20);

  const view = {
    ...relay,
    status,
    relayKey,
    emojiPreference,
    allowedContacts: (allowed ?? []).map((c) => ({ id: c.id as string, title: c.title as string | null })),
  };

  return (
    <AppShell title="Integrations" subtitle="Connect WhatsApp to NEXORA">
      <div className="space-y-8">
        <section>
          <h2 className="mb-3 text-lg font-semibold">Personal WhatsApp</h2>
          <WhatsappPersonal relay={{ ...view }} drafts={drafts} />
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
