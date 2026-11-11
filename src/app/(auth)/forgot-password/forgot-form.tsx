'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { requestPasswordReset, type AuthState } from '../actions';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" isLoading={pending}>
      {pending ? 'Sending…' : 'Send reset link'}
    </Button>
  );
}

export function ForgotPasswordForm() {
  const [state, formAction] = useActionState<AuthState, FormData>(requestPasswordReset, null);

  if (state?.success) {
    return (
      <div
        role="status"
        className="rounded-lg border border-success/30 bg-success-subtle px-4 py-3 text-sm text-success"
      >
        {state.success}
      </div>
    );
  }

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

      <form action={formAction} className="space-y-4">
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
        <SubmitButton />
      </form>
    </div>
  );
}
