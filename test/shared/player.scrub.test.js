/* player.svelte.js — trickplay scrubbing (lookUpTrickplay / trickAt / scrubBy /
 * commitScrub / cancelScrub) and the post-seek position guard (effectivePos).
 *
 * CLAUDE.md, "Trickplay": the item's Trickplay field gives the sheet layout; a
 * thumbnail is a background-position crop of /Videos/{id}/Trickplay/{width}/
 * {sheet}.jpg. With a layout, ◀▶ move a pending P.scrub target (10 s steps,
 * accelerating to 30/60 s on auto-repeat) and the one real seek happens after
 * 900 ms of rest, on OK, or on ▼ off the scrubber; Back abandons it. Without
 * trickplay, ◀▶ keep seeking 30 s per press. ⚠️ Sheet URLs need ApiKey= —
 * 12.1 answers api_key= with 401 on the Trickplay endpoint.
 * "Seeking keeps a private seekTarget for ~900ms after a seek because
 * video.currentTime transiently reads garbage on this TV, which used to make
 * the scrubber jump to 0." */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie } from '../helpers/media.js';

/** Jellyfin TrickplayInfo: 10×10 tiles of 320×180, one every 10 s, 270 thumbnails (3 sheets) */
function layout(o = {}) {
  return { Width: 320, Height: 180, TileWidth: 10, TileHeight: 10, ThumbnailCount: 270, Interval: 10000, Bandwidth: 1, ...o };
}

/** new Image().src = … (the sheet warm-up) recorded instead of loaded */
function stubImage() {
  const warmed = [];
  vi.stubGlobal(
    'Image',
    class {
      set src(v) {
        warmed.push(v);
      }
    }
  );
  return warmed;
}

async function scrubbable(o = {}) {
  const m = movie();
  const sid = m.MediaSources[0].Id;
  const h = await startPlayer({ item: m, trickplay: o.trickplay || { [sid]: { 480: layout({ Width: 480, Height: 270 }), 320: layout() } } });
  await h.settle();
  return Object.assign(h, { sid });
}

/** the playhead is at t (playing there, not a seek) */
function at(h, t) {
  h.video.setTime(t);
  h.video.emit('timeupdate');
}

const sheetUrl = (h, res, i) => 'http://jf.test/Videos/' + h.id + '/Trickplay/' + res + '/' + i + '.jpg?MediaSourceId=' + h.sid + '&ApiKey=tok-u1';

