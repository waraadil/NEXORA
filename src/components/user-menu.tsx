'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { signOut } from '@/app/(auth)/actions';

export function UserMenu({ compact }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-muted"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-primary-subtle text-xs font-semibold text-primary">
          NX
        </span>
        {!compact && <span className="truncate text-muted-foreground">Account</span>}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-40 mb-1 w-52 overflow-hidden rounded-lg border border-border bg-surface shadow-[var(--shadow-lg)]"
        >
          <Link
            role="menuitem"
            href="/settings"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm hover:bg-muted"
          >
            Settings
          </Link>
          <Link
            role="menuitem"
            href="/settings/ai"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm hover:bg-muted"
          >
            AI provider
          </Link>
          <form action={signOut}>
            <button
              role="menuitem"
              type="submit"
              className="w-full border-t border-border px-3 py-2 text-left text-sm text-destructive hover:bg-destructive-subtle"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
