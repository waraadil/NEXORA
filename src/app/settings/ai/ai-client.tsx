'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { saveAiCredential, deleteCredential, testCredential, type SettingsState } from '../actions';

function Save() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" isLoading={pending}>
      {pending ? 'Validating with provider…' : 'Validate & save'}
    </Button>
  );
}

function TestButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" size="sm" isLoading={pending}>
      {pending ? 'Testing…' : 'Test connection'}
    </Button>
  );
}

function RemoveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ghost" size="sm" className="text-destructive" isLoading={pending}>
      {pending ? 'Removing…' : 'Remove'}
    </Button>
  );
}

type Credential = {
  id: string;
  provider: string;
  model: string;
  status: string;
  key_last4: string;
  last_validated_at: string | null;
  last_error: string | null;
  is_active: boolean;
  base_url: string | null;
};

type Provider = {
  id: string;
  name: string;
  keyPrefixHint: string;
  keyDocsUrl: string;
  requiresBaseUrl: boolean;
  models: { id: string; label: string }[];
};

const STATUS_LABEL: Record<string, string> = {
  valid: 'verified',
  invalid: 'invalid key',
  quota_exhausted: 'out of quota',
  rate_limited: 'rate limited',
  error: 'error',
  pending: 'not tested',
};

function CredentialRow({ credential }: { credential: Credential }) {
  const [testState, testAction] = useActionState<SettingsState, FormData>(
    testCredential.bind(null, credential.id),
    null,
  );
  const [removeState, removeAction] = useActionState<SettingsState, FormData>(
    deleteCredential.bind(null, credential.id),
    null,
  );

  const tone =
    credential.status === 'valid'
      ? 'success'
      : credential.status === 'rate_limited' || credential.status === 'pending'
        ? 'neutral'
        : 'destructive';

  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{credential.provider}</span>
        <span className="text-sm text-muted-foreground">{credential.model}</span>
        {credential.is_active && <Badge tone="primary">active</Badge>}
        <span className="font-mono text-xs text-muted-foreground">···{credential.key_last4}</span>
        <Badge tone={tone}>{STATUS_LABEL[credential.status] ?? credential.status}</Badge>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">
        {credential.last_validated_at
          ? `Last checked ${new Date(credential.last_validated_at).toLocaleString()}`
          : 'Never checked'}
        {credential.base_url ? ` · ${credential.base_url}` : ''}
      </p>

      {credential.last_error && !testState?.success && (
        <p className="mt-1 text-xs text-destructive">{credential.last_error}</p>
      )}
      {testState?.success && <p className="mt-1 text-xs text-success">{testState.success}</p>}
      {testState?.error && <p className="mt-1 text-xs text-destructive">{testState.error}</p>}
      {removeState?.error && <p className="mt-1 text-xs text-destructive">{removeState.error}</p>}

      <div className="mt-2 flex flex-wrap gap-2">
        <form action={testAction}>
          <TestButton />
        </form>
        <form action={removeAction}>
          <RemoveButton />
        </form>
      </div>
    </li>
  );
}

export function AiClient({ credentials, providers }: { credentials: Credential[]; providers: Provider[] }) {
  const [state, action] = useActionState<SettingsState, FormData>(saveAiCredential, null);
  const [providerId, setProviderId] = useState(credentials.find((c) => c.is_active)?.provider ?? providers[0]?.id ?? 'openai');
  const [showKey, setShowKey] = useState(false);

  const provider = providers.find((p) => p.id === providerId) ?? providers[0];

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Connected credentials</CardTitle>
          <CardDescription>
            Keys are encrypted with AES-256-GCM using a server-held master key. The browser and the
            database only ever see ciphertext and the last four characters.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {credentials.length === 0 ? (
            <p className="text-sm text-muted-foreground">No credentials yet — add one below.</p>
          ) : (
            <ul className="space-y-2">
              {credentials.map((c) => (
                <CredentialRow key={c.id} credential={c} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add or replace a provider</CardTitle>
          <CardDescription>
            NEXORA makes a real, cheap call to the provider to prove the key works before storing it.
            It never bills you for a shared key — there isn&apos;t one.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {state?.error && (
            <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive">
              {state.error}
            </div>
          )}
          {state?.success && (
            <div role="status" className="rounded-lg border border-success/30 bg-success-subtle px-3.5 py-2.5 text-sm text-success">
              {state.success}
            </div>
          )}

          <form action={action} className="space-y-3">
            <Field label="Provider" htmlFor="providerSelect" required>
              <Select
                id="providerSelect"
                name="provider"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            </Field>

            {provider && !provider.requiresBaseUrl && provider.models.length > 0 && (
              <Field label="Model" htmlFor="modelSelect" required>
                <Select id="modelSelect" name="model" defaultValue={provider.models[0]?.id} key={provider.id}>
                  {provider.models.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </Select>
              </Field>
            )}

            {provider?.requiresBaseUrl && (
              <>
                <Field
                  label="Base URL"
                  htmlFor="baseUrl"
                  required
                  hint="Any OpenAI-compatible endpoint: Groq, Together, OpenRouter, LM Studio, vLLM, Ollama."
                  error={state?.fieldErrors?.baseUrl}
                >
                  <Input id="baseUrl" name="baseUrl" type="url" placeholder="https://api.groq.com/openai/v1" required />
                </Field>
                <Field
                  label="Model id"
                  htmlFor="customModel"
                  required
                  hint="Exactly as your endpoint names it, e.g. llama-3.3-70b-versatile."
                  error={state?.fieldErrors?.model}
                >
                  <Input id="customModel" name="model" placeholder="llama-3.3-70b-versatile" required />
                </Field>
              </>
            )}

            <Field
              label="API key"
              htmlFor="apiKey"
              required
              hint={`Create one at ${provider?.keyDocsUrl ?? 'your provider'}. It is sent once, validated, encrypted, then discarded from memory.`}
              error={state?.fieldErrors?.apiKey}
            >
              <div className="flex gap-2">
                <Input
                  id="apiKey"
                  name="apiKey"
                  type={showKey ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  required
                  placeholder={provider?.keyPrefixHint ?? 'Paste your key'}
                  invalid={!!state?.fieldErrors?.apiKey}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? 'Hide API key' : 'Show API key'}
                  aria-pressed={showKey}
                >
                  {showKey ? '🙈' : '👁'}
                </Button>
              </div>
            </Field>

            <Save />
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
