/* Self-tests of the fake MediaSource (test/helpers/mse.js): if the fake is
 * wrong, every segfeed/trailerstream result built on it is suspect. */
import { describe, it, expect, vi } from 'vitest';
import { installMSE, segment, initSegment, decodeSegment, keyframesEvery } from '../helpers/mse.js';
import { useClock } from '../helpers/time.js';

const MIME = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const once = (target, type) => new Promise((res) => target.addEventListener(type, res, { once: true }));

async function openSb(opts) {
  const mse = installMSE(opts);
  const MS = window.MediaSource || window.ManagedMediaSource;
  const ms = new MS();
  URL.createObjectURL(ms);
  await flush();
  const sb = ms.addSourceBuffer(MIME);
  return { mse, ms, sb };
}

describe('fake MediaSource: installation', () => {
  it('installs window.MediaSource only by default', () => {
    const mse = installMSE();
    expect(window.MediaSource).toBe(mse.MediaSource);
    expect(window.ManagedMediaSource).toBeUndefined();
    expect(new window.MediaSource()).not.toHaveProperty('streaming');
  });

  it("managed: 'only' is the iPhone: no MediaSource, a ManagedMediaSource with `streaming`", () => {
    const mse = installMSE({ managed: 'only' });
    expect(window.MediaSource).toBeUndefined();
    expect(window.ManagedMediaSource).toBe(mse.ManagedMediaSource);
    const ms = new window.ManagedMediaSource();
    expect(ms.streaming).toBe(true);
    expect(ms).toBeInstanceOf(mse.MediaSource);
  });

  it('managed: true installs both classes', () => {
    installMSE({ managed: true });
    expect(typeof window.MediaSource).toBe('function');
    expect(typeof window.ManagedMediaSource).toBe('function');
  });

  it('isTypeSupported is configurable and recorded', () => {
    const mse = installMSE({ supported: (m) => m.includes('avc1') });
    expect(window.MediaSource.isTypeSupported(MIME)).toBe(true);
    expect(window.MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.10"')).toBe(false);
    expect(mse.typeQueries).toHaveLength(2);
  });
});

describe('fake MediaSource: lifecycle', () => {
  it('closed → open with sourceopen after URL.createObjectURL (autoOpen)', async () => {
    const mse = installMSE();
    const ms = new window.MediaSource();
    expect(ms.readyState).toBe('closed');
    const opened = vi.fn();
    const url = URL.createObjectURL(ms);
    ms.addEventListener('sourceopen', opened);
    expect(url).toMatch(/^blob:fake-mse\//);
    expect(mse.byUrl(url)).toBe(ms);
    expect(opened).not.toHaveBeenCalled();
    await flush();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(ms.readyState).toBe('open');
  });

  it('autoOpen: false waits for ms.open(); addSourceBuffer and duration throw while closed', async () => {
    installMSE({ autoOpen: false });
    const ms = new window.MediaSource();
    URL.createObjectURL(ms);
    await flush();
    expect(ms.readyState).toBe('closed');
    expect(() => ms.addSourceBuffer(MIME)).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
    expect(() => (ms.duration = 10)).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
    ms.open();
    ms.duration = 125.5;
    expect(ms.duration).toBe(125.5);
    expect(ms.addSourceBuffer(MIME)).toBe(ms.sb);
  });

  it('endOfStream: open → ended + sourceended; an append re-opens it with sourceopen', async () => {
    const { ms, sb } = await openSb();
    const reopened = vi.fn();
    ms.endOfStream();
    expect(ms.readyState).toBe('ended');
    expect(ms.ended).toBe(1);
    expect(() => ms.endOfStream()).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
    ms.addEventListener('sourceopen', reopened);
    sb.appendBuffer(segment(0, 2));
    expect(ms.readyState).toBe('open');
    expect(reopened).toHaveBeenCalledTimes(1);
  });

  it('revokeObjectURL of a fake URL is recorded; real blob URLs still pass through', async () => {
    const mse = installMSE();
    const ms = new window.MediaSource();
    const url = URL.createObjectURL(ms);
    URL.revokeObjectURL(url);
    expect(mse.revoked).toEqual([url]);
    const blobUrl = URL.createObjectURL(new Blob(['WEBVTT'], { type: 'text/vtt' }));
    expect(blobUrl).not.toMatch(/fake-mse/);
    URL.revokeObjectURL(blobUrl);
    expect(mse.revoked).toEqual([url]);
  });
});

describe('fake SourceBuffer', () => {
  it('segment()/initSegment() encode their range and size', () => {
    expect(decodeSegment(segment(4, 10, 5000))).toEqual([4, 10]);
    expect(segment(4, 10, 5000).byteLength).toBe(5000);
    expect(decodeSegment(initSegment())).toBeNull();
    expect(() => decodeSegment(new ArrayBuffer(64))).toThrow(/not a segment/);
  });

  it('appendBuffer: updating until updateend (async), then the range is buffered', async () => {
    const { sb } = await openSb();
    const events = [];
    for (const t of ['updatestart', 'update', 'updateend']) sb.addEventListener(t, () => events.push(t));
    sb.appendBuffer(segment(0, 6, 2000));
    expect(sb.updating).toBe(true);
    expect(sb.buffered.length).toBe(0);
    expect(() => sb.appendBuffer(segment(6, 12))).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
    await once(sb, 'updateend');
    expect(events).toEqual(['updatestart', 'update', 'updateend']);
    expect(sb.updating).toBe(false);
    expect(sb.ranges()).toEqual([[0, 6]]);
    expect(sb.bytes).toBe(2000);
    expect(sb.appends).toEqual([{ start: 0, end: 6, bytes: 2000 }]);
  });

  it('adjacent segments merge; a hole stays a separate range; an init segment adds none', async () => {
    const { sb } = await openSb();
    for (const buf of [initSegment(), segment(0, 4), segment(4, 8), segment(9, 12)]) {
      sb.appendBuffer(buf);
      await once(sb, 'updateend');
    }
    expect(sb.ranges()).toEqual([[0, 8], [9, 12]]);
    expect(sb.buffered.end(1)).toBe(12);
    expect(sb.appends[0]).toEqual({ init: true, bytes: 512 });
  });

  it('remove(a, b) cuts ranges and their bytes proportionally (keyframe every second)', async () => {
    const { sb } = await openSb({ keyframes: keyframesEvery(1) });
    sb.appendBuffer(segment(0, 10, 1000));
    await once(sb, 'updateend');
    sb.remove(0, 4);
    expect(sb.updating).toBe(true);
    await once(sb, 'updateend');
    expect(sb.ranges()).toEqual([[4, 10]]);
    expect(sb.bytes).toBe(600);
    sb.remove(6, 7);
    await once(sb, 'updateend');
    expect(sb.ranges()).toEqual([[4, 6], [7, 10]]);
    expect(sb.removes).toEqual([[0, 4], [6, 7]]);
  });

  // MSE coded frame removal: what follows the removed frames up to the next
  // random access point goes too (it can't be decoded without them).
  it('remove() also drops the frames up to the next keyframe (default: one per segment)', async () => {
    const { sb } = await openSb();
    sb.appendBuffer(segment(0, 4, 400));
    await once(sb, 'updateend');
    sb.appendBuffer(segment(4, 8, 400));
    await once(sb, 'updateend');
    sb.remove(0, 1.5); // mid-segment: the rest of 0–4 goes, 4–8 stays
    await once(sb, 'updateend');
    expect(sb.ranges()).toEqual([[4, 8]]);
    expect(sb.bytes).toBe(400);
    sb.remove(6, 7); // the tail of a segment after a removal has no keyframe left
    await once(sb, 'updateend');
    expect(sb.ranges()).toEqual([[4, 6]]);
    expect(sb.bytes).toBe(200);
    sb.remove(5, 6); // removing up to the end keeps the head
    await once(sb, 'updateend');
    expect(sb.ranges()).toEqual([[4, 5]]);
  });

  it('remove() with keyframes inside the segment keeps what starts at the next one', async () => {
    const { sb } = await openSb({ keyframes: keyframesEvery(2) });
    sb.appendBuffer(segment(0, 6, 600)); // keyframes 0, 2, 4
    await once(sb, 'updateend');
    sb.remove(0, 2.5);
    await once(sb, 'updateend');
    expect(sb.ranges()).toEqual([[4, 6]]);
    sb.appendBuffer(segment(6, 12, 600)); // keyframes 6, 8, 10
    await once(sb, 'updateend');
    sb.remove(7, 8); // ends on a keyframe: nothing more goes
    await once(sb, 'updateend');
    expect(sb.ranges()).toEqual([[4, 7], [8, 12]]);
    sb.remove(0, 9); // [8, 9) out, 9–10 not decodable, 10 is a keyframe
    await once(sb, 'updateend');
    expect(sb.ranges()).toEqual([[10, 12]]);
  });

  it('keyframes(): read per append, outside points ignored, none → the segment start', async () => {
    const { sb, mse } = await openSb({ keyframes: () => [-1, 99] });
    sb.appendBuffer(segment(0, 4));
    await once(sb, 'updateend');
    mse.options.keyframes = keyframesEvery(1);
    sb.appendBuffer(segment(4, 8));
    await once(sb, 'updateend');
    sb.remove(0, 5.5);
    await once(sb, 'updateend');
    expect(sb.ranges()).toEqual([[6, 8]]);
    expect(keyframesEvery(1.5)(3, 7)).toEqual([3, 4.5, 6]);
  });

  it('quotaBytes: an append past the budget throws QuotaExceededError synchronously', async () => {
    const { sb } = await openSb({ quotaBytes: 3000 });
    sb.appendBuffer(segment(0, 6, 2000));
    await once(sb, 'updateend');
    expect(() => sb.appendBuffer(segment(6, 12, 2000))).toThrow(expect.objectContaining({ name: 'QuotaExceededError' }));
    expect(sb.updating).toBe(false);
    sb.remove(0, 6);
    await once(sb, 'updateend');
    sb.appendBuffer(segment(6, 12, 2000));
    await once(sb, 'updateend');
    expect(sb.ranges()).toEqual([[6, 12]]);
  });

  it('quotaNext() and failNext(): one-shot QuotaExceededError / error + updateend', async () => {
    const { sb } = await openSb();
    sb.quotaNext();
    expect(() => sb.appendBuffer(segment(0, 2))).toThrow(expect.objectContaining({ name: 'QuotaExceededError' }));
    sb.failNext();
    const events = [];
    sb.addEventListener('error', () => events.push('error'));
    sb.addEventListener('updateend', () => events.push('updateend'));
    sb.appendBuffer(segment(0, 2));
    await once(sb, 'updateend');
    expect(events).toEqual(['error', 'updateend']);
    expect(sb.ranges()).toEqual([]);
    sb.appendBuffer(segment(0, 2));
    await once(sb, 'updateend');
    expect(sb.ranges()).toEqual([[0, 2]]);
  });

  it('appendMs > 0 makes an append take fake-clock time', async () => {
    const clock = useClock();
    const { sb } = await openSb({ appendMs: 200 });
    sb.appendBuffer(segment(0, 2));
    await clock.tick(150);
    expect(sb.updating).toBe(true);
    await clock.tick(60);
    expect(sb.updating).toBe(false);
    expect(sb.ranges()).toEqual([[0, 2]]);
  });

  it('ManagedMediaSource: setStreaming fires start/endstreaming, evict() drops ranges silently', async () => {
    const { ms, sb } = await openSb({ managed: 'only' });
    const seen = [];
    ms.addEventListener('startstreaming', () => seen.push('start'));
    ms.addEventListener('endstreaming', () => seen.push('end'));
    ms.setStreaming(false);
    expect(ms.streaming).toBe(false);
    ms.setStreaming(true);
    expect(seen).toEqual(['end', 'start']);
    sb.appendBuffer(segment(0, 20));
    await once(sb, 'updateend');
    sb.evict(0, 10);
    expect(sb.ranges()).toEqual([]); // one keyframe at 0: the rest of the segment goes with it
    expect(sb.removes).toEqual([]);
    sb.appendBuffer(segment(20, 30));
    await once(sb, 'updateend');
    sb.appendBuffer(segment(30, 40));
    await once(sb, 'updateend');
    sb.evict(20, 25);
    expect(sb.ranges()).toEqual([[30, 40]]);
    expect(sb.calls.filter((c) => c[0] === 'evict')).toEqual([['evict', 0, 10], ['evict', 20, 25]]);
  });

  it('a custom `map` decodes any buffer', async () => {
    const { sb } = await openSb({ map: (buf) => [buf.byteLength, buf.byteLength + 1] });
    sb.appendBuffer(new ArrayBuffer(7));
    await once(sb, 'updateend');
    expect(sb.ranges()).toEqual([[7, 8]]);
  });
});

describe('fake MediaSource drives the real feeder', () => {
  it('segfeed: a complete playlist goes in (init + every segment) and the stream is ended', async () => {
    const mse = installMSE();
    const { createSegFeeder } = await import('../../src/lib/segfeed.js');
    const clock = useClock();
    const segs = [0, 1, 2, 3].map((i) => ({ start: i * 4, end: i * 4 + 4, name: 's' + i }));
    const onFail = vi.fn();
    const feeder = createSegFeeder({
      prepare: async () => ({ codecs: 'avc1.640028,mp4a.40.2', duration: 16 }),
      playlist: async () => ({ segs, complete: true }),
      fetchInit: async () => initSegment(),
      fetchSeg: async (s) => segment(s.start, s.end, 4000),
      position: () => 0,
      onFail
    });
    expect(feeder.url).toBe(mse.last.url);
    expect(feeder.managed).toBe(false);
    await clock.tick(1000);
    const ms = mse.last;
    expect(onFail).not.toHaveBeenCalled();
    expect(ms.duration).toBe(16);
    expect(ms.sb.appends.map((a) => (a.init ? 'init' : a.start))).toEqual(['init', 0, 4, 8, 12]);
    expect(ms.sb.ranges()).toEqual([[0, 16]]);
    expect(ms.readyState).toBe('ended');
    feeder.stop();
    expect(mse.revoked).toEqual([feeder.url]);
  });
});
