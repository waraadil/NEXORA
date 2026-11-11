import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { NexoraMark } from '@/components/auth/auth-shell';

// Blocking render is intended: this route depends on the caller's session.
export const instant = false;

const FEATURES = [
  {
    title: 'Learns your voice',
    body: 'Reads the messages you have already written and derives a style profile — how formal you are, whether you use emoji, how you close a message. Re-derived whenever you want.',
    icon: (
      <path
        d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"
        strokeWidth="1.8"
      />
    ),
  },
  {
    title: 'Remembers what matters',
    body: 'Pulls durable facts out of conversations — dates, people, preferences, commitments — with a confidence score and a provenance label on every one. You can edit or delete any of them.',
    icon: (
      <>
        <path d="M12 3a4 4 0 0 0-4 4v1a3 3 0 0 0 0 6v3a4 4 0 0 0 8 0v-3a3 3 0 0 0 0-6V7a4 4 0 0 0-4-4z" strokeWidth="1.8" />
        <path d="M9 12h6" strokeWidth="1.8" />
      </>
    ),
  },
  {
    title: 'Drafts replies you would actually send',
    body: 'Every draft is generated from the real conversation plus your style profile, through your own AI provider key. Nothing is sent without you reading it first.',
    icon: (
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-4-.9L3 21l1.9-4.9A8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z" strokeWidth="1.8" />
    ),
  },
  {
    title: 'Finds things by meaning',
    body: 'Messages are embedded into vectors, so "the place with the squeaky camera" finds the conversation without sharing a single word with it. Search by concept, not keywords.',
    icon: (
      <>
        <circle cx="11" cy="11" r="7" strokeWidth="1.8" />
        <path d="m20 20-3.5-3.5" strokeWidth="1.8" strokeLinecap="round" />
      </>
    ),
  },
  {
    title: 'Answers while you are away',
    body: 'Give NEXORA a window and a set of rules. It holds replies, tells you what it would have said, and you approve or discard each one from the review queue.',
    icon: (
      <>
        <circle cx="12" cy="12" r="9" strokeWidth="1.8" />
        <path d="M12 7v5l3.5 2" strokeWidth="1.8" strokeLinecap="round" />
      </>
    ),
  },
  {
    title: 'Your key, your data',
    body: 'Bring a Google, OpenAI or Anthropic key. It is encrypted with AES-256-GCM before it touches the database, and never leaves the server. Your conversations stay in your own Supabase project.',
    icon: (
      <>
        <rect x="4" y="10" width="16" height="10" rx="2.5" strokeWidth="1.8" />
        <path d="M8 10V7a4 4 0 1 1 8 0v3" strokeWidth="1.8" strokeLinecap="round" />
      </>
    ),
  },
];

const STEPS = [
  { n: '01', t: 'Import a conversation', d: 'Paste a WhatsApp export or drop the .txt file. Parsing happens on import, and you see exactly what landed.' },
  { n: '02', t: 'Connect your provider', d: 'Paste an API key once. NEXORA verifies it against the live endpoint before saving, then encrypts it.' },
  { n: '03', t: 'Read, search, reply', d: 'Your style profile and memories are derived from real messages. Draft a reply whenever you need one.' },
];

export default async function Home() {
  // Send people who already have a session straight into the app.
  let signedIn = false;
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    signedIn = Boolean(user);
  } catch {
    // No session, or Supabase unreachable — fall through to the marketing page.
  }

  return (
    <div className="nexora-ambient min-h-dvh">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5" aria-label="NEXORA home">
          <NexoraMark className="size-8" />
          <span className="text-base font-semibold tracking-tight">NEXORA</span>
        </Link>
        <nav className="flex items-center gap-2">
          {signedIn ? (
            <Link
              href="/dashboard"
              className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:brightness-110"
            >
              Open dashboard
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="inline-flex h-10 items-center rounded-lg px-4 text-sm font-medium text-foreground transition hover:bg-muted"
              >
                Sign in
              </Link>
              <Link
                href="/signup"
                className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:brightness-110"
              >
                Get started
              </Link>
            </>
          )}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-5 sm:px-8">
        <section className="pb-16 pt-10 sm:pb-24 sm:pt-20">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-muted-foreground shadow-[var(--shadow-sm)]">
            <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
            Bring your own AI provider key
          </p>
          <h1 className="max-w-3xl text-4xl font-semibold leading-[1.1] tracking-tight text-balance sm:text-5xl md:text-6xl">
            Your conversations have a voice.
            <span className="text-primary"> NEXORA learns it.</span>
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted-foreground text-pretty">
            A personal conversation intelligence layer. It reads what you have already written,
            remembers the facts worth keeping, finds anything by meaning, and drafts replies that
            sound like you — not like a chatbot.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href={signedIn ? '/dashboard' : '/signup'}
              className="inline-flex h-12 items-center justify-center rounded-lg bg-primary px-6 text-base font-medium text-primary-foreground shadow-sm transition hover:brightness-110"
            >
              {signedIn ? 'Open dashboard' : 'Start with your own key'}
            </Link>
            <Link
              href="/login"
              className="inline-flex h-12 items-center justify-center rounded-lg border border-border-strong bg-surface px-6 text-base font-medium transition hover:bg-muted"
            >
              Sign in
            </Link>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            No card. No trial. Your key is encrypted before it is stored.
          </p>
        </section>

        <section className="grid gap-4 pb-16 sm:grid-cols-2 sm:pb-24 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-xl border border-border bg-surface p-5 shadow-[var(--shadow-sm)] transition hover:shadow-[var(--shadow-md)]"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mb-4 size-6 text-primary"
                aria-hidden="true"
              >
                {f.icon}
              </svg>
              <h2 className="mb-1.5 text-base font-semibold tracking-tight">{f.title}</h2>
              <p className="text-sm leading-relaxed text-muted-foreground text-pretty">{f.body}</p>
            </div>
          ))}
        </section>

        <section className="pb-16 sm:pb-24">
          <h2 className="mb-6 text-2xl font-semibold tracking-tight">Three steps, no ceremony</h2>
          <ol className="grid gap-4 md:grid-cols-3">
            {STEPS.map((s) => (
              <li key={s.n} className="rounded-xl border border-border bg-surface p-5">
                <span className="font-mono text-xs font-medium tracking-widest text-primary">{s.n}</span>
                <h3 className="mb-1.5 mt-2 text-base font-semibold tracking-tight">{s.t}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground text-pretty">{s.d}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mb-16 rounded-xl border border-border bg-primary-subtle p-7 sm:mb-24 sm:p-10">
          <h2 className="max-w-2xl text-2xl font-semibold tracking-tight sm:text-3xl text-balance">
            Nothing here is simulated.
          </h2>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted-foreground text-pretty">
            Memories are extracted by a real model. Drafts come back from a real API call. If a
            feature cannot work — no provider connected, no WhatsApp bridge — NEXORA says so instead
            of quietly faking a result.
          </p>
          <Link
            href={signedIn ? '/dashboard' : '/signup'}
            className="mt-6 inline-flex h-11 items-center justify-center rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm transition hover:brightness-110"
          >
            {signedIn ? 'Open dashboard' : 'Create an account'}
          </Link>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-3 px-5 py-7 text-sm text-muted-foreground sm:flex-row sm:items-center sm:px-8">
          <span>© NEXORA</span>
          <span className="flex items-center gap-4">
            <Link href="/login" className="hover:text-foreground">
              Sign in
            </Link>
            <Link href="/signup" className="hover:text-foreground">
              Get started
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
