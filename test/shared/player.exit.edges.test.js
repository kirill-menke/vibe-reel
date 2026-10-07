/* player.svelte.js — exitPlayer()'s teardown and the destinations the other
 * files leave open (lane r3-tv-unit, mutation-backed: Stryker on 1765–2079).
 *
 * CLAUDE.md, "Exit destination": "back to the screen playback started from —
 * the item's detail page, PendingDetail/LookupDetail for a pending stream, or,
 * for a first start from Home's hero (homeReturn …), Home". exitPlayer():
 * "startGen++ — a start still waiting on loadedmetadata/playing must stay
 * quiet"; the element is emptied (src removed + load()) so its decoder lets go;
 * every OSD/transient field is reset so the next playback starts clean.
 * restartPos(): "such restarts resume at restartPos(), not raw currentTime,
 * which reads 0 under the loading card". */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, episode, source, video, audio, sub, tracks, playbackInfo } from '../helpers/media.js';

const TICKS = 10000000;

describe('exitPlayer: the teardown', () => {
  beforeAll(warmPlayer, 120000);

  it('every transient field of the player is reset', async () => {
    const h = await startPlayer();
    Object.assign(h.P, {
      osdShown: true,
      panel: 'audio',
      skips: [{ kind: 'intro', start: 1, end: 2, from: 'segment' }],
      credits: { start: 1, end: 2, from: 'segment' },
      next: { Id: 'n' },
      trick: { Width: 320 },
      chapters: [{ at: 1, name: 'x' }],
      spinner: true,
      loading: true,
      loadingItem: { Id: 'x' },
      error: { title: 't', detail: '', tech: '' }
    });
    h.player.exitPlayer();
    expect(h.P).toMatchObject({
      osdShown: false, panel: null, skips: [], credits: null, next: null, trick: null, chapters: [],
      spinner: false, loading: false, loadingItem: null, error: null
    });
  });

  it('the element is paused and emptied (src removed, then load() so the decoder lets go)', async () => {
    const h = await startPlayer();
    const before = h.video.calls.length;
    h.player.exitPlayer();
    expect(h.video.calls.slice(before)).toEqual([['pause'], ['removeSrc'], ['load']]);
    expect(h.video.getAttribute('src')).toBe(null);
  });

  it('a start still waiting for its metadata stays quiet after the exit', async () => {
    const h = await startPlayer({ reach: 'src' });
    h.player.exitPlayer();
    const before = h.video.calls.length;
    h.video.setDuration(3600);
    h.video.emit('loadedmetadata');
    h.video.setReadyState(4);
    h.video.emit('playing');
    await h.settle();
    expect(h.video.calls.slice(before).filter((c) => c[0] === 'play')).toEqual([]);
    expect(h.net.callsTo('/Sessions/Playing', 'POST')).toEqual([]);
    expect(h.P.osdShown).toBe(false);
  });

  it('exiting twice reports Stopped once', async () => {
    const h = await startPlayer();
    h.player.exitPlayer();
    h.S.screen = 'player';
    h.player.exitPlayer();
    await h.settle();
    expect(h.net.callsTo('/Sessions/Playing/Stopped', 'POST')).toHaveLength(1);
  });
});

