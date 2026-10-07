/* player.svelte.js — the Audio / Subtitles menu actions (pmSetAudio, pmSetSub,
 * applyAudioSelection, attachSubtitles / clearSubs, the PGS path).
 *
 * CLAUDE.md, "Video playback":
 * - Track switching sets video.audioTracks[i].enabled (applyAudioSelection()).
 * - Per-series track memory: a pick in the Audio/Subtitles menu (pmSetAudio/
 *   pmSetSub, the *only* writers) is stored per account, keyed by SeriesId;
 *   movies and pending streams are neither read nor written.
 * - VobSub/DVB have no client-side decoder → the burn-in profile
 *   (deviceProfile(true)); a switch across the DirectPlay↔burn-in boundary is a
 *   restart that Stops the old session. On the phone every audio switch is that
 *   restart (the remux carries one audio track).
 * - Text formats are fetched as VTT and attached as a same-origin blob <track>;
 *   each attach mints a blob URL, which clearSubs() revokes. PGS is decoded by
 *   libpgs, always in mode 'mainThread' (its worker mode leaked one Worker per
 *   attach). */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, episode, source, video, audio, sub, tracks, playbackInfo } from '../helpers/media.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const LIBPGS = path.resolve(ROOT, 'src/vendor/libpgs.js');

/* 0 video · 1 E-AC3 eng · 2 AC3 ger · 3 SRT eng · 4 PGS eng · 5 VobSub eng */
const streams = () => [video(), tracks.eac3({ Language: 'eng' }), tracks.ac3({ Language: 'ger' }), sub({ Language: 'eng' }), tracks.pgs({ Language: 'eng' }), tracks.vobsub({ Language: 'eng' })];
const AUDIO_DE = 2;
const SRT = 3;
const PGS = 4;
const VOBSUB = 5;

/** PlaybackInfo like Jellyfin's: fresh PlaySessionIds; a burn-in request (or any phone
 * MKV) gets a TranscodingUrl instead of DirectPlay */
function jellyfin(net, { id, item }) {
  let n = 0;
  net.on('POST', '/Items/' + id + '/PlaybackInfo', (req) => {
    const ps = 'ps-' + ++n;
    const src = item.MediaSources[0];
    const burn = req.body.SubtitleStreamIndex === VOBSUB;
    const served = burn || __PHONE__ ? { ...src, SupportsDirectPlay: !burn && !__PHONE__, TranscodingUrl: '/videos/' + id + '/master.m3u8?MediaSourceId=' + src.Id + '&PlaySessionId=' + ps } : src;
    return playbackInfo(served, { PlaySessionId: ps });
  });
}

const infos = (h) => h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST');
const stops = (h) => h.net.callsTo('/Sessions/Playing/Stopped', 'POST');
const prefs = () => JSON.parse(localStorage.getItem('reel.trackPrefs.u1') || 'null');

async function tracksOf(h) {
  return import(/* @vite-ignore */ path.resolve(ROOT, 'src/lib/tracks.js'));
}

async function play(o = {}) {
  const item = o.item || episode({ MediaSources: [source(streams())] });
  const h = await startPlayer({ item, routes: jellyfin, ...o.start });
  await h.settle();
  return h;
}

afterEach(() => {
  vi.doUnmock(LIBPGS);
});

describe('pmSetAudio / pmSetSub: the only writers of track prefs', () => {
  beforeAll(warmPlayer, 120000);

  it('a start alone writes nothing', async () => {
    await play();
    expect(prefs()).toBe(null);
  });

  it('an episode pick is remembered under its series, by meaning', async () => {
    const h = await play();
    h.player.pmSetAudio(AUDIO_DE);
    expect(h.P.audioIndex).toBe(AUDIO_DE);
    h.player.pmSetSub(SRT);
    expect(h.P.subIndex).toBe(SRT);
    const all = prefs();
    expect(Object.keys(all)).toEqual([h.item.SeriesId]);
    expect(all[h.item.SeriesId]).toMatchObject({ a: { lang: 'German' }, s: { lang: 'English', forced: false, sdh: false, burn: false } });
    h.player.pmSetSub(-1);
    expect(h.P.subIndex).toBe(-1);
    expect(prefs()[h.item.SeriesId].s).toEqual({ off: true });
  });

  it('a movie pick is not remembered', async () => {
    const h = await play({ item: movie({ MediaSources: [source(streams())] }) });
    h.player.pmSetAudio(AUDIO_DE);
    h.player.pmSetSub(SRT);
    expect(h.P.audioIndex).toBe(AUDIO_DE);
    expect(prefs()).toBe(null);
  });

  it('a pick under another account lands in that account\'s key', async () => {
    const h = await play();
    h.cfg.userId = 'u2';
    h.player.pmSetAudio(AUDIO_DE);
    expect(prefs()).toBe(null);
    expect(JSON.parse(localStorage.getItem('reel.trackPrefs.u2'))[h.item.SeriesId].a).toEqual({ lang: 'German' });
  });
});

