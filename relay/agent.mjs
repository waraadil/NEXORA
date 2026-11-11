#!/usr/bin/env node
/**
 * NEXORA WhatsApp agent — the always-on half
 * ──────────────────────────────────────────
 * Holds the WhatsApp socket for one or more NEXORA accounts and talks to the app
 * only by making OUTBOUND https requests. That means it can run anywhere that
 * can reach the internet — a small VPS, Render, Railway, Fly, a Raspberry Pi —
 * with no public address, no open port and no inbound firewall rule.
 *
 * The user never sees this process. They open NEXORA, press "Link my WhatsApp",
 * and the code WhatsApp issues appears in the app to type into their phone.
 *
 * ── Run it ───────────────────────────────────────────────────────────────
 *   NEXORA_URL=https://your-app.vercel.app \
 *   NEXORA_AGENT_SECRET=<shared secret> \
 *   NEXORA_AGENT_PORT=8787 \
 *   node agent.mjs
 *
 * NEXORA_AGENT_URL must point at this box's /adopt endpoint; the app calls it
 * when someone starts a pairing. Keep NEXORA_AGENT_SECRET private: anyone who
 * has it can ask this agent to adopt a pairing.
 */

import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  isJidGroup,
  isJidBroadcast,
  isJidStatusBroadcast,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';

const BASE = (process.env.NEXORA_URL || '').replace(/\/+$/, '');
const SECRET = process.env.NEXORA_AGENT_SECRET || '';
const PORT = Number(process.env.NEXORA_AGENT_PORT || 8787);
const ROOT = process.env.NEXORA_AGENT_DIR || join(homedir(), '.nexora-agent');
const POLL_MS = Number(process.env.NEXORA_POLL_MS || 3000);

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

if (!BASE || !SECRET) {
  console.error('Set NEXORA_URL and NEXORA_AGENT_SECRET.');
  process.exit(1);
}

/** One live WhatsApp link. */
class Link {
  constructor({ userId, claim, phone }) {
    this.userId = userId;
    this.token = claim; // swapped for a durable token on first successful poll
    this.phone = phone;
    this.socket = null;
    this.connected = false;
    this.pairingCode = null;
    this.me = null;
    this.outbox = []; // messages collected since the last poll
    this.acks = []; // results for replies the app handed out
    this.stopped = false;
    this.contacts = new Map();
    this.groups = new Map();
    this.dir = join(ROOT, userId);
  }

  // ── Transport ───────────────────────────────────────────────────────────

