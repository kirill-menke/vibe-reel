/* trailer.js: picking a trailer and the YouTube fallback.
 *
 * CLAUDE.md (Video playback → Trailers): sources are Jellyfin `RemoteTrailers`
 * ("TMDB's YouTube list, best 'Official Trailer' picked") and Radarr's
 * `youTubeTrailerId`. "Any failure (yt-dlp broken by a YouTube change, NAS
 * down) toasts and falls back to the YouTube app (`PalmServiceBridge` →
 * `applicationManager/launch` `youtube.leanback.v4`, `contentTarget:
 * https://www.youtube.com/tv?v=ID`)". On the iPhone the fallback is the YouTube
 * web page (a universal link), navigated to when Safari blocks the popup.
 *
 * player.svelte.js is stubbed (vi.doMock): openTrailer's in-app half is
 * playTrailerStream, tested with the player. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { freshImport, TEST_MEDIALIB } from '../helpers/modules.js';
import { useClock, flushPromises } from '../helpers/time.js';
import { mockFetch } from '../helpers/fetch.js';

const PHONE = __PHONE__;
const PLAYER = path.resolve(import.meta.dirname, '../../src/lib/player.svelte.js');
const ID = 'n9xhJrPXop4';   // Dune: Part Two

let m, stub;

beforeEach(async () => {
  stub = { playTrailerStream: vi.fn() };
  vi.doMock(PLAYER, () => stub);
  m = await freshImport({ modules: { tr: 'src/lib/trailer.js', toast: 'src/lib/toast.svelte.js' } });
});

afterEach(() => {
  vi.doUnmock(PLAYER);
});

describe('youtubeId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=' + ID],
    ['http://youtube.com/watch?v=' + ID + '&t=42s'],
    ['https://www.youtube.com/watch?feature=share&v=' + ID],
    ['https://youtu.be/' + ID],
    ['https://youtu.be/' + ID + '?si=abc'],
    ['https://www.youtube.com/embed/' + ID],
    ['https://www.youtube.com/v/' + ID],
    ['https://www.youtube.com/shorts/' + ID],
    ['https://m.youtube.com/watch?v=' + ID]
  ])('%s', (url) => {
    expect(m.tr.youtubeId(url)).toBe(ID);
  });

  it('ids with - and _ are kept whole', () => {
    expect(m.tr.youtubeId('https://www.youtube.com/watch?v=a-b_c-d_e-f')).toBe('a-b_c-d_e-f');
  });

  it('anything else is null', () => {
    for (const u of [null, undefined, '', 'https://vimeo.com/123456789', 'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/channel/UCabcdefghijk', 'not a url']) {
      expect(m.tr.youtubeId(u)).toBeNull();
    }
  });
});

describe('pickTrailer', () => {
  const yt = (id, Name) => ({ Url: 'https://www.youtube.com/watch?v=' + id, Name });

  it("an 'Official Trailer' wins over a teaser, a clip and a plain trailer listed first", () => {
    const item = {
      RemoteTrailers: [yt('clip0000001', 'Clip: The Arena'), yt('teaser00001', 'Teaser'), yt('trailer0001', 'Trailer 2'), yt('official001', 'Official Trailer'), yt('featurette1', 'Featurette')]
    };
    expect(m.tr.pickTrailer(item)).toBe('official001');
  });

  it('any trailer beats a teaser; a teaser beats a clip; ties keep TMDB order', () => {
    expect(m.tr.pickTrailer({ RemoteTrailers: [yt('teaser00001', 'Official Teaser'), yt('trailer0001', 'Trailer')] })).toBe('trailer0001');
    expect(m.tr.pickTrailer({ RemoteTrailers: [yt('clip0000001', 'Clip'), yt('teaser00001', 'Teaser')] })).toBe('teaser00001');
    expect(m.tr.pickTrailer({ RemoteTrailers: [yt('trailer0001', 'Trailer'), yt('trailer0002', 'Final Trailer')] })).toBe('trailer0001');
  });

  it('a dub loses to any undubbed trailer, wherever it is listed', () => {
    expect(m.tr.pickTrailer({ RemoteTrailers: [yt('dubbed00001', 'Official Trailer (German Dub)'), yt('trailer0001', 'Trailer')] })).toBe('trailer0001');
    expect(m.tr.pickTrailer({ RemoteTrailers: [yt('dubbed00001', 'Official Trailer (Dubbed)')] })).toBe('dubbed00001');
  });

  it('a dub loses to an undubbed teaser wherever it is listed, but still beats a clip (V-F8)', () => {
    expect(m.tr.pickTrailer({ RemoteTrailers: [yt('dubbed00001', 'Official Trailer (German Dub)'), yt('clip0000001', 'Clip')] })).toBe('dubbed00001');
    expect(m.tr.pickTrailer({ RemoteTrailers: [yt('dubbed00001', 'Official Trailer (German Dub)'), yt('teaser00001', 'Teaser')] })).toBe('teaser00001');
    expect(m.tr.pickTrailer({ RemoteTrailers: [yt('teaser00001', 'Teaser'), yt('dubbed00001', 'Official Trailer (German Dub)')] })).toBe('teaser00001');
  });

  it("a dubbed trailer not named 'Official' still beats a clip or featurette listed before it (V-F8 review)", () => {
    expect(m.tr.pickTrailer({ RemoteTrailers: [yt('clip0000001', 'Behind the Scenes Clip'), yt('dubbed00001', 'Trailer (German Dub)')] })).toBe('dubbed00001');
    expect(m.tr.pickTrailer({ RemoteTrailers: [yt('featurette1', 'Featurette'), yt('dubbed00001', 'Dubbed Trailer')] })).toBe('dubbed00001');
    expect(m.tr.pickTrailer({ RemoteTrailers: [yt('clip0000001', 'Clip'), yt('dubbed00001', 'Official Trailer (German Dub)')] })).toBe('dubbed00001');
    // …and still loses to any undubbed teaser, wherever it is listed.
    expect(m.tr.pickTrailer({ RemoteTrailers: [yt('dubbed00001', 'Trailer (German Dub)'), yt('teaser00001', 'Teaser')] })).toBe('teaser00001');
    expect(m.tr.pickTrailer({ RemoteTrailers: [yt('dubbed00001', 'Official Trailer (German Dub)'), yt('teaser00001', 'Teaser')] })).toBe('teaser00001');
  });

  it('non-YouTube entries are skipped; none at all is null', () => {
    expect(m.tr.pickTrailer({ RemoteTrailers: [{ Url: 'https://vimeo.com/1', Name: 'Official Trailer' }, yt('clip0000001', 'Clip')] })).toBe('clip0000001');
    expect(m.tr.pickTrailer({ RemoteTrailers: [] })).toBeNull();
    expect(m.tr.pickTrailer({})).toBeNull();
    expect(m.tr.pickTrailer(null)).toBeNull();
  });
});

describe('openTrailer', () => {
  it('plays in our own player with the title and backdrop', () => {
    m.tr.openTrailer(ID, { title: 'Dune: Part Two', art: 'http://jf.test/b.jpg' });
    expect(stub.playTrailerStream).toHaveBeenCalledTimes(1);
    expect(stub.playTrailerStream.mock.calls[0][0]).toMatchObject({ id: ID, title: 'Dune: Part Two', art: 'http://jf.test/b.jpg' });
  });

  it('no id: nothing', () => {
    m.tr.openTrailer(null);
    m.tr.openTrailer('');
    expect(stub.playTrailerStream).not.toHaveBeenCalled();
  });

  it('a failure toasts the reason and opens YouTube instead', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({});
    m.tr.openTrailer(ID, {});
    stub.playTrailerStream.mock.calls[0][0].onFail(new Error('yt-dlp failed'));
    expect(m.toast.toastState.msg).toBe('Couldn’t load the trailer here (yt-dlp failed) — opening YouTube');
    await flushPromises();
    expect(open).toHaveBeenCalledWith('https://www.youtube.com/watch?v=' + ID, '_blank');
    expect(m.toast.toastState.msg).toBe('Couldn’t load the trailer here (yt-dlp failed) — opening YouTube');
  });

  if (!PHONE) {
    it('TV: YouTube refusing the launch too says so', async () => {
      const calls = [];
      vi.stubGlobal(
        'PalmServiceBridge',
        class {
          call(uri, params) {
            calls.push([uri, params]);
            queueMicrotask(() => this.onservicecallback(JSON.stringify({ returnValue: false })));
          }
        }
      );
      m.tr.openTrailer(ID, {});
      stub.playTrailerStream.mock.calls[0][0].onFail(null);
      expect(m.toast.toastState.msg).toBe('Couldn’t load the trailer here (error) — opening YouTube');
      await flushPromises();
      expect(calls).toHaveLength(1);
      expect(m.toast.toastState.msg).toBe('Couldn’t open YouTube either');
    });
  }
});

describe('playTrailer — ' + (PHONE ? 'iPhone: the YouTube web page' : 'TV: the YouTube app'), () => {
  it('no id resolves false', async () => {
    expect(await m.tr.playTrailer('')).toBe(false);
  });

  if (!PHONE) {
    it('launches youtube.leanback.v4 with contentTarget https://www.youtube.com/tv?v=ID', async () => {
      const calls = [];
      vi.stubGlobal(
        'PalmServiceBridge',
        class {
          call(uri, params) {
            calls.push([uri, JSON.parse(params)]);
            queueMicrotask(() => this.onservicecallback(JSON.stringify({ returnValue: true })));
          }
        }
      );
      expect(await m.tr.playTrailer(ID)).toBe(true);
      expect(calls).toEqual([['luna://com.webos.applicationManager/launch', { id: 'youtube.leanback.v4', params: { contentTarget: 'https://www.youtube.com/tv?v=' + ID } }]]);
    });

    it('no answer within 5 s still resolves (true) — the button must not hang', async () => {
      const clock = useClock();
      vi.stubGlobal('PalmServiceBridge', class { call() {} });
      let r = 'pending';
      m.tr.playTrailer(ID).then((v) => (r = v));
      await clock.tick(4900);
      expect(r).toBe('pending');
      await clock.tick(200);
      expect(r).toBe(true);
    });

    it('an unparseable answer or a throwing bridge is false', async () => {
      vi.stubGlobal('PalmServiceBridge', class { call() { queueMicrotask(() => this.onservicecallback('<html>')); } });
      expect(await m.tr.playTrailer(ID)).toBe(false);
      vi.stubGlobal('PalmServiceBridge', class { call() { throw new Error('denied'); } });
      expect(await m.tr.playTrailer(ID)).toBe(false);
    });

    it('a desktop browser (no PalmServiceBridge) opens the web page', async () => {
      vi.stubGlobal('PalmServiceBridge', undefined);
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      expect(await m.tr.playTrailer(ID)).toBe(true);
      expect(open).toHaveBeenCalledWith('https://www.youtube.com/watch?v=' + ID, '_blank');
    });
  } else {
    it('opens https://www.youtube.com/watch?v=ID in a new window (no noopener: open() must return the window)', async () => {
      const open = vi.spyOn(window, 'open').mockReturnValue({});
      expect(await m.tr.playTrailer(ID)).toBe(true);
      expect(open).toHaveBeenCalledWith('https://www.youtube.com/watch?v=' + ID, '_blank');
    });

    it('a blocked popup navigates instead', async () => {
      vi.spyOn(window, 'open').mockReturnValue(null);
      const hrefs = [];
      const loc = { set href(v) { hrefs.push(v); }, get href() { return 'http://phone.test/'; } };
      vi.stubGlobal('location', loc);
      expect(await m.tr.playTrailer(ID)).toBe(true);
      expect(hrefs).toEqual(['https://www.youtube.com/watch?v=' + ID]);
    });

    it('open() throwing and navigation refused: false', async () => {
      vi.spyOn(window, 'open').mockImplementation(() => {
        throw new Error('blocked');
      });
      vi.stubGlobal('location', { set href(v) { throw new Error('no'); } });
      expect(await m.tr.playTrailer(ID)).toBe(false);
    });
  }
});

/* A show's trailer where Jellyfin has none: reel-api's strictly checked YouTube
 * search (GET /api/metadata/tv/{id}/trailer), asked in idle time — CLAUDE.md
 * engine costs: "Each fetch() call costs 3–9 ms of main thread synchronously.
 * Don't fire requests from a navigation task that don't need to go out then."
 * The screens hand the returned cancel to onMount, so a late answer after the
 * screen is gone writes nothing ("Every await can land on a different screen"). */
