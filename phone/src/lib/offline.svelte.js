/* Offline downloads: a film or episode saved on the iPhone, playable without
 * the server.
 *
 * Format: exactly what the phone streams — Jellyfin's HLS fMP4 (video copied,
 * or re-encoded at a Settings quality cap) — fetched segment by segment into
 * Cache Storage, and played back through segfeed.js (a ManagedMediaSource fed
 * from the cache), the same feeder that plays a download while it comes in.
 * No single-file remux: a segment is the unit of progress, so a download
 * interrupted by iOS (the app is suspended whenever it isn't on screen, and
 * there is no Background Fetch in Safari) picks up at the next missing segment,
 * and nothing depends on Safari playing a multi-GB blob.
 *
 * Audio: the one track the player would pick (trackprefs/describeTracks),
 * limited to E-AC-3 / AC-3 / AAC so the MediaSource can take it (FLAC, DTS,
 * TrueHD are converted by Jellyfin). Subtitles: every text track as VTT
 * (small); PGS / DVD subtitles are not saved.
 *
 * Nothing is reported to Jellyfin while an offline copy plays. The position is
 * kept here — checkpointed on every pause and when the app goes to the
 * background (iOS may kill it there without a pagehide), and never taken from
 * a close before the first frame — and sent as UserData (position / played)
 * the next time the server answers, unless the server has a newer
 * LastPlayedDate for the item (it was watched elsewhere since). Downloading
 * itself records nothing on the server (measured 2026-09-30: fetching the
 * whole HLS left UserData untouched).
 *
 * Index: localStorage `reel.offline` (one entry per account + item: two
 * accounts on one iPhone each keep their own copy); media: Cache Storage
 * `vibereel-offline-v1`, keys /offline/<dir>/{manifest,init,s<n>,sub<i>,poster,still,art}
 * with <dir> = `<userId>.<itemId>` (entries from before per-account keys keep
 * their old `<itemId>` folder, see dirOf).
 *
 * Artwork: the entry keeps the Jellyfin image URLs (`img`: poster — a series'
 * for an episode —, the episode still, a backdrop; images need no token), so
 * the Downloads list shows the cover from the moment a title is queued, and
 * the files go into the cache as soon as the download starts (saveArt), so it
 * still shows offline. Entries from before that get theirs once the server
 * answers (fillArt).
 *
 * Room: a download stops with less than MIN_FREE left in the origin's quota —
 * a full quota also breaks the service worker's update (its precache). */
import { cfg } from '$lib/config.js';
import { api, qs, TICKS, errText, itemPath, imgUrl } from '$lib/api.js';
import { deviceProfile, pickSource } from '$lib/tracks.js';
import { startTracks } from '$lib/trackprefs.js';
import { playFeedStream, QUALITY_CAPS, videoEl } from '$lib/player.svelte.js';
import { createSegFeeder, parsePlaylist, feedCanPlay, feedSupported } from '$lib/segfeed.js';
import { toast } from '$lib/toast.svelte.js';
import { S } from './nav.svelte.js';

const CACHE = 'vibereel-offline-v1';
const INDEX = 'reel.offline';
const MSE_AUDIO = ['eac3', 'ac3', 'aac'];
const RETRY_MS = [5000, 15000, 60000];
const MIN_FREE = 500 * 1024 * 1024;   // stop a download below this much room
const ROOM_EVERY = 128 * 1024 * 1024; // …checked again after this many bytes
const NO_ROOM = 'Stopped — less than 500 MB left for VibeReel on this iPhone. Delete a download or free up space, then tap to resume';
/* a wait the download's AbortController cuts short (pause / delete) */
const sleep = (ms, signal) =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    if (signal) signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
  });

/* entries: { id, user, dir, type, title, line, series, seriesId, quality (bit/s or 'original'),
 *   state: 'queued'|'downloading'|'paused'|'done'|'error', error, done, total,
 *   bytes, est, added, pos, dur, posAt, sync, played, sweep,
 *   img: { poster, still, art } (image URLs), pics (bumped when artwork is cached) } */
let migrated = false;   // loadIndex() gave an old entry its account: initOffline saves that
export const OFF = $state({ list: loadIndex(), usage: null, quota: null, persisted: null });

