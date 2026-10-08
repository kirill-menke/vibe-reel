/* trailerstream.js createTrailerSource() in the desktop web build, and the
 * edges its other suites left open (the coverage ratchet pins its branches):
 *   - a codec the browser's MediaSource refuses fails as "this browser
 *     refuses …" (the web build's wording; the iPhone's and TV's are theirs);
 *   - an error answer without a detail or error field reads "HTTP <status>";
 *   - no position hook: the playhead counts as 0;
 *   - stop() at any await of the start — the status poll, the preload, its
 *     appends, the first fetch of the feeding loop — ends the run quietly:
 *     nothing more is fetched or appended, onFail and onInfo stay silent. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTrailerSource } from '../../src/lib/trailerstream.js';
import { cfg } from '../../src/lib/config.js';
import { installMSE } from '../helpers/mse.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock } from '../helpers/time.js';
import { TEST_MEDIALIB } from '../helpers/modules.js';
import { trailerServer, uniform, READY } from '../helpers/trailer.js';

const ID = 'n9xhJrPXop4';
const BASE = TEST_MEDIALIB + '/api/trailers/' + ID + '@1080';

let clock, net, mse, onFail, onInfo, src, srv;

beforeEach(() => {
  cfg.medialib = TEST_MEDIALIB;
  clock = useClock();
  net = mockFetch();
  onFail = vi.fn();
  onInfo = vi.fn();
  src = null;
});

afterEach(() => {
  src?.stop();
});

function start(o = {}, hooks = {}) {
  mse = installMSE(o.mse || {});
  srv = trailerServer({ ...o, net, mse: () => mse, base: BASE });
  src = createTrailerSource(ID, { onFail, onInfo, position: () => 0, jump: () => {}, ...hooks });
  return src;
}
const appended = () => (mse.last && mse.last.sb ? mse.last.sb.appends.length : 0);

describe('failures, in the web build’s words', () => {
  it('a codec this browser’s MediaSource refuses', async () => {
    start({ mse: { supported: () => false }, status: [{ ...READY, codecs: 'hvc1.2.4.L153,ec-3' }] });
    await clock.tick(50);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0].message).toBe('this browser refuses video/mp4; codecs="hvc1.2.4.L153,ec-3"');
  });

  it('an error answer with no detail or error field: "HTTP <status>"', async () => {
    start({ status: [{ httpStatus: 502, body: { ok: false } }] });
    await clock.tick(50);
    expect(onFail.mock.calls[0][0].message).toBe('HTTP 502');
  });
});

describe('no position hook', () => {
  it('feeds from the start as if the playhead were at 0', async () => {
    start({ segs: uniform(25) }, { position: undefined, jump: undefined });
    await clock.tick(200);
    expect(onFail).not.toHaveBeenCalled();
    expect(srv.fetched.slice(0, 3)).toEqual(['init.mp4', 's000.m4s', 's001.m4s']);
    // fills the window ahead of 0 (30 s in the phone/web build: up to the
    // segment that starts before 30 s) and stops there
    expect(srv.fetched).toContain('s007.m4s');
    expect(srv.fetched).not.toContain('s008.m4s');
  });
});

describe('stop() during the start ends it quietly', () => {
  it('while the status poll that says "ready" is in flight', async () => {
    let n = 0;
    start({
      status: () => {
        n++;
        if (n === 1) return { state: 'downloading', buffered_s: 0, subs_done: true };
        src.stop(); // the answer still arrives — then the run gives up
        return READY;
      }
    });
    await clock.tick(1000);
    expect(n).toBe(2);
    expect(onInfo).not.toHaveBeenCalled();
    expect(srv.fetched).toEqual([]);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('while a preload segment downloads', async () => {
    start({ hold: (name) => name === 's000.m4s' });
    await clock.tick(20);
    expect(srv.held.has('s000.m4s')).toBe(true);
    src.stop();
    srv.release('s000.m4s');
    await clock.tick(500);
    expect(srv.fetched).toEqual(['init.mp4', 's000.m4s']);
    expect(appended()).toBe(0);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('between the preload’s appends', async () => {
    start({ mse: { appendMs: 100 } });
    await clock.tick(60); // init is being appended (an append is recorded as it starts)
    expect(appended()).toBe(1);
    expect(mse.last.sb.updating).toBe(true);
    src.stop();
    await clock.tick(1000);
    expect(appended()).toBe(1); // init only — no preload segment after the stop
    expect(onFail).not.toHaveBeenCalled();
  });

  it('while the feeding loop’s first segment downloads', async () => {
    start({ hold: (name) => name === 's002.m4s' });
    await clock.tick(50);
    expect(srv.held.has('s002.m4s')).toBe(true);
    const before = appended();
    src.stop();
    srv.release('s002.m4s');
    await clock.tick(1000);
    expect(appended()).toBe(before);
    expect(srv.fetched.at(-1)).toBe('s002.m4s');
    expect(onFail).not.toHaveBeenCalled();
  });
});
