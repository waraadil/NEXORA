'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { BRIDGE_RISKS } from '@/lib/whatsapp/bridge-risks';
import {
  connectCloudApi,
  enablePersonalBridge,
  disableIntegration,
  type IntegrationState,
} from './actions';

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
  bridgeConversations,
  appUrl,
}: {
  integration: Integration | null;
  cloudConversations: number;
  bridgeConversations: number;
  appUrl: string;
}) {
  const [tab, setTab] = useState<'cloud' | 'bridge'>('cloud');
  const [cloudState, cloudAction] = useActionState<IntegrationState, FormData>(connectCloudApi, null);
  const [bridgeState, bridgeAction] = useActionState<IntegrationState, FormData>(enablePersonalBridge, null);
  const [copied, setCopied] = useState(false);

  const connected = integration?.status === 'connected';

  return (
    <div className="space-y-6">
      {connected && (
        <Card className="border-success/30 bg-success-subtle">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-2.5">
              <Badge tone="success">Connected</Badge>
              <span className="text-sm font-medium">
                {integration!.mode === 'cloud_api'
                  ? `Business number ${integration!.display_phone}`
                  : 'Personal bridge active'}
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

      {integration?.last_error && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive">
          {integration.last_error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg border border-border bg-surface-2 p-1" role="tablist">
        {(
          [
            { id: 'cloud', label: 'Official — Business number' },
            { id: 'bridge', label: 'Personal — self-hosted bridge' },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={[
              'flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              tab === t.id
                ? 'bg-surface text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── CLOUD API ── */}
      {tab === 'cloud' && (
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
      )}

      {/* ── PERSONAL BRIDGE ── */}
      {tab === 'bridge' && (
        <div className="space-y-4">
          <Card className="border-destructive/40">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Badge tone="destructive">High risk · unofficial</Badge>
              </div>
              <CardTitle className="mt-1">Read this before enabling</CardTitle>
              <CardDescription>
                This path uses your personal WhatsApp account. It is not sanctioned by Meta.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                {BRIDGE_RISKS.map((r) => (
                  <li key={r.key} className="rounded-lg border border-border bg-surface-2 p-3">
                    <p className="text-sm font-medium text-foreground">{r.title}</p>
                    <p className="mt-1 text-sm text-muted-foreground text-pretty">{r.detail}</p>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {bridgeState?.bridgeToken ? (
            <Card className="border-warning/40 bg-warning-subtle">
              <CardHeader>
                <CardTitle className="text-sm">Copy your bridge token now</CardTitle>
                <CardDescription>
                  It is shown once. Store it like a password — anyone with it can write conversations
                  into your account.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <code className="block break-all rounded-lg border border-border bg-surface p-3 font-mono text-xs">
                  {bridgeState.bridgeToken}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  onClick={async () => {
                    await navigator.clipboard.writeText(bridgeState.bridgeToken!);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? 'Copied' : 'Copy token'}
                </Button>
                <div className="rounded-lg border border-border bg-surface p-3 text-xs">
                  <p className="font-medium">Then POST to this endpoint</p>
                  <code className="mt-1 block break-all rounded bg-muted px-2 py-1.5 font-mono text-[11px]">
                    POST {appUrl}/api/whatsapp/bridge/ingest
                  </code>
                  <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed">
{`Authorization: Bearer <token>
{
  "chat": { "id": "919876543210@c.us", "name": "Asha", "isGroup": false },
  "messages": [
    { "id": "ABC123", "fromMe": false,
      "senderName": "Asha", "body": "hey",
      "timestamp": 1762800000 }
  ]
}`}
                  </pre>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Acknowledge every risk to continue</CardTitle>
                <CardDescription>
                  NEXORA hosts the ingest endpoint only. You run the bridge yourself, on your own
                  machine, with your own account.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {bridgeState?.error && (
                  <div role="alert" className="mb-3 rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive">
                    {bridgeState.error}
                  </div>
                )}

                <form action={bridgeAction} className="space-y-4">
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">I understand that…</legend>
                    {BRIDGE_RISKS.map((r) => (
                      <label key={r.key} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border-strong p-3 text-sm hover:bg-muted/50">
                        <input
                          type="checkbox"
                          name="ack"
                          value={r.key}
                          className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
                        />
                        <span>{r.title}</span>
                      </label>
                    ))}
                  </fieldset>

                  <Field
                    label="Type the confirmation phrase"
                    htmlFor="confirm"
                    required
                    hint='Exactly: I understand the risks'
                  >
                    <Input
                      id="confirm"
                      name="confirm"
                      placeholder="I understand the risks"
                      autoComplete="off"
                      required
                    />
                  </Field>

                  <Button
                    type="submit"
                    variant="destructive"
                    className="w-full"
                  >
                    Enable personal bridge
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}

          {bridgeConversations > 0 && (
            <p className="text-sm text-muted-foreground">
              {bridgeConversations} conversation{bridgeConversations === 1 ? '' : 's'} received via the
              bridge. These are tagged <code className="font-mono text-xs">personal_bridge</code> and
              visually distinguished everywhere in the app.
            </p>
          )}

          {integration?.mode === 'personal_bridge' && integration.bridge_last_seen_at && (
            <p className="text-xs text-muted-foreground">
              Bridge last reported in at{' '}
              {new Date(integration.bridge_last_seen_at).toLocaleString()}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
