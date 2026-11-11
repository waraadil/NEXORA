// Loads .env.local into process.env so test harnesses see the same config the
// Next dev server does, then enables the `react-server` condition's sibling
// behaviour for `server-only` imports (handled via --conditions=react-server).
import fs from 'node:fs';

if (fs.existsSync('.env.local')) {
  for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}
