import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * OAuth / email-confirmation / password-reset callback.
 * Exchanges the one-time code for a session cookie, then forwards the user.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  if (error) {
    const msg = errorDescription || error;
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(msg)}`,
    );
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent('Missing authorization code.')}`);
  }

  const supabase = await createSupabaseServerClient();
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(exchangeError.message)}`,
    );
  }

  // Only allow same-origin relative redirects — prevents open-redirect abuse.
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;

  if (safeNext) {
    return NextResponse.redirect(`${origin}${safeNext}`);
  }

  // No explicit destination: send the user where their setup actually permits.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from('profiles')
    .select('onboarded_at')
    .eq('id', user?.id ?? '')
    .maybeSingle();

  return NextResponse.redirect(`${origin}${profile?.onboarded_at ? '/dashboard' : '/onboarding'}`);
}
