'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { GoogleIcon } from '@/components/auth/auth-shell';
import { ProviderGate, ProviderDisabledNote } from '@/components/auth/provider-availability';
import { signUpWithEmail, signInWithGoogle, type AuthState } from '../actions';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" isLoading={pending}>
      {pending ? 'Creating account…' : 'Create account'}
    </Button>
  );
}

export function SignupForm() {
  const [state, formAction] = useActionState<AuthState, FormData>(signUpWithEmail, null);

  return (
    <div className="space-y-5">
      {state?.error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive"
        >
          {state.error}
        </div>
      )}

      {state?.success && (
        <div
          role="status"
          className="rounded-lg border border-success/30 bg-success-subtle px-3.5 py-2.5 text-sm text-success"
        >
          {state.success}
        </div>
      )}

      <ProviderGate
        provider="google"
        fallback={<ProviderDisabledNote provider="Google" />}
      >
        <div className="space-y-5">
          <form action={signInWithGoogle}>
            <Button type="submit" variant="outline" size="lg" className="w-full">
              <GoogleIcon />
              Continue with Google
            </Button>
          </form>

          <div className="relative">
            <div className="absolute inset-0 flex items-center" aria-hidden="true">
              <div className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-surface px-3 text-xs uppercase tracking-wider text-muted-foreground">
                or
              </span>
            </div>
          </div>
        </div>
      </ProviderGate>

      <form action={formAction} className="space-y-4">
        <Field label="Name" htmlFor="displayName" hint="Optional — helps personalise your assistant.">
          <Input id="displayName" name="displayName" type="text" autoComplete="name" placeholder="Your name" />
        </Field>

        <Field label="Email" htmlFor="email" required error={state?.fieldErrors?.email}>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@example.com"
            invalid={!!state?.fieldErrors?.email}
          />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          required
          hint="At least 8 characters."
          error={state?.fieldErrors?.password}
        >
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            placeholder="••••••••"
            invalid={!!state?.fieldErrors?.password}
          />
        </Field>

        <Field
          label="Confirm password"
          htmlFor="confirmPassword"
          required
          error={state?.fieldErrors?.confirmPassword}
        >
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            placeholder="••••••••"
            invalid={!!state?.fieldErrors?.confirmPassword}
          />
        </Field>

        <SubmitButton />

        <p className="text-center text-xs text-muted-foreground">
          By creating an account you agree to keep your own AI provider keys secure.
        </p>
      </form>
    </div>
  );
}
