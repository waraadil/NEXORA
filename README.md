# NEXORA

**Your conversations. Your intelligence. Your AI.**

A personal conversation intelligence platform: it learns how you communicate, remembers
what matters, and helps you reply naturally — using *your own* AI provider key.

---

## Stack (all live, nothing stubbed)

| Layer | Choice |
|---|---|
| Framework | Next.js 16.4.6 (App Router, Turbopack) + React 19 + TypeScript |
| Styling | Tailwind CSS 4 with a token-based design system |
| Auth | Supabase Auth (email/password + OAuth, SSR cookies via `@supabase/ssr`) |
| Database | Supabase Postgres 17 — **12 tables, all RLS-enabled** |
| Semantic memory | pgvector 0.8.2 + HNSW index |
| AI | Modular provider adapters — OpenAI · Anthropic · Google · OpenAI-compatible |
| Encryption | AES-256-GCM (Node crypto), server-only master key |

**Supabase project:** `qxdxmigcyxyabjreorfz` (ap-south-1)
**Repo:** `/home/user/nexora`

---

## Status

### ✅ Verified working

- **Auth**: signup, sign-in, session persistence, middleware route protection,
  password reset, OAuth callback handler.
  *Tested against the live DB:* signup → session → profile auto-created by trigger.
- **RLS isolation**: *tested* — a user can insert their own credential but
  **cross-user insert is blocked** (`violates row-level security policy`),
  and only their own profile is visible.
- **WhatsApp parser**: 15/15 regression tests green. Handles iOS bracketed,
  Android dashed, 12h/24h clocks, multi-line messages, group participants,
  system-banner filtering, Arabic bidi/Arabic-Indic digits, stable dedupe hashes.
- **Encryption layer**: AES-256-GCM encrypt/decrypt with tamper detection
  (auth tag), key fingerprinting, and secret redaction for logs/errors.
- **Provider adapters**: real HTTP calls to all four providers, typed error
  classification (invalid key / quota / rate limit / outage).
- **Onboarding**: 3-step wizard with provider → model → key → validate → profile,
  gated so the app is unreachable without a validated credential.

### ✅ WhatsApp integration — both paths built

| Path | Status | What actually works |
|---|---|---|
| **Official Cloud API** (business number) | **Built** | Credential verification against Graph API v21, HMAC-SHA256 webhook verification, inbound message ingest, outbound sending with 24-hour window enforcement, delivery/read status updates. Needs a Meta business number + token to go live. |
| **Personal bridge** (own account) | **Built + tested** | Token-authenticated ingest endpoint; reference bridge client in `bridge-example/`; consent gate with 4 explicit risk acknowledgements. Verified: 3 messages in, replay deduped to 0 new / 3 duplicates, bad token → 401. |

**Endpoint surfaces (live):**

```
GET  /api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=… → challenge echo / 403
POST /api/whatsapp/webhook                → HMAC-verified ingest (401 on bad signature)
POST /api/whatsapp/bridge/ingest          → Bearer-token ingest (401 on bad token)
```

**Proven by test:** bridge POST → 3 messages persisted with correct direction,
conversation auto-created (`source: personal_bridge`), replay → `inserted:0,
duplicates:3`, revoked token → `401`.

### ⚠️ Requires your credentials

