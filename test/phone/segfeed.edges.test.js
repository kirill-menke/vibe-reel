/* segfeed.js createSegFeeder(): edges found by mutation testing (hardening
 * round, Stryker on segfeed.js). Each test pins behaviour the module documents
 * that segfeed.feeder.test.js left loose:
 *   - stop() ends it all: no timer left, the session-long <video> unhooked,
 *     nothing appended or fetched by work that was in flight;
 *   - the loop sleeps until the buffer drains to the refill mark ("it used to
 *     wake every 100–330 ms for a whole film to find there was nothing to do");
 *   - op() leaves no listeners on the SourceBuffer (one per segment would pile
 *     up over a film and every 'updateend' would call all of them);
 *   - the source's own bitrate sizes the window before a segment was measured;
 *   - QuotaExceededError: what is buffered is measured from the playhead, the
 *     retry waits until the playhead has eaten into the buffer;
 *   - endOfStream only when everything from the playhead to the end is in, and
 *     a re-opened source (an append after 'ended') does not start a second feeder;
 *   - gap jumping never jumps backwards, nor reads past the last range.
 *
 * Phone project only (nothing on the TV imports segfeed). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSegFeeder } from '../../src/lib/segfeed.js';
import { installMSE, keyframesEvery } from '../helpers/mse.js';
import { useClock } from '../helpers/time.js';
import { trackListeners } from '../helpers/listeners.js';


let mse, clock, pos, media, feeder, onFail, fetched, plCalls, t0, posCalls;

beforeEach(() => {
  clock = useClock();
  t0 = Date.now();
  pos = 0;
  posCalls = [];
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

/* opts: segs | pl (mutable { segs, complete }), complete, bytes, range, fetchSeg /
 * fetchInit / playlist overrides, position, plus createSegFeeder options */
