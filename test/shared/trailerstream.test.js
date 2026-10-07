/* trailerstream.js createTrailerSource(): the MSE feeder behind in-app trailers.
 *
 * CLAUDE.md (Video playback → Trailers): the TV's own HLS player can't take the
 * growing event playlist, so `trailerstream.js` feeds MSE itself: "6 s preloaded
 * before anything is appended, `ms.duration` from yt-dlp, and a bounded window
 * (45 s ahead, 15 s behind …) that follows seeks and re-fetches dropped
 * stretches. Segments count as buffered by their *midpoint* (an end-time
 * tolerance once skipped a 0.17 s segment and playback hung at the hole), and it
 * steps over holes < 1 s itself ('gap jumping')". English subtitles: "the feeder
 * waits ≤ 1.5 s for them and downloads the VTT itself before the first frame".
 * The phone build keeps 30 s ahead / 5 s behind (module constants).
 *
 * Runs in both projects; phone-only paths (ManagedMediaSource streaming, the
 * `@1080` key and its fallback) are in test/phone/trailerstream.test.js.
 *
 * The server is mocked through fetch: POST/GET `<base>` = the job status,
 * `<base>/index.m3u8`, `<base>/init.mp4`, `<base>/sNNN.m4s` (fake segments from
 * helpers/mse.js that carry their media range), `<base>/subs.vtt`. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTrailerSource } from '../../src/lib/trailerstream.js';
import { cfg } from '../../src/lib/config.js';
import { installMSE } from '../helpers/mse.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock } from '../helpers/time.js';
import { TEST_MEDIALIB } from '../helpers/modules.js';
import { trailerServer, uniform, READY } from '../helpers/trailer.js';

const PHONE = __PHONE__;
const AHEAD = PHONE ? 30 : 45;
const BEHIND = PHONE ? 5 : 15;
const ID = 'dQw4w9WgXcQ';
const BASE = TEST_MEDIALIB + '/api/trailers/' + ID + (PHONE ? '@1080' : '');

let clock, net, mse, pos, jump, onFail, onInfo, onSubs, src, srv;

beforeEach(() => {
  cfg.medialib = TEST_MEDIALIB;
  clock = useClock();
  net = mockFetch();
  pos = 0;
  jump = vi.fn((t) => {
    pos = t;
  });
  onFail = vi.fn();
  onInfo = vi.fn();
  onSubs = vi.fn();
  src = null;
  srv = null;
  mse = null;
});

afterEach(() => {
  src?.stop();
});

function start(o = {}) {
  mse = mse || installMSE(o.mse || {});
  srv = trailerServer({ ...o, net, mse: () => mse, base: BASE });
  src = createTrailerSource(ID, { onFail, onInfo, onSubs, position: () => pos, jump: o.noJump ? undefined : jump });
  return src;
}

const sb = () => mse.last.sb;
const appended = () => (sb() ? sb().appends.filter((a) => !a.init) : []);
const lastEnd = () => {
  const r = sb().ranges();
  return r.length ? r[r.length - 1][1] : 0;
};
const count = (name) => srv.fetched.filter((n) => n === name).length;

describe('start: status, preload, duration', () => {
  it('POSTs the job, then appends init + the first 6 s only after all of them are in memory', async () => {
    // 2 s segments: s000–s002 start before 6 s; hold the third one's answer
    start({ segs: uniform(50, 2), hold: (n) => n === 's002.m4s' });
    await clock.tick(50);
    expect(net.calls[0]).toMatchObject({ method: 'POST', url: BASE });
    expect(net.calls[0].init.cache).toBe('no-store');
    expect(srv.fetched).toEqual(['init.mp4', 's000.m4s', 's001.m4s', 's002.m4s']);
    // 4 of 6 s are in memory: nothing appended yet, not even the init segment
    expect(sb().appends).toEqual([]);
    srv.release('s002.m4s');
    await clock.tick(1);
    expect(sb().appends.slice(0, 4)).toEqual([
      { init: true, bytes: 600 },
      { start: 0, end: 2, bytes: 2048 },
      { start: 2, end: 4, bytes: 2048 },
      { start: 4, end: 6, bytes: 2048 }
    ]);
  });

  it('ms.duration comes from the status (yt-dlp), set before the SourceBuffer exists', async () => {
    start({ status: [{ ...READY, duration: 151.25 }] });
    await clock.tick(10);
    const calls = mse.last.calls.filter((c) => c[0] === 'duration' || c[0] === 'addSourceBuffer');
    expect(calls).toEqual([
      ['duration', 151.25],
      ['addSourceBuffer', 'video/mp4; codecs="avc1.640028,mp4a.40.2"']
    ]);
    expect(onInfo).toHaveBeenCalledTimes(1);
    expect(onInfo.mock.calls[0][0]).toMatchObject({ state: 'ready', duration: 151.25 });
  });

  it('no duration in the status: ms.duration is left alone', async () => {
    start({ status: [{ ...READY, duration: undefined }] });
    await clock.tick(10);
    expect(mse.last.calls.some((c) => c[0] === 'duration')).toBe(false);
    expect(appended().length).toBeGreaterThan(0);
  });

  it('polls the status every 300 ms while downloading < 6 s, and starts at buffered_s >= 6', async () => {
    start({ status: (n, t) => ({ ...READY, state: 'downloading', buffered_s: t >= 1200 ? 6 : 2 }) });
    await clock.tick(1100);
    expect(srv.fetched).toEqual([]);
    expect(net.callsTo(BASE + '/index.m3u8')).toEqual([]);
    await clock.tick(400);
    const st = srv.statusCalls;
    expect(st[0].method).toBe('POST');
    expect(st.slice(1).every((c) => c.method === 'GET')).toBe(true);
    // POST at 0, GETs at 300, 600, 900, 1200 — the one at 1200 says 6 s
    expect(st.map((c) => c.t)).toEqual([0, 300, 600, 900, 1200]);
    expect(appended().length).toBeGreaterThan(0);
  });

  it('builds the MIME from codecs, else vcodec + AAC, else H.264 + AAC', async () => {
    start({ status: [{ ...READY, codecs: 'av01.0.12M.10,opus' }] });
    await clock.tick(10);
    expect(sb().mime).toBe('video/mp4; codecs="av01.0.12M.10,opus"');
    src.stop();

    mse = null;
    start({ status: [{ ...READY, codecs: undefined, vcodec: 'vp09.02.51.10' }] });
    await clock.tick(10);
    expect(sb().mime).toBe('video/mp4; codecs="vp09.02.51.10,mp4a.40.2"');
    src.stop();

    mse = null;
    start({ status: [{ ...READY, codecs: undefined }] });
    await clock.tick(10);
    expect(sb().mime).toBe('video/mp4; codecs="avc1.640028,mp4a.40.2"');
  });

  it('returns a blob URL of the MediaSource; stop() revokes it', () => {
    start();
    expect(src.url).toBe(mse.last.url);
    expect('managed' in src).toBe(PHONE);   // the phone build says whether it got a ManagedMediaSource
    src.stop();
    expect(mse.revoked).toEqual([src.url]);
  });
});

describe('the window: ' + AHEAD + ' s ahead, ' + BEHIND + ' s behind (' + (PHONE ? 'phone' : 'TV') + ')', () => {
  it('fills to the first segment end at or past playhead + ' + AHEAD + ' s, then waits', async () => {
    start();
    await clock.tick(1000);
    const end = lastEnd();
    expect(end).toBeGreaterThanOrEqual(AHEAD);
    expect(end).toBeLessThan(AHEAD + 4);
    expect(sb().ranges()).toEqual([[0, end]]);
    const n = srv.fetched.length;
    await clock.tick(3000);
    expect(srv.fetched.length).toBe(n);   // the playhead didn't move: nothing more
  });

  it('follows the playhead: fetches more as it moves and drops what is more than ' + BEHIND + ' s behind', async () => {
    start();
    await clock.tick(1000);
    pos = 30;
    await clock.tick(1000);
    expect(lastEnd()).toBeGreaterThanOrEqual(30 + AHEAD);
    expect(lastEnd()).toBeLessThan(30 + AHEAD + 4);
    // the cut lands 0.25 s below the start of the segment 30 − BEHIND falls in
    // (keyframe drift margin), so that segment stays whole (V-F12) and the
    // buffer starts right there
    const segStart = Math.floor((30 - BEHIND) / 4) * 4;
    expect(sb().removes[0]).toEqual([0, segStart - 0.25]);
    expect(sb().ranges()[0][0]).toBe(segStart);
  });

  it('does not trim while the cut point is still within the first second', async () => {
    start();
    await clock.tick(500);
    pos = BEHIND + 1;   // cut = 1: not > 1
    await clock.tick(1000);
    expect(sb().removes).toEqual([]);
    // only trims before an append: move far enough to need one
    pos = BEHIND + 8;
    await clock.tick(1000);
    expect(sb().removes).toEqual([[0, 7.75]]);
  });

  it('a seek into an unbuffered stretch fetches from the segment the playhead landed in', async () => {
    start();
    await clock.tick(1000);
    const before = srv.fetched.length;
    pos = 81;   // s020 = 80–84
    await clock.tick(1000);
    const after = srv.fetched.slice(before);
    expect(after[0]).toBe('s020.m4s');
    expect(after).not.toContain('s015.m4s');
    expect(sb().ranges().some(([a, b]) => a <= 81 && b > 84)).toBe(true);
  });

  it('a dropped stretch the playhead needs is fetched again', async () => {
    start();
    await clock.tick(1000);
    expect(count('s005.m4s')).toBe(1);
    sb().evict(20, 24);   // the buffer lost s005
    await clock.tick(1000);
    expect(count('s005.m4s')).toBe(2);
    expect(sb().ranges()).toEqual([[0, lastEnd()]]);
  });

  it('a QuotaExceededError frees what was watched and retries the same segment after 500 ms', async () => {
    start();
    await clock.tick(1000);
    pos = 25;
    sb().quotaNext();
    const appendsBefore = appended().length;
    const endBefore = lastEnd();
    await clock.tick(350);   // the loop wakes within 300 ms and hits the full buffer
    expect(sb().calls.some((c) => c[0] === 'quota')).toBe(true);
    expect(appended().length).toBe(appendsBefore);
    await clock.tick(600);
    expect(appended().length).toBeGreaterThan(appendsBefore);
    expect(appended()[appendsBefore].start).toBe(endBefore);   // the same segment, retried
    expect(onFail).not.toHaveBeenCalled();
  });

  it('closes the stream (endOfStream) once the complete playlist is in, and not before', async () => {
    start({ segs: uniform(6) });   // 24 s, all inside the window
    await clock.tick(1000);
    expect(mse.last.ended).toBe(1);
    expect(mse.last.readyState).toBe('ended');
  });

  it('a growing playlist is re-read every 300 ms and never closed while incomplete', async () => {
    start({ segs: uniform(5), complete: false });
    await clock.tick(1000);
    expect(lastEnd()).toBe(20);
    expect(mse.last.ended).toBe(0);
    const reads = net.callsTo(BASE + '/index.m3u8').length;
    srv.segs.push(...uniform(3, 4, 20).map((g, i) => ({ ...g, name: 's' + String(5 + i).padStart(3, '0') + '.m4s' })));
    srv.complete = true;
    await clock.tick(1000);
    expect(net.callsTo(BASE + '/index.m3u8').length).toBeGreaterThan(reads);
    expect(lastEnd()).toBe(32);
    expect(mse.last.ended).toBe(1);
    // complete: no more playlist reads
    const done = net.callsTo(BASE + '/index.m3u8').length;
    await clock.tick(2000);
    expect(net.callsTo(BASE + '/index.m3u8').length).toBe(done);
  });

  it('a seek back after endOfStream re-opens the source and refills', async () => {
    start({ segs: uniform(20) });   // 80 s
    await clock.tick(500);
    pos = 60;
    await clock.tick(1000);
    expect(mse.last.ended).toBe(1);
    pos = 2;   // into the trimmed start
    await clock.tick(1000);
    expect(count('s000.m4s')).toBe(2);
    expect(sb().ranges()[0][0]).toBe(0);
  });
});

describe('a segment counts as buffered by its midpoint', () => {
  // The measured case: s009 was 40.214–40.381 s; an end-time tolerance called it
  // buffered, it was never fetched, and playback hung at the hole.
  const segs = [
    ...uniform(10).slice(0, 9).map((g) => ({ ...g })),                         // 0–36
    { start: 36, end: 40.214, name: 's009.m4s' },
    { start: 40.214, end: 40.381, name: 's010.m4s' },
    ...uniform(10, 4, 40.381).map((g, i) => ({ ...g, name: 's' + String(11 + i).padStart(3, '0') + '.m4s' }))
  ];

  it('the 0.17 s segment is fetched and appended, leaving no hole', async () => {
    // its neighbour's media runs 0.04 s into it (within the 0.05 s gap tolerance)
    start({ segs, media: (g) => (g.name === 's009.m4s' ? [36, 40.254] : [g.start, g.end]) });
    await clock.tick(500);
    pos = 15;
    await clock.tick(1000);
    expect(count('s010.m4s')).toBe(1);
    expect(sb().appends.some((a) => a.start === 40.214 && a.end === 40.381)).toBe(true);
    expect(sb().ranges()).toHaveLength(1);
  });

  it('a segment whose media ends short of its #EXTINF end is not fetched again and again', async () => {
    // the last segment holds 96–99.8 although the playlist says 96–100
    start({ media: (g) => (g.name === 's024.m4s' ? [96, 99.8] : [g.start, g.end]) });
    await clock.tick(500);
    pos = 80;
    await clock.tick(3000);
    expect(count('s024.m4s')).toBe(1);
    expect(mse.last.ended).toBe(1);
  });

  it('a segment the feeder never appended is fetched even when the buffer already spans its midpoint', async () => {
    // s001's media really covers 4–10.5: s002's midpoint (10) is buffered, but only an append counts
    start({ media: (g) => (g.name === 's001.m4s' ? [4, 10.5] : [g.start, g.end]) });
    await clock.tick(1000);
    expect(count('s002.m4s')).toBe(1);
  });
});

describe('gap jumping', () => {
  // s003's media starts late: a hole of `gap` seconds after 12 s
  const withHole = (gap) => ({ media: (g) => (g.name === 's003.m4s' ? [12 + gap, 16] : [g.start, g.end]) });

  it('a hole < 1 s: the playhead within 0.25 s of the range end is moved just past the hole', async () => {
    start(withHole(0.4));
    await clock.tick(1000);
    expect(sb().ranges()[0]).toEqual([0, 12]);
    pos = 11.7;   // 0.3 s before the end: not yet
    await clock.tick(1000);
    expect(jump).not.toHaveBeenCalled();
    pos = 11.8;
    await clock.tick(400);
    expect(jump).toHaveBeenCalledTimes(1);
    expect(jump.mock.calls[0][0]).toBeCloseTo(12.45, 5);
    expect(pos).toBeCloseTo(12.45, 5);
  });

  it('the playhead stuck inside the hole is moved too', async () => {
    start(withHole(0.9));
    await clock.tick(1000);
    pos = 12.5;
    await clock.tick(400);
    expect(jump.mock.calls.map((c) => +c[0].toFixed(3))).toEqual([12.95]);
  });

  it('a hole of 1 s or more is not jumped', async () => {
    start(withHole(1));
    await clock.tick(1000);
    pos = 11.9;
    await clock.tick(2000);
    expect(jump).not.toHaveBeenCalled();
  });

  it('a hole left by a dropped segment is refetched, not jumped', async () => {
    start();
    await clock.tick(1000);
    sb().evict(8, 12);
    pos = 7.9;
    await clock.tick(1000);
    expect(jump).not.toHaveBeenCalled();
    expect(count('s002.m4s')).toBe(2);
    expect(sb().ranges()).toHaveLength(1);
  });

  it('without a jump() callback holes are left alone', async () => {
    start({ ...withHole(0.4), noJump: true });
    await clock.tick(1000);
    pos = 11.9;
    await clock.tick(1000);
    expect(pos).toBe(11.9);
    expect(onFail).not.toHaveBeenCalled();
  });
});

describe('subtitles', () => {
  const SUBS = { lang: 'en', kind: 'auto' };

  it('subs ready with the video: the VTT is fetched and handed over before the SourceBuffer exists', async () => {
    let sbsAtCall = -1;
    onSubs.mockImplementation(() => {
      sbsAtCall = mse.last.sourceBuffers.length;
    });
    start({ status: [{ ...READY, subs_done: true, subs: SUBS }], vtt: 'WEBVTT\n\n00:01.000 --> 00:02.000\nFirst line\n' });
    await clock.tick(10);
    expect(onSubs).toHaveBeenCalledTimes(1);
    expect(onSubs).toHaveBeenCalledWith('WEBVTT\n\n00:01.000 --> 00:02.000\nFirst line\n', SUBS);
    expect(sbsAtCall).toBe(0);
  });

  it('waits for the subtitle lookup after the video is ready — subs arriving at 900 ms still come first', async () => {
    let appendsAtCall = -1;
    onSubs.mockImplementation(() => {
      appendsAtCall = mse.last.sb ? mse.last.sb.appends.length : 0;
    });
    start({ status: (n, t) => (t >= 900 ? { ...READY, subs_done: true, subs: SUBS } : { ...READY, subs_done: false }) });
    await clock.tick(800);
    expect(srv.fetched).toEqual([]);
    await clock.tick(400);
    expect(onSubs).toHaveBeenCalledTimes(1);
    expect(appendsAtCall).toBe(0);
    expect(appended().length).toBeGreaterThan(0);
  });

  it('waits at most 1.5 s past "enough video"; subs that come later are still handed over', async () => {
    start({ status: (n, t) => (t >= 4000 ? { ...READY, subs_done: true, subs: SUBS } : { ...READY, subs_done: false }) });
    await clock.tick(1500);
    expect(net.callsTo(BASE + '/index.m3u8')).toEqual([]);
    await clock.tick(400);   // the 1.5 s are up at the next 300 ms poll
    expect(net.callsTo(BASE + '/index.m3u8')).toHaveLength(1);
    expect(onSubs).not.toHaveBeenCalled();
    await clock.tick(4000);
    expect(onSubs).toHaveBeenCalledTimes(1);
    expect(onSubs.mock.calls[0][1]).toEqual(SUBS);
    // once found, the status isn't polled for subs any more
    const n = srv.statusCalls.length;
    await clock.tick(3000);
    expect(srv.statusCalls.length).toBe(n);
  });

  it('the lookup finished without subtitles: onSubs is never called and no VTT is fetched', async () => {
    start({ status: [{ ...READY, subs_done: true, subs: null }] });
    await clock.tick(2000);
    expect(onSubs).not.toHaveBeenCalled();
    expect(count('subs.vtt')).toBe(0);
  });

  it('a lookup that never finishes: no onSubs, playback goes on', async () => {
    start({ status: [{ ...READY, subs_done: false }] });
    await clock.tick(6000);
    expect(onSubs).not.toHaveBeenCalled();
    expect(appended().length).toBeGreaterThan(0);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('a failing VTT download is swallowed (no onSubs, no onFail)', async () => {
    start({ status: [{ ...READY, subs_done: true, subs: SUBS }] });
    net.on('GET', BASE + '/subs.vtt', net.status(500));
    await clock.tick(1000);
    expect(onSubs).not.toHaveBeenCalled();
    expect(onFail).not.toHaveBeenCalled();
    expect(appended().length).toBeGreaterThan(0);
  });
});

describe('failures → onFail', () => {
  it('the job reports an error', async () => {
    start({ status: [{ state: 'error', error: 'Video unavailable' }] });
    await clock.tick(10);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0].message).toBe('Video unavailable');
    expect(mse.last.sourceBuffers).toEqual([]);
  });

  it('an error state without a message gets a generic one', async () => {
    start({ status: [{ state: 'downloading', buffered_s: 1 }, { state: 'error' }] });
    await clock.tick(400);
    expect(onFail.mock.calls[0][0].message).toBe('the trailer could not be fetched');
  });

  it('an HTTP error carries the server detail, else the status code', async () => {
    start({ status: [{ httpStatus: 502, body: { detail: 'yt-dlp failed' } }] });
    await clock.tick(10);
    expect(onFail.mock.calls[0][0].message).toBe('yt-dlp failed');
    src.stop();

    mse = null;
    onFail.mockClear();
    start({ status: [{ httpStatus: 503, body: '' }] });
    await clock.tick(10);
    expect(onFail.mock.calls[0][0].message).toBe('HTTP 503');
  });

  it('the service unreachable', async () => {
    mse = installMSE();
    net.on(null, BASE, net.networkError());
    src = createTrailerSource(ID, { onFail, position: () => 0 });
    await clock.tick(10);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0]).toBeInstanceOf(TypeError);
  });

  it('45 s without enough video: "the trailer took too long to start"', async () => {
    start({ status: [{ ...READY, state: 'downloading', buffered_s: 2 }] });
    await clock.tick(44800);
    expect(onFail).not.toHaveBeenCalled();
    await clock.tick(600);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0].message).toBe('the trailer took too long to start');
    const n = net.calls.length;
    await clock.tick(5000);
    expect(net.calls.length).toBe(n);
  });

  it('a codec the platform refuses', async () => {
    start({ mse: { supported: (m) => !/av01/.test(m) }, status: [{ ...READY, codecs: 'av01.0.16M.10,opus' }] });
    await clock.tick(10);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0].message).toBe((PHONE ? 'this iPhone refuses ' : 'the TV refuses ') + 'video/mp4; codecs="av01.0.16M.10,opus"');
    expect(mse.typeQueries).toEqual(['video/mp4; codecs="av01.0.16M.10,opus"']);
    expect(srv.fetched).toEqual([]);
  });

  it('a segment the decoder rejects', async () => {
    start({ hold: (n) => n === 's001.m4s' });
    await clock.tick(10);
    srv.release('s001.m4s');
    mse.last.sb.failNext();   // the init append fails
    await clock.tick(10);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0].message).toBe('the TV rejected a segment');
  });

  it('a playlist or segment HTTP error', async () => {
    start();
    net.on('GET', BASE + '/index.m3u8', net.status(500));
    await clock.tick(10);
    expect(onFail.mock.calls[0][0].message).toBe('playlist: HTTP 500');
    src.stop();

    mse = null;
    onFail.mockClear();
    start();
    net.on('GET', BASE + '/init.mp4', net.status(404));
    await clock.tick(10);
    expect(onFail.mock.calls[0][0].message).toBe('init.mp4: HTTP 404');
  });
});

describe('stop()', () => {
  it('while waiting for the job: no further requests, no timers, no onFail', async () => {
    start({ status: [{ ...READY, state: 'downloading', buffered_s: 1 }] });
    await clock.tick(700);
    src.stop();
    const n = net.calls.length;
    await clock.tick(400);
    expect(vi.getTimerCount()).toBe(0);
    await clock.tick(60000);
    expect(net.calls.length).toBe(n);
    expect(onFail).not.toHaveBeenCalled();
    expect(onInfo).not.toHaveBeenCalled();
  });

  it('mid-preload: the in-flight segment fetch is aborted, nothing is appended', async () => {
    start({ segs: uniform(10, 2), hold: () => false });
    net.on('GET', BASE + '/s001.m4s', net.hang());
    await clock.tick(10);
    const pending = net.callsTo(BASE + '/s001.m4s')[0];
    expect(pending.signal.aborted).toBe(false);
    src.stop();
    await clock.tick(10);
    expect(pending.signal.aborted).toBe(true);
    expect(sb().appends).toEqual([]);
    expect(onFail).not.toHaveBeenCalled();
    await clock.tick(5000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('while feeding: the loop ends, every request shares the aborted signal', async () => {
    start();
    await clock.tick(1000);
    src.stop();
    const n = net.calls.length;
    pos = 50;   // would need more segments
    await clock.tick(1000);
    expect(net.calls.length).toBe(n);
    expect(vi.getTimerCount()).toBe(0);
    expect(net.calls.every((c) => c.signal && c.signal.aborted)).toBe(true);
    expect(onFail).not.toHaveBeenCalled();
  });
});

describe('the reel-api token (backend security.py)', () => {
  let saved;
  beforeEach(() => {
    saved = cfg.token;
  });
  afterEach(() => {
    cfg.token = saved;
  });

  it('every request — job, status polls, playlist, init, segments, subtitles — carries the token', async () => {
    cfg.token = 'tok-trailer';
    start({ status: [{ ...READY, state: 'downloading', buffered_s: 2 }, { ...READY, subs: [{ lang: 'en' }] }] });
    await clock.tick(3000);
    pos = 40;
    await clock.tick(3000);
    const kinds = new Set(net.calls.map((c) => c.method + ' ' + c.url.slice(BASE.length).replace(/s\d+\.m4s$/, 'seg')));
    expect([...kinds]).toEqual(expect.arrayContaining(['POST ', 'GET ', 'GET /index.m3u8', 'GET /init.mp4', 'GET /seg', 'GET /subs.vtt']));
    expect(net.calls.filter((c) => c.headers.Authorization !== 'MediaBrowser Token="tok-trailer"')).toEqual([]);
  });

  it('signed out: no Authorization header', async () => {
    cfg.token = '';
    start();
    await clock.tick(2000);
    expect(net.calls.length).toBeGreaterThan(3);
    expect(net.calls.every((c) => !('Authorization' in c.headers))).toBe(true);
  });
});
