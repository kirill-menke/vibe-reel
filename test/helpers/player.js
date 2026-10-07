/* Player harness: start an item in the real playback engine
 * (player.svelte.js) against a mocked Jellyfin, a fake <video> and a fake
 * clock, up to the point a test needs.
 *
 *   const h = await startPlayer({ item: episode(), segments: [segment('Intro', 60, 150)] });
 *   h.P.loading            // false — the first frame "played"
 *   h.video.advance(1)     // drive the playhead; await h.clock.tick(500) for the watchdog
 *   h.net.callsTo('/Sessions/Playing', 'POST')
 *   h.player.exitPlayer()
 *
 * Options (all optional):
 *   item          the Jellyfin item to play (default: a movie). Its MediaSources[0]
 *                 is what playItem() picks (pickSource).
 *   source        what PlaybackInfo answers with (default: the item's source; on the
 *                 phone a non-MP4 source gets SupportsDirectPlay: false + a
 *                 TranscodingUrl …/master.m3u8, like Jellyfin's answer to phoneProfile)
 *   info          the whole PlaybackInfo answer instead (overrides `source`)
 *   playSessionId PlaybackInfo's PlaySessionId (default 'ps-1')
 *   resumeSec     playItem(item, resumeSec)
 *   segments      /MediaSegments/{id} Items (media.js segment())
 *   chapters      the item's Chapters (media.js chapters()) on the /Items?Ids= query
 *   trickplay     the item's Trickplay field ({ [sourceId]: { [width]: layout } })
 *   next          the episode /Shows/{sid}/Episodes lists after `item` (episodes);
 *                 its item, segments (none) and one-item query are routed too, so
 *                 a roll-on's start makes no unmatched request (its PlaybackInfo
 *                 is the test's: `routes`)
 *   seriesItem    what GET /Items/{SeriesId} answers (default: a series without an IMDb id)
 *   introdb       reel-api /api/segments/… answer (default: 404 → no community markers)
 *   vtt           text served for any …/Subtitles/…/Stream.vtt
 *   storage       extra localStorage keys seeded before the fresh import
 *   screen, base  S.screen / S.base before the start (default 'detail' / 'detail')
 *   reach         'request' (PlaybackInfo not answered yet — it is held until
 *                 h.release()), 'src' (src set, no metadata yet), 'metadata'
 *                 ('loadedmetadata' fired, readyState 1 so no 'playing' yet —
 *                 h.video.setReadyState(4) delivers it), or 'playing' (default)
 *   duration      the fake video's duration (default: the item's runtime)
 *   routes        (net, ctx) => void — extra routes, added after the defaults (so
 *                 they win)
 *
 * Returns { P, S, player, nav, api, cfg, settings, video, net, clock, item, source,
 * info, id, release, settle }. `settle()` = flush promises (await h.settle()).
 * Every module shares one fresh graph (freshImport), so module state — timers,
 * playGen, the SWR store — starts clean in every test.
 *
 * ⚠️ The first import of the player graph in a worker pays the Svelte
 * compiler's cold start (8–16 s measured, more under a parallel run) — longer
 * than the 10 s test timeout. Every file that uses startPlayer() does
 *   beforeAll(warmPlayer, 120000);
 * which transforms the graph once; later fresh imports reuse the transform. The default routes cover
 * every request a DirectPlay start makes; a test can assert
 * `expect(h.net.unmatched).toEqual([])`. */
import { mockFetch } from './fetch.js';
import { fakeVideo } from './video.js';
import { useClock } from './time.js';
import { freshImport, TEST_MEDIALIB } from './modules.js';
import { movie, playbackInfo } from './media.js';

const TICKS = 10000000;

/** beforeAll(warmPlayer, 120000): transform the player graph once per file. */
export async function warmPlayer() {
  await freshImport({ modules: { player: 'src/lib/player.svelte.js', nav: 'src/lib/nav.svelte.js', settings: 'src/lib/settings.svelte.js' } });
}

