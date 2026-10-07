/* Fake fidelity: direct HTTP (no browser) pins the fake Jellyfin's query engine
 * and play-state rules to Jellyfin 12.1's documented behaviour, so a scenario
 * that passes against the fake would pass against the real server for the same
 * reason. Every request still goes through the 12.1 spec validation (a violation
 * fails the test).
 *
 * Sources for the rules (Jellyfin server, 12.x):
 *  - DtoService: optional ItemFields only when asked; EnableUserData/EnableImages;
 *    UserLibraryController.GetItem returns every field, a missing item → bare
 *    NotFound() → ASP.NET Core ProblemDetails.
 *  - TVSeriesManager.GetNextUp: per series the episode after the last played one
 *    (by season/episode order), series ordered by last played date; with
 *    EnableResumable=false a next episode that has a position is left out; a
 *    never-watched series only shows up when asked for by SeriesId.
 *  - UserDataManager.UpdatePlayState on Stopped: MinResumePct 5 (below → no
 *    position), MaxResumePct 90 (above → played, position 0), runtime under
 *    MinResumeDurationSeconds 300 → played; Progress stores the raw position.
 *  - /UserPlayedItems on a folder (season/series) marks every episode under it.
 *  - /Shows/{id}/Episodes StartItemId: SkipWhile(id != start) across seasons.
 *  - Genres is a pipe-delimited list (PipeDelimitedCollectionModelBinder);
 *    Filters/IncludeItemTypes are comma lists. */
import { test, assert } from '../lib/runner.mjs';
import { TICKS, createWorld } from '../server/seed.mjs';
import { ep, movie, setPlayed, setPosition, addPending, landImport } from '../lib/world.mjs';

const AUTH = 'MediaBrowser Client="Reel", Device="LG webOS TV", DeviceId="fidelity", Version="0.1.0"';

