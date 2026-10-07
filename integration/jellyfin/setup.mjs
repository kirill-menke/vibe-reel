/* Set a fresh Jellyfin up for the contract run, through its own API only:
 * startup wizard → user alice (admin, password alice-pw, an avatar) → Movies +
 * Shows libraries over the fixture media (metadata fetchers off: the run is
 * offline) → scan → trickplay for the contract movie → watch state for Home
 * (Browser Movie resumable at 40 s, S01E01 played → S01E02 is Next Up).
 *
 * The harness's own calls carry Client="VibeReel-IT" so they are never
 * mistaken for the apps' traffic in the recording proxy (they don't go through
 * it anyway). Every step throws with the server's answer on failure.
 *
 *   setup({ jf, media, log }) → { admin: { token, userId }, items: { movie, browser, series, ep1, ep2 }, timings } */
import { FIXTURES } from './fixtures.mjs';
import { png } from '../../e2e/server/png.mjs';

export const USER = { name: 'alice', password: 'alice-pw' };
export const IT_DEVICE = 'reel-jellyfin-it';
export const TICKS = 10000000;
export const RESUME_SEC = 40; // Browser Movie's resume point (MovieDetail offers Resume above 30 s)

export function itAuth(token) {
  return `MediaBrowser Client="VibeReel-IT", Device="integration", DeviceId="${IT_DEVICE}", Version="1.0"` + (token ? `, Token="${token}"` : '');
}

/* a raw call with the harness's identity; → { status, headers, json, text } (never throws on HTTP) */
export async function call(jf, method, path, { token, body, headers = {}, raw = false, timeout = 30000 } = {}) {
  const h = { Authorization: itAuth(token), ...headers };
  let b = body;
  if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string') {
    h['Content-Type'] = 'application/json';
    b = JSON.stringify(body);
  }
  const r = await fetch(jf + path, { method, headers: h, body: b, signal: AbortSignal.timeout(timeout) });
  const out = { status: r.status, headers: r.headers };
  if (raw) {
    out.bytes = Buffer.from(await r.arrayBuffer());
    return out;
  }
  out.text = await r.text();
  try {
    out.json = out.text && /json/.test(r.headers.get('content-type') || '') ? JSON.parse(out.text) : undefined;
  } catch {}
  return out;
}

async function ok(jf, method, path, opts) {
  const r = await call(jf, method, path, opts);
  if (r.status >= 300) throw new Error(`setup: ${method} ${path} → ${r.status} ${String(r.text || '').slice(0, 300)}`);
  return r.json ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, { timeout = 120000, every = 500 } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() - t0 > timeout) throw new Error(`setup: timed out waiting for ${what}`);
    await sleep(every);
  }
}

