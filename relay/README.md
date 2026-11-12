# NEXORA WhatsApp agent — live personal WhatsApp

Links **your own** WhatsApp number to NEXORA as a linked device, the same way
WhatsApp Web does. Messages arrive in NEXORA as they are sent, and NEXORA can
answer them in your voice.

There is nothing to install and no terminal in the user-facing flow. The agent
runs on a host you control, holds the WhatsApp session, and polls NEXORA over
outbound HTTPS. The pairing code appears **inside NEXORA**; you type it into
WhatsApp and you are live.

> Hosting instructions, including a one-click Render blueprint, are in
> [HOSTING.md](./HOSTING.md).

---

## How to link it

1. In NEXORA, open **Integrations → Personal WhatsApp → Get started**.
2. Enter your number with the country code (`919876543210`).
3. Tick the four risks, type `I understand the risks`, and press **Create
   pairing code**.
4. NEXORA shows an 8-character code. The page refreshes itself; you do not
   press anything.
5. On your phone: **WhatsApp → Settings → Linked devices → Link a device →
   Link with phone number**, then type that code.

The page switches to **linked** on its own and starts showing messages. The
agent keeps the session, so closing your browser changes nothing.

To disconnect, press **Disconnect** in NEXORA. The agent is told immediately and
drops the WhatsApp session.

## What it does and does not do

| | |
|---|---|
| **Reads** | Messages sent to you and from you while it is running |
| **Sends** | AI replies and anything you queue in NEXORA |
| **Never reads** | History from before you linked (export a `.txt` to import that), encrypted backups, your password, or your 2FA |
| **Never sends** | Auto-replies in group chats — groups are stored, never answered |
| **Does not store** | Your WhatsApp session, on any server. It stays in `./auth` on your machine |

## Auto-reply

Off until you switch it on. When on, it answers **one-to-one chats only**, and
every reply is written by your own AI provider using your style profile.

Guard rails, all enforced server-side:

- one answer per inbound message, claimed atomically (multiple instances cannot
  both answer the same message)
- stands down if you already replied from your phone
- 6 auto-replies per chat per hour, 40 per account per hour
- a configurable pause (default 4s) before each send
- no commitments, no OTPs, no money, no passwords — baked into the prompt
- auto-pauses itself after 5 consecutive send failures
- **Ask me before sending** mode, which holds drafts in the app for approval

## Restarting and reconnecting

Nothing to re-run. The agent reconnects on its own after a restart, and the
session survives redeploys because it lives on a persistent disk.

If the link does drop, open **Integrations → Personal WhatsApp** and press
**Reconnect**. That hands the agent a fresh claim for the number already on
file; re-pairing only happens if WhatsApp itself removed the device.

## ⚠️ This can get your number banned

Automating a personal WhatsApp account violates WhatsApp's Terms of Service.
Meta can suspend or permanently ban the number, and there is no appeals process
that will help you. NEXORA shows this warning, requires explicit consent, and
labels every relayed message with its provenance — but the risk is yours.

If you need WhatsApp connectivity without that risk, use the **WhatsApp
Business Cloud API** card instead: official, stable, and it cannot touch your
personal number.

## How it works

```
your phone ── linked device ──▶ agent.mjs (your host)
                                     │  POST /api/whatsapp/agent/poll
                                     ▼
                              NEXORA (Next.js + Supabase)
                                     │  AI reply, queued
                                     ▼
                            replies ride back on the next poll
```

Every connection is outbound, so the agent needs no public address and no
inbound firewall rule. It polls every few seconds; a reply that cannot be sent
while the socket is down stays queued instead of being lost.
