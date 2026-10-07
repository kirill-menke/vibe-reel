/* The fake Jellyfin 12.1: the routes VibeReel (TV + phone) calls, stateful,
 * in memory. Every route template registered here must exist in the 12.1
 * OpenAPI spec (checked at startup when the spec is cached), and every
 * request is validated against it before it is routed (server/index.mjs).
 *
 * Fidelity rules that matter for the apps (CLAUDE.md):
 *  - auth only via `Authorization: MediaBrowser Client=…, Device=…,
 *    DeviceId=…, Version=…, Token=…` or the `ApiKey` query parameter; the
 *    legacy X-Emby-Authorization header is answered 400 "Value cannot be null.
 *    (Parameter 'request.App')" as 12.1 does;
 *  - `api_key=` is refused (401) on the Trickplay endpoint, accepted elsewhere;
 *  - list routes honour `Fields`: optional ItemFields are only present when
 *    asked for (GET /Items/{id} returns everything);
 *  - CORS: Access-Control-Allow-Origin: *, preflights answered. */
import { Router, qget, send } from './http.mjs';
import { png } from './png.mjs';
import { gid, TICKS } from './seed.mjs';
import { randomBytes } from 'node:crypto';

/* ItemFields enum of 12.1 — the optional parts of a BaseItemDto. */
export const OPTIONAL_FIELDS = new Set('AirTime,CanDelete,CanDownload,ChannelInfo,Chapters,Trickplay,ChildCount,CumulativeRunTimeTicks,CustomRating,DateCreated,DateLastMediaAdded,DisplayPreferencesId,Etag,ExternalUrls,Genres,ItemCounts,MediaSourceCount,MediaSources,OriginalTitle,Overview,ParentId,Path,People,PlayAccess,ProductionLocations,ProviderIds,PrimaryImageAspectRatio,RecursiveItemCount,Settings,SeriesStudio,SortName,SpecialEpisodeNumbers,Studios,Taglines,Tags,RemoteTrailers,MediaStreams,SeasonUserData,DateLastRefreshed,DateLastSaved,RefreshState,ChannelImage,EnableMediaSourceDisplay,Width,Height,ExtraIds,LocalTrailerCount,IsHD,SpecialFeatureCount'.split(','));
const INTERNAL = new Set(['childIds']);

/* Operations without `security` in the spec (fallback when it isn't cached). */
const ANON = [
  /^\/System\/Info\/Public$/i, /^\/Users\/AuthenticateByName$/i, /^\/Users\/AuthenticateWithQuickConnect$/i,
  /^\/QuickConnect\/(Initiate|Connect|Enabled)$/i, /^\/Items\/[^/]+\/Images\//i, /^\/UserImage$/i, /^\/Users\/Public$/i
];

export function parseAuthHeader(h) {
  const m = /^\s*MediaBrowser\s+(.*)$/i.exec(h || '');
  if (!m) return null;
  const out = {};
  for (const p of m[1].matchAll(/([A-Za-z]+)="([^"]*)"/g)) out[p[1]] = decodeURIComponent(p[2]);
  return out;
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, '.0000000Z');