describe('lookUpTrickplay: the layout', () => {
  beforeAll(warmPlayer, 120000);

  it('takes the narrowest resolution of the playing source', async () => {
    const h = await scrubbable();
    expect(h.P.trick).toEqual({ id: h.id, sourceId: h.sid, res: 320, w: 320, h: 180, cols: 10, rows: 10, count: 270, interval: 10 });
  });

  it('matches a source id written without dashes, else takes the first source listed', async () => {
    const m = movie();
    m.MediaSources[0].Id = 'aa-bb-cc';
    const h = await startPlayer({ item: m, trickplay: { aabbcc: { 320: layout({ ThumbnailCount: 5 }) } } });
    await h.settle();
    expect(h.P.trick).toMatchObject({ sourceId: 'aa-bb-cc', count: 5 });

    const o = await startPlayer({ item: movie(), trickplay: { 'some-other-source': { 320: layout({ ThumbnailCount: 7 }) } } });
    await o.settle();
    expect(o.P.trick).toMatchObject({ count: 7 });
  });

  it('the playing source wins over one listed before it, by exact or dashless id', async () => {
    const m = movie();
    const sid = m.MediaSources[0].Id;
    const h = await startPlayer({ item: m, trickplay: { 'other-source': { 320: layout({ ThumbnailCount: 7 }) }, [sid]: { 320: layout({ ThumbnailCount: 5 }) } } });
    await h.settle();
    expect(h.P.trick).toMatchObject({ sourceId: sid, count: 5 });

    const d = movie();
    d.MediaSources[0].Id = 'aa-bb-cc';
    const g = await startPlayer({ item: d, trickplay: { 'other-source': { 320: layout({ ThumbnailCount: 7 }) }, aabbcc: { 320: layout({ ThumbnailCount: 5 }) } } });
    await g.settle();
    expect(g.P.trick).toMatchObject({ sourceId: 'aa-bb-cc', count: 5 });
  });

  // A layout answer belongs to its own start: closed and started again, the first
  // start's late answer must not land on the second.
  it("a late answer from an earlier start of the same item doesn't overwrite the new one", async () => {
    const m = movie();
    const sid = m.MediaSources[0].Id;
    const pending = [];
    const h = await startPlayer({
      item: m,
      routes: (net) =>
        net.on('GET', (r) => r.path === '/Items' && new URLSearchParams(r.query).get('Fields') === 'Trickplay,Chapters', () =>
          pending.length === 0
            ? new Promise((res) => pending.push(() => res({ Items: [{ Id: m.Id, Trickplay: { [sid]: { 320: layout({ ThumbnailCount: 7 }) } } }] })))
            : { Items: [{ Id: m.Id, Trickplay: { [sid]: { 320: layout({ ThumbnailCount: 5 }) } } }] }
        )
    });
    await h.settle();
    expect(pending).toHaveLength(1);
    h.player.exitPlayer();
    h.S.screen = 'detail';
    h.player.playItem(m, 0);
    await h.settle();
    h.video.setDuration(3600);
    h.video.emit('loadedmetadata');
    await h.settle();
    expect(h.P.trick).toMatchObject({ count: 5 });
    pending[0]();
    await h.settle();
    expect(h.P.trick).toMatchObject({ count: 5 });
  });

  it('no layout, or one without thumbnails, is no trickplay', async () => {
    const a = await startPlayer({ item: movie() });
    await a.settle();
    expect(a.P.trick).toBe(null);
    const m = movie();
    const b = await startPlayer({ item: m, trickplay: { [m.MediaSources[0].Id]: { 320: layout({ ThumbnailCount: 0 }) } } });
    await b.settle();
    expect(b.P.trick).toBe(null);
    expect(b.player.trickAt(100)).toBe(null);
  });
});

describe('trickAt: the sheet crop for a position', () => {
  beforeAll(warmPlayer, 120000);

  it('sheet index, x and y from the layout', async () => {
    const h = await scrubbable();
    expect(h.player.trickAt(0)).toEqual({ url: sheetUrl(h, 320, 0), x: 0, y: 0 });
    expect(h.player.trickAt(9.9)).toEqual({ url: sheetUrl(h, 320, 0), x: 0, y: 0 });
    // thumbnail 12: sheet 0, column 2, row 1
    expect(h.player.trickAt(125)).toEqual({ url: sheetUrl(h, 320, 0), x: 640, y: 180 });
    // thumbnail 199: the last tile of sheet 1
    expect(h.player.trickAt(1995)).toEqual({ url: sheetUrl(h, 320, 1), x: 9 * 320, y: 9 * 180 });
    // thumbnail 200: the first of sheet 2
    expect(h.player.trickAt(2000)).toEqual({ url: sheetUrl(h, 320, 2), x: 0, y: 0 });
  });

  it('clamps to [0, count − 1]', async () => {
    const h = await scrubbable();
    expect(h.player.trickAt(-50)).toEqual({ url: sheetUrl(h, 320, 0), x: 0, y: 0 });
    // thumbnail 269 = sheet 2, tile 69: column 9, row 6
    expect(h.player.trickAt(99999)).toEqual({ url: sheetUrl(h, 320, 2), x: 9 * 320, y: 6 * 180 });
  });

  it('sheet URLs authenticate with ApiKey=, never api_key=', async () => {
    const h = await scrubbable();
    const u = new URL(h.player.trickAt(0).url);
    expect(u.searchParams.get('ApiKey')).toBe('tok-u1');
    expect(u.searchParams.get('MediaSourceId')).toBe(h.sid);
    expect(u.search).not.toMatch(/api_key/);
  });
});

