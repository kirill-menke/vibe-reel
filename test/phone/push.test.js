/* phone/src/lib/push.js — Web Push subscribe / sign-out / notification taps.
 *
 * CLAUDE.md: "The server keys a subscription by endpoint with the user's token, so
 * sign-out / account switch (Accounts sheet) first pushSignOut()s it off the
 * server (the browser subscription stays; the next signed-in start re-registers
 * it), and syncPush() does the same when it starts with nobody signed in." and
 * "iOS delivers only to the home-screen app, and requestPermission() must run
 * synchronously in the tap."
 *
 * The browser half (Notification, PushManager, navigator.serviceWorker and its
 * registration's pushManager) is a fake installed per test; reel-api is
 * mockFetch() at http://ml.test/api/push. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { freshImport, TEST_MEDIALIB, TEST_TOKEN, TEST_USER, accountStorage } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock } from '../helpers/time.js';
import { readJSON } from '../helpers/storage.js';

const PUSH = TEST_MEDIALIB + '/api/push';
const KEY_BYTES = Uint8Array.from({ length: 65 }, (_, i) => (i * 7 + 3) & 255);
const KEY = Buffer.from(KEY_BYTES).toString('base64url'); // unpadded base64url, as reel-api sends it
const OTHER_KEY = Uint8Array.from({ length: 65 }, (_, i) => i & 255);
const ITEM = '0123456789abcdef0123456789abcdef';

/** A browser subscription. */
function makeSub(endpoint, keyBytes = KEY_BYTES) {
  return {
    endpoint,
    options: { applicationServerKey: keyBytes ? keyBytes.slice().buffer : null },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => true)
  };
}

let env;
/* Installs the push-capable browser: Notification (permission + requestPermission),
 * window.PushManager, navigator.standalone and a navigator.serviceWorker whose
 * `ready` registration has a pushManager. */
function installPush({ perm = 'granted', answer = 'granted', sub = makeSub('https://push.test/ep-1'), ready = true, standalone = true, api = true } = {}) {
  env = { perm, answer, sub, subscribed: 0 };
  const pushManager = {
    getSubscription: vi.fn(async () => env.sub),
    subscribe: vi.fn(async ({ applicationServerKey }) => {
      env.subscribed++;
      env.sub = makeSub('https://push.test/ep-new-' + env.subscribed, new Uint8Array(applicationServerKey));
      return env.sub;
    })
  };
  env.reg = { pushManager };
  const container = new EventTarget();
  container.ready = ready ? Promise.resolve(env.reg) : new Promise(() => {});
  env.container = container;
  if (api) {
    const N = class {
      static get permission() {
        return env.perm;
      }
    };
    N.requestPermission = vi.fn(() => {
      env.perm = env.answer;
      return Promise.resolve(env.answer);
    });
    env.Notification = N;
    vi.stubGlobal('Notification', N);
    vi.stubGlobal('PushManager', class {});
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
  } else delete navigator.serviceWorker; // 'serviceWorker' in navigator → false: no push API
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: standalone });
  return env;
}

let m;
async function load({ signedIn = true, storage = {} } = {}) {
  m = await freshImport({
    signedIn,
    storage: { 'reel.push': { ready: true, seasons: false }, ...storage },
    modules: {
      push: 'phone/src/lib/push.js',
      nav: 'src/lib/nav.svelte.js',
      router: 'phone/src/lib/router.svelte.js',
      toast: 'src/lib/toast.svelte.js',
      config: 'src/lib/config.js'
    }
  });
  return m;
}

const configOk = (net) => net.on('GET', '/api/push/config', { enabled: true, key: KEY });

afterEach(() => {
  delete navigator.serviceWorker;
  delete navigator.standalone;
  delete navigator.userAgent;
  history.replaceState(null, '', '/');
});

/* ------------------------------------------------------------ sign-out ---- */

