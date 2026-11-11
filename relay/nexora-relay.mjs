#!/usr/bin/env node
/**
 * NEXORA relay launcher — zero install
 *
 * Downloads the relay, keeps it up to date, and runs it. No npm account, no
 * global install, no editing files. This is what the command in NEXORA runs.
 *
 *   node <this-file>          run (installs on first use, reuses afterwards)
 *   node <this-file> --reset  forget the local WhatsApp session
 *
 * Environment (set by NEXORA when it generates the command):
 *   NEXORA_URL           https://your-app.vercel.app
 *   NEXORA_PAIRING_CODE  nxr_relay_...
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rm, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const BASE = (process.env.NEXORA_URL || '').replace(/\/+$/, '');
const KEY = process.env.NEXORA_PAIRING_CODE || '';
const ROOT = join(homedir(), '.nexora-relay');
const VERSION_MARK = join(ROOT, '.version');
const RELAY_FILE = join(ROOT, 'relay.mjs');
const RELAY_PKG = join(ROOT, 'package.json');

const say = (...a) => console.log(...a);

if (!BASE || !KEY) {
  console.error(
    '\nThis launcher is meant to be started by NEXORA.\n\n' +
      'Open NEXORA → Integrations → Personal WhatsApp → Get started, and copy the\n' +
      'command it shows — it already contains your server URL and pairing key.\n',
  );
  process.exit(1);
}

async function currentVersion() {
  try {
    return (await readFile(VERSION_MARK, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(dest));
}

// The relay is published from the app repo, so the launcher always runs the
// newest build without the user reinstalling anything.
const REVISION = process.env.NEXORA_RELAY_REV || 'main';
const RAW = `https://raw.githubusercontent.com/waraadil/NEXORA/${REVISION}`;

async function ensureRelay() {
  await mkdir(ROOT, { recursive: true });

  const want = REVISION;
  if ((await currentVersion()) === want) {
    try {
      const st = await stat(RELAY_FILE);
      if (st.size > 1000) return;
    } catch {
      /* re-download below */
    }
  }

  say('Setting up the NEXORA relay (one time, a few seconds)…');

  const tmpRelay = `${RELAY_FILE}.download`;
  const tmpPkg = `${RELAY_PKG}.download`;

  await download(`${RAW}/relay/relay.mjs`, tmpRelay);
  await download(`${RAW}/relay/package.json`, tmpPkg);
  await rename(tmpRelay, RELAY_FILE);
  await rename(tmpPkg, RELAY_PKG);
  await writeFile(VERSION_MARK, want);

  const hasDeps = await stat(join(ROOT, 'node_modules', '@whiskeysockets', 'baileys'))
    .then(() => true)
    .catch(() => false);

  if (!hasDeps) {
    say('Installing WhatsApp connectivity (about a minute)…');
    await new Promise((resolve, reject) => {
      const npm = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], {
        cwd: ROOT,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
      npm.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`npm install exited with ${code}`)),
      );
      npm.on('error', reject);
    });
  }
}

if (process.argv.includes('--reset')) {
  await rm(join(ROOT, 'auth'), { recursive: true, force: true });
  say(`Cleared the local WhatsApp session in ${join(ROOT, 'auth')}.`);
  say('Run the command from NEXORA again to pair a device.');
  process.exit(0);
}

try {
  await ensureRelay();
} catch (e) {
  console.error(`\nSetup failed: ${e.message}`);
  console.error('Check your internet connection and try again.');
  process.exit(1);
}

// Hand over to the relay, inheriting the terminal so pairing codes and
// Ctrl-C behave exactly as if it had been run directly.
const child = spawn(process.execPath, [RELAY_FILE, ...process.argv.slice(2)], {
  cwd: ROOT,
  env: process.env,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
