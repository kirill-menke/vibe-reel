/* player.svelte.js — the stall watchdog's exact edges (lane r3-tv-unit,
 * mutation-backed). player.stall/slowlink pin every *time* threshold at the
 * exact 500 ms tick on both sides; what they could not land on are the edges of
 * the *media* measurements — the playhead and the buffered ranges, which the
 * fake <video> sets to any value. Here those are driven to the exact boundary:
 *
 * - bufferedEnd(t): a range "holds" the playhead when it starts ≤ t + 0.5 and
 *   ends ≥ t − 0.5; a range ending up to 30 s behind (≥ t − 30) is download
 *   progress but no rate sample; the range that holds may be any of several.
 * - download progress is a buffered end moving > 0.05 s in a tick.
 * - the slow-link hint is for 2 % < ratio < 85 %; ≥ 85 % clears the hint, and
 *   forgets P.link only when the link now carries more than it measured.
 *   (Ratios are chosen so the float arithmetic is exact: 6.8 / 8 === 0.85,
 *   0.16 / 8 === 0.02, 7 / 8 === 0.875.)
 *
 * Timing (player.stall.test.js): ticks every 500 ms from the src (time 0);
 * baseline = the 500 ms tick; with the playhead frozen the ring rises at the
 * 2.5 s tick, samples run from the 3 s tick (one per tick, 500 ms each), so the
 * 8 s judgement is the 10.5 s tick and the 16 s one the 18.5 s tick. The card
 * comes 30 s after the later of the last playhead and the last download move. */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, source, video, audio } from '../helpers/media.js';

const MBIT36 = 36000000;
const film = (bitrate = MBIT36) => movie({ MediaSources: [source([video({ Width: 3840, Height: 2160 }), audio()], { Bitrate: bitrate })] });

/** run ticks up to (and including) the tick at fake time `ms`, calling each(tickTime) before each */
async function until(h, ms, each) {
  while (h.clock.now() - START(h) < ms) {
    const next = h.clock.now() - START(h) + 500;
    if (each) each(next);
    await h.clock.tick(500);
  }
}
const starts = new WeakMap();
const START = (h) => starts.get(h);
async function play(opts) {
  const h = await startPlayer(opts);
  starts.set(h, h.clock.now());   // the src was set at this fake time: ticks land at +500, +1000, …
  return h;
}

describe('slow-link ratio edges (exact float ratios)', () => {
  beforeAll(warmPlayer, 120000);

  /** buffered end per tick time: `ends` maps a tick time to a new end; the playhead stays at 0 */
  async function stall(h, ends, upto, start = 0) {
    let end = start;
    h.video.setBuffered([[0, end]]);
    await until(h, upto, (at) => {
      if (at in ends) end = ends[at];
      h.video.setBuffered([[0, end]]);
    });
  }

  it('exactly 85 % at the 8 s judgement is no hint; 81 % a tick later is', async () => {
    const h = await play({ item: film() });
    // judged on a tick the buffered end grows (R3-INT-1): the still ticks between count then
    await stall(h, { 3000: 3.4, 10500: 6.8 }, 10500);   // 6.8 media-s in 8 s = 0.85
    expect(h.P.spinner).toBe(true);
    expect(h.P.slowNet).toBe(null);
    await stall(h, { 11000: 6.9 }, 11000, 6.8);
    expect(h.P.slowNet).toEqual({ need: 36, got: 29 });   // 6.9 / 8.5 = 0.81 → 29.2
  });

  it('exactly 2 % is no hint (a dead link is the card’s job); a little more is', async () => {
    const h = await play({ item: film() });
    await stall(h, { 10500: 0.16 }, 10500);   // 0.16 / 8 = 0.02
    expect(h.P.slowNet).toBe(null);
    const g = await play({ item: film() });
    await stall(g, { 10500: 0.17 }, 10500);
    expect(g.P.slowNet).toEqual({ need: 36, got: 1 });
  });

  it('a reading of exactly 85 % takes down a hint shown earlier in the same stall, and forgets the lower P.link', async () => {
    const h = await play({ item: film() });
    // 3.4 by 8 s (0.425 → 15 Mbit/s), then 13.6 by 16 s: exactly 0.85
    await stall(h, { 3000: 1.7, 10500: 3.4 }, 10500);
    expect(h.P.slowNet).toEqual({ need: 36, got: 15 });
    expect(h.P.link.got).toBe(15);
    // the rest arrives in the last three samples, so the running ratio stays under 85 % until 16 s
    await stall(h, { 17500: 6.8, 18000: 10.2 }, 18000, 3.4);
    expect(h.P.slowNet).toEqual({ need: 36, got: 24 });   // 10.2 / 15.5 = 0.658
    await until(h, 18500, () => h.video.setBuffered([[0, 13.6]]));   // 13.6 / 16 = 0.85
    expect(h.P.slowNet).toBe(null);
    expect(h.P.link).toBe(null);   // 30.6 Mbit/s now > the 15 it measured
  });

  it('a good reading equal to the remembered link keeps P.link (only a better link forgets it)', async () => {
    const h = await play({ item: film(40000000) });
    h.P.link = { got: 35, at: h.clock.now() };   // an earlier playback measured 35 Mbit/s
    await stall(h, { 3000: 3.5, 3500: 7 }, 10500);   // 7 / 8 = 0.875 of 40 = exactly 35
    expect(h.P.slowNet).toBe(null);
    expect(h.P.link).toEqual({ got: 35, at: h.clock.now() - 10500 });
  });

  it('a good reading below the remembered link keeps it too', async () => {
    const h = await play({ item: film(40000000) });
    h.P.link = { got: 39, at: 1 };
    await stall(h, { 3000: 3.5, 3500: 7 }, 10500);
    expect(h.P.link).toEqual({ got: 39, at: 1 });
  });

  it('a near-dead reading (≤ 2 %) neither clears the hint state nor forgets P.link', async () => {
    const h = await play({ item: film(200000000) });
    h.P.link = { got: 1, at: 1 };   // 1 % of 200 Mbit/s is 2 — more than the 1 remembered, yet no good reading: kept
    await stall(h, { 3000: 0.08 }, 10500);   // 0.01
    expect(h.P.slowNet).toBe(null);
    expect(h.P.link).toEqual({ got: 1, at: 1 });
  });
});