describe('exit destinations the other files leave open', () => {
  beforeAll(warmPlayer, 120000);

  it('a Jellyfin start with no detail item at all goes Home', async () => {
    const h = await startPlayer();
    h.P.detailItem = null;
    h.player.exitPlayer();
    expect(h.S.screen).toBe('home');
  });

  it('an episode whose series page is the base, but of another type, opens the episode', async () => {
    const h = await startPlayer();
    h.P.detailItem = { Id: 'ep-1', Type: 'Episode', SeriesId: 'show-1' };
    h.S.detailId = 'show-1';
    h.S.detailType = 'Season';
    h.player.exitPlayer();
    expect(h.S.detailId).toBe('ep-1');
    expect(h.S.detailType).toBe('Episode');
  });

  it('an episode whose series page is open behind a non-detail base opens the episode', async () => {
    const h = await startPlayer({ base: 'library' });
    h.P.detailItem = { Id: 'ep-1', Type: 'Episode', SeriesId: 'show-1' };
    h.S.detailId = 'show-1';
    h.S.detailType = 'Series';
    h.player.exitPlayer();
    expect(h.S.detailId).toBe('ep-1');
  });

  it('a movie started over the series page of… nothing related opens the movie', async () => {
    const h = await startPlayer();
    h.S.detailId = h.id;
    h.S.detailType = 'Series';
    h.player.exitPlayer();
    expect(h.S.detailId).toBe(h.id);
    expect(h.S.detailType).toBe('Movie');
  });

  it('homeReturn only counts while Home is the base', async () => {
    const h = await startPlayer({ screen: 'home', base: 'home' });
    h.S.base = 'detail';   // the base changed under the player (a deep link)
    h.player.exitPlayer();
    expect(h.S.screen).toBe('detail');
    expect(h.S.detailId).toBe(h.id);
  });

  it('a pending stream over Home (or anything else) goes Home', async () => {
    const h = await startPlayer({ reach: 'src', base: 'home' });
    h.player.playPendingStream({ url: 'http://ml.test/api/downloads/abc/stream', item: { Name: 'F' }, source: h.source });
    h.player.exitPlayer();
    expect(h.S.screen).toBe('home');
    expect(h.P.pending).toBe(false);
  });

  it('a pending stream over a LookupDetail whose title is gone goes Home', async () => {
    const h = await startPlayer({ reach: 'src', base: 'lookup' });
    h.S.lookup = null;
    h.player.playPendingStream({ url: 'http://ml.test/api/downloads/abc/stream', item: { Name: 'F' }, source: h.source });
    h.player.exitPlayer();
    expect(h.S.screen).toBe('home');
  });
});

