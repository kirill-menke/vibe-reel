/* Self-tests of the oracle itself: the fake server's 12.1 request validation
 * must catch the classes of breakage CLAUDE.md documents, and must stay quiet
 * for the requests the apps actually make. No browser. */
import http from 'node:http';
import { test, assert } from '../lib/runner.mjs';
import { tvPlaybackInfo, phonePlaybackInfo, offlinePlaybackInfo, baseReport, offlineUserData } from '../lib/bodies.mjs';
import { WARM_HINT } from '../scripts/reelapi-spec.mjs';

const AUTH = 'MediaBrowser Client="Reel", Device="LG webOS TV", DeviceId="oracle", Version="0.1.0"';

async function call(srv, method, path, { headers = {}, body, origin = 'jf' } = {}) {
  const before = srv.violations.length;
  const r = await fetch(srv.urls[origin] + path, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined
  });
  await r.arrayBuffer();
  return { status: r.status, violations: srv.violations.slice(before).map((v) => v.msg) };
}

test('oracle: spec validation catches the documented 12.x breakages', { app: 'none', fast: true, allowViolations: [/./] }, async (t) => {
  const { srv } = t;
  if (!srv.spec) {
    t.skip('Jellyfin 12.1 spec not cached (node e2e/scripts/fetch-spec.mjs)');
    return;
  }
  const s = srv.issueToken('alice');
  const H = { Authorization: AUTH + `, Token="${s.token}"` };
  const item = srv.world.list('Movie')[0].Id;
  const ep = srv.world.list('Episode')[0].Id;

  // 1. the legacy auth header: 400 "request.App" and a violation
  let r = await call(srv, 'GET', `/Items/${item}?userId=${s.userId}`, { headers: { 'X-Emby-Authorization': AUTH + `, Token="${s.token}"` } });
  assert.equal(r.status, 400, 'X-Emby-Authorization status');
  assert(r.violations.some((v) => /X-Emby-Authorization/.test(v)), 'X-Emby-Authorization flagged: ' + r.violations);

  // 2. api_key on Trickplay: 401 + violation; ApiKey works
  r = await call(srv, 'GET', `/Videos/${ep}/Trickplay/320/0.jpg?MediaSourceId=${ep}&api_key=${s.token}`);
  assert.equal(r.status, 401, 'Trickplay api_key status');
  assert(r.violations.some((v) => /api_key/.test(v)), 'api_key flagged: ' + r.violations);
  r = await call(srv, 'GET', `/Videos/${ep}/Trickplay/320/0.jpg?MediaSourceId=${ep}&ApiKey=${s.token}`);
  assert.equal(r.status, 200, 'Trickplay ApiKey status');
  assert.deepEqual(r.violations, [], 'Trickplay ApiKey violations');

  // 3. routes removed in 10.9+/12.1
  for (const p of [`/Users/${s.userId}/Images/Primary`, `/Users/${s.userId}/Items/${item}`, `/Users/${s.userId}/Items/Resume`, `/Users/${s.userId}/Views`]) {
    r = await call(srv, 'GET', p, { headers: H });
    assert(r.violations.some((v) => /unknown route/.test(v)), 'removed route flagged: ' + p + ' → ' + r.violations);
  }
  r = await call(srv, 'POST', `/Users/${s.userId}/PlayedItems/${item}`, { headers: H });
  assert(r.violations.some((v) => /unknown route/.test(v)), 'PlayedItems flagged: ' + r.violations);

  // 4. wrong method, unknown query param, bad enum, bad uuid, bad body property
  r = await call(srv, 'PUT', `/UserPlayedItems/${item}?userId=${s.userId}`, { headers: H });
  assert(r.violations.some((v) => /method PUT not allowed/.test(v)), 'method flagged: ' + r.violations);
  r = await call(srv, 'GET', `/Items?userId=${s.userId}&Recursive=true&IncludeItemTypes=Movie&SortBy=Popularity`, { headers: H });
  assert(r.violations.some((v) => /SortBy.*not one of/.test(v)), 'bad SortBy flagged: ' + r.violations);
  r = await call(srv, 'GET', `/Items?userId=${s.userId}&Recursive=true&Fields=Overveiw`, { headers: H });
  assert(r.violations.some((v) => /Fields.*not one of/.test(v)), 'typo in Fields flagged: ' + r.violations);
  r = await call(srv, 'GET', `/Items?userId=${s.userId}&Recursive=true&NoSuchParam=1`, { headers: H });
  assert(r.violations.some((v) => /unknown query param 'NoSuchParam'/.test(v)), 'unknown param flagged: ' + r.violations);
  r = await call(srv, 'GET', `/Items/undefined?userId=${s.userId}`, { headers: H });
  assert(r.violations.some((v) => /itemId="undefined" is not a uuid/.test(v)), '/Items/undefined flagged: ' + r.violations);
  r = await call(srv, 'POST', '/Users/AuthenticateByName', { headers: { Authorization: AUTH }, body: { Username: 'alice', Password: 'x' } });
  assert(r.violations.some((v) => /body\.Password not in schema/.test(v)), 'bad body property flagged: ' + r.violations);

  // 5. an Authorization header missing the client identity — and no token to take it from
  r = await call(srv, 'GET', `/Users/${s.userId}`, { headers: { Authorization: 'MediaBrowser Client="Reel"' } });
  assert.equal(r.status, 400, 'identity-less header status');
  assert(r.violations.some((v) => /lacks Device, DeviceId, Version/.test(v)), 'missing identity flagged: ' + r.violations);
  // …while `Token="<valid>"` alone is fine on 12.1 (measured 2026-10-05: the token's own
  // session supplies Client/Device; reel-api's guard asks /Users/Me exactly so)
  r = await call(srv, 'GET', '/Users/Me', { headers: { Authorization: `MediaBrowser Token="${s.token}"` } });
  assert.equal(r.status, 200, 'Token-only /Users/Me status');
  assert.deepEqual(r.violations, [], 'Token-only header violations');
  r = await call(srv, 'GET', '/Users/Me', { headers: { Authorization: 'MediaBrowser Token="not-a-token"' } });
  assert.equal(r.status, 401, 'Token-only with an unknown token');
  r = await call(srv, 'GET', '/Users/Me', { headers: { 'X-Emby-Token': s.token } });
  assert.equal(r.status, 401, 'X-Emby-Token alone (12.1: 401)');

  // 6. reel-api: unknown route is a violation
  r = await call(srv, 'GET', '/api/no-such-thing', { origin: 'ml', headers: srv.mlAuth() });
  assert(r.violations.some((v) => /unknown reel-api route/.test(v)), 'unknown reel-api route flagged');
});

