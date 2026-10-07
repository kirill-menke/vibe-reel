/* player.svelte.js — the OSD helpers and the small start/teardown paths the
 * other player suites don't reach (final audit: functions the coverage run
 * listed as never called).
 *
 * - togglePause / closePanel / videoEl / endsAt / osdTechSummary (the OSD's
 *   info line: "4K HDR10 · DD+ Atmos · English forced subs" — "like the menu's
 *   names, not the raw ENG tag").
 * - "A refused play() never reaches 'playing': drop the loading card so the
 *   paused first frame (and the OSD's Play) is what the user sees."
 * - Subtitle timing: "Text cues are moved in place — each remembers its
 *   original times, so repeated steps never accumulate clamping error"; the
 *   offset is applied when the track has parsed ('load') and again when it is
 *   switched to showing 250 ms after the attach.
 * - Reports and lookups that fail must not break playback (start report,
 *   next-episode lookup). */
import { describe, it, expect, beforeAll } from 'vitest';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, episode, source, video, audio, sub, tracks } from '../helpers/media.js';

describe('OSD helpers', () => {
  beforeAll(warmPlayer, 120000);

  it('videoEl() is the element the engine was handed', async () => {
    const h = await startPlayer();
    expect(h.player.videoEl()).toBe(h.video);
  });

  it('togglePause pauses a playing video and plays a paused one, raising the OSD each time', async () => {
    const h = await startPlayer();
    h.player.hideOsd();
    expect(h.video.paused).toBe(false);
    h.player.togglePause();
    expect(h.video.paused).toBe(true);
    expect(h.P.osdShown).toBe(true);
    h.player.hideOsd();
    h.player.togglePause();
    await h.settle();
    expect(h.video.paused).toBe(false);
    expect(h.P.osdShown).toBe(true);
  });

  it('togglePause with a play() the element refuses stays paused and does not throw', async () => {
    const h = await startPlayer();
    h.video.pause();
    h.video.playRejects = new DOMException('not allowed', 'NotAllowedError');
    h.player.togglePause();
    await h.settle();
    expect(h.video.paused).toBe(true);
  });

  it('closePanel closes the dropdown and brings the OSD back', async () => {
    const h = await startPlayer();
    h.P.panel = 'audio';
    h.player.hideOsd();
    h.player.closePanel();
    await h.settle();
    expect(h.P.panel).toBe(null);
    expect(h.P.osdShown).toBe(true);
  });

  it('endsAt is the wall clock after the remaining time (hh:mm), never in the past', async () => {
    const h = await startPlayer();
    const hhmm = (ms) => {
      const d = new Date(ms);
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    };
    h.P.dur = 3600;
    h.P.pos = 600;
    expect(h.player.endsAt()).toBe(hhmm(Date.now() + 3000 * 1000));
    expect(h.player.endsAt()).toMatch(/^\d\d:\d\d$/);
    h.P.pos = 4000;   // past the end (a stale duration): now, not earlier
    expect(h.player.endsAt()).toBe(hhmm(Date.now()));
  });

  it('osdTechSummary: resolution + HDR, the audio badge, the subtitle in words', async () => {
    const item = movie({
      MediaSources: [
        source([
          video({ Width: 3840, Height: 2160, VideoRange: 'HDR', VideoRangeType: 'HDR10' }),
          tracks.eac3Atmos({ Language: 'eng' }),
          sub({ Language: 'eng', IsForced: true }),
          tracks.sdh({ Language: 'ger' }),
          sub({ Language: 'fre' })
        ])
      ]
    });
    const h = await startPlayer({ item });
    h.player.pmSetAudio(1);
    h.player.pmSetSub(2);
    await h.settle();
    expect(h.player.osdTechSummary()).toBe('4K HDR10 · DD+ Atmos · English forced subs');
    h.player.pmSetSub(3);
    await h.settle();
    expect(h.player.osdTechSummary()).toBe('4K HDR10 · DD+ Atmos · German SDH subs');
    h.player.pmSetSub(4);
    await h.settle();
    expect(h.player.osdTechSummary()).toBe('4K HDR10 · DD+ Atmos · French subs');
    h.player.pmSetSub(-1);
    expect(h.player.osdTechSummary()).toBe('4K HDR10 · DD+ Atmos');
  });

  it('osdTechSummary: a TrueHD Atmos track reads "TrueHD Atmos" (V-F4)', async () => {
    const item = movie({
      MediaSources: [source([video({ Width: 3840, Height: 2160, VideoRange: 'HDR', VideoRangeType: 'HDR10' }), tracks.truehdAtmos({ Language: 'eng' })])]
    });
    const h = await startPlayer({ item });
    h.player.pmSetAudio(1);
    await h.settle();
    expect(h.player.osdTechSummary()).toBe('4K HDR10 · TrueHD Atmos');
  });

  it('osdTechSummary: SDR 1080p shows the resolution alone; no source, nothing', async () => {
    const h = await startPlayer({ item: movie({ MediaSources: [source([video(), audio({ Codec: 'ac3' })])] }) });
    h.player.pmSetSub(-1);
    expect(h.player.osdTechSummary()).toBe('1080p · DD');
    h.P.source = null;
    expect(h.player.osdTechSummary()).toBe('');
  });
});

