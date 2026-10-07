/* segfeed.js createSegFeeder(): the phone's MSE buffer manager (watch while
 * downloading through livefeed.js, offline copies through offline.svelte.js).
 *
 * CLAUDE.md (iPhone app → Performance): "MSE feeds (`segfeed.js`) budget bytes
 * (96 MB), not seconds". The module comment and code document the rest:
 * PRELOAD_S (6 s from where playback starts) before the first append; a window
 * ahead of the playhead (aheadS, default 45 s, never below 10 s) sized by a
 * 96 MB byte budget at the measured (or seeded) bitrate; refill once less than
 * 2/3 of the window is left; drop what is more than behindS (5 s) behind; a
 * QuotaExceededError frees what was watched (all but the last second) and what
 * a seek left far ahead, else shrinks the window to 80 % of what is buffered;
 * a growing playlist is re-read every pollMs near its end, else every ~10 s;
 * segments count as buffered by their midpoint; sub-second holes are jumped;
 * ManagedMediaSource's streaming=false stops fetching ahead; stop() ends it all
 * and revokes the object URL.
 *
 * Phone project only (nothing on the TV imports segfeed). Segments here are
 * plain { byteLength, range } objects decoded by the fake MSE's `map`, so a
 * "32 MB" segment costs no memory. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSegFeeder } from '../../src/lib/segfeed.js';
import { installMSE } from '../helpers/mse.js';
import { useClock } from '../helpers/time.js';

const MB = 1024 * 1024;
const BUDGET = 96 * MB;

let mse, clock, pos, media, feeder, onFail, fetched, plCalls, t0;

beforeEach(() => {
  clock = useClock();
  t0 = Date.now();
  pos = 0;
  media = new EventTarget();
  onFail = vi.fn();
  fetched = [];
  plCalls = [];
  feeder = null;
  mse = null;
});

afterEach(() => {
  feeder?.stop();
});

const mapRange = (b) => b.range || null;
const seg4 = (n, from = 0, len = 4) => Array.from({ length: n }, (_, i) => ({ start: from + i * len, end: from + (i + 1) * len, name: 's' + (from / len + i) }));

/* opts: segs | pl (mutable { segs, complete }), complete, bytes (per segment, or fn(seg)),
 * range (fn(seg) → [a, b]), fetchSeg override, plus createSegFeeder options */
function start(o = {}) {
  mse = mse || installMSE({ managed: o.managedMode ?? 'only', map: mapRange, quotaBytes: o.quotaBytes ?? Infinity, ...(o.supported ? { supported: o.supported } : {}) });
  const pl = o.pl || { segs: o.segs || seg4(100), complete: o.complete ?? true };
  const bytes = typeof o.bytes === 'function' ? o.bytes : () => o.bytes ?? 1000;
  const range = o.range || ((s) => [s.start, s.end]);
  feeder = createSegFeeder({
    prepare: o.prepare || (async () => ({ codecs: 'avc1.640028,mp4a.40.2', duration: o.duration ?? 400 })),
    playlist: async () => {
      plCalls.push(Date.now() - t0);
      return { segs: [...pl.segs], complete: pl.complete };
    },
    fetchInit: o.fetchInit || (async () => ({ byteLength: 600, range: null })),
    fetchSeg:
      o.fetchSeg ||
      (async (s) => {
        fetched.push(s.name);
        return { byteLength: bytes(s), range: range(s) };
      }),
    position: () => pos,
    jump: o.jump,
    onFail,
    media: o.noMedia ? undefined : media,
    bitrate: o.bitrate,
    aheadS: o.aheadS,
    behindS: o.behindS,
    preloadS: o.preloadS,
    pollMs: o.pollMs
  });
  return pl;
}

const ms = () => mse.last;
const sb = () => mse.last.sb;
const ranges = () => sb().ranges();
const mediaStarts = () => sb().appends.filter((a) => !a.init).map((a) => a.start);
const quotaHits = () => sb().calls.filter((c) => c[0] === 'quota').length;
const fire = (type) => media.dispatchEvent(new Event(type));
async function run(ms = 0) {
  await clock.tick(ms);
  for (let i = 0; i < 5; i++) await clock.tick(0);
}

