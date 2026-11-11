'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { stageImport, commitImport, type ImportState } from './actions';
import { isBlankName } from '@/lib/text/names';

function Submit({ idle, busy, className }: { idle: string; busy: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" isLoading={pending} className={className}>
      {pending ? busy : idle}
    </Button>
  );
}

const RELATIONSHIPS = [
  'Family', 'Close friend', 'Friend', 'Colleague', 'Manager', 'Client',
  'Partner', 'Classmate', 'Acquaintance', 'Other',
];

export function ImportWizard({ onDone }: { onDone?: () => void }) {
  const [stageState, stageAction] = useActionState<ImportState, FormData>(stageImport, null);
  const [commitState, commitAction] = useActionState<ImportState, FormData>(commitImport, null);
  const [contactName, setContactName] = useState('');
  const [needsZip, setNeedsZip] = useState(false);
  // Step 2 must send the file too: the server keeps no draft, because on
  // serverless each request may reach a different instance.
  const [file, setFile] = useState<File | null>(null);

  const batch = stageState && 'batch' in stageState ? stageState.batch : undefined;
  const committed = commitState && 'committed' in commitState ? commitState.committed : undefined;

  // ── Success ──
  if (committed) {
    return (
      <Card className="border-success/30">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Badge tone="success">Imported</Badge>
          </div>
          <CardTitle className="mt-1.5">Conversation saved</CardTitle>
          <CardDescription>
            {committed.inserted} message{committed.inserted === 1 ? '' : 's'} stored
            {committed.duplicates > 0 && `, ${committed.duplicates} duplicate${committed.duplicates === 1 ? '' : 's'} skipped`}
            {committed.errors > 0 && `, ${committed.errors} failed`}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Link href={`/conversations/${committed.conversationId}`}>
            <Button>View conversation</Button>
          </Link>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Import another
          </Button>
        </CardContent>
      </Card>
    );
  }

  // ── Step 2: review ──
  if (batch) {
    const suggested = batch.participants[0]?.displayName || '';
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Review before saving</CardTitle>
            <CardDescription>
              Nothing has been written to your conversations yet. Check the details, then confirm.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
              <div>
                <dt className="text-xs text-muted-foreground">Messages parsed</dt>
                <dd className="text-lg font-semibold tabular-nums">{batch.totalParsed}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Duplicates skipped</dt>
                <dd className="text-lg font-semibold tabular-nums">{batch.duplicates}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Participants</dt>
                <dd className="text-lg font-semibold tabular-nums">{batch.participants.length}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">System lines skipped</dt>
                <dd className="text-lg font-semibold tabular-nums">{batch.systemLines}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Unparsed lines</dt>
                <dd className={`text-lg font-semibold tabular-nums ${batch.issues > 0 ? 'text-warning' : ''}`}>
                  {batch.issues}
                </dd>
              </div>
            </dl>

            <div className="rounded-lg border border-border bg-surface-2 p-3 text-xs">
              <p className="font-medium text-foreground">Your messages</p>
              <p className="mt-0.5 text-muted-foreground">
                {batch.meSource === 'given' && (
                  <>
                    Matched the name you typed: <span className="font-mono">{batch.detectedMe}</span>
                  </>
                )}
                {batch.meSource === 'auto' && (
                  <>
                    Auto-detected. In this export your own messages are labelled{' '}
                    {isBlankName(batch.detectedMe ?? '') ? (
                      <span className="font-medium text-foreground">
                        with a blank name (an invisible character)
                      </span>
                    ) : (
                      <span className="font-mono">{batch.detectedMe}</span>
                    )}
                    . Wrong? Go back and type your name exactly as it appears.
                  </>
                )}
                {batch.meSource === 'none' && 'Not determined — messages will import unattributed.'}
              </p>
            </div>

            <div className="rounded-lg border border-border bg-surface-2 p-3 text-xs">
              <p className="font-medium text-foreground">Detected format</p>
              <p className="mt-0.5 text-muted-foreground">
                {batch.format} · {batch.isGroup ? 'Group chat' : 'Direct chat'}
                {batch.firstDate && batch.lastDate && (
                  <> · {new Date(batch.firstDate).toLocaleDateString()} → {new Date(batch.lastDate).toLocaleDateString()}</>
                )}
              </p>
            </div>

            {batch.participants.length > 0 && (
              <div>
                <p className="mb-2 text-sm font-medium">Participants</p>
                <ul className="space-y-1">
                  {batch.participants.map((p) => (
                    <li key={p.name} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                      <span className="truncate font-medium">
                        {p.displayName || <span className="italic text-muted-foreground">Unnamed sender</span>}
                      </span>
                      <span className="text-xs text-muted-foreground">{p.messageCount} messages</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <p className="mb-2 text-sm font-medium">First messages</p>
              <ul className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-border bg-surface-2 p-3">
                {batch.preview.map((m, i) => (
                  <li key={i} className="text-sm">
                    <span className={`font-medium ${m.isFromMe ? 'text-primary' : 'text-foreground'}`}>
                      {m.isFromMe ? 'You' : m.sender}
                    </span>
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {m.sentAt ? new Date(m.sentAt).toLocaleString() : 'no timestamp'}
                    </span>
                    <p className="text-muted-foreground">{m.body.slice(0, 160)}</p>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Who is this conversation with?</CardTitle>
            <CardDescription>
              Used everywhere in NEXORA. You can edit it later in Contacts.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {commitState && 'error' in commitState && commitState.error && (
              <div role="alert" className="mb-3 rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive">
                {commitState.error}
              </div>
            )}

            <form action={commitAction} className="space-y-3">
              <input type="hidden" name="batchId" value={batch.id} />
              <input type="hidden" name="meName" value={batch.detectedMe ?? ''} />
              <input type="hidden" name="relationship" value={batch.relationshipValue ?? ''} />
              {/*
                Step 2 re-sends the export. A file input cannot be prefilled, so
                it stays visually hidden and the browser's DataTransfer is used
                to attach the File the user picked in step 1.
              */}
              <input
                type="file"
                name="file"
                aria-hidden="true"
                tabIndex={-1}
                className="sr-only"
                ref={(el) => {
                  if (!el || !file) return;
                  if (el.files?.length === 1) return;
                  const dt = new DataTransfer();
                  dt.items.add(file);
                  el.files = dt.files;
                }}
              />
              <Field
                label="Contact name"
                htmlFor="contactName"
                required
                error={commitState && 'fieldErrors' in commitState ? commitState.fieldErrors?.contactName : undefined}
              >
                <Input
                  id="contactName"
                  name="contactName"
                  defaultValue={suggested}
                  onChange={(e) => setContactName(e.target.value)}
                  required
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Submit idle="Confirm & save conversation" busy="Saving…" />
                <Button type="button" variant="ghost" onClick={() => window.location.reload()}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Step 1: upload ──
  return (
    <Card>
      <CardHeader>
        <CardTitle>Import a WhatsApp chat</CardTitle>
        <CardDescription>
          On your phone: open the chat → menu → <span className="font-medium text-foreground">More</span> →{' '}
          <span className="font-medium text-foreground">Export chat</span> →{' '}
          <span className="font-medium text-foreground">Without media</span>. Then upload the
          <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-xs">.txt</code>
          file here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {stageState && 'error' in stageState && stageState.error && (
          <div role="alert" className="mb-3 rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive">
            {stageState.error}
          </div>
        )}

        <form
          action={stageAction}
          className="space-y-4"
          onSubmit={() => setNeedsZip(false)}
        >
          <Field
            label="Export file"
            htmlFor="file"
            required
            hint="Your file is parsed in memory and staged — nothing is saved until you confirm."
            error={stageState && 'fieldErrors' in stageState ? stageState.fieldErrors?.file : undefined}
          >
            <input
              id="file"
              name="file"
              type="file"
              accept=".txt,text/plain"
              required
              onChange={(e) => {
                const picked = e.target.files?.[0] ?? null;
                setNeedsZip(picked?.name?.toLowerCase().endsWith('.zip') ?? false);
                // Keep the file for step 2: the server stores no draft, so the
                // confirmation request must carry the export again.
                setFile(picked);
              }}
              className="block w-full cursor-pointer rounded-lg border border-border-strong bg-surface text-sm file:mr-3 file:cursor-pointer file:border-0 file:bg-primary-subtle file:px-3 file:py-2.5 file:text-sm file:font-medium file:text-primary hover:file:bg-primary/15"
            />
          </Field>

          {needsZip && (
            <div className="rounded-lg border border-warning/40 bg-warning-subtle px-3.5 py-2.5 text-sm text-warning">
              A .zip contains the transcript inside. Extract it first and upload the{' '}
              <code className="font-mono text-xs">_chat.txt</code>.
            </div>
          )}

          <Field
            label="Your name in this export"
            htmlFor="meName"
            hint="Optional. Leave blank and NEXORA works it out — it looks for “You”, your saved name, or a sender whose name is blank/invisible, which is what phones use when someone has no display name."
            error={stageState && 'fieldErrors' in stageState ? stageState.fieldErrors?.meName : undefined}
          >
            <Input id="meName" name="meName" placeholder="Leave blank to auto-detect" />
          </Field>

          <Field label="Relationship" htmlFor="relationship" hint="Helps NEXORA understand how you speak to this person.">
            <Select id="relationship" name="relationship" defaultValue="Friend">
              {RELATIONSHIPS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </Select>
          </Field>

          <Submit idle="Parse & preview" busy="Parsing…" />
        </form>
      </CardContent>
    </Card>
  );
}
