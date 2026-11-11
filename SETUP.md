# NEXORA — Your Setup Checklist

Everything below is a step **only you can do**, because each one needs a secret or a
console account. The code paths are already built and tested against fakes; these steps
make them real.

Do them in this order. Steps 1–2 unblock the most.

| # | Task | Time | Unblocks |
|---|------|------|----------|
| 1 | Google OAuth client | ~10 min | "Continue with Google" button |
| 2 | An AI provider API key | ~5 min | Reply drafting, memory extraction, semantic search |
| 3 | WhatsApp Cloud API | ~1–3 days | Live WhatsApp messaging (business number) |
| 4 | Optional: personal bridge | ~15 min | Your own personal chats (risk on you) |
| 5 | Optional: production email | ~15 min | Signup confirmation emails that aren't rate-limited |
| 6 | Deploy (later) | ~20 min | Being on the internet |

---

## 1. Google sign-in

**First — an important correction.** You told me you bought a "Google Cloud subscription."
Google Cloud has **no subscription needed for OAuth**. Sign-in with Google is free at any
scale; you only pay for things like VM/compute, Maps, or Vertex AI. And NEXORA does **not**
use Google Cloud for AI — there is no shared key, every user brings their own.

So before you spend anything, check what you actually bought:

- If it was **Google Cloud Platform** billing → you probably don't need it. It's harmless,
  but it won't make OAuth work any differently.
- If it was **Google Workspace** → that's per-user email/productivity, also not needed here.
- If it was **Google AI Pro / Gemini** (a consumer subscription) → **cannot be used**. That
  is a consumer product; its credentials don't work as an API key. If you want Google as
  your AI provider you need a **Gemini API key** from Google AI Studio (step 2), which has
  a free tier.

You can refund or downgrade whatever you bought if it turns out you don't need it. Nothing
in this project depends on it.

### Make the OAuth client (free)

1. Go to **https://console.cloud.google.com/** and sign in.
2. Top bar → project dropdown → **New Project**. Name it `nexora`, click **Create**.
   Make sure the project selector now shows `nexora`.
