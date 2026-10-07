/* Headless Chrome for the harness: a throwaway profile under run/, a CDP port
 * Chrome picks itself (--remote-debugging-port=0 → DevToolsActivePort), and a
 * two-layer NETWORK GUARD:
 *
 *  1. CDP Fetch interception on every page and worker/service-worker target:
 *     a request is allowed only to the fake server's own loopback ports (and
 *     data:/blob:). The TV app's hard-coded picture service
 *     (http://127.0.0.1:8791) is rewritten onto the fake one. Anything else is
 *     failed (BlockedByClient) and recorded in guard.blocked → the run fails.
 *  2. --proxy-server pointing at a loopback sink + --host-resolver-rules:
 *     whatever slips past Fetch (browser-internal traffic, a target that
 *     attached late) never reaches a real host; hits land in guard.proxyHits.
 *
 * Process cleanup: Chrome runs in its own process group and is SIGKILLed as a
 * group on close() and on process exit, so a crashed run never leaves it. */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { CDP } from './cdp.mjs';
import { Page } from './page.mjs';

const CHROME = process.env.E2E_CHROME || 'google-chrome';
const PIC_REAL = '127.0.0.1:8791';

const live = new Set();
function killAll() {
  for (const p of live) {
    try {
      process.kill(-p.pid, 'SIGKILL');
    } catch {}
  }
  live.clear();
}
process.on('exit', killAll);

/* profiles left behind by a run that was killed hard (SIGKILL, power) */
function pruneStale(runDir) {
  for (const d of existsSync(runDir) ? readdirSync(runDir) : []) {
    if (!d.startsWith('chrome-')) continue;
    const p = path.join(runDir, d);
    try {
      if (Date.now() - statSync(p).mtimeMs > 10 * 60 * 1000) rmSync(p, { recursive: true, force: true });
    } catch {}
  }
}