| Feature | Blocker | How to unblock |
|---|---|---|
| **Google sign-in** | Google OAuth is disabled on the Supabase project and needs a Google Cloud OAuth client | [console.cloud.google.com](https://console.cloud.google.com/apis/credentials) → OAuth client ID → Web application → redirect URI `https://qxdxmigcyxyabjreorfz.supabase.co/auth/v1/callback` → paste Client ID + Secret into Supabase → Authentication → Providers → Google |
| **Cloud API go-live** | Needs a Meta business number, permanent token, app secret | Meta Business Suite → WhatsApp → API Setup |
| **Personal bridge go-live** | Needs you to run `bridge-example/bridge.mjs` | See `bridge-example/README.md` |

### ✅ Built this session — import pipeline + intelligence

**Import pipeline (works end to end, verified):**
- Upload → parse → review → confirm, with nothing written until you confirm
- `.zip` detection: tells you to extract the `_chat.txt` rather than failing cryptically
- `looksLikeWhatsAppExport` guard rejects non-WA files before parsing
- Staged payload stored in `import_batches.staged_messages`, cleared on commit
- Conversation transcript view with date separators, day-grouped, paginated
- **Verified:** 8-message iOS export → 8 stored with correct direction, media
  placeholder and emoji intact → identical re-import inserted **0**

**Contacts:**
- List with search, detail page with editable relationship intelligence
- Every AI-inferred field is user-editable and user edits always win
- Cascade delete (contact → conversations → messages → memories) behind confirmation

**AI intelligence (runs on the user's own key):**
- `src/lib/ai/prompts.ts` — style profiling, reply generation, memory extraction
- Prompt-injection defence: transcripts are labelled untrusted data in every prompt
- `parseJsonResponse` handles code-fenced / malformed model output defensively
- Style scoping: global profile (`user_style_profiles`) **and** per-contact
  `communication_style`, so tone with your mother and your manager differ
- Memory extraction writes with `provenance` (confirmed vs inferred) and a
  unique index on `md5(normalized)` so repeated extraction doesn't duplicate

**Assistant page:** pick a conversation, optional intent, generate 1–3 distinct
reply options with angle labels and copy buttons. Style-profile refresh and
memory extraction are wired to the same page.

### ✅ Built since — settings, memory editing, semantic search, UI

**Settings (`/settings`, `/settings/ai`)**
- Profile (display name, timezone), security (password change), account deletion
  behind a typed `DELETE MY ACCOUNT` confirmation that wipes 15 tables then the
  auth user.
- Provider form with live validation: the key is proven against the provider's
  real API *before* it is encrypted and stored. Credential list supports test
  connection and removal, each with inline success/error feedback.
- Status mapping is honest: `invalid` / `quota_exhausted` / `rate_limited` /
  `error` are distinct stored states, not one generic failure.

**Memory editing (`/memory`)** — edit content, retype, flip provenance between
inferred and confirmed, confirm in one click, delete with confirmation.

**Semantic search** — `src/lib/ai/semantic.ts` embeds messages through the user's
own embedding-capable credential, pins vectors to the credential that produced
them, and calls `match_messages` over the HNSW index. When the user's provider
cannot embed (e.g. Anthropic), the UI says so and runs exact-text search only —
it never presents keyword results as semantic ones.

**Reply → send on `/assistant`** — drafts can be edited then sent through a real
connected WhatsApp Business number. The button is disabled with a stated reason
when no send path exists; the personal bridge is import-only by design and says so.

**UI/UX pass**
- Command palette (⌘K / Ctrl+K) with fuzzy subsequence ranking.
- Three-state theme control (light / dark / system) persisted in `localStorage`
  with a pre-paint script so there is no flash of the wrong theme.
- Route-level `loading.tsx` skeletons on 11 routes, `error.tsx` boundary,
  `global-error.tsx`, and a real `not-found.tsx`.
- Dashboard rebuilt: greeting from the profile, a setup checklist derived from
  real state, recent conversations, recent memories, provider status strip.
- Conversations list now shows a last-message preview and provenance labels that
  say where a thread came from instead of implying an account type.
- **No dead OAuth button:** the Google button only renders when Supabase reports
  the provider as enabled. Google is now enabled on this project and the button
  is live — the test asserts whichever state Supabase reports rather than
  hardcoding an assumption.

### ✅ Proven against a live model

Every AI path was executed for real against Google's API, not simulated. What
that exercise found and fixed — each of these was a genuine defect:

| Found | Fix |
|---|---|
| Gemini 3.x returned **empty text** with `finishReason: STOP` | `thinkingConfig.thinkingBudget` — the thought budget was consuming `maxOutputTokens`. Load-bearing: without it `text=""`, with it text is produced. |
| A 429 told users **"top up your provider"** when they had simply hit a free-tier daily cap | Error classifier now distinguishes free-tier limits, names the reset time, and suggests another model instead of a purchase. |
| One malformed date (`"2025-02"`) **failed an entire memory batch** | Tolerant date normaliser + per-row fallback; one bad row can no longer discard the rest. |
| Memories filled with **paraphrases of one fact** | Jaccard near-duplicate suppression before insert. |
| Every memory scored **100% confidence** and event dates landed in the **past** | Prompt now receives today's date, resolves relative dates forward, and calibrates confidence. Dates moved from `2025-05-18` to `2026-11-15`; confidence now spreads 0.70–0.95. |
| The model **certified its own memories as "confirmed"** | Provenance is forced to `inferred` in code. Only the user can confirm, via `/memory`. |
| Reply generation pulled the **oldest** 200 messages | Most-recent 120, then re-sorted chronologically — in a long thread the model previously never saw the message it was replying to. |
| One insert **per memory** | Single batched insert; falls back to per-row only on conflict. |
| Transient 5xx / timeouts surfaced as **"Unexpected error"** | Retry with backoff on transient kinds only; network and timeout errors are now classified. |
| The conversation selector **silently reset** after generating, so the drafts on screen belonged to someone else | React 19 resets form fields after an action; the select is keyed on the effective value so the control cannot contradict the drafts. |

Measured: chat p50 **553 ms** (range 332 ms – 2.3 s), embeddings **180 ms**.
Verified output on the demo thread — drafts came back as
*"whatever, just bring him along if i want to judge him properly"*, referencing
"the darkroom guy" from that specific conversation, in the learned lowercase voice.

### 🚧 Deployment

Vercel project `nexora` exists with all environment variables set and a fresh
production encryption key. The build is committed and ready. **Pushing the code
is the one remaining step** — it needs a credential this session does not have.
See SETUP.md §6.

## The WhatsApp reality

Two paths exist. Neither is a magic solution, and this project never pretends otherwise.

**1. Official Cloud API** — works only on a dedicated *business* number. That
number cannot be your personal WhatsApp account, and the API cannot read your
existing personal chats. It receives only messages sent *to the business number*.
Requires Meta Business verification. ToS-compliant, no ban risk.

**2. Personal bridge** — runs on your own machine against your own account via
`whatsapp-web.js` (reference client in `bridge-example/`). This **does** reach a
personal account and its history, and it **is** a violation of WhatsApp's ToS
that can get the number banned. NEXORA hosts only the ingest endpoint, never the
automation, and gates token issuance behind four explicit risk acknowledgements
recorded in the database (`risk_acknowledged_at`, version
`2026-11-personal-bridge-v1`).

**3. Manual export import** — always available, zero risk. WhatsApp → chat →
*More* → *Export chat* → upload `.txt`. Parser is built and tested (15/15): participant
detection, system-line filtering, media placeholders, dedupe, per-line error reporting.

### Backend implementation

| File | Responsibility |
|---|---|
| `src/lib/whatsapp/cloud-api.ts` | Graph API client, error classification, webhook parsing, HMAC verify |
| `src/lib/whatsapp/ingest.ts` | Webhook → contact → conversation → message, triple-layer idempotency |
| `src/lib/whatsapp/send.ts` | Outbound send with honest 24-hour window enforcement |
| `src/lib/whatsapp/bridge.ts` | Token issue/revoke/resolve, consent contract, risk text |
| `src/app/api/whatsapp/webhook/route.ts` | Meta verification handshake + signed ingest |
| `src/app/api/whatsapp/bridge/ingest/route.ts` | Bearer-token ingest for the personal bridge |
| `bridge-example/bridge.mjs` | Reference bridge client (user-run) |

**Cloud API limitations surfaced in the UI, not hidden:** free-text replies only
within 24h of the contact's last message; outside that window Meta requires a
pre-approved template; the integration cannot see personal chats at all.

---

## Running locally

```bash
cd /home/user/nexora
npm install
npm run dev          # http://localhost:3000
```

`node_modules/` is not captured in workspace snapshots — reinstall after a fresh session.

### Environment (`.env.local`)

| Variable | Scope | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public | Safe |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | public | Safe — RLS enforces isolation |
| `SUPABASE_SERVICE_ROLE_KEY` | **server-only** | Bypasses RLS; never import client-side |
| `NEXORA_ENCRYPTION_KEY` | **server-only** | 32-byte AES master key. Rotating invalidates stored credentials |
| `GEMINI_API_KEY` | **local test only** | Used exclusively by `scripts/test-provider-live.mjs`. The app never reads it — real AI keys are per-user and encrypted in the database |

### Tests

```bash
npx tsc --noEmit                      # typecheck
npm run build                         # production build, 23 routes
npx tsx scripts/test-parser.ts        # 15 assertions — WhatsApp parser

node scripts/test-column-lockdown.mjs # 8 — secret columns unreadable by a real user JWT
node scripts/test-semantic.mjs        # 10 — pgvector round-trip, isolation, threshold
node scripts/test-auth-e2e.mjs        # 27 — real login, all pages, search, onboarding gate
node scripts/test-ui.mjs              # 27 — palette, theme, 404, a11y, mobile nav
node scripts/test-auth-pages.mjs      # 17 — OAuth button state, callback guards

# Live model suites — these call Google for real and cost tokens.
GEMINI_API_KEY=... npx tsx --conditions=react-server \
  --import ./scripts/server-only-stub.mjs scripts/test-provider-live.mjs
                                      # 21 — key, chat, thinking regression,
                                      #      embeddings, style, replies,
                                      #      memories, semantic search

node scripts/screenshot.mjs           # 17 screenshots, light + dark + mobile
```

`--conditions=react-server` is what lets a Node script import modules that carry
`import 'server-only'`. It resolves the package's `empty.js` branch instead of the
file that throws. The guard is never weakened — TypeScript files stay untouched.

All suites pass against the live Supabase project and a live Google key.
Latest run: **27 / 27** auth, **27 / 27** UI, **17 / 17** auth pages,
**21 / 21** live provider, **10 / 10** semantic, **8 / 8** lockdown,
**15 / 15** parser — **125 assertions, 0 failures**.

---

## Security model

Defence in depth — every layer assumes the one above it may fail:

1. **Middleware** — session revalidation on every protected route via `getUser()`.
2. **Onboarding gate** — the app is unreachable without a validated AI credential.
3. **RLS on all 12 tables** — `auth.uid() = user_id` on every policy. The database
   rejects cross-tenant access even if application code is compromised.
4. **Service-role usage is explicit and pinned** — every admin query carries
   `.eq('user_id', userId)`; code comments mark it as bypassing RLS.
5. **Keys encrypted at rest** — AES-256-GCM, master key never touches Postgres.
   Plaintext exists only in server process memory for the duration of one request.
6. **No key ever reaches the browser** — the client sees only `provider`, `model`,
   and `key_last4`.
7. **Redaction** — error paths strip `sk-…`, `sk-ant-…`, `AIza…` patterns before logging.
8. **Generic auth errors** — sign-in never reveals whether an email is registered.

---

## Architecture notes

**Provider adapters** (`src/lib/ai/providers.ts`) — one object per provider, each
implementing `validate()`, `chat()`, and optionally `embed()`. Adding a provider is
one object, not a refactor. `openai_compatible` covers Groq, Together, OpenRouter,
vLLM, and Ollama via a base URL.

**Embeddings are credential-scoped** (`message_embeddings.credential_id`) so vectors
from different providers/models never get compared — that would produce meaningless
similarities.

**`match_messages()`** is `security invoker`, so RLS still governs every row it
touches even though it's a SQL function.

**Parser design** — two-stage regex (timestamp prefix, then sender/body) rather than
one combined pattern. A single pattern cannot distinguish "system line" from
"message with no body", which is exactly the bug that silently ate users' own
messages during development.
