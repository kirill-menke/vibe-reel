/* player.svelte.js — the Up Next card (upNextWindow / upNextVisible /
 * upNextLeft / dismissUpNext / the roll-on in ontimeupdate and onended).
 *
 * CLAUDE.md, "Up Next": the card appears at the credits start (Outro segment, or
 * a chapter named Credits/Outro/ED) with a 10 s countdown, else for the last
 * 20 s of the file with the end as the "go". Everything derives from the
 * playhead like the intro chip — pausing freezes the countdown, seeking back
 * re-arms a dismissed card. Landing *inside* the credits starts a fresh 10 s
 * countdown from the landing point (upNextFrom). The next episode's item is
 * prefetched 5 s before the card. Back = dismiss (then the end of the file exits
 * normally). */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, episode, source, video, audio, sub, segment, chapters, playbackInfo } from '../helpers/media.js';

const TICKS = 10000000;

/** the playhead reaches t by playing (no seek): timeupdate at t */
function at(h, t) {
  h.video.setTime(t);
  h.video.emit('timeupdate');
}

async function binge(o = {}) {
  const next = episode({ IndexNumber: 2 });
  const ep = episode({ IndexNumber: 1 });   // 45 min = 2700 s
  const h = await startPlayer({
    item: ep,
    next,
    segments: o.credits === false ? [] : o.segments || [segment('Outro', 2500, 2690)],
    chapters: o.chapters,
    storage: o.storage,
    routes: (net) => net.on('POST', '/Items/' + next.Id + '/PlaybackInfo', playbackInfo(next.MediaSources[0], { PlaySessionId: 'ps-next' }))
  });
  await h.settle();
  return Object.assign(h, { next, ep, nextGets: () => h.net.callsTo('/Items/' + next.Id, 'GET') });
}

describe('Up Next: the window', () => {
  beforeAll(warmPlayer, 120000);

  it('with credits: from the credits start, a 10 s countdown, then the roll-on', async () => {
    const h = await binge();
    expect(h.P.credits).toMatchObject({ start: 2500, from: 'segment' });
    at(h, 2499);
    expect(h.player.upNextVisible()).toBe(false);
    at(h, 2500);
    expect(h.player.upNextVisible()).toBe(true);
    expect(h.player.upNextLeft()).toBe(10);
    at(h, 2505.5);
    expect(h.player.upNextLeft()).toBe(5);
    at(h, 2509.9);
    expect(h.player.upNextLeft()).toBe(1);
    expect(h.net.callsTo('/Items/' + h.next.Id + '/PlaybackInfo', 'POST')).toHaveLength(0);
    at(h, 2510);   // go
    await h.settle();
    expect(h.net.callsTo('/Items/' + h.next.Id + '/PlaybackInfo', 'POST')).toHaveLength(1);
    expect(h.P.loading).toBe(true);
  });

  it('a credits chapter (named Credits) works like an Outro segment', async () => {
    const h = await binge({ credits: false, chapters: chapters([['Chapter 1', 0], ['Credits', 2550]]) });
    expect(h.P.credits).toMatchObject({ start: 2550 });
    at(h, 2549);
    expect(h.player.upNextVisible()).toBe(false);
    at(h, 2551);
    expect(h.player.upNextVisible()).toBe(true);
    expect(h.player.upNextLeft()).toBe(10);
  });

  it('without credits data: the last 20 s, the end of the file as the go (onended rolls on)', async () => {
    const h = await binge({ credits: false });
    expect(h.P.credits).toBe(null);
    at(h, 2679);
    expect(h.player.upNextVisible()).toBe(false);
    at(h, 2680);
    expect(h.player.upNextVisible()).toBe(true);
    expect(h.player.upNextLeft()).toBe(20);
    at(h, 2699.5);
    expect(h.player.upNextLeft()).toBe(1);
    await h.settle();
    expect(h.net.callsTo('/Items/' + h.next.Id + '/PlaybackInfo', 'POST')).toHaveLength(0);   // timeupdate never rolls on at the end
    h.video.end();
    await h.settle();
    expect(h.net.callsTo('/Items/' + h.next.Id + '/PlaybackInfo', 'POST')).toHaveLength(1);
  });

  it('credits starting within 2 s of the end count as no credits (the 20 s tail)', async () => {
    const h = await binge({ segments: [segment('Outro', 2699, 2700)] });
    at(h, 2681);
    expect(h.player.upNextVisible()).toBe(true);
    expect(h.player.upNextLeft()).toBe(19);
  });

  it('a movie (no next episode) gets no card', async () => {
    const h = await startPlayer({ item: movie() });
    at(h, 2690);
    expect(h.player.upNextVisible()).toBe(false);
    expect(h.player.upNextLeft()).toBe(0);
  });

  it('a pending stream gets no card', async () => {
    const h = await binge();
    const src = source([video(), audio()]);
    h.player.playPendingStream({ url: 'http://ml.test/api/downloads/abc/stream', item: movie({ MediaSources: [src] }), source: src });
    h.P.next = h.next;   // even if something left a next episode behind
    h.P.pos = 2600;
    h.P.dur = 2700;
    expect(h.player.upNextVisible()).toBe(false);
  });

  it('the card yields to an open panel, and the countdown does not roll on under it', async () => {
    const h = await binge();
    at(h, 2501);
    expect(h.player.upNextVisible()).toBe(true);
    h.P.panel = 'audio';
    expect(h.player.upNextVisible()).toBe(false);
    at(h, 2515);
    await h.settle();
    expect(h.net.callsTo('/Items/' + h.next.Id + '/PlaybackInfo', 'POST')).toHaveLength(0);
  });

  it('autoplay off: the countdown ends but the card waits', async () => {
    const h = await binge({ storage: { 'reel.settings': JSON.stringify({ autoplayNext: false }) } });
    at(h, 2500);
    at(h, 2530);
    await h.settle();
    expect(h.player.upNextVisible()).toBe(true);
    expect(h.player.upNextLeft()).toBe(0);
    expect(h.net.callsTo('/Items/' + h.next.Id + '/PlaybackInfo', 'POST')).toHaveLength(0);
    // the file ends: the card stays up on the last frame
    h.video.end();
    await h.settle();
    expect(h.S.screen).toBe('player');
    expect(h.P.pos).toBe(2700);
    // Back = dismiss: nothing left to watch → exit
    h.player.dismissUpNext();
    await h.settle();
    expect(h.S.screen).not.toBe('player');
  });
});

