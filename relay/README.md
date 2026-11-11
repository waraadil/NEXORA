# NEXORA relay — live personal WhatsApp

Links **your own** WhatsApp number to NEXORA as a linked device, the same way
WhatsApp Web does. Messages arrive in NEXORA as they are sent, and NEXORA can
answer them in your voice.

No install, no npm account, no global package:

```bash
NEXORA_URL=https://your-app.vercel.app NEXORA_PAIRING_CODE=nxr_relay_… \
  node -e "const f=require('os').tmpdir()+'/nexora-relay.mjs';require('https').get('https://raw.githubusercontent.com/waraadil/NEXORA/main/relay/nexora-relay.mjs',r=>{const s=require('fs').createWriteStream(f);r.pipe(s);s.on('finish',()=>require('child_process').spawn(process.execPath,[f],{stdio:'inherit'}).on('exit',c=>process.exit(c||0)))})"
```

You never type this by hand — NEXORA generates it with your URL and key
already filled in. It downloads the relay on first run (about a minute),
then reuses it. State lives in `~/.nexora-relay`.

---

## How to link it

1. In NEXORA, open **Integrations → Personal WhatsApp → Get started**.
2. Enter your number with the country code (`919876543210`).
3. Tick the four risks, type `I understand the risks`, and press **Create
   pairing code**.
4. Copy the command the page shows into a terminal. Needs **Node 20+**.
5. The relay prints an 8-character code.
6. On your phone: **WhatsApp → Settings → Linked devices → Link a device →
   Link with phone number**, then type that code.

The NEXORA page switches to **linked** within about 20 seconds and starts
showing messages. Keep the terminal window open — that process is the link.

Closing it stops new messages arriving; restarting with the same command
reconnects without pairing again.

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

## Restarting later

Re-run the same command NEXORA generated — it reconnects without pairing
again. The relay itself lives in `~/.nexora-relay/relay.mjs` if you prefer to
call it directly.

Your key is under **Integrations → Personal WhatsApp → Your pairing key**
(reveal it with the disclosure) or in the command shown on that page. Lost it?
Disconnect and pair again — it takes a minute.

`node ~/.nexora-relay/relay.mjs --reset` clears the local session and forces a fresh pairing.

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
your phone ── linked device ──▶ relay.mjs (your machine)
                                     │  POST /api/whatsapp/relay/sync
                                     ▼
                              NEXORA (Next.js + Supabase)
                                     │  AI reply, queued
                                     ▼
                     POST /api/whatsapp/relay/pending ──▶ relay sends it
```

The relay polls for outbound work every 4 seconds. A reply that cannot be sent
while offline stays queued instead of being lost.
