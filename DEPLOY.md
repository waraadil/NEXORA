# Where NEXORA stands, and how to pair your number

Everything the app promises now runs for real, on free tiers, with nothing for
you to install or run.

**It costs $0.** Render's free tier is enough now: the agent carries nothing on
its disk, so it comes back linked after a free instance sleeps or restarts. No
Starter plan, no card.

**The agent is deployed and wired.** `https://nexora-whatsapp-agent.onrender.com`
answers `/health`, and production reaches it:

```
GET https://nexora-zeta-red.vercel.app/api/whatsapp/agent/wake
→ {"ok":true,"links":0,"ms":305}
```

`NEXORA_AGENT_URL` and `NEXORA_AGENT_SECRET` are set on the Vercel project and a
deployment carrying them is live. The Render secret was verified against the
service before being stored (a wrong secret answers `401 bad secret`; the one now
in Vercel is accepted).

A real pairing was then driven through the live site against the live agent and
worked first time — the code appeared in the page in 16 seconds, the database
stored it, and the agent reported holding the same link. All that is left is for
you to do it with your own number.

---

## What is done and verified

| Area | State |
| --- | --- |
| Import your own `WhatsApp Chat with …txt` | works in production |
| Live WhatsApp link → real code in the live page, against the live agent | **verified 2026-11-12** (`CMYV-JB7E`, 16s, no JS errors) |
| Relay HTTP path (no agent attached) | 46/46 locally (+2 agent-only skips) |
| Hosted-agent contract (token upgrade, reply round trip, revoke) | 19/19 |
| Resume after a diskless restart | 16/16 |
| Pairing with nothing typed in a terminal | 9/9, real browser + real agent + real WhatsApp code |
| The shipped agent vs real WhatsApp | 4/4 |
| Auth pages | 17/17 |
| Retrieval (pgvector) | 10/10 |
| UI, mobile, a11y | 28/28 |
| Parser / RLS + encryption at rest | 21/21 · 8/8 |

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

## Pair your number (about a minute, in the browser)

1. Open **https://nexora-zeta-red.vercel.app/integrations**
2. Press **Get started** under Personal WhatsApp
3. Type your number with the country code (`91…` for India), tick the four
   consent boxes, type `I understand the risks`
4. Press **Create pairing code** — the code appears **in the page**
5. On your phone: **WhatsApp → Linked devices → Link a device → Link with phone
   number**, then type the code

The page flips to "linked" on its own. No terminal, no command, nothing to
download.

### If the agent was asleep

A free instance can be cold when you arrive, so the first press may take up to a
minute while Render wakes it. The page says so rather than spinning forever —
press it again if it times out.

### Why the free plan is now enough

Render's free instances cannot attach a disk at all — that was the thing asking
for money, not the compute. The disk was never load-bearing: the WhatsApp
session is already stored encrypted in Supabase, and the agent now asks
`/api/whatsapp/agent/links` which links it should hold whenever it boots. So a
free instance that loses its filesystem comes back **linked**, with no re-pair.
That is proven by `scripts/test-agent-resume.mjs`, which deletes the agent's
directory, restarts it with only `NEXORA_AGENT_TOKEN` in the environment, and
asserts the link returns and the log says `↻ resuming …`.

### Staying awake, without anything to run

A free instance sleeps after ~15 minutes with no inbound traffic, which drops
the socket. Three things keep it up, and none of them cost anything:

1. **The agent pings itself.** `relay/agent.mjs` reads `RENDER_EXTERNAL_URL`
   (injected by Render) and GETs its own `/health` every 10 minutes. Through
   Render's proxy that is an ordinary inbound request, so it resets the idle
   counter exactly like a visitor. Verified locally: 5 requests in 20 s at a 3 s
   interval, every one landing on the listener.
2. **`GET /api/whatsapp/agent/wake`** on the app pings the agent from outside,
   and `vercel.json` schedules it twice a day as a backstop. Vercel Hobby crons
   are daily-only, so this is a safety net, not the primary clock.
3. **Every use of the app** touches the agent, so real usage keeps it warm.

If Render ever stops counting its own outbound self-request as inbound traffic,
the fallback is `pinger.mjs` — a dependency-free process you can run on any
always-on box, or point a free cron service at
`https://nexora-whatsapp-agent.onrender.com/health` every 10 minutes. It is not
needed today.

---

## Everything else that is left

- **GitHub repo metadata** (description, topics, website link) — your PAT can't
  edit repository settings. Either add them yourself under Settings, or give me
  a token with `Administration: write`. The README, history and structure are
  already professional; only the sidebar fields are blank.
