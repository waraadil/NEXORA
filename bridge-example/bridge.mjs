#!/usr/bin/env node
/**
 * NEXORA personal WhatsApp bridge — REFERENCE IMPLEMENTATION
 *
 * ⚠️  READ THIS FIRST
 * This script automates a PERSONAL WhatsApp account. That violates WhatsApp's
 * Terms of Service and can get your number permanently banned. NEXORA does not
 * ship or endorse this file — it is provided so the ingest contract is
 * documented with something runnable, and because you asked for the personal
 * path to be real rather than described.
 *
 * You run this yourself, on your own machine, with your own account.
 * NEXORA only receives what you push to it.
 *
 * ── Setup ────────────────────────────────────────────────────────────────
 *   mkdir nexora-bridge && cd nexora-bridge
 *   npm init -y && npm i whatsapp-web.js qrcode-terminal
 *   # Paste your token from NEXORA → Integrations → Personal bridge
 *   NEXORA_TOKEN=nxr_br_… NEXORA_URL=https://your-app.vercel.app node bridge.mjs
 *
 * Scan the QR with WhatsApp → Linked devices. Keep the process running.
 * Ctrl-C stops sync; NEXORA keeps whatever was already ingested.
 */

import WhatsApp from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

const TOKEN = process.env.NEXORA_TOKEN;
const BASE = (process.env.NEXORA_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

if (!TOKEN?.startsWith('nxr_br_')) {
  console.error('Set NEXORA_TOKEN to the token from NEXORA → Integrations → Personal bridge.');
  process.exit(1);
}

const client = new WhatsApp({
  puppeteer: {
    headless: true,
    // On a server you may need: args: ['--no-sandbox']
  },
});

client.on('qr', (qr) => {
  console.log('\nScan this QR in WhatsApp → Linked devices:\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✓ Connected. Listening for messages. Ctrl-C to stop.');
});

/** Push a batch to NEXORA. Batches are capped at 500 messages. */
async function push(chat, messages) {
  if (messages.length === 0) return;

  const res = await fetch(`${BASE}/api/whatsapp/bridge/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      chat: {
        id: chat.id._serialized,
        name: chat.name || chat.id.user,
        isGroup: chat.isGroup,
      },
      messages: messages.map((m) => ({
        id: m.id._serialized,
        fromMe: m.fromMe,
        senderName: m._data?.notifyName ?? m.author ?? 'Unknown',
        body: m.body ?? `[${m.type}]`,
        timestamp: m.timestamp,
      })),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`✗ ingest failed (${res.status}): ${text}`);
    return;
  }

  const out = await res.json();
  console.log(`  → ${chat.name}: ${out.inserted} new, ${out.duplicates} duplicate(s)`);
}

// Live messages
client.on('message', async (msg) => {
  const chat = await msg.getChat();
  await push(chat, [msg]);
});

// Optional: backfill recent history on connect.
// Uncomment to import the last N messages per chat. This is the step most
// likely to trip WhatsApp's abuse detection — do it once, not in a loop.
//
// client.on('ready', async () => {
//   const chats = await client.getChats();
//   for (const chat of chats.slice(0, 20)) {
//     const msgs = await chat.fetchMessages({ limit: 50 });
//     await push(chat, msgs);
//     await new Promise((r) => setTimeout(r, 2000)); // be gentle
//   }
// });

client.on('auth_failure', (m) => {
  console.error('✗ Authentication failed:', m);
  process.exit(1);
});

console.log('Starting bridge… (first run will print a QR)');
client.initialize();
