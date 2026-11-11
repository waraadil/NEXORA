'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { AwayStatus } from '@/lib/away/mode';
import {
  saveAwaySettings,
  setContactRule,
  draftAwayReply,
  approveAndSend,
  pauseAwayMode,
  type AwayState,
} from './actions';

function Submit({ idle, busy, variant }: { idle: string; busy: string; variant?: 'primary' | 'outline' | 'destructive' }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" isLoading={pending} variant={variant ?? 'primary'}>
      {pending ? busy : idle}
    </Button>
  );
}

type Settings = {
  enabled: boolean;
  starts_at: string | null;
  ends_at: string | null;
  default_instructions: string | null;
  auto_reply_enabled: boolean;
  require_approval: boolean;
} | null;

type Rule = { contact_id: string; enabled: boolean; instructions: string | null; allow_auto_reply: boolean };
type Log = {
  id: string;
  action: string;
  draft_text: string | null;
  final_text: string | null;
  detail: string | null;
  created_at: string;
  contacts: { display_name: string } | { display_name: string }[] | null;
};
type Option = { id: string; display_name?: string; title?: string };

const toLocalInput = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16) : '');

export function AwayClient({
  status,
  settings,
  rules,
  logs,
  contacts,
  conversations,
}: {
  status: AwayStatus;
  settings: Settings;
  rules: Rule[];
  logs: Log[];
  contacts: Option[];
  conversations: Option[];
}) {
  const [settingsState, settingsAction] = useActionState<AwayState, FormData>(saveAwaySettings, null);
  const [ruleState, ruleAction] = useActionState<AwayState, FormData>(setContactRule, null);
  const [draftState, draftAction] = useActionState<AwayState, FormData>(draftAwayReply, null);
  const [sendState, sendAction] = useActionState<AwayState, FormData>(approveAndSend, null);
  const [editedDraft, setEditedDraft] = useState<string | null>(null);

  const draft = draftState && 'draft' in draftState ? draftState.draft : undefined;
  const ruleFor = (id: string) => rules.find((r) => r.contact_id === id);

  return (
    <div className="space-y-5">
      {/* Status banner */}
      <div
        className={[
          'flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4',
          status.inWindow
            ? 'border-success/40 bg-success-subtle'
            : 'border-border bg-surface',
        ].join(' ')}
      >
        <div className="flex items-center gap-2.5">
          <Badge tone={status.inWindow ? 'success' : 'neutral'}>
            {status.inWindow ? 'Away Mode active' : status.enabled ? 'Scheduled, not active' : 'Off'}
          </Badge>
          <span className="text-sm text-muted-foreground">
            {status.endsAt ? `Until ${new Date(status.endsAt).toLocaleString()}` : 'No end time set'}
          </span>
        </div>
        {status.enabled && (
          <form action={pauseAwayMode}>
            <Button type="submit" variant="destructive" size="sm">
              Pause immediately
            </Button>
          </form>
        )}
      </div>

      {/* Settings */}
      <Card>
        <CardHeader>
          <CardTitle>Availability</CardTitle>
          <CardDescription>
            Away Mode drafts replies for incoming messages. Sends only happen when you approve.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(settingsState && 'error' in settingsState && settingsState.error) && (
            <div role="alert" className="mb-3 rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive">
              {settingsState.error}
            </div>
          )}
          {(settingsState && 'success' in settingsState && settingsState.success) && (
            <div role="status" className="mb-3 rounded-lg border border-success/30 bg-success-subtle px-3.5 py-2.5 text-sm text-success">
              {settingsState.success}
            </div>
          )}

          <form action={settingsAction} className="space-y-4">
            <label className="flex items-center gap-2.5 text-sm">
              <input type="checkbox" name="enabled" defaultChecked={settings?.enabled ?? false} className="size-4 accent-[hsl(var(--primary))]" />
              Enable Away Mode
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Starts" htmlFor="startsAt" hint="Leave blank to start immediately.">
                <Input id="startsAt" name="startsAt" type="datetime-local" defaultValue={toLocalInput(settings?.starts_at ?? null)} />
              </Field>
              <Field
                label="Ends"
                htmlFor="endsAt"
                hint="Leave blank to run until you pause it."
                error={settingsState && 'fieldErrors' in settingsState ? settingsState.fieldErrors?.endsAt : undefined}
              >
                <Input id="endsAt" name="endsAt" type="datetime-local" defaultValue={toLocalInput(settings?.ends_at ?? null)} />
              </Field>
            </div>

            <Field
              label="Default instructions"
              htmlFor="defaultInstructions"
              hint="Applied to every contact unless a per-contact rule overrides it."
            >
              <Textarea
                id="defaultInstructions"
                name="defaultInstructions"
                rows={2}
                defaultValue={settings?.default_instructions ?? ''}
                placeholder="e.g. Tell them I'm travelling and will reply tomorrow evening."
              />
            </Field>

            <div className="space-y-2 rounded-lg border border-border bg-surface-2 p-3">
              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  name="requireApproval"
                  defaultChecked={settings?.require_approval ?? true}
                  className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
                />
                <span>
                  <span className="font-medium">Require my approval before sending</span>
                  <span className="block text-xs text-muted-foreground">
                    Strongly recommended. Turning this off only matters if auto-reply is also enabled.
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  name="autoReplyEnabled"
                  defaultChecked={settings?.auto_reply_enabled ?? false}
                  className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
                />
                <span>
                  <span className="font-medium">Allow auto-reply</span>
                  <span className="block text-xs text-muted-foreground">
                    Requires a per-contact rule too. Still respects WhatsApp&apos;s 24-hour window.
                  </span>
                </span>
              </label>
            </div>

            <Submit idle="Save settings" busy="Saving…" />
          </form>
        </CardContent>
      </Card>

      {/* Per-contact rules */}
      <Card>
        <CardHeader>
          <CardTitle>Per-contact rules</CardTitle>
          <CardDescription>Fine-grained control over who gets a draft while you are away.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(ruleState && 'error' in ruleState && ruleState.error) && (
            <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive">
              {ruleState.error}
            </div>
          )}
          {(ruleState && 'success' in ruleState && ruleState.success) && (
            <div role="status" className="rounded-lg border border-success/30 bg-success-subtle px-3.5 py-2.5 text-sm text-success">
              {ruleState.success}
            </div>
          )}

          {contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No contacts yet. Import a conversation first.</p>
          ) : (
            <>
              {rules.length > 0 && (
                <ul className="space-y-1.5">
                  {rules.map((r) => {
                    const c = contacts.find((x) => x.id === r.contact_id);
                    return (
                      <li key={r.contact_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                        <span className="font-medium">{c?.display_name ?? 'Unknown contact'}</span>
                        <span className="flex items-center gap-1.5">
                          <Badge tone={r.enabled ? 'success' : 'neutral'}>{r.enabled ? 'drafting' : 'excluded'}</Badge>
                          {r.allow_auto_reply && <Badge tone="warning">auto-reply</Badge>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}

              <form action={ruleAction} className="space-y-3 rounded-lg border border-border p-3">
                <Field label="Contact" htmlFor="ruleContact" required>
                  <Select id="ruleContact" name="contactId" required defaultValue={contacts[0]?.id}>
                    {contacts.map((c) => (
                      <option key={c.id} value={c.id}>{c.display_name}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Instructions for this contact" htmlFor="ruleInstructions">
                  <Input id="ruleInstructions" name="instructions" placeholder="e.g. Keep it formal with my manager" />
                </Field>
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="enabled" defaultChecked className="size-4 accent-[hsl(var(--primary))]" />
                    Draft for this contact
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="allowAutoReply" className="size-4 accent-[hsl(var(--primary))]" />
                    Allow auto-reply
                  </label>
                </div>
                <Submit idle="Save rule" busy="Saving…" variant="outline" />
              </form>
            </>
          )}
        </CardContent>
      </Card>

      {/* Draft a reply */}
      <Card>
        <CardHeader>
          <CardTitle>Draft an away reply</CardTitle>
          <CardDescription>
            Generate a draft using your style, then approve, edit, or copy it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(draftState && 'error' in draftState && draftState.error) && (
            <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive">
              {draftState.error}
            </div>
          )}
          {(sendState && 'error' in sendState && sendState.error) && (
            <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive">
              {sendState.error}
            </div>
          )}
          {(sendState && 'success' in sendState && sendState.success) && (
            <div role="status" className="rounded-lg border border-success/30 bg-success-subtle px-3.5 py-2.5 text-sm text-success">
              {sendState.success}
            </div>
          )}

          {conversations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No conversations to draft for yet.</p>
          ) : (
            <form action={draftAction} className="flex flex-wrap items-end gap-2">
              <div className="min-w-48 flex-1">
                <Field label="Conversation" htmlFor="conversationId" required>
                  <Select id="conversationId" name="conversationId" required defaultValue={conversations[0]?.id}>
                    {conversations.map((c) => (
                      <option key={c.id} value={c.id}>{c.title ?? 'Untitled'}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Submit idle="Generate draft" busy="Generating…" />
            </form>
          )}

          {draft && (
            <div className="space-y-3 rounded-lg border border-primary/30 bg-primary-subtle p-3">
              <Textarea
                aria-label="Draft reply"
                value={editedDraft ?? draft.text}
                onChange={(e) => setEditedDraft(e.target.value)}
                rows={3}
              />
              {!draft.canSend && (
                <p className="text-xs text-muted-foreground">{draft.reason}</p>
              )}
              <div className="flex flex-wrap gap-2">
                {draft.canSend && (
                  <form action={sendAction}>
                    <input type="hidden" name="conversationId" value={draft.conversationId} />
                    <input type="hidden" name="logId" value={draft.logId} />
                    <input type="hidden" name="text" value={editedDraft ?? draft.text} />
                    <Submit idle="Approve & send" busy="Sending…" />
                  </form>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => navigator.clipboard.writeText(editedDraft ?? draft.text)}
                >
                  Copy draft
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Activity log */}
      <Card>
        <CardHeader>
          <CardTitle>Activity log</CardTitle>
          <CardDescription>Every draft, approval, send and block, with its reason.</CardDescription>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing logged yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {logs.map((l) => {
                const c = Array.isArray(l.contacts) ? l.contacts[0] : l.contacts;
                return (
                  <li key={l.id} className="py-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        tone={
                          l.action === 'sent' ? 'success'
                          : l.action === 'blocked' || l.action === 'error' ? 'destructive'
                          : l.action === 'approved' ? 'primary'
                          : 'neutral'
                        }
                      >
                        {l.action}
                      </Badge>
                      {c && <span className="font-medium">{c.display_name}</span>}
                      <span className="text-xs text-muted-foreground">
                        {new Date(l.created_at).toLocaleString()}
                      </span>
                    </div>
                    {(l.final_text || l.draft_text) && (
                      <p className="mt-1 text-muted-foreground text-pretty">
                        {l.final_text ?? l.draft_text}
                      </p>
                    )}
                    {l.detail && <p className="mt-0.5 text-xs text-muted-foreground">{l.detail}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
