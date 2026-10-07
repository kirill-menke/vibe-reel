/* player.svelte.js playFeedStream() (phone): what a MediaSource-fed stream
 * sets up and which feeder failures still reach the player (lane r3-tv-unit,
 * mutation-backed: Stryker on player.svelte.js 461–951).
 *
 * CLAUDE.md (iPhone app): watch-while-downloading and offline copies are
 * "appended to a (Managed)MediaSource by segfeed.js … as a pending stream
 * (P.pending gates off every Jellyfin call)"; `open({ audioIndex, position,
 * jump, onFail })` "makes a fresh feeder". The feeder's jump() is its gap
 * jumping — a quiet seek, never the OSD. A failure only counts while it comes
 * from the feeder of the run on screen. Phone project only. */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { freshImport } from '../helpers/modules.js';
import { useClock } from '../helpers/time.js';
import { mockFetch } from '../helpers/fetch.js';
import { fakeVideo } from '../helpers/video.js';
import { warmPlayer } from '../helpers/player.js';
import { movie, source, video as vstream, audio } from '../helpers/media.js';

async function boot() {
  const m = await freshImport({ modules: { player: 'src/lib/player.svelte.js', nav: 'src/lib/nav.svelte.js' } });
  const clock = useClock();
  const net = mockFetch();
  const video = fakeVideo();
  m.player.setVideoEl(video);
  return { ...m, P: m.player.P, S: m.nav.S, clock, net, video };
}

function feedOpts(extra = {}) {
  const feeders = [];
  const o = {
    item: movie({ Name: 'Offline film' }),
    source: source([vstream(), audio()]),
    open: vi.fn((args) => {
      const f = { url: 'blob:feed-' + (feeders.length + 1), managed: true, stop: vi.fn(), args };
      feeders.push(f);
      return f;
    }),
    exit: vi.fn(),
    checkpoint: vi.fn(),
    ...extra
  };
  return { o, feeders };
}

describe('playFeedStream (phone)', () => {
  beforeAll(warmPlayer, 120000);

  it('the slice: a synthetic item named like the title, no session, DirectPlay', async () => {
    const h = await boot();
    h.P.sessionId = 'ps-old';
    h.P.playMethod = 'Transcode';
    const { o } = feedOpts();
    h.player.playFeedStream(o);
    expect(h.P.item).toEqual({ Id: null, Name: 'Offline film' });
    expect(h.P.sessionId).toBe('');
    expect(h.P.playMethod).toBe('DirectPlay');
  });

  it("the feeder's jump() is a quiet seek (gap jumping never raises the OSD)", async () => {
    const h = await boot();
    const { o, feeders } = feedOpts();
    h.player.playFeedStream(o);
    h.P.osdShown = false;
    feeders[0].args.jump(42.05);
    expect(h.video.seeks.at(-1)).toBe(42.05);
    expect(h.P.osdShown).toBe(false);
    expect(feeders[0].args.position()).toBe(42.05);   // position = effectivePos: the seek target
  });

  it("an earlier playFeedStream's feeder failing raises no card over the new one", async () => {
    const h = await boot();
    const a = feedOpts();
    h.player.playFeedStream(a.o);
    const b = feedOpts();
    h.player.playFeedStream(b.o);
    a.feeders[0].args.onFail({ message: 'old run' });
    expect(h.P.error).toBeNull();
    b.feeders[0].args.onFail({ message: 'this run' });
    expect(h.P.error).not.toBeNull();
  });

  it('a managed feeder turns remote playback off; a trailer source that is not managed leaves it on', async () => {
    const h = await boot();
    const { o } = feedOpts();
    h.player.playFeedStream(o);
    expect(h.video.disableRemotePlayback).toBe(true);
    h.player.exitPlayer();
    const unmanaged = feedOpts();
    unmanaged.o.open = vi.fn((args) => ({ url: 'blob:x', managed: false, stop: vi.fn(), args }));
    h.player.playFeedStream(unmanaged.o);
    expect(h.video.disableRemotePlayback).toBe(false);
  });
});