describe('audio switching', () => {
  beforeAll(warmPlayer, 120000);

  it('applyAudioSelection enables exactly the chosen track, mapped in file order', async () => {
    // the AC3 is listed first in MediaStreams but is Index 2 in the file
    const src = source([video({ Index: 0 }), tracks.ac3({ Index: 2, Language: 'ger' }), tracks.eac3({ Index: 1, Language: 'eng' })]);
    const h = await play({ item: movie({ MediaSources: [src] }) });
    h.video.setAudioTracks(2);
    h.P.audioIndex = 2;
    h.player.applyAudioSelection();
    expect([...h.video.audioTracks].map((t) => t.enabled)).toEqual([false, true]);
    h.P.audioIndex = 1;
    h.player.applyAudioSelection();
    expect([...h.video.audioTracks].map((t) => t.enabled)).toEqual([true, false]);
    // an index that is no audio track of the source leaves the element alone
    h.P.audioIndex = 7;
    h.player.applyAudioSelection();
    expect([...h.video.audioTracks].map((t) => t.enabled)).toEqual([true, false]);
  });

  it('the start applies the selection on loadedmetadata (DirectPlay only)', async () => {
    const h = await startPlayer({ item: movie({ MediaSources: [source(streams())] }), routes: jellyfin, reach: 'src' });
    h.video.setAudioTracks(2);
    h.P.audioIndex = AUDIO_DE;
    h.video.setDuration(3600);
    h.video.setReadyState(1);
    h.video.emit('loadedmetadata');
    await h.settle();
    expect([...h.video.audioTracks].map((t) => t.enabled)).toEqual(__PHONE__ ? [true, false] : [false, true]);
  });

  it('TV: a DirectPlay switch is client-side with a Progress report; phone: a restart at the same spot', async () => {
    const h = await play({ item: movie({ MediaSources: [source(streams())] }) });
    h.video.setAudioTracks(2);
    await h.clock.tick(1000);
    h.video.setTime(500);
    h.video.emit('timeupdate');
    const progress = h.net.callsTo('/Sessions/Playing/Progress', 'POST').length;
    h.player.pmSetAudio(AUDIO_DE);
    if (__PHONE__) expect(h.P.loading).toBe(true);   // the card goes up with the tap
    await h.settle();
    if (__PHONE__) {
      expect(infos(h)).toHaveLength(2);
      expect(infos(h)[1].body).toMatchObject({ AudioStreamIndex: AUDIO_DE, StartTimeTicks: 500 * 10000000 });
      expect(stops(h).map((c) => c.body.PlaySessionId)).toEqual(['ps-1']);
    } else {
      expect(infos(h)).toHaveLength(1);
      expect([...h.video.audioTracks].map((t) => t.enabled)).toEqual([false, true]);
      const p = h.net.callsTo('/Sessions/Playing/Progress', 'POST');
      expect(p).toHaveLength(progress + 1);
      expect(p.at(-1).body.AudioStreamIndex).toBe(AUDIO_DE);
    }
  });
});

