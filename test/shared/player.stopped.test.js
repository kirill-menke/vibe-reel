/* player.svelte.js — progress and Stopped reporting (reportStart / reportProgress /
 * reportStop / postStopped).
 *
 * CLAUDE.md, "Progress": Sessions/Playing, /Progress (10 s timer), /Stopped.
 * exitPlayer() detaches onpause before pausing, or its progress report lands
 * *after* the Stopped. Stopped is retried after 3/10/30 s on a network error or
 * 5xx (4xx is final); a retry is dropped once the item has a newer session
 * (newestSession), or a late Stopped would rewind it. /Progress isn't retried.
 * reportStop() arms holdReads() with the Stopped POST, because exit navigates at
 * once and the detail page used to paint the old resume point. An Up Next roll
 * reports the old episode's Stopped at the *end* position so it counts as
 * watched. Pending streams (P.pending) send no Jellyfin reports at all. */
import { describe, it, expect, beforeAll } from 'vitest';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, episode, source, video, audio, segment, playbackInfo } from '../helpers/media.js';

const TICKS = 10000000;
const STOPPED = '/Sessions/Playing/Stopped';
const PROGRESS = '/Sessions/Playing/Progress';

/** Stopped answers from a list (status codes, 'neterr', or null = 204), then 204 */
function stoppedAnswers(net, list) {
  const q = list.slice();
  net.on('POST', STOPPED, () => {
    const a = q.length ? q.shift() : null;
    if (a === 'neterr') return net.networkError();
    if (typeof a === 'number') return net.status(a, { error: 'x' });
    return null;
  });
}

const stopped = (h) => h.net.callsTo(STOPPED, 'POST');

describe('progress reports', () => {
  beforeAll(warmPlayer, 120000);

  it('Sessions/Playing once at the first frame, then /Progress every 10 s with the live position', async () => {
    const h = await startPlayer();
    expect(h.net.callsTo('/Sessions/Playing', 'POST')).toHaveLength(1);
    h.video.advance(12.5);
    await h.clock.tick(9999);
    expect(h.net.callsTo(PROGRESS, 'POST')).toHaveLength(0);
    await h.clock.tick(1);
    const [p] = h.net.callsTo(PROGRESS, 'POST');
    expect(p.body).toMatchObject({ ItemId: h.id, PlaySessionId: 'ps-1', MediaSourceId: h.source.Id, PositionTicks: 12.5 * TICKS, IsPaused: false });
    await h.clock.tick(10000);
    expect(h.net.callsTo(PROGRESS, 'POST')).toHaveLength(2);
  });

  it('a pause reports Progress at once with IsPaused: true', async () => {
    const h = await startPlayer();
    h.video.advance(30);
    h.video.pause();
    await h.settle();
    const ps = h.net.callsTo(PROGRESS, 'POST');
    expect(ps).toHaveLength(1);
    expect(ps[0].body).toMatchObject({ IsPaused: true, PositionTicks: 30 * TICKS });
  });

  it('a failed /Progress is not retried (the next tick supersedes it)', async () => {
    const h = await startPlayer();
    h.net.on('POST', PROGRESS, h.net.status(503));
    await h.clock.tick(10000);
    expect(h.net.callsTo(PROGRESS, 'POST')).toHaveLength(1);
    await h.clock.tick(9000);
    expect(h.net.callsTo(PROGRESS, 'POST')).toHaveLength(1);
  });
});

describe('Stopped on exit', () => {
  beforeAll(warmPlayer, 120000);

  it('goes out once with keepalive (no deadline signal) at the playhead', async () => {
    const h = await startPlayer();
    h.video.advance(754.3);
    h.player.exitPlayer();
    await h.settle();
    const s = stopped(h);
    expect(s).toHaveLength(1);
    expect(s[0].keepalive).toBe(true);
    expect(s[0].signal).toBeUndefined();
    expect(s[0].body).toEqual({ ItemId: h.id, MediaSourceId: h.source.Id, PlaySessionId: 'ps-1', PositionTicks: Math.floor(754.3 * TICKS) });
  });

  it('no Progress lands after the Stopped: exit detaches onpause before pausing', async () => {
    const h = await startPlayer();
    h.video.advance(60);
    const before = h.net.calls.length;
    h.player.exitPlayer();
    await h.settle();
    await h.clock.tick(30000);   // and the 10 s timer is gone too
    const after = h.net.calls.slice(before).filter((c) => c.path.startsWith('/Sessions/'));
    expect(after.map((c) => c.path)).toEqual([STOPPED]);
    expect(h.video.calls.some((c) => c[0] === 'pause')).toBe(true);
  });

  it('once per session: a second exit does not re-stop it', async () => {
    const h = await startPlayer();
    h.player.exitPlayer();
    h.player.exitPlayer();
    h.player.suspendPlayback();
    await h.settle();
    expect(stopped(h)).toHaveLength(1);
  });

  it('suspendPlayback() (app hidden / pagehide) exits with the keepalive Stopped', async () => {
    const h = await startPlayer();
    h.video.advance(99);
    h.player.suspendPlayback();
    await h.settle();
    expect(h.S.screen).not.toBe('player');
    const s = stopped(h);
    expect(s).toHaveLength(1);
    expect(s[0].keepalive).toBe(true);
    expect(s[0].body.PositionTicks).toBe(99 * TICKS);
  });
});

