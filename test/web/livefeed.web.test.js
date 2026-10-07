/* Watch-while-downloading in the web build (livefeed.js, pendingplay.js).
 *
 * reel-api's livehls.py copies AAC/AC-3/E-AC-3 and turns anything else into
 * AC-3 5.1 — the iPhone's codecs. Desktop Chrome/Firefox decode no AC-3/E-AC-3,
 * so the web build asks for `codec=aac` on every call of the job (start,
 * status ping, playlist, header, segments): the server then copies only AAC and
 * encodes the rest to AAC. canWatchPending is the phone's (any MediaSource);
 * without one, Play explains in a browser's words. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { freshImport, TEST_MEDIALIB } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { installMSE } from '../helpers/mse.js';
import { useClock } from '../helpers/time.js';
import { m3u8, uniform } from '../helpers/trailer.js';

const PLAYER = path.resolve(import.meta.dirname, '../../src/lib/player.svelte.js');
const DL = 'abcdef0123456789abcdef0123456789abcdef01';
const HLS = TEST_MEDIALIB + '/api/downloads/' + DL + '/hls';

let media, feed;
beforeEach(() => {
  media = new EventTarget();
  feed = null;
});
afterEach(() => {
  feed?.stop();
  vi.doUnmock(PLAYER);
});

describe('livefeed.js asks for AAC', () => {
  it('codec=aac on the start, the status ping, the playlist, the header and every segment', async () => {
    vi.doMock(PLAYER, () => ({ videoEl: () => media }));
    const { lf } = await freshImport({ modules: { lf: 'src/lib/livefeed.js' } });
    const mse = installMSE();
    const net = mockFetch();
    const clock = useClock();
    const segs = uniform(3);
    net.on(null, HLS + '?audio=1&codec=aac', { state: 'remuxing', codecs: 'avc1.640028,mp4a.40.2', duration: 18 });
    net.on('GET', HLS + '/1/index.m3u8?codec=aac', () => net.text(m3u8(segs, true)));
    net.on('GET', HLS + '/1/init.mp4?codec=aac', () => mse.initSegment(500));
    net.on('GET', (r) => r.url.startsWith(HLS + '/1/s') && r.url.endsWith('.m4s?codec=aac'), (r) => {
      const g = segs.find((s) => r.url.includes('/' + s.name + '?'));
      return mse.segment(g.start, g.end, 4000);
    });
    const onFail = vi.fn();
    feed = lf.liveOpener(DL)({ audioIndex: 1, position: () => 0, jump: () => {}, onFail });
    await clock.tick(10);
    for (let i = 0; i < 10; i++) await clock.tick(0);
    expect(onFail).not.toHaveBeenCalled();
    expect(net.unmatched).toEqual([]);
    expect(net.calls.filter((c) => c.url.endsWith('.m4s?codec=aac'))).toHaveLength(3);
    await clock.tick(60000);   // the 60 s status ping
    expect(net.calls.filter((c) => c.method === 'GET' && c.url === HLS + '?audio=1&codec=aac').length).toBeGreaterThan(0);
    expect(net.unmatched).toEqual([]);
  });
});

describe('pendingplay.js without a MediaSource', () => {
  it('canWatchPending is false and Play explains in a browser’s words', async () => {
    vi.stubGlobal('MediaSource', undefined);
    vi.stubGlobal('ManagedMediaSource', undefined);
    const stub = { playPendingStream: vi.fn(), playFeedStream: vi.fn(), videoEl: () => null };
    vi.doMock(PLAYER, () => stub);
    const { pp, toast } = await freshImport({ modules: { pp: 'src/lib/pendingplay.js', toast: 'src/lib/toast.svelte.js' } });
    const net = mockFetch();
    expect(pp.canWatchPending).toBe(false);
    await pp.playPending({ download_id: DL, status: 'downloading', type: 'movie', title: 'Dune' });
    expect(toast.toastState.msg).toBe('Watching while downloading needs a browser with Media Source Extensions');
    expect(net.calls).toEqual([]);
    expect(stub.playFeedStream).not.toHaveBeenCalled();
  });

  it('with one: canWatchPending', async () => {
    installMSE();
    vi.doMock(PLAYER, () => ({ playPendingStream: vi.fn(), playFeedStream: vi.fn(), videoEl: () => null }));
    const { pp } = await freshImport({ modules: { pp: 'src/lib/pendingplay.js' } });
    expect(pp.canWatchPending).toBe(true);
  });
});
