/* Builds the TV, phone and (on request) desktop web apps for the harness into
 * the git-ignored e2e/.build/{tv,phone,web}, pointed at the fake server: VITE_JELLYFIN_URL /
 * VITE_MEDIALIB_URL are set on the command line, which beats .env.local, so
 * no private address ever lands in these bundles. Always --outDir; dist/ and
 * phone/dist are never written.
 *
 * Cached: a build is reused while its stamp (content hash of every input +
 * the URLs baked in) matches. The TV build bakes the fake's jf/ml ports in, so
 * run.mjs asks the fake server for the previous run's ports first. */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..', '..');
export const BUILD_DIR = path.join(REPO, 'e2e', '.build');

const INPUTS = ['src', 'public', 'phone/src', 'phone/public', 'phone/index.html', 'phone/vite.config.js', 'index.html', 'vite.config.js', 'svelte.config.js', 'vite.licenses.js', 'vite.svelte-consts.js', 'package-lock.json'];
/* the web build reads the phone's sources and public/ plus its own tree (web/dist is its output, never an input) */
const WEB_INPUTS = [...INPUTS, 'web/src', 'web/index.html', 'web/vite.config.js', 'web/dev'];

function hashInputs(root = REPO, inputs = INPUTS) {
  const h = createHash('sha256');
  const walk = (p) => {
    const abs = path.join(root, p);
    if (!existsSync(abs)) return;
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const f of readdirSync(abs).sort()) walk(path.join(p, f));
    } else {
      h.update(p).update('\0').update(readFileSync(abs)).update('\0');
    }
  };
  for (const p of inputs) walk(p);
  return h.digest('hex').slice(0, 16);
}

function run(args, env, cwd = REPO) {
  return new Promise((resolve, reject) => {
    const p = spawn('npx', args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error('build failed: npx ' + args.join(' ') + '\n' + out.slice(-3000)))));
  });
}

/* dir: where the builds + stamps live (run.mjs's parallel workers each have
 * their own, because the fake's ports are baked into the bundles).
 * tvRoot: build the TV app from another source tree (a mutant copy under
 * e2e/.build, scripts/mutants.mjs) — the phone and web apps always come from REPO.
 * web: also build the desktop web client (web/vite.config.js; run.mjs asks for
 * it only when a selected test has app 'web'). Like the phone app it talks to
 * its own origin's /jf + /ml, so no port is baked in; the VITE_* pair is set
 * anyway so .env.local can never reach a harness bundle. */
export async function buildApps({ jf, ml, log = () => {}, dir: buildDir = BUILD_DIR, tvRoot = REPO, web = false }) {
  mkdirSync(buildDir, { recursive: true });
  const env = { VITE_JELLYFIN_URL: jf, VITE_MEDIALIB_URL: ml };
  const out = {};
  let inputs;
  for (const app of web ? ['tv', 'phone', 'web'] : ['tv', 'phone']) {
    const root = app === 'tv' ? tvRoot : REPO;
    inputs = hashInputs(root, app === 'web' ? WEB_INPUTS : INPUTS);
    const dir = path.join(buildDir, app);
    const stampFile = path.join(buildDir, app + '.stamp');
    const stamp = JSON.stringify({ inputs, ...env, ...(root !== REPO ? { root } : {}) });
    if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp && existsSync(path.join(dir, 'index.html'))) {
      log(`${app} build cached (${inputs})`);
    } else {
      const t0 = Date.now();
      const args = ['vite', 'build', ...(app === 'tv' ? [] : ['--config', app + '/vite.config.js']), '--outDir', dir, '--emptyOutDir', '--logLevel', 'warn'];
      await run(args, env, root);
      writeFileSync(stampFile, stamp);
      log(`${app} built in ${Date.now() - t0} ms`);
    }
    out[app] = dir;
  }
  return { tvDir: out.tv, phoneDir: out.phone, webDir: out.web, inputs };
}
