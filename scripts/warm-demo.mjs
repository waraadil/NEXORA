/**
 * Runs the app's real AI functions over the seeded demo data:
 * embeds messages, derives a style profile, and extracts memories per person.
 * This is the same code the UI calls — not a simulation.
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';

const env = Object.fromEntries(fs.readFileSync('.env.local','utf8').split('\n').filter(Boolean).filter(l=>!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,'')];}));
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY;

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}, realtime:{transport:class{}}});
const { data: list } = await admin.auth.admin.listUsers({perPage:1000});
const user = list.users.find(u=>u.email==='demo@nexora.app');
const userId = user.id;

const sem = await import(pathToFileURL('./src/lib/ai/semantic.ts').href);
const intel = await import(pathToFileURL('./src/lib/ai/intelligence.ts').href);

const emb = await sem.embedMissingMessages(userId);
console.log('embed:', JSON.stringify(emb));

const { data: convs } = await admin.from('conversations').select('id,title,contact_id').eq('user_id',userId);
for (const c of convs) {
  const style = await intel.deriveStyleProfile({ userId, conversationId: c.id, contactId: c.contact_id });
  console.log(`style [${c.title}]:`, style.ok ? 'ok' : JSON.stringify(style).slice(0,120));
  const mem = await intel.extractMemories({ userId, conversationId: c.id });
  console.log(`memory [${c.title}]:`, mem.ok ? JSON.stringify(mem.data) : JSON.stringify(mem).slice(0,120));
}

const { count } = await admin.from('message_embeddings').select('*',{count:'exact',head:true}).eq('user_id',userId);
const { data: mems } = await admin.from('memories').select('kind,content,provenance').eq('user_id',userId);
console.log(`\n${count} embeddings, ${mems.length} memories`);
mems.forEach(m=>console.log(` · [${m.kind}/${m.provenance}] ${m.content}`));
