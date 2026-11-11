import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { NexoraMark } from '@/components/auth/auth-shell';

// Blocking render is intended: this route depends on the caller's session.
export const instant = false;

const FEATURES = [
  {
    title: 'Learns your voice',
    body: 'Reads the messages you have already written and derives a style profile — formality, emoji use, how you open and close. Re-derived whenever you want.',
    tag: 'Style profile',
  },
  {
    title: 'Remembers what matters',
    body: 'Pulls durable facts out of conversations — dates, people, preferences, commitments — each with a confidence score and a provenance label.',
    tag: 'Memory',
  },
  {
    title: 'Drafts replies you would send',
    body: 'Every draft is generated from the real conversation plus your style profile, through your own provider key. Nothing sends itself.',
    tag: 'Drafts',
  },
  {
    title: 'Finds things by meaning',
    body: 'Messages are embedded into vectors, so “the place with the squeaky camera” finds the chat without sharing a single word with it.',
    tag: 'Semantic search',
  },
  {
    title: 'Answers while you are away',
    body: 'Give NEXORA a window and a set of rules. It holds replies, shows what it would have said, and you approve or discard each one.',
    tag: 'Away mode',
  },
  {
    title: 'Your key, your data',
    body: 'Bring a Google, OpenAI or Anthropic key. AES-256-GCM encrypted before it touches the database. Conversations stay in your own Supabase project.',
    tag: 'Bring your own key',
  },
];