  async call(path, body, method = 'POST') {
    const res = await fetch(`${BASE}/api/whatsapp/agent/${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      // 401 has two meanings and they must not be confused. `reason: unlinked`
      // means the owner disconnected in NEXORA — tear the WhatsApp session down.
      // Anything else is a token the app could not match, which happens for a
      // poll or two right after pairing while the claim is being upgraded. In
      // that case retry; logging out would drop a perfectly good link.
      let reason = null;
      try {
        reason = (await res.json())?.reason ?? null;
      } catch {
        /* body was not json */
      }
      const err = new Error(reason === 'unlinked' ? 'unlinked' : 'unauthorised');
      if (reason === 'unlinked') err.unlinked = true;
      throw err;
    }
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res.json();
  }

  // ── WhatsApp ────────────────────────────────────────────────────────────

  async start() {
    if (this.stopped) return;
    await mkdir(this.dir, { recursive: true });

    // Restore the session from NEXORA first, so a fresh host does not force a
    // re-pair. The app stores it encrypted; this is the only copy on disk.
    await this.restoreSession();

    const { state, saveCreds } = await useMultiFileAuthState(this.dir);
    const { version } = await fetchLatestBaileysVersion();

    this.socket = makeWASocket({
      version,
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    });

    this.socket.ev.on('creds.update', async () => {
      await saveCreds();
      this.persistSession().catch(() => {});
    });

    this.socket.ev.on('contacts.upsert', (list) => {
      for (const c of list || []) if (c.id && (c.name || c.notify)) this.contacts.set(c.id, c.name || c.notify);
    });
    this.socket.ev.on('groups.update', (list) => {
      for (const g of list || []) this.groups.delete(g.id);
    });
    this.socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      this.collect(messages, type === 'append').catch((e) => log('collect failed:', e.message));
    });

    this.socket.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect } = u;

      if (connection === 'open') {
        this.connected = true;
        this.pairingCode = null;
        const me = this.socket.user;
        this.me = {
          jid: me?.id ? jidNormalizedUser(me.id) : null,
          phone: phoneFromJid(me?.id),
          name: me?.name || me?.verifiedName || null,
        };
        log(`✓ linked ${this.me.phone ?? 'unknown'} — polling`);
        await this.persistSession().catch(() => {});
      }

      if (connection === 'close') {
        this.connected = false;
        const code = lastDisconnect?.error?.output?.statusCode;

        if (code === DisconnectReason.loggedOut) {
          log('✗ device removed from WhatsApp — clearing session');
          await this.call('session', undefined, 'DELETE').catch(() => {});
          this.stop();
          return;
        }

        if (this.stopped) return;
        log(`… dropped (${code ?? '?'}), reconnecting`);
        await new Promise((r) => setTimeout(r, 2500));
        this.start().catch((e) => log('restart failed:', e.message));
      }
    });

    if (!state.creds.registered && this.phone) {
      await new Promise((r) => setTimeout(r, 1800));
      try {
        const code = await this.socket.requestPairingCode(this.phone);
        this.pairingCode = formatCode(code);
        log(`pairing code for ${this.phone}: ${this.pairingCode}`);
        // Push it straight away so it appears in the app without waiting.
        this.poll().catch(() => {});
      } catch (e) {
        log('pairing code failed:', e.message);
      }
    }
  }

  // ── Messages ────────────────────────────────────────────────────────────

  async collect(messages, history) {
    const byChat = new Map();

    for (const msg of messages) {
      if (!msg?.key?.remoteJid || !msg.message) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;
      if (isJidBroadcast(msg.key.remoteJid)) continue;

      const real = unwrap(msg.message);
      if (real?.protocolMessage || real?.reactionMessage) continue;

      const body = extractText(real);
      if (!body) continue;

      const chatJid = msg.key.remoteJid;
      const group = isJidGroup(chatJid);
      const fromMe = !!msg.key.fromMe;
      const authorJid = group ? msg.key.participant || msg.participant : chatJid;
      const isOwn = fromMe || (group && authorJid && this.me?.jid && jidNormalizedUser(authorJid) === this.me.jid);

      const senderName = isOwn
        ? 'You'
        : msg.pushName || this.contacts.get(authorJid) || phoneFromJid(authorJid) || (group ? 'Group member' : 'WhatsApp contact');

      if (!isOwn) {
        try {
          await this.socket.readMessages([msg.key]);
        } catch {
          /* cosmetic */
        }
      }

      const item = {
        id: msg.key.id,
        isGroup: group,
        fromMe: isOwn,
        senderJid: authorJid || null,
        senderName,
        body,
        timestamp: toSeconds(msg.messageTimestamp),
      };

      const list = byChat.get(chatJid) ?? [];
      list.push(item);
      byChat.set(chatJid, list);
    }

    for (const [chatJid, items] of byChat) {
      this.outbox.push({
        chat: await this.describeChat(chatJid),
        messages: items,
        history,
      });
    }
  }

  async describeChat(jid) {
    if (!isJidGroup(jid)) {
      return { id: jid, name: this.contacts.get(jid) || phoneFromJid(jid) || 'WhatsApp contact', isGroup: false };
    }
    let info = this.groups.get(jid);
    if (!info) {
      try {
        const meta = await this.socket.groupMetadata(jid);
        info = {
          name: meta.subject || 'Group',
          participants: (meta.participants || []).map((p) => ({
            jid: p.id,
            phone: phoneFromJid(p.id),
            name: p.name || p.notify || null,
          })),
        };
        this.groups.set(jid, info);
      } catch {
        info = { name: 'Group', participants: [] };
      }
    }
    return { id: jid, name: info.name, isGroup: true, participants: info.participants };
  }

  // ── Poll loop ───────────────────────────────────────────────────────────

  async poll() {
    const outbox = this.outbox;
    const acks = this.acks;
    this.outbox = [];
    this.acks = [];

    let res;
    try {
      res = await this.call('poll', {
        state: this.connected
          ? 'connected'
          : this.pairingCode
            ? 'awaiting_code'
            : 'starting',
        pairingCode: this.pairingCode,
        selfJid: this.me?.jid ?? null,
        selfPhone: this.me?.phone ?? null,
        selfName: this.me?.name ?? null,
        messages: outbox,
        acks,
      });
    } catch (e) {
      if (e.unlinked) {
        log(`✗ NEXORA unlinked ${this.userId}; shutting this link down`);
        this.stop();
        return;
      }
      // Network blip: put the work back and try next tick.
      this.outbox = [...outbox, ...this.outbox];
      this.acks = [...acks, ...this.acks];
      return;
    }

    if (res.agentToken) {
      this.token = res.agentToken;
      log('✓ adopted: durable agent token issued');
      await this.saveToken(res.agentToken);
    }

    for (const reply of res.replies ?? []) {
      await this.send(reply);
    }
  }

  async send(reply) {
    if (!this.connected) {
      // Leave it queued: NEXORA re-offers unacknowledged work after a timeout.
      this.acks.push({ id: reply.id, ok: false, error: 'agent offline' });
      return;
    }
    try {
      const sent = await this.socket.sendMessage(reply.chatId, { text: reply.body });
      this.acks.push({ id: reply.id, ok: true, providerMessageId: sent?.key?.id });
      log(`→ replied to ${reply.toName || reply.chatId}`);
    } catch (e) {
      this.acks.push({ id: reply.id, ok: false, error: e.message.slice(0, 200) });
    }
  }

  // ── Session persistence ─────────────────────────────────────────────────

  async persistSession() {
    const files = {};
    for (const name of ['creds.json', 'app-state-sync-key.json', 'app-state-sync-version.json']) {
      try {
        files[name] = await readFile(join(this.dir, name), 'utf8');
      } catch {
        /* not written yet */
      }
    }
    if (Object.keys(files).length === 0) return;
    await this.call('session', { files }).catch(() => {});
  }

  async restoreSession() {
    try {
      const res = await this.call('session', {});
      if (!res?.session) return;
      for (const [name, content] of Object.entries(res.session)) {
        const tmp = join(this.dir, `${name}.tmp`);
        await writeFile(tmp, content);
        await rename(tmp, join(this.dir, name));
      }
      log('✓ restored session from NEXORA (no re-pair needed)');
    } catch {
      /* no session stored yet — a fresh pair */
    }
  }

  async saveToken(token) {
    await mkdir(ROOT, { recursive: true });
    await writeFile(join(ROOT, `${this.userId}.token`), token, { mode: 0o600 });
  }

  stop() {
    this.stopped = true;
    try {
      this.socket?.end(undefined);
    } catch {
      /* already gone */
    }
    live.delete(this.userId);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function phoneFromJid(jid) {
  if (!jid || isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid)) return '';
  const digits = String(jid).split('@')[0].split(':')[0].replace(/[^\d]/g, '');
  return digits.length >= 7 && digits.length <= 15 ? digits : '';
}

function toSeconds(ts) {
  if (!ts) return Math.floor(Date.now() / 1000);
  const n = typeof ts === 'object' && 'toNumber' in ts ? ts.toNumber() : Number(ts);
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

function formatCode(code) {
  return String(code).replace(/(\w{4})(?=\w)/g, '$1-');
}

function unwrap(message) {
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
  if (m.imageMessage) return '[photo]';
  if (m.videoMessage) return '[video]';
  if (m.audioMessage) return m.audioMessage.ptt ? '[voice message]' : '[audio]';
  if (m.stickerMessage) return '[sticker]';
  if (m.documentMessage) return `[document${m.documentMessage.fileName ? `: ${m.documentMessage.fileName}` : ''}]`;
  if (m.locationMessage) return '[location]';
  if (m.contactMessage || m.contactsArrayMessage) return '[contact card]';
  if (m.pollCreationMessage || m.pollCreationMessageV3) return '[poll]';
  if (m.reactionMessage || m.protocolMessage || m.senderKeyDistributionMessage) return null;
  return '[unsupported message]';
}

// ── Supervisor ─────────────────────────────────────────────────────────────

const live = new Map(); // userId -> Link

/**
 * Adopt a pairing the app just started.
 *
 * Called by NEXORA (server -> agent), authenticated with the shared secret. The
 * agent never receives the user's message history here — only which number to
 * pair and which claim token to use.
 */
const normaliseBase = (u) => String(u || '').replace(/\/+$/, '').toLowerCase();

async function adoptLink({ base, claim, phone, userId }) {
  if (normaliseBase(base) !== normaliseBase(BASE)) {
    log(`! adopt for a different base (${base}) — ignoring`);
    return { ok: false, error: 'base mismatch: this agent serves ' + BASE };
  }
  if (!claim || !phone || !userId) {
    return { ok: false, error: 'claim, phone and userId are required' };
  }

  const existing = live.get(userId);
  if (existing && !existing.stopped) {
    if (existing.connected) {
      // Already linked: nothing to do, and re-pairing would be wrong.
      existing.token = claim;
      return { ok: true, reused: true };
    }
    existing.stop();
  }

  const link = new Link({ userId, claim, phone });
  live.set(userId, link);
  link.start().catch((e) => log('link start failed:', e.message));
  return { ok: true };
}

// ── HTTP trigger ───────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && req.url === '/health') {
    return json(200, {
      ok: true,
      links: [...live.values()].map((l) => ({
        userId: l.userId,
        connected: l.connected,
        pairingCode: l.pairingCode,
      })),
    });
  }

  if (req.method !== 'POST' || req.url !== '/adopt') {
    return json(404, { error: 'not found' });
  }

  if (req.headers['x-nexora-agent-secret'] !== SECRET) {
    return json(401, { error: 'bad secret' });
  }

  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const payload = JSON.parse(body || '{}');
    const result = await adoptLink(payload);
    return json(result.ok ? 200 : 400, result);
  } catch (e) {
    return json(400, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  log(`agent listening on :${PORT} — talking to ${BASE}`);
});

/** Restore links that were alive before a restart, so nothing waits for a click. */
async function restore() {
  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(ROOT);
    for (const f of files.filter((n) => n.endsWith('.token'))) {
      const userId = f.replace(/\.token$/, '');
      const token = (await readFile(join(ROOT, f), 'utf8')).trim();
      if (!token) continue;
      const link = new Link({ userId, claim: token, phone: null });
      live.set(userId, link);
      link.start().catch((e) => log(`restore ${userId} failed:`, e.message));
    }
    if (files.length) log(`restored ${files.filter((n) => n.endsWith('.token')).length} link(s)`);
  } catch {
    /* first run */
  }
}

setInterval(() => {
  for (const link of live.values()) {
    if (!link.polling) {
      link.polling = true;
      link
        .poll()
        .catch(() => {})
        .finally(() => {
          link.polling = false;
        });
    }
  }
}, POLL_MS);

process.on('SIGINT', () => {
  log('shutting down');
  for (const l of live.values()) l.stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  for (const l of live.values()) l.stop();
  process.exit(0);
});

await restore();