export async function setup({ jf, media, log = () => {} }) {
  const timings = {};
  const t = (k, t0) => (timings[k] = Date.now() - t0);
  let t0 = Date.now();

  // ---- wizard ----
  const pub = await ok(jf, 'GET', '/System/Info/Public');
  if (!pub.StartupWizardCompleted) {
    await ok(jf, 'POST', '/Startup/Configuration', { body: { UICulture: 'en-US', MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en', ServerName: 'reel-it' } });
    await ok(jf, 'GET', '/Startup/User');
    await ok(jf, 'POST', '/Startup/User', { body: { Name: USER.name, Password: USER.password } });
    const ra = await call(jf, 'POST', '/Startup/RemoteAccess', { body: { EnableRemoteAccess: false, EnableAutomaticPortMapping: false } });
    if (ra.status >= 300 && ra.status !== 404) throw new Error('setup: /Startup/RemoteAccess → ' + ra.status);
    await ok(jf, 'POST', '/Startup/Complete');
  }
  t('wizard', t0);
  t0 = Date.now();
  const auth = await ok(jf, 'POST', '/Users/AuthenticateByName', { body: { Username: USER.name, Pw: USER.password } });
  const token = auth.AccessToken, userId = auth.User.Id;
  const tk = { token };

  // avatar (so /UserImage?userId= has something to serve)
  {
    const r = await call(jf, 'POST', '/UserImage?userId=' + userId, { token, body: png(96, 96, 'alice').toString('base64'), headers: { 'Content-Type': 'image/png' } });
    if (r.status >= 300) log(`note: avatar upload → ${r.status} ${String(r.text).slice(0, 120)}`);
  }

  // server config: trickplay like the NAS (320 px, 10 s), no plugin repositories (offline)
  const sc = await ok(jf, 'GET', '/System/Configuration', tk);
  sc.TrickplayOptions = { ...(sc.TrickplayOptions || {}), WidthResolutions: [320], Interval: 10000, TileWidth: 10, TileHeight: 10, EnableKeyFrameOnlyExtraction: false, ProcessThreads: 2 };
  sc.PluginRepositories = [];
  // the fixtures are 30–120 s long; the default (300 s) would make Stopped save no resume point at all
  sc.MinResumeDurationSeconds = 0;
  sc.EnableMetrics = false;
  await ok(jf, 'POST', '/System/Configuration', { ...tk, body: sc });

  // ---- libraries ----
  const noFetch = (types) => types.map((Type) => ({ Type, MetadataFetchers: [], ImageFetchers: [], MetadataFetcherOrder: [], ImageFetcherOrder: [] }));
  const libOpts = (types) => ({
    LibraryOptions: {
      Enabled: true,
      EnableRealtimeMonitor: false,
      EnableChapterImageExtraction: false,
      ExtractChapterImagesDuringLibraryScan: false,
      EnableTrickplayImageExtraction: true,
      ExtractTrickplayImagesDuringLibraryScan: true,
      SaveTrickplayWithMedia: false,
      SaveLocalMetadata: false,
      EnableInternetProviders: false,
      EnableEmbeddedTitles: false,
      EnableEmbeddedExtrasTitles: false,
      EnableEmbeddedEpisodeInfos: false,
      PreferredMetadataLanguage: 'en',
      MetadataCountryCode: 'US',
      TypeOptions: noFetch(types)
    }
  });
  for (const [name, type, dir, types] of [['Movies', 'movies', 'Movies', ['Movie']], ['Shows', 'tvshows', 'Shows', ['Series', 'Season', 'Episode']]]) {
    const q = new URLSearchParams({ name, collectionType: type, refreshLibrary: 'false', paths: media + '/' + dir });
    await ok(jf, 'POST', '/Library/VirtualFolders?' + q, { ...tk, body: libOpts(types) });
  }
  t('libraries', t0);

  // ---- scan ----
  t0 = Date.now();
  await ok(jf, 'POST', '/Library/Refresh', tk);
  const want = { Movie: 2, Series: 1, Episode: 2 };
  const counts = async () => {
    const r = await ok(jf, 'GET', `/Items?userId=${userId}&recursive=true&includeItemTypes=Movie,Series,Episode&fields=MediaSources,Chapters,Trickplay`, tk);
    const by = {};
    for (const i of r.Items) by[i.Type] = (by[i.Type] || 0) + 1;
    return Object.entries(want).every(([k, n]) => by[k] === n) && r.Items.every((i) => i.Type === 'Series' || (i.MediaSources?.[0]?.MediaStreams?.length)) ? r.Items : null;
  };
  let items = await until('the library scan (2 movies, 1 series, 2 episodes, streams probed)', counts, { timeout: 180000 });
  await until('the scan task to go idle', async () => {
    const tasks = await ok(jf, 'GET', '/ScheduledTasks?isHidden=false', tk);
    return tasks.every((x) => x.State !== 'Running');
  }, { timeout: 180000 });
  t('scan', t0);

  const byName = (type, name) => items.find((i) => i.Type === type && i.Name.startsWith(name)); // no metadata fetchers: "Contract Movie (2020)"
  const movie = byName('Movie', FIXTURES.movie.name);
  const browser = byName('Movie', FIXTURES.browser.name);
  const series = byName('Series', FIXTURES.ep1.series);
  if (!movie || !browser || !series) throw new Error('setup: fixture titles not found by name: ' + items.map((i) => `${i.Type}:${i.Name}`).join(', '));
  const eps = (await ok(jf, 'GET', `/Shows/${series.Id}/Episodes?userId=${userId}`, tk)).Items;
  const ep1 = eps.find((e) => e.IndexNumber === 1), ep2 = eps.find((e) => e.IndexNumber === 2);
  if (!ep1 || !ep2) throw new Error('setup: episodes 1/2 not found: ' + eps.map((e) => e.Name).join(', '));

  // ---- trickplay for the contract movie ----
  t0 = Date.now();
  const hasTrick = async () => {
    const r = await ok(jf, 'GET', `/Items?userId=${userId}&ids=${movie.Id}&fields=Trickplay`, tk);
    const tp = r.Items[0]?.Trickplay;
    return tp && Object.keys(tp).length ? tp : null;
  };
  let trick = await hasTrick();
  if (!trick) {
    const tasks = await ok(jf, 'GET', '/ScheduledTasks?isHidden=false', tk);
    const task = tasks.find((x) => x.Key === 'RefreshTrickplayImages') || tasks.find((x) => /trickplay/i.test(x.Name));
    if (task) {
      await ok(jf, 'POST', '/ScheduledTasks/Running/' + task.Id, tk);
      trick = await until('trickplay images for ' + movie.Name, hasTrick, { timeout: 180000, every: 1000 }).catch((e) => (log('note: ' + e.message), null));
    } else log('note: no trickplay scheduled task found');
  }
  t('trickplay', t0);

  // ---- watch state ----
  await ok(jf, 'POST', `/UserItems/${browser.Id}/UserData?userId=${userId}`, { ...tk, body: { PlaybackPositionTicks: RESUME_SEC * TICKS, Played: false, LastPlayedDate: new Date(Date.now() - 3600e3).toISOString() } });
  await ok(jf, 'POST', `/UserPlayedItems/${ep1.Id}?userId=${userId}`, tk);
  items = (await ok(jf, 'GET', `/Items?userId=${userId}&recursive=true&includeItemTypes=Movie,Series,Episode&fields=MediaSources,Chapters,Trickplay,ProviderIds`, tk)).Items;
  const fresh = (x) => items.find((i) => i.Id === x.Id);
  return { admin: { token, userId }, items: { movie: fresh(movie), browser: fresh(browser), series: fresh(series), ep1: fresh(ep1), ep2: fresh(ep2) }, trickplay: trick, server: pub, timings };
}

