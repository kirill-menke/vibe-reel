/* player.svelte.js — start guards, exit destinations and restarts inside the
 * player (play / playFromHome / exitPlayer / suspendPlayback / retryPlayback /
 * restartPlayback via a burn-in switch).
 *
 * CLAUDE.md:
 * - "a start captures S.epoch and gives up if it changed (play(), …) — Back
 *   30 ms after Play must not start video over the page"; `play()` carries a
 *   `playGen` generation so a start still in flight when the player is closed
 *   gives up rather than playing over the detail page.
 * - "startPlayback() sets video.muted = false: the element lives for the whole
 *   session, and a mute left by a DevTools test silenced every later film".
 * - Exit destination: back to the screen playback started from — the item's
 *   detail page, or for a first start from Home's hero (homeReturn, kept across
 *   Up Next and restarts) Home on hero-resume via returnHome(); that includes
 *   suspendPlayback().
 * - "A restart inside the player (Retry, a sub/audio switch across the burn-in
 *   boundary) Stops the old PlaySessionId right after the new src is set …
 *   such restarts resume at restartPos(), not raw currentTime, which reads 0
 *   under the loading card."
 * - Continue Watching / Next Up tiles play on OK: resume position > 30 s. */
import { describe, it, expect, beforeAll } from 'vitest';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, episode, source, video, audio, tracks, playbackInfo } from '../helpers/media.js';

const TICKS = 10000000;

/** the playhead reaches t by playing */
function at(h, t) {
  h.video.setTime(t);
  h.video.emit('timeupdate');
}

/** every PlaybackInfo answers a fresh PlaySessionId (ps-1, ps-2, …), like Jellyfin —
 * on the phone with the HLS remux's TranscodingUrl, as startPlayer() serves it */
function freshSessions(net, { id, item }) {
  let n = 0;
  net.on('POST', '/Items/' + id + '/PlaybackInfo', () => {
    const ps = 'ps-' + ++n;
    const src = item.MediaSources[0];
    const served = __PHONE__
      ? { ...src, SupportsDirectPlay: false, TranscodingUrl: '/videos/' + id + '/master.m3u8?MediaSourceId=' + src.Id + '&PlaySessionId=' + ps }
      : src;
    return playbackInfo(served, { PlaySessionId: ps });
  });
}

const stops = (h) => h.net.callsTo('/Sessions/Playing/Stopped', 'POST');
const infos = (h) => h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST');

describe('start guards', () => {
  beforeAll(warmPlayer, 120000);

  it('a page change (S.epoch) during the PlaybackInfo await drops the start', async () => {
    const h = await startPlayer({ reach: 'request' });
    await h.settle();
    const epoch = h.S.epoch;
    h.nav.openItem('elsewhere', 'Movie');   // Back / another page while the request is out
    expect(h.S.epoch).not.toBe(epoch);
    h.release();
    await h.settle();
    expect(h.video.src).toBe('');
    expect(h.S.screen).not.toBe('player');
    expect(h.P.loading).toBe(false);
    expect(h.net.callsTo('/Sessions/Playing', 'POST')).toHaveLength(0);
  });

  it('closing the player (playGen) during the await drops the start too', async () => {
    const h = await startPlayer({ reach: 'request' });
    await h.settle();
    h.player.exitPlayer();
    const screen = h.S.screen;
    h.release();
    await h.settle();
    expect(h.video.src).toBe('');
    expect(h.S.screen).toBe(screen);
    expect(h.net.callsTo('/Sessions/Playing', 'POST')).toHaveLength(0);
  });

  it('a start that is not interrupted plays (the guard is not a blanket refusal)', async () => {
    const h = await startPlayer({ reach: 'request' });
    await h.settle();
    h.release();
    await h.settle();
    expect(h.video.src).not.toBe('');
    expect(h.S.screen).toBe('player');
  });

  it('startPlayback unmutes the long-lived element', async () => {
    const h = await startPlayer({ reach: 'request' });
    h.video.muted = true;   // left behind by a DevTools test
    h.release();
    await h.settle();
    expect(h.video.src).not.toBe('');
    expect(h.video.muted).toBe(false);
  });

  it('a PlaybackInfo failure from a detail page toasts and stays there', async () => {
    const h = await startPlayer({ reach: 'request', routes: (net, { id }) => net.on('POST', '/Items/' + id + '/PlaybackInfo', net.status(500, { message: 'boom' })) });
    await h.settle();
    expect(h.video.src).toBe('');
    expect(h.S.screen).toBe('detail');
    expect(h.P.error).toBe(null);
  });
});

