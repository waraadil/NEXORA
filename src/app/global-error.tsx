'use client';

/**
 * Last-resort boundary. Only rendered if the root layout itself throws, so it
 * must not assume any provider or stylesheet is present.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#FAF5FF', color: '#1E1B4B' }}>
        <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 24 }}>
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>NEXORA failed to start</h1>
            <p style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.7, marginTop: 8 }}>
              An unrecoverable error occurred. Reloading usually fixes it.
            </p>
            {error.digest && (
              <p style={{ fontSize: 12, opacity: 0.5, marginTop: 8 }}>ref {error.digest}</p>
            )}
            <button
              onClick={reset}
              style={{
                marginTop: 16,
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
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
