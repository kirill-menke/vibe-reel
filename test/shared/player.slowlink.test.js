/* player.svelte.js — the slow-link hint (P.slowNet / P.link), measured by the
 * stall watchdog.
 *
 * CLAUDE.md, "Slow-link hint": after ≥ 8 s of stall, media-s buffered per wall-s
 * × the source Bitrate = what the TV actually gets; between 2 % and 85 % of the
 * file's rate it sets P.slowNet and VideoLayer says "This file needs about
 * 36 Mbit/s; the TV is getting about 13." (the stall card quotes it too). Not for
 * pending streams, not for the burn-in HLS transcode, only sampled while < 20 s
 * is buffered ahead, and a range ending behind the playhead is not a rate sample
 * (bufHeld). The last measurement is kept as P.link (30 min, MovieDetail's chip).
 *
 * Timing (see player.stall.test.js): ticks every 500 ms; after baseline() the
 * ring rises at the 2.5 s tick, and every later tick with the ring up and a held
 * range is a 500 ms sample, so the 8 s judgement lands at the 10.5 s tick. */
import { describe, it, expect, beforeAll } from 'vitest';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, source, video, audio } from '../helpers/media.js';

const PHONE = __PHONE__;
const MBIT36 = 36000000;

function film(bitrate = MBIT36) {
  return movie({ MediaSources: [source([video({ Width: 3840, Height: 2160 }), audio()], { Bitrate: bitrate })] });
}

async function baseline(h) {
  await h.clock.tick(500);
}

/** each 500 ms: the buffered end grows by `perTick` (or perTick(i)), playhead frozen unless `move` */
async function grow(h, ms, perTick, { from = 0, start, move = 0, waiting = false } = {}) {
  let end = start ?? h.video.currentTime + 5;
  for (let i = 0, t = 0; t < ms; t += 500, i++) {
    end += typeof perTick === 'function' ? perTick(i) : perTick;
    h.video.setBuffered([[from, end]]);
    if (move) h.video.advance(move);
    if (waiting) h.video.emit('waiting');
    await h.clock.tick(500);
  }
  return end;
}