const PROCESS = [
  {
    n: '01',
    t: 'Import a conversation',
    d: 'Drop a WhatsApp export — a 36,000-message year takes about a minute. You see the parse report before anything is written.',
  },
  {
    n: '02',
    t: 'Connect your provider',
    d: 'Paste an API key once. NEXORA verifies it against the live endpoint, then encrypts it. No shared key, ever.',
  },
  {
    n: '03',
    t: 'Read, search, reply',
    d: 'Style profile and memories are derived from real messages. Draft a reply whenever you need one.',
  },
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
    <div className="nexora-deep relative min-h-dvh overflow-x-clip text-white">
      {/* ── Floating pill nav ── */}
      <header className="sticky top-0 z-40 px-4 pt-4 sm:px-6">
        <div className="pill-nav mx-auto flex max-w-5xl items-center justify-between gap-3 rounded-full py-2 pl-4 pr-2 sm:pl-5">
          <Link href="/" className="flex items-center gap-2.5" aria-label="NEXORA home">
            <NexoraMark className="size-7" />
            <span className="font-[family-name:var(--font-display)] text-[15px] font-600 tracking-tight">
              NEXORA
            </span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex" aria-label="Sections">
            {[
              ['Capabilities', '#capabilities'],
              ['Process', '#process'],
              ['Principles', '#principles'],
            ].map(([label, href]) => (
              <a
                key={href}
                href={href}
                className="rounded-full px-3.5 py-1.5 text-[13px] text-white/62 transition hover:bg-white/6 hover:text-white"
              >
                {label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-1.5">
            {signedIn ? (
              <Link
                href="/dashboard"
                className="iris-glow inline-flex h-9 items-center rounded-full bg-gradient-to-r from-fuchsia-500 to-violet-600 px-4 text-[13px] font-medium text-white transition hover:brightness-110"
              >
                Open dashboard
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  className="hidden h-9 items-center rounded-full px-3.5 text-[13px] text-white/72 transition hover:text-white sm:inline-flex"
                >
                  Sign in
                </Link>
                <Link
                  href="/signup"
                  className="iris-glow inline-flex h-9 items-center rounded-full bg-gradient-to-r from-fuchsia-500 to-violet-600 px-4 text-[13px] font-medium text-white transition hover:brightness-110"
                >
                  Get started
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main>
        {/* ── Hero ── */}
        <section className="relative mx-auto max-w-6xl px-5 pt-14 sm:px-8 sm:pt-20">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-[18%] -top-24 hidden w-[62%] max-w-[760px] opacity-90 lg:block"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/art/fluid-hero.webp"
              alt=""
              className="animate-float w-full mix-blend-screen"
              loading="eager"
            />
          </div>

          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/5 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-white/70 backdrop-blur">
            <span className="size-1.5 rounded-full bg-fuchsia-400 shadow-[0_0_10px_2px_rgba(232,121,249,0.8)]" />
            Bring your own AI provider key
          </p>

          <h1 className="relative max-w-4xl font-[family-name:var(--font-display)] text-[clamp(2.6rem,7vw,5.1rem)] font-800 leading-[0.94] tracking-[-0.035em] text-balance">
            Your conversations
            <br className="hidden sm:block" /> have a voice.
            <span className="gradient-text"> NEXORA learns it.</span>
          </h1>

          <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-white/66 sm:text-base text-pretty">
            A personal conversation intelligence layer. It reads what you have already written,
            remembers the facts worth keeping, finds anything by meaning, and drafts replies that
            sound like you — not like a chatbot.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Link
              href={signedIn ? '/dashboard' : '/signup'}
              className="iris-glow inline-flex h-12 items-center justify-center rounded-full bg-gradient-to-r from-fuchsia-500 to-violet-600 px-7 text-sm font-semibold text-white transition hover:brightness-110"
            >
              {signedIn ? 'Open dashboard' : 'Start with your own key'}
            </Link>
            <Link
              href="/login"
              className="inline-flex h-12 items-center justify-center rounded-full border border-white/14 bg-white/5 px-7 text-sm font-medium text-white/85 backdrop-blur transition hover:border-white/25 hover:bg-white/10"
            >
              Sign in
            </Link>
            <span className="text-[13px] text-white/45">No card · No trial · Key encrypted at rest</span>
          </div>

          {/* App preview — the "screenshot in a halo" motif from the reference. */}
          <div className="relative mt-14 sm:mt-20">
            <div
              aria-hidden="true"
              className="animate-breathe pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[130%] w-[120%] -translate-x-1/2 -translate-y-1/2 rounded-[50%] bg-[radial-gradient(closest-side,rgba(139,92,246,0.35),rgba(236,72,153,0.12),transparent_72%)] blur-2xl"
            />
            <div className="glass overflow-hidden rounded-2xl">
              <div className="flex items-center gap-2 border-b border-white/8 px-4 py-2.5">
                <span className="size-2 rounded-full bg-white/18" />
                <span className="size-2 rounded-full bg-white/18" />
                <span className="size-2 rounded-full bg-white/18" />
                <span className="ml-3 font-[family-name:var(--font-mono)] text-[11px] text-white/40">
                  nexora · conversations
                </span>
              </div>
              <div className="grid gap-0 sm:grid-cols-[190px_1fr]">
                <div className="hidden border-r border-white/8 p-3 sm:block">
                  {['Dashboard', 'Conversations', 'Contacts', 'Memory', 'Away mode'].map((item, i) => (
                    <div
                      key={item}
                      className={`mb-0.5 rounded-lg px-2.5 py-1.5 text-[12px] ${
                        i === 1 ? 'bg-violet-500/18 text-white' : 'text-white/45'
                      }`}
                    >
                      {item}
                    </div>
                  ))}
                </div>
                <div className="space-y-2.5 p-4">
                  {[
                    { who: 'Mittttrrrrr', msg: 'Mna number chnge kra', mine: false },
                    { who: 'You', msg: 'On hi hai', mine: true },
                    { who: 'Mittttrrrrr', msg: 'Woh ab furkaan k no pe ayegi', mine: false },
                  ].map((m, i) => (
                    <div key={i} className={`flex ${m.mine ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[78%] rounded-2xl px-3 py-2 text-[12.5px] leading-snug ${
                          m.mine
                            ? 'rounded-br-md bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white'
                            : 'rounded-bl-md border border-white/8 bg-white/5 text-white/80'
                        }`}
                      >
                        <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wider opacity-55">
                          {m.who}
                        </span>
                        {m.msg}
                      </div>
                    </div>
                  ))}
                  <div className="mt-4 rounded-xl border border-violet-400/25 bg-violet-500/10 p-3">
                    <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-violet-200/70">
                      Suggested reply · your style
                    </p>
                    <p className="text-[12.5px] leading-snug text-white/78">
                      Acha, theek hai. Baat karti hu usse.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Credibility strip */}
          <div className="marquee-mask relative mt-14 overflow-hidden py-2">
            <div className="animate-marquee flex w-max items-center gap-10 whitespace-nowrap text-[11px] uppercase tracking-[0.18em] text-white/30">
              {Array.from({ length: 2 }).flatMap((_, dup) =>
                [
                  'OpenAI',
                  'Google Gemini',
                  'Anthropic',
                  'Supabase Postgres',
                  'pgvector',
                  'WhatsApp exports',
                  'AES-256-GCM',
                ].map((n) => (
                  <span key={`${dup}-${n}`} className="flex items-center gap-10">
                    {n}
                    <span className="size-1 rounded-full bg-white/20" />
                  </span>
                )),
              )}
            </div>
          </div>
        </section>

        {/* ── Capabilities ── */}
        <section id="capabilities" className="relative mx-auto mt-24 max-w-6xl px-5 sm:mt-32 sm:px-8">
          <div aria-hidden="true" className="pointer-events-none -mb-6 select-none overflow-hidden sm:-mb-10">
            <span className="ghost-word block whitespace-nowrap text-[19vw]">SIGNAL</span>
          </div>
          <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-fuchsia-300/80">
            What we do
          </p>
          <h2 className="mt-3 max-w-2xl font-[family-name:var(--font-display)] text-[clamp(1.9rem,4vw,3rem)] font-700 leading-[1.04] tracking-[-0.03em] text-balance">
            Six things, each backed by a real call.
          </h2>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-white/58">
            No mock data anywhere. If a feature cannot run — no key, no bridge — NEXORA says so
            instead of showing a plausible fake.
          </p>

          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <article key={f.title} className="glass glass-hover group relative overflow-hidden rounded-2xl p-5">
                <span
                  aria-hidden="true"
                  className="absolute right-4 top-4 font-[family-name:var(--font-display)] text-[11px] font-600 tabular-nums text-white/22"
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="inline-flex rounded-full border border-violet-400/22 bg-violet-500/12 px-2.5 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-violet-200/85">
                  {f.tag}
                </span>
                <h3 className="mt-4 font-[family-name:var(--font-display)] text-[17px] font-600 leading-snug tracking-[-0.01em]">
                  {f.title}
                </h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-white/55 text-pretty">{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* ── Full-bleed ribbon ── */}
        <section aria-hidden="true" className="relative mt-24 h-[190px] overflow-hidden sm:mt-32 sm:h-[290px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/art/fluid-band.webp"
            alt=""
            className="absolute left-1/2 top-1/2 w-[130%] max-w-none -translate-x-1/2 -translate-y-1/2 opacity-85 mix-blend-screen"
            loading="lazy"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-[#050208] via-transparent to-[#050208]" />
        </section>

        {/* ── Process ── */}
        <section id="process" className="relative mx-auto max-w-6xl px-5 sm:px-8">
          <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-cyan-300/75">
            How it works
          </p>
          <h2 className="mt-3 font-[family-name:var(--font-display)] text-[clamp(1.9rem,4vw,3rem)] font-700 leading-[1.04] tracking-[-0.03em]">
            Our process
          </h2>

          <ol className="mt-10">
            {PROCESS.map((s, i) => (
              <li
                key={s.n}
                className={`group flex flex-col gap-3 py-7 sm:flex-row sm:items-center sm:gap-10 ${
                  i !== 0 ? 'border-t border-white/8' : ''
                }`}
              >
                <span className="process-index w-[5.2rem] shrink-0 text-[clamp(2.4rem,5vw,3.4rem)] tabular-nums sm:w-[7rem]">
                  {s.n}
                </span>
                <h3 className="w-full shrink-0 font-[family-name:var(--font-display)] text-[17px] font-600 tracking-[-0.01em] sm:w-[220px]">
                  {s.t}
                </h3>
                <p className="max-w-xl text-[13.5px] leading-relaxed text-white/55 text-pretty">{s.d}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ── Principles (the orb section) ── */}
        <section id="principles" className="relative isolate mt-24 sm:mt-32">
          <div className="relative mx-auto max-w-6xl px-5 text-center sm:px-8">
            {/* The orb sits behind the headline as a light source, not as a picture:
                heavily blurred and screened so it reads as glow, never as a blob. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute left-1/2 top-2 z-0 w-[min(150%,820px)] -translate-x-1/2"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/art/orb.webp"
                alt=""
                className="art-mask-circle animate-breathe w-full opacity-90 mix-blend-screen"
                loading="lazy"
              />
            </div>

            <p className="relative z-10 text-[11px] font-medium uppercase tracking-[0.2em] text-violet-300/80">
              Non-negotiables
            </p>
            <h2 className="relative z-10 mx-auto mt-3 max-w-3xl font-[family-name:var(--font-display)] text-[clamp(1.9rem,4.4vw,3.2rem)] font-700 leading-[1.05] tracking-[-0.03em] text-balance">
              Nothing here is simulated.
            </h2>
            <p className="relative z-10 mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-white/60 text-pretty">
              Memories are extracted by a real model. Drafts come back from a real API call. Imports
              report exactly what landed. When something cannot work, you are told — never quietly
              faked.
            </p>

            <div className="relative z-10 mx-auto mt-12 grid max-w-4xl gap-3 pb-24 text-left sm:grid-cols-3">
              {[
                ['Real API calls', 'No stubbed responses behind a feature flag.'],
                ['Honest failures', 'A dead provider shows an error, not fake output.'],
                ['Your Postgres', 'Rows live in your own Supabase project.'],
              ].map(([t, d]) => (
                <div key={t} className="glass rounded-xl p-4">
                  <h3 className="text-[13.5px] font-600 tracking-[-0.01em]">{t}</h3>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-white/52">{d}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Closing CTA ── */}
        <section className="relative mx-auto max-w-6xl px-5 pb-24 sm:px-8">
          <div className="glass relative overflow-hidden rounded-3xl px-6 py-12 text-center sm:px-12 sm:py-16">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 -bottom-24 h-64 bg-[radial-gradient(closest-side,rgba(168,85,247,0.42),transparent)] blur-2xl"
            />
            <h2 className="relative font-[family-name:var(--font-display)] text-[clamp(1.8rem,4.2vw,3rem)] font-700 leading-[1.05] tracking-[-0.03em] text-balance">
              Transform your conversations
              <span className="gradient-text"> into something you can use.</span>
            </h2>
            <p className="relative mx-auto mt-4 max-w-md text-[14.5px] leading-relaxed text-white/58">
              Start with one export. The parse report is the proof.
            </p>
            <Link
              href={signedIn ? '/dashboard' : '/signup'}
              className="iris-glow relative mt-8 inline-flex h-12 items-center justify-center rounded-full bg-gradient-to-r from-fuchsia-500 to-violet-600 px-8 text-sm font-semibold text-white transition hover:brightness-110"
            >
              {signedIn ? 'Open dashboard' : 'Create an account'}
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/8">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 px-5 py-8 text-[12.5px] text-white/42 sm:flex-row sm:items-center sm:px-8">
          <div className="flex items-center gap-2.5">
            <NexoraMark className="size-5" />
            <span>© NEXORA</span>
          </div>
          <nav className="flex items-center gap-5">
            <Link href="/login" className="transition hover:text-white">
              Sign in
            </Link>
            <Link href="/signup" className="transition hover:text-white">
              Get started
            </Link>
            <a href="#principles" className="transition hover:text-white">
              Principles
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