describe('scrubBy: a pending target with acceleration', () => {
  beforeAll(warmPlayer, 120000);

  it('10 s steps, 30 s from the 6th repeat, 60 s from the 20th', async () => {
    stubImage();
    const h = await scrubbable();
    at(h, 100);
    const seeks = h.video.seeks.length;
    const got = [];
    h.player.scrubBy(1, false);
    got.push(h.P.scrub);
    for (let r = 1; r <= 22; r++) {
      h.player.scrubBy(1, true);
      got.push(h.P.scrub);
    }
    const steps = got.map((v, i) => v - (i ? got[i - 1] : 100));
    expect(steps).toEqual([10, 10, 10, 10, 10, 10, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 60, 60, 60]);
    expect(h.video.seeks.length).toBe(seeks);   // nothing seeked yet
    // a fresh press (no repeat) starts over at 10 s, from the pending target
    h.player.scrubBy(-1, false);
    expect(h.P.scrub).toBe(got.at(-1) - 10);
  });

  it('clamped to [0, duration − 1]', async () => {
    stubImage();
    const h = await scrubbable();
    const dur = h.video.duration;
    at(h, 5);
    h.player.scrubBy(-1, false);
    expect(h.P.scrub).toBe(0);
    at(h, dur - 4);
    h.player.cancelScrub();
    h.player.scrubBy(1, false);
    expect(h.P.scrub).toBe(dur - 1);
  });

  it('with no known duration (no metadata, no runtime) the target is only kept ≥ 0', async () => {
    stubImage();
    const m = movie({ RunTimeTicks: 0 });
    const sid = m.MediaSources[0].Id;
    m.MediaSources[0].RunTimeTicks = 0;
    const h = await startPlayer({ item: m, duration: NaN, trickplay: { [sid]: { 320: layout() } } });
    await h.settle();
    expect(h.player.seekDur()).toBe(0);
    at(h, 100);
    h.player.scrubBy(1, false);
    expect(h.P.scrub).toBe(110);
    h.player.scrubBy(-1, false);
    h.player.scrubBy(-1, false);
    expect(h.P.scrub).toBe(90);
  });

  it('warms the next sheet in the direction of travel, none past either end', async () => {
    const warmed = stubImage();
    const h = await scrubbable();
    at(h, 500);   // sheet 0
    h.player.scrubBy(1, false);   // 510 → sheet 0, warm 1
    expect(warmed.at(-1)).toBe(sheetUrl(h, 320, 1));
    h.player.cancelScrub();
    at(h, 1500);   // sheet 1
    h.player.scrubBy(-1, false);   // 1490 → sheet 1, warm 0
    expect(warmed.at(-1)).toBe(sheetUrl(h, 320, 0));
    h.player.cancelScrub();
    const n = warmed.length;
    at(h, 50);
    h.player.scrubBy(-1, false);   // sheet 0 backwards: no sheet −1
    h.player.cancelScrub();
    at(h, 2500);
    h.player.scrubBy(1, false);   // sheet 2 is the last
    expect(warmed.length).toBe(n);
  });

  it('a thumbnail count that fills its sheets exactly: no warm-up past the last sheet', async () => {
    const warmed = stubImage();
    const m = movie();
    const sid = m.MediaSources[0].Id;
    const h = await startPlayer({ item: m, trickplay: { [sid]: { 320: layout({ ThumbnailCount: 200 }) } } });
    await h.settle();
    at(h, 1500);   // sheet 1 of 0–1, the last
    h.player.scrubBy(1, false);
    expect(warmed).toEqual([]);
    h.player.cancelScrub();
  });

  it('raises the OSD', async () => {
    stubImage();
    const h = await scrubbable();
    h.P.osdShown = false;
    h.player.scrubBy(1, false);
    expect(h.P.osdShown).toBe(true);
  });
});

