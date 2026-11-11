import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { AuthShell } from '@/components/auth/auth-shell';
import { LoginForm } from './login-form';
import { LoginWithError } from './login-error-banner';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to your conversation intelligence."
      footer={
        <>
          Don&apos;t have an account?{' '}
          <Link href="/signup" className="font-medium text-primary underline-offset-4 hover:underline">
            Create one
          </Link>
        </>
      }
    >
      <Suspense fallback={<LoginForm />}>
        <LoginWithError />
      </Suspense>
    </AuthShell>
  );
}