export async function startPlayer(opts = {}) {
  // The fresh import runs on real timers: the module runner's own timers must
  // not wait on a fake clock (a first phone-graph transform hung 10 s that way).
  // Nothing in these modules starts a timer at import time.
  const mods = await freshImport({
    storage: opts.storage || {},
    modules: {
      player: 'src/lib/player.svelte.js',
      nav: 'src/lib/nav.svelte.js',
      api: 'src/lib/api.js',
      config: 'src/lib/config.js',
      settings: 'src/lib/settings.svelte.js'
    }
  });
  const { player, nav, api, config, settings } = mods;
  const item = opts.item || movie();
  const id = item.Id;
  const itemSource = (item.MediaSources || [])[0];
  let served = opts.source || itemSource;
  if (__PHONE__ && !opts.source && served && !/^(mp4|m4v|mov)$/i.test(served.Container || '')) {
    served = {
      ...served,
      SupportsDirectPlay: false,
      TranscodingUrl:
        '/videos/' + id + '/master.m3u8?MediaSourceId=' + served.Id + '&PlaySessionId=' + (opts.playSessionId || 'ps-1') + '&VideoCodec=hevc&AudioCodec=eac3'
    };
  }
  const info = opts.info || playbackInfo(served, { PlaySessionId: opts.playSessionId || 'ps-1' });

  const clock = useClock();
  const net = mockFetch();
  let release = () => {};
  const held = opts.reach === 'request' ? new Promise((res) => (release = () => res(info))) : null;
  net.on('POST', '/Items/' + id + '/PlaybackInfo', () => held || info);
  // one-item queries: Fields=Trickplay,Chapters (startPlayback) and Fields=Chapters (segments.js)
  net.on('GET', (r) => r.path === '/Items' && new URLSearchParams(r.query).get('Ids') === id, () => ({
    Items: [{ Id: id, ...(opts.chapters ? { Chapters: opts.chapters } : {}), ...(opts.trickplay ? { Trickplay: opts.trickplay } : {}) }],
    TotalRecordCount: 1
  }));
  net.on('GET', '/MediaSegments/' + id, { Items: opts.segments || [] });
  if (item.SeriesId) {
    net.on('GET', '/Items/' + item.SeriesId, opts.seriesItem || { Id: item.SeriesId, Type: 'Series', Name: 'Test Series', ProviderIds: {} });
    net.on('GET', '/Shows/' + item.SeriesId + '/Episodes', { Items: [item, ...(opts.next ? [opts.next] : [])] });
  }
  if (opts.next) {
    // the roll-on: the next episode's item, and its own start's marker/trickplay lookups
    // (no segments, no chapters — a test that needs them routes them itself)
    const nid = opts.next.Id;
    net.on('GET', '/Items/' + nid, opts.next);
    net.on('GET', '/MediaSegments/' + nid, { Items: [] });
    net.on('GET', (r) => r.path === '/Items' && new URLSearchParams(r.query).get('Ids') === nid, { Items: [{ Id: nid }], TotalRecordCount: 1 });
  }
  net.on('GET', (r) => r.url.startsWith(TEST_MEDIALIB + '/api/segments/'), () => (opts.introdb ? opts.introdb : net.status(404, { detail: 'not found' })));
  net.on('GET', (r) => /\/Subtitles\/\d+\/0\/Stream\.vtt$/.test(r.path), () => net.text(opts.vtt || 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n', 'text/vtt'));
  for (const p of ['/Sessions/Playing', '/Sessions/Playing/Progress', '/Sessions/Playing/Stopped']) net.on('POST', p, null);
  if (opts.routes) opts.routes(net, { id, item });

  nav.S.screen = opts.screen || 'detail';
  nav.S.base = opts.base || 'detail';

  const runtime = (item.RunTimeTicks || (itemSource && itemSource.RunTimeTicks) || 0) / TICKS;
  const video = fakeVideo({ duration: NaN });
  player.setVideoEl(video);

  const settle = () => clock.flush();
  const h = {
    P: player.P,
    S: nav.S,
    player,
    nav,
    api,
    cfg: config.cfg,
    settings,
    SET: settings.SET,
    video,
    net,
    clock,
    item,
    source: served,
    info,
    id,
    release: () => release(),
    settle
  };

  player.playItem(item, opts.resumeSec || 0);
  if (opts.reach === 'request') return h;
  await settle();
  if (!video.src) throw new Error('startPlayer: the engine set no src — ' + JSON.stringify(net.unmatched.map((c) => c.method + ' ' + c.url)));
  if (opts.reach === 'src') return h;
  video.setDuration(opts.duration ?? runtime);
  video.setReadyState(1);
  video.emit('loadedmetadata');   // the engine's handler calls play(): 'playing' waits for data
  await settle();
  if (opts.reach === 'metadata') return h;
  video.setReadyState(4);   // first frame → 'playing'
  await settle();
  return h;
}
