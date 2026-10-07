/* config.js + settings.svelte.js: the persisted client config and viewer settings.
 *
 * CLAUDE.md (App lifecycle): "localStorage is read through guarded helpers
 * everywhere (config.js, accounts, trackPrefs, news-seen): a throwing or
 * corrupted store falls back to defaults instead of killing the bundle at module
 * init." And (Commands): without a configured reel-api, `cfg.medialib` falls back
 * to the Jellyfin host on :8790. The phone is served from one origin: Jellyfin at
 * origin + '/jf', reel-api at origin + '/ml'.
 *
 * Both modules read storage at import, so every test imports a fresh graph. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { freshImport, accountStorage, TEST_SERVER, TEST_MEDIALIB, TEST_USER, TEST_TOKEN } from '../helpers/modules.js';
import { readJSON, seedStorage, stubStorage, storageKeys } from '../helpers/storage.js';

const PHONE = __PHONE__;

async function loadCfg(opts = {}) {
  const m = await freshImport({ ...opts, modules: { config: 'src/lib/config.js' } });
  return m.config;
}

async function loadSettings(opts = {}) {
  const m = await freshImport({ signedIn: false, ...opts, modules: { settings: 'src/lib/settings.svelte.js' } });
  return m.settings;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('config.js: values from storage', () => {
  it('reads the five keys and the deviceId back', async () => {
    const { cfg } = await loadCfg();
    expect(cfg.server).toBe(TEST_SERVER);
    expect(cfg.token).toBe(TEST_TOKEN);
    expect(cfg.userId).toBe(TEST_USER);
    expect(cfg.userName).toBe('Tester');
    expect(cfg.deviceId).toBe('dev-test');
    expect(cfg.medialib).toBe(TEST_MEDIALIB);
  });

  it('does not regenerate a stored deviceId', async () => {
    await loadCfg();
    expect(localStorage.getItem('reel.deviceId')).toBe('dev-test');
  });
});

describe('config.js: defaults when nothing is stored', () => {
  it(PHONE ? 'phone: Jellyfin at origin + /jf, reel-api at origin + /ml' : 'TV: no server (login asks), no reel-api', async () => {
    const { cfg } = await loadCfg({ signedIn: false });
    if (PHONE) {
      expect(cfg.server).toBe(location.origin + '/jf');
      expect(cfg.medialib).toBe(location.origin + '/ml');
    } else {
      expect(cfg.server).toBe('');
      expect(cfg.medialib).toBe('');
    }
    expect(cfg.token).toBe('');
    expect(cfg.userId).toBe('');
    expect(cfg.userName).toBe('');
  });

  it('build env (VITE_JELLYFIN_URL / VITE_MEDIALIB_URL) is the TV default; the phone ignores it', async () => {
    vi.stubEnv('VITE_JELLYFIN_URL', 'http://env-jf.test:8096');
    vi.stubEnv('VITE_MEDIALIB_URL', 'http://env-ml.test:8790');
    const { cfg } = await loadCfg({ signedIn: false });
    if (PHONE) {
      expect(cfg.server).toBe(location.origin + '/jf');
      expect(cfg.medialib).toBe(location.origin + '/ml');
    } else {
      expect(cfg.server).toBe('http://env-jf.test:8096');
      expect(cfg.medialib).toBe('http://env-ml.test:8790');
    }
  });

  it('stored values win over the build env', async () => {
    vi.stubEnv('VITE_JELLYFIN_URL', 'http://env-jf.test:8096');
    vi.stubEnv('VITE_MEDIALIB_URL', 'http://env-ml.test:8790');
    const { cfg } = await loadCfg();
    expect(cfg.server).toBe(TEST_SERVER);
    expect(cfg.medialib).toBe(TEST_MEDIALIB);
  });

  it('generates a deviceId once and persists it', async () => {
    const { cfg } = await loadCfg({ signedIn: false });
    expect(cfg.deviceId).toMatch(PHONE ? /^reelphone-[a-z0-9]+$/ : /^reel-[a-z0-9]+$/);
    expect(localStorage.getItem('reel.deviceId')).toBe(cfg.deviceId);
    // a second boot keeps it: re-import without clearing the store
    vi.resetModules();
    const again = await import('../../src/lib/config.js');
    expect(again.cfg.deviceId).toBe(cfg.deviceId);
  });

  it('two fresh devices get different ids', async () => {
    const a = (await loadCfg({ signedIn: false })).cfg.deviceId;
    const b = (await loadCfg({ signedIn: false })).cfg.deviceId;
    expect(a).not.toBe(b);
  });
});

describe('config.js: medialib follows the Jellyfin host on :8790 unless set', () => {
  // on the phone an unset reel.medialib defaults to origin + /ml, so the fallback is TV-only
  const storage = { ...accountStorage(), 'reel.medialib': '' };
  if (!PHONE) {
    it('derives protocol + hostname + :8790 from cfg.server (port and path dropped)', async () => {
      const { cfg } = await loadCfg({ storage: { ...storage, 'reel.server': 'https://media.example:8920/jellyfin' } });
      expect(cfg.medialib).toBe('https://media.example:8790');
    });

    it('follows a later server change (getter, not a snapshot)', async () => {
      const { cfg } = await loadCfg({ storage });
      expect(cfg.medialib).toBe('http://jf.test:8790');
      cfg.server = 'http://other.test:8096';
      expect(cfg.medialib).toBe('http://other.test:8790');
    });

    it('an unparseable server gives no reel-api rather than throwing', async () => {
      const { cfg } = await loadCfg({ storage: { ...storage, 'reel.server': 'not a url' } });
      expect(cfg.medialib).toBe('');
    });
  }

  it('an explicit medialib is used as is and survives a server change', async () => {
    const { cfg } = await loadCfg({ storage: { ...accountStorage(), 'reel.medialib': 'http://ml.example:9000' } });
    cfg.server = 'http://other.test:8096';
    expect(cfg.medialib).toBe('http://ml.example:9000');
  });

  it('the setter overrides the fallback; clearing it brings the fallback back', async () => {
    const { cfg } = await loadCfg({ storage });
    cfg.medialib = 'http://set.test:1';
    expect(cfg.medialib).toBe('http://set.test:1');
    cfg.medialib = '';
    expect(cfg.medialib).toBe('http://jf.test:8790');
  });
});

describe('config.js: saveCfg', () => {
  it('writes server, token, userId, userName and medialib', async () => {
    const { cfg, saveCfg } = await loadCfg({ signedIn: false });
    cfg.server = 'http://s.test';
    cfg.token = 't2';
    cfg.userId = 'u2';
    cfg.userName = 'Two';
    cfg.medialib = 'http://m.test';
    saveCfg();
    expect(localStorage.getItem('reel.server')).toBe('http://s.test');
    expect(localStorage.getItem('reel.token')).toBe('t2');
    expect(localStorage.getItem('reel.userId')).toBe('u2');
    expect(localStorage.getItem('reel.userName')).toBe('Two');
    expect(localStorage.getItem('reel.medialib')).toBe('http://m.test');
  });

  it('writes medialib only when one is set (never the derived fallback)', async () => {
    if (PHONE) {
      // the phone always has origin + /ml unless storage says otherwise; clear it through the setter
      const { cfg, saveCfg } = await loadCfg({ signedIn: false });
      cfg.medialib = '';
      cfg.server = 'http://s.test';
      saveCfg();
      expect(localStorage.getItem('reel.medialib')).toBe(null);
    } else {
      const { cfg, saveCfg } = await loadCfg({ signedIn: false });
      cfg.server = 'http://s.test';
      expect(cfg.medialib).toBe('http://s.test:8790');
      saveCfg();
      expect(localStorage.getItem('reel.medialib')).toBe(null);
    }
    expect(storageKeys()).toEqual(['reel.deviceId', 'reel.server', 'reel.token', 'reel.userId', 'reel.userName']);
  });

  it('signing out (empty token) is persisted as an empty token', async () => {
    const { cfg, saveCfg } = await loadCfg();
    cfg.token = '';
    saveCfg();
    expect(localStorage.getItem('reel.token')).toBe('');
  });
});

describe('config.js: a broken store boots with defaults', () => {
  it('a throwing getItem and setItem at import does not throw; cfg has defaults', async () => {
    stubStorage({ throwOn: ['getItem', 'setItem'] });
    const { cfg, saveCfg } = await loadCfg({ signedIn: false });
    expect(cfg.token).toBe('');
    expect(cfg.userId).toBe('');
    expect(cfg.server).toBe(PHONE ? location.origin + '/jf' : '');
    // the generated deviceId lives in memory for the session
    expect(cfg.deviceId).toMatch(/^reel/);
    // a write failure keeps the in-memory config (a sign-in still works this session)
    cfg.token = 'tok';
    expect(() => saveCfg()).not.toThrow();
    expect(cfg.token).toBe('tok');
  });

  it('a store that reads fine but refuses writes still loads stored values', async () => {
    const ls = stubStorage({ initial: accountStorage({ deviceId: '' }), throwOn: ['clear', 'setItem'] });
    const { cfg, saveCfg } = await loadCfg({ signedIn: false });
    expect(cfg.server).toBe(TEST_SERVER);
    expect(cfg.token).toBe(TEST_TOKEN);
    expect(cfg.deviceId).toMatch(/^reel/);
    expect(ls.map.get('reel.deviceId')).toBe('');
    cfg.userName = 'Changed';
    expect(() => saveCfg()).not.toThrow();
    expect(ls.map.get('reel.userName')).toBe('Tester');
  });

  it('a store whose every access throws (localStorage getter itself) does not take the module down', async () => {
    vi.stubGlobal('localStorage', undefined);
    const { cfg } = await loadCfg({ signedIn: false });
    expect(cfg.token).toBe('');
    expect(cfg.deviceId).toMatch(/^reel/);
  });
});

describe('settings.svelte.js', () => {
  it('no stored settings → DEFAULTS', async () => {
    const { SET, DEFAULTS } = await loadSettings();
    expect({ ...SET }).toEqual(DEFAULTS);
    expect(DEFAULTS).toEqual({
      audioLang: 'eng',
      subLang: 'eng',
      subMode: 'auto',
      autoplayNext: true,
      autoSkipIntro: false,
      autoSkipRecap: false,
      subSize: 100
    });
  });

  it('stored values are merged over DEFAULTS (a key added later gets its default)', async () => {
    const { SET } = await loadSettings({ storage: { 'reel.settings': { subMode: 'always', subSize: 120 } } });
    expect(SET.subMode).toBe('always');
    expect(SET.subSize).toBe(120);
    expect(SET.audioLang).toBe('eng');
    expect(SET.autoplayNext).toBe(true);
  });

  it.each([
    ['corrupted JSON', '{not json'],
    ['a JSON string', '"hello"'],
    ['a number', '42'],
    ['null', 'null']
  ])('%s in reel.settings → DEFAULTS', async (_n, raw) => {
    const { SET, DEFAULTS } = await loadSettings({ storage: { 'reel.settings': raw } });
    expect({ ...SET }).toEqual(DEFAULTS);
  });

  it('a throwing getItem at import → DEFAULTS', async () => {
    stubStorage({ throwOn: ['getItem'] });
    const { SET, DEFAULTS } = await loadSettings();
    expect({ ...SET }).toEqual(DEFAULTS);
  });

  it('DEFAULTS is not mutated through SET', async () => {
    const { SET, DEFAULTS, setSetting } = await loadSettings();
    setSetting('subMode', 'off');
    expect(SET.subMode).toBe('off');
    expect(DEFAULTS.subMode).toBe('auto');
  });

  it('setSetting writes SET and persists a plain JSON snapshot of all settings', async () => {
    const { SET, setSetting } = await loadSettings();
    setSetting('autoSkipIntro', true);
    expect(SET.autoSkipIntro).toBe(true);
    expect(readJSON('reel.settings')).toEqual({
      audioLang: 'eng',
      subLang: 'eng',
      subMode: 'auto',
      autoplayNext: true,
      autoSkipIntro: true,
      autoSkipRecap: false,
      subSize: 100
    });
    setSetting('subSize', 140);
    expect(readJSON('reel.settings').subSize).toBe(140);
    expect(readJSON('reel.settings').autoSkipIntro).toBe(true);
  });

  it('a persisted setting survives a restart', async () => {
    const { setSetting } = await loadSettings();
    setSetting('audioLang', 'jpn');
    vi.resetModules();
    const again = await import('../../src/lib/settings.svelte.js');
    expect(again.SET.audioLang).toBe('jpn');
  });

  it('setSetting ignores unknown keys (neither SET nor storage)', async () => {
    const { SET, setSetting } = await loadSettings();
    setSetting('bogus', 1);
    expect('bogus' in SET).toBe(false);
    expect(localStorage.getItem('reel.settings')).toBe(null);
  });

  it('a throwing setItem keeps the in-memory value', async () => {
    stubStorage({ throwOn: ['setItem'] });
    const { SET, setSetting } = await loadSettings();
    expect(() => setSetting('subMode', 'always')).not.toThrow();
    expect(SET.subMode).toBe('always');
  });

  it('menu tables: LANGS are ISO 639-2/B codes, SUB_MODES cover auto/always/off, size bounds', async () => {
    const s = await loadSettings();
    const codes = s.LANGS.map(([c]) => c);
    expect(codes).toContain('ger');
    expect(codes).toContain('fre');
    expect(codes).toContain('dut');
    expect(codes).toContain('chi');
    expect(codes).not.toContain('deu');
    expect(codes).not.toContain('fra');
    expect(codes[0]).toBe('eng');
    expect(new Set(codes).size).toBe(codes.length);
    expect(s.SUB_MODES.map(([m]) => m)).toEqual(['auto', 'always', 'off']);
    expect(s.LANGS.map(([c]) => c)).toContain(s.DEFAULTS.audioLang);
    expect(s.SUB_SIZE_MIN).toBe(60);
    expect(s.SUB_SIZE_MAX).toBe(160);
    expect(s.SUB_SIZE_STEP).toBe(10);
    expect((s.DEFAULTS.subSize - s.SUB_SIZE_MIN) % s.SUB_SIZE_STEP).toBe(0);
  });
});