test('oracle: the requests the apps make validate cleanly', { app: 'none', fast: true }, async (t) => {
  const { srv } = t;
  const s = srv.issueToken('alice');
  const H = { Authorization: AUTH + `, Token="${s.token}"` };
  const u = s.userId;
  const movie = srv.world.list('Movie')[0];
  const series = srv.world.byName('Series', 'Northern Line');
  const ep = srv.world.list('Episode')[0];
  const ok = [
    `/Users/${u}`,
    `/UserItems/Resume?userId=${u}&Limit=16&MediaTypes=Video&Fields=Overview,Genres,MediaSources,UserData,PremiereDate,ProductionYear,RunTimeTicks,CommunityRating,OfficialRating,SeriesName,IndexNumber,ParentIndexNumber&EnableImageTypes=Primary,Backdrop,Thumb`,
    `/Shows/NextUp?UserId=${u}&Limit=16&EnableResumable=false&EnableRewatching=false`,
    `/Items?userId=${u}&IncludeItemTypes=Movie&Recursive=true&SortBy=DateCreated,SortName&SortOrder=Descending,Ascending&Fields=UserData,ProductionYear,PremiereDate,MediaSources,ProviderIds&StartIndex=0&Limit=126`,
    `/Items?userId=${u}&IncludeItemTypes=Movie&Recursive=true&Genres=Drama&Filters=IsUnplayed`,
    `/Items/${movie.Id}?userId=${u}`,
    `/Shows/${series.Id}/Seasons?UserId=${u}&Fields=UserData,ChildCount`,
    `/Shows/${series.Id}/Episodes?SeasonId=${series.childIds[0]}&UserId=${u}&Fields=Overview&EnableImageTypes=Primary,Thumb`,
    `/Genres?UserId=${u}&IncludeItemTypes=Movie&SortBy=SortName`,
    `/MediaSegments/${ep.Id}`,
    `/Items/${movie.Id}/Similar?userId=${u}&Limit=12`,
    `/Items/${movie.Id}/Images/Primary?tag=x&quality=85&maxHeight=480`,
    `/UserImage?userId=${u}&maxHeight=96&quality=90`
  ];
  for (const p of ok) {
    const r = await call(srv, 'GET', p, { headers: H });
    assert(r.status < 400, `${p} → HTTP ${r.status}`);
    assert.deepEqual(r.violations, [], 'violations for ' + p);
  }
  // Fields elements that name always-present properties are a recorded known deviation, not a violation
  if (srv.spec) assert(srv.known.size > 0, 'known deviation recorded for Fields=UserData');
});

/* E2E-01: request bodies are validated recursively (DeviceProfile's profile
 * arrays and their Conditions, play reports, UserData), with Jellyfin's own
 * binding rules (case-insensitive names, enum names, numbers from strings). */
