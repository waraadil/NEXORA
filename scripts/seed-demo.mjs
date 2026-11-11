/**
 * Seeds the demo account with realistic conversations so every screen has content.
 * Idempotent: re-running replaces this account's conversations rather than
 * duplicating them.
 *
 *   node scripts/seed-demo.mjs
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter(Boolean).filter((l) => !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: class {} },
});

const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
const user = list.users.find((u) => u.email === 'demo@nexora.app');
if (!user) { console.error('demo user missing — run the create-user step first'); process.exit(1); }
const userId = user.id;

const PEOPLE = [
  { name: 'Priya Sharma', rel: 'friend', relDetail: 'Close friend since university. Photographer.',
    style: 'casual, lowercase, minimal punctuation, occasional emoji', personality: 'Dry humour. Sends several short messages in a row rather than one long one.',
    msgs: [
      ['them', 'hey, are we still on for saturday?', '2026-11-03T10:12:00Z'],
      ['me', 'yep booked the tickets this morning', '2026-11-03T10:18:00Z'],
      ['them', 'perfect, see you at 6', '2026-11-03T10:19:00Z'],
      ['them', 'also im bringing the camera, the light by the river is unreal at that hour', '2026-11-03T10:21:00Z'],
      ['me', 'good call. bring the charger too, mine dies in an hour', '2026-11-03T10:26:00Z'],
      ['them', 'noted. my mom asked about you btw', '2026-11-04T09:02:00Z'],
      ['me', 'tell her i said hi 😄 hows she doing after the wedding?', '2026-11-04T09:15:00Z'],
      ['them', 'tired but happy. shes already planning the next one, some cousin in jaipur in feb', '2026-11-04T09:20:00Z'],
      ['me', 'feb is doable. remind me closer to the date and ill book', '2026-11-04T09:31:00Z'],
      ['them', 'will do. youll forget anyway', '2026-11-04T09:33:00Z'],
      ['me', 'probably. write it on my forehead', '2026-11-04T09:34:00Z'],
      ['them', 'bringing the 35mm too, the one that squeaks', '2026-11-04T18:02:00Z'],
      ['me', 'the squeaky one has never let us down', '2026-11-04T18:10:00Z'],
      ['me', 'ok heading out, see you saturday 6', '2026-11-05T16:40:00Z'],
      ['them', '6 it is. dont be late like last time', '2026-11-05T16:44:00Z'],
      ['me', 'i was 8 minutes late. once', '2026-11-05T16:47:00Z'],
      ['them', '8 minutes and you made me hold the tripod', '2026-11-05T16:49:00Z'],
      ['me', 'fair. ill be early this time', '2026-11-05T16:52:00Z'],
      ['them', 'im holding you to that. also i might bring someone', '2026-11-06T11:20:00Z'],
      ['me', 'oh? whos the someone', '2026-11-06T11:26:00Z'],
      ['them', 'nobody. forget i said it', '2026-11-06T11:28:00Z'],
      ['me', 'im not forgetting that. is it the guy from the darkroom', '2026-11-06T11:31:00Z'],
      ['them', 'maybe', '2026-11-06T11:32:00Z'],
      ['me', 'ok well now i want to meet him', '2026-11-06T11:34:00Z'],
      ['them', 'youll be normal about it', '2026-11-06T11:36:00Z'],
      ['me', 'i will be extremely normal', '2026-11-06T11:37:00Z'],
      ['them', 'that means you wont be', '2026-11-06T11:38:00Z'],
      ['me', 'correct. also the river light will be better at 6:30 not 6', '2026-11-06T11:41:00Z'],
    ] },
  { name: 'Rahul Mehta', rel: 'work', relDetail: 'Direct manager. Finance background, allergic to vague updates.',
    style: 'formal, complete sentences, no emoji', personality: 'Asks one pointed follow-up question. Appreciates brevity.',
    msgs: [
      ['them', 'Hi, circling back on the Q4 deck. Can we get the revised numbers by Thursday?', '2026-11-05T06:40:00Z'],
      ['me', 'Yes. I have the updated revenue figures and will send the deck Thursday morning.', '2026-11-05T07:05:00Z'],
      ['them', 'Thanks. The board also wants a note on the churn increase. Anything we should flag?', '2026-11-05T07:11:00Z'],
      ['me', 'The jump is mostly one enterprise account pausing. I will break that out separately so the headline number is not misread.', '2026-11-05T07:24:00Z'],
      ['them', 'That is exactly the right framing. Appreciate it.', '2026-11-05T07:30:00Z'],
      ['me', 'One more thing: the deck currently has the old growth chart. I will swap it before sending.', '2026-11-05T07:48:00Z'],
      ['them', 'Good catch. Also remove the last slide, the roadmap one. It is not ready for the board.', '2026-11-05T07:55:00Z'],
      ['me', 'Understood, removing slide 14. I will send a preview Wednesday evening.', '2026-11-05T08:02:00Z'],
      ['them', 'Wednesday evening works. Thank you.', '2026-11-05T08:05:00Z'],
      ['me', 'Preview sent to your inbox. Two spots flagged in comments.', '2026-11-06T13:30:00Z'],
      ['them', 'Saw it. The comments are clear, no changes needed.', '2026-11-06T14:15:00Z'],
      ['me', 'Great. I will send the final after Wednesday review.', '2026-11-06T14:22:00Z'],
    ] },
  { name: 'Ananya Iyer', rel: 'family', relDetail: 'Mother. Lives in Chennai. Calls on Sundays.',
    style: 'warm, affectionate, mixes Tamil words, no punctuation at the end', personality: 'Worries about whether I have eaten. Never asks for herself.',
    msgs: [
      ['them', 'beta did you eat something? you always forget on work days', '2026-11-06T13:05:00Z'],
      ['me', 'yes amma, had lunch at 1. proper meal, not just coffee', '2026-11-06T13:40:00Z'],
      ['them', 'good. your father wants to know when you are coming home. he will not ask you himself', '2026-11-06T13:45:00Z'],
      ['me', 'tell him the weekend after next. i will book the train this week', '2026-11-06T14:02:00Z'],
      ['them', 'he will be very happy. i am making the kootu he likes', '2026-11-06T14:10:00Z'],
      ['me', 'tell him im looking forward to it. and to the filter coffee', '2026-11-06T14:31:00Z'],
      ['them', 'i will keep the powder ready. do you need anything else', '2026-11-06T14:36:00Z'],
      ['me', 'nothing amma. just keep the room ready', '2026-11-06T14:44:00Z'],
      ['them', 'it is always ready. you know that', '2026-11-06T14:47:00Z'],
      ['me', 'i know. sorry, ill call sunday', '2026-11-06T14:52:00Z'],
      ['them', 'call when you are free, not because you feel bad', '2026-11-06T14:55:00Z'],
      ['me', 'i will call because i want to. sunday morning', '2026-11-06T15:01:00Z'],
    ] },
  { name: 'Dev Kapoor', rel: 'friend', relDetail: 'Gym friend. Sarcastic. Never on time himself.',
    style: 'banter, heavy sarcasm, short', personality: 'Teases constantly. Reliable when it matters.',
    msgs: [
      ['them', 'bro the gym near your place is shutting down', '2026-11-07T15:00:00Z'],
      ['me', 'what?? since when', '2026-11-07T15:03:00Z'],
      ['them', 'notice went up this morning. landlord wants the space back', '2026-11-07T15:05:00Z'],
      ['me', 'thats rough. the one by the market is decent, want to check it out sunday', '2026-11-07T15:09:00Z'],
      ['them', 'sunday works. 9am, and you actually show up this time', '2026-11-07T15:12:00Z'],
      ['me', '9am is aggressive for a sunday', '2026-11-07T15:15:00Z'],
      ['them', 'thats why i picked it', '2026-11-07T15:16:00Z'],
      ['me', 'fine. i will be there at 9. bring the towel', '2026-11-07T15:20:00Z'],
      ['them', 'you bring the towel, i bring the complaints', '2026-11-07T15:22:00Z'],
      ['me', 'deal. if it sucks we try the one near the station', '2026-11-07T15:26:00Z'],
      ['them', 'it will suck. see you at 9', '2026-11-07T15:28:00Z'],
    ] },
];

// Replace prior demo content so re-running does not duplicate.
await admin.from('conversations').delete().eq('user_id', userId);

let convCount = 0;
let msgCount = 0;

for (const p of PEOPLE) {
  const { data: existing } = await admin
    .from('contacts').select('id').eq('user_id', userId).eq('display_name', p.name).maybeSingle();

  let contactId = existing?.id;
  if (!contactId) {
    const { data: c, error } = await admin.from('contacts').insert({
      user_id: userId,
      display_name: p.name,
      relationship: p.rel,
      relationship_detail: p.relDetail,
      communication_style: p.style,
      personality_notes: p.personality,
      last_interaction_at: p.msgs[p.msgs.length - 1][2],
    }).select('id').single();
    if (error) { console.error('contact insert:', error.message); process.exit(1); }
    contactId = c.id;
  }

  const first = p.msgs[0][2];
  const last = p.msgs[p.msgs.length - 1][2];

  const { data: conv, error: convErr } = await admin.from('conversations').insert({
    user_id: userId,
    contact_id: contactId,
    title: p.name,
    source: 'manual',
    first_message_at: first,
    last_message_at: last,
    message_count: p.msgs.length,
  }).select('id').single();
  if (convErr) { console.error('conversation insert:', convErr.message); process.exit(1); }
  convCount++;

  const rows = p.msgs.map(([who, body, at]) => ({
    conversation_id: conv.id,
    user_id: userId,
    sender_name: who === 'me' ? 'Me' : p.name,
    is_from_me: who === 'me',
    direction: who === 'me' ? 'outbound' : 'inbound',
    body,
    sent_at: at,
    message_hash: createHash('sha256').update(`${conv.id}|${at}|${body}`).digest('hex'),
  }));

  const { error } = await admin.from('messages').insert(rows);
  if (error) console.error('message insert:', error.message);
  else msgCount += rows.length;
}

console.log(`Seeded ${convCount} conversations and ${msgCount} messages for demo@nexora.app.`);
