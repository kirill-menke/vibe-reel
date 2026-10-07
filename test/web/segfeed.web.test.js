/* segfeed.js in the web build: the one web-only rule (segfeed.js gap jumping).
 *
 * A far seek restarts Jellyfin's job at the keyframe there, and the restarted
 * job's first AAC frame comes ~0.5 s after it: a seek onto the segment start
 * then sits just before the muxed buffered range and nothing ever plays
 * (measured, Firefox 156). In the web build the feeder steps forward onto the
 * range when it starts less than 1 s ahead of the playhead. (Phone builds
 * fold the rule away — test/phone/segfeed.* keep their behaviour.) */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSegFeeder } from '../../src/lib/segfeed.js';
import { installMSE } from '../helpers/mse.js';
import { useClock } from '../helpers/time.js';

let clock, feeder, jump, pos;

beforeEach(() => {
  clock = useClock();
  jump = vi.fn();
  pos = 0;
  feeder = null;
});
afterEach(() => feeder?.stop());

async function run(ms = 0) {
  await clock.tick(ms);
  for (let i = 0; i < 5; i++) await clock.tick(0);
}

/* one segment 2000–2006 whose buffered range starts `lead` s late */
function start(lead, opts = {}) {
  installMSE({ map: (b) => b.range || null });
  const segs = [{ start: 2000, end: 2006, name: 's333' }];
  feeder = createSegFeeder({
    prepare: async () => ({ codecs: 'avc1.640028,mp4a.40.2', duration: 2006 }),
    playlist: async () => ({ segs, complete: true }),
    fetchInit: async () => ({ byteLength: 600, range: null }),
    fetchSeg: async (s) => ({ byteLength: 1000, range: [s.start + lead, s.end] }),
    position: () => pos,
    jump: opts.noJump ? undefined : jump,
    onFail: vi.fn()
  });
}

describe('web: a playhead just before the first buffered range', () => {
  it('less than 1 s before it: jumps onto the range', async () => {
    pos = 2000;
    start(0.48);
    await run(10);
    expect(jump.mock.calls[0][0]).toBeCloseTo(2000.53, 6);
  });

  it('1 s or more before it: no jump (that is a hole to fetch, not a gap to step over)', async () => {
    pos = 2000;
    start(1.2);
    await run(10);
    expect(jump).not.toHaveBeenCalled();
  });

  it('inside the range, or no jump hook: nothing', async () => {
    pos = 2001;
    start(0.48);
    await run(10);
    expect(jump).not.toHaveBeenCalled();
    feeder.stop();
    pos = 2000;
    start(0.48, { noJump: true });
    await run(10);
    expect(jump).not.toHaveBeenCalled();
  });
});