describe('the burn-in boundary', () => {
  beforeAll(warmPlayer, 120000);

  it('a VobSub pick restarts with the burn-in profile and stops the old session; None goes back', async () => {
    const h = await play({ item: movie({ MediaSources: [source(streams())] }) });
    const { deviceProfile } = await tracksOf(h);
    const toast = (await import(/* @vite-ignore */ path.resolve(ROOT, 'src/lib/toast.svelte.js'))).toastState;
    const first = infos(h)[0].body;
    expect(first.DeviceProfile).toEqual(JSON.parse(JSON.stringify(deviceProfile(false, first.MaxStreamingBitrate))));
    h.video.setTime(300);
    h.video.emit('timeupdate');
    h.player.pmSetSub(VOBSUB);
    await h.settle();
    expect(infos(h)).toHaveLength(2);
    const burn = infos(h)[1].body;
    expect(burn.DeviceProfile).toEqual(JSON.parse(JSON.stringify(deviceProfile(true, burn.MaxStreamingBitrate))));
    expect(burn).toMatchObject({ SubtitleStreamIndex: VOBSUB, MediaSourceId: h.item.MediaSources[0].Id });
    expect(h.P.playMethod).toBe('Transcode');
    expect(h.video.src).toMatch(/\/videos\/.*\.m3u8/);
    expect(toast.msg).toBe('DVD subtitles need transcoding — burning them in…');
    expect(stops(h).map((c) => c.body.PlaySessionId)).toEqual(['ps-1']);

    h.player.pmSetSub(-1);
    await h.settle();
    expect(infos(h)).toHaveLength(3);
    const back = infos(h)[2].body;
    expect(back.DeviceProfile).toEqual(JSON.parse(JSON.stringify(deviceProfile(false, back.MaxStreamingBitrate))));
    expect(h.P.playMethod).toBe(__PHONE__ ? 'DirectStream' : 'DirectPlay');
    expect(stops(h).map((c) => c.body.PlaySessionId)).toEqual(['ps-1', 'ps-2']);
  });

  it('a text-to-text switch is no restart', async () => {
    const h = await play({ item: movie({ MediaSources: [source(streams())] }) });
    h.player.pmSetSub(SRT);
    await h.settle();
    h.player.pmSetSub(-1);
    await h.settle();
    expect(infos(h)).toHaveLength(1);
    expect(stops(h)).toHaveLength(0);
  });

  it('TV: an audio switch inside the burn-in stream is a restart (the audio is baked in)', async () => {
    const h = await play({ item: movie({ MediaSources: [source(streams())] }) });
    h.player.pmSetSub(VOBSUB);
    await h.settle();
    h.player.pmSetAudio(AUDIO_DE);
    await h.settle();
    expect(infos(h)).toHaveLength(3);
    expect(infos(h)[2].body).toMatchObject({ AudioStreamIndex: AUDIO_DE, SubtitleStreamIndex: VOBSUB });
  });
});

describe('text subtitles: a blob <track>, revoked by clearSubs()', () => {
  beforeAll(warmPlayer, 120000);

  it('fetches the VTT, attaches a same-origin blob track, shows it; clearSubs revokes the URL', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const h = await play({ item: movie({ MediaSources: [source(streams())] }) });
    h.player.pmSetSub(SRT);
    await h.settle();
    const vtt = h.net.callsTo((r) => r.path.endsWith('/Subtitles/' + SRT + '/0/Stream.vtt'));
    expect(vtt).toHaveLength(1);
    expect(new URL(vtt[0].url).searchParams.get('api_key')).toBe('tok-u1');
    const t = h.video.querySelectorAll('track');
    expect(t).toHaveLength(1);
    expect(t[0].src).toMatch(/^blob:/);
    expect(t[0].kind).toBe('subtitles');
    expect(t[0].srclang).toBe('eng');
    const url = t[0].src;
    h.player.clearSubs();
    expect(h.video.querySelectorAll('track')).toHaveLength(0);
    expect(revoke).toHaveBeenCalledWith(url);
  });

  it('switching tracks replaces the track and revokes the old blob', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const src = source([video(), audio(), sub({ Language: 'eng' }), sub({ Language: 'ger' })]);
    const h = await play({ item: movie({ MediaSources: [src] }) });
    h.player.pmSetSub(2);
    await h.settle();
    const first = h.video.querySelector('track').src;
    h.player.pmSetSub(3);
    await h.settle();
    const t = h.video.querySelectorAll('track');
    expect(t).toHaveLength(1);
    expect(t[0].srclang).toBe('ger');
    expect(revoke).toHaveBeenCalledWith(first);
  });

  it('a late answer for a track no longer picked is dropped', async () => {
    let answer;
    const gate = new Promise((r) => (answer = r));
    const h = await play({
      item: movie({ MediaSources: [source(streams())] }),
      start: { routes: (net, ctx) => {
        jellyfin(net, ctx);
        net.on('GET', (r) => r.path.endsWith('/Subtitles/' + SRT + '/0/Stream.vtt'), () => gate.then(() => net.text('WEBVTT\n', 'text/vtt')));
      } }
    });
    h.player.pmSetSub(SRT);
    await h.settle();
    h.player.pmSetSub(-1);
    answer();
    await h.settle();
    expect(h.video.querySelectorAll('track')).toHaveLength(0);
    expect(h.P.subIndex).toBe(-1);
  });

  it('a failed fetch toasts, falls back to None and reports it', async () => {
    const h = await play({
      item: movie({ MediaSources: [source(streams())] }),
      start: { routes: (net, ctx) => {
        jellyfin(net, ctx);
        net.on('GET', (r) => r.path.endsWith('/Subtitles/' + SRT + '/0/Stream.vtt'), net.status(500));
      } }
    });
    const toast = (await import(/* @vite-ignore */ path.resolve(ROOT, 'src/lib/toast.svelte.js'))).toastState;
    h.player.pmSetSub(SRT);
    await h.settle();
    expect(toast.msg).toBe('Couldn’t load subtitles');
    expect(h.P.subIndex).toBe(-1);
    expect(h.video.querySelectorAll('track')).toHaveLength(0);
    expect(h.net.callsTo('/Sessions/Playing/Progress', 'POST').at(-1).body.SubtitleStreamIndex).toBe(-1);
  });
});

