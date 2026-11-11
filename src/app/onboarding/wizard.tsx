'use client';

import { useActionState, useMemo, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { saveAiCredential, completeProfile, type SetupState } from './actions';

type ProviderOption = {
  id: string;
  name: string;
  keyPrefixHint: string;
  keyDocsUrl: string;
  requiresBaseUrl: boolean;
  models: { id: string; label: string }[];
};

function Submit({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" isLoading={pending}>
      {pending ? busy : idle}
    </Button>
  );
}

const STEPS = ['AI provider', 'Test connection', 'Your profile'] as const;

export function OnboardingWizard({
  providers,
  hasValidCredential,
  initialName,
  initialTimezone,
  email,
}: {
  providers: ProviderOption[];
  hasValidCredential: boolean;
  initialName: string;
  initialTimezone: string;
  email: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState(hasValidCredential ? 2 : 0);
  const [providerId, setProviderId] = useState(providers[0]?.id ?? 'openai');
  const [model, setModel] = useState(providers[0]?.models[0]?.id ?? '');
  const [keyVisible, setKeyVisible] = useState(false);

  const provider = useMemo(
    () => providers.find((p) => p.id === providerId) ?? providers[0],
    [providerId, providers],
  );

  const [credState, credAction] = useActionState<SetupState, FormData>(saveAiCredential, null);
  const [profileState, profileAction] = useActionState<SetupState, FormData>(completeProfile, null);

  // Advance to the profile step once a key validates.
  if (credState?.ok && step === 1) {
    setStep(2);
  }

  const timezones = [
    'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo',
    'Europe/London', 'Europe/Berlin', 'Europe/Paris',
    'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'UTC',
  ];

  return (
    <div className="space-y-6">
      {/* Step indicator */}
      <ol className="flex items-center gap-2" aria-label="Onboarding progress">
        {STEPS.map((label, i) => {
          const active = i === step;
          const done = i < step;
          return (
            <li key={label} className="flex flex-1 items-center gap-2">
              <span
                aria-current={active ? 'step' : undefined}
                className={[
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                  done
                    ? 'bg-success text-white'
                    : active
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground',
                ].join(' ')}
              >
                {done ? '✓' : i + 1}
              </span>
              <span
                className={[
                  'hidden text-sm sm:block',
                  active ? 'font-medium text-foreground' : 'text-muted-foreground',
                ].join(' ')}
              >
                {label}
              </span>
              {i < STEPS.length - 1 && <span className="h-px flex-1 bg-border" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>

      <div className="rounded-xl border border-border bg-surface p-6 shadow-[var(--shadow-md)]">
        {/* ── STEP 1 + 2: provider + key ── */}
        {step <= 1 && (
          <div className="space-y-5">
            <div className="space-y-1">
              <h1 className="text-lg font-semibold tracking-tight">Connect your AI provider</h1>
              <p className="text-sm text-muted-foreground text-pretty">
                NEXORA never uses a shared key. Your provider key is validated against{' '}
                {provider?.name ?? 'the provider'} and stored AES-256-GCM encrypted — it never reaches
                the browser again.
              </p>
            </div>

            {credState?.error && (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive"
              >
                {credState.error}
              </div>
            )}

            <form action={credAction} className="space-y-4">
              <input type="hidden" name="provider" value={providerId} />
              <input type="hidden" name="model" value={model} />

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Provider</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {providers.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setProviderId(p.id);
                        setModel(p.models[0]?.id ?? '');
                      }}
                      aria-pressed={providerId === p.id}
                      className={[
                        'flex items-start gap-2.5 rounded-lg border p-3 text-left transition',
                        providerId === p.id
                          ? 'border-primary bg-primary-subtle'
                          : 'border-border-strong hover:border-primary/50 hover:bg-muted/50',
                      ].join(' ')}
                    >
                      <span
                        className={[
                          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2',
                          providerId === p.id ? 'border-primary' : 'border-border-strong',
                        ].join(' ')}
                      >
                        {providerId === p.id && <span className="size-2 rounded-full bg-primary" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{p.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {p.keyPrefixHint}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </fieldset>

              {provider?.models.length > 0 && (
                <Field
                  label="Model"
                  htmlFor="model-select"
                  required
                  hint="You can change this later in Settings."
                >
                  <Select
                    id="model-select"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {provider.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}

              {provider?.requiresBaseUrl && (
                <Field
                  label="Base URL"
                  htmlFor="baseUrl"
                  required
                  hint="e.g. https://api.groq.com/openai/v1"
                >
                  <Input
                    id="baseUrl"
                    name="baseUrl"
                    type="url"
                    placeholder="https://api.example.com/v1"
                    required
                  />
                </Field>
              )}

              {provider?.id === 'openai_compatible' && (
                <Field label="Model id" htmlFor="customModel" required hint="Exactly as your endpoint names it.">
                  <Input
                    id="customModel"
                    name="model"
                    placeholder="llama-3.3-70b-versatile"
                    required
                    defaultValue={model === 'custom' ? '' : model}
                  />
                </Field>
              )}

              <Field
                label="API key"
                htmlFor="apiKey"
                required
                hint={`Get one at ${provider?.keyDocsUrl ?? 'your provider'}.`}
                error={credState?.fieldErrors?.apiKey}
              >
                <div className="flex gap-2">
                  <Input
                    id="apiKey"
                    name="apiKey"
                    type={keyVisible ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    required
                    placeholder={provider?.keyPrefixHint ?? 'Paste your key'}
                    invalid={!!credState?.fieldErrors?.apiKey}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setKeyVisible((v) => !v)}
                    aria-label={keyVisible ? 'Hide API key' : 'Show API key'}
                    aria-pressed={keyVisible}
                  >
                    {keyVisible ? (
                      <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8" strokeLinecap="round" />
                        <path d="M9.4 5.2A9.9 9.9 0 0112 5c5 0 9 4 10 7a12.7 12.7 0 01-3 4.2M6.3 6.9A12.7 12.7 0 002 12c1 3 5 7 10 7a9.9 9.9 0 004.1-.9" strokeLinecap="round" />
                      </svg>
                    ) : (
                      <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </Button>
                </div>
              </Field>

              <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-3.5 py-2.5 text-xs text-muted-foreground">
                <svg className="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <rect x="4" y="10" width="16" height="10" rx="2" />
                  <path d="M8 10V7a4 4 0 118 0v3" strokeLinecap="round" />
                </svg>
                Encrypted at rest · never logged · never sent to your browser
              </div>

              <div className="flex items-center justify-between gap-3 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => router.push('/settings/ai')}
                >
                  Manage later
                </Button>
                <Submit idle="Validate & continue" busy="Validating key…" />
              </div>
            </form>
          </div>
        )}

        {/* ── STEP 3: profile ── */}
        {step === 2 && (
          <div className="space-y-5">
            <div className="flex items-center gap-2">
              <Badge tone="success">
                <svg className="size-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 111.4-1.4l3.8 3.8 6.8-6.8a1 1 0 011.4 0Z" clipRule="evenodd" />
                </svg>
                {credState?.detail ?? 'AI connection validated'}
              </Badge>
            </div>

            <div className="space-y-1">
              <h1 className="text-lg font-semibold tracking-tight">Almost there</h1>
              <p className="text-sm text-muted-foreground">
                How should NEXORA address you?
              </p>
            </div>

            {profileState?.error && (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive"
              >
                {profileState.error}
              </div>
            )}

            <form action={profileAction} className="space-y-4">
              <Field
                label="Display name"
                htmlFor="displayName"
                required
                error={profileState?.fieldErrors?.displayName}
              >
                <Input
                  id="displayName"
                  name="displayName"
                  defaultValue={initialName}
                  placeholder="Your name"
                  required
                  invalid={!!profileState?.fieldErrors?.displayName}
                />
              </Field>

              <Field label="Timezone" htmlFor="timezone" hint="Used for Away Mode schedules.">
                <Select id="timezone" name="timezone" defaultValue={initialTimezone}>
                  {timezones.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </Select>
              </Field>

              <p className="text-xs text-muted-foreground">
                Signed in as <span className="font-medium text-foreground">{email}</span>
              </p>

              <div className="flex justify-end pt-1">
                <Submit idle="Enter NEXORA" busy="Setting up…" />
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
