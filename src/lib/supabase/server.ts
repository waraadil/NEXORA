import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

/**
 * Request-scoped client that acts AS THE SIGNED-IN USER.
 * Every query goes through RLS — this is the security boundary for all
 * user-facing reads/writes. Use this by default.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component — middleware handles the refresh.
          }
        },
      },
    },
  );
}

/**
 * Service-role client. BYPASSES RLS.
 *
 * Only for operations that legitimately need cross-cutting access:
 *  - decrypting a user's AI credential before a server-side provider call
 *  - writing import batches atomically
 *  - account deletion cleanup
 *
 * Every call site MUST scope queries by user_id explicitly, because RLS is not
 * there to catch mistakes. Never import this into a client component.
 */
export function createSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Service-role Supabase credentials are not configured.');
  }

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    // We never use Realtime. Supplying an empty transport avoids the client
    // eagerly resolving a WebSocket implementation, which throws on Node < 22
    // ("native WebSocket not found") — including in test harnesses.
    realtime: { transport: class {} as never },
  });
}

/** Returns the authenticated user or null. Never throws on missing session. */
export async function getCurrentUser() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user;
}
