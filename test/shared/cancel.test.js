/* cancel.svelte.js: the phone's "Cancel download" (only the phone imports it,
 * but it is plain shared src/lib code, so it is tested in both projects).
 *
 * CLAUDE.md (iPhone app → Phone-only backend features): "`DELETE
 * /api/activity/{type}/{id}` cancels a grab (`src/lib/cancel.svelte.js`: a
 * torrent goes whole, a season pack cancels every episode; the arr is
 * unmonitored so it doesn't re-grab)". The module comment: rows dim at once
 * (`cancelling`, by activity item id) for up to 60 s, a failed cancel un-dims
 * them; 404 'not_in_queue' = already gone (treated as done); 409 'importing'. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { freshImport, TEST_MEDIALIB } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock } from '../helpers/time.js';

let C, A, T, net, clock;
const ACT = TEST_MEDIALIB + '/api/activity';

beforeEach(async () => {
  ({ C, A, T } = await freshImport({
    modules: { C: 'src/lib/cancel.svelte.js', A: 'src/lib/activity.svelte.js', T: 'src/lib/toast.svelte.js' }
  }));
  net = mockFetch();
  clock = useClock();
});

let nid = 0;
const ep = (o = {}) => ({ id: 'q' + ++nid, type: 'tv', title: 'Silo', media_id: '403245', season: 2, episode: nid, status: 'downloading', progress: 10, download_id: 'h-' + nid, ...o });
const mv = (o = {}) => ({ id: 'q' + ++nid, type: 'movie', title: 'Dune: Part Two', media_id: '693134', status: 'downloading', progress: 10, download_id: 'h-' + nid, ...o });

/* a season pack: one torrent, n episodes */
function pack(n, o = {}) {
  return Array.from({ length: n }, (_, i) => ep({ download_id: 'pack-1', episode: i + 1, ...o }));
}

describe('packOf / cancelWhat', () => {
  it('a torrent goes whole: every row sharing its download_id', () => {
    const p = pack(6);
    const other = ep({ season: 3, episode: 1 });
    A.act.items = [...p, other];
    expect(C.packOf(p[2])).toEqual(p);
    expect(C.packOf(other)).toEqual([other]);
  });

  it('without a download_id, or not in the feed: just the item', () => {
    const lone = ep({ download_id: undefined });
    A.act.items = [lone];
    expect(C.packOf(lone)).toEqual([lone]);
    const off = ep();
    expect(C.packOf(off)).toEqual([off]);
  });

  it('"S2 · E3", "Season 2 · 6 episodes", a mixed pack just "N episodes", a movie its title', () => {
    A.act.items = [];
    expect(C.cancelWhat(ep({ season: 2, episode: 3 }))).toBe('S2 · E3');
    expect(C.cancelWhat(ep({ season: null, episode: undefined }))).toBe('S? · E?');
    const p = pack(6);
    A.act.items = p;
    expect(C.cancelWhat(p[0])).toBe('Season 2 · 6 episodes');
    const mixed = [ep({ download_id: 'm', season: 1 }), ep({ download_id: 'm', season: 2 })];
    A.act.items = mixed;
    expect(C.cancelWhat(mixed[0])).toBe('2 episodes');
    const noSeason = [ep({ download_id: 'n', season: null }), ep({ download_id: 'n', season: null })];
    A.act.items = noSeason;
    expect(C.cancelWhat(noSeason[0])).toBe('2 episodes');
    expect(C.cancelWhat(mv())).toBe('Dune: Part Two');
  });

  it('confirmItems spells a season pack out', () => {
    const fn = vi.fn();
    const one = C.confirmItems('S2 · E3', 1, fn);
    expect(one[0]).toEqual({ label: 'Cancel S2 · E3? What has arrived so far is deleted.', disabled: true });
    expect(one[1]).toMatchObject({ label: 'Cancel download', danger: true, action: fn });
    expect(one[2]).toEqual({ sep: true });
    expect(one[3].label).toBe('Keep downloading');
    expect(one[3].action()).toBeUndefined();   // just closes the menu: the cancel is not run
    expect(fn).not.toHaveBeenCalled();
    const many = C.confirmItems('Season 2 · 6 episodes', 6, fn);
    expect(many[0].label).toBe('They come as one download. Cancel Season 2 · 6 episodes? What has arrived so far is deleted.');
    expect(many[1].label).toBe('Cancel all 6 episodes');
  });
});

