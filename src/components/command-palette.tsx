'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';

/**
 * Keyboard-first command palette (⌘K / Ctrl+K).
 *
 * Fuzzy ranking is modelled on the 21st.dev "Command Palette" component:
 * subsequence matching with bonuses for word boundaries and consecutive runs.
 * Rewritten without a motion dependency so it adds nothing to the bundle —
 * NEXORA has no animation library and this is not worth introducing one.
 */

export type CommandItem = {
  id: string;
  label: string;
  hint?: string;
  href?: string;
  keywords?: string;
  action?: () => void;
};

const BOUNDARY = /[\s\-_/.:]/;

function scoreOne(text: string, query: string): number {
  const t = text.toLowerCase();
  let cursor = 0;
  let total = 0;
  let streak = 0;

  for (let i = 0; i < query.length; i++) {
    const at = t.indexOf(query[i], cursor);
    if (at < 0) return -1;
    streak = at === cursor && i > 0 ? streak + 1 : 0;
    total += 2 + streak * 4;
    if (at === 0) total += 12;
    else if (BOUNDARY.test(t[at - 1])) total += 8;
    cursor = at + 1;
  }
  return total;
}

function rank(items: CommandItem[], query: string): CommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;

  return items
    .map((item, order) => {
      const label = scoreOne(item.label, q) * 2;
      const keywords = item.keywords ? scoreOne(item.keywords, q) : -1;
      const best = Math.max(label, keywords);
      return { item, score: best, order };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((r) => r.item);
}

export function CommandPalette({ items }: { items: CommandItem[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => rank(items, query), [items, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActive(0);
  }, []);

  const run = useCallback(
    (item: CommandItem | undefined) => {
      if (!item) return;
      close();
      if (item.href) router.push(item.href);
      else item.action?.();
    },
    [close, router],
  );

  // Global shortcut
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isK = e.key.toLowerCase() === 'k';
      if (isK && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Focus + lock scroll while open
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      clearTimeout(t);
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Keep the active row in view
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[active]);
    } else if (e.key === 'Tab') {
      // Trap focus inside the dialog.
      e.preventDefault();
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group flex w-full items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        aria-label="Open command palette"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-4 shrink-0" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" strokeLinecap="round" />
        </svg>
        <span className="truncate">Search…</span>
        <kbd className="ml-auto hidden shrink-0 rounded border border-border-strong bg-surface px-1.5 py-0.5 font-sans text-[10px] font-medium text-muted-foreground sm:block">
          ⌘K
        </kbd>
      </button>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]"
            role="presentation"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <div className="absolute inset-0 animate-[nexora-fade-in_0.15s_ease-out] bg-foreground/25 backdrop-blur-sm" aria-hidden="true" />

            <div
              role="dialog"
              aria-modal="true"
              aria-label="Command palette"
              onKeyDown={onKeyDown}
              className="relative z-10 w-full max-w-lg animate-fade-up overflow-hidden rounded-xl border border-primary/30 bg-surface shadow-[var(--shadow-lg)] ring-1 ring-primary/10"
            >
              <div className="flex items-center gap-2 border-b border-border px-3.5">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-4 shrink-0 text-muted-foreground" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" strokeLinecap="round" />
                </svg>
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  placeholder="Jump to a page or run an action…"
                  aria-label="Command"
                  aria-controls="command-results"
                  className="h-12 w-full bg-transparent text-sm outline-none focus-visible:outline-none placeholder:text-muted-foreground/70"
                />
                <button
                  type="button"
                  onClick={close}
                  className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
                >
                  ESC
                </button>
              </div>

              <ul
                id="command-results"
                ref={listRef}
                role="listbox"
                aria-label="Results"
                className="max-h-72 overflow-y-auto p-1.5"
              >
                {results.length === 0 && (
                  <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No match for “{query}”.
                  </li>
                )}
                {results.map((item, i) => (
                  <li key={item.id} role="option" aria-selected={i === active}>
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => run(item)}
                      className={[
                        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                        i === active ? 'bg-primary-subtle text-foreground' : 'text-foreground hover:bg-muted',
                      ].join(' ')}
                    >
                      <span className="truncate">{item.label}</span>
                      {item.hint && (
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{item.hint}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>

              <div className="flex items-center gap-3 border-t border-border px-3.5 py-2 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <kbd className="rounded border border-border px-1">↑</kbd>
                  <kbd className="rounded border border-border px-1">↓</kbd> navigate
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="rounded border border-border px-1">↵</kbd> open
                </span>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
