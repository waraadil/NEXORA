/**
 * Loading placeholders.
 *
 * A skeleton is only honest if it roughly matches the shape of the content that
 * replaces it — otherwise it is a decorative spinner with extra steps. These are
 * composed per-page rather than sprinkled arbitrarily.
 *
 * `aria-busy` on the container plus `aria-hidden` on the blocks means a screen
 * reader hears "loading" once, not a stream of empty boxes.
 */

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={[
        'animate-pulse rounded-md bg-muted',
        className,
      ].join(' ')}
    />
  );
}

export function SkeletonText({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <div className={['space-y-2', className].join(' ')} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded bg-muted"
          style={{ width: i === lines - 1 ? '60%' : '100%' }}
        />
      ))}
    </div>
  );
}

export function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5" aria-hidden="true">
      <div className="size-10 shrink-0 animate-pulse rounded-full bg-muted" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-3.5 w-2/5 animate-pulse rounded bg-muted" />
        <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="rounded-xl border border-border bg-surface p-5" aria-hidden="true">
      <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
      <div className="mt-3 h-3 w-full animate-pulse rounded bg-muted" />
      <div className="mt-2 h-3 w-4/5 animate-pulse rounded bg-muted" />
    </div>
  );
}

/** Full-page shell used by route-level loading.tsx files. */
export function PageSkeleton({
  title = 'Loading',
  rows = 6,
  variant = 'list',
}: {
  title?: string;
  rows?: number;
  variant?: 'list' | 'cards' | 'messages';
}) {
  return (
    <div className="min-h-dvh bg-background" aria-busy="true" aria-live="polite">
      <span className="sr-only">{title}</span>
      <div className="lg:pl-60">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:py-8">
          <div className="mb-6 space-y-2.5" aria-hidden="true">
            <div className="h-7 w-48 animate-pulse rounded-lg bg-muted" />
            <div className="h-3.5 w-64 animate-pulse rounded bg-muted" />
          </div>

          {variant === 'cards' && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-hidden="true">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="rounded-xl border border-border bg-surface p-5">
                  <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                  <div className="mt-3 h-7 w-12 animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          )}

          {variant === 'messages' && (
            <div className="space-y-3" aria-hidden="true">
              {Array.from({ length: rows }).map((_, i) => (
                <div key={i} className={i % 2 === 0 ? 'flex justify-start' : 'flex justify-end'}>
                  <div
                    className={`animate-pulse rounded-2xl bg-muted ${i % 3 === 0 ? 'h-16 w-2/3' : 'h-11 w-1/2'}`}
                  />
                </div>
              ))}
            </div>
          )}

          {variant === 'list' && (
            <div className="overflow-hidden rounded-xl border border-border bg-surface">
              {Array.from({ length: rows }).map((_, i) => (
                <div key={i} className="border-b border-border last:border-b-0">
                  <SkeletonRow />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