describe('Stopped retries', () => {
  beforeAll(warmPlayer, 120000);

  it('a 5xx is retried after 3 s, 10 s and 30 s, then given up', async () => {
    const h = await startPlayer();
    stoppedAnswers(h.net, [503, 502, 500, 504, 503]);
    h.video.advance(10);
    h.player.exitPlayer();
    await h.settle();
    expect(stopped(h)).toHaveLength(1);
    await h.clock.tick(2999);
    expect(stopped(h)).toHaveLength(1);
    await h.clock.tick(1);
    expect(stopped(h)).toHaveLength(2);
    await h.clock.tick(9999);
    expect(stopped(h)).toHaveLength(2);
    await h.clock.tick(1);
    expect(stopped(h)).toHaveLength(3);
    await h.clock.tick(29999);
    expect(stopped(h)).toHaveLength(3);
    await h.clock.tick(1);
    expect(stopped(h)).toHaveLength(4);
    await h.clock.tick(600000);
    expect(stopped(h)).toHaveLength(4);
    // every attempt is the same report, keepalive each time
    const s = stopped(h);
    expect(new Set(s.map((c) => JSON.stringify(c.body))).size).toBe(1);
    expect(s.every((c) => c.keepalive)).toBe(true);
  });

  it('a network error is retried; a success ends the retries', async () => {
    const h = await startPlayer();
    stoppedAnswers(h.net, ['neterr', 'neterr', null]);
    h.player.exitPlayer();
    await h.settle();
    await h.clock.tick(3000);
    await h.clock.tick(10000);
    expect(stopped(h)).toHaveLength(3);
    await h.clock.tick(120000);
    expect(stopped(h)).toHaveLength(3);
  });

  it.each([400, 401, 404])('a %i is final: no retry', async (code) => {
    const h = await startPlayer();
    stoppedAnswers(h.net, [code]);
    h.player.exitPlayer();
    await h.settle();
    await h.clock.tick(120000);
    expect(stopped(h)).toHaveLength(1);
  });

  it('a retry is dropped once the item started a newer session', async () => {
    const h = await startPlayer();
    stoppedAnswers(h.net, [503]);   // ps-1's first attempt fails; everything after answers 204
    h.player.exitPlayer();
    await h.settle();
    // played again within the retry window: a new PlaySessionId
    h.net.on('POST', '/Items/' + h.id + '/PlaybackInfo', playbackInfo(h.source, { PlaySessionId: 'ps-2' }));
    h.player.playItem(h.item, 0);
    await h.settle();
    expect(h.P.sessionId).toBe('ps-2');
    await h.clock.tick(3000);
    expect(stopped(h)).toHaveLength(1);
    // …and exited again: still no late ps-1 Stopped to rewind ps-2's resume point
    h.player.exitPlayer();
    await h.settle();
    await h.clock.tick(60000);
    expect(stopped(h).map((c) => c.body.PlaySessionId)).toEqual(['ps-1', 'ps-2']);
  });
});

