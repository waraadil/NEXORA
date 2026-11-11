'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { updateProfile, type SettingsState } from './actions';

function Save() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" isLoading={pending}>
      {pending ? 'Saving…' : 'Save changes'}
    </Button>
  );
}

type Profile = {
  display_name: string | null;
  timezone: string | null;
  email: string | null;
} | null;

const TIMEZONES = [
  'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Karachi', 'Asia/Dhaka',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Australia/Sydney', 'Africa/Nairobi', 'UTC',
];

export function SettingsClient({ profile, email }: { profile: Profile; email: string }) {
  const [state, action] = useActionState<SettingsState, FormData>(updateProfile, null);

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold">Profile</h2>

      {state?.error && (
        <div role="alert" className="mt-3 rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive">
          {state.error}
        </div>
      )}
      {state?.success && (
        <div role="status" className="mt-3 rounded-lg border border-success/30 bg-success-subtle px-3.5 py-2.5 text-sm text-success">
          {state.success}
        </div>
      )}

      <form action={action} className="mt-3 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Display name" htmlFor="displayName" required error={state?.fieldErrors?.displayName}>
            <Input id="displayName" name="displayName" defaultValue={profile?.display_name ?? ''} required />
          </Field>
          <Field label="Email" htmlFor="emailView" hint="Email changes are handled by your sign-in provider.">
            <Input id="emailView" defaultValue={email} disabled readOnly />
          </Field>
        </div>

        <Field label="Timezone" htmlFor="timezone" hint="Used for Away Mode schedules.">
          <Select id="timezone" name="timezone" defaultValue={profile?.timezone ?? 'UTC'}>
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </Select>
        </Field>

        <Save />
      </form>
    </div>
  );
}
