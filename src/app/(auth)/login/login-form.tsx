'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { GoogleIcon } from '@/components/auth/auth-shell';
import { ProviderGate, ProviderDisabledNote } from '@/components/auth/provider-availability';
import { signInWithEmail, signInWithGoogle, type AuthState } from '../actions';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" isLoading={pending}>
      {pending ? 'Signing in…' : 'Sign in'}
    </Button>
  );
}

export function LoginForm({ initialError }: { initialError?: string }) {
  const [state, formAction] = useActionState<AuthState, FormData>(signInWithEmail, null);

  const error = state?.error ?? initialError;

  return (
    <div className="space-y-5">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive"
        >
          {error}
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
        <Field
          label="Email"
          htmlFor="email"
          required
          error={state?.fieldErrors?.email}
        >
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
          error={state?.fieldErrors?.password}
        >
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            placeholder="••••••••"
            invalid={!!state?.fieldErrors?.password}
          />
        </Field>

        <div className="flex justify-end">
          <Link
            href="/forgot-password"
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Forgot password?
          </Link>
        </div>

        <SubmitButton />
      </form>
    </div>
  );
}