describe('bufferedEnd: which range holds the playhead', () => {
  beforeAll(warmPlayer, 120000);

  /** playhead creeping by 0.25 a tick under a 'waiting' ring; the range ends `off` from it */
  async function creep(h, off, upto, from = 0) {
    h.video.setTime(100);
    await until(h, upto, () => {
      h.video.advance(0.25);
      h.video.setBuffered([[from, h.video.currentTime + off]]);
      h.video.emit('waiting');
    });
  }

  it('a range ending exactly 0.5 s behind the playhead still holds it (rate samples → hint)', async () => {
    const h = await play({ item: film() });
    await creep(h, -0.5, 9000);   // 0.25 media-s per 500 ms = 0.5 ratio → 18 Mbit/s
    expect(h.P.slowNet).toEqual({ need: 36, got: 18 });
  });

  it('a range ending 0.75 s behind does not hold it (progress only: no hint)', async () => {
    const h = await play({ item: film() });
    await creep(h, -0.75, 12000);
    expect(h.P.slowNet).toBe(null);
  });

  it('a range starting exactly 0.5 s ahead of the playhead holds it', async () => {
    const h = await play({ item: film() });
    h.video.setTime(100);
    await until(h, 9000, () => {
      h.video.advance(0.25);
      const t = h.video.currentTime;
      h.video.setBuffered([[t + 0.5, t + 3]]);
      h.video.emit('waiting');
    });
    expect(h.P.slowNet).toEqual({ need: 36, got: 18 });
  });

  it('the holding range may be the second of several (each range is looked at in order)', async () => {
    const h = await play({ item: film() });
    h.video.setTime(100);
    await until(h, 9000, () => {
      h.video.advance(0.25);
      const t = h.video.currentTime;
      h.video.setBuffered([[0, 10], [t - 1, t + 2]]);
      h.video.emit('waiting');
    });
    expect(h.P.slowNet).toEqual({ need: 36, got: 18 });
  });
});

