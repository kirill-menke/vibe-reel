/* The web build's identity towards Jellyfin (api.js, config.js): `__WEB__`
 * branches inside the phone ones. Jellyfin lists this client as "VibeReel Web"
 * on "Web" (Dashboard → Devices / Activity), and a new DeviceId starts
 * `reelweb-`, so a browser never shares a device row with the iPhone app. The
 * shared suites pin the TV's and the phone's values. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { api, onAuthLost } from '../../src/lib/api.js';
import { cfg } from '../../src/lib/config.js';
import { mockFetch } from '../helpers/fetch.js';
import { freshImport, TEST_SERVER, TEST_TOKEN } from '../helpers/modules.js';

beforeEach(() => {
  cfg.server = TEST_SERVER;
  cfg.token = TEST_TOKEN;
  onAuthLost(null);
});

describe('web identity', () => {
  it('sends Client="VibeReel Web", Device="Web" in the MediaBrowser header', async () => {
    const net = mockFetch();
    net.on('GET', '/System/Info', { Version: '12.1.0' });
    await api('/System/Info');
    expect(net.calls[0].headers.Authorization).toMatch(/^MediaBrowser Client="VibeReel Web", Device="Web", DeviceId="[^"]+", Version="[^"]+", Token="tok-u1"$/);
  });

  it('generates a reelweb- deviceId once and persists it', async () => {
    const { config } = await freshImport({ signedIn: false, modules: { config: 'src/lib/config.js' } });
    expect(config.cfg.deviceId).toMatch(/^reelweb-[a-z0-9]+$/);
    expect(localStorage.getItem('reel.deviceId')).toBe(config.cfg.deviceId);
    vi.resetModules();
    const again = await import('../../src/lib/config.js');
    expect(again.cfg.deviceId).toBe(config.cfg.deviceId);
  });
});
