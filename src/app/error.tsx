'use client';

import { useEffect } from 'react';
import Link from 'next/link';

/**
 * Per-route error boundary.
 *
 * Without this, one throwing server component takes down the whole app view —
 * the user sees "NEXORA failed to start" and loses the navigation shell, so
 * they cannot even get back to a working page. This keeps the failure local and
 * recoverable, and names the digest so it can be traced in the logs.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server components redact the message in production; the digest is the
    // only handle we get, and it is what appears in the Vercel log stream.
    console.error('[nexora] route error', error.digest ?? '(no digest)', error.message);
  }, [error]);

  return (
    <main className="nexora-ambient flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-[var(--shadow-lg)]">
        <h1 className="text-lg font-semibold tracking-tight">This page hit an error</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          The rest of NEXORA still works. Try again, or go back to a page that loads.
        </p>
        {error.digest && (
          <p className="mt-2 font-mono text-xs text-muted-foreground">ref {error.digest}</p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            onClick={reset}
            className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:brightness-110"
          >
            Try again
          </button>
          <Link
            href="/dashboard"
            className="inline-flex h-10 items-center rounded-lg border border-border-strong bg-surface px-4 text-sm font-medium transition hover:bg-muted"
          >
            Dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