describe('slow-link hint', () => {
  beforeAll(warmPlayer, 120000);

  it('8 s of stall at 0.36 media-s per wall-s on a 36 Mbit/s file → "needs 36, gets 13", not one tick earlier', async () => {
    const h = await startPlayer({ item: film() });
    await baseline(h);
    await grow(h, 9500, 0.18);   // up to the 10 s tick: 7.5 s sampled
    expect(h.P.spinner).toBe(true);
    expect(h.P.slowNet).toBe(null);
    await grow(h, 500, 0.18, { start: 5 + 19 * 0.18 });
    expect(h.P.slowNet).toEqual({ need: 36, got: 13 });
    expect(h.P.link).toEqual({ got: 13, at: h.clock.now() });
  });

  it('got never reads below 1 Mbit/s', async () => {
    const h = await startPlayer({ item: film(MBIT36) });
    await baseline(h);
    await grow(h, 12000, 0.0125);   // 0.025 media-s/s → 0.9 Mbit/s
    expect(h.P.slowNet).toEqual({ need: 36, got: 1 });
  });

  it('a near-dead link (≤ 2 % of the rate arriving) gets no hint — that is the stall card\'s job', async () => {
    const h = await startPlayer({ item: film() });
    await baseline(h);
    await grow(h, 15000, 0.005);
    expect(h.P.spinner).toBe(true);
    expect(h.P.slowNet).toBe(null);
    expect(h.P.link).toBe(null);
  });

  it('a link carrying ≥ 85 % of the rate gets no hint', async () => {
    const h = await startPlayer({ item: film() });
    await baseline(h);
    await grow(h, 12000, 0.45);   // 0.9 media-s/s
    expect(h.P.slowNet).toBe(null);
  });

  it('a link carrying 82 % of the rate still gets the hint (the line is 85 %)', async () => {
    const h = await startPlayer({ item: film() });
    await baseline(h);
    await grow(h, 12000, 0.41);   // 0.82 media-s/s → ~29.5 of 36 Mbit/s
    expect(h.P.slowNet).toEqual({ need: 36, got: 30 });
  });

  it('a jump of ≥ 5 s in one tick is a new range, not throughput', async () => {
    const h = await startPlayer({ item: film() });
    await baseline(h);
    await grow(h, 12000, (i) => (i === 8 ? 6 : 0.18));
    expect(h.P.slowNet).toEqual({ need: 36, got: 13 });
  });

  it('only while < 20 s is buffered ahead: a ring over a full buffer is a pipeline hiccup', async () => {
    const h = await startPlayer({ item: film() });
    await baseline(h);
    await grow(h, 15000, 0.18, { start: 20 });
    expect(h.P.spinner).toBe(true);
    expect(h.P.slowNet).toBe(null);
  });

  it('a range ending behind the playhead (the refill after a resume) is progress but not a rate sample', async () => {
    const h = await startPlayer({ item: film() });
    h.video.setTime(659);
    await baseline(h);
    await grow(h, 20000, 0.18, { start: 640 });
    expect(h.P.spinner).toBe(true);
    expect(h.P.error).toBe(null);
    expect(h.P.slowNet).toBe(null);
  });

  // A sample needs the range to have held the playhead on the previous tick too:
  // the tick where the refill catches up with the playhead adds the whole invisible
  // preroll in one step, which is no rate. (Final audit: mutant 1002, held =
  // bufHeld && lastHeld.)
  it('the tick the refill catches up with the playhead is not a sample', async () => {
    const h = await startPlayer({ item: film() });
    h.video.setTime(659);
    h.video.setBuffered([[0, 655]]);   // 4 s behind: progress, not held
    await baseline(h);
    const behind = await grow(h, 3000, 0.1, { start: 655 });   // ring up from the 2.5 s tick
    expect(h.P.spinner).toBe(true);
    // one tick: the range jumps 4.9 s, past the playhead (now held)
    h.video.setBuffered([[0, behind + 4.9]]);
    await h.clock.tick(500);
    // then 16 held ticks of 0.25 media-s: 0.5 of the rate → "needs 36, gets 18"
    await grow(h, 8000, 0.25, { start: behind + 4.9 });
    expect(h.P.slowNet).toEqual({ need: 36, got: 18 });
  });

  it('not for the burn-in transcode (encoder-paced, its bitrate is not the source\'s)', async () => {
    const h = await startPlayer({ item: film() });
    h.P.playMethod = 'Transcode';
    await baseline(h);
    await grow(h, 15000, 0.18);
    expect(h.P.spinner).toBe(true);
    expect(h.P.slowNet).toBe(null);
  });

  it('a source without a Bitrate gets no hint', async () => {
    const h = await startPlayer({ item: film(0) });
    await baseline(h);
    await grow(h, 15000, 0.18);
    expect(h.P.slowNet).toBe(null);
  });

  it('the stall card quotes need/got once the link then dies', async () => {
    const h = await startPlayer({ item: film() });
    await baseline(h);
    const end = await grow(h, 12000, 0.18);
    expect(h.P.slowNet).toEqual({ need: 36, got: 13 });
    h.video.setBuffered([[0, end]]);
    await h.clock.tick(30000);
    expect(h.P.error).toMatchObject({ title: 'Playback stalled' });
    // R3-INT-1: the reading froze when the buffered end stopped, so the card
    // quotes the last live measurement — the hint's 13 — not a running average
    // the dead 30 s dragged down (3.6 media-s over 39.5 s read 3).
    expect(h.P.slowNet).toEqual({ need: 36, got: 13 });
    expect(h.P.error.detail).toContain(
      'needs about 36 Mbit/s but the ' + (PHONE ? 'iPhone' : 'TV') + ' was only getting about 13 Mbit/s, and then nothing for 30 s'
    );   // 30 s = the time the buffered end stood still, not the playhead's 42 s, which include the 12 s the trickle still arrived (V-F9)
    expect(h.P.error.detail).toContain(PHONE ? 'lower the streaming quality' : '5 GHz Wi-Fi or Ethernet');
  });

  it('R3-INT-1: a link delivering in bursts: the still ticks between them count once the next burst lands', async () => {
    const h = await startPlayer({ item: film() });
    await baseline(h);
    // 0.72 media-s every 4th tick (0.36 per wall-s): growth only on the 4.5/6.5/8.5/10.5 s ticks
    await grow(h, 10000, (i) => (i % 4 === 3 ? 0.72 : 0));
    expect(h.P.slowNet).toEqual({ need: 36, got: 13 });   // 2.88 media-s over the 8 s from the 3 s tick
  });

  it('R3-INT-1: once nothing arrives, the hint holds the last live reading while the ring waits for the card', async () => {
    const h = await startPlayer({ item: film() });
    await baseline(h);
    const end = await grow(h, 12000, 0.18);
    expect(h.P.slowNet).toEqual({ need: 36, got: 13 });
    const link = h.P.link;
    h.video.setBuffered([[0, end]]);
    await h.clock.tick(25000);
    expect(h.P.error).toBe(null);
    expect(h.P.spinner).toBe(true);
    expect(h.P.slowNet).toEqual({ need: 36, got: 13 });
    expect(h.P.link).toBe(link);
  });

  it('the link recovering to ≥ 85 % clears P.slowNet and forgets the worse P.link', async () => {
    const h = await startPlayer({ item: film() });
    await baseline(h);
    const end = await grow(h, 10000, 0.18);
    expect(h.P.slowNet).toEqual({ need: 36, got: 13 });
    // now it buffers 4 media-s per wall-s while the playhead creeps on under the ring
    await grow(h, 500, 2, { start: end, move: 1.9, waiting: true });
    expect(h.P.slowNet).toEqual({ need: 36, got: 21 });   // a changed reading replaces the hint…
    expect(h.P.link.got).toBe(21);   // …and the kept measurement
    await grow(h, 1000, 2, { start: end + 2, move: 1.9, waiting: true });
    expect(h.P.slowNet).toBe(null);
    expect(h.P.link).toBe(null);
  });

  it('a kept P.link better than the new full-rate reading stays', async () => {
    const h = await startPlayer({ item: film() });
    h.P.link = { got: 80, at: h.clock.now() };
    await baseline(h);
    await grow(h, 12000, 0.5);   // 1.0 media-s/s = 36 Mbit/s
    expect(h.P.slowNet).toBe(null);
    expect(h.P.link).toMatchObject({ got: 80 });
  });

  it('a kept worse P.link from an earlier playback is forgotten on a good reading', async () => {
    const h = await startPlayer({ item: film() });
    h.P.link = { got: 5, at: h.clock.now() };
    await baseline(h);
    await grow(h, 12000, 0.5);
    expect(h.P.link).toBe(null);
  });

  it('a steady reading refreshes P.link.at only after 60 s (TechGrid\'s 30-min clock)', async () => {
    const h = await startPlayer({ item: film() });
    await baseline(h);
    await grow(h, 10000, 0.1);   // 0.2 media-s/s → 7 Mbit/s, judged at the 10.5 s tick
    expect(h.P.slowNet).toEqual({ need: 36, got: 7 });
    const at = h.P.link.at;
    let end = 5 + 20 * 0.1;
    end = await grow(h, 60000, 0.1, { start: end });
    expect(h.P.slowNet).toEqual({ need: 36, got: 7 });
    expect(h.P.link).toEqual({ got: 7, at });
    await grow(h, 500, 0.1, { start: end });
    expect(h.P.link).toEqual({ got: 7, at: at + 60500 });
  });

  it('a new start clears the hint', async () => {
    const h = await startPlayer({ item: film() });
    await baseline(h);
    await grow(h, 12000, 0.18);
    expect(h.P.slowNet).not.toBe(null);
    h.player.retryPlayback();
    await h.settle();
    expect(h.P.slowNet).toBe(null);
    expect(h.P.link).toMatchObject({ got: 13 });   // the measurement outlives the playback
  });

  it('phone: the rate is the quality cap when the file is above it (the TV has no cap)', async () => {
    const h = await startPlayer({ item: film(), storage: { 'reel.qualityCellular': '8000000' } });
    await baseline(h);
    await grow(h, 12000, 0.18);   // 0.36 of 8 Mbit/s → 2.9
    expect(h.P.slowNet).toEqual(PHONE ? { need: 8, got: 3 } : { need: 36, got: 13 });
  });
});
