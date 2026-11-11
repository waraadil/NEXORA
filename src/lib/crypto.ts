/**
 * AES-256-GCM envelope encryption for per-user AI API keys.
 *
 * Threat model: the database may be dumped, and service-role queries may be
 * logged. Neither should reveal a user's provider key. The master key lives
 * only in the server process environment (NEXORA_ENCRYPTION_KEY) and never
 * reaches Postgres, so ciphertext in `ai_credentials` is inert without it.
 *
 * Node's built-in crypto only — no external crypto dependency.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the GCM-recommended size
const KEY_BYTES = 32;

export type EncryptedPayload = {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
  last4: string;
  fingerprint: string;
};

function masterKey(): Buffer {
  const raw = process.env.NEXORA_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('NEXORA_ENCRYPTION_KEY is not set — refusing to handle credentials.');
  }
  // Accept 64-char hex, or any string we can derive 32 bytes from.
  const buf = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, 'hex')
    : createHash('sha256').update(raw).digest();

  if (buf.length !== KEY_BYTES) {
    throw new Error('NEXORA_ENCRYPTION_KEY must decode to 32 bytes.');
  }
  return buf;
}

/** Stable, non-reversible identifier for a key — lets us detect duplicates/rotation. */
export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 32);
}

export function encryptSecret(plaintext: string): EncryptedPayload {
  if (!plaintext || plaintext.length < 8) {
    throw new Error('Refusing to encrypt a suspiciously short secret.');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    last4: plaintext.slice(-4),
    fingerprint: fingerprint(plaintext),
  };
}

export function decryptSecret(payload: {
  ciphertext: string;
  iv: string;
  auth_tag: string;
}): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    masterKey(),
    Buffer.from(payload.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(payload.auth_tag, 'base64'));

  // A tampered ciphertext throws here — GCM authenticates, it does not just decrypt.
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/** Constant-time compare, for anywhere we match a provided key against a stored hash. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Redact anything key-shaped before it can reach a log or an error message. */
export function redactSecrets(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length > 6) out = out.split(s).join('[redacted]');
  }
  // Common provider key shapes
  return out
    .replace(/sk-[A-Za-z0-9_\-]{16,}/g, 'sk-[redacted]')
    .replace(/sk-ant-[A-Za-z0-9_\-]{16,}/g, 'sk-ant-[redacted]')
    .replace(/AIza[A-Za-z0-9_\-]{20,}/g, 'AIza[redacted]')
    .replace(/21st_sk_[A-Za-z0-9]{16,}/g, '21st_sk_[redacted]');
}