test('oracle: nested request bodies — the apps’ bodies pass, each mis-shaped one is caught', { app: 'none', fast: true, allowViolations: [/./] }, async (t) => {
  const { srv } = t;
  if (!srv.spec) {
    t.skip('Jellyfin 12.1 spec not cached — body validation not checked');
    return;
  }
  const s = srv.issueToken('alice');
  const H = { Authorization: AUTH + `, Token="${s.token}"` };
  const u = s.userId;
  const movie = srv.world.list('Movie')[0].Id;
  const ep = srv.world.list('Episode')[0].Id;
  const post = (path, body) => call(srv, 'POST', path, { headers: H, body });
  const clean = async (what, path, body) => {
    const r = await post(path, body);
    assert.deepEqual(r.violations, [], 'violations for ' + what);
    assert(r.status < 400, `${what} → HTTP ${r.status}`);
  };

  // ---- positive: the exact shapes the apps send ----
  await clean('TV PlaybackInfo (DirectPlay, resume)', `/Items/${movie}/PlaybackInfo`, tvPlaybackInfo(u, { resumeSec: 754.2 }));
  await clean('TV PlaybackInfo (burn-in: hls TranscodingProfile, string MinSegments)', `/Items/${movie}/PlaybackInfo`, tvPlaybackInfo(u, { burn: true, sourceId: movie }));
  const knownBefore = srv.known.size;
  await clean('phone PlaybackInfo (8 Mbit/s cap, AV1, boxed Conditions)', `/Items/${ep}/PlaybackInfo`, phonePlaybackInfo(u, { sourceId: ep, cap: 8000000, av1: true }));
  assert([...srv.known].some((k) => /deviceprofile-responseprofiles/.test(k)) && srv.known.size > knownBefore, 'phone ResponseProfiles recorded as the known deviation (F-005)');
  await clean('phone offline PlaybackInfo (4 Mbit/s)', `/Items/${ep}/PlaybackInfo`, offlinePlaybackInfo(u, { sourceId: ep, bitrate: 4000000 }));
  await clean('Sessions/Playing', '/Sessions/Playing', baseReport(movie));
  await clean('Sessions/Playing/Progress', '/Sessions/Playing/Progress', { ...baseReport(movie, { method: 'Transcode', sub: 3 }), IsPaused: true });
  const b = baseReport(movie);
  await clean('Sessions/Playing/Stopped', '/Sessions/Playing/Stopped', { ItemId: b.ItemId, MediaSourceId: b.MediaSourceId, PlaySessionId: b.PlaySessionId, PositionTicks: b.PositionTicks });
  await clean('Stopped of a restarted session', '/Sessions/Playing/Stopped', { ItemId: movie, MediaSourceId: movie, PlaySessionId: 'old', PositionTicks: 12340000 });
  await clean('offline UserData sync', `/UserItems/${ep}/UserData?userId=${u}`, offlineUserData());
  await clean('lower-case property names bind (System.Text.Json is case-insensitive)', '/Sessions/Playing/Progress', { itemId: movie, positionTicks: 5, isPaused: false, playMethod: 'directplay' });

  // ---- negative: one per schema, each must be caught at its path ----
  const bad = [
    ['PlaybackInfoDto: bool for an int', `/Items/${movie}/PlaybackInfo`, { ...tvPlaybackInfo(u), MaxStreamingBitrate: true }, /body\.MaxStreamingBitrate=true should be an integer/],
    ['PlaybackInfoDto: int32 overflow', `/Items/${movie}/PlaybackInfo`, { ...tvPlaybackInfo(u), MaxStreamingBitrate: 4000000000 }, /body\.MaxStreamingBitrate=4000000000 overflows int32/],
    ['DeviceProfile: unknown top-level property', `/Items/${movie}/PlaybackInfo`, mut(tvPlaybackInfo(u), (x) => (x.DeviceProfile.Identification = {})), /body\.DeviceProfile\.Identification not in schema/],
    ['DirectPlayProfile: unknown nested name', `/Items/${movie}/PlaybackInfo`, mut(tvPlaybackInfo(u), (x) => (x.DeviceProfile.DirectPlayProfiles[0].VideoCodecs = 'h264')), /body\.DeviceProfile\.DirectPlayProfiles\[0\]\.VideoCodecs not in schema/],
    ['DirectPlayProfile: bad DlnaProfileType', `/Items/${movie}/PlaybackInfo`, mut(tvPlaybackInfo(u), (x) => (x.DeviceProfile.DirectPlayProfiles[1].Type = 'Music')), /DirectPlayProfiles\[1\]\.Type="Music" not one of Audio\|Video/],
    ['TranscodingProfile: bad Protocol enum', `/Items/${movie}/PlaybackInfo`, mut(tvPlaybackInfo(u, { burn: true, sourceId: movie }), (x) => (x.DeviceProfile.TranscodingProfiles[0].Protocol = 'dash')), /TranscodingProfiles\[0\]\.Protocol="dash" not one of http\|hls/],
    ['TranscodingProfile: non-numeric MinSegments', `/Items/${movie}/PlaybackInfo`, mut(tvPlaybackInfo(u, { burn: true, sourceId: movie }), (x) => (x.DeviceProfile.TranscodingProfiles[0].MinSegments = 'one')), /TranscodingProfiles\[0\]\.MinSegments="one" should be an integer/],
    ['SubtitleProfile: bad delivery Method', `/Items/${movie}/PlaybackInfo`, mut(tvPlaybackInfo(u), (x) => (x.DeviceProfile.SubtitleProfiles[4].Method = 'Sidecar')), /SubtitleProfiles\[4\]\.Method="Sidecar" not one of/],
    ['CodecProfile.Conditions[]: bad ProfileConditionValue (3 levels deep)', `/Items/${ep}/PlaybackInfo`, mut(phonePlaybackInfo(u, { sourceId: ep }), (x) => (x.DeviceProfile.CodecProfiles[1].Conditions[1].Property = 'VideoRange')), /CodecProfiles\[1\]\.Conditions\[1\]\.Property="VideoRange" not one of/],
    ['CodecProfile.Conditions[]: string for IsRequired', `/Items/${ep}/PlaybackInfo`, mut(phonePlaybackInfo(u, { sourceId: ep }), (x) => (x.DeviceProfile.CodecProfiles[0].Conditions[0].IsRequired = 'false')), /Conditions\[0\]\.IsRequired="false" should be a boolean/],
    ['CodecProfile: Conditions not an array', `/Items/${ep}/PlaybackInfo`, mut(phonePlaybackInfo(u, { sourceId: ep }), (x) => (x.DeviceProfile.CodecProfiles[2].Conditions = { Condition: 'Equals' })), /CodecProfiles\[2\]\.Conditions=.* should be an array/],
    ['PlaybackStartInfo: bad PlayMethod', '/Sessions/Playing', { ...baseReport(movie), PlayMethod: 'DirectPlayy' }, /body\.PlayMethod="DirectPlayy" not one of Transcode\|DirectStream\|DirectPlay/],
    ['PlaybackProgressInfo: bad RepeatMode', '/Sessions/Playing/Progress', { ...baseReport(movie), RepeatMode: 'RepeatEverything' }, /body\.RepeatMode="RepeatEverything" not one of RepeatNone/],
    ['PlaybackProgressInfo: object for a string', '/Sessions/Playing/Progress', { ...baseReport(movie), PlaySessionId: { id: 1 } }, /body\.PlaySessionId=.* should be a string/],
    ['PlaybackStopInfo: a start-only property', '/Sessions/Playing/Stopped', { ...baseReport(movie) }, /body\.IsPaused not in schema/],
    ['PlaybackStopInfo: ItemId not a uuid', '/Sessions/Playing/Stopped', { ItemId: 'undefined', PositionTicks: 1 }, /body\.ItemId="undefined" is not a uuid/],
    ['UpdateUserItemDataDto: string for a bool', `/UserItems/${ep}/UserData?userId=${u}`, { ...offlineUserData(), Played: 'true' }, /body\.Played="true" should be a boolean/],
    ['UpdateUserItemDataDto: bad date-time', `/UserItems/${ep}/UserData?userId=${u}`, { ...offlineUserData(), LastPlayedDate: 'yesterday' }, /body\.LastPlayedDate="yesterday" is not a date-time/],
    ['UpdateUserItemDataDto: unknown name', `/UserItems/${ep}/UserData?userId=${u}`, { ...offlineUserData(), PositionTicks: 5 }, /body\.PositionTicks not in schema/]
  ];
  for (const [what, path, body, re] of bad) {
    const r = await post(path, body);
    assert(r.violations.some((v) => re.test(v)), `${what}: not caught (${re}); got ${JSON.stringify(r.violations)}`);
  }
  t.log(`${bad.length} mis-shaped bodies caught`);
});