describe('download progress edges (the card)', () => {
  beforeAll(warmPlayer, 120000);

  it('a buffered end moving exactly 0.05 s is not progress: the card comes 30 s after the playhead stopped', async () => {
    const h = await play();
    h.video.setBuffered([[0, 0]]);
    await until(h, 10000, (at) => h.video.setBuffered([[0, at >= 10000 ? 0.05 : 0]]));
    await until(h, 30000);
    expect(h.P.error).toBe(null);
    await until(h, 30500);
    expect(h.P.error).toMatchObject({ title: 'Playback stalled' });
  });

  it('a buffered end moving 0.0625 s is progress: the card waits 30 s from that move', async () => {
    const h = await play();
    h.video.setBuffered([[0, 0]]);
    await until(h, 10000, (at) => h.video.setBuffered([[0, at >= 10000 ? 0.0625 : 0]]));
    await until(h, 39500);
    expect(h.P.error).toBe(null);
    await until(h, 40000);
    expect(h.P.error).toMatchObject({ title: 'Playback stalled' });
  });

  it('a range ending exactly 30 s behind the playhead is progress when it then grows', async () => {
    const h = await play();
    h.video.setTime(100);
    // nothing buffered until the 5 s tick, then 70 (exactly t − 30), then 75 at 5.5 s
    await until(h, 5500, (at) => h.video.setBuffered(at < 5000 ? [] : [[0, at === 5000 ? 70 : 75]]));
    await until(h, 35000);
    expect(h.P.error).toBe(null);   // the 70 → 75 move at 5.5 s
    await until(h, 35500);
    expect(h.P.error).toMatchObject({ title: 'Playback stalled' });
  });

  it('a tick without any range keeps the last end: the range coming back further on is progress', async () => {
    const h = await play();
    h.video.setBuffered([[0, 0]]);
    await until(h, 5500, (at) => h.video.setBuffered(at === 5000 ? [] : [[0, at === 5500 ? 0.5 : 0]]));
    await until(h, 35000);
    expect(h.P.error).toBe(null);   // 0 → (gone) → 0.5 counted at 5.5 s
    await until(h, 35500);
    expect(h.P.error).toMatchObject({ title: 'Playback stalled' });
  });

  it('a range that shrank to the playhead (evicted) is the new reference: growing back is progress', async () => {
    const h = await play();
    h.video.setBuffered([[0, 0.25]]);
    await until(h, 6000, (at) => h.video.setBuffered([[0, at === 5500 ? 0 : at === 6000 ? 0.25 : 0.25]]));
    await until(h, 35500);
    expect(h.P.error).toBe(null);   // 0.25 → 0 → 0.25: the 6 s tick moved
    await until(h, 36000);
    expect(h.P.error).toMatchObject({ title: 'Playback stalled' });
  });
});

describe('sample edges', () => {
  beforeAll(warmPlayer, 120000);

  async function stall(h, ends, upto, start = 0) {
    let end = start;
    h.video.setBuffered([[0, end]]);
    await until(h, upto, (at) => {
      if (at in ends) end = ends[at];
      h.video.setBuffered([[0, end]]);
    });
  }

  it('a step of exactly 5 s in one tick is a new range, not throughput', async () => {
    const h = await play({ item: film() });
    await stall(h, { 3000: 5 }, 10500);
    expect(h.P.slowNet).toBe(null);   // counted, 5 s in 8 s would read 62 %
  });

  it('exactly 20 s buffered ahead is "full": no samples', async () => {
    const h = await play({ item: film() });
    await stall(h, { 3000: 20 }, 10500, 16);
    expect(h.P.slowNet).toBe(null);   // counted, 4 s in 8 s would read 50 %
  });
});

describe('more sample edges', () => {
  beforeAll(warmPlayer, 120000);

  it('a buffered end sitting exactly at 0 is still a (zero) sample: the 8 s are counted from the first one', async () => {
    const h = await play({ item: film() });
    let end = 0;
    h.video.setBuffered([[0, 0]]);
    await until(h, 10500, (at) => {
      if (at === 10500) end = 1;
      h.video.setBuffered([[0, end]]);
    });
    expect(h.P.slowNet).toEqual({ need: 36, got: 5 });   // 1 media-s in 8 s: 4.5 → 5
  });

  it('the first held tick after a seek is no sample (nothing to measure from yet)', async () => {
    const h = await play({ item: film() });
    h.video.setBuffered([[0, 105]]);
    await h.clock.tick(500);   // a held range: the watchdog remembers it held
    h.player.seekTo(100);
    h.video.emit('waiting');   // the ring is up through the seek
    let end = 105;
    await until(h, 9000, (at) => {
      if (at >= 2000) end += 0.25;
      h.video.setBuffered([[0, end]]);
    });
    expect(h.P.slowNet).toBe(null);   // 15 samples so far (from 2 s): 7.5 s
    await until(h, 9500, () => h.video.setBuffered([[0, (end += 0.25)]]));
    expect(h.P.slowNet).toEqual({ need: 36, got: 18 });   // 4 media-s in 8 s
  });

  it('a pause takes a watchdog ring down once; a later "waiting" ring survives the next pause', async () => {
    const h = await play();
    await until(h, 2500);
    expect(h.P.spinner).toBe(true);   // the watchdog's ring
    h.video.pause();
    await h.clock.tick(500);
    expect(h.P.spinner).toBe(false);
    h.video.play();
    h.video.emit('waiting');   // buffering right after the resume: the element's own ring
    h.video.pause();
    await h.clock.tick(500);
    expect(h.P.spinner).toBe(true);
  });
});

