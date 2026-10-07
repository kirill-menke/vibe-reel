/* World helpers: named lookups and scenario builders over the fake server's
 * in-memory world (t.srv.world, made by server/seed.mjs createWorld()). They
 * only change memory, exactly like a test poking the world by hand — they just
 * keep the shapes (BaseItemDto, UserItemDataDto, reel-api ActivityItem) right
 * in one place.
 *
 *   ep(w, 'Northern Line', 1, 3)          → the Episode item (series by name or item)
 *   movie(w, 2) / movie(w, 'The Silent Harbor') → a Movie (library order / name)
 *   user(w) / user(w, 'bob')              → the user record (default alice)
 *   setPosition(w, 'alice', item, 1200)   → resume point at 20:00 (played: false)
 *   setPlayed(w, 'alice', item)           → watched (setPlayed(..., false) un-watches)
 *   addPending(w, { type: 'movie', media_id: '900002', progress: 0.2, probe: true })
 *                                         → a grab in /api/activity (+ a probe for its download_id)
 *   landImport(w, 'q-movie-900001')       → the grab leaves the feed, Jellyfin gains the
 *                                           movie / episode with matching ProviderIds
 *
 * All of them are deterministic: ids derive from names (gid) or are given. */
import { gid, TICKS } from '../server/seed.mjs';

export { TICKS };

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, '.0000000Z');
const kids = (w, it) => (it.childIds || []).map((id) => w.items.get(id));

export function series(w, s) {
  const it = typeof s === 'string' ? w.byName('Series', s) : s;
  if (!it) throw new Error('no series ' + s);
  return it;
}

export function season(w, s, n) {
  const it = kids(w, series(w, s)).find((x) => x.IndexNumber === n);
  if (!it) throw new Error(`no season ${n} of ${series(w, s).Name}`);
  return it;
}

/* an Episode by series (name or item), season and episode number */
export function ep(w, s, n, e) {
  const it = kids(w, season(w, s, n)).find((x) => x.IndexNumber === e);
  if (!it) throw new Error(`no S${n}E${e} of ${series(w, s).Name}`);
  return it;
}

/* a Movie: by index in library (seed) order, or by name */
export function movie(w, which) {
  const it = typeof which === 'number' ? w.list('Movie')[which] : w.byName('Movie', which);
  if (!it) throw new Error('no movie ' + which);
  return it;
}

/* a user record by name (default alice), or pass one through */
export function user(w, u = 'alice') {
  if (typeof u === 'object') return u;
  const it = [...w.users.values()].find((x) => x.Name === u || x.Id === u);
  if (!it) throw new Error('no user ' + u);
  return it;
}

/* the user's UserData record for an item, created (all-defaults) when absent */
export function userData(w, u, item) {
  const k = user(w, u).Id + ':' + (typeof item === 'string' ? item : item.Id);
  if (!w.userData.has(k)) w.userData.set(k, { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false });
  return w.userData.get(k);
}

/* a resume point at `sec` (0 clears it), last played `agoMs` ago */
export function setPosition(w, u, item, sec, { agoMs = 60_000, played = false } = {}) {
  const d = userData(w, u, item);
  Object.assign(d, { PlaybackPositionTicks: Math.round(sec * TICKS), Played: played, PlayCount: Math.max(d.PlayCount, 1), LastPlayedDate: iso(w.now - agoMs) });
  return d;
}

/* watched / un-watched (as the server does it: a played item has no resume point) */
export function setPlayed(w, u, item, played = true, { agoMs = 60_000 } = {}) {
  const d = userData(w, u, item);
  if (played) Object.assign(d, { Played: true, PlaybackPositionTicks: 0, PlayCount: Math.max(d.PlayCount, 1), LastPlayedDate: iso(w.now - agoMs) });
  else Object.assign(d, { Played: false, PlaybackPositionTicks: 0 });
  return d;
}

/* A grab in reel-api's activity feed (backend models.py ActivityItem).
 *   type 'movie' | 'tv', media_id (tmdb / tvdb; must be in the lookup
 *   catalog, which supplies title, year and poster), season/episode for tv,
 *   status 'downloading' | 'queued' | 'importing' | …, progress 0..1,
 *   speed (bytes/s), download_id (null for a queued grab; default: derived),
 *   listInMetadata: true → the show's /api/metadata seasons grow to include it,
 *   probe: true → GET /api/downloads/{id}/probe answers a 1080p H.264 file
 *   (or pass a probe object). Returns the activity item (already in the feed). */