function mut(x, fn) {
  fn(x);
  return x;
}

/* E2E-02: the reel-api contract comes from the backend's own FastAPI OpenAPI
 * (e2e/scripts/reelapi-spec.mjs). Every fake route answers in the shape
 * models.py declares; a fake that drifts, or a client request off the
 * contract, is a violation. */
test('oracle: reel-api contract — every fake route answers per models.py; drift and bad requests are caught', { app: 'none', fast: true, allowViolations: [/./] }, async (t) => {
  const { srv } = t;
  if (!srv.reelSpec) {
    if (process.env.E2E_ALLOW_NO_REEL_SPEC === '1') return t.skip('reel-api spec absent, allowed by E2E_ALLOW_NO_REEL_SPEC=1');
    throw new Error('reel-api spec absent — ' + WARM_HINT);
  }
  // the untyped routes ({} in the OpenAPI) carry the backend's documented shapes
  for (const [m, tpl] of [['GET', '/api/downloads/{gid}/probe'], ['GET', '/api/trailers/{key}'], ['POST', '/api/trailers/{key}'], ['GET', '/api/push/config'], ['GET', '/api/downloads/{gid}/hls']]) {
    assert(srv.reelSpec.documented(m, tpl), `no documented shape for ${m} ${tpl} in the dumped spec (x-documented)`);
  }
  const ML = srv.world.ml;
  const nl = srv.world.byName('Series', 'Northern Line');
  const hs = srv.world.byName('Series', 'The Hollow Signal');
  // a fresh token per call: srv.reset() below drops the issued ones
  const ml = (method, path, body) => call(srv, method, path, { origin: 'ml', body, headers: srv.mlAuth() });
  const clean = async (method, path, body, status) => {
    const r = await ml(method, path, body);
    assert.deepEqual(r.violations, [], `violations for ${method} ${path}`);
    if (status) assert.equal(r.status, status, `${method} ${path} status`);
    else assert(r.status < 300, `${method} ${path} → HTTP ${r.status}`);
    return r;
  };

  // ---- positive: every route the fake implements, with seeded data ----
  await clean('GET', '/api/activity');
  await clean('GET', '/api/lookup?q=harbor&type=movie');
  await clean('GET', '/api/lookup?q=paper&type=tv');
  await clean('GET', '/api/metadata/movie/900001');
  await clean('GET', '/api/metadata/tv/400002');
  await clean('GET', '/api/trending?type=movie');
  await clean('GET', '/api/trending?type=tv');
  await clean('GET', '/api/charts');
  for (const key of Object.keys(ML.charts)) await clean('GET', '/api/charts/' + key);
  await clean('GET', '/api/collection/7001');
  await clean('GET', '/api/news');
  await clean('GET', '/api/segments/tt8000000/1/3');
  await clean('GET', '/api/downloads/' + 'a'.repeat(40) + '/probe');
  await clean('HEAD', '/api/downloads/' + 'a'.repeat(40) + '/stream');
  await clean('GET', '/api/trailers/ytFixture01');
  await clean('POST', '/api/trailers/ytFixture01');
  await clean('GET', '/api/push/config');
  // untyped routes, checked against their documented shapes: a ready trailer, a live HLS job
  srv.world.ml.trailers.set('ytFixture02', { title: 'Fixture | Trailer' });
  await clean('POST', '/api/trailers/ytFixture02');
  await clean('GET', '/api/trailers/ytFixture02');
  srv.world.ml.liveHls.set('a'.repeat(40), { probing: 1 });
  await clean('POST', '/api/downloads/' + 'a'.repeat(40) + '/hls?audio=1');
  await clean('GET', '/api/downloads/' + 'a'.repeat(40) + '/hls?audio=1');
  srv.reset();
  // writes: add → undo, season search → undo, cancel a grab
  const add = await fetch(srv.urls.ml + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json', ...srv.mlAuth() }, body: JSON.stringify({ id: '900003', type: 'movie' }) });
  assert.equal(add.status, 202, 'library add status');
  const { undo } = await add.json();
  await clean('DELETE', `/api/library/movie/900003?undo=${undo}`);
  const ss = await fetch(srv.urls.ml + '/api/news/search', { method: 'POST', headers: { 'Content-Type': 'application/json', ...srv.mlAuth() }, body: JSON.stringify({ id: hs.ProviderIds.Tvdb, season: 5 }) });
  assert.equal(ss.status, 202, 'season search status');
  await clean('DELETE', '/api/news/search/' + (await ss.json()).undo);
  await clean('DELETE', `/api/activity/tv/${nl.ProviderIds.Tvdb}?season=3&episode=7`);
  assert.deepEqual(srv.violations.map((v) => v.msg), [], 'no violations from the write round trips');

  // ---- negative: the fake drifting from models.py ----
  const drift = [
    ['activity item missing `status` (required)', (w) => delete w.ml.activity[0].status, '/api/activity', /fake reel-api response GET \/api\/activity → 200: body\.items\[0\]\.status required/],
    ['activity item with a property ActivityItem lacks', (w) => (w.ml.activity[1].eta = 5), '/api/activity', /body\.items\[1\]\.eta not in schema/],
    ['progress as a string', (w) => (w.ml.activity[0].progress = '0.43'), '/api/activity', /body\.items\[0\]\.progress="0\.43" should be a number/],
    ['null where the model is not Optional', (w) => (w.ml.activity[2].title = null), '/api/activity', /body\.items\[2\]\.title is null but not nullable/],
    ['news season as a string', (w) => (w.ml.news[0].season = '5'), '/api/news', /body\.items\[0\]\.season="5" should be an integer/],
    // untyped routes ({} in the OpenAPI): the documented shapes (backend/tests/support/documented.py)
    ['probe video without its index', (w) => delete w.ml.probes['a'.repeat(40)].video.index, '/api/downloads/' + 'a'.repeat(40) + '/probe', /probe → 200: body\.video\.index required/],
    ['probe hdr outside DV|HDR10|HLG', (w) => (w.ml.probes['a'.repeat(40)].video.hdr = 'HDR'), '/api/downloads/' + 'a'.repeat(40) + '/probe', /body\.video\.hdr="HDR" not one of DV\|HDR10\|HLG/],
    ['probe audio with an extra key', (w) => (w.ml.probes['a'.repeat(40)].audio[0].bitrate = 768000), '/api/downloads/' + 'a'.repeat(40) + '/probe', /body\.audio\[0\]\.bitrate not in schema/],
    ['probe size_bytes as a string', (w) => (w.ml.probes['a'.repeat(40)].size_bytes = '8400000000'), '/api/downloads/' + 'a'.repeat(40) + '/probe', /body\.size_bytes="8400000000" should be an integer/]
  ];
  // the trailer / push answers are built in the handler: check drifted bodies against the shape directly
  const tid = '/api/trailers/ytFixture01';
  const okTrailer = { id: 'ytFixture01', state: 'ready', segments: 3, buffered_s: 30, duration: 30, complete: true, width: 320, height: 180, vcodec: 'vp9', codecs: 'vp09.00.10.08,opus', hdr: null, subs: null, subs_done: true, title: null, error: null };
  assert.deepEqual(srv.reelSpec.validateResponse('GET', tid, 200, okTrailer), [], 'a trailer status as trailers.py writes it');
  const shapeDrift = [
    ['trailer status without subs_done', 'GET', tid, (({ subs_done, ...x }) => x)(okTrailer), /body\.subs_done required/],
    ['trailer hdr as a boolean', 'GET', tid, { ...okTrailer, hdr: false }, /body\.hdr=false should be a string/],
    ['trailer state off the enum', 'POST', tid, { ...okTrailer, state: 'done' }, /body\.state="done" not one of/],
    ['push config enabled as a string', 'GET', '/api/push/config', { enabled: 'no', key: null }, /body\.enabled="no" should be a boolean/],
    ['hls video as a string', 'GET', '/api/downloads/' + 'a'.repeat(40) + '/hls', { id: 'a', audio: 1, state: 'remuxing', segments: 3, buffered_s: 30, duration: 60, complete: false, codecs: 'x', video: 'copy', audio_codec: 'aac', progress: null, error: null }, /body\.video="copy" should be an object/]
  ];
  for (const [what, method, path, body, re] of shapeDrift) {
    const v = srv.reelSpec.validateResponse(method, path, 200, body);
    assert(v.some((x) => re.test(x)), `${what}: not caught (${re}); got ${JSON.stringify(v)}`);
  }
  // an untyped JSON route with no documented shape is itself a violation
  const bare = new (srv.reelSpec.constructor)({ ...srv.reelSpec.doc, 'x-documented': {} });
  assert(bare.validateResponse('GET', '/api/push/config', 200, { enabled: false, key: null }).some((x) => /declares no response model and has no documented shape/.test(x)), 'an undocumented untyped route passes');
  for (const [what, mutate, path, re] of drift) {
    srv.reset();
    mutate(srv.world);
    const r = await ml('GET', path);
    assert(r.violations.some((v) => re.test(v)), `${what}: not caught (${re}); got ${JSON.stringify(r.violations)}`);
  }
  srv.reset();

  // ---- negative: a client request off the contract ----
  const bad = [
    ['unknown query param', 'GET', '/api/trending?type=tv&limit=5', undefined, /unknown query param 'limit'/],
    ['path param pattern (imdb id)', 'GET', '/api/segments/8000000/1/3', undefined, /path param imdb_id="8000000" does not match/],
    ['path param range', 'GET', '/api/segments/tt8000000/1/9999', undefined, /path param episode="9999" is above 5000/],
    ['required query param missing', 'GET', '/api/lookup?type=tv', undefined, /required query param 'q' missing/],
    ['body: a number for a str field (pydantic v2 refuses it)', 'POST', '/api/library', { id: 900004, type: 'movie' }, /body\.id=900004 should be a string/],
    ['body: required field missing', 'POST', '/api/news/search', { id: hs.ProviderIds.Tvdb }, /body\.season required/],
    ['route the backend does not have', 'GET', '/api/library', undefined, /route not in reel-api's OpenAPI|method GET not allowed/]
  ];
  for (const [what, method, path, body, re] of bad) {
    const r = await ml(method, path, body);
    assert(r.violations.some((v) => re.test(v)), `${what}: not caught (${re}); got ${JSON.stringify(r.violations)}`);
  }
  t.log(`${drift.length + shapeDrift.length} drifted fake responses and ${bad.length} off-contract requests caught`);
});

/* The fake reel-api enforces the real request guard (backend security.py):
 * a client path that forgets the token fails its scenario. */
test('oracle: reel-api guard — every route but /health and push/unsubscribe wants a known token, in any transport; Host and Origin checked', { app: 'none', fast: true, allowViolations: [/./] }, async (t) => {
  const { srv } = t;
  const s = srv.issueToken('alice');
  const ml = (method, path, opts = {}) => call(srv, method, path, { origin: 'ml', ...opts });
  const guarded = (r) => r.violations.filter((v) => /reel-api guard/.test(v));

  // no token: 401 and a violation, on every kind of route
  for (const [method, path] of [['GET', '/api/activity'], ['GET', '/api/trending?type=tv'], ['GET', '/api/push/config'], ['POST', '/api/push/subscribe'], ['HEAD', '/api/downloads/' + 'a'.repeat(40) + '/stream'], ['DELETE', '/api/downloads/' + 'a'.repeat(40)], ['POST', '/api/trailers/ytFixture01']]) {
    const r = await ml(method, path);
    assert.equal(r.status, 401, `${method} ${path} without a token`);
    assert(guarded(r).some((v) => /no Jellyfin token/.test(v)), `${method} ${path}: not flagged: ${r.violations}`);
  }
  // every transport the real guard reads
  const transports = {
    mediabrowser: { headers: { Authorization: `MediaBrowser Token="${s.token}"` } },
    'mediabrowser + identity': { headers: { Authorization: AUTH + `, Token="${s.token}"` } },
    emby: { headers: { Authorization: `Emby Token="${s.token}"` } },
    bearer: { headers: { Authorization: `Bearer ${s.token}` } },
    'x-emby-token': { headers: { 'X-Emby-Token': s.token } },
    'x-mediabrowser-token': { headers: { 'X-MediaBrowser-Token': s.token } },
    api_key: { query: `?api_key=${s.token}` },
    'empty Token= then api_key': { headers: { Authorization: 'MediaBrowser Token=""' }, query: `?api_key=${s.token}` }
  };
  for (const [name, o] of Object.entries(transports)) {
    const r = await ml('GET', '/api/activity' + (o.query || ''), { headers: o.headers || {} });
    assert.equal(r.status, 200, name);
    assert.deepEqual(r.violations, [], name + ' violations');
  }
  // a token Jellyfin doesn't know: 401, but not a client bug
  let r = await ml('GET', '/api/activity', { headers: { Authorization: 'MediaBrowser Token="revoked-token"' } });
  assert.equal(r.status, 401, 'unknown token');
  assert.deepEqual(guarded(r), [], 'unknown token is no violation');
  // the open routes
  r = await ml('GET', '/health');
  assert.deepEqual(guarded(r), [], 'GET /health is open');
  r = await ml('POST', '/api/push/unsubscribe', { body: { endpoint: 'https://push.example/x' } });
  assert(r.status !== 401, 'POST /api/push/unsubscribe is open: ' + r.status);
  assert.deepEqual(guarded(r), [], 'unsubscribe is open');
  // Host / Origin (node's fetch can't set Host: a raw request)
  const raw = (headers) => new Promise((resolve, reject) => {
    const before = srv.violations.length;
    const req = http.request(srv.urls.ml + '/api/activity', { headers: { Authorization: `MediaBrowser Token="${s.token}"`, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, violations: srv.violations.slice(before).map((v) => v.msg) }));
    });
    req.on('error', reject);
    req.end();
  });
  r = await raw({ Host: 'evil.example' });
  assert.equal(r.status, 403, 'a rebinding Host');
  assert(r.violations.some((v) => /Host "evil.example" refused/.test(v)), 'Host flagged: ' + r.violations);
  r = await raw({ Host: 'localhost:8790' });
  assert.equal(r.status, 200, 'localhost');
  r = await raw({ Origin: 'https://evil.example' });
  assert.equal(r.status, 403, 'a cross-site Origin');
  assert(r.violations.some((v) => /Origin https:\/\/evil.example refused/.test(v)), 'Origin flagged: ' + r.violations);
  for (const origin of ['null', 'file://', 'http://127.0.0.1:9']) {
    r = await raw({ Origin: origin });
    assert.equal(r.status, 200, 'Origin ' + origin);
  }
});