describe('PGS: libpgs on the main thread', () => {
  beforeAll(warmPlayer, 120000);

  function fakeLibpgs({ throws = false } = {}) {
    const made = [];
    class FakePgs {
      constructor(opts) {
        this.opts = opts;
        this.disposed = 0;
        made.push(this);
      }
      dispose() {
        this.disposed++;
      }
    }
    vi.doMock(LIBPGS, () => ({
      loadPgs: () => {
        if (throws) throw new Error('no libpgs');
        return FakePgs;
      }
    }));
    return made;
  }

  it("mode 'mainThread' on the #pgs canvas with an ApiKey URL; clearSubs disposes it", async () => {
    const made = fakeLibpgs();
    const h = await play({ item: movie({ MediaSources: [source(streams())] }) });
    const canvas = document.createElement('canvas');
    h.player.setPgsCanvas(canvas);
    h.player.pmSetSub(PGS);
    expect(made).toHaveLength(1);
    const o = made[0].opts;
    expect(o.mode).toBe('mainThread');
    expect(o.video).toBe(h.video);
    expect(o.canvas).toBe(canvas);
    expect(o.timeOffset === 0).toBe(true);
    const u = new URL(o.subUrl);
    expect(u.pathname).toBe('/Videos/' + h.id + '/' + h.item.MediaSources[0].Id + '/Subtitles/' + PGS + '/0/Stream.pgssub');
    expect(u.searchParams.get('ApiKey')).toBe('tok-u1');
    expect(canvas.style.display).toBe('block');
    expect(h.net.callsTo((r) => r.path.includes('/Subtitles/'))).toHaveLength(0);   // libpgs fetches it itself
    h.player.pmSetSub(-1);
    expect(made[0].disposed).toBe(1);
    expect(canvas.style.display).toBe('none');
  });

  it('the subtitle offset reaches the renderer negated', async () => {
    const made = fakeLibpgs();
    const h = await play({ item: movie({ MediaSources: [source(streams())] }) });
    h.player.setPgsCanvas(document.createElement('canvas'));
    h.player.pmSetSub(PGS);
    h.player.nudgeSubOffset(1);
    h.player.nudgeSubOffset(1);
    expect(h.P.subOffset).toBe(0.5);
    expect(made[0].timeOffset).toBe(-0.5);
    h.player.pmSetSub(-1);
    h.player.pmSetSub(PGS);
    expect(made[1].opts.timeOffset).toBe(-0.5);
  });

  it('a libpgs that will not load toasts instead of breaking playback', async () => {
    fakeLibpgs({ throws: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = await play({ item: movie({ MediaSources: [source(streams())] }) });
    const toast = (await import(/* @vite-ignore */ path.resolve(ROOT, 'src/lib/toast.svelte.js'))).toastState;
    h.player.setPgsCanvas(document.createElement('canvas'));
    h.player.pmSetSub(PGS);
    expect(toast.msg).toBe('Couldn’t show these subtitles');
    expect(warn).toHaveBeenCalled();
    expect(h.P.error).toBe(null);
  });
});
