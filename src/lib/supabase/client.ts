import { createBrowserClient } from '@supabase/ssr';

/** Browser client. Uses the publishable key only — RLS is the enforcement layer. */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
