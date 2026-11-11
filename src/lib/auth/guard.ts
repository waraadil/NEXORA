import 'server-only';
import { connection } from 'next/server';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { User } from '@supabase/supabase-js';

/**
 * Server-side session + onboarding guard for protected pages.
 *
 * The middleware already does this, but middleware can be skipped on soft client
 * navigations / prefetch edges. Every protected page therefore re-checks here.
 * Defence in depth: a page never renders app chrome for a user who has no AI
 * provider configured.
 */
export async function requireUser(): Promise<{
  user: User;
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
}> {
  // Mark this render as request-bound BEFORE touching the session client.
  // Supabase's auth client reads the clock; with `cacheComponents` enabled the
  // router otherwise tries to include that in the prerendered shell and fails
  // with "encountered the unstable value Date.now() while prerendering".
  await connection();

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');
  return { user, supabase };
}

export async function requireOnboardedUser(): Promise<{
  user: User;
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
}> {
  const { user, supabase } = await requireUser();

  const { data: profile } = await supabase
    .from('profiles')
    .select('onboarded_at')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile?.onboarded_at) redirect('/onboarding');

  return { user, supabase };
}
