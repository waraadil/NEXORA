import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOnboardedUser } from '@/lib/auth/guard';
import { AppShell } from '@/components/app-shell';
import { PROVIDER_LIST } from '@/lib/ai/providers';
import { AiClient } from './ai-client';

export const metadata: Metadata = { title: 'AI provider' };

// Auth-gated route: blocking render is intended, so the page never
// prerenders a shell it cannot legitimately produce.
export const instant = false;
export default async function AiSettingsPage() {
  const { user, supabase } = await requireOnboardedUser();

  const { data: creds } = await supabase
    .from('ai_credentials')
    .select('id, provider, model, status, key_last4, last_validated_at, last_error, is_active, base_url')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  const providers = PROVIDER_LIST.map((p) => ({
    id: p.id,
    name: p.name,
    keyPrefixHint: p.keyPrefixHint,
    keyDocsUrl: p.keyDocsUrl,
    requiresBaseUrl: p.requiresBaseUrl ?? false,
    models: p.models,
  }));

  return (
    <AppShell title="AI provider" subtitle="Your key, your provider, your cost">
      <AiClient credentials={creds ?? []} providers={providers} />
    </AppShell>
  );
}
