# Where NEXORA stands, and the one step left

Everything the app promises now runs for real. The only thing between you and a
working WhatsApp link is hosting one small process — the agent — because Vercel
can't hold a WhatsApp socket open.

---

## What is done and verified

| Area | State |
| --- | --- |
| Import your own `WhatsApp Chat with …txt` | works in production |
| Parser | 21/21 |
| Live WhatsApp link, pairing, messages, AI replies, approval, disconnect | **48/48 on production** and 48/48 locally with a real agent |
| Hosted-agent contract (token upgrade, reply round trip, revoke) | 19/19 |
| Pairing with nothing typed in a terminal | 9/9, real browser + real agent + real WhatsApp code |
| Auth pages | 17/17 |
| Retrieval (pgvector) | 10/10 |
| UI, mobile, a11y | 27/27 |
| Live provider calls | 21/21 |

The pairing code appears **inside the page**. There is no shell command anywhere
in the flow — a test asserts exactly that.

### Real bugs found and fixed this round

1. `whatsapp_integrations` had lost its `SELECT` grant, so every integration page
   was broken. Restored, column-scoped so the encrypted secret columns stay
   unreadable.
2. The waiting card never refreshed, so the code would never have appeared. It
   now polls while it waits.
3. With no agent configured the page spun "Generating your code…" forever and
   wrote a claim nobody could adopt. It now says what is wrong and changes
   nothing.
4. A refused adopt left the same dead spinner. Failed adopts are now undone.
5. The always-on agent minted a **new** pairing code every ~27 seconds when a
   pairing was never completed, silently killing the code on screen. Pairing
   attempts are now bounded; a link that has connected still reconnects forever.
6. `requestPairingCode` could run on an already-closed socket.
7. `auto_reply_require_approval` defaulted to `false` in the database while the
   UI showed it ticked. The database now matches the screen.
8. A 401 from the poll API was treated as "unlinked", so a transient token
   mismatch logged the user out of WhatsApp. Revoked and unknown tokens are now
   distinct.

---

> **If the Render dashboard showed no Blueprint:** that was a real mistake on my
> side, now fixed. Render only discovers a file named exactly `render.yaml` in
> the **root** of the repository, and it was in `relay/`. It is at the root now
> (commit `1852890`), so **refresh the New → Blueprint page** and it will appear.

## The one step left: host the agent (≈2 minutes, once)

### 1. Deploy the agent on Render

1. Open **https://dashboard.render.com/blueprints**
2. Click **New Blueprint Instance**
3. Choose the **NEXORA** repository (`waraadil/NEXORA`) and branch `main`
4. Render reads `render.yaml` at the repository root: one **free** web service, no
disk. Nothing to pay for, no card needed.
5. Click **Apply** and wait for the first build (~2 minutes)

### 2. Copy two values from Render

- The service URL — like `https://nexora-whatsapp-agent.onrender.com`
- **Environment → `NEXORA_AGENT_SECRET`** (Render generated it)

### 3. Put them in Vercel

Project `nexora` → **Settings → Environment Variables**:

| Key | Value |
| --- | --- |
| `NEXORA_AGENT_URL` | the Render service URL |
| `NEXORA_AGENT_SECRET` | the value Render generated |

`NEXORA_AGENT_SECRET` is already there — check it matches Render's, and replace
it if Render generated its own. Then redeploy (Git → Redeploy, or push anything).

### 4. Send me the two values

`NEXORA_AGENT_URL` and `NEXORA_AGENT_SECRET`, and I'll set them, redeploy, and
verify the whole flow against production myself — including a real pairing code
in the page.

### Why the free plan is now enough

Render's free instances cannot attach a disk at all — that was the thing asking
for money, not the compute. The disk was never load-bearing: the WhatsApp
session is already stored encrypted in Supabase, and the agent now asks
`/api/whatsapp/agent/links` which links it should hold whenever it boots. So a
free instance that loses its filesystem comes back **linked**, with no re-pair.
That is proven by `scripts/test-agent-resume.mjs`, which deletes the agent's
directory, restarts it with only `NEXORA_AGENT_TOKEN` in the environment, and
asserts the link returns and the log says `↻ resuming …`.

The one real limit left: a free instance sleeps after ~15 minutes with no
inbound traffic, which drops the socket. `GET /api/whatsapp/agent/wake` exists
to prevent exactly that — it pings the agent's `/health` and is safe for any
caller to hit. `vercel.json` schedules it twice a day, which is **not** enough
on its own (Vercel Hobby crons are daily-only). Until an external pinger runs
every ~10 minutes, expect the agent to be asleep after 15 idle minutes and to
wake on the next visit to the app.

---

## Everything else that is left

- **GitHub repo metadata** (description, topics, website link) — your PAT can't
  edit repository settings. Either add them yourself under Settings, or give me
  a token with `Administration: write`. The README, history and structure are
  already professional; only the sidebar fields are blank.
