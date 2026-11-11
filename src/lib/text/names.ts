/**
 * What actually counts as "my name" in an export.
 *
 * WhatsApp writes the export owner's own messages under whatever the device
 * saved their own number as. That is frequently not a readable name:
 *   - "You"            English Android imports the owner as "You"
 *   - U+3164           HANGUL FILLER — chosen by people who want a blank name.
 *                      It renders as nothing, so the sidebar shows an empty row.
 *   - U+2800, U+200B…  braille blank, zero-width space, BOM, non-breaking space
 *   - ""               genuinely empty after trimming
 *   - "🙂", "🌚"       emoji-only names
 *
 * None of these should ever be stored or displayed as a contact name, and a
 * name field that accepts them is a name field that produces blank UI.
 */

/**
 * Codepoints that render as nothing (or as a deliberate blank placeholder) and
 * therefore cannot be a display name on their own.
 *
 * Deliberately NOT included: U+00A0 and other ordinary spaces are handled by
 * trimming; this list is for characters that survive a trim and still look
 * blank.
 */
const BLANK_NAME_REGEX =
  /^[\s\u3164\u2800\u115f\u1160\u180e\u200b\u200c\u200d\u200e\u200f\u2060\ufeff\u00a0]+$/u;

/** Emoji presentation characters — used only to decide "is this name readable". */
const ONLY_SYMBOLS_REGEX =
  /^[\p{Extended_Pictographic}\p{Emoji_Component}\s\p{P}\p{S}]+$/u;

/** Names WhatsApp itself uses for the export owner. */
const OWNER_ALIASES = ['you', 'me', 'myself', 'yourself'];

/**
 * True when `name` cannot be shown to a human as a name: empty, whitespace,
 * an invisible/blank filler, or nothing but emoji/punctuation.
 */
export function isBlankName(name: string | null | undefined): boolean {
  if (!name) return true;
  const trimmed = name.trim();
  if (trimmed.length === 0) return true;
  if (BLANK_NAME_REGEX.test(trimmed)) return true;
  if (ONLY_SYMBOLS_REGEX.test(trimmed)) return true;
  return false;
}

/** True when the export labels its owner "You" / "Me" rather than by name. */
export function isOwnerAlias(name: string): boolean {
  return OWNER_ALIASES.includes(name.trim().toLowerCase());
}

/**
 * Strip invisible characters from a stored name and collapse whitespace, so
 * whatever survives is safe to render. Returns '' when nothing readable is
 * left — callers must fall back to a real label (see `displayName`).
 */
export function cleanName(name: string | null | undefined): string {
  if (!name) return '';
  const stripped = name
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[\u3164\u2800\u115f\u1160\u180e\u2060\u00a0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return isBlankName(stripped) ? '' : stripped;
}