export function addPending(w, o) {
  const e = w.ml.lookup(o.type, String(o.media_id));
  if (!e) throw new Error(`addPending: ${o.type}:${o.media_id} is not in the lookup catalog`);
  const tv = o.type === 'tv';
  const status = o.status ?? 'downloading';
  const queued = status === 'queued';
  const id = o.id ?? `q-${o.type}-${e.id}` + (tv ? `-${o.season}-${o.episode}` : '');
  const sxe = tv ? `S${String(o.season).padStart(2, '0')}E${String(o.episode).padStart(2, '0')}` : '';
  const download_id = o.download_id !== undefined ? o.download_id : queued ? null : gid('dl', id).padEnd(40, '0').slice(0, 40);
  const a = {
    id, type: o.type, title: e.title, subtitle: tv ? sxe + (o.episode_title ? ' · ' + o.episode_title : '') : String(e.year),
    status, progress: o.progress ?? (queued ? 0 : 0.25), size_bytes: queued ? null : o.size_bytes ?? 4_000_000_000,
    timeleft: queued ? null : o.timeleft ?? '0:30:00', quality: o.quality ?? (tv ? 'WEBDL-1080p' : 'Bluray-1080p'),
    download_speed: o.speed ?? (queued ? 0 : 4_000_000), message: o.message ?? null, media_id: e.id,
    season: tv ? o.season : null, episode: tv ? o.episode : null, episode_title: tv ? o.episode_title ?? null : null,
    poster: e.poster, year: e.year, download_id
  };
  // listInMetadata: Sonarr's metadata lists the episode the grab is for (as the seed's own grabs)
  if (tv && o.listInMetadata && e.seasons && (e.seasons[o.season - 1] || 0) < o.episode) e.seasons[o.season - 1] = o.episode;
  w.ml.activity.push(a);
  if (o.probe && download_id) {
    w.ml.probes[download_id] = typeof o.probe === 'object' ? o.probe : {
      container: 'matroska,webm', duration_s: tv ? 2700 : 6600, bitrate: 8_000_000, size_bytes: a.size_bytes,
      video: { index: 0, codec: 'h264', width: 1920, height: 1080, hdr: null, fps: 23.976 },
      audio: [{ index: 1, codec: 'eac3', channels: 6, layout: '5.1', lang: 'eng', title: null, atmos: false, default: true }], subtitles: []
    };
  }
  return a;
}

/* The import: the grab (activity id, or the item itself) leaves the feed and
 * Jellyfin gains the title, with ProviderIds that match it (Tmdb + Imdb for a
 * movie; for tv, an Episode in the series with that Tvdb id — season created
 * when missing; the series must already be in Jellyfin).
 *   name / year      the movie's (default: the catalog's)
 *   createdAgoMs     DateCreated relative to now (negative = in the future;
 *                    default 5 s ago). Landed checks sort by it.
 *   template         the item whose files/streams/trickplay are copied
 *                    (default: the 4th movie, a 4K HDR file; for tv episode
 *                    S1E1 of the same series)
 *   id               the new item's id (default: derived from the grab id)
 * Returns the new item. */
export function landImport(w, grab, o = {}) {
  const a = typeof grab === 'string' ? w.ml.activity.find((x) => x.id === grab) : grab;
  if (!a) throw new Error('landImport: no activity item ' + grab);
  w.ml.activity = w.ml.activity.filter((x) => x !== a && !(x.id === a.id));
  const created = iso(Date.now() - (o.createdAgoMs ?? 5_000));
  const id = o.id ?? gid('landed', a.id);
  if (a.type === 'movie') {
    const e = w.ml.lookup('movie', a.media_id);
    const name = o.name ?? e?.title ?? a.title;
    const tpl = o.template ?? movie(w, 3);
    const m = structuredClone(tpl);
    Object.assign(m, {
      Id: id, Name: name, OriginalTitle: name, SortName: name.replace(/^(the|a|an) /i, '').toLowerCase(), ProductionYear: o.year ?? e?.year ?? a.year,
      DateCreated: created, Etag: gid('etag', id).slice(0, 16), ProviderIds: { Tmdb: String(a.media_id), Imdb: e?.imdb_id ?? 'tt' + (7000000 + (Number(a.media_id) % 1000000)) }
    });
    m.MediaSources = m.MediaSources.map((s) => ({ ...s, Id: id }));
    m.Trickplay = { [id]: Object.values(tpl.Trickplay)[0] };
    w.items.set(id, m);
    if (e) e.added = true;
    return m;
  }
  const sr = w.list('Series').find((s) => s.ProviderIds?.Tvdb === String(a.media_id));
  if (!sr) throw new Error(`landImport: series tvdb ${a.media_id} is not in Jellyfin (add it first)`);
  let sn = kids(w, sr).find((x) => x.IndexNumber === a.season);
  if (!sn) {
    const s1 = kids(w, sr)[0];
    sn = { ...structuredClone(s1), Id: gid('Season', sr.Name, a.season), Name: `Season ${a.season}`, IndexNumber: a.season, DateCreated: created, childIds: [] };
    w.items.set(sn.Id, sn);
    sr.childIds.push(sn.Id);
  }
  const tpl = o.template ?? ep(w, sr, 1, 1);
  const name = a.episode_title ?? o.name ?? `Episode ${a.episode}`;
  const e = structuredClone(tpl);
  Object.assign(e, {
    Id: id, Name: name, OriginalTitle: name, SortName: name.toLowerCase(), SeasonId: sn.Id, SeasonName: sn.Name, ParentId: sn.Id,
    IndexNumber: a.episode, ParentIndexNumber: a.season, DateCreated: created, Etag: gid('etag', id).slice(0, 16),
    Overview: `S${a.season}E${a.episode} of ${sr.Name}.`, ProviderIds: { Tvdb: String(7000000 + Number(a.episode) + 100 * Number(a.season)) }
  });
  e.MediaSources = e.MediaSources.map((s) => ({ ...s, Id: id }));
  e.Trickplay = { [id]: Object.values(tpl.Trickplay)[0] };
  w.items.set(id, e);
  sn.childIds.push(id);
  sn.childIds.sort((x, y) => w.items.get(x).IndexNumber - w.items.get(y).IndexNumber);
  sr.DateLastMediaAdded = created;
  return e;
}