describe('cancelItem', () => {
  it('an episode: DELETE /api/activity/tv/{media_id}?season=&episode=, its pack dims at once', async () => {
    const p = pack(3);
    A.act.items = p;
    let dimmedDuring;
    net.on('DELETE', () => true, () => {
      dimmedDuring = p.map((r) => C.isCancelling(r));
      return { status: 'cancelled' };
    });
    expect(await C.cancelItem(p[1])).toBe(true);
    expect(net.calls[0].url).toBe(ACT + '/tv/403245?season=2&episode=2');
    expect(dimmedDuring).toEqual([true, true, true]);
    expect(T.toastState.msg).toBe('Cancelled — Silo Season 2 · 3 episodes');
  });

  it('a movie: no season/episode; the dim lasts 60 s if the row stays in the feed', async () => {
    const m = mv();
    A.act.items = [m];
    net.on('DELETE', ACT + '/movie/693134', { status: 'cancelled' });
    expect(await C.cancelItem(m)).toBe(true);
    expect(T.toastState.msg).toBe('Cancelled — Dune: Part Two');
    expect(C.isCancelling(m)).toBe(true);
    await clock.tick(59000);
    expect(C.isCancelling(m)).toBe(true);
    await clock.tick(1000);
    expect(C.isCancelling(m)).toBe(false);
  });

  it('a whole season row (no episode) sends only the season', async () => {
    const s = ep({ episode: null });
    A.act.items = [s];
    net.on('DELETE', () => true, {});
    await C.cancelItem(s);
    expect(net.calls[0].url).toBe(ACT + '/tv/403245?season=2');
  });

  it('404 (not in the queue any more) is what the user wanted', async () => {
    const m = mv();
    net.on('DELETE', () => true, net.status(404, { error: 'not_in_queue', detail: 'x' }));
    expect(await C.cancelItem(m)).toBe(true);
    expect(T.toastState.msg).toBe('Already gone — Dune: Part Two');
  });

  it.each([
    ['409 importing', (n) => n.status(409, { error: 'importing', detail: 'x' }), 'Too late — it’s being added to your library'],
    ['503', (n) => n.status(503, { error: 'busy', detail: 'x' }), 'Library busy — try again in a moment'],
    ['500', (n) => n.status(500, { detail: 'qBittorrent said no' }), 'Couldn’t cancel: qBittorrent said no'],
    ['403 not_owner', (n) => n.status(403, { error: 'not_owner', detail: 'Only the person who added “Silo” can cancel its download.' }), 'Only the person who added “Silo” can cancel its download.']
  ])('%s: false, the rows un-dim, the toast says why', async (_, answer, msg) => {
    const p = pack(2);
    A.act.items = p;
    net.on('DELETE', () => true, answer(net));
    expect(await C.cancelItem(p[0])).toBe(false);
    expect(p.map((r) => C.isCancelling(r))).toEqual([false, false]);
    expect(T.toastState.msg).toBe(msg);
  });

  it('no media_id (an older backend): nothing sent', async () => {
    expect(await C.cancelItem(mv({ media_id: null }))).toBe(false);
    expect(T.toastState.msg).toBe('Can’t cancel this one from here');
    expect(net.calls).toEqual([]);
  });
});

describe('cancelGroup', () => {
  it('cancels the whole title, dims every row incl. other episodes of its torrents, marks the group', async () => {
    const p = pack(2);
    const single = ep({ season: 3, episode: 1 });
    const unrelated = ep({ media_id: '1', title: 'Andor' });
    A.act.items = [...p, single, unrelated];
    const g = A.pendingGroups('tv').find((x) => x.mediaId === '403245');
    let dims;
    net.on('DELETE', ACT + '/tv/403245', () => {
      dims = [...p, single, unrelated].map((r) => C.isCancelling(r));
      return { status: 'cancelled' };
    });
    expect(await C.cancelGroup(g)).toBe(true);
    expect(dims).toEqual([true, true, true, false]);
    expect(C.cancelledGroups[g.key]).toBe(true);
    expect(T.toastState.msg).toBe('Cancelled — Silo');
  });

  it('a failed group cancel does not mark it', async () => {
    const m = mv();
    A.act.items = [m];
    const g = A.pendingGroups('movie')[0];
    net.on('DELETE', () => true, net.status(500));
    expect(await C.cancelGroup(g)).toBe(false);
    expect(C.cancelledGroups[g.key]).toBeUndefined();
    expect(C.isCancelling(m)).toBe(false);
  });

  it('a group without a media id: nothing sent', async () => {
    expect(await C.cancelGroup({ key: 'tv:t:x', type: 'tv', mediaId: null, title: 'x', items: [] })).toBe(false);
    expect(net.calls).toEqual([]);
  });
});

/* run/design.md §6.1 / §7.5: the server marks each activity row with
 * can_cancel (admin, or the caller's own title / requested season); a row
 * without the field comes from an older backend, where everyone could cancel. */
describe('canCancel / canCancelGroup', () => {
  it('can_cancel false → no; true or absent (older backend) → yes', () => {
    expect(C.canCancel(mv({ can_cancel: false }))).toBe(false);
    expect(C.canCancel(mv({ can_cancel: true }))).toBe(true);
    expect(C.canCancel(mv())).toBe(true);
  });

  it('a group only when every row may be cancelled (a cancel takes them all)', () => {
    expect(C.canCancelGroup({ items: [ep({ can_cancel: true }), ep({ can_cancel: true })] })).toBe(true);
    expect(C.canCancelGroup({ items: [ep(), ep()] })).toBe(true);
    expect(C.canCancelGroup({ items: [ep({ can_cancel: true }), ep({ can_cancel: false })] })).toBe(false);
  });

  it('a row only when every row of its torrent may be cancelled (a pack goes whole)', () => {
    const mine = ep({ download_id: 'mixed', season: 2, can_cancel: true });
    const theirs = ep({ download_id: 'mixed', season: 1, can_cancel: false });
    const lone = ep({ can_cancel: true });
    A.act.items = [mine, theirs, lone];
    expect(C.canCancel(mine)).toBe(true);
    expect(C.canCancelPack(mine)).toBe(false);
    expect(C.canCancelPack(lone)).toBe(true);
    expect(C.canCancelPack(ep({ can_cancel: false }))).toBe(false); // not in the feed: just itself
    A.act.items = [ep({ download_id: 'old' }), ep({ download_id: 'old' })]; // older backend: no flags
    expect(C.canCancelPack(A.act.items[0])).toBe(true);
  });
});