describe('start-up', () => {
  it('managed: the object URL is the ManagedMediaSource; duration from prepare(); init goes first', async () => {
    start({ segs: seg4(3), duration: 12 });
    expect(feeder.managed).toBe(true);
    expect(feeder.url).toBe(ms().url);
    await run(10);
    expect(onFail).not.toHaveBeenCalled();
    expect(ms().duration).toBe(12);
    expect(sb().mime).toBe('video/mp4; codecs="avc1.640028,mp4a.40.2"');
    expect(sb().appends[0]).toEqual({ init: true, bytes: 600 });
    expect(mediaStarts()).toEqual([0, 4, 8]);
    expect(ms().readyState).toBe('ended');
  });

  it('plain MediaSource: managed false', () => {
    start({ managedMode: false });
    expect(feeder.managed).toBe(false);
  });

  it('a duration of 0 (unknown) is not set on the MediaSource', async () => {
    start({ segs: seg4(3), duration: 0 });
    await run(10);
    expect(ms().calls.some((c) => c[0] === 'duration')).toBe(false);
  });

  it('waits for 6 s of a growing playlist before fetching the header; polls every pollMs meanwhile', async () => {
    const pl = start({ segs: seg4(1), complete: false });
    await run(2500);
    expect(sb()).toBeTruthy(); // the SourceBuffer exists, but nothing is appended
    expect(sb().appends).toEqual([]);
    expect(plCalls).toEqual([0, 1000, 2000]);
    pl.segs = seg4(2); // 8 s now
    await run(1000);
    expect(sb().appends[0].init).toBe(true);
    expect(mediaStarts()).toEqual([0, 4]);
  });

  it('the 6 s are counted from where playback starts (a resume point)', async () => {
    pos = 100;
    const pl = start({ segs: seg4(26), complete: false }); // 0–104: only 100–104 lies ahead
    await run(3000);
    expect(sb().appends).toEqual([]);
    pl.segs = seg4(27); // 0–108
    await run(1000);
    expect(mediaStarts()[0]).toBe(100); // fetching starts at the landing segment
  });

  it('a complete playlist shorter than the preload starts at once', async () => {
    start({ segs: [{ start: 0, end: 2, name: 'only' }] });
    await run(0);
    expect(mediaStarts()).toEqual([0]);
    expect(ms().readyState).toBe('ended');
  });

  it('preloadS is configurable', async () => {
    const pl = start({ segs: seg4(2), complete: false, preloadS: 10 });
    await run(3000);
    expect(sb().appends).toEqual([]);
    pl.segs = seg4(3);
    await run(1000);
    expect(mediaStarts()).toEqual([0, 4, 8]);
  });
});

describe('failures', () => {
  it('codecs the MediaSource cannot take → onFail with code unsupported, nothing appended', async () => {
    start({ supported: (m) => !m.includes('av01'), prepare: async () => ({ codecs: 'av01.0.12M.10', duration: 60 }) });
    await run(10);
    expect(onFail).toHaveBeenCalledTimes(1);
    const e = onFail.mock.calls[0][0];
    expect(e.code).toBe('unsupported');
    expect(e.message).toContain('av01.0.12M.10');
    expect(ms().sourceBuffers).toEqual([]);
  });

  it('no init segment → "the stream has no header"', async () => {
    start({ fetchInit: async () => null });
    await run(10);
    expect(onFail.mock.calls[0][0].message).toBe('the stream has no header');
  });

  it('a segment the pipeline rejects → onFail, the loop ends', async () => {
    start({
      fetchSeg: async (s) => {
        fetched.push(s.name);
        if (s.name === 's2') sb().failNext();
        return { byteLength: 1000, range: [s.start, s.end] };
      }
    });
    await run(10);
    expect(onFail.mock.calls[0][0].message).toBe('the media pipeline rejected a segment');
    expect(fetched).toEqual(['s0', 's1', 's2']);
    await run(30000);
    expect(fetched).toEqual(['s0', 's1', 's2']);
  });

  it('an AbortError is not reported', async () => {
    start({ fetchSeg: async () => { throw new DOMException('aborted', 'AbortError'); } });
    await run(10);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('a segment that is not there (yet) is asked for again after pollMs', async () => {
    let n = 0;
    start({
      fetchSeg: async (s) => {
        fetched.push([s.name, Date.now() - t0]);
        if (s.name === 's1' && n++ < 2) return null;
        return { byteLength: 1000, range: [s.start, s.end] };
      },
      aheadS: 12
    });
    await run(5000);
    expect(fetched.slice(0, 5)).toEqual([['s0', 0], ['s1', 0], ['s1', 1000], ['s1', 2000], ['s2', 2000]]);
  });
});

describe('the window ahead', () => {
  it('fills 45 s ahead by default, then sleeps until less than 2/3 of it is left', async () => {
    start();
    await run(10);
    expect(mediaStarts()).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44]); // to 48: ≥ 45 s
    pos = 17; // 31 s left: above 2/3 (30 s)
    fire('waiting');
    await run(10);
    expect(mediaStarts()).toHaveLength(12);
    pos = 19; // 29 s left
    fire('waiting');
    await run(10);
    expect(mediaStarts().slice(12)).toEqual([48, 52, 56, 60]); // to 64: 45 s ahead of 19
  });

  it('wakes up on its own when the buffer drains (no event needed)', async () => {
    start();
    await run(10);
    pos = 20; // 28 s left
    await run(5000); // the loop's sleep is capped at 5 s
    expect(mediaStarts()).toContain(48);
  });

  it('drops what lies more than 5 s behind the playhead before appending', async () => {
    start();
    await run(10);
    expect(sb().removes).toEqual([]);
    pos = 19;
    fire('waiting');
    await run(10);
    // 14 falls in 12–16: the cut lands 0.25 s below its start (V-F12 + keyframe
    // drift margin) and 12–16 stays whole
    expect(sb().removes).toEqual([[0, 11.75]]);
    expect(ranges()).toEqual([[12, 64]]);
  });

  it('behindS is configurable; nothing is dropped in the first second', async () => {
    start({ behindS: 10, aheadS: 12 });
    await run(10);
    pos = 5; // cut at -5: nothing
    fire('waiting');
    await run(10);
    expect(sb().removes).toEqual([]);
    pos = 15;
    fire('waiting');
    await run(10);
    expect(sb().removes).toEqual([[0, 3.75]]); // 5 falls in 4–8: cut 0.25 s below its start (V-F12)
  });

  it('aheadS sets the window; it never goes below 10 s however high the bitrate', async () => {
    start({ aheadS: 20 });
    await run(10);
    expect(mediaStarts()).toEqual([0, 4, 8, 12, 16]);
  });

  it('an aheadS below 10 s is honoured as given', async () => {
    start({ aheadS: 8 });
    await run(10);
    expect(mediaStarts()).toEqual([0, 4]);
  });
});

