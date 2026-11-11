import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/** Routes that require a session. */
const PROTECTED = [
  '/dashboard',
  '/conversations',
  '/contacts',
  '/assistant',
  '/memory',
  '/away',
  '/integrations',
  '/settings',
  '/onboarding',
];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: getUser() (not getSession()) — it revalidates the JWT server-side.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isProtected = PROTECTED.some((p) => path === p || path.startsWith(`${p}/`));

  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', path);
    return NextResponse.redirect(url);
  }

  // Signed-in users who haven't configured an AI provider must not reach the app.
  if (user && isProtected) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('onboarded_at')
      .eq('id', user.id)
      .maybeSingle();

    const needsOnboarding = !profile?.onboarded_at;

    if (needsOnboarding && path !== '/onboarding') {
      const url = request.nextUrl.clone();
      url.pathname = '/onboarding';
      url.search = '';
      return NextResponse.redirect(url);
    }

    if (!needsOnboarding && path === '/onboarding') {
      const url = request.nextUrl.clone();
      url.pathname = '/dashboard';
      url.search = '';
      return NextResponse.redirect(url);
    }
  }

  // Signed-in users shouldn't sit on the auth screens.
  if (user && (path === '/login' || path === '/signup')) {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
