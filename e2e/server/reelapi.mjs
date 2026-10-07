/* The fake reel-api (backend/README.md is the contract, backend/src/reel_api/
 * models.py the shapes). In-memory: adds, season searches, cancels, undos and
 * deletes change world.ml and are recorded (world.ml.adds / searches / cancels
 * / undos / deletes) for tests to assert on. Unknown /api routes are violations.
 *
 * Ownership and quotas (run/design.md §5, ownership.py): every route sees the
 * guard's user as ctx.user = { id, name, admin } (admin = the fake Jellyfin's
 * Policy.IsAdministrator). Adds record the caller as owner (world.ml.owners)
 * and a normal user's add is quota-checked (world.ml.quota); delete with files,
 * cancel and undo are the owner's or an admin's; a season Get records its
 * requester (world.ml.seasons). Titles without a record are legacy (the
 * admins'). "Still exists" (the arr has it) is the catalog entry's `added` or
 * a grab of it in the feed; a record whose title left the arr is pruned
 * whenever a quota is counted.
 * world.ml.oldBackend = true answers like a reel-api from before all this: no
 * /api/me (FastAPI's 404), no activity flags, no permission or quota checks,
 * no records.
 * Not modelled: a delete is synchronous (never `deleting`, so never 409
 * `being_deleted`), and it doesn't remove the Jellyfin item (the real Jellyfin
 * drops it on its next library scan). */
import { Router, send, sendFile } from './http.mjs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { png } from './png.mjs';
import { randomBytes } from 'node:crypto';

const err = (ctx, status, error, detail) => ctx.json(status, { error, detail: detail || error });

/* reel-api's request guard (backend/src/reel_api/security.py), enforced like the
 * real one: Host must be an IP literal or localhost (the fake's allowlist is
 * empty), an http(s) Origin likewise, and every route but GET/HEAD /health and
 * POST /api/push/unsubscribe needs a signed-in user's Jellyfin token —
 * `Authorization: MediaBrowser|Emby …Token="…"`, `Bearer …`, `X-Emby-Token`,
 * `X-MediaBrowser-Token` or `?api_key=`; a transport without a token falls
 * through to the next. → null when the request passes, else
 * { status, error, detail, why } (why: the violation text, null for a refusal
 * that is no client bug). The fake-only
 * /__fixture/ routes (poster images the real service links off-site) are exempt. */
export const GUARD_OPEN = new Set(['GET /health', 'HEAD /health', 'POST /api/push/unsubscribe']);

const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || (h.includes(':') && /^[0-9a-f:.]+$/i.test(h));
function hostAllowed(name) {
  if (!name) return false;
  name = name.toLowerCase().replace(/\.$/, '');
  return isIp(name) || name === 'localhost';
}
function hostname(host) {
  try {
    return host && host.trim() ? new URL('http://' + host.trim()).hostname.replace(/^\[|\]$/g, '') : null;
  } catch {
    return null;
  }
}

export function tokenFrom(headers, query) {
  const auth = (headers.authorization || '').trim();
  if (auth) {
    const sp = auth.indexOf(' ');
    const scheme = (sp < 0 ? auth : auth.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? '' : auth.slice(sp + 1);
    if (scheme === 'bearer' && rest.trim()) return rest.trim();
    if (scheme === 'mediabrowser' || scheme === 'emby') {
      const m = /(?:^|[\s,])Token\s*=\s*"([^"]*)"/i.exec(' ' + rest);
      if (m && m[1]) return m[1];
    }
  }
  for (const h of ['x-emby-token', 'x-mediabrowser-token']) {
    const v = (headers[h] || '').trim();
    if (v) return v;
  }
  for (const [k, v] of query) if (k.toLowerCase() === 'api_key' && v) return v;
  return null;
}

