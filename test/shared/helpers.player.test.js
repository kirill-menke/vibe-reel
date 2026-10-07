/* Self-tests of the player harness (test/helpers/player.js): a DirectPlay
 * start against the mocked Jellyfin reaches 'playing' with no request left
 * unanswered. Every player-* test file builds on this. */
import { describe, it, expect, beforeAll } from 'vitest';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, episode, source, video, audio, sub, tracks, segment, chapters } from '../helpers/media.js';
import { TEST_SERVER, TEST_TOKEN } from '../helpers/modules.js';

describe('startPlayer harness', () => {
  beforeAll(warmPlayer, 120000);

  it('a movie start reaches playing: loading card down, S.screen player, no unmatched request', async () => {
    const h = await startPlayer();
    expect(h.S.screen).toBe('player');
    expect(h.P.loading).toBe(false);
    expect(h.P.spinner).toBe(false);
    expect(h.P.item.Id).toBe(h.id);
    expect(h.P.sessionId).toBe('ps-1');
    expect(h.video.calls.some((c) => c[0] === 'play')).toBe(true);
    expect(h.net.unmatched).toEqual([]);
  });

  it('PlaybackInfo is a POST with the device profile and the user in the body', async () => {
    const h = await startPlayer();
    const [pi] = h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST');
    expect(pi.body.UserId).toBe('u1');
    expect(pi.body.DeviceProfile).toBeTruthy();
    expect(pi.headers.Authorization || pi.headers.authorization).toContain('Token="' + TEST_TOKEN + '"');
  });

  it('the Sessions/Playing report goes out once, after the first frame', async () => {
    const h = await startPlayer({ reach: 'metadata' });
    expect(h.net.callsTo('/Sessions/Playing', 'POST')).toHaveLength(0);
    expect(h.P.loading).toBe(true);
    h.video.setReadyState(4);
    await h.settle();
    const sent = h.net.callsTo('/Sessions/Playing', 'POST');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ ItemId: h.id, PlaySessionId: 'ps-1', MediaSourceId: h.source.Id });
    expect(sent[0].body.PlayMethod).toBe(__PHONE__ ? 'DirectStream' : 'DirectPlay');
    expect(h.P.loading).toBe(false);
  });

  it('TV: a static=true /Videos/{id}/stream.{container} URL; phone: main.m3u8, never master.m3u8', async () => {
    const h = await startPlayer();
    const url = new URL(h.video.src);
    if (__PHONE__) {
      expect(url.pathname).toBe('/videos/' + h.id + '/main.m3u8');
      expect(h.video.src).not.toContain('master.m3u8');
      expect(url.searchParams.get('MediaSourceId')).toBe(h.source.Id);
      expect(h.P.playMethod).toBe('DirectStream');
    } else {
      expect(url.origin).toBe(TEST_SERVER);
      expect(url.pathname).toBe('/Videos/' + h.id + '/stream.mkv');
      expect(url.searchParams.get('static')).toBe('true');
      expect(url.searchParams.get('mediaSourceId')).toBe(h.source.Id);
      expect(url.searchParams.get('PlaySessionId')).toBe('ps-1');
      expect(h.P.playMethod).toBe('DirectPlay');
    }
  });

  it('phone and TV: an MP4 source DirectPlays as the static file', async () => {
    const src = source([video({ Codec: 'h264' }), audio({ Codec: 'aac' })], { Container: 'mp4' });
    const h = await startPlayer({ item: movie({ MediaSources: [src] }) });
    expect(new URL(h.video.src).pathname).toBe('/Videos/' + h.id + '/stream.mp4');
    expect(h.P.playMethod).toBe('DirectPlay');
    expect(h.net.unmatched).toEqual([]);
  });

  it('an episode start answers the series, next-episode and IntroDB lookups', async () => {
    const next = episode({ IndexNumber: 2 });
    const ep = episode({ MediaSources: [source([video(), tracks.eac3()])] });
    const h = await startPlayer({
      item: ep,
      next,
      segments: [segment('Intro', 60, 150), segment('Outro', 2500, 2700)],
      chapters: chapters([['Chapter 1', 0], ['Chapter 2', 600]]),
      seriesItem: { Id: ep.SeriesId, Type: 'Series', ProviderIds: { Imdb: 'tt0000001' } },
      introdb: { recap: { start: 0, end: 30 } }
    });
    await h.settle();
    expect(h.P.next && h.P.next.Id).toBe(next.Id);
    expect(h.P.skips.map((s) => s.kind)).toEqual(['recap', 'intro']);
    expect(h.P.credits).toMatchObject({ start: 2500, from: 'segment' });
    expect(h.P.chapters).toHaveLength(2);
    expect(h.net.callsTo((r) => r.url.includes('/api/segments/tt0000001/1/1'))).toHaveLength(1);
    expect(h.net.unmatched).toEqual([]);
  });

  it("reach: 'request' holds PlaybackInfo until release()", async () => {
    const h = await startPlayer({ reach: 'request' });
    await h.settle();
    expect(h.video.src).toBe('');
    expect(h.S.screen).toBe('detail');
    h.release();
    await h.settle();
    expect(h.S.screen).toBe('player');
    expect(h.video.src).not.toBe('');
  });

  it('a resume point is seeked to on loadedmetadata and announced on the loading card', async () => {
    const h = await startPlayer({ resumeSec: 1234, reach: 'metadata' });
    expect(h.P.loadingFrom).toBe(1234);
    expect(h.video.seeks).toEqual([1234]);
  });

  it('a text subtitle chosen at start is fetched as VTT from the mocked server', async () => {
    const src = source([video(), audio(), sub({ Language: 'eng' })]);
    const h = await startPlayer({
      item: movie({ MediaSources: [src] }),
      storage: { 'reel.settings': JSON.stringify({ subMode: 'always' }) }
    });
    await h.settle();
    expect(h.P.subIndex).toBe(2);
    expect(h.net.callsTo((r) => r.path.endsWith('/Subtitles/2/0/Stream.vtt'))).toHaveLength(1);
    expect(h.net.unmatched).toEqual([]);
  });
});