describe('the stall card wording', () => {
  beforeAll(warmPlayer, 120000);

  it('a dead link: how long nothing arrived, and where Retry resumes', async () => {
    const h = await play();
    h.video.setTime(65);
    h.video.emit('timeupdate');
    h.video.setBuffered([[0, 70]]);
    await until(h, 30500);
    expect(h.P.error.title).toBe('Playback stalled');
    expect(h.P.error.detail).toBe(
      __PHONE__
        ? 'No video has arrived from the server for 30 s. Check the iPhone’s connection, then Retry from 1:05.'
        : 'No video has arrived from the server for 30 s. Check the TV’s connection, then Retry from 1:05.'
    );
  });

  it('a slow link that then died: what it needed, what it got, and for how long nothing came', async () => {
    const h = await play({ item: film() });
    let end = 0;
    h.video.setBuffered([[0, 0]]);
    await until(h, 10500, (at) => {
      if (at >= 3000) end += 0.125;   // 0.25 media-s per wall-s → 9 Mbit/s of 36
      h.video.setBuffered([[0, end]]);
    });
    expect(h.P.slowNet).toEqual({ need: 36, got: 9 });
    await until(h, 40500);   // nothing more arrives: 30 s after the last move
    expect(h.P.error.title).toBe('Playback stalled');
    // R3-INT-1: the reading froze when the buffered end stopped — the card quotes the last live
    // measurement (the hint's 9), not an average the dead 30 s dragged to 2
    expect(h.P.slowNet).toEqual({ need: 36, got: 9 });
    expect(h.P.error.detail).toBe(
      __PHONE__
        ? 'This stream needs about 36 Mbit/s but the iPhone was only getting about 9 Mbit/s, and then nothing for 30 s. Check the connection or lower the streaming quality, then Retry from 0:00.'
        : 'This file needs about 36 Mbit/s but the TV was only getting about 9 Mbit/s, and then nothing for 30 s. Check the TV’s connection — 5 GHz Wi-Fi or Ethernet — then Retry from 0:00.'
    );
  });
});

describe('the first tick', () => {
  beforeAll(warmPlayer, 120000);

  it('a playhead that happens to read 1 at the first tick is a movement like any other', async () => {
    const h = await play();
    h.video.setTime(1);
    await until(h, 2000);
    expect(h.P.spinner).toBe(false);   // still since the 500 ms tick: 1.5 s
    await until(h, 2500);
    expect(h.P.spinner).toBe(true);
  });
});

describe('watchdog state across starts', () => {
  beforeAll(warmPlayer, 120000);

  it("a 'waiting' ring at the start survives a pause (only a watchdog ring is taken down)", async () => {
    const h = await play();
    h.video.emit('waiting');
    expect(h.P.spinner).toBe(true);
    h.video.pause();
    await h.clock.tick(500);
    expect(h.P.spinner).toBe(true);
  });

  it('a restart leaves exactly one watchdog interval running', async () => {
    const h = await play();
    // every 500 ms interval created from here on, minus the ones cleared
    const live = new Set();
    const si = globalThis.setInterval;
    const ci = globalThis.clearInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation((fn, ms, ...a) => {
      const id = si(fn, ms, ...a);
      if (ms === 500) live.add(id);
      return id;
    });
    vi.spyOn(globalThis, 'clearInterval').mockImplementation((id) => {
      live.delete(id);
      return ci(id);
    });
    h.player.restartPlayback(10);
    await h.settle();
    h.player.restartPlayback(20);
    await h.settle();
    expect(live.size).toBe(1);
  });
});
