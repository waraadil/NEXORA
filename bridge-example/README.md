# Personal WhatsApp bridge — what this is and is not

## The two paths, honestly compared

| | Official Cloud API | Personal bridge |
|---|---|---|
| Works on your **personal** number | ❌ No | ✅ Yes |
| Can read your **existing** chats | ❌ No | ✅ Yes |
| Requires Meta Business verification | ✅ Yes | ❌ No |
| ToS compliant | ✅ Yes | ❌ **No** |
| Ban risk | None | **Real** |
| Who runs the automation | Meta | You, on your machine |
| Message the contact first | Only with approved templates | Yes, free text |
| Support if it breaks | Meta docs | Nobody |

There is no third option. Any product claiming live personal WhatsApp sync is
either doing the right-hand column or lying about it.

## Contract

Your bridge POSTs to `POST /api/whatsapp/bridge/ingest`:

```http
Authorization: Bearer nxr_br_<your token>
Content-Type: application/json
```

```json
{
  "chat": { "id": "919876543210@c.us", "name": "Asha", "isGroup": false },
  "messages": [
    {
      "id": "ABCDEF123",
      "fromMe": false,
      "senderName": "Asha",
      "body": "hey, did you book the tickets?",
      "timestamp": 1762800000
    }
  ]
}
```

**Response:** `{ ok, inserted, duplicates, conversationId }`

### Rules the endpoint enforces

- `messages[]` capped at 500 per batch → `413` beyond that
- `chat.id` and `messages[]` required → `400`
- Token must resolve to a `connected` `personal_bridge` integration → `401`
- **Duplicate messages are counted and skipped**, never inserted twice
  (dedupe key: `provider_message_id = bridge:<id>`)
- Conversation rollups (`message_count`, `first_message_at`, `last_message_at`)
  are recomputed from the messages table, not incremented — so replays can't
  corrupt counts

### Verified behaviour

Run against the live endpoint:

```
POST 3 messages          → { ok:true, inserted:3, duplicates:0 }
POST identical batch     → { ok:true, inserted:0, duplicates:3 }
bad token                → 401
```

Rows persisted with correct direction (`is_from_me`), a conversation was
auto-created with `source = 'personal_bridge'`, and the message count stayed
at 3 after the replay.

## Running the reference implementation

```bash
mkdir nexora-bridge && cd nexora-bridge
npm init -y
npm i whatsapp-web.js qrcode-terminal
cp /path/to/bridge-example/bridge.mjs .

NEXORA_TOKEN=nxr_br_… NEXORA_URL=https://your-app.vercel.app node bridge.mjs
```

Scan the QR: WhatsApp → **Linked devices** → Link a device.

### Operational notes

- **Do not backfill aggressively.** Bulk history reads are the fastest way to
  get flagged. The reference script leaves backfill commented out with a rate
  limit; enable it deliberately, once.
- **A linked device is visible** in the user's WhatsApp UI. The account holder
  can see it and unlink it — which stops the bridge.
- **WhatsApp updates break unofficial clients** regularly. When it breaks, the
  fix is yours to find.
- **Revoking is instant.** NEXORA → Integrations → Disconnect clears the token
  hash; any held token stops working on the next request.

## Data responsibility

Messages pushed through this bridge are:
1. stored in your NEXORA Postgres database,
2. sent to **your** AI provider for style analysis and memory extraction.

The people in those conversations did not consent to that. Depending on your
jurisdiction you are the data controller for that processing. NEXORA records
the consent you gave (`risk_acknowledged_at`, version
`2026-11-personal-bridge-v1`) but cannot obtain consent from your contacts.