describe('Up Next: derived from the playhead', () => {
  beforeAll(warmPlayer, 120000);

  it('paused, the countdown freezes and nothing rolls on', async () => {
    const h = await binge();
    at(h, 2500);   // played into the credits (the first timeupdate inside starts the countdown)
    at(h, 2503);
    h.video.pause();
    await h.clock.tick(30000);
    expect(h.player.upNextLeft()).toBe(7);
    expect(h.net.callsTo('/Items/' + h.next.Id + '/PlaybackInfo', 'POST')).toHaveLength(0);
  });

  it('seeking back before the window takes the card away and re-arms a dismissed one', async () => {
    const h = await binge();
    at(h, 2502);
    h.player.dismissUpNext();
    expect(h.P.upNextOff).toBe(true);
    expect(h.player.upNextVisible()).toBe(false);
    at(h, 2520);   // dismissed: no roll-on at the go
    await h.settle();
    expect(h.net.callsTo('/Items/' + h.next.Id + '/PlaybackInfo', 'POST')).toHaveLength(0);
    h.player.seekTo(2000);
    expect(h.player.upNextVisible()).toBe(false);
    await h.clock.tick(1000);
    at(h, 2000);
    expect(h.P.upNextOff).toBe(false);
    at(h, 2500);
    expect(h.player.upNextVisible()).toBe(true);
  });

  it('dismissed, the end of the file exits instead of rolling on', async () => {
    const h = await binge();
    at(h, 2502);
    h.player.dismissUpNext();
    at(h, 2699);
    h.video.end();
    await h.settle();
    expect(h.S.screen).not.toBe('player');
    expect(h.net.callsTo('/Items/' + h.next.Id + '/PlaybackInfo', 'POST')).toHaveLength(0);
  });

  it('landing inside the credits (a seek) starts a fresh 10 s countdown there', async () => {
    const h = await binge();
    h.player.seekTo(2600);
    expect(h.player.upNextVisible()).toBe(true);
    expect(h.player.upNextLeft()).toBe(10);
    await h.clock.tick(1000);
    at(h, 2605);
    expect(h.player.upNextLeft()).toBe(5);
    at(h, 2609.9);
    await h.settle();
    expect(h.net.callsTo('/Items/' + h.next.Id + '/PlaybackInfo', 'POST')).toHaveLength(0);
    at(h, 2610);
    await h.settle();
    expect(h.net.callsTo('/Items/' + h.next.Id + '/PlaybackInfo', 'POST')).toHaveLength(1);
  });

  it('a resume point inside the credits does not roll on at once', async () => {
    const next = episode({ IndexNumber: 2 });
    const ep = episode({ IndexNumber: 1 });
    const h = await startPlayer({
      item: ep,
      next,
      resumeSec: 2650,
      segments: [segment('Outro', 2500, 2690)],
      routes: (net) => net.on('POST', '/Items/' + next.Id + '/PlaybackInfo', playbackInfo(next.MediaSources[0]))
    });
    await h.settle();
    await h.clock.tick(1000);
    at(h, 2650);
    await h.settle();
    expect(h.player.upNextVisible()).toBe(true);
    expect(h.player.upNextLeft()).toBe(10);
    expect(h.net.callsTo('/Items/' + next.Id + '/PlaybackInfo', 'POST')).toHaveLength(0);
  });

  it('a keyframe-short landing lowers the start once the seek window is over; never above 10', async () => {
    const h = await binge();
    h.player.seekTo(2600);
    at(h, 2597);   // inside the seek window: effectivePos is still the target
    expect(h.player.upNextLeft()).toBe(10);
    await h.clock.tick(1000);
    at(h, 2597);   // the TV decoded from the keyframe before the target
    expect(h.player.upNextLeft()).toBe(10);
    at(h, 2602);
    expect(h.player.upNextLeft()).toBe(5);   // go = 2607, not 2610
  });

  it('the countdown is capped at its length even before upNextFrom catches up', async () => {
    const h = await binge();
    h.player.seekTo(2600);   // go = 2610
    h.P.pos = 2596;   // a frame where P.pos already reads lower than the landing
    expect(h.player.upNextLeft()).toBe(10);
  });
});

