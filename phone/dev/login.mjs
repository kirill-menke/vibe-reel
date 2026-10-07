#!/usr/bin/env node
/* Mint a Jellyfin token for the phone dev server and store it in the
 * gitignored phone/.devcreds.json (mode 0600), which /__devcreds serves to
 * `/?devlogin` and the /__frame page. Run via `phone/dev-chrome.sh login`.
 *
 * Asks for username + password on the terminal (password not echoed), signs
 * in through the dev server's /jf proxy with its own DeviceId
 * `reel-chrome-dev` — so re-running it only replaces the previous dev token,
 * never the TV's or the iPhone's — and never prints the token.
 *
 *   REEL_DEV_URL   dev server origin (default http://127.0.0.1:8930) */
import { writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', '.devcreds.json');
const BASE = (process.env.REEL_DEV_URL || 'http://127.0.0.1:8930').replace(/\/$/, '');
const DEVICE_ID = 'reel-chrome-dev';

function ask(prompt, { hidden = false } = {}) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error('needs an interactive terminal'));
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let s = '';
    const done = (v, err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', on);
      stdout.write('\n');
      err ? reject(err) : resolve(v);
    };
    const on = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(s);
        if (ch === '\u0003') return done(null, new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') {
          if (s) {
            s = s.slice(0, -1);
            if (!hidden) stdout.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue;
        s += ch;
        if (!hidden) stdout.write(ch);
      }
    };
    stdin.on('data', on);
  });
}

const auth = `MediaBrowser Client="Reel", Device="Chrome (dev)", DeviceId="${DEVICE_ID}", Version="0.1.0"`;

try {
  const ping = await fetch(BASE + '/jf/System/Info/Public', { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!ping || !ping.ok) throw new Error(`no Jellyfin behind ${BASE}/jf — start the dev server first (phone/dev-chrome.sh)`);
  const user = (await ask('Jellyfin username: ')).trim();
  if (!user) throw new Error('no username');
  const pass = await ask('Password (not shown): ', { hidden: true });
  const r = await fetch(BASE + '/jf/Users/AuthenticateByName', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ Username: user, Pw: pass }),
    signal: AbortSignal.timeout(20000)
  });
  if (r.status === 401) throw new Error('wrong username or password');
  if (!r.ok) throw new Error('sign-in failed: HTTP ' + r.status);
  const j = await r.json();
  if (!j.AccessToken || !j.User?.Id) throw new Error('unexpected answer from Jellyfin');
  const creds = { token: j.AccessToken, userId: j.User.Id, userName: j.User.Name || user, deviceId: DEVICE_ID, created: new Date().toISOString() };
  const tmp = OUT + '.tmp';
  writeFileSync(tmp, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, OUT);
  console.log(`Signed in as ${creds.userName}; saved to ${path.relative(process.cwd(), OUT) || OUT} (gitignored).`);
  console.log('Open the frame again (or its "Dev login" button) to use it.');
} catch (e) {
  console.error('login: ' + e.message);
  process.exit(1);
}