function start(o = {}) {
  mse = mse || installMSE({ managed: o.managedMode ?? 'only', map: mapRange, quotaBytes: o.quotaBytes ?? Infinity, ...(o.supported ? { supported: o.supported } : {}) });
  const pl = o.pl || { segs: o.segs || seg4(100), complete: o.complete ?? true };
  const bytes = typeof o.bytes === 'function' ? o.bytes : () => o.bytes ?? 1000;
  const range = o.range || ((s) => [s.start, s.end]);
  feeder = createSegFeeder({
    prepare: o.prepare || (async () => ({ codecs: 'avc1.640028,mp4a.40.2', duration: o.duration ?? 400 })),
    playlist:
      o.playlist ||
      (async () => {
        plCalls.push(Date.now() - t0);
        return { segs: [...pl.segs], complete: pl.complete };
      }),
    fetchInit: o.fetchInit || (async () => ({ byteLength: 600, range: null })),
    fetchSeg:
      o.fetchSeg ||
      (async (s) => {
        fetched.push(s.name);
        return { byteLength: bytes(s), range: range(s) };
      }),
    position: () => {
      posCalls.push(Date.now() - t0);
      return o.position ? o.position() : pos;
    },
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

describe('stop() ends it all', () => {
  it('no timer is left behind, and the <video> listeners are removed', async () => {
    const add = vi.spyOn(media, 'addEventListener');
    const remove = vi.spyOn(media, 'removeEventListener');
    start({ segs: seg4(3), complete: false });
    await run(10); // sleeping in the loop: a growing playlist, nothing new
    expect(clock.pending()).toBeGreaterThan(0);
    const hooked = add.mock.calls.map((c) => [c[0], c[1]]);
    expect(hooked.map((c) => c[0]).sort()).toEqual(['seeking', 'waiting']);
    feeder.stop();
    await run(0);
    // the sleeping loop was woken, saw `dead` and ended: no nap timer remains
    expect(clock.pending()).toBe(0);
    // the <video> lives for the whole session: every feeder must unhook itself
    expect(remove.mock.calls.map((c) => [c[0], c[1]])).toEqual(expect.arrayContaining(hooked));
  });

  it('stopped while waiting for the preload: the playlist is not read again', async () => {
    start({ segs: seg4(1), complete: false });
    await run(2500);
    expect(plCalls).toEqual([0, 1000, 2000]);
    feeder.stop();
    await run(10000);
    // the woken nap sees `dead` and ends: no request after stop() (V-F11)
    expect(plCalls).toEqual([0, 1000, 2000]);
    expect(sb().appends).toEqual([]);
  });

  it('stopped while the header is being fetched: nothing is appended', async () => {
    let release;
    start({ fetchInit: () => new Promise((r) => (release = () => r({ byteLength: 600, range: null }))) });
    await run(10);
    feeder.stop();
    release();
    await run(10000);
    expect(sb().appends).toEqual([]);
    expect(fetched).toEqual([]);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('stopped while a playlist re-read is in flight: no segment is fetched after it', async () => {
    const pl = { segs: seg4(3), complete: false };
    let hold = null;
    start({
      pl,
      playlist: () => {
        plCalls.push(Date.now() - t0);
        const answer = () => ({ segs: [...pl.segs], complete: pl.complete });
        if (plCalls.length < 3) return Promise.resolve(answer());
        return new Promise((r) => (hold = () => r(answer())));
      }
    });
    await run(10);
    expect(fetched).toEqual(['s0', 's1', 's2']);
    await run(3000);
    expect(hold).toBeTypeOf('function'); // the re-read near the known end is pending
    pl.segs = seg4(6); // it will answer with three new segments…
    feeder.stop();
    hold();
    await run(5000);
    expect(fetched).toEqual(['s0', 's1', 's2']); // …that are never fetched
  });

  it('stopped during the QuotaExceededError back-off: the append is not tried again', async () => {
    start({ quotaBytes: 2000 }); // two 1000-byte segments
    await run(10);
    expect(quotaHits()).toBe(1);
    feeder.stop();
    await run(30000);
    expect(quotaHits()).toBe(1);
    expect(mediaStarts()).toEqual([0, 4]);
  });
});

describe('the loop sleeps until there is work', () => {
  it('a full window with the playhead paused: the loop wakes at most every 5 s', async () => {
    start();
    await run(10); // 0–48 in
    posCalls.length = 0;
    await run(20000);
    // ~one look per 5 s nap; polling every 250 ms would be ~80
    expect(posCalls.length).toBeGreaterThanOrEqual(3);
    expect(posCalls.length).toBeLessThanOrEqual(8);
    expect(mediaStarts()).toHaveLength(12);
  });

  it('while playing, the refill starts as the buffer reaches the 2/3 mark, not up to 5 s late', async () => {
    let playFrom = null;
    start({ position: () => (playFrom == null ? 14 : 14 + (Date.now() - playFrom) / 1000) });
    await run(10); // 14 → 0–60 in (to the first segment end ≥ 14 + 45)
    expect(mediaStarts().at(-1)).toBe(56);
    fetched.length = 0;
    playFrom = Date.now();
    fire('waiting'); // re-plan from "playing at 14 s, 46 s ahead"
    await run(10);
    // 46 s ahead drains to the 30 s mark at 16 s of playback (nap capped at 5 s, so
    // the loop checks at 5, 10, 15 s, then sleeps exactly the remaining second)
    await run(15500);
    expect(fetched).toEqual([]);
    await run(1000);
    expect(fetched[0]).toBe('s15');
  });
});

describe('the SourceBuffer keeps no listeners between operations', () => {
  it('after a run of appends (and a QuotaExceededError retry) none are left', async () => {
    let live = null;
    start({
      quotaBytes: 10000,
      fetchInit: async () => {
        live = trackListeners(sb());
        return { byteLength: 600, range: null };
      }
    });
    await run(10);
    expect(mediaStarts().length).toBeGreaterThanOrEqual(10);
    expect(quotaHits()).toBe(1);
    pos = 12; // frees what was watched: the held append goes in
    fire('waiting');
    await run(10);
    expect(onFail).not.toHaveBeenCalled();
    expect(live()).toEqual([]);
  });
});

describe('the source bitrate before anything was measured', () => {
  // 64 Mbit/s: 96 MB hold ~12.6 s. The first segment is not there yet, so the
  // window is still sized by `bitrate` when the loop next decides whether the
  // playlist must be re-read (only when the window reaches past its known end).
  const RATE = 64e6;
  function notYet() {
    let n = 0;
    return async (s) => {
      fetched.push(s.name);
      if (s.name === 's0' && n++ === 0) return null;
      return { byteLength: (RATE / 8) * 4, range: [s.start, s.end] };
    };
  }

  it('a seeded high rate: a playlist 32 s long is far beyond the window — not re-read every pollMs', async () => {
    start({ segs: seg4(8), complete: false, bitrate: RATE, fetchSeg: notYet() });
    await run(10);
    expect(plCalls).toEqual([0]);
    await run(1000); // the retry of s0: window 12.6 s < 32 s known
    expect(plCalls).toEqual([0]);
  });

  it('no bitrate: the 45 s default window reaches past 32 s — re-read after pollMs', async () => {
    start({ segs: seg4(8), complete: false, fetchSeg: notYet() });
    await run(10);
    await run(1000);
    expect(plCalls).toEqual([0, 1000]);
  });
});

describe('QuotaExceededError details', () => {
  it('the buffer is measured from the playhead (a resume at 100 s)', async () => {
    pos = 100;
    start({ quotaBytes: 10000 }); // ten 1000-byte segments: 100–140
    await run(10);
    expect(mediaStarts()).toEqual([100, 104, 108, 112, 116, 120, 124, 128, 132, 136]);
    expect(quotaHits()).toBe(1);
    pos = 110;
    await run(5000); // all but the last second dropped, the held 140–144 goes in
    // (the cut at 109 lands 0.25 s below the start of 108–112, which stays whole —
    // V-F12; it used to take the rest of 108–112 with it and refetch it, F13)
    expect(sb().removes).toEqual([[0, 107.75]]);
    expect(ranges()).toEqual([[108, 144]]);
    // the playhead's own segment (108–112) is neither cut nor fetched again (V-F13)
    expect(sb().removes.every(([, b]) => b <= 108)).toBe(true);
    expect(fetched.filter((n) => n === 's27')).toHaveLength(1);
    expect(mediaStarts().filter((x) => x === 108)).toHaveLength(1);
    const past = (s) => mediaStarts().filter((x) => x >= s);
    expect(past(140)).toEqual([140]);
    // the window is now 80 % of the 40 s that were buffered ahead = 32 s
    await run(5000);
    expect(past(140)).toEqual([140]);
    expect(quotaHits()).toBe(2);
    pos = 122; // 22 s left: not below 2/3 × 32 ≈ 21.3
    fire('waiting');
    await run(10);
    expect(past(140)).toEqual([140]);
  });

  it('what a seek back left far ahead is freed and the append retried at once, with the full window', async () => {
    start({ quotaBytes: 20000 });
    await run(10); // 0–48
    pos = 200;
    fire('seeking');
    await run(10); // 0–48 dropped behind, 200–248 in
    pos = 3; // seek back: 200–248 is now far ahead and fills the quota
    const removesBefore = sb().removes.length;
    const fetchedBefore = fetched.length;
    fire('seeking');
    await run(10);
    // the playhead's segment (0–4) goes in once and is not cut again (V-F13)
    expect(fetched.slice(fetchedBefore).filter((n) => n === 's0')).toHaveLength(1);
    expect(sb().removes.slice(removesBefore).every(([a, b]) => b <= 0 || a >= 4)).toBe(true);
    // no back-off, no shrunken window: up to 48 is back in straight away, the
    // playhead covered (the quota path's cut at 2 lands on 0, the start of 0–4,
    // so nothing behind is cut — V-F12)
    expect(ranges()[0]).toEqual([0, 48]);
    expect(sb().removes.some(([a, b]) => a >= 48 && b === 248)).toBe(true);
  });

  it('nothing freeable: the retry waits until the buffer would have drained to the refill mark', async () => {
    start({ quotaBytes: 2000 }); // 0–8 fits, 8–12 does not
    await run(10);
    expect(quotaHits()).toBe(1);
    // 8 s ahead → window 80 % = 6.4 s → retry when 8 − 2/3 × 6.4 ≈ 3.73 s have played
    await run(3600);
    expect(quotaHits()).toBe(1);
    await run(200);
    expect(quotaHits()).toBe(2);
  });

  it('a QuotaExceededError with nothing buffered at all is not retried in a busy loop', async () => {
    start({
      fetchInit: async () => {
        sb().quotaNext();
        return { byteLength: 600, range: null };
      }
    });
    await run(10);
    expect(quotaHits()).toBe(1);
    expect(sb().appends).toEqual([]); // waits (≥ 1 s) instead of hammering the append
    await run(1000);
    expect(sb().appends[0]).toEqual({ init: true, bytes: 600 });
    expect(onFail).not.toHaveBeenCalled();
  });
});

describe('the preload, the window and the playlist', () => {
  it('exactly 6 s of a growing playlist is enough to start', async () => {
    start({ segs: seg4(3, 0, 2), complete: false }); // 0–6 in 2 s segments
    await run(10);
    expect(mediaStarts()).toEqual([0, 2, 4]);
  });

  it('nothing is dropped behind while the cut point is within the first second', async () => {
    start({ aheadS: 12 });
    await run(10);
    pos = 5.8; // 5 s behind = 0.8
    fire('waiting');
    await run(10);
    expect(mediaStarts().length).toBeGreaterThan(3); // a refill went in…
    expect(sb().removes).toEqual([]); // …without a trim
    pos = 6.5;
    fire('waiting');
    await run(10);
    expect(sb().removes).toEqual([]); // nothing to append: no trim either
    pos = 12.5; // 7.5 s left of the 12 s window: refill, trimming to 5 s behind
    fire('waiting');
    await run(10);
    // 7.5 falls in 4–8: the cut lands 0.25 s below its start (V-F12)
    expect(sb().removes).toEqual([[0, 3.75]]);
  });

  it('a complete playlist is read once and never again', async () => {
    start({ segs: seg4(30) });
    await run(10);
    for (const p of [20, 40, 60, 80, 100]) {
      pos = p;
      fire('waiting');
      await run(3000);
    }
    expect(plCalls).toEqual([0]);
    expect(ms().readyState).toBe('ended');
  });

  it('a growing playlist whose known end lies inside the window is re-read at every wake-up, not every ~10 s', async () => {
    // 60 s listed, 0–48 buffered: the window (to 48 + 45) wants what isn't listed
    // yet. The full window sleeps in 5 s naps; each wake-up re-reads the playlist.
    start({ segs: seg4(15), complete: false });
    await run(10);
    expect(mediaStarts().at(-1)).toBe(44);
    plCalls.length = 0;
    await run(15000);
    expect(plCalls).toHaveLength(3);
  });
});

describe('endOfStream', () => {
  it('played to the end with the start long dropped: the stream is still ended', async () => {
    start({ segs: seg4(20) }); // 0–80
    await run(10);
    for (const p of [20, 40, 60, 70]) {
      pos = p;
      fire('waiting');
      await run(10);
    }
    expect(ranges()[0][0]).toBeGreaterThan(0); // the start was dropped behind
    expect(ms().readyState).toBe('ended');
    expect(ms().ended).toBe(1);
  });

  it('once ended, later wake-ups neither end it again nor fail', async () => {
    start({ segs: seg4(3) });
    await run(10);
    expect(ms().ended).toBe(1);
    for (let i = 0; i < 4; i++) {
      fire('waiting');
      await run(6000);
    }
    expect(ms().ended).toBe(1);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('a seek back leaving a hole before the end: not ended again until the hole is filled; one feeder only', async () => {
    start({ segs: seg4(25) }); // 0–100
    await run(10);
    pos = 60;
    fire('seeking');
    await run(10);
    expect(ms().ended).toBe(1); // 60–100 all in
    pos = 10;
    fire('seeking');
    await run(10);
    // 8–56 refilled (re-opening the source), 56–60 missing, 60–100 still there
    expect(ranges()).toEqual([[8, 56], [60, 100]]);
    expect(ms().readyState).toBe('open');
    expect(ms().ended).toBe(1);
    // the re-open fired 'sourceopen' again: still exactly one SourceBuffer
    expect(ms().sourceBuffers).toHaveLength(1);
    expect(onFail).not.toHaveBeenCalled();
    pos = 30; // the window now reaches the hole
    fire('waiting');
    await run(10);
    // (the trim at 25 lands on the start of 24–28, which stays — V-F12)
    expect(ranges()).toEqual([[24, 100]]);
    expect(ms().ended).toBe(2);
  });
});

describe('gap jumping edges', () => {
  it('never jumps backwards from a later range', async () => {
    const jump = vi.fn((t) => {
      pos = t;
    });
    start({ jump, range: (s) => [s.start, s.end - 0.5], aheadS: 12 }); // 0–3.5, 4–7.5, 8–11.5
    await run(10);
    pos = 6; // inside 4–7.5
    fire('waiting');
    await run(10);
    expect(jump).not.toHaveBeenCalled();
  });

  it('the playhead at the end of the last range reads no range past the last one', async () => {
    const jump = vi.fn();
    start({ jump, segs: seg4(3) }); // 0–12, complete, all in
    await run(10);
    pos = 11.9;
    fire('waiting');
    await run(10);
    expect(onFail).not.toHaveBeenCalled();
    expect(jump).not.toHaveBeenCalled();
  });

  it('without a jump() callback a sub-second hole is left alone, without failing', async () => {
    start({ range: (s) => [s.start, s.end - 0.5], aheadS: 12 });
    await run(10);
    pos = 3.4;
    fire('waiting');
    await run(10);
    expect(onFail).not.toHaveBeenCalled();
  });
});

// F12 (findings.md): the trim behind the playhead used to cut at playhead − behindS,
// inside a segment. Under the MSE coded-frame-removal rule what follows the cut up
// to the next keyframe goes with it, so with a keyframe between the cut and the
// segment's midpoint a 1 s hole stayed behind that the feeder never refetched
// (V-F12). The cut is now snapped down to the start of the segment it falls in:
// a segment either stays whole or goes whole (and is fetched again).
describe('F12: the trim behind the playhead cuts on a segment boundary', () => {
  it('one keyframe per segment: the segment the cut falls in stays whole, and a seek back leaves no hole', async () => {
    const jump = vi.fn((t) => {
      pos = t;
    });
    start({ segs: seg4(30), jump }); // 0–120
    await run(10); // 0–48
    pos = 26; // refill: trims 5 s behind = 21, inside 20–24 → cut 0.25 s below 20
    fire('waiting');
    await run(10);
    expect(sb().removes[0]).toEqual([0, 19.75]);
    expect(ranges()[0][0]).toBe(20); // all of 20–24 is left
    pos = 2; // seek back
    fire('seeking');
    await run(10);
    expect(fetched.filter((n) => n === 's5')).toHaveLength(1); // never left the buffer
    expect(ranges()).toHaveLength(1);
    expect(ranges()[0][0]).toBe(0);
    pos = 19.9; // play across the old cut: nothing to jump
    fire('waiting');
    await run(3000);
    expect(jump).not.toHaveBeenCalled();
    expect(ranges().some(([a, b]) => a <= 19.9 && b >= 24)).toBe(true);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('a keyframe every second (V-F12): the cut segment is kept whole, so after a seek back there is no 1 s hole', async () => {
    const jump = vi.fn((t) => {
      pos = t;
    });
    start({ segs: seg4(30), jump }); // 0–120
    mse.options.keyframes = keyframesEvery(1);
    await run(10); // 0–48
    pos = 26; // refill: trims 5 s behind = 21, a keyframe inside 20–24 → cut 0.25 s below 20
    fire('waiting');
    await run(10);
    expect(sb().removes.every(([, e]) => (e + 0.25) % 4 === 0)).toBe(true);
    expect(ranges()[0][0]).toBe(20);
    pos = 2; // seek back
    fire('seeking');
    await run(10);
    // one range from 0 through the cut segment (it was [0, 20] + [21, ..]: a 1 s
    // hole too wide to be gap-jumped, never refetched)
    expect(ranges().some(([a, b]) => a === 0 && b >= 24)).toBe(true);
    expect(fetched.filter((n) => n === 's5')).toHaveLength(1); // never left the buffer
    pos = 19.9; // play across the old cut
    fire('waiting');
    await run(3000);
    expect(jump).not.toHaveBeenCalled();
    expect(ranges().some(([a, b]) => a <= 19.9 && b >= 24)).toBe(true);
    expect(onFail).not.toHaveBeenCalled();
  });
});

// A playlist segment's start is a running sum of rounded #EXTINF values; the
// media's own first keyframe can sit a little before it (negative drift) or after
// it (positive). A cut exactly on the playlist start removes a keyframe that sits
// before it, and with it the GOP it opens: the V-F12 hole again, or (quota path)
// the segment under the playhead. The cut now stays CUT_MARGIN_S (0.25 s) below
// the segment start, bounded to a quarter of the previous segment.
describe('the trim cut vs the real keyframe (playlist drift)', () => {
  const drift = (d) => (s) => [Math.max(0, s.start + d), s.end + d];

  it('keyframes 30 ms before the playlist starts, a keyframe every second: a seek back leaves no hole', async () => {
    const jump = vi.fn((t) => {
      pos = t;
    });
    start({ segs: seg4(30), jump, range: drift(-0.03) }); // s5 really 19.97–23.97
    mse.options.keyframes = keyframesEvery(1);
    await run(10);
    pos = 26; // trims 5 s behind = 21, inside s5
    fire('waiting');
    await run(10);
    // nothing at or after s5's real keyframe went
    expect(sb().removes.every(([, e]) => e <= 19.97)).toBe(true);
    expect(ranges()[0][0]).toBeCloseTo(19.97, 6);
    pos = 2; // seek back
    fire('seeking');
    await run(10);
    expect(fetched.filter((n) => n === 's5')).toHaveLength(1);
    // one range from 0 through s5 (it was [0, 19.97] + [20.97, …]: a 1 s hole
    // covered() counted as in, never refetched)
    expect(ranges().some(([a, b]) => a === 0 && b >= 23.97)).toBe(true);
    pos = 19.9;
    fire('waiting');
    await run(3000);
    expect(jump).not.toHaveBeenCalled();
    expect(onFail).not.toHaveBeenCalled();
  });

  it('keyframes 30 ms before the playlist starts, quota path: the playhead\'s own segment is not cut (V-F13)', async () => {
    pos = 100;
    start({ quotaBytes: 10000, range: drift(-0.03) }); // s27 really 107.97–111.97
    await run(10);
    expect(quotaHits()).toBe(1);
    pos = 110;
    await run(5000); // the quota path trims to 1 s behind = 109, inside s27
    expect(sb().removes.every(([, e]) => e <= 107.97)).toBe(true);
    expect(fetched.filter((n) => n === 's27')).toHaveLength(1);
    expect(ranges().some(([a, b]) => a <= 108 && b >= 112)).toBe(true);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('keyframes 30 ms after the playlist starts: the cut still keeps the segment whole', async () => {
    const jump = vi.fn((t) => {
      pos = t;
    });
    start({ segs: seg4(30), jump, range: drift(0.03) }); // s5 really 20.03–24.03
    mse.options.keyframes = keyframesEvery(1);
    await run(10);
    pos = 26;
    fire('waiting');
    await run(10);
    expect(sb().removes.every(([, e]) => e <= 20.03)).toBe(true);
    expect(ranges()[0][0]).toBeCloseTo(20.03, 6);
    pos = 2;
    fire('seeking');
    await run(10);
    expect(fetched.filter((n) => n === 's5')).toHaveLength(1);
    expect(ranges().some(([a, b]) => a <= 0.03 && b >= 24.03)).toBe(true);
    pos = 19.9;
    fire('waiting');
    await run(3000);
    expect(jump).not.toHaveBeenCalled();
    expect(onFail).not.toHaveBeenCalled();
  });

  it('the margin stays within a quarter of a short previous segment: what is left of it never counts as in', async () => {
    const jump = vi.fn((t) => {
      pos = t;
    });
    // …, 12–16, 16–19.6, 19.6–20 (0.4 s), 20–24, …; a keyframe every 50 ms
    const segs = [...seg4(4), { start: 16, end: 19.6, name: 'a' }, { start: 19.6, end: 20, name: 'b' }, ...seg4(20, 20).map((s) => ({ ...s, name: 'c' + s.start }))];
    start({ segs, jump });
    mse.options.keyframes = keyframesEvery(0.05);
    await run(10);
    pos = 26; // trims to 21, inside 20–24: cut 0.1 s (not 0.25) below 20
    fire('waiting');
    await run(10);
    expect(sb().removes.every(([, e]) => e >= 19.85)).toBe(true);
    pos = 2;
    fire('seeking');
    await run(10);
    // the 0.4 s segment's leftover tail missed its midpoint, so it is fetched
    // again and the range runs through without a hole
    expect(ranges().some(([a, b]) => a === 0 && b >= 24)).toBe(true);
    pos = 19.5;
    fire('waiting');
    await run(3000);
    expect(jump).not.toHaveBeenCalled();
    expect(onFail).not.toHaveBeenCalled();
  });
});

describe('failure wording', () => {
  it('unsupported codecs name them in a sentence the player can show', async () => {
    start({ supported: (m) => !m.includes('av01'), prepare: async () => ({ codecs: 'av01.0.12M.10', duration: 60 }) });
    await run(10);
    expect(onFail.mock.calls[0][0].message).toBe('this iPhone can’t play av01.0.12M.10');
  });
});

