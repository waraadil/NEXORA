import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
const env = Object.fromEntries(fs.readFileSync('.env.local','utf8').split('\n').filter(Boolean).filter(l=>!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,'')];}));
process.env.GEMINI_API_KEY = env.GEMINI_API_KEY;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}, realtime:{transport:class{}}});
const { data: list } = await admin.auth.admin.listUsers({perPage:1000});
const userId = list.users.find(u=>u.email==='demo@nexora.app').id;
const intel = await import(pathToFileURL('./src/lib/ai/intelligence.ts').href);
// No contactId → global profile, exactly what "derive my style" does.
const r = await intel.deriveStyleProfile({ userId });
console.log('derive:', r.ok ? 'ok' : JSON.stringify(r));
const { data } = await admin.from('user_style_profiles').select('tone,formality,emoji_usage,punctuation_habits,signature_phrases,confidence,sample_message_count').eq('user_id',userId).maybeSingle();
console.log('PERSISTED:', JSON.stringify(data));
