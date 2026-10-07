/* activity.svelte.js: edges found by mutation testing (hardening round,
 * Stryker on activity.svelte.js). Each pins documented behaviour the
 * activity.groups / activity.poll tests left loose:
 *   - before the first answer the feed is empty, not loaded, not stale;
 *   - remote input is seen in the capture phase: a screen's keydown handler that
 *     stops propagation (Home's pageKey, MovieDetail's pageKey …) must not hide
 *     the key from the idle back-off;
 *   - phone: only a `downloading` grab with a live speed is "moving"
 *     (`queued`/`paused`/`warning` alone are not);
 *   - episodes sort by season, then episode; the longest ETA is found on the
 *     whole "d.hh:mm:ss" / "hh:mm:ss" / "mm:ss" value;
 *   - humanBytes: one decimal *below* 10, none for bytes. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshImport } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock } from '../helpers/time.js';

const PHONE = __PHONE__;
const MIN = 60 * 1000;

let A;

beforeEach(async () => {
  const m = await freshImport({ modules: { activity: 'src/lib/activity.svelte.js' } });
  A = m.activity;
});

afterEach(() => {
  A.stopActivity();
});

let nid = 0;
function tv(o = {}) {
  nid++;
  return { id: nid, type: 'tv', title: 'Silo', status: 'queued', progress: 0, media_id: '403245', season: 1, episode: nid, ...o };
}

describe('state before the first answer', () => {
  it('no items, not loaded, not stale', () => {
    expect(A.act.items).toEqual([]);
    expect(A.act.loaded).toBe(false);
    expect(A.act.stale).toBe(false);
    expect(A.pendingGroups('tv')).toEqual([]);
  });
});

describe('the poll', () => {
  let clock, times, answer;
  beforeEach(() => {
    clock = useClock();
    const t0 = Date.now();
    times = [];
    answer = () => ({ items: [] });
    const net = mockFetch();
    net.on('GET', '/api/activity', () => {
      times.push(Date.now() - t0);
      return answer();
    });
  });

  it('a key a screen handler stops from propagating still counts as input (capture phase)', async () => {
    answer = () => ({ items: [{ id: 1, type: 'tv', title: 'Silo', status: 'downloading', progress: 0.1, download_speed: 1e6, media_id: '1' }] });
    const page = document.createElement('div');
    page.tabIndex = 0;
    document.body.appendChild(page);
    page.addEventListener('keydown', (e) => e.stopPropagation()); // like Home's pageKey
    try {
      A.startActivity();
      await clock.tick(11 * MIN); // idle: one poll a minute now
      const before = times.length;
      page.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await clock.tick(1);
      expect(times.length).toBe(before + 1); // polled at once on the key
    } finally {
      page.remove();
    }
  });

  if (PHONE) {
    it.each(['warning', 'paused', 'queued', 'importing'])("phone: a '%s' grab is not moving even with a speed reported", async (status) => {
      answer = () => ({ items: [{ id: 1, type: 'tv', title: 'Silo', status, progress: 0.4, download_speed: 5e5, media_id: '1' }] });
      A.startActivity();
      await clock.tick(30000);
      expect(times).toEqual([0]);
    });
  }
});

describe('older backend', () => {
  it('a tv item with its episode but no season is completed from the subtitle', async () => {
    const net = mockFetch();
    net.on('GET', '/api/activity', { items: [{ id: 1, type: 'tv', title: 'X', status: 'queued', episode: 6, subtitle: 'S05E06 · Parsed' }] });
    A.startActivity();
    A.stopActivity();
    for (let i = 0; i < 10 && !A.act.loaded; i++) await new Promise((r) => setTimeout(r, 0));
    const [a] = A.act.items;
    expect([a.season, a.episode, a.episode_title]).toEqual([5, 6, 'Parsed']);
  });
});

describe('grouping details', () => {
  it('episodes of one season given out of order are sorted by episode', () => {
    A.act.items = [tv({ season: 1, episode: 9 }), tv({ season: 1, episode: 2 }), tv({ season: 1, episode: 5 })];
    expect(A.pendingGroups('tv')[0].items.map((i) => i.episode)).toEqual([2, 5, 9]);
  });

  it('the longest ETA wins on the whole value, not its first digit', () => {
    A.act.items = [tv({ download_id: 'a', timeleft: '9:59' }), tv({ download_id: 'b', timeleft: '1:00:00' })];
    expect(A.pendingGroups('tv')[0].timeleft).toBe('1:00:00');
    A.act.items = [tv({ download_id: 'a', timeleft: '1.00:00:00' }), tv({ download_id: 'b', timeleft: '9:00:00' })];
    expect(A.pendingGroups('tv')[0].timeleft).toBe('1.00:00:00');
    A.act.items = [tv({ download_id: 'a', timeleft: '3.00:00:00' }), tv({ download_id: 'b', timeleft: '2.23:59:59' })];
    expect(A.pendingGroups('tv')[0].timeleft).toBe('3.00:00:00');
    // same shape, every digit counts
    A.act.items = [tv({ download_id: 'a', timeleft: '1:00:00' }), tv({ download_id: 'b', timeleft: '2:00:00' })];
    expect(A.pendingGroups('tv')[0].timeleft).toBe('2:00:00');
    A.act.items = [tv({ download_id: 'a', timeleft: '12:30' }), tv({ download_id: 'b', timeleft: '12:31' })];
    expect(A.pendingGroups('tv')[0].timeleft).toBe('12:31');
    // the clock part after a day count counts too
    A.act.items = [tv({ download_id: 'a', timeleft: '1.06:00:00' }), tv({ download_id: 'b', timeleft: '1.12:00:00' })];
    expect(A.pendingGroups('tv')[0].timeleft).toBe('1.12:00:00');
  });
});

describe('humanBytes edges', () => {
  it('exactly 10 of a unit has no decimal; single bytes never do', () => {
    expect(A.humanBytes(10 * 1024 * 1024)).toBe('10 MB');
    expect(A.humanBytes(9.96 * 1024 * 1024)).toBe('10.0 MB'); // still below 10 before rounding
    expect(A.humanBytes(5)).toBe('5 B');
    expect(A.humanBytes(1)).toBe('1 B');
  });
});