describe('the 96 MB byte budget', () => {
  // 64 Mbit/s: 4 s segments of 32 MB. 96 MB hold ~12.6 s of it.
  const RATE = 64e6;
  const segBytes = (RATE / 8) * 4;

  it('a measured high rate shrinks the window to what 96 MB hold', async () => {
    start({ bytes: segBytes });
    await run(10);
    // first segment at the 45 s default (no measurement yet), then ~12.6 s
    expect(mediaStarts()).toEqual([0, 4, 8, 12]);
    const window = (BUDGET * 8) / RATE;
    expect(window).toBeGreaterThan(12);
    expect(window).toBeLessThan(13);
  });

  it('the source bitrate sizes the window before anything was measured', async () => {
    start({ bytes: 1000, bitrate: RATE }); // measured rate (tiny) takes over after the first segment
    await run(10);
    expect(mediaStarts()).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44]);
    feeder.stop();
    mse = null;
    fetched = [];
    // seeded high rate, and each segment really is that big: the window is never 45 s
    start({ bytes: segBytes, bitrate: RATE, aheadS: 45 });
    await run(10);
    expect(mediaStarts()).toEqual([0, 4, 8, 12]);
  });

  it('refills at 2/3 of the byte-sized window', async () => {
    start({ bytes: segBytes });
    await run(10); // 0–16, window ≈ 12.58 s, refill below ≈ 8.39 s
    pos = 7.5; // 8.5 s left
    fire('waiting');
    await run(10);
    expect(mediaStarts()).toHaveLength(4);
    pos = 7.7; // 8.3 s left
    fire('waiting');
    await run(10);
    expect(mediaStarts().slice(4)).toEqual([16, 20]); // 7.7 + 12.58 = 20.3 → to 20 is short, to 24
  });

  it('a very high rate still keeps 10 s ahead', async () => {
    start({ bytes: (200e6 / 8) * 4 }); // 200 Mbit/s: 96 MB ≈ 4 s
    await run(10);
    expect(mediaStarts()).toEqual([0, 4, 8]); // to 12: ≥ 10 s
  });
});