3. In the search bar type **"OAuth consent screen"** and open it. (Google renamed this
   area to **Google Auth Platform** in 2025 — if you see "Get started" instead of a form,
   that's the new flow, same thing.)
4. Click **Get started** / fill the form:
   - **App name:** `NEXORA`
   - **User support email:** your email
   - **Audience / User type:** **External**
   - **Contact information:** your email
   - Agree to the policy → **Create**.
5. Left sidebar → **Clients** (or **Credentials**) → **Create client**
   (or **Create Credentials → OAuth client ID**).
6. **Application type: Web application**. Name it `NEXORA Web`.
7. Under **Authorized JavaScript origins**, add:
   ```
   http://localhost:3000
   ```
8. Under **Authorized redirect URIs**, add — **this exact value, it is not your app's URL**:
   ```
   https://qxdxmigcyxyabjreorfz.supabase.co/auth/v1/callback
   ```
9. Click **Create**. Copy the **Client ID** and **Client Secret**.

> The redirect URI points at **Supabase**, not NEXORA. Google redirects to Supabase,
> Supabase redirects back to your app at `/auth/callback`. Getting this wrong is the
> single most common reason Google sign-in fails with `redirect_uri_mismatch`.

### Turn it on in Supabase

10. Open **https://supabase.com/dashboard/project/qxdxmigcyxyabjreorfz/auth/providers**
11. Find **Google** → toggle **Enable**.
12. Paste the **Client ID** and **Client Secret** → **Save**.

### Verify it works

13. Open your app at `http://localhost:3000/login` and refresh.
    The button should now appear (it is hidden whenever Supabase reports the provider as
    off — that's why you saw the "not enabled" notice earlier).
14. Click it, pick a Google account, and you should land back inside NEXORA signed in.

**While the app is in "Testing" publishing status**, only Google accounts you add as test
users can sign in. Add them under **Google Auth Platform → Audience → Test users**. To let
anyone in, click **Publish app** — for the basic scopes NEXORA uses (email + profile) Google
does not require a full verification review.

I can enable the Supabase side for you once you have the Client ID and Secret — just say
the word and paste them, or do it yourself at the link above.

---

## 2. An AI provider key

NEXORA has **no shared developer key**. Every user enters their own, which is why AI
features are disabled until you add one. Any of these works:

| Provider | Get a key | Cost | Notes |
|----------|-----------|------|-------|
| **Google Gemini** | https://aistudio.google.com/apikey | **Free tier** | **Also does embeddings** → semantic search works |
| **OpenAI** | https://platform.openai.com/api-keys | Paid | Also does embeddings |
| **Anthropic** | https://console.anthropic.com/settings/keys | Paid | **No embedding model** → semantic search unavailable |
| Groq / OpenRouter / Together | their dashboards | Often free | Use the "OpenAI-compatible" option |

**My recommendation for you: Google Gemini.** It has a genuinely usable free tier and it
supports embeddings, so you get both reply generation *and* semantic search without paying.

### Add it

1. Open **http://localhost:3000/settings/ai**
2. Choose the provider, choose a model.
3. Paste the key → **Validate & save**.

The key is sent to the provider **once, live** to prove it works, then encrypted with
AES-256-GCM and stored. It never goes back to the browser.

> If you already have a Gemini key from AI Studio, note it starts with `AIza…`. A Google
> AI Pro subscription does not produce that key — only AI Studio does.

---

## 3. WhatsApp Cloud API (business number)

This is the only ToS-clean path, and it needs a **phone number that is not currently on
WhatsApp**. A number already in WhatsApp cannot be used. You can use a spare SIM, a
virtual number, or a test number Meta provides.

There is **no subscription** — Meta charges per conversation, and there is a free tier of
1,000 service conversations per month.

1. Go to **https://developers.facebook.com/** → **My Apps** → **Create App**.
2. Choose **Other** → **Business**, name it `NEXORA`.
3. In the app dashboard, find **WhatsApp** → **Set up**.
4. Meta gives you a **test number** immediately with a 24-hour token. Good for trying it.
   For a permanent number: **WhatsApp → API Setup → Add phone number**, verify it.
5. Collect these four values:
   - **Phone number ID** — from API Setup
   - **WhatsApp Business Account ID (WABA ID)**
   - **Permanent access token** — create a System User under
     **Business Settings → Users → System users**, give it the `whatsapp_business_messaging`
     permission, generate a token. *The 24-hour token from API Setup expires and everything
     breaks — use a permanent one.*
   - **App Secret** — **App settings → Basic → App secret**
6. Open **http://localhost:3000/integrations** → WhatsApp Cloud API, and fill in those
   values. NEXORA generates a **verify token** for you — copy it.
7. Back in the Meta app: **WhatsApp → Configuration → Webhook → Edit**.
   - **Callback URL:** `https://YOUR-DEPLOYED-DOMAIN/api/whatsapp/webhook`
   - **Verify token:** the one NEXORA showed you
   - Click **Verify and save**, then **subscribe** to the `messages` field.

**The blocker you'll hit:** Meta cannot call `http://localhost`. The webhook needs a public
HTTPS URL. Two options:

- **Deploy to Vercel** — that's the real answer, and it's step 6. Deploy first, then come
  back and finish the webhook.
- **Temporary tunnel** — `npx ngrok http 3000` gives you a public HTTPS URL you can use as
  the callback while developing. Free, but the URL changes each restart.

**Also know:** WhatsApp only allows free-form replies within **24 hours** of the contact's
last message. Outside that window you must use a pre-approved template. NEXORA enforces this
and will refuse with an explanation rather than silently failing.

---

## 4. Optional — personal bridge (your own WhatsApp)

This works on a personal account by running a small client on **your own machine**. Be clear
on the trade-off before you start:

- It **violates WhatsApp's Terms of Service**.
- **Your number can be banned.** This is a real, documented risk. Use a number you can
  afford to lose.
- NEXORA does not hide this — the setup screen requires four explicit checkboxes and typing
  `I understand the risks` before it will issue a token.

It is **import-only**: it syncs your chats in, it cannot send messages for you. NEXORA will
tell you that instead of pretending to send.

To set it up: **http://localhost:3000/integrations** → Personal bridge → acknowledge the
risk → follow `bridge-example/README.md` (it has a ready-to-run `bridge.mjs`).

Honest recommendation: if you just want your history analysed, the **manual chat export**
(WhatsApp → chat → More → Export chat) is zero-risk, works today, and gives the same
intelligence. The bridge only adds convenience.

---

## 5. Optional — production email

Right now Supabase uses its built-in mailer, which is **rate-limited to a few emails per
hour** and meant for testing only. Since you have `mailer_autoconfirm` on, signup doesn't
need email — but password reset does.

Fix it with any SMTP provider (Resend, Postmark, SendGrid, or Gmail app-password):
**Supabase → Project Settings → Authentication → SMTP Settings**. Takes 10 minutes.
I can wire this for you if you give me the SMTP details.

---

## 6. Deploy — DONE ✅

**Live at https://nexora-zeta-red.vercel.app**

Verified from outside the sandbox:

| Check | Result |
|---|---|
| `GET /` | **HTTP 200**, title "NEXORA — Your conversations. Your intelligence. Your AI." |
| `GET /dashboard` while signed out | **307 → `/login?next=/dashboard`** (middleware guard working) |
| Supabase auth from production | **HTTP 200**, real token issued for the demo account |
| Build | **READY in 41s**, 4 serverless functions (turbopack) |

GitHub: https://github.com/waraadil/NEXORA (4 commits, 122 files, no secrets)

### What was configured

- Vercel project `nexora`, linked to `waraadil/NEXORA`, production branch `main`.
- All six env vars set for production, preview and development, including a
  **fresh** `NEXORA_ENCRYPTION_KEY` distinct from the dev key.
- `NEXT_PUBLIC_APP_URL` = the production alias above.
- Every push to `main` now deploys automatically.

### Still worth doing (2 minutes)

1. **Rotate the GitHub token** — revoke `NEXORA deploy` at
   github.com/settings/personal-access-tokens. It was pasted in chat.
2. ~~Add the domain to Supabase~~ — **done.** `site_url` is
   `https://nexora-zeta-red.vercel.app` and the allow-list covers the production
   alias, branch alias, `localhost:3000-3001`, and the `*.vercel.app` /
   `*.e2b.app` wildcards. Verified: hitting `/auth/v1/authorize?provider=google`
   with the production redirect returns a Google consent URL carrying
   `redirect_to=https://nexora-zeta-red.vercel.app/auth/...`.
3. **Rotate the Google API key** used during testing — it is also in the chat log.

### Encryption key must match the data

`NEXORA_ENCRYPTION_KEY` encrypts each user's provider API key (AES-256-GCM,
`src/lib/crypto.ts`). **It is not a secret you can freely rotate.** Every stored
credential is encrypted with whatever key was active when it was saved; a
different key in production means `decryptSecret()` throws on every request and
`/assistant` dies with *"NEXORA failed to start"*.

Vercel production now uses the same key that encrypted the existing credentials.
If you ever rotate it, you must re-save every API key through `/settings/ai`
while the new key is live.

### Live AI path — verified in production

Signed in as the demo user against `https://nexora-zeta-red.vercel.app` and
generated drafts through the real Gemini API:

| Draft | Angle |
|---|---|
| "bet. are you still dragging her along too?" | casual inquiry |
| "alright. she still coming with you or what?" | direct question |
| "cool. is she tagging along or are you flying solo?" | sarcastic banter |

Send stays disabled with *"no WhatsApp channel is connected"* — correct, honest
behaviour rather than a silent no-op.

### Auth wiring — verified state

| Setting | Value |
|---|---|
| Site URL | `https://nexora-zeta-red.vercel.app` |
| Redirect allow-list | production alias, branch alias, localhost:3000-3001, `*.vercel.app/**`, `*.e2b.app/**` |
| Google OAuth | **enabled** — consent URL resolves with the production redirect |
| Email/password | **enabled**, autoconfirm on |
| Password sign-in from prod | HTTP 200, real token issued |

**One gap that is not a bug:** no SMTP provider is configured, so all auth emails
go through Supabase's built-in sender — roughly 2 per hour, frequently
spam-foldered. Password sign-in is unaffected. If you want reliable
magic-link / password-reset / email-confirmation delivery, add SMTP in
Supabase → Authentication → SMTP (Resend, Postmark, SES — all have free tiers),
and the existing templates will work unchanged.

**Note on `demo@nexora.app`:** `.app` is a real TLD, so Supabase rejects that
address for recovery flows ("Email address is invalid"). It was fine for
sign-in testing but cannot receive mail. Use a real address for any account you
intend to keep.

---

## What I can do for you vs. what needs your hands

**Needs your hands (secrets/consoles):** creating the Google OAuth client, generating the
AI key, Meta app + phone verification, SMTP credentials.

**I can do the moment you hand me values:** enable the Google provider in Supabase, add
SMTP settings, verify the webhook is receiving deliveries, deploy and smoke-test.

**Nothing here requires you to buy anything.** If the Google Cloud purchase turns out to be
unnecessary, cancel it — the OAuth setup above is free.
