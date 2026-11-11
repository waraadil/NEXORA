import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOnboardedUser } from '@/lib/auth/guard';
import { AppShell } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { AssistantClient } from './assistant-client';

export const metadata: Metadata = { title: 'AI Assistant' };

// Auth-gated route: blocking render is intended, so the page never
// prerenders a shell it cannot legitimately produce.
export const instant = false;

export default async function AssistantPage() {
  const { user, supabase } = await requireOnboardedUser();

  const [{ data: credential }, { data: conversations }, { data: integration }, { data: style }] = await Promise.all([
    supabase
      .from('ai_credentials')
      .select('provider, model, status, key_last4')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .eq('status', 'valid')
      .maybeSingle(),
    supabase
      .from('conversations')
      .select('id, title, message_count')
      .eq('user_id', user.id)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(50),
    supabase
      .from('whatsapp_integrations')
      .select('mode, status')
      .eq('user_id', user.id)
      .maybeSingle(),
    supabase
      .from('user_style_profiles')
      .select('tone, formality, confidence, sample_message_count, derived_at')
      .eq('user_id', user.id)
      .maybeSingle(),
  ]);

  // Sending is only offered when a real outbound channel exists. The bridge is
  // import-only by design, so it never counts as a send path.
  const canSend = integration?.status === 'connected' && integration?.mode === 'cloud_api';
  const sendBlockedReason = !integration
    ? 'no WhatsApp channel is connected.'
    : integration.mode === 'personal_bridge'
      ? 'personal bridge mode is import-only and cannot send.'
      : integration.status !== 'connected'
        ? 'the WhatsApp connection is not active.'
        : undefined;

  return (
    <AppShell
      title="AI Assistant"
      subtitle="Draft replies that sound like you — using your own provider key"
    >
      {!credential ? (
        <div className="rounded-xl border border-warning/40 bg-warning-subtle p-5">
          <h2 className="text-sm font-semibold text-warning">No AI provider connected</h2>
          <p className="mt-1 text-sm text-foreground/80 text-pretty">
            Reply generation runs on your own API key — NEXORA has no shared key. Connect a provider
            to enable the assistant.
          </p>
          <Link
            href="/settings/ai"
            className="mt-3 inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground"
          >
            Connect a provider
          </Link>
        </div>
      ) : !conversations || conversations.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-strong bg-surface p-10 text-center">
          <h2 className="text-base font-semibold">Import a conversation first</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground text-pretty">
            The assistant needs real messages to learn from and reply to.
          </p>
          <Link href="/conversations/import" className="mt-4 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline">
            Import a chat →
          </Link>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge tone="success">{credential.provider} · {credential.model}</Badge>
            <span>key ending {credential.key_last4}</span>
            {style && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  style profile from {style.sample_message_count} of your messages
                  {' '}({Math.round(Number(style.confidence) * 100)}% confidence)
                </span>
              </>
            )}
          </div>

          <AssistantClient
            conversations={conversations}
            hasStyleProfile={!!style}
            canSend={canSend}
            sendBlockedReason={sendBlockedReason}
          />
        </div>
      )}
    </AppShell>
  );
}
