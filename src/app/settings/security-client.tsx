'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { updatePassword } from '@/app/(auth)/actions';
import { deleteAccount, type SettingsState } from './actions';

function Change() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" isLoading={pending}>
      {pending ? 'Updating…' : 'Update password'}
    </Button>
  );
}

function Delete() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="destructive" isLoading={pending}>
      {pending ? 'Deleting…' : 'Permanently delete account'}
    </Button>
  );
}

export function SecurityClient({
  email,
  providers,
  createdAt,
}: {
  email: string;
  providers: string[];
  createdAt: string;
}) {
  const [pwState, pwAction] = useActionState(updatePassword, null);
  const [delState, delAction] = useActionState<SettingsState, FormData>(deleteAccount, null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <>
      <div className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold">Sign-in &amp; security</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{email}</span> · member since{' '}
          {new Date(createdAt).toLocaleDateString()}
        </p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {providers.length > 0 ? (
            providers.map((p) => <Badge key={p} tone="neutral">{p}</Badge>)
          ) : (
            <Badge tone="neutral">email</Badge>
          )}
        </div>

        <div className="mt-5 border-t border-border pt-4">
          <h3 className="text-sm font-medium">Change password</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Only applies if you sign in with email. Google accounts manage their password with Google.
          </p>

          {pwState?.error && (
            <div role="alert" className="mt-2 rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive">
              {pwState.error}
            </div>
          )}
          {pwState?.success && (
            <div role="status" className="mt-2 rounded-lg border border-success/30 bg-success-subtle px-3 py-2 text-sm text-success">
              {pwState.success}
            </div>
          )}

          <form action={pwAction} className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="New password" htmlFor="newPassword" required error={pwState?.fieldErrors?.password}>
                <Input id="newPassword" name="password" type="password" autoComplete="new-password" minLength={8} required />
              </Field>
              <Field label="Confirm password" htmlFor="confirmNew" required error={pwState?.fieldErrors?.confirmPassword}>
                <Input id="confirmNew" name="confirmPassword" type="password" autoComplete="new-password" required />
              </Field>
            </div>
            <Change />
          </form>
        </div>
      </div>

      <div className="rounded-xl border border-destructive/30 bg-surface p-5">
        <h2 className="text-sm font-semibold text-destructive">Delete account</h2>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          Permanently deletes your account and everything attached to it: contacts, conversations,
          messages, memories, AI credentials and WhatsApp integrations. This cascades through the
          database and cannot be undone.
        </p>

        {delState?.error && (
          <div role="alert" className="mt-3 rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive">
            {delState.error}
          </div>
        )}

        {!confirmDelete ? (
          <Button
            type="button"
            variant="outline"
            className="mt-3 border-destructive/40 text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            I want to delete my account
          </Button>
        ) : (
          <form action={delAction} className="mt-3 space-y-3">
            <Field
              label="Type DELETE MY ACCOUNT to confirm"
              htmlFor="confirm"
              required
              error={delState?.fieldErrors?.confirm}
            >
              <Input id="confirm" name="confirm" placeholder="DELETE MY ACCOUNT" autoComplete="off" required />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Delete />
              <Button type="button" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
