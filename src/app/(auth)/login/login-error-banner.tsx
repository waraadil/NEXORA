'use client';

import { useSearchParams } from 'next/navigation';
import { LoginForm } from './login-form';

/**
 * Reads `?error=` (set by a failed OAuth callback or middleware) inside a
 * Suspense boundary so the rest of the page stays prerenderable.
 */
export function LoginWithError() {
  const searchParams = useSearchParams();
  return <LoginForm initialError={searchParams.get('error') ?? undefined} />;
}
