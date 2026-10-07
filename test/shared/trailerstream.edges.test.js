/* trailerstream.js createTrailerSource(): edges found by mutation testing
 * (hardening round, Stryker on trailerstream.js). Each pins documented
 * behaviour trailerstream.test.js left loose:
 *   - the growing playlist is fetched with `cache: 'no-store'` (a cached copy
 *     never grows) and re-read at most every 300 ms, the subtitle status at
 *     most every second — not on every segment;
 *   - "nothing is appended until PRELOAD_S seconds of segments are in memory":
 *     the preload is the segments *starting before* 6 s;
 *   - a QuotaExceededError retries the same buffer (no refetch) and stops with stop();
 *   - endOfStream only when everything from the playhead to the end is in (a seek
 *     back that leaves a hole before the end does not end it again);
 *   - op() leaves no listeners on the SourceBuffer;
 *   - the VTT download is aborted by stop() like every other request;
 *   - a failure landing after stop() is not reported;
 *   - phone: with streaming off the loop waits ~900 ms per look, not a busy poll.
 * Runs in both projects (TV: 45 s ahead / 15 s behind, phone: 30 / 5). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTrailerSource } from '../../src/lib/trailerstream.js';
import { cfg } from '../../src/lib/config.js';
import { installMSE, keyframesEvery } from '../helpers/mse.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock } from '../helpers/time.js';
import { TEST_MEDIALIB } from '../helpers/modules.js';
import { trailerServer, uniform, READY } from '../helpers/trailer.js';
import { trackListeners } from '../helpers/listeners.js';

const PHONE = __PHONE__;

const ID = 'dQw4w9WgXcQ';
const BASE = TEST_MEDIALIB + '/api/trailers/' + ID + (PHONE ? '@1080' : '');

let clock, net, mse, pos, posCalls, onFail, onInfo, onSubs, src, srv;

beforeEach(() => {
  cfg.medialib = TEST_MEDIALIB;
  clock = useClock();
  net = mockFetch();
  pos = 0;
  posCalls = 0;
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
  src = createTrailerSource(ID, {
    onFail,
    onInfo,
    onSubs,
    position: () => {
      posCalls++;
      return pos;
    },
    jump: (t) => (pos = t)
  });
  return src;
}

const sb = () => mse.last.sb;
const appended = () => (sb() ? sb().appends.filter((a) => !a.init) : []);
const count = (name) => srv.fetched.filter((n) => n === name).length;
const plReads = () => net.callsTo(BASE + '/index.m3u8');
const statusGets = () => net.callsTo(BASE, 'GET');

describe('requests', () => {
  it("the playlist is always fetched with cache: 'no-store' (a cached copy would never grow)", async () => {
    start({ segs: uniform(5), complete: false });
    await clock.tick(1000);
    expect(plReads().length).toBeGreaterThan(1);
    expect(plReads().every((c) => c.init.cache === 'no-store')).toBe(true);
  });

  it('while filling at full speed the growing playlist is re-read at most every 300 ms, not per segment', async () => {
    start({ segs: uniform(25), complete: false });
    await clock.tick(50);
    expect(appended().length).toBeGreaterThanOrEqual(PHONE ? 8 : 12); // the whole window went in at once…
    expect(plReads().length).toBeLessThanOrEqual(2); // …on one or two reads
  });

  it('a growing playlist is re-read every 300 ms while the window is full', async () => {
    start({ segs: uniform(25), complete: false });
    await clock.tick(1000);
    const before = plReads().length;
    await clock.tick(3000);
    expect(plReads().length - before).toBe(10);
  });

  it('subtitles still pending: their status is asked at most once a second while feeding', async () => {
    start({ status: [{ ...READY, subs_done: false }] });
    await clock.tick(2000); // ready at 0, gives up waiting for subs 1.5 s later
    const before = statusGets().length;
    await clock.tick(3000);
    const n = statusGets().length - before;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(4);
  });

  it('the VTT download shares the signal stop() aborts', async () => {
    start({ status: [{ ...READY, subs: [{ lang: 'en' }] }] });
    net.on('GET', BASE + '/subs.vtt', net.hang());
    await clock.tick(10);
    const vtt = net.callsTo(BASE + '/subs.vtt')[0];
    expect(vtt.signal).toBeTruthy();
    expect(vtt.signal.aborted).toBe(false);
    src.stop();
    expect(vtt.signal.aborted).toBe(true);
    await clock.tick(5000);
    expect(onSubs).not.toHaveBeenCalled();
    expect(onFail).not.toHaveBeenCalled();
  });
});

describe('the preload', () => {
  it('is the segments starting before 6 s: one starting at exactly 6 s is fetched by the feeding loop', async () => {
    // 2 s segments: s000–s002 are the preload; hold s003 (starts at 6.0)
    start({ segs: uniform(50, 2), hold: (n) => n === 's003.m4s' });
    await clock.tick(50);
    expect(srv.fetched.slice(0, 5)).toEqual(['init.mp4', 's000.m4s', 's001.m4s', 's002.m4s', 's003.m4s']);
    // the preload went in although s003 hasn't arrived
    expect(sb().appends.map((a) => (a.init ? 'init' : a.start))).toEqual(['init', 0, 2, 4]);
  });
});

describe('QuotaExceededError', () => {
  it('the held segment is appended on retry, never fetched a second time', async () => {
    start();
    await clock.tick(1000);
    pos = 25;
    sb().quotaNext();
    await clock.tick(1500);
    expect(sb().calls.some((c) => c[0] === 'quota')).toBe(true);
    const names = srv.fetched.filter((n) => n.endsWith('.m4s'));
    expect(new Set(names).size).toBe(names.length);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('stopped during the 500 ms back-off: nothing more is appended', async () => {
    start();
    await clock.tick(1000);
    pos = 25;
    sb().quotaNext();
    await clock.tick(350); // the loop hit the full buffer
    expect(sb().calls.some((c) => c[0] === 'quota')).toBe(true);
    const n = sb().appends.length;
    src.stop();
    await clock.tick(5000);
    expect(sb().appends.length).toBe(n);
  });
});

describe('endOfStream', () => {
  it('a seek back that leaves a hole before the end: not ended again until the hole is filled', async () => {
    start({ segs: uniform(25) }); // 0–100
    await clock.tick(500);
    // the trim behind the playhead lands on a segment boundary (F12 below: one that doesn't)
    pos = PHONE ? 72 : 63;
    await clock.tick(1000);
    expect(mse.last.ended).toBe(1); // everything from there to the end is in
    pos = 10;
    await clock.tick(1000);
    // the window refilled from 8 (re-opening the source); the stretch before the
    // kept tail is missing, so the stream must stay open
    const r = sb().ranges();
    expect(r).toHaveLength(2);
    expect(r[0][0]).toBe(8);
    expect(r[1][1]).toBe(100);
    expect(mse.last.readyState).toBe('open');
    expect(mse.last.ended).toBe(1);
    expect(mse.last.sourceBuffers).toHaveLength(1);
    pos = PHONE ? 45 : 20; // the window now reaches the kept tail
    await clock.tick(1000);
    expect(sb().ranges()).toHaveLength(1);
    expect(mse.last.ended).toBe(2);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('once ended, it is not ended again on later loop turns', async () => {
    start({ segs: uniform(6) });
    await clock.tick(5000);
    expect(mse.last.ended).toBe(1);
    expect(onFail).not.toHaveBeenCalled();
  });
});

// F12 (findings.md): the trim behind the playhead used to cut at playhead − BEHIND_S,
// inside a segment. Under the MSE coded-frame-removal rule what follows the cut up
// to the next keyframe goes with it, so with a keyframe between the cut and the
// segment's midpoint a 1 s hole stayed behind that was never refetched (V-F12).
// The cut is now snapped down to the start of the segment it falls in.
describe('F12: the trim behind the playhead cuts on a segment boundary', () => {
  // TV 60 − 15 = 45 inside 44–48, phone 26 − 5 = 21 inside 20–24: after the
  // segment start, before its midpoint
  const PLAY = PHONE ? 26 : 60;
  const CUT = PLAY - (PHONE ? 5 : 15);
  const SEG_START = Math.floor(CUT / 4) * 4;
  const SEG_NAME = 's' + String(SEG_START / 4).padStart(3, '0') + '.m4s';
  const BACK = PHONE ? 2 : 10;

  it('one keyframe per segment (ffmpeg\'s cut when the GOP is a segment long): the segment the cut falls in stays whole, and a seek back leaves no hole', async () => {
    start({ segs: uniform(25) }); // 0–100, 4 s segments
    await clock.tick(500);
    pos = PLAY;
    await clock.tick(1000);
    expect(sb().removes[0]).toEqual([0, SEG_START - 0.25]); // 0.25 s below it: keyframe drift margin
    // the cut segment is all there, every range starts on a segment boundary
    expect(sb().ranges().some(([a, b]) => a <= SEG_START && b >= SEG_START + 4)).toBe(true);
    expect(sb().ranges().every(([a]) => a % 4 === 0)).toBe(true);
    expect(count(SEG_NAME)).toBe(1);
    pos = BACK; // seek back
    await clock.tick(3000);
    // refilled from the playhead's segment up to the kept one: no hole on the way
    expect(count(SEG_NAME)).toBe(1);
    const r = sb().ranges();
    expect(r[0][0]).toBe(Math.floor(BACK / 4) * 4);
    expect(r[0][1]).toBeGreaterThanOrEqual(SEG_START + 4);
    pos = SEG_START + 2; // play into the once-trimmed-at segment
    await clock.tick(1000);
    expect(sb().ranges().some(([a, b]) => a <= SEG_START && b >= SEG_START + 4)).toBe(true);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('a keyframe every second (V-F12): the cut segment is kept whole, so after a seek back there is no 1 s hole to stall in', async () => {
    start({ segs: uniform(25), mse: { keyframes: keyframesEvery(1) } });
    await clock.tick(500);
    pos = PLAY;
    await clock.tick(1000);
    expect(sb().removes.every(([, e]) => (e + 0.25) % 4 === 0)).toBe(true);
    pos = BACK; // seek back
    await clock.tick(3000);
    // one range from the playhead's segment through the cut one: no hole on the way
    // (it was [.., SEG_START] + [CUT, ..], a 1 s hole too wide to be gap-jumped)
    const through = () => sb().ranges().some(([a, b]) => a <= Math.floor(BACK / 4) * 4 && b >= SEG_START + 4);
    expect(through()).toBe(true);
    expect(count(SEG_NAME)).toBe(1); // never left the buffer
    pos = SEG_START - 0.1; // play up to where the hole was
    await clock.tick(3000);
    expect(pos).toBe(SEG_START - 0.1); // nothing to jump over
    expect(sb().ranges().some(([a, b]) => a <= SEG_START - 0.1 && b >= SEG_START + 4)).toBe(true);
    expect(onFail).not.toHaveBeenCalled();
  });

  // A playlist start is a running sum of rounded #EXTINF values; the segment's
  // real first keyframe can sit a little before it or after it. A cut exactly on
  // the playlist start removes a keyframe sitting before it and the GOP it opens —
  // the hole again. The cut stays 0.25 s below the start (≤ ¼ of the previous segment).
  const drift = (d) => (s) => [Math.max(0, s.start + d), s.end + d];
  for (const d of [-0.03, 0.03]) {
    it('keyframes ' + Math.abs(d * 1000) + ' ms ' + (d < 0 ? 'before' : 'after') + ' the playlist starts, a keyframe every second: the cut segment stays whole, a seek back leaves no hole', async () => {
      start({ segs: uniform(25), media: drift(d), mse: { keyframes: keyframesEvery(1) } });
      await clock.tick(500);
      pos = PLAY;
      await clock.tick(1000);
      const key = SEG_START + d; // the cut segment's real first keyframe
      expect(sb().removes.length).toBeGreaterThan(0);
      expect(sb().removes.every(([, e]) => e <= key)).toBe(true);
      expect(sb().ranges()[0][0]).toBeCloseTo(key, 6);
      pos = BACK; // seek back
      await clock.tick(3000);
      expect(count(SEG_NAME)).toBe(1); // never left the buffer
      const from = Math.max(0, Math.floor(BACK / 4) * 4 + d);
      expect(sb().ranges().some(([a, b]) => a <= from + 1e-9 && b >= key + 4)).toBe(true);
      pos = SEG_START - 0.1;
      await clock.tick(3000);
      expect(pos).toBe(SEG_START - 0.1); // nothing to jump over
      expect(onFail).not.toHaveBeenCalled();
    });
  }
});

describe('the SourceBuffer keeps no listeners between operations', () => {
  it('after the preload and a full window (and a quota retry) none are left', async () => {
    let live = null;
    start();
    net.on('GET', BASE + '/init.mp4', () => {
      srv.fetched.push('init.mp4');
      live = trackListeners(sb());
      return mse.initSegment(600);
    });
    await clock.tick(1000);
    pos = 25;
    sb().quotaNext();
    await clock.tick(1500);
    expect(sb().calls.some((c) => c[0] === 'quota')).toBe(true);
    expect(appended().length).toBeGreaterThan(10);
    expect(live()).toEqual([]);
  });
});

describe('after stop()', () => {
  it('a failure that lands after stop() is not reported', async () => {
    // appends take 1 s; the init append will be rejected by the decoder
    start({ mse: { appendMs: 1000 }, segs: uniform(20, 2), hold: (n) => n === 's002.m4s' });
    await clock.tick(50);
    sb().failNext();
    srv.release('s002.m4s');
    await clock.tick(500); // the init append is in flight
    expect(sb().updating).toBe(true);
    src.stop();
    await clock.tick(2000);
    expect(onFail).not.toHaveBeenCalled();
  });
});

if (PHONE) describe('phone: ManagedMediaSource with streaming off', () => {
  it('the loop looks again about every 900 ms, not in a busy poll', async () => {
    start({ mse: { managed: 'only' } });
    await clock.tick(1000); // 0–32 in
    mse.last.setStreaming(false);
    pos = 5; // 27 s ahead ≥ the 6 s preload, the window wants more
    await clock.tick(500);
    posCalls = 0;
    await clock.tick(9000);
    expect(posCalls).toBeGreaterThanOrEqual(8);
    expect(posCalls).toBeLessThanOrEqual(14);
  });
});