export function reelGuard(srv, req, r) {
  const where = req.method + ' ' + r.pathname;
  if (r.pathname.startsWith('/__fixture/')) return null;
  if (!hostAllowed(hostname(req.headers.host))) return { status: 403, error: 'bad_host', detail: 'unknown host name', why: `reel-api guard: Host ${JSON.stringify(req.headers.host || '')} refused on ${where}` };
  const origin = req.headers.origin;
  if (origin != null && /^https?:/i.test(origin.trim())) {
    let name = null;
    try {
      name = new URL(origin.trim()).hostname.replace(/^\[|\]$/g, '');
    } catch {}
    if (!hostAllowed(name)) return { status: 403, error: 'bad_origin', detail: 'cross-site request refused', why: `reel-api guard: Origin ${origin} refused on ${where}` };
  }
  if (GUARD_OPEN.has(where)) return null;
  const token = tokenFrom(req.headers, r.query);
  if (!token) return { status: 401, error: 'unauthorized', detail: 'sign in to Jellyfin first', why: `reel-api guard: no Jellyfin token on ${where} (send mlHeaders() / mlUrl())` };
  /* a token Jellyfin doesn't know (revoked, or a page left over from before
   * srv.reset()) is a 401 like the real guard's — but no violation: the client
   * did send one, and revocation mid-session is a legitimate state */
  if (!srv.world.tokens.has(token)) return { status: 401, error: 'unauthorized', detail: 'Jellyfin rejected the token', why: null };
  return null;
}

/* The guard's user for a request that passed it: { id, name, admin } (null on
 * the open routes without a token). index.mjs puts it on ctx.user. */
export function reelUser(srv, req, r) {
  const token = tokenFrom(req.headers, r.query);
  const rec = token ? srv.world.tokens.get(token) : null;
  const u = rec ? srv.world.users.get(rec.userId) : null;
  return u ? { id: u.Id, name: u.Name, admin: !!u.admin } : null;
}

/* activity statuses, most active first (app.py _STATUS_RANK); /api/me's order */
const RANK = { downloading: 0, importing: 1, queued: 2, warning: 3, paused: 4, completed: 5 };
const ME_ORDER = { ...RANK, waiting: 10, in_library: 11 };
const NOUN = { movie: ['movie', 'movies'], tv: ['show', 'shows'] };

/* the most active status of a title's rows in flight and their progress,
 * size-weighted over distinct downloads (app.py _title_status) */
function titleStatus(rows) {
  rows = rows.filter((a) => a.status !== 'completed');
  if (!rows.length) return [null, null];
  const status = rows.map((a) => a.status).sort((a, b) => (RANK[a] ?? 9) - (RANK[b] ?? 9))[0];
  const grabs = [...new Map(rows.map((a) => [a.download_id || 'i:' + a.id, a])).values()];
  const sized = grabs.filter((a) => a.size_bytes);
  const wsum = sized.reduce((n, a) => n + a.size_bytes, 0);
  const p = wsum ? sized.reduce((n, a) => n + (a.progress || 0) * a.size_bytes, 0) / wsum : grabs.reduce((n, a) => n + (a.progress || 0), 0) / grabs.length;
  return [status, Math.round(p * 1e4) / 1e4];
}

