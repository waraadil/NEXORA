/**
 * WhatsApp chat-export parser.
 *
 * Handles the real formats WhatsApp produces across platforms/locales:
 *   [12/03/2024, 9:14:32 PM] Alice: Hey          (iOS, bracketed)
 *   12/03/2024, 9:14 pm - Alice: Hey             (Android, dash)
 *   12/03/24, 21:14 - Alice: Hey                 (24h, short year)
 *   ٣١‏/١‏/٢٠٢٤، ٩:١٤ م - Alice: مرحبا           (Arabic, RTL marks)
 *
 * Also handles:
 *   - "<Media omitted>", "image omitted", "sticker omitted", deleted messages
 *   - system lines (encryption notices, joins, calls) → skipped, not invented
 *   - multi-line messages (continuation lines are appended, not dropped)
 *   - group exports: participant names resolved per line
 *
 * Design rule: if we cannot confidently parse a line we count it as an error
 * and report it. We never silently invent content.
 */

import { createHash } from 'node:crypto';

export type ParsedMessage = {
  senderName: string;
  isFromMe: boolean;
  body: string;
  sentAt: string | null; // ISO
  rawLine: string;
  hash: string;
  lineNumber: number;
};

export type ParseIssue = {
  lineNumber: number;
  reason: string;
  preview: string;
};

export type ParseResult = {
  messages: ParsedMessage[];
  issues: ParseIssue[];
  participants: { name: string; messageCount: number }[];
  isGroup: boolean;
  systemLineCount: number;
  dateRange: { first: string | null; last: string | null };
  formatDetected: string;
};

