'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { updateContact, deleteContact, type ContactState } from './actions';

function Save() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" isLoading={pending}>
      {pending ? 'Saving…' : 'Save changes'}
    </Button>
  );
}

const RELATIONSHIPS = [
  'Family', 'Close friend', 'Friend', 'Colleague', 'Manager', 'Client',
  'Partner', 'Classmate', 'Acquaintance', 'Other',
];

type Contact = {
  id: string;
  display_name: string;
  relationship: string | null;
  relationship_detail: string | null;
  communication_style: string | null;
  personality_notes: string | null;
  is_group: boolean;
};

export function ContactForm({ contact }: { contact: Contact }) {
  const [state, action] = useActionState<ContactState, FormData>(updateContact, null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Relationship intelligence</h2>
          <p className="mt-0.5 text-xs text-muted-foreground text-pretty">
            Everything here is yours to correct. Your edits always win over anything NEXORA inferred.
          </p>
        </div>
      </div>

      {state?.error && (
        <div role="alert" className="mb-3 rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive">
          {state.error}
        </div>
      )}
      {state?.success && (
        <div role="status" className="mb-3 rounded-lg border border-success/30 bg-success-subtle px-3.5 py-2.5 text-sm text-success">
          {state.success}
        </div>
      )}

      <form action={action} className="space-y-4">
        <input type="hidden" name="id" value={contact.id} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="displayName" required error={state?.fieldErrors?.displayName}>
            <Input id="displayName" name="displayName" defaultValue={contact.display_name} required />
          </Field>

          <Field label="Relationship" htmlFor="relationship">
            <Select id="relationship" name="relationship" defaultValue={contact.relationship ?? 'Friend'}>
              {RELATIONSHIPS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label="Relationship detail"
          htmlFor="relationshipDetail"
          hint="e.g. “Sister — we talk daily about family and work.”"
        >
          <Input
            id="relationshipDetail"
            name="relationshipDetail"
            defaultValue={contact.relationship_detail ?? ''}
            placeholder="Anything that gives context"
          />
        </Field>

        <Field
          label="How you communicate with them"
          htmlFor="communicationStyle"
          hint="Short messages? Lots of emoji? Formal? This guides reply generation."
        >
          <Textarea
            id="communicationStyle"
            name="communicationStyle"
            defaultValue={contact.communication_style ?? ''}
            rows={3}
            placeholder="e.g. We speak in short bursts, mostly Hinglish, lots of teasing."
          />
        </Field>

        <Field
          label="Notes about them"
          htmlFor="personalityNotes"
          hint="Verified facts you know — not AI guesses."
        >
          <Textarea
            id="personalityNotes"
            name="personalityNotes"
            defaultValue={contact.personality_notes ?? ''}
            rows={3}
            placeholder="e.g. Works night shifts, has a dog called Bruno, hates phone calls."
          />
        </Field>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <Save />

          {renderDelete()}
        </div>
      </form>

      <div className="mt-4 border-t border-border pt-4">
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          className="text-xs text-destructive underline-offset-4 hover:underline"
        >
          Delete this contact and all its conversations
        </button>

        {confirmDelete && (
          <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive-subtle p-3">
            <p className="text-sm text-destructive">
              This permanently deletes the contact, every conversation, message and memory attached
              to it. This cannot be undone.
            </p>
            <div className="mt-2 flex gap-2">
              <form action={deleteContact.bind(null, contact.id)}>
                <Button type="submit" variant="destructive" size="sm">
                  Yes, delete everything
                </Button>
              </form>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  function renderDelete() {
    return null;
  }
}