export function createReelApi(srv) {
  const ML = () => srv.world.ml;
  const r = new Router();
  const imgCache = new Map();

  /* ---- ownership (ownership.py Owners / Quota) ---- */
  const checks = () => !ML().oldBackend;
  const isMine = (u, type, id, season) => {
    if (!id) return false;
    if (ML().owners.get(type + ':' + id)?.owner === u.id) return true;
    return type === 'tv' && season != null && ML().seasons.get(`tv:${id}:${season}`)?.owner === u.id;
  };
  const dropTitle = (type, id) => {
    ML().owners.delete(type + ':' + id);
    if (type === 'tv') for (const k of [...ML().seasons.keys()]) if (k.startsWith(`tv:${id}:`)) ML().seasons.delete(k);
  };
  /* the arr has the title: lookup says added, or a grab of it is queued (the
   * seed's feed has grabs of titles its catalog calls un-added) */
  const inArr = (type, id) => !!ML().lookup(type, id)?.added || ML().activity.some((a) => a.type === type && a.media_id === id);
  /* records of titles the arr no longer has (deleted outside reel-api) go */
  const prune = () => {
    for (const k of [...ML().owners.keys()]) {
      const [type, id] = k.split(':');
      if (!inArr(type, id)) dropTitle(type, id);
    }
    for (const k of [...ML().seasons.keys()]) if (!inArr('tv', k.split(':')[1])) ML().seasons.delete(k);
  };
  const owned = (u, type) => {
    prune();
    return [...ML().owners].filter(([k, rec]) => k.startsWith(type + ':') && rec.owner === u.id).map(([k, rec]) => [k.slice(type.length + 1), rec]);
  };
  /* the title as Jellyfin has it (a file is on disk): a movie by tmdb, a series by tvdb id */
  const inJellyfin = (type, id) => srv.world.list(type === 'tv' ? 'Series' : 'Movie').some((it) => it.ProviderIds?.[type === 'tv' ? 'Tvdb' : 'Tmdb'] === id);
  const notOwner = (ctx, detail) => err(ctx, 403, 'not_owner', detail);

  /* { __img: key } placeholders → absolute URLs on this origin */
  const urls = (v) => {
    if (Array.isArray(v)) return v.map(urls);
    if (v && typeof v === 'object') {
      if (v.__img) return srv.urls.ml + '/__fixture/img/' + encodeURIComponent(v.__img) + '.png';
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = urls(x);
      return o;
    }
    return v;
  };
  const lookupOut = (e) => urls(ML().lookupShape(e));
  const rated = (e, rank) => ({ ...lookupOut(e), imdb_id: e.imdb_id, rating: e.rating, rating_votes: e.votes, rank });

  r.add('GET', '/__fixture/img/{name}', (ctx) => {
    const name = ctx.params.name.replace(/\.png$/, '');
    const wide = /^fanart|^still/.test(name);
    if (!imgCache.has(name)) imgCache.set(name, png(wide ? 480 : 200, wide ? 270 : 300, 'ml' + name));
    return ctx.image(imgCache.get(name));
  });

  /* each row says whether it is the caller's and whether they may cancel it */
  r.add('GET', '/api/activity', (ctx) => {
    const u = ctx.user;
    const items = checks() ? ML().activity.map((a) => {
      const mine = isMine(u, a.type, a.media_id, a.season);
      return { ...a, mine, can_cancel: u.admin || mine };
    }) : ML().activity;
    return urls({ items });
  });

  /* GET /api/me (app.py who_am_i): the caller, their quota use, the titles they own */
  r.add('GET', '/api/me', (ctx) => {
    if (!checks()) return ctx.json(404, { detail: 'Not Found' }); // FastAPI's answer for an unknown route
    const u = ctx.user;
    const quota = {}, titles = [];
    for (const type of ['movie', 'tv']) {
      const mine = owned(u, type);
      quota[type] = { used: mine.length, limit: u.admin ? null : ML().quota[type] };
      for (const [id, rec] of mine) {
        const e = ML().lookup(type, id);
        const [status, progress] = titleStatus(ML().activity.filter((a) => a.type === type && a.media_id === id));
        const has = inJellyfin(type, id);
        titles.push({ type, id, title: e.title, year: e.year, poster: urls(e.poster), added_at: rec.at, status: status || (has ? 'in_library' : 'waiting'), progress, has_files: has });
      }
    }
    titles.sort((a, b) => (ME_ORDER[a.status] ?? 9) - (ME_ORDER[b.status] ?? 9) || (a.added_at < b.added_at ? 1 : a.added_at > b.added_at ? -1 : 0));
    return { user: { id: u.id, name: u.name }, admin: u.admin, quota, titles };
  });

  /* undo.py Undo.cancel + app.py cancel_activity: the rows of that title (season /
   * episode), widened to every row sharing their torrent (a season pack goes as a
   * whole); torrents with an importing row are kept; nothing left → 409 importing */
  r.add('DELETE', '/api/activity/{type}/{id}', (ctx) => {
    const { type, id } = ctx.params;
    const season = ctx.q('season'), episode = ctx.q('episode');
    if (episode != null && season == null) return err(ctx, 400, 'bad_request', 'episode needs season');
    if (type === 'movie' && (season != null || episode != null)) return err(ctx, 400, 'bad_request', 'a movie has no seasons');
    const all = ML().activity;
    const mine = all.filter((a) => a.type === type && a.media_id === id && (season == null || a.season === Number(season)) && (episode == null || a.episode === Number(episode)));
    if (!mine.length) return err(ctx, 404, 'not_in_queue', 'nothing of that is downloading');
    const dls = new Set(mine.map((a) => a.download_id).filter(Boolean));
    let rows = all.filter((a) => mine.includes(a) || (a.download_id && dls.has(a.download_id)));
    const key = (a) => a.download_id || 'row:' + a.id;
    const busy = new Set(rows.filter((a) => a.status === 'importing').map(key));
    rows = rows.filter((a) => !busy.has(key(a)));
    if (!rows.length) return err(ctx, 409, 'importing', 'already being imported into the library');
    // a normal user cancels only rows of their titles / seasons they asked for — all or nothing
    if (checks() && !ctx.user.admin && !rows.every((a) => isMine(ctx.user, a.type, a.media_id, a.season)))
      return notOwner(ctx, `Only the person who added “${rows[0].title || id}” can cancel its download.`);
    ML().activity = all.filter((a) => !rows.includes(a));
    ML().cancels.push({ type, id, season, episode, removed: rows.map((a) => a.id) });
    const eps = [...new Map(rows.filter((a) => a.season != null).map((a) => [a.season + ':' + a.episode, { season: a.season, episode: a.episode }])).values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
    return { id, type, status: 'cancelled', downloads_removed: new Set(rows.map(key)).size, episodes: eps, unmonitored: type === 'tv' ? eps.length : 1, kept: busy.size };
  });

  r.add('GET', '/api/lookup', (ctx) => {
    const q = (ctx.q('q') || '').trim();
    const type = ctx.q('type');
    if (!q) return ctx.json(422, { detail: [{ loc: ['query', 'q'], msg: 'field required', type: 'value_error.missing' }] });
    if (type !== 'tv' && type !== 'movie') return ctx.json(422, { detail: [{ loc: ['query', 'type'], msg: 'bad type' }] });
    const results = [...ML().catalog.values()].filter((e) => e.type === type && e.title.toLowerCase().includes(q.toLowerCase())).map(lookupOut);
    return { query: q, type, results };
  });

  /* the quota comes first (design Amendment 5: at the limit even an
   * already-added title is quota_exceeded — no arr call is made) */
  r.add('POST', '/api/library', (ctx) => {
    const b = ctx.body || {};
    const u = ctx.user;
    if (checks() && !u.admin && (b.type === 'movie' || b.type === 'tv')) {
      const used = owned(u, b.type).length, limit = ML().quota[b.type];
      if (used >= limit) {
        const [one, many] = NOUN[b.type];
        const detail = limit === 0 ? `Adding ${many} is turned off for your account.` : `You already have ${used} of ${limit} ${limit === 1 ? one : many}. Delete one in My library to add another.`;
        return ctx.json(409, { error: 'quota_exceeded', detail, type: b.type, used, limit });
      }
    }
    const e = ML().lookup(b.type, String(b.id));
    if (!e) return err(ctx, 404, 'not_found');
    if (e.added) return err(ctx, 409, 'already_added');
    e.added = true;
    const undo = randomBytes(8).toString('hex');
    if (checks()) ML().owners.set(e.type + ':' + e.id, { owner: u.id, at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') });
    ML().adds.push({ id: e.id, type: e.type, undo, user: u.id });
    // Sonarr/Radarr start searching: a queued grab appears in the feed
    ML().activity.push({ id: 'q-' + e.type + '-' + e.id, type: e.type, title: e.title, subtitle: e.type === 'tv' ? 'S01E01 · Pilot' : String(e.year), status: 'queued', progress: 0, size_bytes: null, timeleft: null, quality: null, download_speed: 0, message: null, media_id: e.id, season: e.type === 'tv' ? 1 : null, episode: e.type === 'tv' ? 1 : null, episode_title: e.type === 'tv' ? 'Pilot' : null, poster: e.poster, year: e.year, download_id: null });
    return ctx.json(202, { id: e.id, type: e.type, title: e.title, status: 'added', undo });
  });

  /* ?undo=TOKEN undoes an add (the adder's or an admin's); ?delete_files=true
   * deletes the title with its files (its owner's or an admin's; a legacy
   * title an admin's only). Exactly one of them, else 400. */
  r.add('DELETE', '/api/library/{type}/{id}', (ctx) => {
    const { type, id } = ctx.params;
    const u = ctx.user;
    const token = ctx.q('undo'), del = ctx.qb('delete_files', false);
    if (!checks() && token == null) return ctx.json(422, { detail: [{ loc: ['query', 'undo'], msg: 'Field required', type: 'missing' }] });
    if ((token != null) === del) return err(ctx, 400, 'bad_request', 'pass either undo=<token> or delete_files=true');
    if (del) return deleteWithFiles(ctx, type, id, u);
    const a = ML().adds.find((x) => x.type === type && x.id === id && x.undo === token);
    if (!a) return err(ctx, 410, 'undo_expired');
    const e = ML().lookup(type, id);
    if (checks() && !u.admin && a.user !== u.id) return notOwner(ctx, `Only the person who added “${e.title}” can undo that.`);
    e.added = false;
    const before = ML().activity.length;
    ML().activity = ML().activity.filter((x) => !(x.type === type && x.media_id === id));
    ML().undos.push({ type, id });
    dropTitle(type, id);
    return { id, type, title: e.title, status: 'removed', downloads_removed: before - ML().activity.length };
  });

  /* undo.py delete_with_files, with design Amendment 2's order: a title the
   * arr no longer has is already_removed for its owner, an admin, or anyone
   * when there is no record; refusals (403, 409 importing) touch nothing */
  function deleteWithFiles(ctx, type, id, u) {
    const rec = ML().owners.get(type + ':' + id);
    const e = ML().lookup(type, id);
    const name = e?.title || id;
    const mine = u.admin || rec?.owner === u.id;
    if (!inArr(type, id) && (mine || !rec)) {
      dropTitle(type, id);
      return { id, type, title: name, status: 'already_removed', downloads_removed: 0 };
    }
    if (!mine) return notOwner(ctx, rec ? `Only the person who added “${name}” can delete it.` : `“${name}” was added by an admin; only an admin can delete it.`);
    const rows = ML().activity.filter((a) => a.type === type && a.media_id === id);
    if (rows.some((a) => a.status === 'importing')) return err(ctx, 409, 'importing', `“${name}” is being imported right now — try again in a minute.`);
    ML().activity = ML().activity.filter((a) => !rows.includes(a));
    e.added = false;
    dropTitle(type, id);
    if (type === 'tv') for (let i = ML().news.length - 1; i >= 0; i--) if (ML().news[i].media_id === id) ML().news.splice(i, 1); // Sonarr no longer has the series
    ML().deletes.push({ type, id, user: u.name });
    ctx.note('fake reel-api: a delete with files is synchronous (no `deleting`/`being_deleted`) and leaves the Jellyfin item (the real Jellyfin drops it on its next scan)');
    return { id, type, title: name, status: 'deleted', downloads_removed: new Set(rows.map((a) => a.download_id || 'row:' + a.id)).size };
  }

  r.add('GET', '/api/metadata/{type}/{id}', (ctx) => {
    const { type, id } = ctx.params;
    const e = ML().lookup(type, id);
    if (!e) return err(ctx, 404, 'not_found');
    const episodes = [];
    if (type === 'tv') {
      (e.seasons || []).forEach((n, k) => {
        for (let i = 1; i <= n; i++) episodes.push({ season: k + 1, episode: i, title: `Episode ${i}`, overview: `S${k + 1}E${i} of ${e.title}.`, air_date: ML().date(srv.world.now - (400 - k * 100 - i * 7) * 86_400_000), still: { __img: `still-${id}-${k + 1}-${i}` }, has_file: false });
      });
    }
    return urls({ id: e.id, type, title: e.title, year: e.year, overview: e.overview, poster: e.poster, fanart: { __img: `fanart-${type}-${id}` }, runtime_min: e.runtime_min, genres: e.genres, rating: e.rating, certification: e.certification, status: e.status, episodes, trailer: e.trailer, collection: e.collection });
  });

  r.add('GET', '/api/trending', (ctx) => {
    const type = ctx.q('type');
    if (type !== 'tv' && type !== 'movie') return ctx.json(422, { detail: 'bad type' });
    return { type, results: ML().trending[type].map((e, i) => ({ ...rated(e, i + 1), released: ML().date(srv.world.now - (40 + i * 9) * 86_400_000), ...(type === 'movie' ? { digital_release: i % 2 ? null : ML().date(srv.world.now - 10 * 86_400_000) } : {}) })) };
  });

  r.add('GET', '/api/charts', () => ({
    categories: Object.values(ML().charts).map((c) => ({
      key: c.key, title: c.title, types: c.sections.map((s) => s.type), count: c.sections.reduce((n, s) => n + s.entries.length, 0),
      posters: c.sections.flatMap((s) => s.entries.slice(0, 3)).slice(0, 4).map((e) => urls(e.poster))
    }))
  }));

  r.add('GET', '/api/charts/{key}', (ctx) => {
    const c = ML().charts[ctx.params.key];
    if (!c) return err(ctx, 404, 'no_such_chart');
    return { key: c.key, title: c.title, sections: c.sections.map((s) => ({ type: s.type, title: s.title, results: s.entries.map((e, i) => rated(e, i + 1)) })) };
  });

  r.add('GET', '/api/collection/{id}', (ctx) => {
    const c = ML().collections[ctx.params.id];
    if (!c) return err(ctx, 404, 'not_found');
    return urls({ id: c.id, title: c.title, overview: c.overview, poster: c.poster, fanart: c.fanart, movies: c.entries.map((e) => ({ ...ML().lookupShape(e), rating: e.rating, released: ML().date(Date.UTC(e.year || 2000, 5, 1)) })) });
  });

  r.add('GET', '/api/news', () => urls({ items: ML().news }));

  r.add('POST', '/api/news/search', (ctx) => {
    const b = ctx.body || {};
    const n = ML().news.find((x) => x.media_id === String(b.id) && x.season === Number(b.season));
    if (!n) return err(ctx, 404, 'not_found');
    if (n.kind !== 'aired') return err(ctx, 409, 'not_aired');
    const undo = randomBytes(8).toString('hex');
    // anyone may Get a season; the FIRST requester holds it (may cancel the grabs it
    // makes — ownership.py also refuses grabs queued before the request); undo: the requester
    const recorded = checks() && !ML().seasons.has(`tv:${n.media_id}:${n.season}`);
    ML().searches.push({ id: n.media_id, season: n.season, undo, user: ctx.user.id, recorded });
    if (recorded) ML().seasons.set(`tv:${n.media_id}:${n.season}`, { owner: ctx.user.id, at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') });
    n.monitored = true;
    return ctx.json(202, { id: n.media_id, season: n.season, title: n.title, status: 'searching', undo });
  });

  r.add('DELETE', '/api/news/search/{undo}', (ctx) => {
    const s = ML().searches.find((x) => x.undo === ctx.params.undo);
    if (!s) return err(ctx, 410, 'undo_expired');
    if (checks() && !ctx.user.admin && s.user !== ctx.user.id) return notOwner(ctx, 'Only the person who asked for that season can undo it.');
    if (s.recorded && !s.undone && ML().seasons.get(`tv:${s.id}:${s.season}`)?.owner === s.user) ML().seasons.delete(`tv:${s.id}:${s.season}`);
    s.undone = true; // a replayed token drops nothing (undo.py: the cached answer)
    const n = ML().news.find((x) => x.media_id === s.id && x.season === s.season);
    if (n) n.monitored = false;
    ML().undos.push({ search: s.undo });
    return { id: s.id, season: s.season, title: n?.title || '', status: 'reverted', downloads_removed: 0, kept: 0 };
  });

  r.add('GET', '/api/segments/{imdb}/{season}/{episode}', (ctx) => {
    const { imdb, season, episode } = ctx.params;
    return ML().segments.get(`${imdb}:${season}:${episode}`) || { intro: null, recap: null, outro: null };
  });

  r.add('GET', '/api/downloads/{id}/probe', (ctx) => {
    const p = ML().probes[ctx.params.id];
    if (!p) return err(ctx, 404, 'not_found');
    if (p.notReady) return err(ctx, 409, 'not_ready');
    return p;
  });

  r.add('GET,HEAD', '/api/downloads/{id}/stream', (ctx) => {
    if (!ML().probes[ctx.params.id]) return err(ctx, 404, 'not_found');
    // streaming.py stream_endpoint: Accept-Ranges, Cache-Control: no-store (a growing file must never be reused from a cache)
    return ctx.video({ cut: ML().cutStreams.has(ctx.params.id), headers: { 'Cache-Control': 'no-store' } });
  });

  /* Trailers (trailers.py). Without yt-dlp every trailer reports `error`, which
   * the apps answer by falling back to the YouTube app — unless a test puts its
   * key into world.ml.trailers ({ subs?: {lang, kind} | null, title? }): then the
   * job is "ready" at once and serves the fixture's 30 s fMP4 HLS (media.mjs
   * `trailer`), subs.vtt the fixture VTT. GET before a POST is 404 like the
   * backend's (no job). */
  const TRAILER_FILE = /^(index\.m3u8|init\.mp4|s\d{3,5}\.m4s|subs\.vtt)$/;
  /* trailers.py parse_key: `<id>` (best up to 2160p) or `<id>@<height>` (the
   * iPhone asks for @1080) → { id, h, key } with the canonical key (a height at
   * or above 2160 is the plain id), or null. Every height of an id is served
   * from the same fixture job, world.ml.trailers.get(id); `tr.keys` lists the
   * canonical keys asked for, `trailerFiles` entries carry the key. */
  const parseTrailerKey = (key) => {
    const m = /^([\w-]{11})(?:@(\d{3,4}))?$/.exec(key);
    if (!m) return null;
    const h = Math.min(m[2] ? Number(m[2]) : 2160, 2160);
    return h < 144 ? null : { id: m[1], h, key: h === 2160 ? m[1] : `${m[1]}@${h}` };
  };
  const trailerJob = (raw) => {
    const k = parseTrailerKey(raw);
    const tr = k && ML().trailers.get(k.id), m = srv.media.trailer;
    return tr && m ? { tr, m, key: k.key } : null;
  };
  r.add('POST,GET', '/api/trailers/{id}', (ctx) => {
    const raw = ctx.params.id, job = trailerJob(raw), key = job ? job.key : parseTrailerKey(raw)?.key ?? raw;
    // every key of trailers.py Job.status(), as the backend sends it (backend/tests/support/documented.py)
    if (!job) return { id: key, state: 'error', segments: 0, buffered_s: 0, duration: null, complete: false, width: null, height: null, vcodec: null, codecs: null, hdr: null, subs: null, subs_done: true, title: null, error: 'fixture: trailers are not served' };
    if (ctx.req.method === 'POST') ((job.tr.started ||= new Set()).add(key), (job.tr.keys ||= []).push(key));
    else if (!job.tr.started?.has(key)) return err(ctx, 404, 'not_found', 'trailer not started');
    const subs = job.tr.subs === undefined ? { lang: 'en', kind: 'manual' } : job.tr.subs;
    return { id: key, state: 'ready', segments: job.m.files.filter((f) => f.endsWith('.m4s')).length, buffered_s: job.m.duration, duration: job.m.duration, complete: true, width: 320, height: 180, vcodec: 'vp9', codecs: job.m.codecs, hdr: null, subs, subs_done: true, title: job.tr.title ?? null, error: null };
  });

  r.add('GET', '/api/trailers/{key}/{name}', (ctx) => {
    const { name } = ctx.params, job = trailerJob(ctx.params.key), key = job?.key;
    if (!TRAILER_FILE.test(name) || !job?.tr.started?.has(key)) return err(ctx, 404, 'not_found', 'no such trailer file');
    if (name === 'subs.vtt') {
      if (job.tr.subs === null) return err(ctx, 404, 'not_found', 'no such trailer file');
      ML().trailerFiles.push({ key, name });
      return ctx.raw(200, srv.media.vtt, 'text/vtt; charset=utf-8');
    }
    if (!job.m.files.includes(name)) return err(ctx, 404, 'not_found', 'no such trailer file');
    const type = name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4';
    sendFile(ctx.req, ctx.res, path.join(job.m.dir, name), { 'Content-Type': type, 'Cache-Control': name.endsWith('.m3u8') ? 'no-store' : 'max-age=86400' });
    ML().trailerFiles.push({ key, name });
  });

  /* Live HLS of a growing download (livehls.py, the phone's watch-while-
   * downloading). The real one needs the qBittorrent backend; by default the
   * fixture answers exactly like a reel-api without it — start 503, status
   * "not started", files 404. A test that puts a download id into
   * world.ml.liveHls ({ probing: n } = the first n status answers say
   * "probing" without codecs, default 1) gets a job: "remuxing" with the
   * fixture trailer's codecs, the probed runtime as duration, and its 30 s of
   * fMP4 as a playlist that is still growing (no #EXT-X-ENDLIST), segments
   * renamed to livehls's s00000.m4s; every file no-store like livehls.py. */
  const LIVE_FILE = /^(index\.m3u8|init\.mp4|s\d{5}\.m4s)$/;
  const liveJob = (ctx) => {
    const gid = ctx.params.gid.toLowerCase(), job = ML().liveHls.get(gid);
    return job && srv.media.trailer ? { gid, job } : null;
  };
  const liveStatus = (ctx, gid, job) => {
    const audio = Number(ctx.q('audio') ?? -1);
    const probing = (job.answers = (job.answers || 0) + 1) <= (job.probing ?? 1);
    const dur = ML().probes[gid]?.duration_s ?? srv.media.trailer.duration;
    return { id: gid, audio, state: probing ? 'probing' : 'remuxing', segments: probing ? 0 : 3, buffered_s: probing ? 0 : srv.media.trailer.duration, duration: probing ? null : dur, complete: false, codecs: probing ? null : srv.media.trailer.codecs, video: probing ? null : { codec: 'vp9', width: 320, height: 180, dv_profile: null }, audio_codec: probing ? null : 'opus', progress: null, error: null };
  };
  r.add('POST', '/api/downloads/{gid}/hls', (ctx) => {
    const l = liveJob(ctx);
    if (!l) return err(ctx, 503, 'temporarily_unavailable', 'streaming needs the qBittorrent backend');
    l.job.started = new Set([...(l.job.started || []), Number(ctx.q('audio') ?? -1)]);
    return liveStatus(ctx, l.gid, l.job);
  });
  r.add('GET', '/api/downloads/{gid}/hls', (ctx) => {
    const l = liveJob(ctx);
    if (!l || !l.job.started?.has(Number(ctx.q('audio') ?? -1))) return err(ctx, 404, 'not_found', 'not started');
    return liveStatus(ctx, l.gid, l.job);
  });
  r.add('GET', '/api/downloads/{gid}/hls/{audio}/{name}', (ctx) => {
    const l = liveJob(ctx), { name } = ctx.params;
    if (!l || !LIVE_FILE.test(name) || !l.job.started?.has(Number(ctx.params.audio))) return err(ctx, 404, 'not_found', 'no such file');
    const m = srv.media.trailer;
    const h = { 'Cache-Control': 'no-store' };
    if (name === 'index.m3u8') {
      const text = readFileSync(path.join(m.dir, 'index.m3u8'), 'utf8').replace(/^s(\d{3})\.m4s$/gm, (_, n) => 's' + n.padStart(5, '0') + '.m4s').replace('#EXT-X-ENDLIST\n', '').replace('#EXTM3U\n', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n');
      send(ctx.res, 200, text, { 'Content-Type': 'application/vnd.apple.mpegurl', ...h });
    } else {
      const file = name === 'init.mp4' ? name : 's' + name.slice(1, 6).replace(/^00/, '') + '.m4s';
      if (!m.files.includes(file)) return err(ctx, 404, 'not_found', 'no such file');
      sendFile(ctx.req, ctx.res, path.join(m.dir, file), { 'Content-Type': 'video/mp4', ...h });
    }
    ML().liveFiles.push({ gid: l.gid, audio: Number(ctx.params.audio), name });
  });

  /* Web Push (push.py) without VAPID_PRIVATE_KEY: config says disabled and
   * every other call is 503 not_available, as on a backend with push unset. */
  r.add('GET', '/api/push/config', () => ({ enabled: false, key: null }));
  for (const p of ['subscribe', 'status', 'unsubscribe', 'test']) r.add('POST', '/api/push/' + p, (ctx) => err(ctx, 503, 'not_available', 'push notifications are not set up'));

  return { router: r };
}
