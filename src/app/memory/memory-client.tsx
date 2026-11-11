'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import {
  updateMemory,
  confirmMemory,
  deleteMemory,
  type MemoryState,
} from './actions';

const KINDS = ['fact', 'preference', 'event', 'topic', 'promise', 'relationship'] as const;

type Tone = 'neutral' | 'primary' | 'accent' | 'warning' | 'success';

const KIND_TONE: Record<string, Tone> = {
  fact: 'neutral',
  preference: 'primary',
  event: 'accent',
  topic: 'neutral',
  promise: 'warning',
  relationship: 'success',
};

export type MemoryItem = {
  id: string;
  kind: string;
  content: string;
  provenance: string;
  confidence: number | string;
  event_date: string | null;
  created_at: string;
  contact: { id: string; display_name: string } | null;
};

function Save() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" isLoading={pending}>
      {pending ? 'Saving…' : 'Save'}
    </Button>
  );
}

function Confirm() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ghost" size="sm" className="text-success" isLoading={pending}>
      {pending ? 'Confirming…' : 'Confirm'}
    </Button>
  );
}

function ConfirmDelete() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant="destructive" isLoading={pending}>
      {pending ? 'Deleting…' : 'Yes, delete'}
    </Button>
  );
}

function MemoryRow({ memory }: { memory: MemoryItem }) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const [editState, editAction] = useActionState<MemoryState, FormData>(updateMemory, null);
  const [delState, delAction] = useActionState<MemoryState, FormData>(
    deleteMemory.bind(null, memory.id),
    null,
  );
  const [confirmState, confirmAction] = useActionState<MemoryState, FormData>(
    confirmMemory.bind(null, memory.id),
    null,
  );

  const inferred = memory.provenance !== 'confirmed';

  return (
    <li className="rounded-xl border border-border bg-surface p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={KIND_TONE[memory.kind] ?? 'neutral'}>{memory.kind}</Badge>
        <Badge tone={inferred ? 'warning' : 'success'}>{inferred ? 'inferred' : 'confirmed'}</Badge>
        <span className="text-xs text-muted-foreground">
          {Math.round(Number(memory.confidence) * 100)}% confidence
        </span>
        {memory.contact && (
          <a
            href={`/contacts/${memory.contact.id}`}
            className="text-xs text-primary underline-offset-4 hover:underline"
          >
            {memory.contact.display_name}
          </a>
        )}
        {memory.event_date && (
          <span className="text-xs text-muted-foreground">
            · {new Date(memory.event_date).toLocaleDateString()}
          </span>
        )}
      </div>

      {editing ? (
        <form action={editAction} className="mt-2.5 space-y-3">
          <input type="hidden" name="id" value={memory.id} />
          <Field label="Memory" htmlFor={`content-${memory.id}`} required error={editState?.error}>
            <Textarea
              id={`content-${memory.id}`}
              name="content"
              defaultValue={memory.content}
              rows={3}
              required
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type" htmlFor={`kind-${memory.id}`}>
              <Select id={`kind-${memory.id}`} name="kind" defaultValue={memory.kind}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Provenance"
              htmlFor={`prov-${memory.id}`}
              hint="Confirmed means you verified it yourself."
            >
              <Select id={`prov-${memory.id}`} name="provenance" defaultValue={memory.provenance}>
                <option value="inferred">inferred</option>
                <option value="confirmed">confirmed</option>
              </Select>
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Save />
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className="mt-1.5 text-sm text-pretty">{memory.content}</p>

          {editState?.success && <p className="mt-1 text-xs text-success">{editState.success}</p>}
          {confirmState?.error && <p className="mt-1 text-xs text-destructive">{confirmState.error}</p>}
          {delState?.error && <p className="mt-1 text-xs text-destructive">{delState.error}</p>}

          <div className="mt-2 flex flex-wrap items-center gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            {inferred && (
              <form action={confirmAction}>
                <Confirm />
              </form>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive"
              onClick={() => setConfirmingDelete(true)}
            >
              Delete
            </Button>
          </div>
        </>
      )}

      {confirmingDelete && (
        <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2">
          <p className="text-xs text-destructive">Delete this memory permanently?</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <form action={delAction}>
              <ConfirmDelete />
            </form>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setConfirmingDelete(false)}
            >
              Keep
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function MemoryList({ memories }: { memories: MemoryItem[] }) {
  return (
    <ul className="space-y-1.5">
      {memories.map((m) => (
        <MemoryRow key={m.id} memory={m} />
      ))}
    </ul>
  );
}
