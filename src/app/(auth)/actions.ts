'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getAppUrl } from '@/lib/app-url';

export type AuthState = { error?: string; success?: string; fieldErrors?: Record<string, string> } | null;

const emailSchema = z.string().trim().min(1, 'Email is required').email('Enter a valid email address');
const passwordSchema = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(72, 'Password is too long');

// getAppUrl() never hands out localhost from a deployed build.

export async function signInWithGoogle(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${getAppUrl()}/auth/callback`,
      queryParams: { access_type: 'offline', prompt: 'consent' },
    },
  });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }
  if (data.url) redirect(data.url);
}

export async function signInWithEmail(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const parsed = z
    .object({ email: emailSchema, password: z.string().min(1, 'Password is required') })
    .safeParse({
      email: formData.get('email'),
      password: formData.get('password'),
    });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[String(issue.path[0])] = issue.message;
    }
    return { fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    // Deliberately generic — never confirm whether an email exists.
    return {
      error:
        error.message === 'Email not confirmed'
          ? 'Please confirm your email address before signing in. Check your inbox.'
          : 'Incorrect email or password.',
    };
  }

  revalidatePath('/', 'layout');

  // Route straight to the right place. Chaining /dashboard -> middleware ->
  // /onboarding produces two redirects in one soft navigation, which leaves the
  // client URL stale on /dashboard while rendering the onboarding UI.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from('profiles')
    .select('onboarded_at')
    .eq('id', user?.id ?? '')
    .maybeSingle();

  redirect(profile?.onboarded_at ? '/dashboard' : '/onboarding');
}

export async function signUpWithEmail(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const parsed = z
    .object({
      email: emailSchema,
      password: passwordSchema,
      confirmPassword: z.string(),
      displayName: z.string().trim().max(80).optional(),
    })
    .refine((d) => d.password === d.confirmPassword, {
      message: 'Passwords do not match',
      path: ['confirmPassword'],
    })
    .safeParse({
      email: formData.get('email'),
      password: formData.get('password'),
      confirmPassword: formData.get('confirmPassword'),
      displayName: formData.get('displayName') ?? undefined,
    });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[String(issue.path[0])] = issue.message;
    }
    return { fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: `${getAppUrl()}/auth/callback`,
      data: { full_name: parsed.data.displayName || null },
    },
  });

  if (error) {
    if (error.message.toLowerCase().includes('already registered')) {
      return { error: 'An account with this email already exists. Try signing in instead.' };
    }
    return { error: error.message };
  }

  // If email confirmation is enabled, there is no session yet.
  if (!data.session) {
    return {
      success: 'Account created. Check your email for a confirmation link, then sign in.',
    };
  }

  revalidatePath('/', 'layout');
  redirect('/onboarding');
}

export async function requestPasswordReset(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const parsed = emailSchema.safeParse(formData.get('email'));
  if (!parsed.success) {
    return { fieldErrors: { email: parsed.error.issues[0].message } };
  }

  const supabase = await createSupabaseServerClient();
  await supabase.auth.resetPasswordForEmail(parsed.data, {
    redirectTo: `${getAppUrl()}/auth/callback?next=/settings/security`,
  });

  // Always report success — do not leak which emails are registered.
  return {
    success: 'If an account exists for that address, a reset link is on its way.',
  };
}

export async function updatePassword(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const parsed = z
    .object({ password: passwordSchema, confirmPassword: z.string() })
    .refine((d) => d.password === d.confirmPassword, {
      message: 'Passwords do not match',
      path: ['confirmPassword'],
    })
    .safeParse({
      password: formData.get('password'),
      confirmPassword: formData.get('confirmPassword'),
    });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[String(issue.path[0])] = issue.message;
    }
    return { fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return { error: error.message };

  return { success: 'Password updated.' };
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  revalidatePath('/', 'layout');
  redirect('/login');
}