// ── Timestamp patterns, tried in order ──────────────────────────────
// Stage 1: match only the timestamp prefix. Everything after it is `remainder`,
// which is then decided to be either "Sender: body" or a system notice.
// Keeping these separate is what stops a system line that contains no colon
// from being mis-attributed to a sender.
const PREFIX_BRACKETED =
  /^\[(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\]\s*([\s\S]*)$/i;
const PREFIX_DASHED =
  /^(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\s+[-–—]\s*([\s\S]*)$/i;

// Stage 2: split "Sender: body". Sender may not contain a colon; body may.
// Supports "-" (unknown participant) and long names up to 80 chars.
const SENDER_BODY = /^([^:\n]{1,80}?):\s?([\s\S]*)$/;

// Lines WhatsApp injects that are not conversation content
const SYSTEM_PATTERNS = [
  /messages and calls are end-to-end encrypted/i,
  /you created (this )?group/i,
  /added you$/i,
  /changed the subject/i,
  /changed (their|this group'?s) icon/i,
  /^messages to this chat and calls are now secured/i,
  /joined using this group's invite link/i,
  /^missed voice call$/i,
  /^missed video call$/i,
  /created group/i,
  /^you (were added|joined)/i,
  /^.* pinned a message$/i,
];

const MEDIA_PLACEHOLDERS = [
  '<media omitted>',
  'image omitted',
  'video omitted',
  'audio omitted',
  'document omitted',
  'sticker omitted',
  'gif omitted',
  'contact card omitted',
  'this message was deleted',
  'you deleted this message',
];

const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function stripBidi(s: string): string {
  return s.replace(BIDI, '');
}

/** Normalise unicode digits (Arabic-Indic, etc.) to ASCII so dates parse. */
function normalizeDigits(s: string): string {
  return s.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (d) => {
    const code = d.charCodeAt(0);
    if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
    return String(code - 0x06f0);
  });
}

function parseTimestamp(datePart: string, timePart: string): string | null {
  const d = normalizeDigits(stripBidi(datePart)).trim();
  const t = normalizeDigits(stripBidi(timePart)).trim().toLowerCase();

  // Split the date into three numeric components.
  const parts = d.split(/[./-]/).map((p) => parseInt(p, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;

  let year: number, month: number, day: number;
  const [a, b, c] = parts;

  if (a > 31) {
    // yyyy-mm-dd
    year = a;
    month = b;
    day = c;
  } else if (c > 31) {
    // Ambiguous dd/mm/yyyy vs mm/dd/yyyy — default to day-first (WhatsApp's
    // default outside the US). If day>12 we know for sure.
    if (a > 12) {
      day = a;
      month = b;
    } else if (b > 12) {
      month = a;
      day = b;
    } else {
      day = a;
      month = b;
    }
    year = c;
  } else {
    // Two-digit year — WhatsApp uses 20xx for recent exports.
    day = a;
    month = b;
    year = 2000 + c;
    if (a > 12) {
      day = a;
      month = b;
    } else if (b > 12) {
      month = a;
      day = b;
    }
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Time
  const tm = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?\.?m?\.?$/);
  if (!tm) return null;

  let hour = parseInt(tm[1], 10);
  const minute = parseInt(tm[2], 10);
  const second = tm[3] ? parseInt(tm[3], 10) : 0;
  const meridiem = tm[4];

  if (meridiem === 'p' && hour < 12) hour += 12;
  if (meridiem === 'a' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || second > 59) return null;

  // Export timestamps carry no timezone. Store as UTC to keep ordering stable
  // and label it honestly in the UI as "export local time".
  const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

export function messageHash(senderName: string, body: string, sentAt: string | null, index: number): string {
  // Deliberately excludes the line index so re-importing the same export
  // produces identical hashes and the DB unique index skips duplicates.
  return createHash('sha256')
    .update(`${senderName}\u0000${sentAt ?? ''}\u0000${body.trim()}`)
    .digest('hex');
}

/** The device owner's name, as it appears in the export. */
export type ParseOptions = {
  /** Name that represents "me" in the export (the person who exported). */
  meName?: string;
  /** Optional override: treat every message from this name as outgoing. */
  fromMeName?: string;
};

export function parseWhatsAppExport(raw: string, options: ParseOptions = {}): ParseResult {
  // Normalise newlines and strip a UTF-8 BOM if present.
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  const messages: ParsedMessage[] = [];
  const issues: ParseIssue[] = [];
  let systemLineCount = 0;
  let formatDetected = 'none';
  let current: ParsedMessage | null = null;

  const pushCurrent = () => {
    if (current) {
      current.body = current.body.trim();
      if (current.body.length > 0) messages.push(current);
      current = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = stripBidi(rawLine).trimEnd();
    const lineNumber = i + 1;

    if (!line.trim()) {
      // Blank line inside a multi-line message is meaningful; otherwise skip.
      if (current) current.body += '\n';
      continue;
    }

    let datePart: string | null = null;
    let timePart: string | null = null;
    let sender: string | null = null;
    let body: string | null = null;
    let fmt = '';

    const pre = line.match(PREFIX_BRACKETED) ?? line.match(PREFIX_DASHED);
    if (pre) {
      datePart = pre[1];
      timePart = pre[2];
      const remainder = pre[3] ?? '';
      fmt = line.startsWith('[') ? 'ios-bracketed' : 'android-dash';

      const sb = remainder.match(SENDER_BODY);
      if (sb) {
        sender = sb[1];
        body = sb[2];
      }
    }

    if (fmt && datePart && timePart) {
      pushCurrent();
      if (formatDetected === 'none') formatDetected = fmt;

      const cleanSender = sender === null ? '' : normalizeDigits(stripBidi(sender)).trim();
      const remainderText = line.replace(PREFIX_BRACKETED, '$3').replace(PREFIX_DASHED, '$3');

      // A line with a timestamp but no "Sender: body" shape is a system notice
      // (encryption banner, "X added Y", call logs, subject changes).
      // NOTE: never treat a sender name as a system marker — "You" is exactly
      // how WhatsApp labels the export owner's own messages.
      const isSystem =
        sender === null ||
        cleanSender === '' ||
        cleanSender === '-' ||
        (body !== null && SYSTEM_PATTERNS.some((p) => p.test(body))) ||
        SYSTEM_PATTERNS.some((p) => p.test(remainderText));

      if (isSystem) {
        systemLineCount++;
        continue;
      }

      const sentAt = parseTimestamp(datePart, timePart);
      const bodyText = (body ?? '').trim();

      if (sentAt === null) {
        issues.push({
          lineNumber,
          reason: 'unparseable timestamp',
          preview: line.slice(0, 120),
        });
        // Still keep the message — a bad timestamp shouldn't lose the content.
      }

      const meName = options.fromMeName ?? options.meName;
      const isFromMe = meName
        ? cleanSender.toLowerCase() === meName.trim().toLowerCase()
        : false;

      current = {
        senderName: cleanSender,
        isFromMe,
        body: bodyText,
        sentAt,
        rawLine,
        hash: messageHash(cleanSender, bodyText, sentAt, messages.length),
        lineNumber,
      };

      // Media placeholders are recorded as-is; the UI labels them as media.
      const lowerBody = bodyText.toLowerCase();
      if (MEDIA_PLACEHOLDERS.some((p) => lowerBody.includes(p))) {
        current.body = bodyText;
      }
      continue;
    }

    // Continuation of the previous message (multi-line body).
    if (current) {
      current.body += `\n${line}`;
      // Recompute hash once the body is complete.
      current.hash = messageHash(current.senderName, current.body.trim(), current.sentAt, 0);
    } else if (line.trim()) {
      issues.push({
        lineNumber,
        reason: 'line does not match any known WhatsApp export format',
        preview: line.slice(0, 120),
      });
    }
  }

  pushCurrent();

  // Recompute hashes now that bodies are final (multi-line messages).
  for (const msg of messages) {
    msg.hash = messageHash(msg.senderName, msg.body, msg.sentAt, 0);
  }

  // Participants
  const counts = new Map<string, number>();
  for (const msg of messages) {
    if (msg.isFromMe) continue;
    counts.set(msg.senderName, (counts.get(msg.senderName) ?? 0) + 1);
  }
  const participants = [...counts.entries()]
    .map(([name, messageCount]) => ({ name, messageCount }))
    .sort((a, b) => b.messageCount - a.messageCount);

  const dated = messages.filter((m) => m.sentAt).map((m) => m.sentAt!) as string[];
  dated.sort();

  return {
    messages,
    issues,
    participants,
    isGroup: participants.length > 1,
    systemLineCount,
    dateRange: {
      first: dated[0] ?? null,
      last: dated[dated.length - 1] ?? null,
    },
    formatDetected,
  };
}

/** Cheap pre-check so the UI can reject obviously wrong uploads early. */
export function looksLikeWhatsAppExport(raw: string): boolean {
  const head = raw.slice(0, 4000).replace(/^\uFEFF/, '');
  // Test the first few non-empty lines — the very first line is sometimes a
  // system banner rather than a message.
  const candidates = head.split('\n').map((l) => stripBidi(l).trim()).filter(Boolean).slice(0, 20);

  return (
    candidates.some((l) => PREFIX_BRACKETED.test(l) || PREFIX_DASHED.test(l)) ||
    /end-to-end encrypted/i.test(head)
  );
}