describe('Up Next: the next episode is warmed 5 s before the card', () => {
  beforeAll(warmPlayer, 120000);

  it('prefetched once from credits − 5 s, and the roll-on uses the warm item', async () => {
    const h = await binge();
    at(h, 2494);
    await h.settle();
    expect(h.nextGets()).toHaveLength(0);
    at(h, 2495);
    await h.settle();
    expect(h.nextGets()).toHaveLength(1);
    at(h, 2497);
    at(h, 2500);
    await h.settle();
    expect(h.nextGets()).toHaveLength(1);
    at(h, 2510);
    await h.settle();
    await h.settle();
    expect(h.nextGets()).toHaveLength(1);   // playEpisode() took the parked prefetch
    expect(h.net.callsTo('/Items/' + h.next.Id + '/PlaybackInfo', 'POST')).toHaveLength(1);
  });

  it('the roll-on Stopped is the end position; the next episode starts as a restart inside the player', async () => {
    const h = await binge();
    at(h, 2500);
    at(h, 2510);
    await h.settle();
    await h.settle();
    const [s] = h.net.callsTo('/Sessions/Playing/Stopped', 'POST');
    expect(s.body).toMatchObject({ ItemId: h.ep.Id, PositionTicks: 2700 * TICKS });
    expect(h.S.screen).toBe('player');
    expect(h.P.sessionId).toBe('ps-next');
    expect(h.P.item.Id).toBe(h.next.Id);
  });
});

/* "Credits within 2 s of the end count as no credits": the element's duration
 * decides, not the item runtime — a file that ends before Jellyfin's RunTimeTicks
 * (here 2700 s of video, a 2760 s runtime) can carry credits that pass the
 * segment checks yet start in its last 2 s. The existing test above uses an
 * Outro too short to be credits at all, so it never reached this rule. */
describe('Up Next: credits in the last 2 s of the file', () => {
  beforeAll(warmPlayer, 120000);

  async function short(outroStart) {
    const next = episode({ IndexNumber: 2 });
    const ep = episode({ IndexNumber: 1, RunTimeTicks: 2760 * TICKS });
    const h = await startPlayer({ item: ep, next, duration: 2700, segments: [segment('Outro', outroStart, 2760)] });
    await h.settle();
    expect(h.P.credits).toMatchObject({ start: outroStart });
    return h;
  }

  it.each([2699, 2698])('credits from %i of a 2700 s file → the 20 s tail and its count', async (s) => {
    const h = await short(s);
    at(h, 2681);
    expect(h.player.upNextVisible()).toBe(true);
    expect(h.player.upNextLeft()).toBe(19);
  });

  it('credits from 2697.5 (more than 2 s before the end) are the credits', async () => {
    const h = await short(2697.5);
    at(h, 2681);
    expect(h.player.upNextVisible()).toBe(false);
    at(h, 2697.5);
    expect(h.player.upNextVisible()).toBe(true);
  });
});