describe('exit destinations', () => {
  beforeAll(warmPlayer, 120000);

  it('a movie returns to its detail page', async () => {
    const h = await startPlayer();
    h.player.exitPlayer();
    expect(h.S.screen).toBe('detail');
    expect(h.S.detailId).toBe(h.id);
    expect(h.video.src).toBe('');
  });

  it('an episode started from its series page returns to the series', async () => {
    const ep = episode();
    const h = await startPlayer({ item: ep });
    h.S.detailId = ep.SeriesId;   // the page under the player
    h.S.detailType = 'Series';
    h.player.exitPlayer();
    expect(h.S.screen).toBe('detail');
    expect(h.S.detailId).toBe(ep.SeriesId);
    expect(h.S.detailType).toBe('Series');
  });

  it('an episode started from its own page (or another series page) opens the episode', async () => {
    const ep = episode();
    const h = await startPlayer({ item: ep });
    h.S.detailId = 'some-other-series';
    h.S.detailType = 'Series';
    h.player.exitPlayer();
    expect(h.S.detailId).toBe(ep.Id);
    expect(h.S.detailType).toBe('Episode');
  });

  it("Home's hero start returns to Home on hero-resume", async () => {
    const h = await startPlayer({ screen: 'home', base: 'home' });
    h.player.exitPlayer();
    expect(h.S.screen).toBe('home');
    expect(h.nav.takeHomeFocus()).toBe(__PHONE__ ? null : 'hero-resume');   // the phone shim has no focus restore
  });

  it('homeReturn is kept across an Up Next roll-on', async () => {
    const next = episode({ IndexNumber: 2 });
    const h = await startPlayer({
      item: episode({ IndexNumber: 1 }),
      next,
      screen: 'home',
      base: 'home',
      routes: (net) => net.on('POST', '/Items/' + next.Id + '/PlaybackInfo', playbackInfo(next.MediaSources[0], { PlaySessionId: 'ps-next' }))
    });
    await h.settle();
    h.player.playNext(true);
    await h.settle();
    await h.settle();
    expect(h.P.item.Id).toBe(next.Id);
    h.player.exitPlayer();
    expect(h.S.screen).toBe('home');
    expect(h.S.detailId).not.toBe(next.Id);
    expect(h.nav.takeHomeFocus()).toBe(__PHONE__ ? null : 'hero-resume');
  });

  it('a start from a detail page does not inherit an earlier Home start', async () => {
    const h = await startPlayer({ screen: 'home', base: 'home' });
    h.player.exitPlayer();
    h.nav.takeHomeFocus();
    h.S.base = 'detail';
    h.S.screen = 'detail';
    h.player.playItem(h.item, 0);
    await h.settle();
    expect(h.S.screen).toBe('player');
    h.player.exitPlayer();
    expect(h.S.screen).toBe('detail');
    expect(h.S.detailId).toBe(h.id);
  });

  it('suspendPlayback exits to the same destination; off the player it does nothing', async () => {
    const h = await startPlayer({ screen: 'home', base: 'home' });
    h.player.suspendPlayback();
    expect(h.S.screen).toBe('home');
    expect(stops(h)).toHaveLength(1);
    expect(stops(h)[0].keepalive).toBe(true);
    const epoch = h.S.epoch;
    h.player.suspendPlayback();
    expect(h.S.epoch).toBe(epoch);
    expect(stops(h)).toHaveLength(1);
  });
});

describe('the error card', () => {
  beforeAll(warmPlayer, 120000);

  it('a media error while playing raises it at the last good position', async () => {
    const h = await startPlayer();
    at(h, 321);
    h.video.fail(3, 'decode');
    expect(h.P.error).toMatchObject({ title: __PHONE__ ? 'The iPhone couldn’t decode this video' : 'The TV couldn’t decode this video' });
    expect(h.P.error.detail).toMatch(/\(decode\)$/);
    expect(h.P.loading).toBe(false);
  });

  it('an error from the element exitPlayer() just emptied is not a failure', async () => {
    const h = await startPlayer();
    h.player.exitPlayer();
    h.video.fail(4, '');
    expect(h.P.error).toBe(null);
  });
});

