/**
 * Style brief composition.
 *
 * The bug this guards is subtle and was reported in plain language: "it uses
 * emoji with every message that's not my style" and "it shouldn't behave like
 * that with everyone". A single global profile was describing every
 * relationship at once. These checks pin down the layering, and in particular
 * that a romantic profile cannot leak into a professional conversation.
 *
 * Run: npx tsx scripts/test-intelligence.ts
 */
import {
  composeStyleBrief,
  registerFor,
  hasEnoughForContactProfile,
  MIN_MESSAGES_FOR_CONTACT_PROFILE,
} from '../src/lib/whatsapp/intelligence';

let pass = 0;
let fail = 0;
const ok = (n: string, x = '') => {
  pass++;
  console.log(`  PASS  ${n}${x ? ` — ${x}` : ''}`);
};
const no = (n: string, x = '') => {
  fail++;
  console.log(`  FAIL  ${n}${x ? ` — ${x}` : ''}`);
};
const check = (c: boolean, n: string, x = '') => (c ? ok(n, x) : no(n, x));

// The user's real derived profile, verbatim from the database.
const romanticProfile = {
  tone: 'Affectionate, possessive, and emotionally volatile',
  formality: 'very informal',
  emojiUsage: 'heavy; uses ☺️, 🫶, 🥹, ❤️, 🥰 frequently',
  humour: 'teasing, playful',
  vocabularyNotes: "Hinglish; 'moti/motu' (endearment), 'jnu' (darling)",
  signaturePhrases: ['jnuuuuu', 'meri moti', 'cxeiii'],
  punctuationHabits: 'minimal, elongated vowels',
  averageMessageLength: 3,
};

console.log('\n[Register]');
check(registerFor('partner') === 'close', 'partner is close');
check(registerFor('Wife') === 'close', 'case-insensitive');
check(registerFor('client') === 'formal', 'client is professional');
check(registerFor('my boss') === 'formal', 'substring match on a label');
check(registerFor('colleague') === 'formal', 'colleague is professional');
check(registerFor(null) === 'neutral', 'no relationship is neutral');
check(registerFor('Priya') === 'neutral', 'an unrecognised label is neutral, not close');
check(registerFor('fiancee') === 'close', 'unaccented spelling still matches');

console.log('\n[Layering: the same person, two different chats]');
{
  // Same user, writing to their partner.
  const toPartner = composeStyleBrief({
    global: romanticProfile,
    contact: { displayName: 'Priya', relationship: 'partner' },
  });
  check(/Register: close/.test(toPartner), 'a partner chat gets the close register, not a blanket "informal"');

  // Same user, same global profile, writing to a client.
  const toClient = composeStyleBrief({
    global: romanticProfile,
    contact: { displayName: 'R. Mehta', relationship: 'client' },
  });
  check(/Register: professional/.test(toClient), 'a client chat gets the professional register');
  check(
    /no pet names|never carry affection/i.test(toClient),
    'the brief explicitly forbids carrying endearments across',
  );
  check(
    /most specific statement wins/.test(toClient),
    'the precedence rule is stated rather than left to the model to average',
  );
  check(
    /Baseline/.test(toClient),
    'the baseline is still available as context, labelled as such',
  );
}

console.log('\n[The transcript outranks the baseline]');
{
  const brief = composeStyleBrief({
    global: romanticProfile,
    contact: { displayName: 'Priya', relationship: 'partner', communicationStyle: 'short Hinglish, teasing' },
  });
  check(/How the user writes with this person specifically: short Hinglish/.test(brief), 'contact-specific notes appear');
  check(
    brief.indexOf('Baseline') < brief.indexOf('this person specifically'),
    'global comes first as background, contact notes follow as the more specific layer',
  );
  check(
    /transcript beats both/i.test(brief),
    'the transcript is named as the highest authority',
  );
}

console.log('\n[Edge cases]');
{
  const empty = composeStyleBrief({});
  check(/no style profile yet/i.test(empty), 'with nothing known, it says so instead of inventing a personality');
  check(/neutral/i.test(empty), 'and defaults to neutral');
}
{
  const noRelationship = composeStyleBrief({ global: romanticProfile, contact: { displayName: 'Unknown' } });
  check(/Register: neutral/.test(noRelationship), 'an unknown contact is not assumed close');
}
{
  const instr = composeStyleBrief({ global: romanticProfile, instructions: 'say I will call back at 6' });
  check(/What the user wants: say I will call back at 6/.test(instr), 'explicit instructions are carried through');
}
{
  // Very long phrase lists must not blow up the prompt.
  const many = composeStyleBrief({
    global: { signaturePhrases: Array.from({ length: 40 }, (_, i) => `phrase${i}`) },
  });
  const listed = (many.match(/phrase\d+/g) ?? []).length;
  check(listed <= 6, 'signature phrases are capped', `${listed} listed`);
}

console.log('\n[When a per-contact profile is worth deriving]');
check(hasEnoughForContactProfile(MIN_MESSAGES_FOR_CONTACT_PROFILE), 'exactly at the threshold is enough');
check(!hasEnoughForContactProfile(MIN_MESSAGES_FOR_CONTACT_PROFILE - 1), 'below it is not, so no wasted model call');
check(!hasEnoughForContactProfile(0), 'a chat with nothing in it derives nothing');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
