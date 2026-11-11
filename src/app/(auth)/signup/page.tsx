import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthShell } from '@/components/auth/auth-shell';
import { SignupForm } from './signup-form';

export const metadata: Metadata = { title: 'Create account' };

export default function SignupPage() {
  return (
    <AuthShell
      title="Create your account"
      subtitle="Your conversations, your intelligence, your AI."
      footer={
        <>
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <SignupForm />
    </AuthShell>
  );
}