describe('playFromHome: resume over 30 s, back to the tile', () => {
  beforeAll(warmPlayer, 120000);

  async function fromHome(posSec, key = 'tile-x') {
    const h = await startPlayer({ screen: 'home', base: 'home', reach: 'request' });
    h.release();
    await h.settle();
    h.player.exitPlayer();
    h.nav.takeHomeFocus();
    const item = { ...h.item, UserData: { PlaybackPositionTicks: Math.round(posSec * TICKS) } };
    h.player.playFromHome(item, key);
    await h.settle();
    return h;
  }

  it.each([
    [25, 0],
    [30, 0],
    [30.9, 30],
    [1234.6, 1234]
  ])('a saved position of %s s starts at %s', async (pos, start) => {
    const h = await fromHome(pos);
    expect(h.P.loadingFrom).toBe(start);
    expect(infos(h).at(-1).body.StartTimeTicks).toBe(start * TICKS);
  });

  it('Back returns to Home on that tile', async () => {
    const h = await fromHome(100, 'tile-cw-1');
    expect(h.S.screen).toBe('player');
    h.player.exitPlayer();
    expect(h.S.screen).toBe('home');
    expect(h.nav.takeHomeFocus()).toBe(__PHONE__ ? null : 'tile-cw-1');
  });
});

describe('restarts inside the player', () => {
  beforeAll(warmPlayer, 120000);

  it('Retry after an error resumes at the last good position, not the 0 the element reads', async () => {
    const h = await startPlayer({ routes: freshSessions });
    at(h, 1234);
    h.video.fail(2, '');
    expect(h.P.error).toMatchObject({ title: 'Lost the connection to the server' });
    h.video.setTime(0);
    h.player.retryPlayback();
    expect(h.P.loadingFrom).toBe(1234);
    await h.settle();
    expect(infos(h)).toHaveLength(2);
    expect(infos(h)[1].body.StartTimeTicks).toBe(1234 * TICKS);
    expect(h.P.sessionId).toBe('ps-2');
    expect(h.P.loadingFrom).toBe(1234);
  });

  it('the old PlaySessionId is Stopped right after the new src is set, at the restart position', async () => {
    let srcAtStop = null;
    const h = await startPlayer({
      routes: (net, ctx) => {
        freshSessions(net, ctx);
        net.on('POST', '/Sessions/Playing/Stopped', () => {
          srcAtStop = srcAtStop || h.video.src;
          return null;
        });
      }
    });
    const firstSrc = h.video.src;
    at(h, 600);
    h.video.fail(2, '');
    h.player.retryPlayback();
    await h.settle();
    const s = stops(h);
    expect(s).toHaveLength(1);
    expect(s[0].body).toMatchObject({ ItemId: h.id, PlaySessionId: 'ps-1', PositionTicks: 600 * TICKS });
    expect(srcAtStop).not.toBe(firstSrc);
    expect(srcAtStop).toBe(h.video.src);
    // and exiting later stops the new session, not the old one again
    h.player.exitPlayer();
    await h.settle();
    expect(stops(h).map((c) => c.body.PlaySessionId)).toEqual(['ps-1', 'ps-2']);
  });

  it('a restart that gets the same PlaySessionId back stops nothing', async () => {
    const h = await startPlayer();   // the default route answers ps-1 every time
    at(h, 600);
    h.player.restartPlayback(600);
    await h.settle();
    expect(stops(h)).toHaveLength(0);
  });

  describe('a burn-in subtitle switch resumes at restartPos()', () => {
    const burnable = () => movie({ MediaSources: [source([video(), audio(), tracks.vobsub()])] });

    it('under the loading card: the last good position, not currentTime (0)', async () => {
      const h = await startPlayer({ item: burnable(), routes: freshSessions });
      at(h, 1234);
      h.P.loading = true;   // a previous restart's card is still up
      h.video.setTime(0);
      h.player.pmSetSub(2);
      await h.settle();
      expect(infos(h)).toHaveLength(2);
      expect(infos(h)[1].body.SubtitleStreamIndex).toBe(2);
      expect(h.P.loadingFrom).toBe(1234);
      expect(stops(h)[0].body.PositionTicks).toBe(1234 * TICKS);
    });

    it('right after a seek: the seek target, not the garbage read', async () => {
      const h = await startPlayer({ item: burnable(), routes: freshSessions });
      at(h, 100);
      h.player.seekTo(2000);
      h.video.setTime(0);
      h.player.pmSetSub(2);
      await h.settle();
      expect(h.P.loadingFrom).toBe(2000);
    });

    it('while playing: the playhead', async () => {
      const h = await startPlayer({ item: burnable(), routes: freshSessions });
      await h.clock.tick(1000);   // out of any seek window
      at(h, 777.4);
      h.player.pmSetSub(2);
      await h.settle();
      expect(h.P.loadingFrom).toBe(777);
    });
  });
});
