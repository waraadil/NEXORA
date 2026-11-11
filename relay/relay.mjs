#!/usr/bin/env node
/**
 * NEXORA live WhatsApp relay
 * ──────────────────────────
 * Links YOUR personal WhatsApp to NEXORA as a linked device, exactly like
 * WhatsApp Web or the desktop app. NEXORA never asks for your password, your
 * 2FA code, or your messages' encryption keys.
 *
 * What it does, in order:
 *   1. Pairs a linked device with the code NEXORA gives you in the browser
 *      (WhatsApp → Linked devices → Link with phone number).
 *   2. Streams every incoming and outgoing message to your NEXORA account.
 *   3. Collects the replies NEXORA writes (AI auto-replies and anything you
 *      type in NEXORA) and sends them from your own WhatsApp.
 *
 * Everything runs on this machine. Your session credentials are written to
 * ~/.nexora-relay/auth and go nowhere except WhatsApp's own servers.
 *
 * ── Setup ────────────────────────────────────────────────────────────────
 *   npx github:waraadil/nexora-relay
 *
 * You will be asked for the pairing code shown in NEXORA → Integrations.
 * Keep the window open. Closing it stops sync; reopen it and it resumes.
 *
 * ⚠️  Personal WhatsApp automation breaks WhatsApp's Terms of Service and can
 * get your number banned. Read the warnings in the app before you link.
 */

import { rm, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  isJidGroup,
  isJidBroadcast,
  isJidStatusBroadcast,
  jidNormalizedUser,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';

const HERE = dirname(fileURLToPath(import.meta.url));
// Deliberately NOT next to the script: under `npx` the package sits in a
// temporary cache npm may clear, which would silently log the user out.
// ~/.nexora-relay survives that, survives moving the script, and is private.
const AUTH_DIR = process.env.NEXORA_AUTH_DIR || join(homedir(), '.nexora-relay', 'auth');

const BASE = (process.env.NEXORA_URL || '').replace(/\/+$/, '');
const PAIRING_CODE = process.env.NEXORA_PAIRING_CODE || '';
const RELAY_NAME = process.env.NEXORA_RELAY_NAME || 'NEXORA relay';
const API_KEY = process.env.NEXORA_API_KEY || ''; // only needed for `--reset`

const log = (...args) => console.log(`[${new Date().toLocaleTimeString()}]`, ...args);

// ── HTTP helpers ────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function post(path, body, code = PAIRING_CODE) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${code}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    throw new ApiError(res.status, json?.error || `HTTP ${res.status}`);
  }
  return json;
}

// ── Message shaping ─────────────────────────────────────────────────────────

/** Pull readable text out of any Baileys message shape. */
function extractText(message) {
  if (!message) return null;
  const m = message;
  const text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    null;
  if (text) return text;

  // Labelled placeholders — never invent content we cannot read.
  if (m.imageMessage) return '[photo]';
  if (m.videoMessage) return '[video]';
  if (m.audioMessage) return m.audioMessage.ptt ? '[voice message]' : '[audio]';
  if (m.stickerMessage) return '[sticker]';
  if (m.documentMessage) return `[document${m.documentMessage.fileName ? `: ${m.documentMessage.fileName}` : ''}]`;
  if (m.locationMessage) return '[location]';
  if (m.liveLocationMessage) return '[live location]';
  if (m.contactMessage || m.contactsArrayMessage) return '[contact card]';
  if (m.reactionMessage) return null; // reactions are not messages
  if (m.protocolMessage || m.senderKeyDistributionMessage) return null;
  if (m.pollCreationMessage || m.pollCreationMessageV3) return `[poll: ${m.pollCreationMessage?.name ?? m.pollCreationMessageV3?.name ?? ''}]`.trim();
  if (m.eventMessage) return '[event]';
  return '[unsupported message]';
}

function unwrap(message) {
  // Unwrap disappearing-message / view-once wrappers.
  let m = message;
  for (let i = 0; i < 3 && m; i++) {
    if (m.ephemeralMessage) m = m.ephemeralMessage.message;
    else if (m.viewOnceMessage) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
    else if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
    else break;
  }
  return m;
}

