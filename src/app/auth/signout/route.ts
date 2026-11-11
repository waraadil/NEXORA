import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * GET /auth/signout — clears the session and returns to /login.
 *
 * Exists so a user whose session is broken can escape from anywhere, including
 * the global error boundary where no React tree is available to render a
 * server-action form. Idempotent and safe to link to.
 */
export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/login', request.url));
}