/* playNext(): the roll-on itself (final audit — the teardown and guards Stryker
 * found unpinned). CLAUDE.md: "Rolling on reports the old episode's Stopped at the
 * *end* position so it counts as watched even when the credits start below
 * Jellyfin's 90 % threshold"; the OSD's Next button (manual === true) counts it
 * only from the Up Next window on. */
describe('playNext: one roll-on, a clean slate for the next episode', () => {
  beforeAll(warmPlayer, 120000);

  const stopped = (h) => h.net.callsTo('/Sessions/Playing/Stopped', 'POST');

  it('no window before the duration is known (no metadata, no runtime)', async () => {
    const next = episode({ IndexNumber: 2 });
    const ep = episode({ IndexNumber: 1, RunTimeTicks: 0, MediaSources: [source(undefined, { RunTimeTicks: 0 })] });
    const h = await startPlayer({ item: ep, next, duration: NaN });
    await h.settle();
    expect(h.P.next).toMatchObject({ Id: next.Id });
    h.player.showOsd();
    expect(h.P.dur).toBe(0);
    expect(h.player.upNextVisible()).toBe(false);
    expect(h.player.upNextLeft()).toBe(0);
  });

  it('with no next episode it does nothing', async () => {
    const h = await startPlayer({ item: movie() });
    await h.settle();
    expect(h.P.next).toBe(null);
    h.player.playNext(true);
    await h.settle();
    expect(stopped(h)).toHaveLength(0);
    expect(h.S.screen).toBe('player');
    expect(h.P.loading).toBe(false);
  });

  it('the Next button exactly at the credits start counts as watched', async () => {
    const h = await binge();
    at(h, 2500);
    h.player.playNext(true);
    await h.settle();
    expect(stopped(h)[0].body.PositionTicks).toBe(2700 * TICKS);
  });

  // "(A click handler passes its event here, hence the strict comparison.)"
  it('any argument but true (a click handler\'s event) is the automatic roll-on: counts as watched', async () => {
    const h = await binge();
    at(h, 600);
    h.player.playNext({ type: 'click' });
    await h.settle();
    expect(stopped(h)[0].body.PositionTicks).toBe(2700 * TICKS);
  });

  it('tears the old episode down at once: paused without a late Progress, subs, skips, chapters, scrub, panel', async () => {
    const next = episode({ IndexNumber: 2 });
    const ep = episode({ IndexNumber: 1, MediaSources: [source([video(), audio(), sub({ Language: 'eng' })])] });
    const sid = ep.MediaSources[0].Id;
    const h = await startPlayer({
      item: ep,
      next,
      segments: [segment('Intro', 60, 150), segment('Outro', 2500, 2690)],
      chapters: chapters([['Opening', 0], ['Part 2', 1200]]),
      trickplay: { [sid]: { 320: { Width: 320, Height: 180, TileWidth: 10, TileHeight: 10, ThumbnailCount: 270, Interval: 10000 } } },
      routes: (net) => net.on('POST', '/Items/' + next.Id + '/PlaybackInfo', playbackInfo(next.MediaSources[0], { PlaySessionId: 'ps-next' }))
    });
    await h.settle();
    vi.stubGlobal('Image', class { set src(v) {} });
    h.player.pmSetSub(2);
    await h.settle();
    expect(h.video.querySelectorAll('track')).toHaveLength(1);
    expect(h.P.skips.length).toBeGreaterThan(0);
    expect(h.P.chapters.length).toBe(2);
    expect(h.P.trick).not.toBe(null);
    at(h, 2500);
    h.player.dismissUpNext();
    h.player.scrubBy(1, false);
    h.P.panel = 'audio';
    expect(h.video.paused).toBe(false);
    const progress = h.net.callsTo('/Sessions/Playing/Progress', 'POST').length;

    h.player.playNext(true);
    // synchronously, before the next episode is even fetched
    expect(h.video.paused).toBe(true);
    expect(h.video.querySelectorAll('track')).toHaveLength(0);
    expect(h.P).toMatchObject({ panel: null, credits: null, next: null, trick: null, scrub: null, upNextOff: false, osdShown: false, pos: 0, spinner: true, loading: true });
    expect(h.P.skips).toEqual([]);
    expect(h.P.chapters).toEqual([]);
    expect(h.P.loadingItem).toMatchObject({ Id: next.Id });
    await h.settle();
    // the onpause handler was detached first: no Progress lands after the Stopped
    expect(h.net.callsTo('/Sessions/Playing/Progress', 'POST')).toHaveLength(progress);
  });

  it('rolls on again from the episode it rolled on to (a three-episode binge)', async () => {
    const e1 = episode({ IndexNumber: 1 });
    const e2 = episode({ IndexNumber: 2 });
    const e3 = episode({ IndexNumber: 3 });
    const order = [e1, e2, e3];
    const h = await startPlayer({
      item: e1,
      next: e2,
      segments: [],
      routes: (net) => {
        net.on('GET', '/Shows/' + e1.SeriesId + '/Episodes', (r) => {
          const i = order.findIndex((e) => e.Id === new URLSearchParams(r.query).get('StartItemId'));
          return { Items: order.slice(i, i + 2) };
        });
        for (const e of [e2, e3]) {
          net.on('GET', '/Items/' + e.Id, e);
          net.on('POST', '/Items/' + e.Id + '/PlaybackInfo', playbackInfo(e.MediaSources[0], { PlaySessionId: 'ps-' + e.Id }));
          net.on('GET', '/MediaSegments/' + e.Id, { Items: [] });
          net.on('GET', (r) => r.path === '/Items' && new URLSearchParams(r.query).get('Ids') === e.Id, { Items: [{ Id: e.Id }], TotalRecordCount: 1 });
        }
      }
    });
    await h.settle();
    h.player.playNext(true);
    await h.clock.tick(100);   // the next episode's own lookups land
    expect(h.P.item.Id).toBe(e2.Id);
    expect(h.P.next).toMatchObject({ Id: e3.Id });
    h.player.playNext(true);
    await h.clock.tick(100);
    expect(h.P.item.Id).toBe(e3.Id);
    expect(h.net.callsTo('/Items/' + e3.Id + '/PlaybackInfo', 'POST')).toHaveLength(1);
    expect(stopped(h).map((c) => c.body.ItemId)).toEqual([e1.Id, e2.Id]);
  });

  it('closed while the next episode loads: a failed load afterwards does not exit (navigate) a second time', async () => {
    const next = episode({ IndexNumber: 2 });
    let fail;
    const h = await startPlayer({
      item: episode({ IndexNumber: 1 }),
      next,
      routes: (net) => net.on('GET', '/Items/' + next.Id, () => new Promise((res) => (fail = () => res(net.status(404)))))
    });
    await h.settle();
    at(h, 600);
    h.player.playNext(true);
    await h.settle();
    expect(fail).toBeTypeOf('function');
    h.player.exitPlayer();
    const screen = h.S.screen;
    const epoch = h.S.epoch;
    expect(screen).not.toBe('player');
    fail();
    await h.settle();
    await h.settle();
    expect(h.S.epoch).toBe(epoch);
    expect(h.S.screen).toBe(screen);
    expect(stopped(h)).toHaveLength(1);
  });
});