/** "919876543210@s.whatsapp.net" | "...@lid" -> "919876543210" */
function jidToDigits(jid) {
  if (!jid) return '';
  const local = String(jid).split('@')[0].split(':')[0];
  return local.replace(/[^\d]/g, '');
}

/** "919876543210@s.whatsapp.net" -> "+919876543210" (returns '' for groups/status) */
function jidToPhone(jid) {
  if (!jid || isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid)) return '';
  const digits = jidToDigits(jid);
  if (!digits || digits.length < 7 || digits.length > 15) return '';
  return `+${digits}`;
}

function toSeconds(ts) {
  if (!ts) return Math.floor(Date.now() / 1000);
  const n = typeof ts === 'object' && 'toNumber' in ts ? ts.toNumber() : Number(ts);
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

// ── Relay state ─────────────────────────────────────────────────────────────

let selfJid = null;
let socket = null;
let stopping = false;
let connected = false;
const groupCache = new Map(); // jid -> { name, participants: [{ jid, phone, name }] }

async function groupInfo(sock, jid) {
  const cached = groupCache.get(jid);
  if (cached) return cached;
  try {
    const meta = await sock.groupMetadata(jid);
    const info = {
      name: meta.subject || 'Group',
      participants: (meta.participants || []).map((p) => ({
        jid: p.id,
        phone: jidToPhone(p.id),
        name: p.name || p.notify || null,
      })),
    };
    groupCache.set(jid, info);
    return info;
  } catch {
    return { name: 'Group', participants: [] };
  }
}

async function pushMessages(sock, chatJid, messages, history = false) {
  if (messages.length === 0) return null;

  const isGroup = isJidGroup(chatJid);
  const group = isGroup ? await groupInfo(sock, chatJid) : null;

  const chat = isGroup
    ? { id: chatJid, name: group.name, isGroup: true, participants: group.participants }
    : {
        id: chatJid,
        name: contacts.get(chatJid)?.name || jidToPhone(chatJid) || 'WhatsApp contact',
        isGroup: false,
      };

  try {
    const out = await post('/api/whatsapp/relay/sync', { chat, messages, history });
    if (out?.inserted) {
      log(`${history ? '⇢' : '↑'} ${out.inserted} ${history ? 'older' : 'new'} message${out.inserted === 1 ? '' : 's'} · ${chat.name}`);
    }
    return out;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      log('✗ NEXORA rejected the pairing code. Re-pair from NEXORA → Integrations.');
      shutdown(1);
      return null;
    }
    log(`! upload failed for ${chat.name}: ${e.message}`);
    return null;
  }
}

// Names WhatsApp shares for your contacts (pushname). Used to label people
// who have saved nothing, and group participants.
const contacts = new Map(); // jid -> { name }

function rememberContact(jid, name) {
  if (!jid || !name) return;
  const prev = contacts.get(jid);
  if (!prev || prev.name.length < name.length) contacts.set(jid, { name });
}

// Messages that want a reply from NEXORA (AI or the user's own typing).
async function requestReplies(sock, items) {
  if (items.length === 0) return;

  if (!connected) {
    // Leave the work queued. NEXORA re-offers it after a stale timeout, so a
    // dropped connection delays a reply instead of losing it.
    log('… offline, holding replies until the connection is back');
    return;
  }
  let out;
  try {
    out = await post('/api/whatsapp/relay/replies', { items });
  } catch (e) {
    log(`! could not ask NEXORA for replies: ${e.message}`);
    return;
  }

  for (const reply of out?.replies ?? []) {
    try {
      const jid = reply.chatId;
      if (!jid) continue;
      const sent = await sock.sendMessage(jid, { text: reply.body });
      const id = sent?.key?.id;
      await post('/api/whatsapp/relay/ack', { id: reply.id, ok: true, providerMessageId: id }).catch(() => {});
      log(`→ replied to ${reply.toName || jid}: ${reply.body.slice(0, 60)}`);
    } catch (e) {
      await post('/api/whatsapp/relay/ack', {
        id: reply.id,
        ok: false,
        error: e.message,
      }).catch(() => {});
      log(`! reply failed: ${e.message}`);
    }
  }
}

