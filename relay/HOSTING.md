# Hosting the WhatsApp agent

The agent is a single Node process that keeps your personal WhatsApp linked — like
WhatsApp Web — and talks to NEXORA over outbound HTTPS only. It needs no open
ports, no inbound firewall rule and no public IP. NEXORA calls it exactly once,
when a pairing starts.

You only do this **once**. After that, every pairing is: type your number in
NEXORA → type the code NEXORA shows into WhatsApp → done.

---

## Option A — Render (recommended, no card for the free tier)

1. Push this repo (already pushed) and open
   **Render Dashboard → New → Blueprint**.
2. Pick the `NEXORA` repo. Render reads `relay/render.yaml` and shows one web
   service plus one 1 GB disk.
3. Click **Apply** and wait for the first build (~2 minutes).
4. Open the service → **Environment** and copy the generated
   `NEXORA_AGENT_SECRET` value.
5. Copy the service URL — it looks like
   `https://nexora-whatsapp-agent.onrender.com`.
6. Set both values on Vercel (below).

> The **free** instance sleeps after 15 minutes of inactivity, which drops the
> WhatsApp socket. If you want true 24/7, switch the service to the **Starter**
> plan (\$7/month) — no code changes, no redeploy needed.

## Option B — any VPS you already own

```bash
git clone https://github.com/waraadil/NEXORA.git && cd NEXORA/relay
npm install --omit=dev
NEXORA_URL=https://nexora-zeta-red.vercel.app \
NEXORA_AGENT_SECRET='<a long random string>' \
NEXORA_AGENT_DIR=/var/lib/nexora-agent \
npm start
```

Keep it alive across reboots with systemd:

```ini
# /etc/systemd/system/nexora-agent.service
[Unit]
Description=NEXORA WhatsApp agent
After=network-online.target

[Service]
WorkingDirectory=/opt/NEXORA/relay
Environment=NEXORA_URL=https://nexora-zeta-red.vercel.app
Environment=NEXORA_AGENT_SECRET=<same secret>
Environment=NEXORA_AGENT_DIR=/var/lib/nexora-agent
ExecStart=/usr/bin/node agent.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now nexora-agent
```

## Step 2 — point NEXORA at the agent

Set these on the Vercel project (`nexora`), for **Production** and **Preview**:

| Variable               | Value                                            |
| ---------------------- | ------------------------------------------------ |
| `NEXORA_AGENT_URL`     | the agent's public URL, e.g. `https://…onrender.com` |
| `NEXORA_AGENT_SECRET`  | the same secret the agent was started with        |

Then redeploy. From that moment the integrations page shows a real WhatsApp
code instead of "No WhatsApp agent is running for this deployment".

## Verifying it honestly

```bash
curl -s https://<agent-url>/health
# {"ok":true,"links":[]}
```

`links` lists the WhatsApp sessions currently held. An empty list with
`"ok":true` means the agent is up and waiting for a pairing — it is **not**
proof that any account is linked. The only proof of a link is a code appearing
in NEXORA after you press *Create pairing code*.

## Security notes

- The agent authenticates to NEXORA with a claim token that expires in 15
  minutes, upgraded once to a long-lived agent token stored only as a SHA-256
  hash. Disconnecting in NEXORA revokes it immediately.
- `NEXORA_AGENT_SECRET` only authorises "please pair this number". It never
  grants read access to anyone's messages.
- The WhatsApp session on disk is the login. Treat the host as you would a
  phone: full-disk encryption, no shared shell accounts.
- Baileys is an unofficial WhatsApp client. Linked-device automation is against
  WhatsApp's terms and carries a real chance of an account ban. NEXORA shows
  this risk before pairing and requires an explicit acknowledgement.