describe('the one real seek', () => {
  beforeAll(warmPlayer, 120000);

  it('after 900 ms of rest; every press restarts the wait', async () => {
    stubImage();
    const h = await scrubbable();
    at(h, 100);
    const seeks = h.video.seeks.length;
    h.player.scrubBy(1, false);
    await h.clock.tick(800);
    h.player.scrubBy(1, true);
    await h.clock.tick(899);
    expect(h.video.seeks.length).toBe(seeks);
    expect(h.P.scrub).toBe(120);
    await h.clock.tick(1);
    expect(h.video.seeks.slice(seeks)).toEqual([120]);
    expect(h.P.scrub).toBe(null);
    expect(h.P.pos).toBe(120);
  });

  it('commitScrub seeks at once and says whether it did', async () => {
    stubImage();
    const h = await scrubbable();
    at(h, 100);
    const seeks = h.video.seeks.length;
    expect(h.player.commitScrub()).toBe(false);
    h.player.scrubBy(-1, false);
    expect(h.player.commitScrub()).toBe(true);
    expect(h.video.seeks.slice(seeks)).toEqual([90]);
    await h.clock.tick(2000);
    expect(h.video.seeks.slice(seeks)).toEqual([90]);   // the rest timer was dropped
  });

  it('cancelScrub abandons it', async () => {
    stubImage();
    const h = await scrubbable();
    at(h, 100);
    const seeks = h.video.seeks.length;
    expect(h.player.cancelScrub()).toBe(false);
    h.player.scrubBy(1, false);
    h.P.osdShown = false;
    expect(h.player.cancelScrub()).toBe(true);
    expect(h.P.scrub).toBe(null);
    expect(h.P.osdShown).toBe(true);
    await h.clock.tick(2000);
    expect(h.video.seeks.length).toBe(seeks);
  });

  it('without trickplay every step is a real 30 s seek, held or not', async () => {
    const h = await startPlayer({ item: movie() });
    await h.settle();
    at(h, 100);
    const seeks = h.video.seeks.length;
    h.player.scrubBy(1, false);
    expect(h.P.scrub).toBe(null);
    for (let r = 1; r <= 8; r++) h.player.scrubBy(1, true);
    expect(h.video.seeks.slice(seeks)).toEqual([130, 160, 190, 220, 250, 280, 310, 340, 370]);
    h.player.scrubBy(-1, false);
    expect(h.video.seeks.at(-1)).toBe(340);
  });
});

describe('effectivePos: the seek target outlives a garbage currentTime', () => {
  beforeAll(warmPlayer, 120000);

  it('for 900 ms after a seek the target is the position, then currentTime again', async () => {
    const h = await startPlayer({ item: movie() });
    await h.settle();
    at(h, 100);
    h.player.seekTo(1500);
    h.video.setTime(0);   // the TV's transient read
    expect(h.player.effectivePos()).toBe(1500);
    h.video.emit('timeupdate');
    expect(h.P.pos).toBe(1500);   // the scrubber does not jump to 0
    await h.clock.tick(899);
    expect(h.player.effectivePos()).toBe(1500);
    await h.clock.tick(1);
    expect(h.player.effectivePos()).toBe(0);
    h.video.setTime(1501);
    expect(h.player.effectivePos()).toBe(1501);
  });

  it('a second seek restarts the 900 ms', async () => {
    const h = await startPlayer({ item: movie() });
    await h.settle();
    h.player.seekTo(500);
    await h.clock.tick(600);
    h.player.seekTo(700);
    h.video.setTime(0);
    await h.clock.tick(600);
    expect(h.player.effectivePos()).toBe(700);
    await h.clock.tick(300);
    expect(h.player.effectivePos()).toBe(0);
  });

  it('seekTo clamps to [0, duration − 1]; seekBy is relative to the effective position', async () => {
    const h = await startPlayer({ item: movie() });
    await h.settle();
    const dur = h.video.duration;
    h.player.seekTo(-20);
    expect(h.video.seeks.at(-1)).toBe(0);
    h.player.seekTo(dur + 100);
    expect(h.video.seeks.at(-1)).toBe(dur - 1);
    h.player.seekTo(400);
    h.video.setTime(0);
    h.player.seekBy(30);
    expect(h.video.seeks.at(-1)).toBe(430);
  });

  it('a garbage NaN / negative currentTime reads as 0 outside the window', async () => {
    const h = await startPlayer({ item: movie() });
    await h.settle();
    h.video.setTime(NaN);
    expect(h.player.effectivePos()).toBe(0);
    h.video.setTime(-3);
    expect(h.player.effectivePos()).toBe(0);
  });
});