describe('findShowTrailer', () => {
  const PATH = '/api/metadata/tv/305288/trailer';
  let net, idle;

  beforeEach(() => {
    net = mockFetch();
    idle = [];
    vi.stubGlobal('requestIdleCallback', (fn, opts) => idle.push({ fn, opts }) && idle.length);
    vi.stubGlobal('cancelIdleCallback', (id) => idle[id - 1] && (idle[id - 1].cancelled = true));
  });
  afterEach(() => vi.unstubAllGlobals());
  const runIdle = () =>
    idle.filter((x) => !x.cancelled && !x.ran).forEach((x) => {
      x.ran = true;
      x.fn();
    });

  it('asks in idle time (1 s at most), then hands over the YouTube id', async () => {
    net.on('GET', PATH, { trailer: ID });
    const found = vi.fn();
    m.tr.findShowTrailer('305288', found);
    expect(net.calls).toHaveLength(0);   // not on the navigation task
    expect(idle).toHaveLength(1);
    expect(idle[0].opts).toEqual({ timeout: 1000 });
    runIdle();
    await flushPromises();
    expect(net.calls.map((c) => c.url)).toEqual([TEST_MEDIALIB + PATH]);
    expect(found).toHaveBeenCalledExactlyOnceWith(ID);
  });

  it('nothing found (or the call failed): onFound never runs', async () => {
    net.once('GET', PATH, { trailer: null });
    const found = vi.fn();
    m.tr.findShowTrailer('305288', found);
    runIdle();
    await flushPromises();
    net.once('GET', PATH, net.status(503));
    m.tr.findShowTrailer('305288', found);
    runIdle();
    await flushPromises();
    expect(net.calls).toHaveLength(2);
    expect(found).not.toHaveBeenCalled();
  });

  it('no tvdb id: no request at all', async () => {
    const found = vi.fn();
    for (const id of [undefined, null, '']) m.tr.findShowTrailer(id, found)();
    expect(idle).toHaveLength(0);
    expect(net.calls).toHaveLength(0);
  });

  it('cancelled before idle time: no request; after it: the late answer is dropped', async () => {
    net.on('GET', PATH, { trailer: ID });
    const found = vi.fn();
    m.tr.findShowTrailer('305288', found)();
    runIdle();
    await flushPromises();
    expect(net.calls).toHaveLength(0);
    const cancel = m.tr.findShowTrailer('305288', found);
    runIdle();
    cancel();   // the screen went away while the answer was on its way
    await flushPromises();
    expect(net.calls).toHaveLength(1);
    expect(found).not.toHaveBeenCalled();
  });

  it('without requestIdleCallback it asks on the next task', async () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    const clock = useClock();
    net.on('GET', PATH, { trailer: ID });
    const found = vi.fn();
    const cancel = m.tr.findShowTrailer('305288', found);
    expect(net.calls).toHaveLength(0);
    await clock.tick(0);
    await flushPromises();
    expect(found).toHaveBeenCalledExactlyOnceWith(ID);
    cancel();
    m.tr.findShowTrailer('305288', found)();   // cancelled: the timer never fires
    await clock.tick(10);
    expect(net.calls).toHaveLength(1);
  });
});
