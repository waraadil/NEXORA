'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { runSearch, indexHistory, type SearchState, type IndexState } from './actions';

function SearchBtn() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" isLoading={pending}>
      {pending ? 'Searching…' : 'Search'}
    </Button>
  );
}

function IndexBtn() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" size="sm" isLoading={pending}>
      {pending ? 'Indexing…' : 'Index history'}
    </Button>
  );
}

function Hit({
  body,
  conversationId,
  title,
  contactName,
  sentAt,
  isFromMe,
  score,
}: {
  body: string;
  conversationId: string;
  title: string;
  contactName: string | null;
  sentAt: string | null;
  isFromMe: boolean;
  score?: number;
}) {
  return (
    <li className="border-b border-border last:border-b-0">
      <Link
        href={`/conversations/${conversationId}`}
        className="block px-3.5 py-3 transition-colors hover:bg-muted/60"
      >
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{contactName ?? title}</span>
          <Badge tone={isFromMe ? 'primary' : 'neutral'}>{isFromMe ? 'you' : 'them'}</Badge>
          {sentAt && <span>{new Date(sentAt).toLocaleDateString()}</span>}
          {score !== undefined && (
            <span className="ml-auto font-mono text-[11px] text-accent">
              {(score * 100).toFixed(0)}% match
            </span>
          )}
        </div>
        <p className="mt-1 line-clamp-2 text-sm text-pretty">{body}</p>
      </Link>
    </li>
  );
}

export function SearchPanel({ canEmbed }: { canEmbed: boolean }) {
  const [state, action] = useActionState<SearchState, FormData>(runSearch, null);
  const [indexState, indexAction] = useActionState<IndexState, FormData>(indexHistory, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" strokeLinecap="round" />
        </svg>
        Search messages
      </Button>
    );
  }

  const modeBadge =
    state?.mode === 'semantic'
      ? { tone: 'accent' as const, label: `semantic · ${state.model}` }
      : state?.mode === 'keyword_only'
        ? { tone: 'warning' as const, label: 'keyword only' }
        : { tone: 'neutral' as const, label: 'keyword' };

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Search your history</h2>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>

      <form action={action} className="mt-3 space-y-3">
        <div className="flex flex-wrap gap-2">
          <input
            name="q"
            placeholder="What did we decide about the trip?"
            defaultValue={state?.query ?? ''}
            className="h-11 min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-3 text-sm placeholder:text-muted-foreground/70"
            aria-label="Search query"
            required
          />
          <SearchBtn />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            name="semantic"
            defaultChecked={canEmbed}
            disabled={!canEmbed}
            className="size-4 rounded border-border-strong"
          />
          Meaning-based search (vector)
          {!canEmbed && <span className="text-warning">— needs an embedding-capable provider</span>}
        </label>
      </form>

      {!canEmbed && (
        <div className="mt-3 rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2 text-xs text-warning">
          Your AI provider has no embedding model, so only exact-text search runs. Add an OpenAI or
          Google key in{' '}
          <Link href="/settings/ai" className="underline">
            AI settings
          </Link>{' '}
          to enable meaning-based search. NEXORA will not fake a semantic result.
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <form action={indexAction}>
          <IndexBtn />
        </form>
        <span className="text-xs text-muted-foreground">
          Embeds messages that don&apos;t have a vector yet. Safe to re-run.
        </span>
      </div>

      {indexState && (
        <p
          className={`mt-2 text-xs ${indexState.ok ? 'text-success' : 'text-destructive'}`}
          role="status"
        >
          {indexState.ok
            ? `${indexState.message} (${indexState.progress.batches} batch${
                indexState.progress.batches === 1 ? '' : 'es'
              })`
            : indexState.message}
        </p>
      )}

      {state && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={modeBadge.tone}>{modeBadge.label}</Badge>
            <span className="text-xs text-muted-foreground">
              {state.semanticHits.length} semantic · {state.keywordHits.length} exact matches
            </span>
          </div>

          {state.error && <p className="text-xs text-destructive" role="alert">{state.error}</p>}
          {state.notice && <p className="text-xs text-warning">{state.notice}</p>}

          {state.semanticHits.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Meaning
              </h3>
              <ul className="overflow-hidden rounded-lg border border-border">
                {state.semanticHits.map((h) => (
                  <Hit
                    key={h.messageId}
                    body={h.body}
                    conversationId={h.conversationId}
                    title="Untitled"
                    contactName={h.contactName}
                    sentAt={h.sentAt}
                    isFromMe={h.isFromMe}
                    score={h.similarity}
                  />
                ))}
              </ul>
            </div>
          )}

          {state.keywordHits.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Exact text
              </h3>
              <ul className="overflow-hidden rounded-lg border border-border">
                {state.keywordHits.map((h) => (
                  <Hit
                    key={h.messageId}
                    body={h.body}
                    conversationId={h.conversationId}
                    title={h.conversationTitle}
                    contactName={h.contactName}
                    sentAt={h.sentAt}
                    isFromMe={h.isFromMe}
                  />
                ))}
              </ul>
            </div>
          )}

          {state.semanticHits.length === 0 && state.keywordHits.length === 0 && !state.error && (
            <p className="text-sm text-muted-foreground">No messages matched “{state.query}”.</p>
          )}
        </div>
      )}
    </div>
  );
}
