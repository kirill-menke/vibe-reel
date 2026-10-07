/* The phone's lifecycle.js (phone/vite.config.js redirects src/lib/lifecycle.js
 * to phone/src/lib/lifecycle.js), driven against the real playback engine.
 *
 * CLAUDE.md: "No Picture in Picture in the home-screen app … So backgrounding
 * pauses (phone lifecycle.js, 700 ms late so a PiP/AirPlay switch counts as
 * still watching): the onpause Progress saves the spot, the player stays up;
 * only pagehide Stops." And offline copies: "the position is checkpointed into
 * the index on every pause and on backgrounding (checkpointFeed())".
 *
 * initLifecycle() adds document/window listeners; they are collected and
 * removed after each test so a later test's events never reach an old graph. */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, source, video as vstream, audio } from '../helpers/media.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
let added = [];
let hidden = false;

async function withLifecycle(opts) {
  const h = await startPlayer(opts);
  document.body.append(h.video);
  const life = await import(/* @vite-ignore */ path.resolve(ROOT, 'src/lib/lifecycle.js'));
  const spies = [document, window].map((target) => {
    const orig = target.addEventListener.bind(target);
    return vi.spyOn(target, 'addEventListener').mockImplementation((type, fn, o) => {
      added.push([target, type, fn, o]);
      return orig(type, fn, o);
    });
  });
  life.initLifecycle();
  for (const s of spies) s.mockRestore();
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  return { ...h, life };
}

function goHidden() {
  hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
}
function goVisible() {
  hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  for (const [t, type, fn, o] of added) t.removeEventListener(type, fn, o);
  added = [];
  hidden = false;
  delete document.hidden;
  delete document.visibilityState;
  delete document.pictureInPictureElement;
  document.body.innerHTML = '';
});

const progress = (h) => h.net.callsTo('/Sessions/Playing/Progress', 'POST');
const stopped = (h) => h.net.callsTo('/Sessions/Playing/Stopped', 'POST');

describe('phone lifecycle: backgrounding pauses, only pagehide Stops', () => {
  beforeAll(warmPlayer, 120000);

  it('runs the phone module (the redirect)', async () => {
    const h = await withLifecycle();
    expect(__PHONE__).toBe(true);
    expect(added.some(([t, type]) => t === window && type === 'pagehide')).toBe(true);
    expect(added.some(([t, type]) => t === document && type === 'visibilitychange')).toBe(true);
    expect(h.life.initLifecycle).toBeTypeOf('function');
  });

  it('hidden mid-video: paused 700 ms later (not before), with a paused Progress report; the player stays up', async () => {
    const h = await withLifecycle();
    h.video.advance(300);
    goHidden();
    await h.clock.tick(699);
    expect(h.video.paused).toBe(false);
    await h.clock.tick(1);
    expect(h.video.paused).toBe(true);
    await h.settle();
    expect(progress(h).at(-1).body).toMatchObject({ IsPaused: true });
    expect(h.S.screen).toBe('player');
    expect(stopped(h)).toHaveLength(0);
  });

  it('back within 700 ms (a PiP / AirPlay switch, an app-switcher glance): no pause', async () => {
    const h = await withLifecycle();
    goHidden();
    await h.clock.tick(400);
    goVisible();
    await h.clock.tick(1000);
    expect(h.video.paused).toBe(false);
  });

  it('coming back shows the controls over the paused video', async () => {
    const h = await withLifecycle();
    goHidden();
    await h.clock.tick(700);
    h.P.osdShown = false;
    goVisible();
    expect(h.P.osdShown).toBe(true);
  });

  it('Picture in Picture keeps playing — at the hide, or when WebKit switches mode only after it', async () => {
    const h = await withLifecycle();
    Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, get: () => h.video });
    goHidden();
    await h.clock.tick(1000);
    expect(h.video.paused).toBe(false);

    delete document.pictureInPictureElement;
    goVisible();
    goHidden();
    h.video.webkitPresentationMode = 'picture-in-picture';   // switched after visibilitychange
    await h.clock.tick(700);
    expect(h.video.paused).toBe(false);
  });

  it('AirPlay (a wireless playback target) keeps playing', async () => {
    const h = await withLifecycle();
    h.video.webkitCurrentPlaybackTargetIsWireless = true;
    goHidden();
    await h.clock.tick(1000);
    expect(h.video.paused).toBe(false);
  });

  it('hidden outside the player: nothing to pause', async () => {
    const h = await withLifecycle();
    h.player.exitPlayer();
    await h.settle();
    const calls = h.video.calls.length;
    goHidden();
    await h.clock.tick(1000);
    expect(h.video.calls.slice(calls).filter((c) => c[0] === 'pause')).toEqual([]);
  });

  it('the player closed during the 700 ms: no pause', async () => {
    const h = await withLifecycle();
    goHidden();
    await h.clock.tick(300);
    h.S.screen = h.S.base;   // lowered (e.g. by a notification tap)
    const calls = h.video.calls.length;
    await h.clock.tick(700);
    expect(h.video.calls.slice(calls).filter((c) => c[0] === 'pause')).toEqual([]);
  });

  it('pagehide (the app closed) ends playback properly: Stopped, player down', async () => {
    const h = await withLifecycle();
    h.video.advance(120);
    window.dispatchEvent(new Event('pagehide'));
    await h.settle();
    expect(stopped(h)).toHaveLength(1);
    expect(stopped(h)[0].body.PositionTicks).toBe(120 * 10000000);
    expect(h.S.screen).not.toBe('player');
  });

  it('pagehide outside the player sends nothing', async () => {
    const h = await withLifecycle();
    h.player.exitPlayer();
    await h.settle();
    const n = stopped(h).length;
    window.dispatchEvent(new Event('pagehide'));
    await h.settle();
    expect(stopped(h)).toHaveLength(n);
  });

  it('an offline copy is checkpointed on the way down (it reports nothing to Jellyfin)', async () => {
    const h = await withLifecycle();
    h.player.exitPlayer();
    await h.settle();
    const checkpoint = vi.fn();
    const src = source([vstream(), audio()], { RunTimeTicks: 3600 * 10000000 });
    h.player.playFeedStream({
      item: movie({ MediaSources: [src] }),
      source: src,
      open: () => ({ url: 'blob:feed-1', managed: true, stop() {} }),
      exit: vi.fn(),
      checkpoint
    });
    h.video.setDuration(3600);
    h.video.emit('loadedmetadata');
    h.video.setReadyState(4);
    await h.settle();
    h.video.setTime(1500);
    h.video.emit('timeupdate');
    goHidden();
    expect(checkpoint).toHaveBeenCalledWith(1500, 3600);   // at once, before the 700 ms pause
  });

  it('back after more than a minute away: server check + token check (GET /Users/{id}); sooner: neither', async () => {
    const h = await withLifecycle();
    h.net.on('GET', '/System/Info/Public', { Version: '12.1.0' });
    h.net.on('GET', '/Users/u1', { Id: 'u1' });
    h.player.exitPlayer();
    await h.settle();
    goHidden();
    await h.clock.tick(30000);
    goVisible();
    await h.settle();
    expect(h.net.callsTo('/System/Info/Public')).toHaveLength(0);
    goHidden();
    await h.clock.tick(61000);
    goVisible();
    await h.settle();
    expect(h.net.callsTo('/System/Info/Public')).toHaveLength(1);
    expect(h.net.callsTo('/Users/u1', 'GET')).toHaveLength(1);
  });
});