function loadIndex() {
  try {
    const v = JSON.parse(localStorage.getItem(INDEX) || '[]');
    return Array.isArray(v)
      ? v
          .filter((e) => e && e.id)
          // an entry saved without its account belongs to whoever is signed in now
          .map((e) => (e.user || !cfg.userId ? e : ((migrated = true), { ...e, user: cfg.userId })))
          .map((e) => (e.state === 'downloading' ? { ...e, state: 'queued' } : e))
      : [];
  } catch {
    return [];
  }
}

let saveT = 0;
function save(now) {
  clearTimeout(saveT);
  const w = () => {
    try {
      localStorage.setItem(INDEX, JSON.stringify($state.snapshot(OFF.list)));
    } catch {}
  };
  if (now) w();
  else saveT = setTimeout(w, 1000);
}

export function offlineSupported() {
  return typeof caches !== 'undefined' && feedSupported();
}

/* The signed-in account's entry for an item (another account's copy of the
 * same title is its own entry). */
export function entryOf(id, user = cfg.userId) {
  return OFF.list.find((e) => e.id === id && e.user === user) || null;
}

const same = (a, b) => !!a && !!b && a.id === b.id && a.user === b.user;
/* An entry's Cache Storage folder. Entries made before per-account keys have
 * no `dir` and keep their files under the bare item id. */
const dirOf = (e) => e.dir || e.id;
const key = (e, part) => '/offline/' + dirOf(e) + '/' + part;
const cache = () => caches.open(CACHE);

/* Remove every cached file of a folder. */
async function clearDir(dir) {
  try {
    const c = await cache();
    const pre = '/offline/' + dir + '/';
    for (const req of await c.keys()) if (new URL(req.url).pathname.startsWith(pre)) await c.delete(req);
  } catch {}
}
/* …unless an entry still uses it. */
async function sweepDir(dir) {
  if (!OFF.list.some((x) => dirOf(x) === dir)) await clearDir(dir);
}

/* Files no entry points at (a delete the app was killed in the middle of, an
 * entry lost with a cleared index). Listing the cache means every key of every
 * copy (~1,100 for a 2 h film), so it no longer runs at each cold start ahead
 * of the first render: only when a delete may have left something behind
 * (deleteDownload drops the stamp) or after a week, ~10 s after boot. A
 * cleared localStorage loses the stamp along with the index, so that case
 * still gets its sweep. Safe beside a running download: whether a folder is
 * in use is asked again right before each delete, not once up front. */
const SWEPT = 'reel.offline.swept';
const SWEEP_EVERY = 7 * 24 * 3600 * 1000;
function sweepDue() {
  try {
    const at = Number(localStorage.getItem(SWEPT)) || 0;
    return !at || Date.now() - at > SWEEP_EVERY;
  } catch {
    return true;
  }
}
function markSwept(ok) {
  try {
    if (ok) localStorage.setItem(SWEPT, String(Date.now()));
    else localStorage.removeItem(SWEPT);
  } catch {}
}
async function sweepOrphans() {
  const c = await cache();
  const inUse = (dir) => OFF.list.some((x) => dirOf(x) === dir);
  for (const req of await c.keys()) {
    const dir = new URL(req.url).pathname.split('/')[2];
    if (dir && !inUse(dir)) await c.delete(req);
  }
  markSwept(true);
}

/* ---------------- storage ---------------- */

export async function refreshStorage() {
  try {
    const est = await navigator.storage.estimate();
    OFF.usage = est.usage ?? null;
    OFF.quota = est.quota ?? null;
  } catch {}
  try {
    OFF.persisted = navigator.storage.persisted ? await navigator.storage.persisted() : null;
  } catch {}
}

export function freeBytes() {
  return OFF.quota != null && OFF.usage != null ? Math.max(0, OFF.quota - OFF.usage) : null;
}

/* Room left in the origin's quota right now (Infinity when the browser won't say). */
async function roomLeft() {
  await refreshStorage();
  const f = freeBytes();
  return f == null ? Infinity : f;
}

/* Size of a copy at `quality`: the cap's bitrate (a re-encode aims for it), or
 * the file's own bitrate. Audio rides along (~0.6 Mbit/s). */
export function estimateBytes(item, quality) {
  const src = pickSource(item) || {};
  const sec = (item.RunTimeTicks || src.RunTimeTicks || 0) / TICKS;
  const file = src.Bitrate || 0;
  // a file already under the cap is copied as it is
  const bps = quality === 'original' || !quality || (file && file <= quality) ? file : quality + 256000;
  return sec && bps ? Math.round((bps * sec) / 8) : 0;
}

export const OFFLINE_QUALITIES = QUALITY_CAPS;

/* ---------------- starting a download ---------------- */