describe('restartPos: where a burn-in restart resumes', () => {
  beforeAll(warmPlayer, 120000);

  const burnable = () => movie({ MediaSources: [source([video(), audio(), tracks.vobsub()])] });
  function fresh(net, { id, item }) {
    let n = 0;
    // like Jellyfin: a burn-in request (the VobSub, index 2) gets the HLS transcode
    net.on('POST', '/Items/' + id + '/PlaybackInfo', (req) => {
      const src = item.MediaSources[0];
      const ps = 'ps-' + ++n;
      const burn = req.body.SubtitleStreamIndex === 2;
      const served = burn || __PHONE__ ? { ...src, SupportsDirectPlay: !burn && !__PHONE__, TranscodingUrl: '/videos/' + id + '/master.m3u8?PlaySessionId=' + ps } : src;
      return playbackInfo(served, { PlaySessionId: ps });
    });
  }

  it('a playhead reading 0 (not under the loading card) falls back to the last good position', async () => {
    const h = await startPlayer({ item: burnable(), resumeSec: 900, routes: fresh });
    await h.clock.tick(1000);   // out of the resume seek window
    h.video.setTime(0);   // the garbage read after a resume
    h.player.pmSetSub(2);
    await h.settle();
    const infos = h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST');
    expect(infos.at(-1).body.SubtitleStreamIndex).toBe(2);
    expect(h.P.loadingFrom).toBe(900);
  });

  it('a switch back out of the burn-in resumes where the burn-in stream is', async () => {
    const h = await startPlayer({ item: burnable(), routes: fresh });
    h.player.pmSetSub(2);
    await h.settle();
    expect(h.P.playMethod).toBe('Transcode');
    h.video.setDuration(3600);
    h.video.emit('loadedmetadata');
    h.video.setReadyState(4);
    await h.settle();
    await h.clock.tick(1000);
    h.video.setTime(1500);
    h.video.emit('timeupdate');
    h.player.pmSetSub(-1);
    await h.settle();
    expect(h.P.playMethod).toBe(__PHONE__ ? 'DirectStream' : 'DirectPlay');
    expect(h.P.loadingFrom).toBe(1500);
    expect(h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST')).toHaveLength(3);
  });

  it('a subtitle switch that stays on one side of the boundary does not restart', async () => {
    const item = movie({ MediaSources: [source([video(), audio(), tracks.vobsub(), tracks.pgs({ Language: 'ger' })])] });
    const h = await startPlayer({ item, routes: fresh });
    const n = h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST').length;
    h.player.pmSetSub(-1);
    await h.settle();
    expect(h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST')).toHaveLength(n);
    // a Progress report says which track is on now
    expect(h.net.callsTo('/Sessions/Playing/Progress', 'POST').at(-1).body.SubtitleStreamIndex).toBe(-1);
  });
});

describe('audio switch on a DirectPlay file', () => {
  beforeAll(warmPlayer, 120000);

  it('switches the element’s track and reports it, with the pause state as it is', async () => {
    const item = movie({ MediaSources: [source([video(), audio({ Language: 'eng' }), audio({ Codec: 'ac3', Language: 'ger' })])] });
    const h = await startPlayer({ item });
    if (__PHONE__) return expect(h.P.playMethod).toBe('DirectStream');   // the phone restarts instead (player.tracks)
    h.video.setAudioTracks(2);
    h.video.pause();
    const n = h.net.callsTo('/Sessions/Playing/Progress', 'POST').length;
    h.player.pmSetAudio(2);
    expect([...h.video.audioTracks].map((t) => t.enabled)).toEqual([false, true]);
    const reports = h.net.callsTo('/Sessions/Playing/Progress', 'POST').slice(n);
    expect(reports.at(-1).body).toMatchObject({ AudioStreamIndex: 2, IsPaused: true });
    expect(h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST')).toHaveLength(1);
  });
});

function layerButton(key) {
  let layer = document.getElementById('video-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'video-layer';
    document.body.append(layer);
  }
  const b = document.createElement('button');
  b.className = 'focus';
  b.dataset.focus = key;
  b.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 });
  layer.append(b);
  return b;
}
afterEach(() => {
  document.body.innerHTML = '';
});

describe('the OSD auto-hide', () => {
  beforeAll(warmPlayer, 120000);
  const HIDE = __PHONE__ ? 3500 : 5000;

  it('hides after the delay while playing; a second showOsd restarts the delay', async () => {
    const h = await startPlayer();
    h.player.showOsd();
    await h.clock.tick(HIDE - 1000);
    h.player.showOsd();
    await h.clock.tick(HIDE - 1);
    expect(h.P.osdShown).toBe(true);
    await h.clock.tick(1);
    expect(h.P.osdShown).toBe(false);
  });

  it.each([
    ['paused', (h) => h.video.pause()],
    ['a dropdown is open', (h) => (h.P.panel = 'audio')],
    ['a scrub is pending', (h) => (h.P.scrub = 120)]
  ])('stays up while %s', async (_, set) => {
    const h = await startPlayer();
    set(h);
    h.player.showOsd();
    await h.clock.tick(HIDE * 3);
    expect(h.P.osdShown).toBe(true);
  });

  it('showOsd seeds the position only when the OSD comes up (not while it is up)', async () => {
    const h = await startPlayer();
    h.player.hideOsd();
    h.video.setTime(300);
    h.player.showOsd();
    expect(h.P.pos).toBe(300);
  });
});

describe('closePanel', () => {
  beforeAll(warmPlayer, 120000);

  it('closes the dropdown onto the pill it came from, else the Audio pill (TV focus)', async () => {
    const h = await startPlayer();
    const audioPill = layerButton('c-audio');
    const subsPill = layerButton('c-subs');
    h.P.panel = 'subs';
    h.S.lastPill = 'c-subs';
    h.player.closePanel();
    await h.settle();
    expect(h.P.panel).toBe(null);
    expect(h.P.osdShown).toBe(true);
    if (!__PHONE__) expect(document.activeElement).toBe(subsPill);
    h.S.lastPill = null;
    h.player.closePanel();
    await h.settle();
    if (!__PHONE__) expect(document.activeElement).toBe(audioPill);
  });
});

describe('osdTechSummary', () => {
  beforeAll(warmPlayer, 120000);

  it('a video stream that yields no words leaves no empty part', async () => {
    const src = source([video({ Width: undefined, Height: undefined, VideoRangeType: 'SDR' }), audio({ Codec: 'eac3', IsDefault: true })]);
    const h = await startPlayer({ item: movie({ MediaSources: [src] }) });
    expect(h.player.osdTechSummary()).toBe('DD+');
  });
});

describe('exitPlayer: more teardown', () => {
  beforeAll(warmPlayer, 120000);

  it('the subtitle track goes, and the watchdog interval with it', async () => {
    const item = movie({ MediaSources: [source([video(), audio(), sub({ Language: 'eng' })])] });
    const h = await startPlayer({ item, storage: { 'reel.settings': JSON.stringify({ subMode: 'always' }) } });
    // watch the next start's intervals: the 500 ms one is the watchdog
    const si = globalThis.setInterval;
    const ci = globalThis.clearInterval;
    const watchdogs = [];
    const cleared = new Set();
    vi.spyOn(globalThis, 'setInterval').mockImplementation((fn, ms, ...a) => {
      const id = si(fn, ms, ...a);
      if (ms === 500) watchdogs.push(id);
      return id;
    });
    vi.spyOn(globalThis, 'clearInterval').mockImplementation((id) => {
      cleared.add(id);
      return ci(id);
    });
    h.player.restartPlayback(0);
    await h.settle();
    await h.clock.tick(300);
    expect(h.video.querySelectorAll('track')).toHaveLength(1);
    expect(watchdogs).toHaveLength(1);
    h.player.exitPlayer();
    expect(h.video.querySelectorAll('track')).toHaveLength(0);
    expect(cleared.has(watchdogs[0])).toBe(true);
  });

  it('a scrub pending at the exit never seeks the emptied element', async () => {
    const m = movie();
    const sid = m.MediaSources[0].Id;
    vi.stubGlobal('Image', class { set src(v) {} });
    const h = await startPlayer({ item: m, trickplay: { [sid]: { 320: { Width: 320, Height: 180, TileWidth: 10, TileHeight: 10, ThumbnailCount: 270, Interval: 10000, Bandwidth: 1 } } } });
    await h.settle();
    h.player.scrubBy(1);
    h.player.exitPlayer();
    const seeks = h.video.seeks.length;
    await h.clock.tick(2000);
    expect(h.video.seeks.length).toBe(seeks);
    expect(h.P.scrub).toBe(null);
  });

  it('a pending stream over a detail page with a stale LookupDetail in S returns to the detail page', async () => {
    const h = await startPlayer({ reach: 'src', base: 'detail' });
    h.S.lookup = { type: 'movie', id: 1 };
    h.S.detailId = 'm-1';
    h.S.detailType = 'Movie';
    h.player.playPendingStream({ url: 'http://ml.test/api/downloads/abc/stream', item: { Name: 'F' }, source: h.source });
    h.player.exitPlayer();
    expect(h.S.screen).toBe('detail');
    expect(h.S.detailId).toBe('m-1');
  });

  it('a detail-page start whose base became Home (no Home tile) goes to the item, not Home', async () => {
    const h = await startPlayer();
    h.S.base = 'home';
    h.player.exitPlayer();
    expect(h.S.screen).toBe('detail');
    expect(h.S.detailId).toBe(h.id);
  });

  it('a series extra (a Video with a SeriesId) over its series page opens the extra, not the series', async () => {
    const h = await startPlayer();
    h.P.detailItem = { Id: 'extra-1', Type: 'Video', SeriesId: 'show-1' };
    h.S.detailId = 'show-1';
    h.S.detailType = 'Series';
    h.player.exitPlayer();
    expect(h.S.detailId).toBe('extra-1');
    expect(h.S.detailType).toBe('Video');
  });
});

describe('track picks during a pending stream are not remembered', () => {
  beforeAll(warmPlayer, 120000);

  it('neither the audio nor the subtitle pick writes a series preference', async () => {
    const h = await startPlayer({ reach: 'src' });
    const src = source([video(), audio({ Language: 'eng' }), audio({ Codec: 'ac3', Language: 'ger' }), sub({ Language: 'eng' })]);
    h.player.playPendingStream({ url: 'http://ml.test/api/downloads/abc/stream', item: { Name: 'Ep', Type: 'Episode', SeriesId: 'show-1' }, source: src });
    h.video.setAudioTracks(2);
    h.player.pmSetAudio(2);
    h.player.pmSetSub(3);
    expect(Object.keys(localStorage).filter((k) => k.startsWith('reel.trackPrefs'))).toEqual([]);
  });

  it('…while the same picks on a library episode are', async () => {
    const ep = episode({ SeriesId: 'show-1', MediaSources: [source([video(), audio({ Language: 'eng' }), audio({ Codec: 'ac3', Language: 'ger' }), sub({ Language: 'eng' })])] });
    const h = await startPlayer({ item: ep });
    h.video.setAudioTracks(2);
    h.player.pmSetAudio(2);
    expect(Object.keys(localStorage).filter((k) => k.startsWith('reel.trackPrefs')).length).toBeGreaterThan(0);
  });
});
