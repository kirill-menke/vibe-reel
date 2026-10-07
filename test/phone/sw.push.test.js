/* phone/public/sw.js — the push and notificationclick handlers.
 *
 * CLAUDE.md: "sw.js adds one [badge] per push while the app sleeps (count kept in
 * Cache Storage vr-badge), the app re-sets the truth on foreground", and a push
 * while the app is open makes it check for changes (`vr-changed`,
 * freshness.svelte.js). A tap hands `open` to a running page as a `vr-open`
 * message, or opens `/?open=Type:Id` for initPushLinks() (push.js) on a cold
 * start. iOS requires every push to show a notification (userVisibleOnly), so a
 * malformed payload still shows one.
 *
 * The worker script is evaluated as-is against a fake ServiceWorkerGlobalScope
 * (self, caches); its handlers are taken from self.addEventListener. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { freshImport } from '../helpers/modules.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'phone/public/sw.js'), 'utf8');
const ORIGIN = 'https://app.test';
const ITEM = '0123456789abcdef0123456789abcdef';

function fakeCaches() {
  const stores = new Map();
  return {
    stores,
    fail: false,
    open: vi.fn(async function (name) {
      if (this.fail) throw new Error('cache storage unavailable');
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        match: async (k) => m.get(k)?.clone(),
        put: async (k, r) => void m.set(k, r)
      };
    }),
    keys: async () => [...stores.keys()]
  };
}

function client(url, log) {
  return {
    url,
    postMessage: vi.fn((msg) => log.push(['post', url, msg])),
    focus: vi.fn(async () => log.push(['focus', url]))
  };
}

/* Evaluates sw.js; returns its handlers and the fakes it talks to. */
function loadSW({ badge = true, clients = [] } = {}) {
  const handlers = {};
  const log = [];
  const caches = fakeCaches();
  const self = {
    location: new URL(ORIGIN + '/sw.js'),
    addEventListener: (type, fn) => (handlers[type] = fn),
    registration: { showNotification: vi.fn(async (title, opts) => log.push(['show', title, opts])) },
    clients: {
      list: clients,
      matchAll: vi.fn(async () => self.clients.list),
      openWindow: vi.fn(async (u) => log.push(['open', u])),
      claim: vi.fn()
    },
    navigator: badge ? { setAppBadge: vi.fn(async (n) => log.push(['badge', n])) } : {},
    skipWaiting: vi.fn()
  };
  new Function('self', 'caches', 'Response', 'URL', SRC)(self, caches, Response, URL);
  return { handlers, self, caches, log };
}

async function fire(handler, ev) {
  const waits = [];
  handler({ ...ev, waitUntil: (p) => waits.push(p) });
  expect(waits).toHaveLength(1); // the worker stays alive until the work is done
  await waits[0];
}

const pushEv = (payload) => ({
  data:
    payload === undefined
      ? null
      : {
          json: () => JSON.parse(payload),
          text: () => payload
        }
});
const badgeCount = async (sw) => {
  const r = sw.caches.stores.get('vr-badge')?.get('/__badge');
  return r ? (await r.clone().text()) : null;
};