/* The chapter list (P.chapters: the scrubber's tick marks and the OSD's Chapters
 * menu) rides on the same one-item Fields=Trickplay,Chapters request: sorted by
 * time, blank names numbered by file position, names trimmed, a single chapter
 * (or none) is no navigation at all, and an answer that lands after the player
 * moved on is dropped. */
describe('lookUpTrickplay: the chapter list', () => {
  beforeAll(warmPlayer, 120000);
  const C = (list) => list.map(([Name, s]) => (s == null ? { Name } : { Name, StartPositionTicks: s * 10000000 }));

  it('names trimmed, blank ones numbered by position', async () => {
    const h = await startPlayer({ item: movie(), chapters: C([['', 0], ['Act 2', 1200], ['  Finale  ', 2400]]) });
    await h.settle();
    expect(h.P.chapters).toEqual([{ at: 0, name: 'Chapter 1' }, { at: 1200, name: 'Act 2' }, { at: 2400, name: 'Finale' }]);
  });

  it('sorted by start; a chapter without a start sits at 0', async () => {
    const h = await startPlayer({ item: movie(), chapters: C([['B', 1200], ['A', null]]) });
    await h.settle();
    expect(h.P.chapters).toEqual([{ at: 0, name: 'A' }, { at: 1200, name: 'B' }]);
  });

  it('one chapter (or none) is no list', async () => {
    const a = await startPlayer({ item: movie(), chapters: C([['Only', 0]]) });
    await a.settle();
    expect(a.P.chapters).toEqual([]);
    const b = await startPlayer({ item: movie() });
    await b.settle();
    expect(b.P.chapters).toEqual([]);
  });

  it('a failed one-item request leaves no chapters and no trickplay (nothing from the last start)', async () => {
    const m = movie();
    const h = await startPlayer({
      item: m,
      chapters: C([['A', 0], ['B', 600]]),
      routes: (net) => net.on('GET', (r) => r.path === '/Items' && new URLSearchParams(r.query).get('Fields') === 'Trickplay,Chapters', net.status(500))
    });
    await h.settle();
    expect(h.P.chapters).toEqual([]);
    expect(h.P.trick).toBe(null);
    expect(h.P.error).toBe(null);
  });

  it('an answer landing after the player closed sets nothing', async () => {
    const m = movie();
    let answer;
    const h = await startPlayer({
      item: m,
      routes: (net) =>
        net.on('GET', (r) => r.path === '/Items' && new URLSearchParams(r.query).get('Fields') === 'Trickplay,Chapters', () =>
          new Promise((res) => (answer = () => res({ Items: [{ Id: m.Id, Chapters: C([['A', 0], ['B', 600]]) }] })))
        )
    });
    await h.settle();
    expect(answer).toBeTypeOf('function');
    h.player.exitPlayer();
    answer();
    await h.settle();
    expect(h.P.chapters).toEqual([]);
  });
});

describe('cancelScrub', () => {
  beforeAll(warmPlayer, 120000);

  // startPlayback/playNext/exitPlayer all call cancelScrub(): with nothing pending
  // it must not raise the OSD (a start would otherwise open with the OSD up).
  it('with nothing pending it leaves the OSD as it was; with a target it raises it', async () => {
    stubImage();
    const h = await scrubbable();
    h.player.hideOsd();
    expect(h.player.cancelScrub()).toBe(false);
    expect(h.P.osdShown).toBe(false);
    h.player.scrubBy(1, false);
    h.player.hideOsd();
    expect(h.player.cancelScrub()).toBe(true);
    expect(h.P.osdShown).toBe(true);
  });

  it('says false when nothing was pending (Back then means Back, not "abandon")', async () => {
    const h = await scrubbable();
    expect(h.player.cancelScrub()).toBe(false);
    h.player.scrubBy(1, false);
    expect(h.player.cancelScrub()).toBe(true);
  });
});