/* CLAUDE.md, "Up Next": "the next one comes from
 * /Shows/{sid}/Episodes?StartItemId={id}&Limit=2&IsMissing=false (crosses seasons)". */
describe('Up Next: which episode is next', () => {
  beforeAll(warmPlayer, 120000);

  it('the series order from this episode, two of them, no missing placeholders; a season boundary is crossed', async () => {
    const next = episode({ ParentIndexNumber: 2, IndexNumber: 1, SeasonId: 'season-2' });
    const ep = episode({ ParentIndexNumber: 1, IndexNumber: 10 });
    const h = await startPlayer({ item: ep, next });
    await h.settle();
    const [c] = h.net.callsTo('/Shows/' + ep.SeriesId + '/Episodes', 'GET');
    const q = new URLSearchParams(c.query);
    expect(q.get('StartItemId')).toBe(ep.Id);
    expect(q.get('Limit')).toBe('2');
    expect(q.get('IsMissing')).toBe('false');
    expect(h.P.next).toMatchObject({ Id: next.Id, ParentIndexNumber: 2 });
  });

  it('the last episode (the list holds only itself) has no next', async () => {
    const ep = episode();
    const h = await startPlayer({ item: ep });
    await h.settle();
    expect(h.P.next).toBe(null);
  });
});
