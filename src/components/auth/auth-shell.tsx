import Link from 'next/link';

export function NexoraMark({ className = 'size-9' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="hsl(var(--primary))" />
      <path
        d="M10 22V10.5l12 11V10"
        stroke="hsl(var(--primary-foreground))"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="22" cy="10" r="2.1" fill="hsl(var(--accent))" />
    </svg>
  );
}

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="nexora-ambient flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <Link
          href="/"
          className="mb-8 flex items-center justify-center gap-2.5 rounded-lg py-1"
          aria-label="NEXORA home"
        >
          <NexoraMark />
          <span className="text-lg font-semibold tracking-tight">NEXORA</span>
        </Link>

        <div className="rounded-xl border border-border bg-surface p-6 shadow-[var(--shadow-lg)] sm:p-8">
          <div className="mb-6 space-y-1.5 text-center">
            <h1 className="text-xl font-semibold tracking-tight text-balance">{title}</h1>
            {subtitle && <p className="text-sm text-muted-foreground text-pretty">{subtitle}</p>}
          </div>
          {children}
        </div>

        {footer && <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div>}
      </div>
    </main>
  );
}

export function GoogleIcon() {
  return (
    <svg className="size-4.5" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1a11 11 0 0 0-9.82 6.05l3.66 2.84C6.71 7.29 9.14 5.38 12 5.38Z"
      />
    </svg>
  );
}
