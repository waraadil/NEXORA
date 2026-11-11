'use client';

import { useEffect } from 'react';

/**
 * Last-resort boundary — only rendered if the root layout itself throws, so it
 * must not assume any provider or stylesheet is present.
 *
 * It deliberately offers a way out instead of only "Reload": if the failure is
 * caused by a stale session, reloading loops forever.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[nexora] root error', error.digest ?? '(no digest)', error.message);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#FAF5FF', color: '#1E1B4B' }}>
        <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 24 }}>
          <div style={{ maxWidth: 440, textAlign: 'center' }}>
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>NEXORA hit an error</h1>
            <p style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.75, marginTop: 8 }}>
              Something failed before the page could load. Try again — if it keeps happening,
              sign out and back in, which clears a stale session.
            </p>
            {error.digest && (
              <p style={{ fontSize: 12, opacity: 0.5, marginTop: 8 }}>ref {error.digest}</p>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 20 }}>
              <button
                onClick={reset}
                style={{
                  padding: '10px 18px',
                  borderRadius: 10,
                  border: 'none',
                  background: '#7C3AED',
                  color: 'white',
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Try again
              </button>
              <a
                href="/auth/signout"
                style={{
                  padding: '10px 18px',
                  borderRadius: 10,
                  border: '1px solid #E9D5FF',
                  background: 'white',
                  color: '#1E1B4B',
                  fontSize: 14,
                  fontWeight: 500,
                  textDecoration: 'none',
                }}
              >
                Sign out
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
