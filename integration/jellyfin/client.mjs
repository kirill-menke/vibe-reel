/* The apps' own src/lib modules, loaded into Node through Vite's SSR module
 * loader — the same plugins and `__PHONE__` define as the real builds (taken
 * from vite.config.js / phone/vite.config.js by name, as vitest.config.js
 * does), so api(), qs(), GRID_FIELDS, deviceProfile(), setPlayed(),
 * findMarkers() … are the shipped code, not copies.
 *
 *   const tv = await loadClient('tv', { server, token, userId, deviceId })
 *   tv.api / tv.tracks / tv.played / tv.segments / tv.account / tv.cfg
 *   await tv.close()
 *
 * The modules read localStorage at import (config.js) and the phone's
 * deviceProfile() probes `document.createElement('video').canPlayType`; both
 * are stubbed here with plain objects — Node's global fetch does the HTTP.
 * The phone stub answers like iOS 17 Safari on an A16 iPhone: HEVC yes,
 * Dolby Vision profile 5 and AV1 no (docs/ios/MEDIA-TEST.md). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..', '..');

function plugin(config, name) {
  const p = (config.plugins || []).flat().find((x) => x && x.name === name);
  if (!p) throw new Error(`client.mjs: plugin "${name}" not in the build config`);
  return p;
}

const IOS_CAN_PLAY = (t) => (/hvc1/.test(t) ? 'probably' : '');

export async function loadClient(flavour, { server, token = '', userId = '', userName = '', deviceId }) {
  const { createServer } = await import('vite');
  const { svelte } = await import('@sveltejs/vite-plugin-svelte');
  const mem = new Map(Object.entries({ 'reel.server': server, 'reel.token': token, 'reel.userId': userId, 'reel.userName': userName, 'reel.deviceId': deviceId }).filter(([, v]) => v));
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), clear: () => mem.clear(), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
  globalThis.localStorage = storage;
  // the phone's config.js defaults its URLs from location.origin (/jf, /ml); reel.server above wins
  if (!globalThis.location) globalThis.location = new URL(server);
  let config, plugins, alias;
  if (flavour === 'tv') {
    config = (await import(path.join(REPO, 'vite.config.js'))).default;
    plugins = [svelte({ configFile: false }), plugin(config, 'lazy-libpgs')];
  } else {
    config = (await import(path.join(REPO, 'phone/vite.config.js'))).default;
    plugins = [plugin(config, 'phone-module-redirects'), svelte({ configFile: false }), plugin(config, 'lazy-libpgs')];
    alias = { ...(config.resolve?.alias || {}) };
  }
  const vite = await createServer({
    root: REPO,
    configFile: false,
    envDir: path.join(REPO, 'test/env'), // never .env.local: no private address reaches import.meta.env
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins,
    define: { ...config.define },
    resolve: { conditions: ['browser'], ...(alias ? { alias } : {}) }
  });
  const load = (p) => vite.ssrLoadModule(p);
  const mods = {
    flavour,
    storage,
    cfg: (await load('/src/lib/config.js')).cfg,
    api: await load('/src/lib/api.js'),
    tracks: await load('/src/lib/tracks.js'),
    played: await load('/src/lib/played.js'),
    segments: await load('/src/lib/segments.js'),
    account: await load('/src/lib/account.svelte.js').catch((e) => ({ loadError: e.message })),
    /* deviceProfile(burn, maxBitrate) with the phone's canPlayType probe answered like iOS */
    deviceProfile(burn, maxBitrate) {
      if (flavour !== 'phone') return mods.tracks.deviceProfile(burn, maxBitrate);
      const had = Object.prototype.hasOwnProperty.call(globalThis, 'document');
      const prev = globalThis.document;
      globalThis.document = { createElement: () => ({ canPlayType: IOS_CAN_PLAY }) };
      try {
        return mods.tracks.deviceProfile(burn, maxBitrate);
      } finally {
        if (had) globalThis.document = prev;
        else delete globalThis.document;
      }
    },
    close: () => vite.close()
  };
  return mods;
}
