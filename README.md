<div align="center">

# NEXORA

**Your conversations. Your intelligence. Your AI.**

A personal conversation-intelligence platform that learns how *you* write, remembers what
matters, and drafts replies in your own voice — through your own AI provider key.

[**Live app**](https://nexora-zeta-red.vercel.app) · [Report a bug](../../issues) · [Request a feature](../../issues)

<sub>Next.js 16 · React 19 · TypeScript · Supabase Postgres + pgvector · Tailwind CSS 4</sub>

</div>

---

## What it actually does

| Capability | How it works | Provider |
|---|---|---|
| **Import WhatsApp exports** | Parses iOS/Android `.txt` exports with a single-pass parser. Handles 36k-message files, system banners, multi-line bodies, bidi text, and an owner whose display name is an invisible codepoint. Reports exactly what was parsed before anything is written. | built-in |
| **Learn your writing style** | Derives tone, formality, emoji rate and openers from the messages you have actually sent. | your key |
| **Remember what matters** | Extracts durable facts (dates, people, preferences, commitments) with a confidence score and a provenance label. Every memory is editable and deletable. | your key |
| **Search by meaning** | Every message is embedded into a vector; retrieval is cosine similarity over pgvector with an HNSW index. "The place with the squeaky camera" finds the chat without a keyword match. | your key |
| **Draft replies** | Generates from the real conversation plus your style profile. Nothing is sent without you reading it. | your key |
| **Away mode** | Holds replies inside a window and a rule set; you approve or discard each one from a queue. | your key |

> **No simulated data anywhere.** Every number on screen comes from a row in your database or a
> live API response. When a feature cannot run — no key configured, no WhatsApp bridge — the UI
> says so instead of showing a plausible fake.

---

## Architecture

```
Browser ──► Next.js App Router (RSC + Server Actions)
                │
                ├─► Supabase Auth ................. SSR cookies via @supabase/ssr
                ├─► Postgres 17 ................... RLS on all 15 tables
                │     └─ pgvector + HNSW ......... semantic search
                └─► Provider adapter ............. OpenAI / Anthropic / Google / OpenAI-compatible
                      └─ your key, AES-256-GCM at rest, server-only master key
```

**Design decisions worth knowing**

- **Your key stays yours.** Credentials are encrypted with AES-256-GCM before they touch the
  database and are never returned to the browser. Every provider call happens server-side.
- **The import is stateless.** The two-step wizard re-sends the file on confirm rather than
  holding a server-side draft, because on serverless each request can land on a different
  instance. Parsing 1.8 MB costs ~0.5 s.
- **`(conversation_id, message_hash)` is unique.** Re-importing the same export is safe: it
  adds new messages and reports the rest as duplicates instead of erroring.
- **Errors stay local.** `app/error.tsx` keeps the shell and offers recovery, so one failing
  query cannot replace the whole application with a crash screen.

---

## Getting started

```bash
git clone https://github.com/waraadil/NEXORA.git
cd NEXORA
npm install
cp .env.example .env.local     # fill in the values below
npm run dev                    # http://localhost:3000
```

**Environment**

| Variable | Required | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Public anon key (RLS enforces access) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-only; bypasses RLS for admin operations |
| `NEXORA_ENCRYPTION_KEY` | yes | 64 hex chars — AES-256-GCM master key |
| `NEXT_PUBLIC_APP_URL` | prod | Absolute URL used for OAuth redirects |

Generate a key with `openssl rand -hex 32`.

---

## Testing

The suites run against a real Supabase project and a real provider key — there are no mocks.

```bash
npx tsc --noEmit                        # types
npm run build                           # production build

npx tsx scripts/test-parser.ts          # 21 checks — WhatsApp parser
node scripts/test-column-lockdown.mjs   #  8 checks — RLS + encryption at rest
node scripts/test-semantic.mjs          # 10 checks — pgvector retrieval
node scripts/test-auth-e2e.mjs          # 27 checks — auth flows end to end
node scripts/test-auth-pages.mjs        # 17 checks — auth page behaviour
node scripts/test-ui.mjs                # 27 checks — layout, a11y, theme, mobile
node scripts/test-provider-live.mjs     # 21 checks — live provider calls
```

Point any browser suite at a running server with `NEXORA_BASE=http://127.0.0.1:3100`.

**Current status: 131 checks passing, 0 failing.**

---

## Project layout

```
src/
├── app/
│   ├── (auth)/                 sign-in, sign-up, forgot-password, OAuth callback
│   ├── conversations/          list, transcript, import wizard
│   ├── contacts/ memory/ away/ assistant/ settings/ integrations/
│   ├── error.tsx               per-route boundary — failures stay local
│   └── global-error.tsx        last-resort boundary with an escape hatch
├── components/
│   ├── app-shell.tsx           glass sidebar, mobile top bar and bottom nav
│   └── ui/                     buttons, cards, fields, badges
├── lib/
│   ├── whatsapp/parser.ts      the export parser, with a regression suite
│   ├── text/names.ts           blank/invisible display-name handling
│   ├── ai/                     provider adapters + prompt construction
│   └── supabase/               server, client and admin clients
└── middleware.ts               route protection and onboarding gate
```

---

## Design

Dark-first, built around iridescent fluid artwork, glass panels and editorial type.

- **Surface language** — near-black ink (`#050208`) with violet light pooling under the fold;
  panels are hairline-rimmed glass that pick up the glow behind them.
- **Type** — Sora for display and oversized section numerals, Inter for body.
- **Motion** — slow drift and breathe on the artwork, a marquee for the trust strip. Every
  animation is disabled under `prefers-reduced-motion`.
- **Light mode is a full citizen** — the toggle is three-state (light / dark / system), and dark
  is the default for visitors who have not chosen.

---

## License

Private. All rights reserved.