function lineOf(item) {
  if (item.Type === 'Episode') {
    const code = 'S' + (item.ParentIndexNumber ?? '?') + 'E' + (item.IndexNumber ?? '?');
    return [item.SeriesName, code].filter(Boolean).join(' · ');
  }
  return item.ProductionYear ? String(item.ProductionYear) : 'Movie';
}

/* The artwork a download keeps: the poster (a series' for an episode), the
 * episode's own still, and a backdrop for the player's loading card. */
function imgsOf(item) {
  const ep = item.Type === 'Episode';
  const poster = ep
    ? item.SeriesId && item.SeriesPrimaryImageTag
      ? imgUrl({ Id: item.SeriesId, ImageTags: { Primary: item.SeriesPrimaryImageTag } }, 'Primary', { h: 360 })
      : null
    : imgUrl(item, 'Primary', { h: 360 });
  return {
    poster,
    still: ep && item.ImageTags?.Primary ? imgUrl(item, 'Primary', { w: 640 }) : null,
    art: imgUrl(item, 'Backdrop', { w: 1280 }) || null
  };
}

/* From the tap: asks for persistent storage (iOS decides; a Home Screen app
 * usually gets it) and queues the item. */
export function queueDownload(item, quality) {
  if (!offlineSupported()) {
    toast('Downloads need iOS 17.1 or later');
    return;
  }
  try {
    navigator.storage.persist && navigator.storage.persist().then((p) => (OFF.persisted = p)).catch(() => {});
  } catch {}
  const old = entryOf(item.Id);
  if (old && old.state !== 'error') {
    toast(old.state === 'done' ? 'Already downloaded' : 'Already downloading');
    return;
  }
  if (old) OFF.list = OFF.list.filter((e) => !same(e, old));
  const dir = cfg.userId + '.' + item.Id;
  OFF.list = [
    ...OFF.list,
    {
      id: item.Id,
      user: cfg.userId,
      dir,
      // start from an empty folder: files left by a failed copy, or by a
      // delete that was cut short, would otherwise be taken as already fetched
      sweep: [...new Set([dir, ...(old ? [dirOf(old)] : [])])],
      type: item.Type,
      title: item.Type === 'Episode' ? item.Name || '' : item.Name || '',
      line: lineOf(item),
      series: item.SeriesName || null,
      seriesId: item.SeriesId || null,
      img: imgsOf(item),
      pics: 0,
      quality,
      state: 'queued',
      error: null,
      done: 0,
      total: 0,
      bytes: 0,
      est: estimateBytes(item, quality),
      added: Date.now(),
      pos: Math.floor(((item.UserData || {}).PlaybackPositionTicks || 0) / TICKS),
      dur: (item.RunTimeTicks || 0) / TICKS,
      posAt: 0,
      sync: false
    }
  ];
  save(true);
  toast('Downloading “' + (item.Name || 'title') + '” — keep VibeReel open until it’s done');
  pump();
}

/* ---------------- the download loop ---------------- */

let running = null;       // the entry being fetched
let runningP = null;      // …and its fetch loop, settled once nothing writes for it any more
let abort = null;         // its AbortController (pause / delete)
let runningMan = null;    // its manifest — the Jellyfin job to stop on pause / delete

export function pump() {
  if (running || !offlineSupported()) return;
  const next = OFF.list.find((e) => e.state === 'queued' && e.user === cfg.userId);
  if (!next) return;
  running = next;
  runningP = fetchEntry(next)
    .catch(() => {})
    .finally(() => {
      running = null;
      runningP = null;
      abort = null;
      runningMan = null;
      save(true);
      refreshStorage();
      pump();
    });
}

export function pauseDownload(id) {
  const e = entryOf(id);
  if (!e || (e.state !== 'downloading' && e.state !== 'queued')) return;
  e.state = 'paused';
  if (same(running, e) && abort) {
    abort.abort();
    stopJob(runningMan);
  }
  save(true);
}

export function resumeDownload(id) {
  const e = entryOf(id);
  if (!e || (e.state !== 'paused' && e.state !== 'error')) return;
  e.state = 'queued';
  e.error = null;
  save(true);
  pump();
}

