/**
 * INTELLIGENCE — writing as the user, to *this* person.
 *
 * The reported problem was that a single style profile, derived from one
 * romantic conversation, was applied to everybody: the same pet names and the
 * same emoji in a message to a partner and in a message to a colleague. The
 * profile itself was accurate — confidence 0.95 from 300 messages — it was just
 * being asked to describe a whole person when it only ever described one
 * relationship.
 *
 * Style is relational. Most people write differently to their partner, their
 * boss, and their mother, and the difference is mostly *register*: length,
 * formality, whether emoji or endearments are appropriate, whether a joke
 * lands. So the brief is assembled in layers, most specific first:
 *
 *   1. Global profile  — the person's baseline (tone, vocabulary, humour).
 *   2. Contact profile — how they write *with this contact* (register).
 *   3. The transcript  — what they have actually said here, most recently.
 *
 * Layer 3 already existed and is usually the strongest signal. Layer 2 is the
 * missing one. Layer 1 must never be allowed to dominate a specific chat: a
 * global profile saying "affectionate, heavy emoji" is true of the partner and
 * false of the accountant, and it is the transcript plus the contact profile
 * that should decide.
 *
 * Kept free of server imports so the composition rules can be tested directly.
 */

export type StyleLayers = {
  global?: {
    tone?: string | null;
    formality?: string | null;
    emojiUsage?: string | null;
    humour?: string | null;
    vocabularyNotes?: string | null;
    signaturePhrases?: string[] | null;
    punctuationHabits?: string | null;
    averageMessageLength?: number | null;
  } | null;
  contact?: {
    displayName?: string | null;
    relationship?: string | null;
    relationshipDetail?: string | null;
    /** Free-text register notes derived from this conversation only. */
    communicationStyle?: string | null;
  } | null;
  /** What the user explicitly asked for, in their own words. */
  instructions?: string | null;
};

/**
 * Relationships where endearments and heavy emoji would read as normal.
 * Deliberately short and conservative: when in doubt, treat the contact as
 * "not close" and let the transcript prove otherwise, because the cost of
 * being too familiar with a professional contact is much higher than the cost
 * of being slightly reserved with a friend.
 */
const CLOSE_RELATIONSHIPS = [
  'partner',
  'girlfriend',
  'boyfriend',
  'wife',
  'husband',
  'spouse',
  'fiance',
  'fiancée',
  'crush',
  'best friend',
  'bestfriend',
  'sibling',
  'brother',
  'sister',
  'mother',
  'father',
  'mom',
  'dad',
  'family',
];

/** Relationships where the register should default to plain and unadorned. */
const FORMAL_RELATIONSHIPS = [
  'client',
  'customer',
  'boss',
  'manager',
  'colleague',
  'coworker',
  'co-worker',
  'employer',
  'employee',
  'vendor',
  'recruiter',
  'landlord',
  'bank',
  'official',
  'doctor',
  'professor',
  'teacher',
];

export type Register = 'close' | 'formal' | 'neutral';

/** Classify a relationship label into a register. Unknown labels are neutral. */
export function registerFor(relationship?: string | null): Register {
  const r = (relationship ?? '').toLowerCase().trim();
  if (!r) return 'neutral';
  if (FORMAL_RELATIONSHIPS.some((x) => r.includes(x))) return 'formal';
  if (CLOSE_RELATIONSHIPS.some((x) => r.includes(x))) return 'close';
  return 'neutral';
}

/**
 * Build the style brief handed to the model.
 *
 * Ordering is the whole point: the most specific statement wins, and the prompt
 * is told so explicitly, because models average conflicting instructions rather
 * than preferring the specific one.
 */
export function composeStyleBrief(layers: StyleLayers): string {
  const lines: string[] = [];
  const g = layers.global;
  const c = layers.contact;
  const register = registerFor(c?.relationship);

  // Nothing known at all: say so. Inventing a personality from an empty profile
  // is how a model ends up confidently writing "warm and playful" for someone it
  // has never seen a single message from.
  const knowsNothing = !g && !c?.communicationStyle && !c?.relationship && !layers.instructions;
  if (knowsNothing) {
    return 'No style profile yet — infer the style from this conversation only, and stay neutral.';
  }

  if (g) {
    const base: string[] = [];
    if (g.tone) base.push(`${g.tone} tone`);
    if (g.formality) base.push(`${g.formality} formality`);
    if (g.averageMessageLength) base.push(`~${g.averageMessageLength} words per message`);
    if (base.length) lines.push(`Baseline (across all chats): ${base.join(', ')}.`);
    if (g.vocabularyNotes) lines.push(`Vocabulary: ${g.vocabularyNotes}.`);
    if (g.punctuationHabits) lines.push(`Punctuation: ${g.punctuationHabits}.`);
    if (g.humour && g.humour !== 'none observed') lines.push(`Humour: ${g.humour}.`);
    const phrases = (g.signaturePhrases as string[] | null) ?? [];
    if (phrases.length) lines.push(`Recurring phrases: ${phrases.slice(0, 6).join(', ')}.`);
  }

  if (c?.displayName) {
    const who = c.relationship ? `${c.displayName} (${c.relationship})` : c.displayName;
    lines.push(`Writing to: ${who}.`);
  }
  if (c?.relationshipDetail) lines.push(`About them: ${c.relationshipDetail}.`);
  if (c?.communicationStyle) {
    lines.push(`How the user writes with this person specifically: ${c.communicationStyle}.`);
  }

  // The register instruction is a floor and a ceiling, not decoration. It is
  // the line that stops a pet name reaching a client.
  if (register === 'close') {
    lines.push(
      'Register: close. Warm, casual wording is appropriate here, but only if it matches what the user has actually written in this chat.',
    );
  } else if (register === 'formal') {
    lines.push(
      'Register: professional. Plain, courteous, no pet names, no endearments, no slang. Do not assume familiarity.',
    );
  } else {
    lines.push(
      'Register: neutral. Match the tone of this specific conversation and do not add familiarity that is not already there.',
    );
  }

  lines.push(
    'Where these conflict, the most specific statement wins: this chat beats the baseline, and the transcript beats both. Never carry affection, inside jokes or pet names from another conversation into this one.',
  );

  if (layers.instructions) lines.push(`What the user wants: ${layers.instructions}.`);

  return lines.length
    ? lines.join('\n')
    : 'No style profile yet — infer the style from this conversation only, and stay neutral.';
}

/**
 * How much of the user's own writing this conversation needs before a
 * per-contact profile is worth deriving.
 *
 * Below this, the transcript itself is a better teacher than a summary of it,
 * and deriving would burn a model call to learn almost nothing.
 */
export const MIN_MESSAGES_FOR_CONTACT_PROFILE = 25;

export function hasEnoughForContactProfile(ownMessages: number): boolean {
  return ownMessages >= MIN_MESSAGES_FOR_CONTACT_PROFILE;
}
