'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Never log message bodies or keys here — error text can carry provider detail.
    console.error('Dashboard render failed:', error.digest ?? error.name);
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 text-center">
        <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-full bg-destructive-subtle">
          <svg className="size-5 text-destructive" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1 className="text-base font-semibold">This page could not load</h1>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          Something failed on the server. Your data is safe — nothing was changed.
          {error.digest && (
            <span className="mt-2 block font-mono text-xs text-muted-foreground/80">
              ref {error.digest}
            </span>
          )}
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button onClick={reset}>Try again</Button>
          <Link href="/dashboard">
            <Button variant="outline">Back to dashboard</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