export async function launchChrome({ runDir, allowPorts, picUrl, headless = true }) {
  pruneStale(runDir);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const userDataDir = path.join(runDir, 'chrome-' + id);
  mkdirSync(userDataDir, { recursive: true });

  /* proxyHits: requests that reached the sink. Chrome's own background
   * services (time sync, sign-in, component updates — all *.google.com and
   * friends) are blocked there too but counted separately as browserNoise:
   * the app never talks to those hosts, and page/worker traffic is judged by
   * the Fetch layer, which blocks every non-fixture host. Any other host in
   * the sink fails the run. */
  const guard = { blocked: [], proxyHits: [], browserNoise: [], allowPorts: new Set(allowPorts.map(String)) };
  const NOISE = /^(?:[\w-]+\.)*(?:google\.com|gstatic\.com|googleapis\.com|gvt1\.com|googleusercontent\.com)(?::\d+)?$/i;
  const hit = (desc, host) => (NOISE.test(host) ? guard.browserNoise : guard.proxyHits).push(desc);
  const sink = http.createServer((req, res) => {
    let host = '';
    try {
      host = new URL(req.url).host;
    } catch {}
    hit(req.method + ' ' + req.url, host);
    res.writeHead(403);
    res.end('blocked by e2e network guard');
  });
  sink.on('connect', (req, sock) => {
    // a CONNECT socket has no 'error' listener of its own: Chrome resetting it
    // (ECONNRESET) would otherwise crash the whole run
    sock.on('error', () => {});
    hit('CONNECT ' + req.url, req.url);
    sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  sink.on('clientError', (e, sock) => sock.destroy());
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const sinkPort = sink.address().port;

  const args = [
    ...(headless ? ['--headless=new'] : []),
    '--remote-debugging-port=0',
    '--user-data-dir=' + userDataDir,
    '--no-first-run', '--no-default-browser-check', '--no-service-autorun', '--password-store=basic', '--use-mock-keychain',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions',
    '--disable-domain-reliability', '--disable-client-side-phishing-detection', '--disable-breakpad', '--disable-crash-reporter',
    '--metrics-recording-only', '--no-pings', '--disable-component-extensions-with-background-pages', '--disable-search-engine-choice-screen',
    '--disable-field-trial-config', '--disable-dev-shm-usage', '--disable-hang-monitor', '--disable-popup-blocking', '--disable-prompt-on-repost',
    '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions,PrivacySandboxSettings4,NetworkTimeServiceQuerying,SafeBrowsing,ChromeWhatsNewUI,SigninInterceptBubble',
    '--proxy-server=http://127.0.0.1:' + sinkPort,
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--hide-scrollbars',
    '--window-size=1920,1080',
    'about:blank'
  ];
  const proc = spawn(CHROME, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  live.add(proc);
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  proc.on('exit', () => live.delete(proc));

  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const t0 = Date.now();
  while (!existsSync(portFile) || readFileSync(portFile, 'utf8').split('\n').length < 2) {
    if (proc.exitCode !== null) throw new Error('Chrome exited early: ' + stderr);
    if (Date.now() - t0 > 20000) throw new Error('Chrome did not start (no DevToolsActivePort): ' + stderr);
    await new Promise((r) => setTimeout(r, 50));
  }
  const [port, wsPath] = readFileSync(portFile, 'utf8').trim().split('\n');
  const cdp = await CDP.connect(`ws://127.0.0.1:${port}${wsPath}`);

  /* ---- guard: one handler for every attached session ---- */
  const guarded = new Set();
  /* sessionId → { type, url } of every attached target (page, worker,
   * service_worker, iframe …): lets a blocked request name who sent it */
  const targets = new Map();
  function allowed(u) {
    if (/^(data|blob|about|chrome|devtools):/.test(u.protocol)) return 'ok';
    if ((u.hostname === '127.0.0.1' || u.hostname === 'localhost') && guard.allowPorts.has(u.port || '80')) return 'ok';
    if (u.host === PIC_REAL && picUrl) return 'pic';
    return null;
  }
  cdp.on('Fetch.requestPaused', (p, sid) => {
    let u;
    try {
      u = new URL(p.request.url);
    } catch {
      return cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sid).catch(() => {});
    }
    const a = allowed(u);
    if (a === 'ok') return cdp.send('Fetch.continueRequest', { requestId: p.requestId }, sid).catch(() => {});
    if (a === 'pic') return cdp.send('Fetch.continueRequest', { requestId: p.requestId, url: picUrl + u.pathname + u.search }, sid).catch(() => {});
    guard.blocked.push({ url: p.request.url, method: p.request.method, type: p.resourceType, session: sid, target: targets.get(sid)?.type || 'unknown' });
    return cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sid).catch(() => {});
  });
  /* A target whose Fetch.enable fails would run unguarded (only the proxy
   * sink behind it, which files Google hosts as browser noise): retry once,
   * and if the target is still attached after that, it is a guard failure
   * the running test reports like a blocked request. A target that detached
   * meanwhile (a worker that ended at once) can't send anything. The one
   * accepted failure: a dedicated worker has no Fetch domain at all ("wasn't
   * found") — Chrome routes its network through the owning frame, whose
   * session must then be guarded (measured in 01-guard: its foreign fetch is
   * blocked on the 'page' session). */
  async function guardSession(sid) {
    if (guarded.has(sid)) return;
    guarded.add(sid);
    const viaParent = (e) => {
      const t = targets.get(sid);
      return t?.type === 'worker' && /wasn't found/.test(String(e?.message || e)) && t.parent && guarded.has(t.parent);
    };
    const enable = () => cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sid);
    try {
      await enable();
    } catch (e0) {
      if (viaParent(e0)) return;
      await new Promise((r) => setTimeout(r, 50));
      try {
        await enable();
      } catch (e) {
        await new Promise((r) => setTimeout(r, 200));
        if (!targets.has(sid)) return;
        const t = targets.get(sid);
        guard.blocked.push({ url: `(unguarded ${t.type} target ${t.url})`, method: 'Fetch.enable failed:', type: String(e.message || e).slice(0, 160), session: sid, target: t.type });
      }
    }
  }

  /* contextId → its Page: errors in that context's workers / service worker
   * are the page's errors (they fail the test like the page's own) */
  const pages = new Map();
  async function watchErrors(sid, info) {
    const owner = pages.get(info.browserContextId);
    if (!owner) return;
    const who = `${info.type} ${info.url.replace(/^https?:\/\/[^/]+/, '')}`;
    owner.offs.push(
      cdp.on('Runtime.consoleAPICalled', (p) => {
        const text = p.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ');
        owner.console.push({ type: p.type, text: `[${who}] ${text}` });
        if (p.type === 'error' || p.type === 'assert') owner.errors.push({ kind: `console.${p.type} in ${who}`, text });
      }, sid),
      cdp.on('Runtime.exceptionThrown', (p) => {
        const d = p.exceptionDetails;
        owner.errors.push({ kind: `exception in ${who}`, text: (d.exception?.description || d.text || '').split('\n').slice(0, 4).join(' | ') });
      }, sid),
      cdp.on('Log.entryAdded', (p) => {
        if (p.entry.level === 'error') owner.errors.push({ kind: `log.${p.entry.source} in ${who}`, text: p.entry.text + (p.entry.url ? ' ' + p.entry.url : '') });
      }, sid)
    );
    // not awaited: a target paused for the debugger may hold these answers
    // until Runtime.runIfWaitingForDebugger (sent right after, same order as
    // Puppeteer); the session still processes them first
    cdp.send('Runtime.enable', {}, sid).catch(() => {});
    cdp.send('Log.enable', {}, sid).catch(() => {});
  }
  /* workers / service workers / iframes: attached paused, guarded, resumed */
  cdp.on('Target.attachedToTarget', async (p, parent) => {
    const sid = p.sessionId;
    targets.set(sid, { type: p.targetInfo.type, url: p.targetInfo.url, targetId: p.targetInfo.targetId, parent });
    if (p.targetInfo.type !== 'page') {
      await guardSession(sid);
      watchErrors(sid, p.targetInfo);
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid).catch(() => {});
      await cdp.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
    }
  });
  /* a target that went away (its context disposed, a worker ended) leaves the
   * map: a later lookup by type/URL must not find a dead session */
  cdp.on('Target.detachedFromTarget', (p) => {
    targets.delete(p.sessionId);
    guarded.delete(p.sessionId);
  });
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: 'page', exclude: true }, { type: 'tab', exclude: true }, { type: 'browser', exclude: true }, {}]
  });

  const browser = {
    cdp, guard, proc, userDataDir, targets,
    async newPage(opts = {}) {
      const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      targets.set(sessionId, { type: 'page', url: 'about:blank', targetId, parent: null });
      await guardSession(sessionId);
      const page = new Page(cdp, sessionId, { targetId, browserContextId, ...opts });
      pages.set(browserContextId, page);
      page.offs.push(() => pages.delete(browserContextId));
      await page.init();
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
      return page;
    },
    async close() {
      try {
        await cdp.send('Browser.close', {}, null, { timeout: 3000 });
      } catch {}
      cdp.close();
      const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once('exit', r));
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {}
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      live.delete(proc);
      await new Promise((r) => sink.close(r));
      for (let i = 0; i < 20; i++) {
        try {
          rmSync(userDataDir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
  };
  return browser;
}
