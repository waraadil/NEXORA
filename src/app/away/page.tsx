import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOnboardedUser } from '@/lib/auth/guard';
import { AppShell } from '@/components/app-shell';
import { getAwayStatus } from '@/lib/away/mode';
import { AwayClient } from './away-client';

export const metadata: Metadata = { title: 'Away Mode' };

// Auth-gated route: blocking render is intended, so the page never
// prerenders a shell it cannot legitimately produce.
export const instant = false;
export default async function AwayPage() {
  const { user, supabase } = await requireOnboardedUser();

  const [status, { data: settings }, { data: rules }, { data: logs }, { data: contacts }, { data: conversations }] =
    await Promise.all([
      getAwayStatus(user.id),
      supabase.from('away_settings').select('*').eq('user_id', user.id).maybeSingle(),
      supabase.from('away_rules').select('contact_id, enabled, instructions, allow_auto_reply').eq('user_id', user.id),
      supabase
        .from('away_logs')
        .select('id, action, draft_text, final_text, detail, created_at, contacts(display_name)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(25),
      supabase.from('contacts').select('id, display_name').eq('user_id', user.id).order('display_name'),
      supabase
        .from('conversations')
        .select('id, title')
        .eq('user_id', user.id)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(50),
    ]);

  return (
    <AppShell
      title="Away Mode"
      subtitle="Draft replies while you are unavailable — you approve every send"
    >
      <AwayClient
        status={status}
        settings={settings ?? null}
        rules={rules ?? []}
        logs={logs ?? []}
        contacts={contacts ?? []}
        conversations={conversations ?? []}
      />
    </AppShell>
  );
}
