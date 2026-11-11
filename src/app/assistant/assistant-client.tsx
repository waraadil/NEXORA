'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  draftReplies,
  refreshStyleProfile,
  runMemoryExtraction,
  sendApprovedReply,
  type AssistantState,
  type SendState,
} from './actions';
import { Badge } from '@/components/ui/badge';

function Submit({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" isLoading={pending}>
      {pending ? busy : idle}
    </Button>
  );
}

type Conversation = { id: string; title: string | null; message_count: number };

export function AssistantClient({
  conversations,
  hasStyleProfile,
  canSend,
  sendBlockedReason,
}: {
  conversations: Conversation[];
  hasStyleProfile: boolean;
  canSend: boolean;
  sendBlockedReason?: string;
}) {
  const [state, action] = useActionState<AssistantState, FormData>(draftReplies, null);
  const [styleState, styleAction] = useActionState<AssistantState, FormData>(refreshStyleProfile, null);
  const [memState, memAction] = useActionState<AssistantState, FormData>(runMemoryExtraction, null);
  const [copied, setCopied] = useState<number | null>(null);
  const [draftConversationId, setDraftConversationId] = useState<string>(
    conversations[0]?.id ?? '',
  );
  const [sendState, sendAction] = useActionState<SendState, FormData>(sendApprovedReply, null);
  const [sendIndex, setSendIndex] = useState<number | null>(null);
  const [edited, setEdited] = useState<Record<number, string>>({});
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const replies = state && 'replies' in state ? state.replies : undefined;

  // After the action returns, the page is revalidated and this component is
  // remounted, so local state falls back to the first conversation while the
  // drafts on screen belong to a different one. Derive the shown value instead
  // of storing it: if the action reported which conversation it used, that is
  // the truth, and the control must never contradict the drafts underneath it.
  const usedConversationId = state && 'conversationId' in state ? state.conversationId : undefined;
  const shownConversationId =
    usedConversationId && conversations.some((c) => c.id === usedConversationId)
      ? usedConversationId
      : draftConversationId;
  const error = state && 'error' in state ? state.error : undefined;
  const notice =
    (styleState && 'notice' in styleState ? styleState.notice : undefined) ??
    (memState && 'notice' in memState ? memState.notice : undefined);

  return (
    <div className="space-y-5">
      {notice && (
        <div role="status" className="rounded-lg border border-success/30 bg-success-subtle px-3.5 py-2.5 text-sm text-success">
          {notice}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Draft a reply</CardTitle>
          <CardDescription>
            Generated from the real conversation plus your style profile. Nothing is sent
            automatically — you review, edit, then copy or send.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3.5 py-2.5 text-sm text-destructive">
              {error}
            </div>
          )}

          <form action={action} className="space-y-3">
            <Field label="Conversation" htmlFor="conversationId" required>
              <Select
                id="conversationId"
                name="conversationId"
                required
                // Controlled: after the server action re-renders, an
                // uncontrolled select snapped back to the first conversation
                // while the drafts below it belonged to the one the user
                // actually picked. The visible selection must always match the
                // drafts on screen.
                // React 19 resets the form's fields once the action resolves.
                // A `value` prop alone did not survive that reset: component
                // state held the right conversation while the DOM snapped back
                // to the first option, so the selector disagreed with the
                // drafts below it. Keying the select on the effective value
                // rebuilds it with a matching default, so the reset and the
                // render agree.
                key={shownConversationId}
                defaultValue={shownConversationId}
                onChange={(e) => setDraftConversationId(e.target.value)}
              >
                {conversations.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title ?? 'Untitled'} — {c.message_count} messages
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="What should the reply do?"
              htmlFor="instructions"
              hint="Optional. e.g. “decline politely but keep the door open”."
            >
              <Textarea
                id="instructions"
                name="instructions"
                rows={2}
                defaultValue={state && 'instructions' in state ? state.instructions : ''}
                placeholder="Leave blank to just reply naturally to the last message"
              />
            </Field>

            <div className="flex items-center gap-3">
              <label htmlFor="count" className="text-sm text-muted-foreground">
                Options
              </label>
              <Select id="count" name="count" defaultValue="3" className="w-24">
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
              </Select>
              <Submit idle="Generate replies" busy="Generating…" />
            </div>
          </form>
        </CardContent>
      </Card>

      {replies && replies.length > 0 && (
        <div className="space-y-3">
          {replies.map((r, i) => (
            <Card key={i} className="animate-fade-up">
              <CardContent className="py-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {r.angle}
                  </span>
                  <Badge tone="neutral">draft</Badge>
                </div>

                {editingIndex === i ? (
                  <Textarea
                    value={edited[i] ?? r.text}
                    onChange={(e) => setEdited((prev) => ({ ...prev, [i]: e.target.value }))}
                    rows={4}
                    aria-label="Edit reply before sending"
                  />
                ) : (
                  <p className="whitespace-pre-wrap text-sm text-pretty">{edited[i] ?? r.text}</p>
                )}

                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border pt-2.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      await navigator.clipboard.writeText(edited[i] ?? r.text);
                      setCopied(i);
                      setTimeout(() => setCopied(null), 1800);
                    }}
                  >
                    {copied === i ? 'Copied' : 'Copy'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingIndex(editingIndex === i ? null : i)}
                  >
                    {editingIndex === i ? 'Done editing' : 'Edit'}
                  </Button>
                  <form
                    action={sendAction}
                    onSubmit={() => setSendIndex(i)}
                    className="contents"
                  >
                    <input type="hidden" name="conversationId" value={shownConversationId} />
                    <input type="hidden" name="text" value={edited[i] ?? r.text} />
                    <Button
                      type="submit"
                      size="sm"
                      variant="outline"
                      disabled={!canSend}
                      title={canSend ? undefined : sendBlockedReason}
                    >
                      Send
                    </Button>
                  </form>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {sendState && (
        <div
          role={sendState.ok ? 'status' : 'alert'}
          className={`rounded-lg border px-3.5 py-2.5 text-sm ${
            sendState.ok
              ? 'border-success/30 bg-success-subtle text-success'
              : 'border-destructive/30 bg-destructive-subtle text-destructive'
          }`}
        >
          {sendState.message}
        </div>
      )}

      {!canSend && sendBlockedReason && (
        <p className="text-xs text-muted-foreground">
          Sending is unavailable: {sendBlockedReason} You can still copy any draft.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Learn your style</CardTitle>
            <CardDescription>
              {hasStyleProfile
                ? 'Re-derive from your latest imported messages.'
                : 'Build a profile from your own messages so replies sound like you.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {styleState && 'error' in styleState && styleState.error && (
              <div role="alert" className="mb-2 rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-xs text-destructive">
                {styleState.error}
              </div>
            )}
            <form action={styleAction}>
              <Submit idle="Analyse my messages" busy="Analysing…" />
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Extract memories</CardTitle>
            <CardDescription>
              Pull durable facts out of a conversation into long-term memory.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {memState && 'error' in memState && memState.error && (
              <div role="alert" className="mb-2 rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-xs text-destructive">
                {memState.error}
              </div>
            )}
            <form action={memAction} className="space-y-2">
              <Select name="conversationId" defaultValue={conversations[0]?.id} aria-label="Conversation to analyse">
                {conversations.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title ?? 'Untitled'}
                  </option>
                ))}
              </Select>
              <Submit idle="Extract" busy="Extracting…" />
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