describe('QuotaExceededError', () => {
  it('nothing to free: the window shrinks to 80 % of what is buffered; once the playhead moves, the watched part is dropped and the append goes in', async () => {
    start({ quotaBytes: 10000 }); // ten 1000-byte segments
    await run(10);
    expect(mediaStarts()).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36]);
    expect(quotaHits()).toBe(1); // s10 (40–44) did not fit
    expect(fetched.at(-1)).toBe('s10');
    await run(5000); // retried after the capped 5 s nap: still full, nothing behind to drop
    expect(quotaHits()).toBe(2);
    expect(sb().removes).toEqual([]);
    pos = 10;
    await run(5000);
    // all but the last second, down to the start of the segment that falls in
    // (9 is in 8–12, which stays whole — V-F12; the cut sits 0.25 s below 8):
    // playhead covered
    expect(sb().removes).toEqual([[0, 7.75]]);
    expect(ranges()).toEqual([[8, 44]]);
    expect(fetched.filter((n) => n === 's10')).toHaveLength(1); // the held segment, not a refetch
    // the playhead's own segment (8–12) is neither cut nor fetched again (V-F13)
    expect(sb().removes.every(([a, b]) => b <= 8 || a >= 12)).toBe(true);
    expect(fetched.filter((n) => n === 's2')).toHaveLength(1);
    // window is now 80 % of the 40 s that were buffered = 32 s: 34 s ahead is enough
    const past = (s) => mediaStarts().filter((x) => x >= s);
    await run(5000);
    expect(past(40)).toEqual([40]);
    pos = 22; // 22 s left: not below 2/3 × 32 ≈ 21.3
    fire('waiting');
    await run(10);
    expect(past(40)).toEqual([40]);
    pos = 23; // 21 s left
    fire('waiting');
    await run(10);
    expect(past(40)).toEqual([40, 44, 48, 52]); // to 56: 33 ≥ 32 s ahead
    expect(quotaHits()).toBe(3);
  });

  it('what a seek back left far ahead is freed first', async () => {
    start({ quotaBytes: 20000 });
    await run(10); // 0–48 (12 segments)
    pos = 200;
    fire('seeking');
    await run(10); // 0..195 dropped behind, 200–248 in
    pos = 3; // seek back: 0–3 is gone, refetch from s0
    fire('seeking');
    await run(10);
    const removes = sb().removes;
    // the region after 3 + 45 s (what the forward seek left) is removed to make room
    expect(removes.some(([a, b]) => a >= 48 && b === 248)).toBe(true);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('other append errors are not retried', async () => {
    start({
      fetchSeg: async (s) => {
        if (s.name === 's1') sb().appendBuffer = () => { throw new DOMException('gone', 'InvalidStateError'); };
        return { byteLength: 1000, range: [s.start, s.end] };
      }
    });
    await run(10);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0].name).toBe('InvalidStateError');
  });
});

describe('a growing playlist', () => {
  it('near its known end it is re-read every pollMs, and new segments go in', async () => {
    const pl = start({ segs: seg4(3), complete: false });
    await run(10);
    expect(mediaStarts()).toEqual([0, 4, 8]);
    plCalls.length = 0;
    await run(3000);
    expect(plCalls.length).toBeGreaterThanOrEqual(3);
    expect(plCalls.length).toBeLessThanOrEqual(4);
    pl.segs = seg4(5);
    await run(1000);
    expect(mediaStarts()).toEqual([0, 4, 8, 12, 16]);
    expect(ms().readyState).toBe('open'); // not complete: never ended
  });

  it('far from its known end it is re-read only every ~10 s', async () => {
    start({ segs: seg4(100), complete: false });
    await run(10);
    plCalls.length = 0;
    await run(30000);
    expect(plCalls.length).toBeGreaterThanOrEqual(2);
    expect(plCalls.length).toBeLessThanOrEqual(3);
  });

  it('once it gains #EXT-X-ENDLIST and everything is in, the stream is ended', async () => {
    const pl = start({ segs: seg4(3), complete: false });
    await run(10);
    expect(ms().readyState).toBe('open');
    pl.segs = seg4(4);
    pl.complete = true;
    await run(1000);
    expect(mediaStarts()).toEqual([0, 4, 8, 12]);
    expect(ms().readyState).toBe('ended');
    expect(ms().ended).toBe(1);
  });

  it('a complete playlist is not ended while segments after the playhead are missing', async () => {
    start(); // 400 s, window 45 s
    await run(10);
    expect(ms().readyState).toBe('open');
  });
});

