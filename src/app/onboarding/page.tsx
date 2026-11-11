import type { Metadata } from 'next';
import { connection } from 'next/server';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { NexoraMark } from '@/components/auth/auth-shell';
import { OnboardingWizard } from './wizard';
import { PROVIDER_LIST } from '@/lib/ai/providers';

export const metadata: Metadata = { title: 'Configure your AI' };

// Auth-gated route: blocking render is intended, so the page never
// prerenders a shell it cannot legitimately produce.
export const instant = false;

export default async function OnboardingPage() {
  // Request-bound render (see src/lib/auth/guard.ts for the reasoning).
  await connection();
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, timezone, onboarded_at')
    .eq('id', user.id)
    .maybeSingle();

  if (profile?.onboarded_at) redirect('/dashboard');

  // Never send the ciphertext/key to the client — only whether one exists.
  const { data: creds } = await supabase
    .from('ai_credentials')
    .select('provider, model, status, key_last4')
    .eq('user_id', user.id)
    .eq('status', 'valid')
    .eq('is_active', true);

  const providers = PROVIDER_LIST.map((p) => ({
    id: p.id,
    name: p.name,
    keyPrefixHint: p.keyPrefixHint,
    keyDocsUrl: p.keyDocsUrl,
    requiresBaseUrl: p.requiresBaseUrl ?? false,
    models: p.models.filter((m) => !m.supportsEmbeddings),
  }));

  return (
    <main className="nexora-ambient min-h-dvh px-4 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-8 flex items-center gap-2.5">
          <NexoraMark />
          <span className="text-lg font-semibold tracking-tight">NEXORA</span>
        </div>

        <OnboardingWizard
          providers={providers}
          hasValidCredential={(creds?.length ?? 0) > 0}
          initialName={profile?.display_name ?? ''}
          initialTimezone={profile?.timezone ?? 'UTC'}
          email={user.email ?? ''}
        />
      </div>
    </main>
  );
}