// ── Connection ──────────────────────────────────────────────────────────────

async function start() {
  if (!BASE) {
    console.error('Set NEXORA_URL, e.g. NEXORA_URL=https://nexora-zeta-red.vercel.app');
    process.exit(1);
  }

  await mkdir(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  socket = makeWASocket({
    version,
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
  });

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('contacts.upsert', (list) => {
    for (const c of list || []) rememberContact(c.id, c.name || c.notify);
  });
  socket.ev.on('contacts.update', (list) => {
    for (const c of list || []) rememberContact(c.id, c.name || c.notify);
  });
  socket.ev.on('groups.upsert', (list) => {
    for (const g of list || []) groupCache.delete(g.id);
  });
  socket.ev.on('groups.update', (list) => {
    for (const g of list || []) groupCache.delete(g.id);
  });

  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    // 'append' is WhatsApp replaying a backlog on connect; 'notify' is live.
    await handleMessages(messages, type === 'append');
  });

  socket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log('Waiting for pairing — enter the code from NEXORA → Integrations.');
    }

    if (connection === 'open') {
      connected = true;
      const me = socket.user;
      selfJid = me?.id ? jidNormalizedUser(me.id) : null;
      const phone = jidToPhone(selfJid);

      log(`✓ Linked as ${me?.name || me?.verifiedName || phone || 'your account'}`);
      await post('/api/whatsapp/relay/ping', {
        state: 'connected',
        selfJid,
        selfPhone: phone,
        selfName: me?.name || me?.verifiedName || null,
        relayVersion: '1.0.0',
      }).catch((e) => log(`! ping failed: ${e.message}`));

      // Heartbeat keeps the app's "live" indicator honest.
      setInterval(() => {
        post('/api/whatsapp/relay/ping', { state: 'connected' }).catch(() => {});
      }, 60_000).unref?.();
    }

    if (connection === 'close') {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;

      await post('/api/whatsapp/relay/ping', {
        state: loggedOut ? 'unpaired' : 'offline',
        reason: lastDisconnect?.error?.message || (loggedOut ? 'device removed' : 'connection closed'),
      }).catch(() => {});

      if (loggedOut) {
        log('✗ This device was removed from WhatsApp. Re-pair from NEXORA → Integrations.');
        await rm(AUTH_DIR, { recursive: true, force: true });
        shutdown(1);
        return;
      }

      if (stopping) return;
      log(`… connection dropped (${code ?? 'no code'}); reconnecting in 3s`);
      await new Promise((r) => setTimeout(r, 3000));
      if (!stopping) start();
    }
  });

  // Pairing by phone number — the flow NEXORA shows in the browser.
  if (PAIRING_CODE && !state.creds.registered) {
    const phone = await resolvePairingPhone();
    if (phone) {
      // Give the socket a moment to finish the handshake before asking.
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const code = await socket.requestPairingCode(phone);
        log('');
        log(`  ┌─────────────────────────────────────┐`);
        log(`  │   WhatsApp pairing code: ${formatCode(code)}   │`);
        log(`  └─────────────────────────────────────┘`);
        log('  Enter it in NEXORA → Integrations → Enter your phone number.');
      } catch (e) {
        log(`! pairing code request failed: ${e.message}`);
        log('  Fall back: on your phone open WhatsApp → Linked devices and scan.');
      }
    }
  }

  // After pairing, NEXORA hands us work (for example, messages you sent from
  // the NEXORA app). Poll on a short interval so replies feel immediate.
  pollLoop();
}