/* E2E-03: the fake Jellyfin's own answers fit 12.1's response schemas — every
 * implemented JSON route, with the seed's richest items (MediaSources with
 * streams, People, Chapters, UserData, Trickplay). */
test('oracle: fake Jellyfin responses conform to the 12.1 response schemas', { app: 'none', fast: true, allowViolations: [/./] }, async (t) => {
  const { srv } = t;
  if (!srv.spec) {
    t.skip('Jellyfin 12.1 spec not cached — response validation not checked');
    return;
  }
  const s = srv.issueToken('alice');
  const H = { Authorization: AUTH + `, Token="${s.token}"` };
  const u = s.userId;
  const W = srv.world;
  const movie = W.list('Movie')[0];
  const series = W.byName('Series', 'Northern Line');
  const season = series.childIds[0];
  const ep = W.list('Episode')[0];
  const get = (p) => call(srv, 'GET', p, { headers: H });
  const post = (p, body, headers = H) => call(srv, 'POST', p, { headers, body });
  const clean = async (what, r) => {
    r = await r;
    assert.deepEqual(r.violations.filter((v) => /^fake response/.test(v)), [], 'fake response violations for ' + what);
    assert.deepEqual(r.violations, [], 'violations for ' + what);
    assert(r.status < 300, `${what} → HTTP ${r.status}`);
  };
  const F = 'Overview,Genres,MediaSources,MediaStreams,People,Chapters,Trickplay,ProviderIds,Studios,Taglines,ChildCount,RecursiveItemCount';
  await clean('System/Info/Public', call(srv, 'GET', '/System/Info/Public'));
  await clean('AuthenticateByName', post('/Users/AuthenticateByName', { Username: 'alice', Pw: 'alice-pw' }, { Authorization: AUTH }));
  await clean('Users/{id}', get(`/Users/${u}`));
  await clean('QuickConnect/Enabled', call(srv, 'GET', '/QuickConnect/Enabled'));
  await clean('Items (movies, every Field)', get(`/Items?userId=${u}&IncludeItemTypes=Movie&Recursive=true&Fields=${F}&Limit=40`));
  await clean('Items (series)', get(`/Items?userId=${u}&IncludeItemTypes=Series&Recursive=true&Fields=${F}`));
  await clean('Items/{movie}', get(`/Items/${movie.Id}?userId=${u}`));
  await clean('Items/{series}', get(`/Items/${series.Id}?userId=${u}`));
  await clean('Items/{episode}', get(`/Items/${ep.Id}?userId=${u}`));
  await clean('Items/Latest', get(`/Items/Latest?userId=${u}&Limit=16&Fields=${F}`));
  await clean('UserItems/Resume', get(`/UserItems/Resume?userId=${u}&Limit=16&MediaTypes=Video&Fields=${F}`));
  await clean('Shows/NextUp', get(`/Shows/NextUp?UserId=${u}&Limit=16&Fields=${F}`));
  await clean('Shows/Seasons', get(`/Shows/${series.Id}/Seasons?UserId=${u}&Fields=UserData,ChildCount`));
  await clean('Shows/Episodes', get(`/Shows/${series.Id}/Episodes?SeasonId=${season}&UserId=${u}&Fields=${F}`));
  await clean('Similar', get(`/Items/${movie.Id}/Similar?userId=${u}&Limit=12&Fields=${F}`));
  await clean('Genres', get(`/Genres?UserId=${u}&IncludeItemTypes=Movie&SortBy=SortName`));
  await clean('UserData GET', get(`/UserItems/${ep.Id}/UserData?userId=${u}`));
  await clean('UserData POST', post(`/UserItems/${ep.Id}/UserData?userId=${u}`, { PlaybackPositionTicks: 5 }));
  await clean('UserPlayedItems POST', post(`/UserPlayedItems/${movie.Id}?userId=${u}`));
  await clean('UserPlayedItems DELETE', call(srv, 'DELETE', `/UserPlayedItems/${movie.Id}?userId=${u}`, { headers: H }));
  await clean('PlaybackInfo', post(`/Items/${ep.Id}/PlaybackInfo`, tvPlaybackInfo(u)));
  await clean('PlaybackInfo (phone)', post(`/Items/${ep.Id}/PlaybackInfo`, phonePlaybackInfo(u, { sourceId: ep.Id })));
  await clean('MediaSegments', get(`/MediaSegments/${ep.Id}`));
  await clean('Sessions/Playing (204)', post('/Sessions/Playing', baseReport(ep.Id)));
  await clean('Sessions/Playing/Stopped (204)', post('/Sessions/Playing/Stopped', { ItemId: ep.Id, PositionTicks: 1 }));
  const qc = await post('/QuickConnect/Initiate', undefined, { Authorization: AUTH });
  await clean('QuickConnect/Initiate', Promise.resolve(qc));

  // ---- negative: a fixture that drifts from the DTOs is caught ----
  const drift = [
    ['a seeded item with a bogus property', (m) => (m.Bogus = 1), /fake response GET \/Items\/\w+ → 200: body\.Bogus not in schema/],
    ['a BaseItemKind that does not exist', (m) => (m.Type = 'Film'), /body\.Type="Film" not one of/],
    ['a MediaStream.Type typo, two levels down', (m) => (m.MediaSources[0].MediaStreams[0].Type = 'Vid'), /body\.MediaSources\[0\]\.MediaStreams\[0\]\.Type="Vid" not one of Audio\|Video/],
    ['a VideoRangeType that does not exist', (m) => (m.MediaSources[0].MediaStreams.find((x) => x.Type === 'Video').VideoRangeType = 'HDR'), /MediaStreams\[\d+\]\.VideoRangeType="HDR" not one of/],
    ['ticks as a string', (m) => (m.RunTimeTicks = String(m.RunTimeTicks)), /body\.RunTimeTicks="\d+" should be an integer/],
    ['a person with an unknown field', (m) => (m.People[0].Character = 'x'), /body\.People\[0\]\.Character not in schema/]
  ];
  for (const [what, mutate, re] of drift) {
    srv.reset();
    const m = srv.world.list('Movie')[0];
    mutate(m);
    const tok = srv.issueToken('alice');
    const r = await call(srv, 'GET', `/Items/${m.Id}?userId=${tok.userId}`, { headers: { Authorization: AUTH + `, Token="${tok.token}"` } });
    assert(r.violations.some((v) => re.test(v)), `${what}: not caught (${re}); got ${JSON.stringify(r.violations)}`);
  }
  srv.reset();
  srv.world.segments.set(ep.Id, [{ Id: ep.Id, ItemId: ep.Id, Type: 'Credits', StartTicks: 0, EndTicks: 1 }]);
  const tok = srv.issueToken('alice');
  const r = await call(srv, 'GET', `/MediaSegments/${ep.Id}`, { headers: { Authorization: AUTH + `, Token="${tok.token}"` } });
  assert(r.violations.some((v) => /body\.Items\[0\]\.Type="Credits" not one of/.test(v)), 'bad MediaSegmentType caught: ' + JSON.stringify(r.violations));
  t.log(`${drift.length + 1} drifted fixtures caught`);
});
