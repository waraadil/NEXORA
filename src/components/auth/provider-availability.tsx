'use client';

import { useEffect, useState } from 'react';

/**
 * Renders `children` only when the given identity provider is genuinely enabled
 * on this Supabase project; otherwise renders `fallback`.
 *
 * Why client-side: probing `/auth/v1/settings` is a runtime fetch. Doing it during
 * server render makes `/login` dynamic and blocks prerendering. Doing it here
 * keeps the auth pages static while still guaranteeing that no control is ever
 * shown for a provider that is switched off.
 *
 * While the answer is unknown we render a fixed-height placeholder — never a
 * button that might turn out to be dead.
 */
export function ProviderGate({
  provider,
  children,
  fallback,
  placeholderHeight = 92,
}: {
  provider: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
  placeholderHeight?: number;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
        if (!url || !key) {
          if (!cancelled) setEnabled(false);
          return;
        }

        const res = await fetch(`${url}/auth/v1/settings`, {
          headers: { apikey: key },
          cache: 'no-store',
        });
        if (!res.ok) {
          if (!cancelled) setEnabled(false);
          return;
        }

        const settings = (await res.json()) as { external?: Record<string, boolean> };
        if (!cancelled) setEnabled(settings.external?.[provider] === true);
      } catch {
        if (!cancelled) setEnabled(false);
      }
    }

    check();
    return () => {
      cancelled = true;
    };
  }, [provider]);

  if (enabled === null) {
    return <div style={{ height: placeholderHeight }} aria-hidden="true" />;
  }

  return <>{enabled ? children : fallback}</>;
}

/** Explains that an identity provider is switched off for this deployment. */
export function ProviderDisabledNote({ provider }: { provider: string }) {
  return (
    <p className="rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 text-xs text-muted-foreground">
      {provider} sign-in is not enabled on this deployment. Use your email and password.
    </p>
  );
}