describe('pushSignOut(): the server forgets this device, the browser keeps its subscription', () => {
  it('POSTs the endpoint to /unsubscribe (keepalive, 2.5 s deadline); the browser subscription and the prefs stay', async () => {
    installPush();
    await load();
    const clock = useClock();
    const net = mockFetch();
    net.on('POST', '/api/push/unsubscribe', null);
    await m.push.pushSignOut();
    const calls = net.callsTo('/api/push/unsubscribe', 'POST');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(PUSH + '/unsubscribe');
    expect(calls[0].body).toEqual({ endpoint: 'https://push.test/ep-1' });
    expect(calls[0].keepalive).toBe(true); // it races the reload that follows
    expect(clock.timeouts).toContain(2500);
    expect(env.sub.unsubscribe).not.toHaveBeenCalled();
    expect(readJSON('reel.push')).toEqual({ ready: true, seasons: false });
    expect(net.unmatched).toEqual([]);
  });

  it('nothing to do: no permission, no push API, or no subscription — no request', async () => {
    const net = mockFetch();
    installPush({ perm: 'default' });
    await load();
    await m.push.pushSignOut();
    installPush({ perm: 'granted', sub: null });
    await load();
    await m.push.pushSignOut();
    installPush({ api: false });
    await load();
    await m.push.pushSignOut();
    expect(net.calls).toEqual([]);
  });

  it('best effort and bounded: a service worker that never gets ready is given up after 1.5 s', async () => {
    installPush({ ready: false });
    await load();
    const clock = useClock();
    const net = mockFetch();
    let done = false;
    m.push.pushSignOut().then(() => (done = true));
    await clock.tick(1499);
    expect(done).toBe(false);
    await clock.tick(1);
    expect(done).toBe(true);
    expect(net.calls).toEqual([]);
  });

  it('a hung reel-api: resolves (never rejects) at the 2.5 s deadline, so the sign-out reload goes ahead', async () => {
    installPush();
    await load();
    const clock = useClock();
    const net = mockFetch();
    net.on('POST', '/api/push/unsubscribe', net.hang());
    let settled = null;
    m.push.pushSignOut().then(() => (settled = 'resolved'), () => (settled = 'rejected'));
    await clock.tick(2499);
    expect(settled).toBe(null);
    await clock.tick(1);
    expect(settled).toBe('resolved');
  });

  it('a network error or a 500 still resolves', async () => {
    installPush();
    await load();
    const net = mockFetch();
    net.on('POST', '/api/push/unsubscribe', net.networkError());
    await expect(m.push.pushSignOut()).resolves.toBeUndefined();
    net.on('POST', '/api/push/unsubscribe', net.status(500));
    await expect(m.push.pushSignOut()).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------ syncPush ---- */

describe('syncPush() on start', () => {
  it('nobody signed in: takes the device off the server (the same sign-out) — no /config, no /subscribe', async () => {
    installPush();
    await load({ signedIn: false });
    const net = mockFetch();
    const unsub = /\/api\/push\/unsubscribe$/;
    net.on('POST', unsub, null);
    m.push.syncPush();
    await vi.waitFor(() => expect(net.callsTo(unsub, 'POST')).toHaveLength(1));
    expect(net.callsTo(unsub)[0].body).toEqual({ endpoint: 'https://push.test/ep-1' });
    // signed out, reel-api is the page's own /ml (cfg.medialib's phone fallback)
    expect(net.calls.map((c) => c.url)).toEqual(['http://phone.test/ml/api/push/unsubscribe']);
    expect(env.sub.unsubscribe).not.toHaveBeenCalled();
  });

  it('signed in: re-registers the existing subscription with this user’s token, ids and prefs', async () => {
    installPush();
    await load({ storage: { 'reel.push': { ready: true, seasons: true } } });
    const net = mockFetch();
    configOk(net);
    net.on('POST', '/api/push/subscribe', { ok: true });
    m.push.syncPush();
    await vi.waitFor(() => expect(net.callsTo('/api/push/subscribe', 'POST')).toHaveLength(1));
    expect(net.callsTo('/api/push/subscribe')[0].body).toEqual({
      subscription: { endpoint: 'https://push.test/ep-1', keys: { p256dh: 'p', auth: 'a' } },
      token: TEST_TOKEN,
      user_id: TEST_USER,
      device_id: 'dev-test',
      ready: true,
      seasons: true
    });
    expect(env.reg.pushManager.subscribe).not.toHaveBeenCalled(); // same server key: reused
    expect(env.sub.unsubscribe).not.toHaveBeenCalled();
  });

  it('after a sign-out the next signed-in start registers the kept browser subscription for the new user, without a tap', async () => {
    installPush();
    await load();
    const net = mockFetch();
    net.on('POST', '/api/push/unsubscribe', null);
    await m.push.pushSignOut();
    const kept = env.sub;
    // the reload: another account signs in, the browser subscription is the same object
    await load({ storage: accountStorage({ userId: 'u2', token: 'tok-u2' }) });
    configOk(net);
    net.on('POST', '/api/push/subscribe', { ok: true });
    m.push.syncPush();
    await vi.waitFor(() => expect(net.callsTo('/api/push/subscribe', 'POST')).toHaveLength(1));
    const body = net.callsTo('/api/push/subscribe')[0].body;
    expect([body.token, body.user_id, body.subscription.endpoint]).toEqual(['tok-u2', 'u2', kept.endpoint]);
    expect(env.Notification.requestPermission).not.toHaveBeenCalled();
    expect(env.reg.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('a subscription made for another server key is replaced (unsubscribe, then subscribe with the new key)', async () => {
    installPush({ sub: makeSub('https://push.test/old', OTHER_KEY) });
    await load();
    const old = env.sub;
    const net = mockFetch();
    configOk(net);
    net.on('POST', '/api/push/subscribe', { ok: true });
    m.push.syncPush();
    await vi.waitFor(() => expect(net.callsTo('/api/push/subscribe', 'POST')).toHaveLength(1));
    expect(old.unsubscribe).toHaveBeenCalledTimes(1);
    const arg = env.reg.pushManager.subscribe.mock.calls[0][0];
    expect(arg.userVisibleOnly).toBe(true);
    expect([...arg.applicationServerKey]).toEqual([...KEY_BYTES]); // base64url decoded, padding restored
    expect(net.callsTo('/api/push/subscribe')[0].body.subscription.endpoint).toBe('https://push.test/ep-new-1');
  });

  it('a same-length key that differs in one byte is replaced too', async () => {
    const near = KEY_BYTES.slice();
    near[64] ^= 1;
    installPush({ sub: makeSub('https://push.test/old', near) });
    await load();
    const old = env.sub;
    const net = mockFetch();
    configOk(net);
    net.on('POST', '/api/push/subscribe', { ok: true });
    m.push.syncPush();
    await vi.waitFor(() => expect(net.callsTo('/api/push/subscribe', 'POST')).toHaveLength(1));
    expect(old.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('nothing asked for, no permission, or no push API: does nothing at all (signed in or not)', async () => {
    const net = mockFetch();
    installPush();
    await load({ storage: { 'reel.push': { ready: false, seasons: false } } });
    m.push.syncPush();
    installPush({ perm: 'denied' });
    await load({ signedIn: false });
    m.push.syncPush();
    installPush({ api: false });
    await load();
    m.push.syncPush();
    await new Promise((r) => setTimeout(r, 20));
    expect(net.calls).toEqual([]);
  });

  it('a server without push set up: the start stays quiet (no subscribe, no throw)', async () => {
    installPush();
    await load();
    const net = mockFetch();
    net.on('GET', '/api/push/config', { enabled: false });
    expect(() => m.push.syncPush()).not.toThrow();
    await vi.waitFor(() => expect(net.callsTo('/api/push/config')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(net.callsTo('/api/push/subscribe')).toEqual([]);
    expect(env.reg.pushManager.subscribe).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------- setPush ---- */

describe('setPush(): the permission prompt runs synchronously inside the tap', () => {
  it('permission "default": requestPermission() is called before setPush returns (no await in front of it)', async () => {
    installPush({ perm: 'default', sub: null });
    await load({ storage: { 'reel.push': null } });
    const net = mockFetch();
    configOk(net);
    net.on('POST', '/api/push/subscribe', { ok: true });
    const p = m.push.setPush('ready', true);
    // still inside the same task as the tap: no microtask has run yet
    expect(env.Notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(net.calls).toEqual([]); // and it was the first thing, before any request
    await expect(p).resolves.toEqual({ ready: true, seasons: false });
    expect(env.reg.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(readJSON('reel.push')).toEqual({ ready: true, seasons: false });
  });

  it('already granted: no prompt; denied: no prompt, a Settings hint, nothing saved, no request', async () => {
    installPush({ perm: 'granted' });
    await load({ storage: { 'reel.push': null } });
    const net = mockFetch();
    configOk(net);
    net.on('POST', '/api/push/subscribe', { ok: true });
    await m.push.setPush('seasons', true);
    expect(env.Notification.requestPermission).not.toHaveBeenCalled();

    installPush({ perm: 'denied' });
    await load({ storage: { 'reel.push': null } });
    net.reset();
    await expect(m.push.setPush('ready', true)).rejects.toThrow(/Settings → Notifications → VibeReel/);
    expect(env.Notification.requestPermission).not.toHaveBeenCalled();
    expect(net.calls).toEqual([]);
    expect(readJSON('reel.push')).toBe(null);
  });

  it('the prompt dismissed: rejects "weren’t allowed", nothing registered', async () => {
    installPush({ perm: 'default', answer: 'default' });
    await load({ storage: { 'reel.push': null } });
    const net = mockFetch();
    await expect(m.push.setPush('ready', true)).rejects.toThrow('Notifications weren’t allowed');
    expect(net.calls).toEqual([]);
  });

  it('the last kind off: unsubscribes on the server and in the browser, and forgets the prefs', async () => {
    installPush();
    await load();
    const sub = env.sub;
    const net = mockFetch();
    net.on('POST', '/api/push/unsubscribe', null);
    await expect(m.push.setPush('ready', false)).resolves.toEqual({ ready: false, seasons: false });
    expect(net.callsTo('/api/push/unsubscribe')[0].body).toEqual({ endpoint: sub.endpoint });
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('reel.push')).toBe(null);
    expect(env.Notification.requestPermission).not.toHaveBeenCalled();
  });

  it('best effort when turning off: a failing server unsubscribe or browser unsubscribe still clears the prefs', async () => {
    installPush();
    await load();
    env.sub.unsubscribe.mockRejectedValue(new Error('gone'));
    const net = mockFetch();
    net.on('POST', '/api/push/unsubscribe', net.networkError());
    await expect(m.push.setPush('ready', false)).resolves.toEqual({ ready: false, seasons: false });
    expect(localStorage.getItem('reel.push')).toBe(null);
  });

  it('a non-JSON error body reads as "HTTP <status>"; an old-key subscription that won’t unsubscribe is still replaced', async () => {
    installPush({ sub: makeSub('https://push.test/old', OTHER_KEY) });
    env.sub.unsubscribe.mockRejectedValue(new Error('nope'));
    await load({ storage: { 'reel.push': null } });
    const net = mockFetch();
    configOk(net);
    net.on('POST', '/api/push/subscribe', net.status(502, '<html>bad gateway</html>', { 'content-type': 'text/html' }));
    const e = await m.push.setPush('seasons', true).catch((x) => x);
    expect(e.message).toBe('HTTP 502');
    expect(env.reg.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it('a failed /subscribe rejects with the server’s detail and keeps the old prefs', async () => {
    installPush();
    await load({ storage: { 'reel.push': null } });
    const net = mockFetch();
    configOk(net);
    net.on('POST', '/api/push/subscribe', net.status(502, { detail: 'bad gateway' }));
    const e = await m.push.setPush('ready', true).catch((x) => x);
    expect(e.message).toBe('bad gateway');
    expect(e.status).toBe(502);
    expect(readJSON('reel.push')).toBe(null);
  });
});

/* ------------------------------------------------------ server state etc ---- */

describe('pushSupport / pushServerState / sendTestPush', () => {
  it('pushSupport: the Home Screen app → ok; an iPhone Safari tab → browser; nothing → unsupported', async () => {
    installPush({ standalone: true });
    await load();
    expect(m.push.pushSupport()).toBe('ok');
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)' });
    installPush({ standalone: false, api: false });
    vi.unstubAllGlobals();
    delete navigator.serviceWorker;
    expect(m.push.pushSupport()).toBe('browser');
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    expect(m.push.pushSupport()).toBe('unsupported');
    expect(m.push.permission()).toBe('denied');
  });

  it('pushServerState: the server’s copy for this endpoint; no subscription → all off; no permission → null', async () => {
    installPush();
    await load();
    const net = mockFetch();
    net.on('POST', '/api/push/status', (req) => ({ subscribed: true, ready: true, seasons: false, echo: req.body.endpoint }));
    expect(await m.push.pushServerState()).toEqual({ subscribed: true, ready: true, seasons: false, echo: 'https://push.test/ep-1' });
    env.sub = null;
    expect(await m.push.pushServerState()).toEqual({ subscribed: false, ready: false, seasons: false });
    env.perm = 'default';
    expect(await m.push.pushServerState()).toBe(null);
    expect(m.push.pushPrefs()).toEqual({ ready: true, seasons: false });
  });

  it('sendTestPush: posts the endpoint; unsubscribed → "Not subscribed"', async () => {
    installPush();
    await load();
    const net = mockFetch();
    net.on('POST', '/api/push/test', { sent: 1 });
    expect(await m.push.sendTestPush()).toEqual({ sent: 1 });
    expect(net.callsTo('/api/push/test')[0].body).toEqual({ endpoint: 'https://push.test/ep-1' });
    env.sub = null;
    await expect(m.push.sendTestPush()).rejects.toThrow('Not subscribed');
  });

  it('corrupted prefs read as all off', async () => {
    installPush();
    await load({ storage: { 'reel.push': '{nope' } });
    expect(m.push.pushPrefs()).toEqual({ ready: false, seasons: false });
  });
});

/* ------------------------------------------------------ notification taps ---- */

const tap = (open) => env.container.dispatchEvent(new MessageEvent('message', { data: { type: 'vr-open', open } }));
const names = () => m.router.stack().map((r) => r.name);

describe('notification taps (initPushLinks → route)', () => {
  beforeEach(() => installPush());

  it('a tap while the app runs: an item opens its detail page, the bell opens the sheet, home switches tab', async () => {
    await load();
    m.router.markBooted();
    m.push.initPushLinks();
    tap({ type: 'item', id: ITEM, itemType: 'Episode' });
    expect(names()).toEqual(['home', 'detail']);
    expect(m.router.top().params).toEqual({ id: ITEM, type: 'Episode' });
    tap({ type: 'item', id: 'x2' }); // no itemType → Movie
    expect(m.router.top().params).toEqual({ id: 'x2', type: 'Movie' });
    tap({ type: 'bell' });
    expect(m.router.R.sheet?.name).toBe('notifications');
    m.router.closeSheet();
    m.router.switchTab('movies');
    tap({ type: 'home' });
    expect(m.router.R.tab).toBe('home');
  });

  it('never leaves the player for a tapped notification: a toast instead, the player stays up', async () => {
    await load();
    m.router.markBooted();
    m.push.initPushLinks();
    m.nav.S.screen = 'player';
    expect(m.router.R.modal).toBe('player');
    tap({ type: 'item', id: ITEM, itemType: 'Movie' });
    tap({ type: 'bell' });
    expect(m.router.R.modal).toBe('player');
    expect(m.nav.S.screen).toBe('player');
    expect(names()).toEqual(['home']);
    expect(m.router.R.sheet).toBe(null);
    expect(m.toast.toastState).toMatchObject({ show: true, msg: 'Opens when you close the player' });
  });

  /* R3-PS-1 (fixed): the toast promises "Opens when you close the player", so the
   * refused tap is remembered and routed by the next close. */
  it('R3-PS-1: the item tapped during playback opens once the player closes, as the toast says', async () => {
    await load();
    m.router.markBooted();
    m.push.initPushLinks();
    m.nav.S.screen = 'player';
    tap({ type: 'item', id: ITEM, itemType: 'Movie' });
    m.router.closePlayer();
    await new Promise((r) => setTimeout(r, 0));
    expect(names()).toEqual(['home', 'detail']);
  });

  it('R3-PS-1: the latest refused tap wins, it opens once, and over the page the engine’s exit returned to', async () => {
    await load();
    m.router.markBooted();
    m.push.initPushLinks();
    m.nav.S.screen = 'player';
    tap({ type: 'bell' });
    tap({ type: 'item', id: ITEM, itemType: 'Episode' });
    // the engine's exit: close, then (same task) the page it returns to
    m.nav.openItem('feedfeedfeedfeedfeedfeedfeedfeed', 'Movie');
    expect(names()).toEqual(['home', 'detail']);
    await new Promise((r) => setTimeout(r, 0));
    expect(names()).toEqual(['home', 'detail', 'detail']);
    expect(m.router.top().params).toEqual({ id: ITEM, type: 'Episode' });
    expect(m.router.R.sheet).toBe(null); // the bell tap was superseded
    // the next playback's close opens nothing more
    m.nav.S.screen = 'player';
    m.router.closePlayer();
    await new Promise((r) => setTimeout(r, 0));
    expect(names()).toEqual(['home', 'detail', 'detail']);
  });

  it('R3-PS-1: a sign-out or an account switch drops the remembered tap', async () => {
    await load();
    m.router.markBooted();
    m.push.initPushLinks();
    m.nav.S.screen = 'player';
    tap({ type: 'item', id: ITEM, itemType: 'Movie' });
    const net = mockFetch();
    net.on('POST', '/api/push/unsubscribe', null);
    await m.push.pushSignOut();
    expect(net.callsTo('/api/push/unsubscribe', 'POST')).toHaveLength(1);
    m.router.closePlayer();
    await new Promise((r) => setTimeout(r, 0));
    expect(names()).toEqual(['home']);

    m.nav.S.screen = 'player';
    tap({ type: 'item', id: ITEM, itemType: 'Movie' });
    m.config.cfg.userId = 'someone-else';
    m.router.closePlayer();
    await new Promise((r) => setTimeout(r, 0));
    expect(names()).toEqual(['home']);
  });

  it('cold start: waits for boot (polled every 200 ms) and then routes', async () => {
    await load();
    const clock = useClock();
    m.push.initPushLinks();
    tap({ type: 'item', id: ITEM, itemType: 'Movie' });
    await clock.tick(3000);
    expect(names()).toEqual(['home']);
    m.router.markBooted();
    await clock.tick(199);
    expect(names()).toEqual(['home']);
    await clock.tick(1);
    expect(names()).toEqual(['home', 'detail']);
    expect(clock.pending()).toBe(0); // the poll stopped
  });

  it('cold start: gives up after 15 s — a session that boots later is not yanked to the item', async () => {
    await load();
    const clock = useClock();
    m.push.initPushLinks();
    tap({ type: 'item', id: ITEM, itemType: 'Movie' });
    await clock.tick(15200);
    expect(clock.pending()).toBe(0);
    m.router.markBooted();
    await clock.tick(5000);
    expect(names()).toEqual(['home']);
  });

  it('cold start: boot at 14.8 s still routes', async () => {
    await load();
    const clock = useClock();
    m.push.initPushLinks();
    tap({ type: 'bell' });
    await clock.tick(14800);
    m.router.markBooted();
    await clock.tick(200);
    expect(m.router.R.sheet?.name).toBe('notifications');
  });

  it('cold start into the player (a restored session): still refuses once booted', async () => {
    await load();
    const clock = useClock();
    m.push.initPushLinks();
    tap({ type: 'item', id: ITEM, itemType: 'Movie' });
    m.nav.S.screen = 'player';
    m.router.markBooted();
    await clock.tick(200);
    expect(m.router.R.modal).toBe('player');
    expect(names()).toEqual(['home']);
  });

  it('/?open=Type:Id on a cold start: routed and stripped from the URL (other params and the hash kept)', async () => {
    history.replaceState(null, '', '/?x=1&open=Episode:' + ITEM + '#h');
    await load();
    m.router.markBooted();
    m.push.initPushLinks();
    expect(location.search).toBe('?x=1');
    expect(location.hash).toBe('#h');
    expect(m.router.top().params).toEqual({ id: ITEM, type: 'Episode' });
  });

  it('/?open=bell and /?open=home; a malformed id or junk message is ignored', async () => {
    history.replaceState(null, '', '/?open=bell');
    await load();
    m.router.markBooted();
    m.push.initPushLinks();
    expect(location.search).toBe('');
    expect(m.router.R.sheet?.name).toBe('notifications');
    m.router.closeSheet();

    m.router.switchTab('shows');
    history.replaceState(null, '', '/?open=home');
    m.push.initPushLinks();
    expect(m.router.R.tab).toBe('home');

    history.replaceState(null, '', '/?open=Movie:../../etc');
    m.push.initPushLinks();
    tap(null);
    tap('item');
    env.container.dispatchEvent(new MessageEvent('message', { data: { type: 'other', open: { type: 'bell' } } }));
    expect(names()).toEqual(['home']);
    expect(m.router.R.sheet).toBe(null);
  });

  it('no service worker: initPushLinks does nothing', async () => {
    delete navigator.serviceWorker;
    history.replaceState(null, '', '/?open=bell');
    await load();
    m.router.markBooted();
    m.push.initPushLinks();
    expect(location.search).toBe('?open=bell');
  });
});

/* ------------------------------------------- reel-api's request guard ---- */

/* Every request to reel-api's /api/push… carries the signed-in user's Jellyfin
 * token (reel-api's guard, backend security.py), and a device with nobody signed
 * in still takes its subscription off the server through the one open push route
 * (POST /api/push/unsubscribe) — without one. (main's push.test.js, kept whole
 * when r3-phone-sync's tests landed; its own minimal browser stand-in.) */
describe("reel-api's request guard: the Jellyfin token on /api/push", () => {
  const AUTH = 'MediaBrowser Token="' + TEST_TOKEN + '"';
  const GKEY = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');
  const ENDPOINT = 'https://push.example/sub/1';
  let push, net, swDesc;

  function installGuardPush() {
    const sub = {
      endpoint: ENDPOINT,
      options: { applicationServerKey: new Uint8Array(65).fill(4).buffer },
      toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: vi.fn(async () => true)
    };
    const reg = { pushManager: { getSubscription: vi.fn(async () => sub), subscribe: vi.fn(async () => sub) } };
    swDesc = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve(reg), addEventListener() {} }
    });
    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn(async () => 'granted') });
  }

  async function loadGuard(storage = {}) {
    ({ push } = await freshImport({ storage: { 'reel.push': JSON.stringify({ ready: true, seasons: false }), ...storage }, modules: { push: 'phone/src/lib/push.js' } }));
    net = mockFetch();
    net.on('GET', PUSH + '/config', { enabled: true, key: GKEY });
    net.on('POST', PUSH + '/subscribe', { ok: true, user: 'Tester' });
    net.on('POST', PUSH + '/status', { subscribed: true, ready: true, seasons: false });
    net.on('POST', PUSH + '/test', { ok: true });
    net.on('POST', PUSH + '/unsubscribe', { ok: true });
  }

  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };

  beforeEach(() => installGuardPush());

  afterEach(() => {
    if (swDesc) Object.defineProperty(navigator, 'serviceWorker', swDesc);
    else delete navigator.serviceWorker;
  });

  describe('signed in: the token on every /api/push request', () => {
    beforeEach(() => loadGuard());

    it('turning a kind on: GET /config and POST /subscribe carry it (the body keeps its own copy for push.py)', async () => {
      await push.setPush('seasons', true);
      expect(net.calls.map((c) => c.method + ' ' + c.url)).toEqual(['GET ' + PUSH + '/config', 'POST ' + PUSH + '/subscribe']);
      expect(net.calls[0].headers).toEqual({ Authorization: AUTH });
      expect(net.calls[1].headers).toEqual({ 'Content-Type': 'application/json', Authorization: AUTH });
      expect(net.calls[1].body).toMatchObject({ token: TEST_TOKEN, ready: true, seasons: true });
    });

    it('status, test push, turning everything off, sign-out: each carries it', async () => {
      await push.pushServerState();
      await push.sendTestPush();
      await push.setPush('ready', false);
      await push.pushSignOut();
      expect(net.calls.map((c) => c.url.slice(PUSH.length))).toEqual(['/status', '/test', '/unsubscribe', '/unsubscribe']);
      expect(net.calls.every((c) => c.headers.Authorization === AUTH && c.headers['Content-Type'] === 'application/json')).toBe(true);
      expect(net.calls[3].keepalive).toBe(true);
    });

    it('syncPush on start re-registers with the token', async () => {
      push.syncPush();
      await flush();
      expect(net.calls.map((c) => c.url.slice(PUSH.length))).toEqual(['/config', '/subscribe']);
      expect(net.calls.every((c) => c.headers.Authorization === AUTH)).toBe(true);
    });
  });

  describe('signed out', () => {
    beforeEach(() => loadGuard({ 'reel.token': '' }));

    it('syncPush takes the device off the server with no Authorization header (the open route)', async () => {
      push.syncPush();
      await flush();
      expect(net.calls.map((c) => c.method + ' ' + c.url)).toEqual(['POST ' + PUSH + '/unsubscribe']);
      expect(net.calls[0].headers).toEqual({ 'Content-Type': 'application/json' });
      expect(net.calls[0].body).toEqual({ endpoint: ENDPOINT });
    });
  });
});