describe('sw.js push', () => {
  it('shows the payload’s notification, with `open` as the tap target', async () => {
    const sw = loadSW();
    const open = { type: 'item', id: ITEM, itemType: 'Episode' };
    await fire(sw.handlers.push, pushEv(JSON.stringify({ title: 'Ready to watch', body: 'Silo · S2E1', tag: 't1', open })));
    expect(sw.self.registration.showNotification).toHaveBeenCalledWith('Ready to watch', {
      body: 'Silo · S2E1',
      tag: 't1',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { open }
    });
  });

  it('a malformed payload still shows a notification (iOS revokes push otherwise): its text as the body, a tap opens Home', async () => {
    const sw = loadSW();
    await fire(sw.handlers.push, pushEv('not json'));
    expect(sw.self.registration.showNotification).toHaveBeenCalledWith('VibeReel', expect.objectContaining({ body: 'not json', tag: undefined, data: { open: { type: 'home' } } }));
    const sw2 = loadSW();
    await fire(sw2.handlers.push, pushEv(undefined));
    expect(sw2.self.registration.showNotification).toHaveBeenCalledWith('VibeReel', expect.objectContaining({ body: '', data: { open: { type: 'home' } } }));
  });

  it('the icon badge counts up from Cache Storage (vr-badge), one per push', async () => {
    const sw = loadSW();
    await fire(sw.handlers.push, pushEv('{}'));
    expect(await badgeCount(sw)).toBe('1');
    await fire(sw.handlers.push, pushEv('{}'));
    await fire(sw.handlers.push, pushEv('{}'));
    expect(await badgeCount(sw)).toBe('3');
    expect(sw.self.navigator.setAppBadge.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  it('continues from the count the page stored (badge.svelte.js); a garbage count restarts at 1', async () => {
    const sw = loadSW();
    const c = await sw.caches.open('vr-badge');
    await c.put('/__badge', new Response('4'));
    await fire(sw.handlers.push, pushEv('{}'));
    expect(await badgeCount(sw)).toBe('5');
    await c.put('/__badge', new Response('x'));
    await fire(sw.handlers.push, pushEv('{}'));
    expect(await badgeCount(sw)).toBe('1');
  });

  it('then tells every open window `vr-changed` — after the badge was bumped', async () => {
    const log = [];
    const sw = loadSW({ clients: [client(ORIGIN + '/', log), client(ORIGIN + '/movies', log)] });
    // the worker's own log and the clients' share one timeline
    sw.self.navigator.setAppBadge.mockImplementation(async (n) => log.push(['badge', n]));
    await fire(sw.handlers.push, pushEv('{}'));
    expect(log).toEqual([
      ['badge', 1],
      ['post', ORIGIN + '/', { type: 'vr-changed' }],
      ['post', ORIGIN + '/movies', { type: 'vr-changed' }]
    ]);
  });

  it('no Badging API: no cache work, the windows still hear vr-changed', async () => {
    const log = [];
    const sw = loadSW({ badge: false, clients: [client(ORIGIN + '/', log)] });
    await fire(sw.handlers.push, pushEv('{}'));
    expect(sw.caches.open).not.toHaveBeenCalled();
    expect(log).toEqual([['post', ORIGIN + '/', { type: 'vr-changed' }]]);
  });

  it('a failing badge never loses the notification or the vr-changed', async () => {
    const log = [];
    const sw = loadSW({ clients: [client(ORIGIN + '/', log)] });
    sw.caches.fail = true;
    await fire(sw.handlers.push, pushEv('{"title":"x"}'));
    expect(sw.self.registration.showNotification).toHaveBeenCalledTimes(1);
    expect(log).toEqual([['post', ORIGIN + '/', { type: 'vr-changed' }]]);
  });
});

describe('sw.js notificationclick', () => {
  const clickEv = (data) => ({ notification: { data, close: vi.fn() } });

  it('a running window gets `vr-open` with the target and is focused; no new window', async () => {
    const log = [];
    const sw = loadSW({ clients: [client('https://elsewhere.test/', log), client(ORIGIN + '/shows', log)] });
    const open = { type: 'item', id: ITEM, itemType: 'Movie' };
    const ev = clickEv({ open });
    await fire(sw.handlers.notificationclick, ev);
    expect(ev.notification.close).toHaveBeenCalled();
    expect(log).toEqual([
      ['post', ORIGIN + '/shows', { type: 'vr-open', open }],
      ['focus', ORIGIN + '/shows']
    ]);
    expect(sw.self.clients.openWindow).not.toHaveBeenCalled();
    expect(sw.self.clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
  });

  it('no window of this origin: opens /?open=Type:Id (bell, home; a missing itemType is Movie)', async () => {
    const cases = [
      [{ open: { type: 'item', id: ITEM, itemType: 'Episode' } }, '/?open=' + encodeURIComponent('Episode:' + ITEM)],
      [{ open: { type: 'item', id: ITEM } }, '/?open=' + encodeURIComponent('Movie:' + ITEM)],
      [{ open: { type: 'item' } }, '/?open=home'],
      [{ open: { type: 'bell' } }, '/?open=bell'],
      [null, '/?open=home']
    ];
    for (const [data, url] of cases) {
      const sw = loadSW({ clients: [client('https://elsewhere.test/', [])] });
      await fire(sw.handlers.notificationclick, clickEv(data));
      expect(sw.self.clients.openWindow).toHaveBeenCalledWith(url);
    }
  });

  it('round trip: the cold-start URL it opens is what initPushLinks() routes', async () => {
    const sw = loadSW();
    await fire(sw.handlers.notificationclick, clickEv({ open: { type: 'item', id: ITEM, itemType: 'Episode' } }));
    const url = sw.self.clients.openWindow.mock.calls[0][0];
    const container = new EventTarget();
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
    history.replaceState(null, '', url);
    const m = await freshImport({ modules: { push: 'phone/src/lib/push.js', router: 'phone/src/lib/router.svelte.js' } });
    m.router.markBooted();
    m.push.initPushLinks();
    expect(m.router.top().name).toBe('detail');
    expect(m.router.top().params).toEqual({ id: ITEM, type: 'Episode' });
    expect(location.search).toBe('');
  });
});

afterEach(() => {
  delete navigator.serviceWorker;
  history.replaceState(null, '', '/');
});