describe('seeking and what counts as buffered', () => {
  it('a seek into an unbuffered stretch fetches from the landing segment', async () => {
    start();
    await run(10);
    fetched.length = 0;
    pos = 201;
    fire('seeking');
    await run(10);
    expect(fetched[0]).toBe('s50'); // 200–204 holds 201
    expect(fetched).toEqual(['s50', 's51', 's52', 's53', 's54', 's55', 's56', 's57', 's58', 's59', 's60', 's61']);
    expect(sb().removes).toEqual([[0, 195.75]]); // 0.25 s below 196, the start of what 201 − 5 falls in
  });

  it('a segment counts as buffered by its midpoint: a range ending short of the segment end is not refetched', async () => {
    start({ range: (s) => [s.start, s.end - 0.2] }); // 0–3.8, 4–7.8, …
    await run(10);
    await run(20000);
    const counts = {};
    for (const n of fetched) counts[n] = (counts[n] || 0) + 1;
    expect(Object.values(counts).every((c) => c === 1)).toBe(true);
    expect(fetched.slice(0, 12)).toEqual(seg4(12).map((s) => s.name));
  });

  it('a segment the UA evicted (ManagedMediaSource) is fetched again', async () => {
    start({ aheadS: 12 });
    await run(10);
    expect(fetched).toEqual(['s0', 's1', 's2']);
    sb().evict(0, 8);
    fire('waiting');
    await run(10);
    expect(fetched).toEqual(['s0', 's1', 's2', 's0', 's1']);
  });

  it('gap jumping: at the end of a range with a hole < 1 s before the next, jump() moves past it', async () => {
    const jump = vi.fn((t) => { pos = t; });
    start({ jump, range: (s) => [s.start, s.end - 0.5], aheadS: 12 }); // 0–3.5, 4–7.5, 8–11.5
    await run(10);
    pos = 3.3; // within 0.25 s of the end of 0–3.5
    fire('waiting');
    await run(10);
    expect(jump).toHaveBeenCalledWith(4.05);
  });

  it('no jump for a hole of 1 s or more, nor away from a range end', async () => {
    const jump = vi.fn();
    start({ jump, range: (s) => [s.start, s.end - 1], aheadS: 12 }); // holes of exactly 1 s
    await run(10);
    pos = 2.9;
    fire('waiting');
    await run(10);
    feeder.stop();
    mse = null;
    start({ jump, range: (s) => [s.start, s.end - 0.5], aheadS: 12 });
    await run(10);
    pos = 2; // mid-range
    fire('waiting');
    await run(10);
    expect(jump).not.toHaveBeenCalled();
  });
});

describe('ManagedMediaSource streaming', () => {
  it('with streaming off it only fetches the preload, then waits for startstreaming', async () => {
    start();
    ms().setStreaming(false);
    await run(10);
    expect(fetched).toEqual(['s0', 's1']); // 8 s ≥ the 6 s preload
    await run(20000);
    expect(fetched).toEqual(['s0', 's1']);
    ms().setStreaming(true);
    await run(10);
    expect(fetched).toHaveLength(12);
  });

  it('streaming off does not hold back a stalled playhead (less than the preload buffered)', async () => {
    start({ aheadS: 45 });
    await run(10);
    ms().setStreaming(false);
    pos = 46; // 2 s left
    fire('waiting');
    await run(10);
    expect(fetched).toContain('s12');
  });
});

describe('stop()', () => {
  it('revokes the object URL, ends the loop and ignores a fetch that answers late', async () => {
    let release;
    start({
      fetchSeg: (s) => {
        fetched.push(s.name);
        if (s.name === 's2') return new Promise((r) => (release = () => r({ byteLength: 1000, range: [s.start, s.end] })));
        return Promise.resolve({ byteLength: 1000, range: [s.start, s.end] });
      }
    });
    await run(10);
    expect(fetched).toEqual(['s0', 's1', 's2']);
    feeder.stop();
    expect(mse.revoked).toEqual([feeder.url]);
    release();
    await run(30000);
    expect(mediaStarts()).toEqual([0, 4]);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('a feeder sleeping in its loop stops at once; later media events do nothing', async () => {
    const pl = start({ segs: seg4(3), complete: false });
    await run(10);
    feeder.stop();
    plCalls.length = 0;
    pl.segs = seg4(10);
    fire('seeking');
    fire('waiting');
    await run(30000);
    expect(plCalls).toEqual([]);
    expect(mediaStarts()).toEqual([0, 4, 8]);
    expect(clock.pending()).toBeLessThanOrEqual(1); // at most a stray abandoned nap timer
  });

  it('stopped before the source opened: nothing runs', async () => {
    start();
    feeder.stop();
    await run(1000);
    expect(ms().sourceBuffers).toEqual([]);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('works without a media element (offline copies poll instead)', async () => {
    start({ noMedia: true, aheadS: 12 });
    await run(10);
    expect(mediaStarts()).toEqual([0, 4, 8]);
    pos = 6;
    await run(5000);
    expect(mediaStarts()).toContain(12);
  });
});
