/* activity.svelte.js: the /api/activity poll.
 *
 * CLAUDE.md (Download activity): polled every 4 s; it "backs off on remote idle
 * (10 min without key/wheel/pointer → every 60 s, 1 h → every 5 min; the first
 * input polls at once)"; "an unchanged answer is not re-assigned, so idle polls
 * cost no re-render"; activity.svelte.js hands every *changed* feed to onFeed()
 * (landed.svelte.js). Errors keep the last-known list; after 20 s without an
 * answer the feed is stale. (api() deadlines) "`mlFetch` 30 s (a hung call used
 * to wedge the activity poll's `inflight` flag)".
 * Phone (ARCHITECTURE "Performance"): "/api/activity polls every 4 s only while
 * a grab moves (else 30 s)"; boostActivity() holds the fast rate for 2 min
 * after the user started or cancelled something; the stale threshold allows
 * one slow-rate blip.
 *
 * Each test imports a fresh graph, then installs the fake clock (startActivity
 * re-reads Date.now(), so the module's import-time timestamps don't matter). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { freshImport } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock } from '../helpers/time.js';

const PHONE = __PHONE__;
const MIN = 60 * 1000;

let A, net, clock, t0, times, answer;

beforeEach(async () => {
  const m = await freshImport({ modules: { activity: 'src/lib/activity.svelte.js' } });
  A = m.activity;
  clock = useClock();
  t0 = Date.now();
  times = [];
  answer = () => ({ items: [] });
  net = mockFetch();
  net.on('GET', '/api/activity', () => {
    times.push(Date.now() - t0);
    return answer();
  });
});

afterEach(() => {
  A.stopActivity();
});

const polls = () => times.length;
const gaps = (from = 0, to = Infinity) => {
  const t = times.filter((x) => x >= from && x <= to);
  return t.slice(1).map((x, i) => x - t[i]);
};
const press = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));

function moving(o = {}) {
  return { id: 1, type: 'tv', title: 'Silo', status: 'downloading', progress: 0.1, download_speed: 1e6, media_id: '1', ...o };
}

describe('cadence', () => {
  it('startActivity polls at once', async () => {
    A.startActivity();
    await clock.tick(1);
    expect(polls()).toBe(1);
    expect(times[0]).toBe(0);
    expect(A.act.loaded).toBe(true);
  });

  it(PHONE ? 'phone, a grab moving: every 4 s' : 'TV: every 4 s', async () => {
    answer = () => ({ items: [moving()] });
    A.startActivity();
    await clock.tick(40000);
    expect(times).toEqual([0, 4000, 8000, 12000, 16000, 20000, 24000, 28000, 32000, 36000, 40000]);
  });

  it('a second startActivity does not add a second timer or poll', async () => {
    answer = () => ({ items: [moving()] });
    A.startActivity();
    A.startActivity();
    await clock.tick(8000);
    expect(times).toEqual([0, 4000, 8000]);
  });

  it('stopActivity stops every timer; a later start polls at once again', async () => {
    answer = () => ({ items: [moving()] });
    A.startActivity();
    await clock.tick(5000);
    A.stopActivity();
    // left: only the two answered requests' fake 30 s deadline timers (test helper), no interval
    expect(vi.getTimerCount()).toBe(2);
    await clock.tick(60000);
    expect(vi.getTimerCount()).toBe(0);
    expect(times).toEqual([0, 4000]);
    A.startActivity();
    await clock.tick(1);
    expect(times).toEqual([0, 4000, 65000]);
  });

  if (PHONE) {
    it('phone, nothing moving: every ~30 s (the next 4 s tick after 29.5 s)', async () => {
      answer = () => ({ items: [moving({ status: 'queued', download_speed: 0 })] });
      A.startActivity();
      await clock.tick(130000);
      expect(times).toEqual([0, 32000, 64000, 96000, 128000]);
    });

    it("phone: 'downloading' at speed 0 (stalledDL / importBlocked) is not moving", async () => {
      answer = () => ({ items: [moving({ download_speed: 0 })] });
      A.startActivity();
      await clock.tick(30000);
      expect(times).toEqual([0]);
    });

    it('phone: a change in the feed holds the 4 s rate for 2 min', async () => {
      let n = 0;
      answer = () => ({ items: [moving({ status: 'queued', download_speed: 0, progress: n++ < 2 ? 0 : 0.5 })] });
      A.startActivity();
      // baseline at 0 (the first answer is not a change), unchanged at 32 s, changed at 64 s
      await clock.tick(64000);
      expect(times).toEqual([0, 32000, 64000]);
      await clock.tick(2 * MIN);
      // 4 s cadence from 64 s until 2 min after the change (184 s), then slow again
      const fast = times.filter((t) => t > 64000 && t <= 184000);
      expect(gaps(64000, 184000).every((g) => g === 4000)).toBe(true);
      expect(fast.length).toBe(29);
      await clock.tick(40000);
      expect(times.filter((t) => t > 184000 && t <= 224000)).toEqual([212000]);
    });

    it('phone: boostActivity holds the 4 s rate for 2 min after an Add/Get/cancel', async () => {
      answer = () => ({ items: [] });
      A.startActivity();
      await clock.tick(4000);
      expect(times).toEqual([0]);
      A.boostActivity();
      await clock.tick(4000);
      expect(times).toEqual([0, 8000]);
      await clock.tick(2 * MIN);
      expect(gaps(8000, 124000).every((g) => g === 4000)).toBe(true);
      // boost over at 124 s: the slow rate again (next poll 30 s after the last one)
      expect(times.filter((t) => t > 120000)).toEqual([]);
      await clock.tick(24000);
      expect(times.filter((t) => t > 120000)).toEqual([152000]);
    });

    it('phone, stale: one slow-rate blip is not stale, two in a row are', async () => {
      answer = () => ({ items: [] });
      A.startActivity();
      await clock.tick(1);
      answer = () => net.status(502);
      await clock.tick(32000);
      expect(times).toEqual([0, 32000]);
      expect(A.act.stale).toBe(false);
      await clock.tick(32000);
      expect(A.act.stale).toBe(true);
    });
  } else {
    it('TV: boostActivity is a no-op (the TV polls at 4 s anyway)', async () => {
      A.boostActivity();
      A.startActivity();
      await clock.tick(8000);
      expect(times).toEqual([0, 4000, 8000]);
    });

    it('TV: nothing moving still polls every 4 s', async () => {
      answer = () => ({ items: [moving({ status: 'queued', download_speed: 0 })] });
      A.startActivity();
      await clock.tick(12000);
      expect(times).toEqual([0, 4000, 8000, 12000]);
    });
  }
});

describe('remote-idle back-off', () => {
  beforeEach(() => {
    answer = () => ({ items: [moving()] });
  });

  it('10 min without input → every 60 s; 1 h → every 5 min', async () => {
    A.startActivity();
    await clock.tick(10 * MIN);
    expect(gaps(0, 10 * MIN).every((g) => g === 4000)).toBe(true);
    expect(polls()).toBe(151);
    await clock.tick(50 * MIN);
    // between 10 min and 1 h: one poll a minute
    expect(gaps(10 * MIN, 60 * MIN)).toEqual(Array(50).fill(MIN));
    await clock.tick(60 * MIN);
    // past 1 h: one poll every 5 min (the last 4 s tick before 300 s - 0.5 s has passed is skipped)
    const late = gaps(61 * MIN, 120 * MIN);
    expect(late.length).toBeGreaterThan(5);
    expect(late.every((g) => g === 5 * MIN)).toBe(true);
  });

  it('the first input after idling polls at once and restores the 4 s cadence', async () => {
    A.startActivity();
    await clock.tick(15 * MIN);
    const before = polls();
    await clock.tick(20000);
    press();
    await clock.tick(1);
    expect(polls()).toBe(before + 1);
    expect(times[times.length - 1]).toBe(15 * MIN + 20000); // polled on the key press itself
    const pressAt = times[times.length - 1];
    await clock.tick(12000);
    expect(times.filter((t) => t > pressAt).length).toBe(3);
  });

  it.each([
    ['wheel', () => window.dispatchEvent(new WheelEvent('wheel'))],
    ['mousemove', () => window.dispatchEvent(new MouseEvent('mousemove'))],
    ['pointerdown', () => window.dispatchEvent(new Event('pointerdown'))]
  ])('%s counts as input', async (_n, fire) => {
    A.startActivity();
    await clock.tick(11 * MIN);
    const before = polls();
    fire();
    await clock.tick(1);
    expect(polls()).toBe(before + 1);
  });

  it('input while not idle does not poll early', async () => {
    A.startActivity();
    await clock.tick(1000);
    press();
    await clock.tick(1);
    expect(polls()).toBe(1);
  });

  it('input keeps the 4 s cadence going past 10 min', async () => {
    A.startActivity();
    for (let i = 0; i < 4; i++) {
      await clock.tick(5 * MIN);
      press();
    }
    expect(gaps(0, 20 * MIN).every((g) => g === 4000)).toBe(true);
  });

  it('input while stopped (the player) does not poll', async () => {
    A.startActivity();
    await clock.tick(11 * MIN);
    A.stopActivity();
    const before = polls();
    press();
    await clock.tick(1);
    expect(polls()).toBe(before);
  });

  it('the skipped idle ticks are not failures: a failing first poll after input is not stale at once', async () => {
    A.startActivity();
    await clock.tick(1);
    await clock.tick(30 * MIN);
    // idle polls run once a minute: go to 30 s after the last one (no poll in between)
    const last = times[times.length - 1];
    await clock.tick(last + 30000 - (Date.now() - t0));
    expect(times[times.length - 1]).toBe(last);
    // without the reset, 30 s since the last success would already be > 20 s → stale
    answer = () => net.status(500);
    press();
    await clock.tick(1);
    expect(A.act.stale).toBe(false);
  });

  it('reaching a browse screen counts as activity (startActivity resets the idle clock)', async () => {
    A.startActivity();
    await clock.tick(11 * MIN);
    A.stopActivity();
    A.startActivity();
    const at = times[times.length - 1];
    await clock.tick(8000);
    expect(times.filter((t) => t > at)).toEqual([at + 4000, at + 8000]);
  });
});

describe('changed answers only', () => {
  it('an unchanged answer keeps act.items identity and does not call onFeed', async () => {
    const feeds = [];
    A.onFeed((items) => feeds.push(items));
    answer = () => ({ items: [moving()] });
    A.startActivity();
    await clock.tick(1);
    const first = A.act.items;
    expect(first).toHaveLength(1);
    expect(feeds).toEqual([first]);
    await clock.tick(12000);
    expect(polls()).toBe(4);
    expect(A.act.items).toBe(first);
    expect(feeds).toHaveLength(1);
    answer = () => ({ items: [moving({ progress: 0.2 })] });
    await clock.tick(4000);
    expect(A.act.items).not.toBe(first);
    expect(A.act.items[0].progress).toBe(0.2);
    expect(feeds).toHaveLength(2);
    expect(feeds[1]).toBe(A.act.items);
  });

  it('the first answer is handed to onFeed even when empty; a missing items list reads as []', async () => {
    const feeds = [];
    A.onFeed((items) => feeds.push(items));
    answer = () => ({});
    A.startActivity();
    await clock.tick(1);
    expect(feeds).toEqual([[]]);
    expect(A.act.loaded).toBe(true);
  });

  it('a throwing onFeed hook does not break the poll', async () => {
    A.onFeed(() => {
      throw new Error('hook');
    });
    let n = 0;
    answer = () => ({ items: [moving({ progress: n++ / 10 })] });
    A.startActivity();
    await clock.tick(4001);
    expect(A.act.items[0].progress).toBe(0.1);
    expect(A.act.stale).toBe(false);
  });
});

describe('errors and staleness', () => {
  beforeEach(() => {
    answer = () => ({ items: [moving()] });
  });

  it('a failure keeps the last-known list; stale after > 20 s without an answer; the next good poll clears it', async () => {
    A.startActivity();
    await clock.tick(1);
    const list = A.act.items;
    answer = () => net.networkError();
    await clock.tick(20000);
    expect(A.act.items).toBe(list);
    expect(A.act.stale).toBe(false);
    await clock.tick(4000);
    expect(A.act.stale).toBe(true);
    expect(A.act.items).toBe(list);
    answer = () => ({ items: [moving()] });
    await clock.tick(4000);
    expect(A.act.stale).toBe(false);
  });

  it('never succeeded: stale counts from the first try', async () => {
    answer = () => net.status(503, { error: 'busy' });
    A.startActivity();
    // TV: failures every 4 s, stale once > 20 s; phone (nothing moving): every 32 s, stale once > 50 s
    await clock.tick(PHONE ? 32000 : 20000);
    expect(A.act.stale).toBe(false);
    expect(A.act.loaded).toBe(false);
    await clock.tick(PHONE ? 32000 : 4000);
    expect(A.act.stale).toBe(true);
    expect(A.act.loaded).toBe(false);
  });

  it('a stop/start (a stretch of playback) is not a failure', async () => {
    A.startActivity();
    await clock.tick(1);
    A.stopActivity();
    await clock.tick(2 * MIN);
    answer = () => net.networkError();
    A.startActivity();
    await clock.tick(1);
    expect(A.act.stale).toBe(false);
  });

  it('a hung request is cut by the 30 s mlFetch deadline and does not wedge later polls', async () => {
    A.startActivity();
    await clock.tick(1);
    answer = () => net.hang();
    await clock.tick(3999);
    expect(polls()).toBe(2);
    // ticks while it hangs are skipped (inflight), the feed is not stale yet
    await clock.tick(25000);
    expect(polls()).toBe(2);
    expect(A.act.stale).toBe(false);
    // the deadline fires at 4 s + 30 s: the hang is a failure > 20 s after the last success
    await clock.tick(5001);
    expect(A.act.stale).toBe(true);
    answer = () => ({ items: [moving({ progress: 0.9 })] });
    await clock.tick(4000);
    expect(polls()).toBe(3);
    expect(A.act.stale).toBe(false);
    expect(A.act.items[0].progress).toBe(0.9);
  });
});