describe('holdReads with the Stopped POST', () => {
  beforeAll(warmPlayer, 120000);

  it('a user-data read right after exit waits for the Stopped answer', async () => {
    const h = await startPlayer();
    let answer;
    h.net.on('POST', STOPPED, () => new Promise((r) => (answer = r)));
    h.net.on('GET', '/Users/u1/Items/' + h.id, { Id: h.id, UserData: {} });
    h.player.exitPlayer();
    const read = h.api.api('/Users/u1/Items/' + h.id);
    await h.clock.tick(1000);
    expect(h.net.callsTo('/Users/u1/Items/' + h.id)).toHaveLength(0);
    answer(null);
    await h.settle();
    await h.settle();
    expect(h.net.callsTo('/Users/u1/Items/' + h.id)).toHaveLength(1);
    await expect(read).resolves.toMatchObject({ Id: h.id });
  });

  it('…but at most 1.5 s', async () => {
    const h = await startPlayer();
    h.net.on('POST', STOPPED, () => new Promise(() => {}));
    h.net.on('GET', '/Users/u1/Items/' + h.id, { Id: h.id });
    h.player.exitPlayer();
    h.api.api('/Users/u1/Items/' + h.id);
    await h.clock.tick(1499);
    expect(h.net.callsTo('/Users/u1/Items/' + h.id)).toHaveLength(0);
    await h.clock.tick(1);
    expect(h.net.callsTo('/Users/u1/Items/' + h.id)).toHaveLength(1);
  });
});

describe('Up Next roll-on reports the old episode', () => {
  beforeAll(warmPlayer, 120000);

  function binge() {
    const next = episode({ IndexNumber: 2 });
    const ep = episode({ IndexNumber: 1 });
    return {
      ep,
      next,
      opts: {
        item: ep,
        next,
        segments: [segment('Outro', 2500, 2690)],
        routes: (net) => net.on('POST', '/Items/' + next.Id + '/PlaybackInfo', playbackInfo(next.MediaSources[0], { PlaySessionId: 'ps-next' }))
      }
    };
  }

  it('the countdown running out stops the old episode at the END position (counts as watched)', async () => {
    const { ep, next, opts } = binge();
    const h = await startPlayer(opts);
    await h.settle();
    expect(h.P.credits).toMatchObject({ start: 2500 });
    h.player.seekTo(2500);
    await h.clock.tick(1000);   // past the seek window
    h.video.setTime(2500);
    h.video.advance(10.5);   // the 10 s countdown is over → playNext()
    await h.settle();
    const s = stopped(h);
    expect(s).toHaveLength(1);
    expect(s[0].body).toMatchObject({ ItemId: ep.Id, PlaySessionId: 'ps-1', PositionTicks: 2700 * TICKS });
    expect(h.net.callsTo('/Items/' + next.Id + '/PlaybackInfo', 'POST')).toHaveLength(1);
  });

  it('the Next button before the window reports the real position', async () => {
    const { opts } = binge();
    const h = await startPlayer(opts);
    await h.settle();
    h.video.advance(600);
    h.player.showOsd();
    h.player.playNext(true);
    await h.settle();
    expect(stopped(h)[0].body.PositionTicks).toBe(600 * TICKS);
  });

  it('the Next button inside the credits counts as watched', async () => {
    const { opts } = binge();
    const h = await startPlayer(opts);
    await h.settle();
    h.video.advance(2550);
    h.player.showOsd();
    h.player.playNext(true);
    await h.settle();
    expect(stopped(h)[0].body.PositionTicks).toBe(2700 * TICKS);
  });

  it('a next episode that fails to load exits without stopping the old one twice', async () => {
    const { next, opts } = binge();
    const h = await startPlayer({ ...opts, routes: (net) => net.on('GET', '/Items/' + next.Id, net.status(404)) });
    await h.settle();
    h.video.advance(2550);
    h.player.showOsd();
    h.player.playNext(true);
    await h.settle();
    await h.settle();
    expect(h.S.screen).not.toBe('player');
    expect(stopped(h)).toHaveLength(1);
  });
});

describe('pending streams report nothing to Jellyfin', () => {
  beforeAll(warmPlayer, 120000);

  it('no Playing / Progress / Stopped for a whole pending playback', async () => {
    const h = await startPlayer({ reach: 'src' });
    const src = source([video(), audio()], { RunTimeTicks: 3600 * TICKS });
    h.player.playPendingStream({ url: 'http://ml.test/api/downloads/abc/stream', item: movie({ Name: 'Pending', MediaSources: [src] }), source: src, downloadId: 'abc' });
    await h.settle();
    h.video.setDuration(3600);
    h.video.emit('loadedmetadata');
    h.video.setReadyState(4);
    h.video.emit('playing');
    await h.settle();
    h.video.advance(100);
    await h.clock.tick(30000);
    h.video.pause();
    h.player.exitPlayer();
    await h.settle();
    await h.clock.tick(60000);
    expect(h.net.calls.filter((c) => c.path.startsWith('/Sessions/'))).toEqual([]);
  });
});
