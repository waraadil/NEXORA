import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AuthShell } from '@/components/auth/auth-shell';

// Blocking render is intended: this route depends on the caller's session.
export const instant = false;

export const metadata = { title: 'Reset password' };

export default async function ForgotPasswordPage() {
  // Already signed in? There is nothing to reset.
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) redirect('/dashboard');
  } catch {
    // Not signed in — render the form.
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter the address you signed up with and we will send a recovery link."
      footer={
        <Link href="/login" className="font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-border bg-muted/50 p-4 text-sm leading-relaxed text-muted-foreground">
          <p className="mb-2 font-medium text-foreground">Password resets are not enabled yet.</p>
          <p>
            This deployment has no SMTP provider configured, so Supabase cannot deliver the email.
            Sending a link that never arrives would look like a broken feature — so this page tells
            you the truth instead.
          </p>
        </div>

        <div className="space-y-3 rounded-lg border border-border p-4">
          <p className="text-sm font-medium">Two ways forward</p>
          <ol className="list-inside list-decimal space-y-2 text-sm leading-relaxed text-muted-foreground">
            <li>
              <span className="text-foreground">Sign in with Google.</span> It uses the same account
              and needs no password at all.
            </li>
            <li>
              <span className="text-foreground">Ask an admin to reset it.</span> In your Supabase
              dashboard, Authentication → Users → open the user → send a recovery link or set a new
              password directly.
            </li>
          </ol>
        </div>

        <Link
          href="/login"
          className="flex h-11 w-full items-center justify-center rounded-lg bg-primary text-sm font-medium text-primary-foreground transition hover:brightness-110"
        >
          Back to sign in
        </Link>

        <p className="text-center text-xs leading-relaxed text-muted-foreground">
          To turn resets on, add an SMTP provider under Supabase → Authentication → SMTP. The
          recovery template is already written and will start working unchanged.
        </p>
      </div>
    </AuthShell>
  );
}