function client(srv, user = 'alice') {
  const s = srv.issueToken(user);
  const H = { Authorization: AUTH + `, Token="${s.token}"` };
  const call = async (method, path, body) => {
    const before = srv.violations.length;
    const r = await fetch(srv.urls.jf + path, { method, headers: { ...H, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    const v = srv.violations.slice(before).map((x) => x.msg);
    assert.deepEqual(v, [], `${method} ${path}: spec violations`);
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: r.status, type: r.headers.get('content-type') || '', text, json };
  };
  const get = async (path) => {
    const r = await call('GET', path);
    assert.equal(r.status, 200, 'GET ' + path + ' → ' + r.status + ' ' + r.text.slice(0, 120));
    return r.json;
  };
  return { uid: s.userId, call, get };
}

const names = (r) => r.Items.map((i) => (i.SeriesName ? `${i.SeriesName} S${i.ParentIndexNumber}E${i.IndexNumber}` : i.Name));

test('fake fidelity: Fields / EnableUserData / EnableImages projection; GET /Items/{id} is complete; 404s', { app: 'none', fast: true }, async (t) => {
  const { srv } = t;
  const w = srv.world;
  const { uid, call, get } = client(srv);
  const m = w.list('Movie')[0];

  let r = await get(`/Items?userId=${uid}&Ids=${m.Id}`);
  let it = r.Items[0];
  for (const f of ['Overview', 'Genres', 'MediaSources', 'ProviderIds', 'People', 'MediaStreams', 'DateCreated', 'SortName']) assert(!(f in it), `optional ${f} absent unless asked`);
  for (const f of ['Id', 'Name', 'Type', 'RunTimeTicks', 'ImageTags', 'UserData']) assert(f in it, `base ${f} present`);

  r = await get(`/Items?userId=${uid}&Ids=${m.Id}&Fields=Overview,Genres,ProviderIds`);
  it = r.Items[0];
  assert.deepEqual(['Overview', 'Genres', 'ProviderIds'].filter((f) => f in it), ['Overview', 'Genres', 'ProviderIds'], 'asked fields present');
  assert(!('MediaSources' in it) && !('People' in it), 'only the asked ones');

  r = await get(`/Items?userId=${uid}&Ids=${m.Id}&EnableUserData=false&EnableImages=false`);
  it = r.Items[0];
  assert(!('UserData' in it), 'EnableUserData=false drops UserData');
  assert(!('ImageTags' in it) && !('BackdropImageTags' in it), 'EnableImages=false drops image tags');

  it = await get(`/Items/${m.Id}?userId=${uid}`);
  for (const f of ['Overview', 'Genres', 'MediaSources', 'ProviderIds', 'People', 'MediaStreams', 'UserData']) assert(f in it, `GET /Items/{id} carries ${f}`);

  const missing = await call('GET', `/Items/${'0'.repeat(32)}?userId=${uid}`);
  assert.equal(missing.status, 404);
  assert(/^application\/problem\+json/.test(missing.type), 'ProblemDetails content type: ' + missing.type);
  assert.equal(missing.json?.title, 'Not Found');
  assert.equal(missing.json?.status, 404);
});

test('fake fidelity: Resume order, NextUp rules (EnableResumable, SeriesId first episode), Episodes StartItemId, Genres pipes, IsUnplayed for series, paging', { app: 'none', fast: true }, async (t) => {
  const { srv } = t;
  const w = srv.world;
  const { uid, get } = client(srv);

  // Resume: newest LastPlayedDate first, only positions > 0 that aren't played
  let r = await get(`/UserItems/Resume?userId=${uid}&Limit=10&MediaTypes=Video`);
  const resume = r.Items.map((i) => i.Id);
  const dates = resume.map((id) => w.userData.get(uid + ':' + id).LastPlayedDate);
  assert.deepEqual(dates, dates.slice().sort().reverse(), 'Resume sorted by LastPlayedDate desc');
  assert.equal(r.TotalRecordCount, 3);
  assert.equal(resume[0], ep(w, 'Northern Line', 1, 3).Id, 'the episode played an hour ago leads');
  r = await get(`/UserItems/Resume?userId=${uid}&IncludeItemTypes=Movie`);
  assert(r.Items.every((i) => i.Type === 'Movie') && r.Items.length === 2, 'IncludeItemTypes=Movie');

  // NextUp: by last played series; NL's next (S1E3) has a position → only with EnableResumable
  r = await get(`/Shows/NextUp?userId=${uid}&Limit=20`);
  assert.deepEqual(names(r), ['Northern Line S1E3', 'Paper Kingdom S2E1', 'Electric Orchard S1E5'], 'NextUp default (resumable included)');
  r = await get(`/Shows/NextUp?userId=${uid}&Limit=20&EnableResumable=false`);
  assert.deepEqual(names(r), ['Paper Kingdom S2E1', 'Electric Orchard S1E5'], 'EnableResumable=false leaves out a next episode with a position');
  // a never-watched series: absent from the global list, its first episode when asked by SeriesId
  const vel = w.byName('Series', 'Velvet Archive');
  assert(!names(r).some((n) => n.startsWith('Velvet Archive')), 'unwatched series not in NextUp');
  r = await get(`/Shows/NextUp?userId=${uid}&SeriesId=${vel.Id}`);
  assert.deepEqual(names(r), ['Velvet Archive S1E1'], 'SeriesId → first episode');
  // the next one after the HIGHEST played episode, even with an earlier gap
  const pk = 'Paper Kingdom';
  setPlayed(w, uid, ep(w, pk, 1, 3), false);
  setPlayed(w, uid, ep(w, pk, 2, 2), true, { agoMs: w.now - Date.now() });
  r = await get(`/Shows/NextUp?userId=${uid}&SeriesId=${w.byName('Series', pk).Id}`);
  assert.deepEqual(names(r), ['Paper Kingdom S2E3'], 'after the last played (S2E2), not the gap (S1E3)');

  // Episodes StartItemId crosses seasons; an unknown id yields nothing
  const nl = w.byName('Series', 'Northern Line');
  r = await get(`/Shows/${nl.Id}/Episodes?userId=${uid}&StartItemId=${ep(w, 'Northern Line', 1, 8).Id}&Limit=2&IsMissing=false`);
  assert.deepEqual(names(r), ['Northern Line S1E8', 'Northern Line S2E1'], 'StartItemId + Limit=2 rolls into the next season');
  r = await get(`/Shows/${nl.Id}/Episodes?userId=${uid}&StartItemId=${'1'.repeat(32)}`);
  assert.equal(r.Items.length, 0, 'unknown StartItemId → empty');

  // Genres: pipe-delimited union; a comma is part of the name
  const has = (g) => w.list('Series').filter((s) => s.Genres.includes(g)).length;
  r = await get(`/Items?userId=${uid}&Recursive=true&IncludeItemTypes=Series&Genres=${encodeURIComponent('Comedy|Thriller')}`);
  assert.equal(r.TotalRecordCount, has('Comedy') + has('Thriller'), 'Genres=Comedy|Thriller is a union');
  r = await get(`/Items?userId=${uid}&Recursive=true&IncludeItemTypes=Series&Genres=${encodeURIComponent('Comedy,Thriller')}`);
  assert.equal(r.TotalRecordCount, 0, 'Genres=Comedy,Thriller is one (unknown) genre');

  // Filters=IsUnplayed for series: by the series' own Played (all episodes watched)
  const eo = w.byName('Series', 'Electric Orchard');
  r = await get(`/Items?userId=${uid}&Recursive=true&IncludeItemTypes=Series&Filters=IsUnplayed`);
  assert.equal(r.TotalRecordCount, w.list('Series').length, 'no series fully watched yet');
  for (const id of w.items.get(eo.childIds[0]).childIds) setPlayed(w, uid, id);
  r = await get(`/Items?userId=${uid}&Recursive=true&IncludeItemTypes=Series&Filters=IsUnplayed`);
  assert(!r.Items.some((i) => i.Id === eo.Id), 'a fully watched series is not IsUnplayed');
  assert.equal(r.TotalRecordCount, w.list('Series').length - 1);

  // paging: StartIndex/Limit slice, TotalRecordCount is the whole match
  const all = await get(`/Items?userId=${uid}&Recursive=true&IncludeItemTypes=Movie&SortBy=SortName&SortOrder=Ascending`);
  const page2 = await get(`/Items?userId=${uid}&Recursive=true&IncludeItemTypes=Movie&SortBy=SortName&SortOrder=Ascending&StartIndex=126&Limit=126`);
  assert.equal(page2.TotalRecordCount, all.TotalRecordCount);
  assert.equal(page2.StartIndex, 126);
  assert.deepEqual(page2.Items.map((i) => i.Id), all.Items.slice(126).map((i) => i.Id), 'second page = the rest');
});

test('fake fidelity: play state — Stopped applies MinResumePct 5 / MaxResumePct 90 / MinResumeDuration 300 s, Progress stores raw; UserPlayedItems on a season marks every episode', { app: 'none', fast: true }, async (t) => {
  const { srv } = t;
  const w = srv.world;
  const { uid, call, get } = client(srv);
  const m = w.list('Movie')[30];
  const run = m.RunTimeTicks;
  const ud = () => w.userData.get(uid + ':' + m.Id) || {};
  const report = async (kind, pos) => {
    // PlaybackStopInfo has no CanSeek/IsPaused/PlayMethod (the spec check would flag them)
    const body = { ItemId: m.Id, MediaSourceId: m.Id, PlaySessionId: 'fid', ...(kind === 'Stopped' ? {} : { CanSeek: true, IsPaused: false, IsMuted: false, PlayMethod: 'DirectPlay' }) };
    if (pos != null) body.PositionTicks = pos;
    const r = await call('POST', '/Sessions/Playing' + (kind === 'start' ? '' : '/' + kind), body);
    assert.equal(r.status, 204, kind + ' → 204');
  };

  await report('start', 0);
  await report('Progress', Math.round(run * 0.02));
  assert.equal(ud().PlaybackPositionTicks, Math.round(run * 0.02), 'Progress stores the raw position (even < 5 %)');
  await report('Stopped', Math.round(run * 0.02));
  assert.equal(ud().PlaybackPositionTicks, 0, 'Stopped < 5 % → no resume point');
  assert(!ud().Played, 'and not played');

  await report('Stopped', Math.round(run * 0.5));
  assert.equal(ud().PlaybackPositionTicks, Math.round(run * 0.5), 'Stopped at 50 % → resume point');
  assert.equal((await get(`/UserItems/Resume?userId=${uid}&Limit=50`)).Items[0].Id, m.Id, 'and it leads Continue Watching');

  await report('Stopped', Math.round(run * 0.9));
  assert(!ud().Played && ud().PlaybackPositionTicks === Math.round(run * 0.9), 'exactly 90 % is still a resume point (> MaxResumePct marks played)');
  const pc = ud().PlayCount || 0;
  await report('Stopped', Math.round(run * 0.93));
  assert(ud().Played && ud().PlaybackPositionTicks === 0, 'Stopped > 90 % → played, position cleared');
  assert.equal(ud().PlayCount, pc + 1, 'PlayCount + 1');

  // a Stopped without a position = played to the end
  const m2 = w.list('Movie')[31];
  const r2 = await call('POST', '/Sessions/Playing/Stopped', { ItemId: m2.Id, MediaSourceId: m2.Id, PlaySessionId: 'fid2' });
  assert.equal(r2.status, 204);
  assert.equal(w.userData.get(uid + ':' + m2.Id)?.Played, true, 'no PositionTicks → played');

  // shorter than 5 min: any position past 5 % is "watched"
  const short = w.list('Movie')[32];
  short.RunTimeTicks = 200 * TICKS;
  await call('POST', '/Sessions/Playing/Stopped', { ItemId: short.Id, MediaSourceId: short.Id, PlaySessionId: 'fid3', PositionTicks: 60 * TICKS });
  assert.equal(w.userData.get(uid + ':' + short.Id)?.Played, true, 'under MinResumeDurationSeconds → played');

  // a season: POST marks every episode, the series' UserData follows; DELETE unmarks
  const hs = w.byName('Series', 'The Hollow Signal');
  const s2 = w.items.get(hs.childIds[1]);
  let r = await call('POST', `/UserPlayedItems/${s2.Id}?userId=${uid}`);
  assert.equal(r.status, 200);
  assert(s2.childIds.every((id) => w.userData.get(uid + ':' + id)?.Played), 'every episode of the season played');
  assert.equal(r.json.Played, true, 'the season answers Played');
  let sr = await get(`/Items/${hs.Id}?userId=${uid}`);
  const total = hs.childIds.reduce((n, sid) => n + w.items.get(sid).childIds.length, 0);
  assert.equal(sr.UserData.UnplayedItemCount, total - s2.childIds.length, 'series UnplayedItemCount follows');
  r = await call('DELETE', `/UserPlayedItems/${s2.Id}?userId=${uid}`);
  assert.equal(r.status, 200);
  assert(s2.childIds.every((id) => !w.userData.get(uid + ':' + id)?.Played), 'DELETE unmarks the season');
  sr = await get(`/Items/${hs.Id}?userId=${uid}`);
  assert.equal(sr.UserData.UnplayedItemCount, total);
});

test('fake fidelity: seed presets (empty, big) are deterministic; world helpers (setPosition, addPending + probe, landImport) keep the served shapes valid', { app: 'none', fast: true, seed: { preset: 'empty' } }, async (t) => {
  const { srv } = t;
  const w = srv.world;
  const { uid, get } = client(srv);
  const ids = (o) => [...createWorld(o).items.keys()].join();

  // determinism: same ids (and order) on every build of a preset
  assert.equal(ids({ preset: 'empty' }), ids({ preset: 'empty' }), 'empty is deterministic');
  const big = createWorld({ preset: 'big' });
  const bigMovies = big.list('Movie');
  assert.equal(bigMovies.length, 400, 'big: 400 movies');
  assert.equal(new Set(bigMovies.map((m) => m.Name)).size, 400, 'big: 400 distinct names (" II" past 360)');
  assert.equal(big.ml.charts['top-movie'].sections[0].entries.length, 250, 'big: a full Top 250');
  assert.equal(ids({ preset: 'big' }), [...big.items.keys()].join(), 'big is deterministic');
  assert.equal(createWorld().list('Movie')[0].Id, bigMovies[0].Id, 'presets keep the default ids of what they share');

  // empty: no play state, no activity, no news
  assert.equal(w.userData.size, 0, 'no UserData for anyone');
  let r = await get(`/UserItems/Resume?userId=${uid}&MediaTypes=Video&Limit=12`);
  assert.equal(r.Items.length, 0, 'nothing to resume');
  r = await get(`/Shows/NextUp?userId=${uid}&Limit=20`);
  assert.equal(r.Items.length, 0, 'no Next Up');
  const ml = async (p) => {
    const res = await fetch(srv.urls.ml + p, { headers: srv.mlAuth() });
    assert.equal(res.status, 200, 'GET ' + p);
    return res.json();
  };
  assert.equal((await ml('/api/activity')).items.length, 0, 'empty activity feed');
  assert.equal((await ml('/api/news')).items.length, 0, 'no news');

  // setPosition → Resume
  const m = movie(w, 'The Silent Harbor');
  setPosition(w, 'alice', m, 1200);
  r = await get(`/UserItems/Resume?userId=${uid}&MediaTypes=Video&Limit=12`);
  assert.deepEqual(r.Items.map((i) => [i.Id, i.UserData.PlaybackPositionTicks]), [[m.Id, 1200 * TICKS]], 'setPosition makes a resume point');

  // addPending (+ probe) → /api/activity and the probe route; tv with metadata listing
  const a = addPending(w, { type: 'movie', media_id: '900002', progress: 0.3, probe: true });
  const feed = await ml('/api/activity');
  assert.deepEqual(feed.items.map((x) => [x.id, x.status, x.progress]), [[a.id, 'downloading', 0.3]], 'the grab is in the feed');
  const probe = await ml(`/api/downloads/${a.download_id}/probe`);
  assert.equal(probe.video.codec, 'h264', 'the probe answers for its download_id');
  const e = addPending(w, { type: 'tv', media_id: w.byName('Series', 'Northern Line').ProviderIds.Tvdb, season: 4, episode: 2, status: 'queued', listInMetadata: true });
  assert.equal(e.subtitle, 'S04E02', 'tv subtitle');
  assert.equal(e.download_id, null, 'a queued grab has no download yet');

  // landImport: the grab leaves, Jellyfin gains the title with matching ProviderIds
  const mv = landImport(w, a.id);
  assert(!w.ml.activity.includes(a), 'the movie grab left the feed');
  r = await get(`/Items?userId=${uid}&Ids=${mv.Id}&Fields=ProviderIds`);
  assert.deepEqual([r.Items[0].Name, r.Items[0].ProviderIds.Tmdb], ['Iron Tide', '900002'], 'the landed movie, by tmdb id');
  const ne = landImport(w, e.id);
  r = await get(`/Shows/${ne.SeriesId}/Episodes?userId=${uid}&Season=4`);
  assert.deepEqual(r.Items.map((i) => `S${i.ParentIndexNumber}E${i.IndexNumber}`), ['S4E2'], 'the landed episode in a new Season 4');
  r = await get(`/Shows/${ne.SeriesId}/Seasons?userId=${uid}`);
  assert.equal(r.Items.at(-1).IndexNumber, 4, 'Season 4 listed');
});