export async function deleteDownload(id) {
  const e = entryOf(id);
  if (!e) return;
  const wasRunning = same(running, e) ? runningP : null;
  if (wasRunning && abort) {
    abort.abort();
    stopJob(runningMan);
  }
  OFF.list = OFF.list.filter((x) => !same(x, e));
  save(true);
  markSwept(false);   // killed before the sweep below is done: the next start's sweep finds it
  // Only sweep once the aborted loop has settled: a segment fetch or cache.put
  // still in flight would otherwise land *after* the sweep, and a later
  // download of the same title would take that stray file as already fetched.
  if (wasRunning) await wasRunning;
  await sweepDir(dirOf(e));
  refreshStorage();
}

async function readManifest(e) {
  const r = await (await cache()).match(key(e, 'manifest'));
  return r ? r.json() : null;
}

function withDevice(url, dlDevice) {
  return url.replace(/([?&])DeviceId=[^&]*/i, '$1DeviceId=' + encodeURIComponent(dlDevice));
}

/* PlaybackInfo → Jellyfin's HLS media playlist for this item at this quality. */
async function resolve(entry, signal) {
  const item = await api(itemPath(entry.id), { signal });
  entry.img = imgsOf(item); // the full item: fills what the tapped one lacked
  const src = pickSource(item);
  if (!src) throw new Error('Jellyfin has no file for this title');
  const tracks = startTracks(src, item);
  const bitrate = entry.quality === 'original' ? 200000000 : entry.quality;
  const prof = deviceProfile(false, bitrate);
  prof.DirectPlayProfiles = [];
  for (const tp of prof.TranscodingProfiles || []) {
    if (tp.Protocol !== 'hls') continue;
    const a = String(tp.AudioCodec || '').split(',').filter((c) => MSE_AUDIO.includes(c));
    tp.AudioCodec = a.length ? a.join(',') : 'aac';
  }
  const body = {
    UserId: cfg.userId,
    DeviceProfile: prof,
    MaxStreamingBitrate: bitrate,
    AutoOpenLiveStream: true,
    EnableDirectPlay: false,
    MediaSourceId: src.Id,
    SubtitleStreamIndex: -1,
    StartTimeTicks: 0
  };
  if (tracks.audio >= 0) body.AudioStreamIndex = tracks.audio;
  const info = await api('/Items/' + entry.id + '/PlaybackInfo', { method: 'POST', body, signal });
  const ms = (info.MediaSources || [])[0];
  if (!ms || !ms.TranscodingUrl) throw new Error('Jellyfin offered no stream for this title');
  const dlDevice = cfg.deviceId + '-dl';
  const master = cfg.server + withDevice(ms.TranscodingUrl, dlDevice);
  const mainUrl = master.replace('/master.m3u8', '/main.m3u8');
  const [mText, pText] = await Promise.all([
    fetch(master, { signal }).then((r) => (r.ok ? r.text() : '')),
    fetch(mainUrl, { signal }).then((r) => {
      if (!r.ok) throw new Error('playlist: HTTP ' + r.status);
      return r.text();
    })
  ]);
  const pl = parsePlaylist(pText);
  if (!pl.segs.length || !pl.init) throw new Error('Jellyfin’s playlist is empty');
  // CODECS / SUPPLEMENTAL-CODECS of the first variant (= the stream copy)
  const inf = (mText.match(/#EXT-X-STREAM-INF:[^\n]*/) || [''])[0];
  const codecs = (inf.match(/CODECS="([^"]+)"/) || [])[1] || '';
  const supp = ((inf.match(/SUPPLEMENTAL-CODECS="([^"]+)"/) || [])[1] || '').split('/')[0];
  const base = new URL(mainUrl);
  const abs = (u) => new URL(u, base).href;
  const subs = (ms.MediaStreams || [])
    .filter((s) => s.Type === 'Subtitle' && s.DeliveryMethod === 'External' && s.DeliveryUrl && /\.vtt/i.test(s.DeliveryUrl))
    .map((s) => ({ index: s.Index, url: cfg.server + s.DeliveryUrl, lang: s.Language, title: s.DisplayTitle || s.Title || '', forced: !!s.IsForced }));
  const audio = (ms.MediaStreams || []).find((s) => s.Type === 'Audio' && s.Index === (tracks.audio >= 0 ? tracks.audio : ms.DefaultAudioStreamIndex));
  return {
    v: 1,
    item: {
      Id: item.Id, Name: item.Name, Type: item.Type, SeriesName: item.SeriesName, SeriesId: item.SeriesId,
      ParentIndexNumber: item.ParentIndexNumber, IndexNumber: item.IndexNumber, ProductionYear: item.ProductionYear,
      RunTimeTicks: item.RunTimeTicks, Genres: item.Genres || [], Overview: item.Overview || ''
    },
    source: {
      Id: 'offline',
      RunTimeTicks: item.RunTimeTicks || src.RunTimeTicks || 0,
      Bitrate: entry.quality === 'original' ? src.Bitrate || 0 : entry.quality,
      MediaStreams: [
        ...(src.MediaStreams || []).filter((s) => s.Type === 'Video').slice(0, 1),
        ...(audio ? [{ ...audio }] : []),
        ...subs.map((s) => ({ Type: 'Subtitle', Index: s.index, Codec: 'webvtt', Language: s.lang, Title: s.title, DisplayTitle: s.title, IsForced: s.forced, IsExternal: true }))
      ]
    },
    audioIndex: audio ? audio.Index : -1,
    codecs,
    supp,
    duration: pl.segs[pl.segs.length - 1].end,
    init: abs(pl.init),
    segs: pl.segs.map((s) => ({ start: s.start, end: s.end, url: abs(s.name) })),
    subs,
    session: ms.TranscodingUrl.match(/PlaySessionId=([^&]+)/i)?.[1] || info.PlaySessionId || '',
    dlDevice
  };
}

/* Sample entry fourccs in an init segment (the video one first): 'hvc1', 'dvh1', 'avc1', 'ec-3'… */
function sampleEntries(buf) {
  const b = new Uint8Array(buf);
  const out = [];
  for (let i = 4; i + 20 < b.length; i++) {
    if (b[i] === 0x73 && b[i + 1] === 0x74 && b[i + 2] === 0x73 && b[i + 3] === 0x64) {   // 'stsd'
      out.push(String.fromCharCode(b[i + 16], b[i + 17], b[i + 18], b[i + 19]));
    }
  }
  return out;
}

/* The codec string the MediaSource gets. A Dolby Vision copy has a dvh1
 * sample entry while the master's CODECS names the HDR10 base (hvc1…) and
 * SUPPLEMENTAL-CODECS the DV one — offer DV where this iPhone takes it. */
function pickCodecs(man, entries) {
  const [v, ...rest] = man.codecs.split(',');
  const audio = rest.join(',');
  const cands = [];
  if (entries[0] === 'dvh1' || entries[0] === 'dvhe') {
    if (man.supp) cands.push(man.supp.replace(/^dvhe/, 'dvh1') + (audio ? ',' + audio : ''));
    cands.push('dvh1.08.06' + (audio ? ',' + audio : ''));
  }
  cands.push(man.codecs);
  return cands.find((c) => feedCanPlay(c)) || null;
}

async function fetchEntry(e) {
  const ac = new AbortController();
  abort = ac;
  e.state = 'downloading';
  e.error = null;
  save();
  let tries = 0;
  for (;;) {
    try {
      await fetchOnce(e, ac.signal);
      e.state = 'done';
      toast('“' + e.title + '” is downloaded');
      return;
    } catch (err) {
      if (ac.signal.aborted) {
        if (e.state === 'downloading') e.state = 'paused';
        return;
      }
      if (err && err.fatal) {
        e.state = 'error';
        e.error = err.message;
        return;
      }
      if (err && err.noRoom) {
        // not an 'error' (nothing is wrong with the copy) and not 'Paused —'
        // (initOffline re-queues those on its own): it waits for the user
        e.state = 'paused';
        e.error = NO_ROOM;
        toast('Download stopped — the iPhone is almost out of room for VibeReel');
        return;
      }
      // network trouble (or the app was suspended mid-request): try again a few times, then park it
      if (tries >= RETRY_MS.length) {
        e.state = 'paused';
        e.error = 'Paused — ' + errText(err);
        return;
      }
      await sleep(RETRY_MS[tries++], ac.signal);
      if (ac.signal.aborted) {
        if (e.state === 'downloading') e.state = 'paused';
        return;
      }
    }
  }
}

function fatal(msg) {
  const e = new Error(msg);
  e.fatal = true;
  return e;
}

function noRoom() {
  const e = new Error(NO_ROOM);
  e.noRoom = true;
  return e;
}

async function fetchOnce(e, signal) {
  const c = await cache();
  if (e.sweep) {
    // a fresh download: its own folder is emptied, a replaced copy's too
    for (const d of e.sweep) await (d === dirOf(e) ? clearDir(d) : sweepDir(d));
    e.sweep = null;
    save(true);
  }
  if ((await roomLeft()) < MIN_FREE) throw noRoom();
  let sinceCheck = 0;
  let man = await readManifest(e);
  if (!man) {
    man = await resolve(e, signal);
    let initBuf;
    const r = await fetch(man.init, { signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    initBuf = await r.arrayBuffer();
    const codecs = pickCodecs(man, sampleEntries(initBuf));
    if (!codecs) {
      stopJob(man);
      throw fatal('This iPhone can’t play this format offline (' + man.codecs + ')');
    }
    man.play = codecs;
    await put(c, key(e, 'init'), new Response(initBuf, { headers: { 'Content-Type': 'video/mp4' } }));
    await put(c, key(e, 'manifest'), new Response(JSON.stringify(man), { headers: { 'Content-Type': 'application/json' } }));
    e.total = man.segs.length;
    e.done = 0;
    e.bytes = initBuf.byteLength;
    save();
  }
  e.total = man.segs.length;
  runningMan = man;
  // artwork first (a few hundred KB): the cover is there offline from now on
  if (!e.img && man.art) e.img = { art: man.art }; // a copy started by an older build
  await saveArt(e, signal);
  let refreshed = false;
  for (let i = e.done; i < man.segs.length; i++) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const k = key(e, 's' + i);
    if (await c.match(k)) {
      e.done = i + 1;
      continue;
    }
    let r = await fetch(man.segs[i].url, { signal });
    if ((r.status === 401 || r.status === 403 || r.status === 404) && !refreshed) {
      // token changed (re-login) or the server lost the job: a fresh playlist
      // for the same file has the same segments
      refreshed = true;
      const fresh = await resolve(e, signal);
      if (fresh.segs.length !== man.segs.length) {
        stopJob(fresh);
        throw fatal('The file changed on the server — delete and download again');
      }
      stopJob(man);
      man.segs = fresh.segs;
      man.session = fresh.session;
      await put(c, key(e, 'manifest'), new Response(JSON.stringify(man), { headers: { 'Content-Type': 'application/json' } }));
      r = await fetch(man.segs[i].url, { signal });
    }
    if (!r.ok) throw new Error('segment ' + i + ': HTTP ' + r.status);
    // Straight from the response into the cache: reading it into an
    // ArrayBuffer first held a whole segment (30–60 MB at 4K) in page memory
    // for every put. A put whose body breaks off (abort, network) stores
    // nothing, so a missing key still means "fetch it again". The size comes
    // from Content-Length; without one, the old buffered way counts it.
    let size = Number(r.headers.get('Content-Length')) || 0;
    if (size > 0) await put(c, k, r);
    else {
      const buf = await r.arrayBuffer();
      size = buf.byteLength;
      await put(c, k, new Response(buf, { headers: { 'Content-Type': 'video/mp4' } }));
    }
    e.done = i + 1;
    e.bytes += size;
    if (i % 5 === 0) save();
    sinceCheck += size;
    if (sinceCheck >= ROOM_EVERY) {
      sinceCheck = 0;
      if ((await roomLeft()) < MIN_FREE) {
        stopJob(man);
        throw noRoom();
      }
    }
  }
  // subtitles + artwork: best effort
  for (const s of man.subs) {
    const k = key(e, 'sub' + s.index);
    if (await c.match(k)) continue;
    try {
      const r = await fetch(s.url, { signal });
      if (r.ok) await put(c, k, new Response(await r.text(), { headers: { 'Content-Type': 'text/vtt' } }));
    } catch {}
  }
  await saveArt(e, signal); // whatever failed at the start
  stopJob(man);
}

async function put(c, k, res) {
  try {
    await c.put(k, res);
  } catch (err) {
    if (err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''))) {
      throw fatal('The iPhone has no more room for downloads — delete one, or free up space');
    }
    throw err;
  }
}

function stopJob(man) {
  if (!man || !man.session) return;
  api('/Videos/ActiveEncodings' + qs({ deviceId: man.dlDevice, playSessionId: man.session }), { method: 'DELETE' }).catch(() => {});
}

/* ---------------- artwork ---------------- */

const ART_PARTS = ['poster', 'still', 'art'];

/* Puts the entry's missing artwork into its cache folder. Best effort: a
 * failure leaves the placeholder (and fillArt / the next pass tries again).
 * Bumps e.pics when something landed, so the Downloads list re-reads it. */
async function saveArt(e, signal) {
  const img = e.img;
  if (!img) return false;
  let got = 0;
  try {
    const c = await cache();
    for (const part of ART_PARTS) {
      const u = img[part];
      if (!u || signal?.aborted) continue;
      if (await c.match(key(e, part))) continue;
      const ac = new AbortController();
      const stop = () => ac.abort();
      const t = setTimeout(stop, 20000);
      signal?.addEventListener('abort', stop, { once: true });
      try {
        const r = await fetch(u, { signal: ac.signal });
        if (!r.ok) continue;
        const blob = await r.blob();
        if (!OFF.list.some((x) => same(x, e))) return false; // deleted meanwhile
        await c.put(key(e, part), new Response(blob, { headers: { 'Content-Type': blob.type || 'image/jpeg' } }));
        got++;
      } catch {
        /* network / quota: the placeholder stays */
      } finally {
        clearTimeout(t);
        signal?.removeEventListener('abort', stop);
      }
    }
  } catch {
    return false;
  }
  if (got) {
    e.pics = (e.pics || 0) + 1;
    save();
  }
  return got > 0;
}

/* Entries without a cached poster (made before artwork was kept, or whose
 * artwork failed): look the item up once the server answers and cache it.
 * Once per entry and session, unless the network was the problem. */
const artTried = new Set();
let filling = false;
async function fillArt() {
  if (filling || !cfg.token) return;
  filling = true;
  try {
    const c = await cache();
    for (const e of OFF.list) {
      const d = dirOf(e);
      if (e.user !== cfg.userId || artTried.has(d) || same(running, e)) continue;
      artTried.add(d);
      if (await c.match(key(e, 'poster'))) continue;
      try {
        if (!e.img || !e.img.poster) {
          const it = await api(itemPath(e.id), { signal: AbortSignal.timeout(8000) });
          e.img = imgsOf(it);
          if (!e.series && it.SeriesName) e.series = it.SeriesName;
          e.pics = (e.pics || 0) + 1; // the list can show the network copy meanwhile
          save();
        }
        // a folder still to be swept at the start of its download: that start saves it
        if (!e.sweep) await saveArt(e);
      } catch (err) {
        if (!(err && err.status >= 400 && err.status < 500)) artTried.delete(d); // offline: next time
      }
    }
  } catch {
    /* no Cache Storage */
  } finally {
    filling = false;
  }
}

/* An object URL for the first of `parts` this download has cached (revoke it
 * when done), or null. */
export async function artUrl(id, parts = ['art', 'still', 'poster']) {
  const e = entryOf(id);
  if (!e) return null;
  try {
    const c = await cache();
    for (const p of parts) {
      const r = await c.match(key(e, p));
      if (r) return URL.createObjectURL(await r.blob());
    }
  } catch {}
  return null;
}

/* ---------------- playing an offline copy ---------------- */

export async function playOffline(id) {
  const e = entryOf(id);
  if (!e || e.state !== 'done' || S.screen === 'player') return;
  // the awaits below can land somewhere else (Back, another tap): give up then
  const epoch = S.epoch;
  const user = e.user;
  // inside the tap: lets the play() after the awaits below make sound (iOS)
  const v = videoEl();
  if (v && !v.getAttribute('src')) {
    try {
      v.load();
    } catch {}
  }
  // online: a position saved on the server since (watched on the TV) wins
  if (cfg.token && navigator.onLine !== false) {
    try {
      const it = await api('/Items/' + id + qs({ userId: cfg.userId }), { signal: AbortSignal.timeout(2500) });
      const ud = (it && it.UserData) || {};
      const theirs = ud.LastPlayedDate ? Date.parse(ud.LastPlayedDate) : 0;
      if (theirs > (e.posAt || 0) && !e.sync) {
        e.pos = Math.floor((ud.PlaybackPositionTicks || 0) / TICKS);
        e.posAt = theirs;
      }
    } catch {}
  }
  const c = await cache();
  const man = await readManifest(e);
  if (!man) {
    toast('This download is damaged — delete it and download again');
    return;
  }
  const streams = [];
  for (const s of man.source.MediaStreams) {
    if (s.Type !== 'Subtitle') {
      streams.push(s);
      continue;
    }
    const r = await c.match(key(e, 'sub' + s.Index));
    if (r) streams.push({ ...s, _vtt: await r.text() });
  }
  const source = { ...man.source, MediaStreams: streams };
  const art = await artUrl(id, e.type === 'Episode' ? ['still', 'art', 'poster'] : ['art', 'still', 'poster']);
  if (epoch !== S.epoch || S.screen === 'player' || !entryOf(id, user)) {
    if (art) URL.revokeObjectURL(art);
    return;
  }
  const item = { ...man.item, _art: art };
  const t = startTracks(source, man.item);
  const dur = man.duration;
  const start = e.pos > 30 && (!dur || e.pos < dur - 60) ? e.pos : 0;
  playFeedStream({
    item,
    source,
    start,
    audioIndex: man.audioIndex,
    subIndex: streams.some((s) => s.Type === 'Subtitle' && s.Index === t.sub) ? t.sub : -1,
    open: ({ position, jump, onFail }) =>
      createSegFeeder({
        position,
        jump,
        onFail,
        media: videoEl(),
        bitrate: man.source.Bitrate || 0,
        // local: nothing to ride out, a short window is plenty (and cheap on memory)
        aheadS: 20,
        prepare: async () => ({ codecs: man.play || man.codecs, duration: dur }),
        playlist: async () => ({ segs: man.segs.map((s, i) => ({ start: s.start, end: s.end, name: 's' + i })), complete: true }),
        fetchInit: async () => {
          const r = await c.match(key(e, 'init'));
          return r ? r.arrayBuffer() : null;
        },
        fetchSeg: async (seg) => {
          const r = await c.match(key(e, seg.name));
          if (!r) throw new Error('part of this download is missing — delete it and download again');
          return r.arrayBuffer();
        }
      }),
    // every pause and every trip to the background (iOS may kill the app there)
    checkpoint: (pos, d) => record(id, user, pos, d),
    exit: (pos, d, started) => {
      if (art) setTimeout(() => URL.revokeObjectURL(art), 5000);
      // Closed before the first frame: `pos` is only the start we asked for
      // (or 0) — the saved spot and a pending sync stay exactly as they were.
      if (!started) return;
      if (record(id, user, pos, d)) syncPositions();
    }
  });
}

/* Where an offline copy got to, for syncPositions(). */
function record(id, user, pos, d) {
  const en = entryOf(id, user);
  if (!en) return false;
  const played = d > 0 && pos >= d * 0.9;
  en.pos = played ? 0 : Math.floor(pos);
  en.played = played;
  en.posAt = Date.now();
  en.sync = true;
  save(true);
  return true;
}

/* Positions watched offline → Jellyfin, once it answers. */
let syncing = false;
export async function syncPositions() {
  if (syncing || !cfg.token) return;
  const todo = OFF.list.filter((e) => e.sync && e.user === cfg.userId);
  if (!todo.length) return;
  syncing = true;
  try {
    for (const e of todo) {
      const at = e.posAt;   // a checkpoint while this is out makes a newer one: keep it pending
      try {
        const it = await api('/Items/' + e.id + qs({ userId: cfg.userId }));
        const ud = (it && it.UserData) || {};
        const theirs = ud.LastPlayedDate ? Date.parse(ud.LastPlayedDate) : 0;
        if (!(theirs > e.posAt)) {
          await api('/UserItems/' + e.id + '/UserData' + qs({ userId: cfg.userId }), {
            method: 'POST',
            body: {
              PlaybackPositionTicks: Math.floor((e.pos || 0) * TICKS),
              Played: !!e.played || !!ud.Played,
              LastPlayedDate: new Date(e.posAt).toISOString()
            }
          });
        }
        if (e.posAt === at) e.sync = false;
        save(true);
      } catch (err) {
        if (err && err.status >= 400 && err.status < 500 && err.status !== 401) {
          e.sync = false;   // the item is gone from the server: nothing to sync to
          save(true);
        } else break;       // offline still — next time
      }
    }
  } finally {
    syncing = false;
  }
}

/* Called once from main.js: resume queued downloads and pending syncs when the
 * app comes (back) to the foreground or the network returns. */
export function initOffline() {
  if (!offlineSupported()) return;
  if (migrated) save(true);
  refreshStorage();
  if (sweepDue()) {
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 0));
    setTimeout(() => idle(() => sweepOrphans().catch(() => {})), 10000);
  }
  if (cfg.token && S.screen !== 'login') pump();
  const kick = () => {
    if (document.visibilityState !== 'visible' || !cfg.token) return;
    syncPositions();
    fillArt();
    // a download the suspension broke off: queue it again
    for (const e of OFF.list) if (e.state === 'paused' && e.error && e.error.startsWith('Paused —')) {
      e.state = 'queued';
      e.error = null;
    }
    if (S.screen !== 'login') pump();
  };
  setTimeout(kick, 4000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && setTimeout(kick, 1500));
  addEventListener('online', () => setTimeout(kick, 2000));
}
