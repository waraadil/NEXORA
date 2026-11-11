'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { connectCloudApi, disableIntegration, type IntegrationState } from './actions';

function Submit({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" isLoading={pending}>
      {pending ? busy : idle}
    </Button>
  );
}

type Integration = {
  mode: string;
  status: string;
  display_phone: string | null;
  phone_number_id: string | null;
  bridge_last_seen_at: string | null;
  last_error: string | null;
  risk_acknowledged_at: string | null;
};

export function IntegrationsClient({
  integration,
  cloudConversations,
  appUrl,
}: {
  integration: Integration | null;
  cloudConversations: number;
  appUrl: string;
}) {
  const [cloudState, cloudAction] = useActionState<IntegrationState, FormData>(connectCloudApi, null);

  // Only a Cloud API integration is managed from this card; a personal relay is
  // handled by <WhatsappPersonal /> above and must never show a false "Connected".
  const connected = integration?.status === 'connected' && integration.mode === 'cloud_api';

  return (
    <div className="space-y-6">
      {connected && (
        <Card className="border-success/30 bg-success-subtle">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-2.5">
              <Badge tone="success">Connected</Badge>
              <span className="text-sm font-medium">
                Business number {integration!.display_phone}
              </span>
            </div>
            <form action={disableIntegration}>
              <Button type="submit" variant="outline" size="sm">
                Disconnect
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {integration?.last_error && integration?.mode === 'cloud_api' && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive">
          {integration.last_error}
        </div>
      )}

      {/* ── CLOUD API ── */}
      <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>WhatsApp Business Cloud API</CardTitle>
              <CardDescription>
                Official and stable. Works on a dedicated business number that cannot be your
                personal WhatsApp number.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg bg-muted/60 p-3.5 text-sm">
                <p className="font-medium">What this can do</p>
                <ul className="mt-1.5 space-y-1 text-muted-foreground">
                  <li>• Receive messages sent to your business number, in real time</li>
                  <li>• Reply within 24 hours of the contact&apos;s last message</li>
                  <li>• Delivery and read status webhooks</li>
                </ul>
                <p className="mt-3 font-medium">What it cannot do</p>
                <ul className="mt-1.5 space-y-1 text-muted-foreground">
                  <li>• Read your existing personal chats — they are not accessible</li>
                  <li>• Message first with free text (needs a pre-approved template)</li>
                  <li>• Run without Meta Business verification</li>
                </ul>
              </div>

              {cloudState?.error && (
                <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive">
                  {cloudState.error}
                </div>
              )}
              {cloudState?.success && (
                <div role="status" className="rounded-lg border border-success/30 bg-success-subtle px-3.5 py-2.5 text-sm text-success">
                  {cloudState.success}
                </div>
              )}

              <form action={cloudAction} className="space-y-3">
                <Field label="Phone number ID" htmlFor="phoneNumberId" required hint="Meta → WhatsApp → API Setup.">
                  <Input id="phoneNumberId" name="phoneNumberId" placeholder="109876543210987" required />
                </Field>
                <Field label="WhatsApp Business Account ID" htmlFor="wabaId" hint="Optional, for reference.">
                  <Input id="wabaId" name="wabaId" placeholder="1029384756" />
                </Field>
                <Field label="Permanent access token" htmlFor="accessToken" required hint="System user token, not the 24-hour temporary one.">
                  <Input id="accessToken" name="accessToken" type="password" autoComplete="off" required />
                </Field>
                <Field label="App secret" htmlFor="appSecret" required hint="Used to verify webhook signatures.">
                  <Input id="appSecret" name="appSecret" type="password" autoComplete="off" required />
                </Field>

                <div className="rounded-lg border border-border bg-surface-2 p-3 text-xs">
                  <p className="font-medium text-foreground">Webhook URL for Meta</p>
                  <code className="mt-1 block break-all rounded bg-muted px-2 py-1.5 font-mono text-[11px]">
                    {appUrl}/api/whatsapp/webhook
                  </code>
                  <p className="mt-2 text-muted-foreground">
                    Subscribe to the <code className="font-mono">messages</code> field. The verify
                    token is generated when you connect and shown in Settings.
                  </p>
                </div>

                <Submit idle="Verify & connect" busy="Verifying with Meta…" />
              </form>
            </CardContent>
          </Card>

          {cloudConversations > 0 && (
            <p className="text-sm text-muted-foreground">
              {cloudConversations} conversation{cloudConversations === 1 ? '' : 's'} imported from the
              official API.
            </p>
          )}
      </div>
    </div>
  );
}