export function createJellyfin(srv) {
  const W = () => srv.world;
  const r = new Router();
  const imgCache = new Map();

  /* ---------------- DTO projection ---------------- */
  function userDataOf(userId, it) {
    const w = W();
    const raw = w.userData.get(userId + ':' + it.Id) || { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false };
    const ud = { ...raw, Key: it.Id, ItemId: it.Id };
    if (it.Type === 'Series' || it.Type === 'Season') {
      const eps = episodesUnder(it);
      const played = eps.filter((e) => w.userData.get(userId + ':' + e.Id)?.Played).length;
      ud.UnplayedItemCount = eps.length - played;
      ud.PlayedPercentage = eps.length ? (played / eps.length) * 100 : 0;
      ud.Played = eps.length > 0 && played === eps.length;
      if (!ud.PlayedPercentage) delete ud.PlayedPercentage;
    } else if (it.RunTimeTicks && raw.PlaybackPositionTicks > 0) {
      ud.PlayedPercentage = (raw.PlaybackPositionTicks / it.RunTimeTicks) * 100;
    }
    return ud;
  }

  function episodesUnder(it) {
    const w = W();
    if (it.Type === 'Season') return it.childIds.map((id) => w.items.get(id));
    if (it.Type === 'Series') return it.childIds.flatMap((sid) => w.items.get(sid).childIds.map((id) => w.items.get(id)));
    return [];
  }

  /* opts.fields: 'all' | Set of ItemFields names (case-insensitive) */
  function dto(it, userId, opts = {}) {
    const fields = opts.fields ?? new Set();
    const want = (f) => fields === 'all' || fields.has(f.toLowerCase());
    const out = {};
    for (const [k, v] of Object.entries(it)) {
      if (INTERNAL.has(k)) continue;
      if (OPTIONAL_FIELDS.has(k) && !want(k)) continue;
      out[k] = structuredClone(v);
    }
    if (it.MediaSources && want('MediaStreams')) out.MediaStreams = structuredClone(it.MediaSources[0].MediaStreams);
    if (it.childIds && want('ChildCount')) out.ChildCount = it.childIds.length;
    if (it.childIds && want('RecursiveItemCount')) out.RecursiveItemCount = episodesUnder(it).length;
    if (want('PrimaryImageAspectRatio') && it.ImageTags?.Primary) out.PrimaryImageAspectRatio = it.Type === 'Episode' ? 16 / 9 : 2 / 3;
    if (it.Type !== 'Person' && opts.userData !== false && userId) out.UserData = userDataOf(userId, it);
    if (opts.images === false) {
      delete out.ImageTags;
      delete out.BackdropImageTags;
    }
    return out;
  }

  function fieldsOf(ctx) {
    const f = ctx.q('fields');
    return new Set((f || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  }
  const listOpts = (ctx) => ({ fields: fieldsOf(ctx), userData: ctx.qb('enableUserData', true), images: ctx.qb('enableImages', true) });

  /* ---------------- query engine for /Items-like lists ---------------- */
  const sortKeys = {
    sortname: (it) => it.SortName || '',
    name: (it) => it.Name || '',
    datecreated: (it) => it.DateCreated || '',
    premieredate: (it) => it.PremiereDate || '',
    productionyear: (it) => it.ProductionYear || 0,
    communityrating: (it) => it.CommunityRating || 0,
    runtime: (it) => it.RunTimeTicks || 0,
    datelastcontentadded: (it) => it.DateLastMediaAdded || it.DateCreated || '',
    dateplayed: (it, ctx) => W().userData.get(ctx.userId + ':' + it.Id)?.LastPlayedDate || '',
    playcount: (it, ctx) => W().userData.get(ctx.userId + ':' + it.Id)?.PlayCount || 0,
    indexnumber: (it) => it.IndexNumber || 0,
    parentindexnumber: (it) => it.ParentIndexNumber || 0,
    random: (it) => gid('rand', it.Id)
  };

  function sortItems(list, ctx, sortBy, sortOrder) {
    if (!sortBy) return list;
    const by = sortBy.split(',').map((s) => s.trim().toLowerCase());
    const ord = (sortOrder || '').split(',').map((s) => s.trim().toLowerCase());
    return list.slice().sort((a, b) => {
      for (let i = 0; i < by.length; i++) {
        const f = sortKeys[by[i]];
        if (!f) {
          ctx.note(`fake ignores SortBy=${by[i]}`);
          continue;
        }
        const x = f(a, ctx), y = f(b, ctx);
        const desc = (ord[i] ?? ord[0]) === 'descending';
        if (x < y) return desc ? 1 : -1;
        if (x > y) return desc ? -1 : 1;
      }
      return 0;
    });
  }

  const HANDLED_ITEMS_Q = new Set(['userid', 'ids', 'includeitemtypes', 'excludeitemtypes', 'recursive', 'parentid', 'searchterm', 'genres', 'personids', 'filters', 'isplayed', 'sortby', 'sortorder', 'startindex', 'limit', 'fields', 'enableuserdata', 'enableimages', 'enableimagetypes', 'imagetypelimit', 'mediatypes', 'ismissing', 'enabletotalrecordcount', 'isfavorite', 'hastmdbid', 'hastvdbid', 'hasimdbid', 'collapseboxsetitems']);

  function queryItems(ctx) {
    const w = W();
    for (const [k] of ctx.query) if (!HANDLED_ITEMS_Q.has(k.toLowerCase()) && !/^(api_?key)$/i.test(k)) ctx.note(`fake ignores /Items param ${k}`);
    let list = [...w.items.values()];
    const ids = ctx.q('ids');
    const parentId = ctx.q('parentId');
    const recursive = ctx.qb('recursive', false);
    if (ids) {
      const set = new Set(ids.split(',').map((s) => s.toLowerCase()));
      list = list.filter((it) => set.has(it.Id));
    } else if (parentId) {
      const p = w.items.get(parentId.toLowerCase());
      list = p ? (recursive ? [...p.childIds.map((i) => w.items.get(i)), ...episodesUnder(p)] : p.childIds.map((i) => w.items.get(i))) : [];
      list = [...new Set(list)];
    } else if (!recursive && !ctx.q('searchTerm') && !ctx.q('personIds')) {
      // the root's direct children are the user's libraries (views); the apps never ask for them
      ctx.note('non-recursive /Items without parentId/ids (would list library views)');
      list = [];
    }
    list = list.filter((it) => it.Type !== 'Person');
    const types = ctx.q('includeItemTypes');
    if (types) {
      const t = new Set(types.split(',').map((s) => s.toLowerCase()));
      list = list.filter((it) => t.has(it.Type.toLowerCase()));
    }
    const ex = ctx.q('excludeItemTypes');
    if (ex) {
      const t = new Set(ex.split(',').map((s) => s.toLowerCase()));
      list = list.filter((it) => !t.has(it.Type.toLowerCase()));
    }
    const mt = ctx.q('mediaTypes');
    if (mt && /video/i.test(mt)) list = list.filter((it) => it.MediaType === 'Video');
    const st = ctx.q('searchTerm');
    if (st) list = list.filter((it) => it.Name.toLowerCase().includes(st.toLowerCase()));
    const genres = ctx.q('genres');
    if (genres) {
      const g = genres.split('|').map((s) => s.toLowerCase());
      list = list.filter((it) => (it.Genres || []).some((x) => g.includes(x.toLowerCase())));
    }
    const pids = ctx.q('personIds');
    if (pids) {
      const p = new Set(pids.split(',').map((s) => s.toLowerCase()));
      list = list.filter((it) => (it.People || []).some((x) => p.has(x.Id)));
    }
    const ud = (it) => userDataOf(ctx.userId, it);
    const filters = (ctx.q('filters') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    for (const f of filters) {
      if (f === 'isunplayed') list = list.filter((it) => !ud(it).Played);
      else if (f === 'isplayed') list = list.filter((it) => ud(it).Played);
      else if (f === 'isresumable') list = list.filter((it) => ud(it).PlaybackPositionTicks > 0);
      else if (f === 'isfavorite') list = list.filter((it) => ud(it).IsFavorite);
      else ctx.note('fake ignores Filters=' + f);
    }
    const ip = ctx.q('isPlayed');
    if (ip != null) list = list.filter((it) => ud(it).Played === /^true$/i.test(ip));
    if (ctx.qb('isFavorite', null) != null) list = list.filter((it) => ud(it).IsFavorite === ctx.qb('isFavorite'));
    list = sortItems(list, ctx, ctx.q('sortBy'), ctx.q('sortOrder'));
    return page(ctx, list);
  }

  function page(ctx, list, opts = listOpts(ctx)) {
    const start = Number(ctx.q('startIndex') || 0);
    const lim = ctx.q('limit');
    const slice = lim != null ? list.slice(start, start + Number(lim)) : list.slice(start);
    return { Items: slice.map((it) => dto(it, ctx.userId, opts)), TotalRecordCount: list.length, StartIndex: start };
  }

  /* ---------------- next up ---------------- */
  function nextUpFor(series, userId, { resumable, firstEpisode }) {
    const w = W();
    const eps = episodesUnder(series);
    let last = -1;
    eps.forEach((e, i) => {
      if (w.userData.get(userId + ':' + e.Id)?.Played) last = i;
    });
    if (last < 0) {
      if (!firstEpisode) return null;
      const e = eps[0];
      const u = w.userData.get(userId + ':' + e.Id);
      if (u?.PlaybackPositionTicks > 0 && !resumable) return null;
      return e;
    }
    const next = eps.slice(last + 1).find((e) => !w.userData.get(userId + ':' + e.Id)?.Played);
    if (!next) return null;
    if (!resumable && w.userData.get(userId + ':' + next.Id)?.PlaybackPositionTicks > 0) return null;
    return next;
  }
  function lastPlayed(series, userId) {
    return episodesUnder(series).reduce((m, e) => {
      const d = W().userData.get(userId + ':' + e.Id)?.LastPlayedDate || '';
      return d > m ? d : m;
    }, '');
  }

  /* ---------------- routes ---------------- */
  r.add('GET', '/System/Info/Public', () => ({
    LocalAddress: srv.urls.jf, ServerName: W().serverName, Version: W().version, ProductName: 'Jellyfin Server', OperatingSystem: '', Id: W().serverId, StartupWizardCompleted: true
  }));

  const userDto = (u) => ({
    Name: u.Name, ServerId: W().serverId, Id: u.Id, HasPassword: u.HasPassword, HasConfiguredPassword: u.HasPassword, HasConfiguredEasyPassword: false,
    EnableAutoLogin: false, LastLoginDate: u.LastLoginDate, LastActivityDate: u.LastLoginDate, ...(u.hasImage ? { PrimaryImageTag: gid('userimg', u.Id).slice(0, 16) } : {}),
    Configuration: { AudioLanguagePreference: '', PlayDefaultAudioTrack: true, SubtitleLanguagePreference: '', DisplayMissingEpisodes: false, SubtitleMode: 'Default', EnableNextEpisodeAutoPlay: true, RememberAudioSelections: true, RememberSubtitleSelections: true },
    Policy: { IsAdministrator: !!u.admin, IsDisabled: false, EnableMediaPlayback: true, EnableAllFolders: true, AuthenticationProviderId: 'Default', PasswordResetProviderId: 'Default' }
  });

  function authResult(u, ctx) {
    const token = randomBytes(16).toString('hex');
    W().tokens.set(token, { userId: u.Id, deviceId: ctx.auth?.DeviceId, client: ctx.auth?.Client, device: ctx.auth?.Device });
    return {
      User: userDto(u),
      SessionInfo: { Id: gid('session', token), UserId: u.Id, UserName: u.Name, Client: ctx.auth?.Client, DeviceName: ctx.auth?.Device, DeviceId: ctx.auth?.DeviceId, ApplicationVersion: ctx.auth?.Version, IsActive: true, ServerId: W().serverId },
      AccessToken: token,
      ServerId: W().serverId
    };
  }

  r.add('POST', '/Users/AuthenticateByName', (ctx) => {
    const b = ctx.body || {};
    const u = [...W().users.values()].find((x) => x.Name.toLowerCase() === String(b.Username || '').toLowerCase());
    if (!u || (u.password || '') !== (b.Pw || '')) return ctx.status(401, 'Error processing request.');
    return authResult(u, ctx);
  });

  /* the signed-in user — what reel-api's guard asks with a Token-only header */
  r.add('GET', '/Users/Me', (ctx) => {
    const u = ctx.userId && W().users.get(ctx.userId);
    return u ? userDto(u) : ctx.status(401, 'Unauthorized');
  });

  r.add('GET', '/Users/{userId}', (ctx) => {
    const u = W().users.get(ctx.params.userId.toLowerCase());
    return u ? userDto(u) : ctx.status(404, 'User not found');
  });

  r.add('GET,HEAD', '/UserImage', (ctx) => {
    const u = W().users.get((ctx.q('userId') || '').toLowerCase());
    if (!u || !u.hasImage) return ctx.status(404, 'Image not found');
    return ctx.image(png(160, 160, 'user' + u.Id));
  });

  r.add('POST', '/Sessions/Logout', (ctx) => {
    W().tokens.delete(ctx.token);
    return ctx.status(204);
  });

  /* Quick Connect: a test approves a code with srv.approveQuickConnect(code, user). */
  r.add('GET', '/QuickConnect/Enabled', () => W().quickConnectEnabled);
  r.add('POST', '/QuickConnect/Initiate', (ctx) => {
    if (!W().quickConnectEnabled) return ctx.status(401, 'Quick connect is disabled');
    const secret = randomBytes(32).toString('hex');
    const code = String(100000 + (parseInt(secret.slice(0, 8), 16) % 900000));
    const st = { Secret: secret, Code: code, DeviceId: ctx.auth?.DeviceId, DeviceName: ctx.auth?.Device, AppName: ctx.auth?.Client, AppVersion: ctx.auth?.Version, DateAdded: iso(Date.now()), Authenticated: false, userId: null };
    W().quickConnect.set(secret, st);
    const { userId, ...pub } = st;
    return pub;
  });
  r.add('GET', '/QuickConnect/Connect', (ctx) => {
    const st = W().quickConnect.get(ctx.q('secret') || '');
    if (!st) return ctx.status(404, 'Unknown secret');
    const { userId, ...pub } = st;
    return pub;
  });
  r.add('POST', '/Users/AuthenticateWithQuickConnect', (ctx) => {
    const st = W().quickConnect.get(ctx.body?.Secret || '');
    if (!st || !st.Authenticated) return ctx.status(401, 'Quick connect not authorized');
    W().quickConnect.delete(st.Secret);
    return authResult(W().users.get(st.userId), ctx);
  });

  /* ---- items ---- */
  r.add('GET', '/Items', (ctx) => queryItems(ctx));

  /* A bare `return NotFound();` in an [ApiController] (UserLibraryController.GetItem)
   * answers ASP.NET Core's ProblemDetails, not a text body. */
  const problem404 = (ctx) => ctx.raw(404, JSON.stringify({ type: 'https://tools.ietf.org/html/rfc9110#section-15.5.5', title: 'Not Found', status: 404, traceId: '00-' + randomBytes(16).toString('hex') + '-' + randomBytes(8).toString('hex') + '-00' }), 'application/problem+json; charset=utf-8');

  r.add('GET', '/Items/{itemId}', (ctx) => {
    const it = W().items.get(ctx.params.itemId.toLowerCase());
    if (!it) return problem404(ctx);
    return dto(it, ctx.userId, { fields: 'all' });
  });

  r.add('GET', '/Items/Latest', (ctx) => {
    const types = (ctx.q('includeItemTypes') || 'Movie,Episode').split(',').map((s) => s.toLowerCase());
    let list = [...W().items.values()].filter((it) => types.includes(it.Type.toLowerCase()));
    list.sort((a, b) => ((b.DateLastMediaAdded || b.DateCreated) > (a.DateLastMediaAdded || a.DateCreated) ? 1 : -1));
    list = list.slice(0, Number(ctx.q('limit') || 20));
    return list.map((it) => dto(it, ctx.userId, listOpts(ctx)));
  });

  r.add('GET', '/UserItems/Resume', (ctx) => {
    const w = W();
    let list = [...w.items.values()].filter((it) => it.MediaType === 'Video').filter((it) => {
      const u = w.userData.get(ctx.userId + ':' + it.Id);
      return u && u.PlaybackPositionTicks > 0 && !u.Played;
    });
    const types = ctx.q('includeItemTypes');
    if (types) list = list.filter((it) => types.toLowerCase().split(',').includes(it.Type.toLowerCase()));
    list.sort((a, b) => ((w.userData.get(ctx.userId + ':' + b.Id).LastPlayedDate || '') > (w.userData.get(ctx.userId + ':' + a.Id).LastPlayedDate || '') ? 1 : -1));
    return page(ctx, list);
  });

  r.add('GET', '/Shows/NextUp', (ctx) => {
    const w = W();
    const sid = ctx.q('seriesId');
    const series = sid ? [w.items.get(sid.toLowerCase())].filter(Boolean) : w.list('Series');
    const opts = { resumable: ctx.qb('enableResumable', true), firstEpisode: !!sid && !ctx.qb('disableFirstEpisode', false) };
    const picks = series
      .map((s) => ({ s, e: nextUpFor(s, ctx.userId, opts), d: lastPlayed(s, ctx.userId) }))
      .filter((x) => x.e)
      .sort((a, b) => (b.d > a.d ? 1 : -1))
      .map((x) => x.e);
    return page(ctx, picks);
  });

  r.add('GET', '/Shows/{seriesId}/Seasons', (ctx) => {
    const s = W().items.get(ctx.params.seriesId.toLowerCase());
    if (!s || s.Type !== 'Series') return ctx.status(404, 'Series not found');
    const list = s.childIds.map((id) => W().items.get(id));
    return { Items: list.map((it) => dto(it, ctx.userId, listOpts(ctx))), TotalRecordCount: list.length, StartIndex: 0 };
  });

  r.add('GET', '/Shows/{seriesId}/Episodes', (ctx) => {
    const w = W();
    const s = w.items.get(ctx.params.seriesId.toLowerCase());
    if (!s || s.Type !== 'Series') return ctx.status(404, 'Series not found');
    let list = episodesUnder(s);
    const seasonId = ctx.q('seasonId');
    const season = ctx.q('season');
    if (seasonId) list = list.filter((e) => e.SeasonId === seasonId.toLowerCase());
    else if (season != null) list = list.filter((e) => e.ParentIndexNumber === Number(season));
    const start = ctx.q('startItemId');
    if (start) {
      const i = list.findIndex((e) => e.Id === start.toLowerCase());
      list = i >= 0 ? list.slice(i) : [];
    }
    return page(ctx, list);
  });

  r.add('GET', '/Items/{itemId}/Similar', (ctx) => {
    const it = W().items.get(ctx.params.itemId.toLowerCase());
    if (!it) return ctx.status(404, 'Item not found');
    const list = [...W().items.values()].filter((x) => x.Type === it.Type && x.Id !== it.Id && (x.Genres || []).some((g) => (it.Genres || []).includes(g)));
    return page(ctx, list.slice(0, Number(ctx.q('limit') || 12)));
  });

  r.add('GET', '/Genres', (ctx) => {
    const types = (ctx.q('includeItemTypes') || 'Movie,Series').toLowerCase().split(',');
    const names = new Set();
    for (const it of W().items.values()) if (types.includes(it.Type.toLowerCase())) for (const g of it.Genres || []) names.add(g);
    const list = [...names].sort().map((n) => ({ Name: n, ServerId: W().serverId, Id: gid('genre', n), Type: 'Genre', IsFolder: false, ImageTags: {}, BackdropImageTags: [] }));
    return { Items: list, TotalRecordCount: list.length, StartIndex: 0 };
  });

  /* ---- user data ---- */
  function setUd(ctx, it, patch) {
    const k = ctx.userId + ':' + it.Id;
    const cur = W().userData.get(k) || { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false };
    W().userData.set(k, { ...cur, ...patch });
  }
  function markPlayed(ctx, played) {
    const it = W().items.get(ctx.params.itemId.toLowerCase());
    if (!it) return ctx.status(404, 'Item not found');
    const targets = it.childIds ? episodesUnder(it) : [it];
    for (const t of targets.concat(it.childIds ? [it] : [])) {
      setUd(ctx, t, played ? { Played: true, PlayCount: (W().userData.get(ctx.userId + ':' + t.Id)?.PlayCount || 0) + 1, PlaybackPositionTicks: 0, LastPlayedDate: iso(Date.now()) } : { Played: false, PlaybackPositionTicks: 0 });
    }
    srv.events.push({ kind: played ? 'played' : 'unplayed', itemId: it.Id, userId: ctx.userId });
    return userDataOf(ctx.userId, it);
  }
  r.add('POST', '/UserPlayedItems/{itemId}', (ctx) => markPlayed(ctx, true));
  r.add('DELETE', '/UserPlayedItems/{itemId}', (ctx) => markPlayed(ctx, false));

  r.add('GET', '/UserItems/{itemId}/UserData', (ctx) => {
    const it = W().items.get(ctx.params.itemId.toLowerCase());
    return it ? userDataOf(ctx.userId, it) : ctx.status(404, 'Item not found');
  });
  r.add('POST', '/UserItems/{itemId}/UserData', (ctx) => {
    const it = W().items.get(ctx.params.itemId.toLowerCase());
    if (!it) return ctx.status(404, 'Item not found');
    const b = ctx.body || {};
    const patch = {};
    for (const k of ['PlaybackPositionTicks', 'Played', 'PlayCount', 'LastPlayedDate', 'IsFavorite']) if (k in b) patch[k] = b[k];
    setUd(ctx, it, patch);
    srv.events.push({ kind: 'userdata', itemId: it.Id, userId: ctx.userId, patch });
    return userDataOf(ctx.userId, it);
  });

  /* ---- playback ---- */
  r.add('POST', '/Items/{itemId}/PlaybackInfo', (ctx) => {
    const it = W().items.get(ctx.params.itemId.toLowerCase());
    if (!it || !it.MediaSources) return ctx.status(404, 'Item not found');
    const b = ctx.body || {};
    const sess = gid('play', it.Id, Date.now(), Math.random());
    const profile = b.DeviceProfile || {};
    const dp = (profile.DirectPlayProfiles || []).some((p) => !p.Container || p.Container.split(',').includes('mkv') || p.Container.split(',').includes('matroska'));
    /* A subtitle the profile can't deliver (no SubtitleProfile for its format,
     * e.g. VobSub on the TV) has to be burned in: Jellyfin answers with an HLS
     * TranscodingUrl built from the profile's Video TranscodingProfile, or with
     * no playable source when the profile has none (StreamBuilder's
     * SubtitleDeliveryMethod.Encode → TranscodeReason.SubtitleCodecNotSupported). */
    const subFmt = (c) => ({ subrip: 'srt', dvd_subtitle: 'dvdsub', vobsub: 'dvdsub', dvb_subtitle: 'dvbsub', hdmv_pgs_subtitle: 'pgssub', webvtt: 'vtt' })[String(c || '').toLowerCase()] || String(c || '').toLowerCase();
    const canDeliver = (st) => (profile.SubtitleProfiles || []).some((p) => subFmt(p.Format) === subFmt(st.Codec) && p.Method !== 'Encode');
    const vtp = (profile.TranscodingProfiles || []).find((p) => p.Type === 'Video');
    const sources = it.MediaSources.map((ms) => {
      const s = structuredClone(ms);
      const sub = b.SubtitleStreamIndex >= 0 && (!b.MediaSourceId || b.MediaSourceId === ms.Id) ? ms.MediaStreams.find((x) => x.Type === 'Subtitle' && x.Index === b.SubtitleStreamIndex) : null;
      if (sub && !canDeliver(sub) && dp && b.EnableDirectPlay !== false) {
        s.SupportsDirectPlay = false;
        s.SupportsDirectStream = false;
        if (vtp) {
          const container = vtp.Container || 'ts';
          s.TranscodingUrl = `/videos/${it.Id}/master.m3u8?DeviceId=${encodeURIComponent(ctx.auth?.DeviceId || '')}&MediaSourceId=${ms.Id}&VideoCodec=${vtp.VideoCodec || 'h264'}&AudioCodec=${vtp.AudioCodec || 'aac'}&AudioStreamIndex=${b.AudioStreamIndex ?? 1}&VideoBitrate=8000000&SubtitleStreamIndex=${sub.Index}&SubtitleMethod=Encode&PlaySessionId=${sess}&ApiKey=${ctx.token}&SegmentContainer=${container}&MinSegments=${vtp.MinSegments || 1}&BreakOnNonKeyFrames=${vtp.BreakOnNonKeyFrames ? 'True' : 'False'}&TranscodeReasons=SubtitleCodecNotSupported`;
          s.TranscodingSubProtocol = vtp.Protocol || 'hls';
          s.TranscodingContainer = container;
        }
        return s;
      }
      if (!dp || b.EnableDirectPlay === false) {
        s.SupportsDirectPlay = false;
        s.TranscodingUrl = `/videos/${it.Id}/master.m3u8?DeviceId=${encodeURIComponent(ctx.auth?.DeviceId || '')}&MediaSourceId=${ms.Id}&VideoCodec=hevc,h264&AudioCodec=eac3,ac3,aac&VideoStreamIndex=0&AudioStreamIndex=${b.AudioStreamIndex ?? 1}&PlaySessionId=${sess}&ApiKey=${ctx.token}&SegmentContainer=mp4&TranscodeReasons=ContainerNotSupported`;
        s.TranscodingSubProtocol = 'hls';
        s.TranscodingContainer = 'mp4';
      }
      return s;
    });
    W().playSessions.set(sess, { itemId: it.Id, userId: ctx.userId, body: b });
    srv.events.push({ kind: 'playbackinfo', itemId: it.Id, body: b });
    return { MediaSources: sources, PlaySessionId: sess };
  });

  /* Dynamic HLS (EXTRA_ROUTES): the playlists a transcode would serve, built
   * from the TranscodingUrl's own query. No transcoder runs here: segments
   * answer 404 (noted), so a client that loads one only gets as far as the
   * playlists — enough to pin the URLs it asks for. */
  const hlsQuery = (ctx) => ctx.url.search.slice(1);
  r.add('GET', '/Videos/{itemId}/master.m3u8', (ctx) => {
    const it = W().items.get(ctx.params.itemId.toLowerCase());
    if (!it || !it.MediaSources) return ctx.status(404, 'Item not found');
    const v = it.MediaSources[0].MediaStreams.find((x) => x.Type === 'Video');
    return ctx.raw(200, `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8192000,AVERAGE-BANDWIDTH=8192000,RESOLUTION=${v.Width}x${v.Height}\nmain.m3u8?${hlsQuery(ctx)}\n`, 'application/vnd.apple.mpegurl');
  });
  r.add('GET', '/Videos/{itemId}/main.m3u8', (ctx) => {
    const it = W().items.get(ctx.params.itemId.toLowerCase());
    if (!it || !it.MediaSources) return ctx.status(404, 'Item not found');
    const dur = it.RunTimeTicks / TICKS;
    const ext = (ctx.q('SegmentContainer') || 'ts').toLowerCase();
    const lines = ['#EXTM3U', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-VERSION:' + (ext === 'mp4' ? 7 : 3), '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:0'];
    if (ext === 'mp4') lines.push(`#EXT-X-MAP:URI="hls1/main/-1.mp4?${hlsQuery(ctx)}"`);
    for (let i = 0, t = 0; t < dur; i++, t += 6) lines.push(`#EXTINF:${Math.min(6, dur - t).toFixed(6)}, nodesc`, `hls1/main/${i}.${ext}?${hlsQuery(ctx)}`);
    lines.push('#EXT-X-ENDLIST', '');
    return ctx.raw(200, lines.join('\n'), 'application/vnd.apple.mpegurl');
  });
  r.add('GET', '/Videos/{itemId}/hls1/{playlistId}/{segmentId}.{segmentContainer}', (ctx) => {
    ctx.note('fake serves no transcoded HLS segments (/Videos/{id}/hls1/…)');
    return ctx.status(404, 'no transcoder in the fixture');
  });

  r.add('GET,HEAD', '/Videos/{itemId}/stream.{container}', (ctx) => ctx.video());
  r.add('GET,HEAD', '/Videos/{itemId}/stream', (ctx) => ctx.video());

  r.add('GET', '/Videos/{routeItemId}/{routeMediaSourceId}/Subtitles/{routeIndex}/{routeStartPositionTicks}/Stream.{routeFormat}', (ctx) => {
    const fmt = ctx.params.routeFormat.toLowerCase();
    // one cue every 10 s, on the fixture video's burned-in clock (server/media.mjs)
    if (fmt === 'vtt') return ctx.raw(200, srv.media.vtt, 'text/vtt');
    return ctx.status(404, 'fixture has no ' + fmt + ' subtitles');
  });

  r.add('GET', '/Videos/{itemId}/Trickplay/{width}/{index}.jpg', (ctx) => {
    if ([...ctx.query.keys()].some((k) => k === 'api_key')) {
      ctx.violation('Trickplay with legacy api_key= (12.1 answers 401; use ApiKey=)');
      return ctx.status(401, 'Unauthorized');
    }
    // sheets cut from the fixture video, 10×10 tiles of 320×180 (server/media.mjs);
    // an index past the fixture's hour wraps — still a full sheet of the seeded grid
    const sheets = srv.media.sheets;
    if (!sheets) {
      ctx.note('no trickplay sheets (ffmpeg missing?)');
      return ctx.status(404, 'no trickplay sheets');
    }
    if (!/^\d+$/.test(ctx.params.index)) return ctx.status(404, 'no such sheet');
    if (ctx.params.width !== '320') return ctx.status(404, 'no trickplay at width ' + ctx.params.width);
    return ctx.file(sheets[Number(ctx.params.index) % sheets.length], 'image/jpeg');
  });

  r.add('GET', '/MediaSegments/{itemId}', (ctx) => {
    const segs = W().segments.get(ctx.params.itemId.toLowerCase()) || [];
    const types = ctx.q('includeSegmentTypes');
    const list = types ? segs.filter((s) => types.split(',').includes(s.Type)) : segs;
    return { Items: list, TotalRecordCount: list.length, StartIndex: 0 };
  });

  function report(kind) {
    return (ctx) => {
      const b = ctx.body || {};
      W().sessions.push({ kind, at: Date.now(), userId: ctx.userId, body: b });
      const it = b.ItemId && W().items.get(String(b.ItemId).toLowerCase());
      if (it && kind === 'progress' && typeof b.PositionTicks === 'number') {
        // SessionManager.OnPlaybackProgress stores the reported position as it is
        setUd(ctx, it, { PlaybackPositionTicks: b.PositionTicks, LastPlayedDate: iso(Date.now()) });
      } else if (it && kind === 'stopped') {
        // OnPlaybackStopped → UserDataManager.UpdatePlayState with the server defaults
        // MinResumePct 5, MaxResumePct 90, MinResumeDurationSeconds 300; a Stopped
        // without a position counts as played to the end
        const run = it.RunTimeTicks || 0;
        let pos = typeof b.PositionTicks === 'number' ? b.PositionTicks : run;
        let done = false;
        if (pos > 0 && run > 0) {
          const pct = (pos / run) * 100;
          if (pct < 5) pos = 0;
          else if (pct > 90 || pos >= run - TICKS) (pos = 0), (done = true);
          else if (run / TICKS < 300) (pos = 0), (done = true);
        } else if (!run) (pos = 0), (done = true);
        const cur = W().userData.get(ctx.userId + ':' + it.Id);
        if (done) setUd(ctx, it, { Played: true, PlaybackPositionTicks: 0, PlayCount: (cur?.PlayCount || 0) + 1, LastPlayedDate: iso(Date.now()) });
        else setUd(ctx, it, { PlaybackPositionTicks: pos, LastPlayedDate: iso(Date.now()) });
      }
      return ctx.status(204);
    };
  }
  r.add('POST', '/Sessions/Playing', report('start'));
  r.add('POST', '/Sessions/Playing/Progress', report('progress'));
  r.add('POST', '/Sessions/Playing/Stopped', report('stopped'));
  r.add('POST', '/Sessions/Playing/Ping', (ctx) => ctx.status(204));
  r.add('DELETE', '/Videos/ActiveEncodings', (ctx) => {
    srv.events.push({ kind: 'stopEncoding', deviceId: ctx.q('deviceId'), playSessionId: ctx.q('playSessionId') });
    return ctx.status(204);
  });

  /* ---- images ---- */
  function image(ctx) {
    const it = W().items.get(ctx.params.itemId.toLowerCase());
    if (!it) return ctx.status(404, 'Item not found');
    const type = ctx.params.imageType;
    const wide = type === 'Backdrop' || type === 'Thumb' || (type === 'Primary' && it.Type === 'Episode');
    const has = type === 'Backdrop' ? it.BackdropImageTags?.length : it.ImageTags?.[type] || (type === 'Thumb' && it.ParentThumbImageTag);
    if (!has) return ctx.status(404, 'Image not found');
    // the requested box decides the pixel size, capped small: layout is CSS's job
    const mw = Number(ctx.q('maxWidth') || ctx.q('fillWidth') || 0), mh = Number(ctx.q('maxHeight') || ctx.q('fillHeight') || 0);
    let w = wide ? 480 : 200, h = wide ? 270 : 300;
    if (it.Type === 'Person') h = 200;
    if (mw && mw < w) (h = Math.round((h * mw) / w)), (w = mw);
    else if (mh && mh < h) (w = Math.round((w * mh) / h)), (h = mh);
    const key = it.Id + type + w + 'x' + h;
    if (!imgCache.has(key)) imgCache.set(key, png(w, h, it.Id + type));
    return ctx.image(imgCache.get(key));
  }
  r.add('GET,HEAD', '/Items/{itemId}/Images/{imageType}', image);
  r.add('GET,HEAD', '/Items/{itemId}/Images/{imageType}/{imageIndex}', image);

  return {
    router: r,
    dto,
    anonymous(pathname, op) {
      if (op !== undefined) return !op?.security;
      return ANON.some((re) => re.test(pathname));
    }
  };
}

export { TICKS };