describe('a play() the element refuses at the start', () => {
  beforeAll(warmPlayer, 120000);

  it('drops the loading card and shows the OSD on the paused first frame', async () => {
    const h = await startPlayer({ reach: 'src' });
    // phone: the Low Power Mode kick at src time already ran (and the fake let it
    // play); a WebKit that refuses play() refuses that one too — undo it
    if (__PHONE__) h.video.pause();
    h.video.playRejects = new DOMException('not allowed', 'NotAllowedError');
    h.video.setDuration(3600);
    h.video.setReadyState(1);
    h.video.emit('loadedmetadata');
    await h.settle();
    expect(h.video.paused).toBe(true);
    expect(h.P.loading).toBe(false);
    expect(h.P.osdShown).toBe(true);
    expect(h.P.error).toBe(null);
  });
});

describe('subtitle timing on text cues', () => {
  beforeAll(warmPlayer, 120000);

  /** the element's TextTrackList, with parsed cues */
  function cuesOn(h) {
    const list = [{ mode: 'disabled', cues: [{ startTime: 10, endTime: 12 }, { startTime: 0.1, endTime: 0.2 }] }];
    Object.defineProperty(h.video, 'textTracks', { configurable: true, get: () => list });
    return list;
  }

  async function withSrt() {
    const h = await startPlayer({ item: movie({ MediaSources: [source([video(), audio(), sub({ Language: 'eng' })])] }) });
    const list = cuesOn(h);
    h.player.pmSetSub(2);
    await h.settle();
    expect(h.video.querySelectorAll('track')).toHaveLength(1);
    return { h, list, cues: list[0].cues };
  }

  it('250 ms after the attach the track shows, with the current offset applied', async () => {
    const { h, list, cues } = await withSrt();
    h.P.subOffset = 1;
    await h.clock.tick(249);
    expect(list[0].mode).toBe('disabled');
    await h.clock.tick(1);
    expect(list[0].mode).toBe('showing');
    expect(cues[0]).toMatchObject({ startTime: 11, endTime: 13 });
  });

  it("the track's 'load' (cues parsed) applies the offset at once", async () => {
    const { h, cues } = await withSrt();
    h.P.subOffset = -2;
    h.video.querySelector('track').dispatchEvent(new Event('load'));
    expect(cues[0]).toMatchObject({ startTime: 8, endTime: 10 });
  });

  it('nudges move cues from their original times: no drift, clamped at 0 with a 10 ms minimum length', async () => {
    const { h, cues } = await withSrt();
    await h.clock.tick(250);
    h.player.nudgeSubOffset(1);
    h.player.nudgeSubOffset(1);
    expect(cues[0]).toMatchObject({ startTime: 10.5, endTime: 12.5 });
    for (let i = 0; i < 4; i++) h.player.nudgeSubOffset(-1);   // −0.5
    expect(cues[0]).toMatchObject({ startTime: 9.5, endTime: 11.5 });
    expect(cues[1].startTime).toBe(0);
    expect(cues[1].endTime).toBeCloseTo(0.01, 10);
    h.player.nudgeSubOffset(1);
    h.player.nudgeSubOffset(1);   // back to 0: the original times exactly
    expect(cues[0]).toMatchObject({ startTime: 10, endTime: 12 });
    expect(cues[1]).toMatchObject({ startTime: 0.1, endTime: 0.2 });
  });

  it('the offset stops at ±30 s', async () => {
    const h = await startPlayer();
    for (let i = 0; i < 125; i++) h.player.nudgeSubOffset(1);
    expect(h.P.subOffset).toBe(30);
    for (let i = 0; i < 245; i++) h.player.nudgeSubOffset(-1);
    expect(h.P.subOffset).toBe(-30);
  });
});

describe('failing side requests do not break playback', () => {
  beforeAll(warmPlayer, 120000);

  it('a failed start report (Sessions/Playing) is swallowed', async () => {
    const h = await startPlayer({ routes: (net) => net.on('POST', '/Sessions/Playing', net.status(500)) });
    await h.settle();
    expect(h.net.callsTo('/Sessions/Playing', 'POST')).toHaveLength(1);
    expect(h.P.error).toBe(null);
    expect(h.P.loading).toBe(false);
    expect(h.S.screen).toBe('player');
  });

  it('a failed next-episode lookup leaves no Up Next and playback running', async () => {
    const ep = episode();
    const h = await startPlayer({ item: ep, routes: (net) => net.on('GET', '/Shows/' + ep.SeriesId + '/Episodes', net.status(500)) });
    await h.settle();
    expect(h.P.next).toBe(null);
    expect(h.P.error).toBe(null);
    expect(h.S.screen).toBe('player');
  });
});