/** The browser supplies the digits to pair with; fall back to asking here. */
async function resolvePairingPhone() {
  try {
    const state = await post('/api/whatsapp/relay/pairing-read', {});
    if (state?.pairingPhone) return state.pairingPhone;
  } catch {
    /* pairing endpoint may not be readable yet — ask the human instead */
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      'Phone number to pair (country code, digits only — e.g. 919876543210): ',
    );
    const digits = answer.replace(/[^\d]/g, '');
    if (digits.length < 7) {
      log('! That does not look like a phone number. Re-run and enter country code + number.');
      return null;
    }
    await post('/api/whatsapp/relay/pairing-phone', { phone: digits }).catch((e) =>
      log(`! could not save the number: ${e.message}`),
    );
    return digits;
  } finally {
    rl.close();
  }
}

function formatCode(code) {
  return String(code).replace(/(\w{4})(?=\w)/g, '$1-');
}

async function handleMessages(messages, history = false) {
  const byChat = new Map();

  for (const msg of messages) {
    if (!msg?.key || !msg.message) continue;
    if (msg.key.remoteJid === 'status@broadcast') continue;
    if (isJidBroadcast(msg.key.remoteJid)) continue;

    const real = unwrap(msg.message);
    if (real?.protocolMessage) continue;
    if (real?.reactionMessage) continue;

    const text = extractText(real);
    if (!text) continue;

    const chatJid = msg.key.remoteJid;
    const fromMe = !!msg.key.fromMe;
    const group = isJidGroup(chatJid);

    // In groups, the author is the participant; in 1:1, it is the chat.
    const authorJid = group ? msg.key.participant || msg.participant : chatJid;
    const isOwn = fromMe || (group && authorJid && selfJid && jidNormalizedUser(authorJid) === selfJid);

    let senderName = '';
    if (isOwn) senderName = 'You';
    else if (authorJid) {
      senderName =
        msg.pushName ||
        contacts.get(authorJid)?.name ||
        jidToPhone(authorJid) ||
        (group ? 'Group member' : 'WhatsApp contact');
    }

    const item = {
      id: msg.key.id,
      chatId: chatJid,
      isGroup: group,
      fromMe: isOwn,
      senderJid: authorJid || null,
      senderName,
      body: text,
      timestamp: toSeconds(msg.messageTimestamp),
    };

    // Echo back to WhatsApp (read receipt) — only for real inbound messages.
    if (!isOwn) {
      try {
        await socket.readMessages([msg.key]);
      } catch {
        /* cosmetic */
      }
    }

    const list = byChat.get(chatJid) ?? [];
    list.push(item);
    byChat.set(chatJid, list);
  }

  for (const [chatJid, items] of byChat) {
    const result = await pushMessages(socket, chatJid, items, history);

    // NEXORA can hand back work immediately: AI auto-replies it generated,
    // and anything the user queued in the app.
    const replies = result?.replies ?? [];
    if (replies.length) await requestReplies(socket, replies);
  }
}

// ── Outbound pump ───────────────────────────────────────────────────────────

let pumping = false;

async function pollLoop() {
  if (stopping) return;

  if (!pumping) {
    pumping = true;
    try {
      const out = await post('/api/whatsapp/relay/pending', {});
      if (out?.replies?.length) await requestReplies(socket, out.replies);
      if (out?.unpaired) {
        log('✗ NEXORA no longer recognises this device. Re-pair from Integrations.');
        shutdown(1);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        log('✗ Pairing code rejected. Re-pair from NEXORA → Integrations.');
        shutdown(1);
        return;
      }
      /* transient network errors: keep polling */
    } finally {
      pumping = false;
    }
  }

  setTimeout(pollLoop, 4000);
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  try {
    socket?.end(undefined);
  } catch {
    /* already closed */
  }
  setTimeout(() => process.exit(code), 250);
}

process.on('SIGINT', () => {
  log('Stopping relay. History stays in NEXORA; new messages stop arriving.');
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));

// `--reset` clears the local session so the next run starts a fresh pairing.
if (process.argv.includes('--reset')) {
  await rm(AUTH_DIR, { recursive: true, force: true });
  log(`Cleared local session in ${AUTH_DIR}. Start again to pair a new device.`);
  process.exit(0);
}

await start();
