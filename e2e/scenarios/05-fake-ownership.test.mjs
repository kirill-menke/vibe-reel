/* Fake fidelity, ownership and quotas (run/design.md §5, §8.2, §9.1–9.2):
 * direct HTTP (no browser) pins the fake reel-api's permission and quota rules
 * to the backend's (backend/tests/test_permissions.py, test_quota.py,
 * test_me.py, test_library_delete.py), so a scenario that passes against the
 * fake passes against the real service for the same reason. Every request and
 * every 2xx answer still goes through the reel-api OpenAPI validation (a
 * violation fails the test).
 *
 * Actors: kirill (admin) and alice (admin), nicole and bob (normal users).
 * Titles: nicole's (recorded owner nicole), kirill's, and legacy ones (the
 * seed's: no record, owned by "the admins"). */
import { test, assert } from '../lib/runner.mjs';
import { addPending, series } from '../lib/world.mjs';

/* a reel-api client signed in as `user`; every call asserts the fake saw no violation */
function as(srv, user) {
  const H = srv.mlAuth(user);
  const call = async (method, path, body) => {
    const before = srv.violations.length;
    const r = await fetch(srv.urls.ml + path, { method, headers: { ...H, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    assert.deepEqual(srv.violations.slice(before).map((x) => x.msg), [], `${user} ${method} ${path}: violations`);
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: r.status, json };
  };
  return {
    call,
    me: async () => {
      const r = await call('GET', '/api/me');
      assert.equal(r.status, 200, `${user} GET /api/me → ${r.status} ${JSON.stringify(r.json)}`);
      return r.json;
    },
    add: (type, id) => call('POST', '/api/library', { type, id: String(id) }),
    del: (type, id) => call('DELETE', `/api/library/${type}/${id}?delete_files=true`),
    undo: (type, id, token) => call('DELETE', `/api/library/${type}/${id}?undo=${token}`),
    cancel: (type, id, q = '') => call('DELETE', `/api/activity/${type}/${id}${q}`),
    feed: async () => (await call('GET', '/api/activity')).json.items
  };
}

const used = (me) => [me.quota.movie.used, me.quota.tv.used];

test('fake ownership: users and roles — the fake Jellyfin\'s /Users/Me carries Policy.IsAdministrator, /api/me mirrors it', { app: 'none', fast: true }, async (t) => {
  const { srv } = t;
  const w = srv.world;
  assert.deepEqual([w.kirill.Name, w.nicole.Name], ['kirill', 'nicole'], 'world.kirill / world.nicole');
  for (const [name, admin] of [['alice', true], ['bob', false], ['kirill', true], ['nicole', false]]) {
    const { token, userId } = srv.issueToken(name);
    const r = await fetch(srv.urls.jf + '/Users/Me', { headers: { Authorization: `MediaBrowser Token="${token}"` } });
    assert.equal(r.status, 200);
    const u = await r.json();
    assert.deepEqual([u.Id, u.Name, u.Policy.IsAdministrator], [userId, name, admin], name + ' as Jellyfin answers the guard');
    const me = await as(srv, name).me();
    assert.deepEqual(me.user, { id: userId, name }, name + ' /api/me user');
    assert.equal(me.admin, admin, name + ' /api/me admin');
    assert.deepEqual(me.quota, { movie: { used: 0, limit: admin ? null : 10 }, tv: { used: 0, limit: admin ? null : 10 } }, name + ' quota (admin: no limit)');
    assert.deepEqual(me.titles, [], name + ' owns nothing in the seed (every seeded title is legacy)');
  }
  // both sign in with their passwords; kirill has a picture, nicole none
  for (const [name, pw] of [['kirill', 'kirill-pw'], ['nicole', 'nicole-pw']]) {
    const r = await fetch(srv.urls.jf + '/Users/AuthenticateByName', { method: 'POST', headers: { Authorization: 'MediaBrowser Client="Reel", Device="e2e", DeviceId="own-' + name + '", Version="0.1.0"', 'Content-Type': 'application/json' }, body: JSON.stringify({ Username: name, Pw: pw }) });
    assert.equal(r.status, 200, name + ' signs in');
  }
  assert.equal(w.kirill.hasImage, true);
  assert.equal(w.nicole.hasImage, false);
});

test('fake ownership: quota — 10/10 movies refuses with the 409 body, per user and type, admins unlimited, a delete or undo frees the slot', { app: 'none', fast: true }, async (t) => {
  const { srv } = t;
  const w = srv.world;
  const N = as(srv, 'nicole'), B = as(srv, 'bob'), K = as(srv, 'kirill');

  const filled = w.ml.fill('nicole', 'movie', 9);
  assert.equal(filled.length, 9, 'fill made 9 titles');
  assert(filled.every((e) => e.added && w.ml.owners.get('movie:' + e.id)?.owner === w.nicole.Id), 'filled titles are added and nicole\'s');
  assert.deepEqual(used(await N.me()), [9, 0]);

  let r = await N.add('movie', 900002);
  assert.equal(r.status, 202, 'the 10th movie is added');
  assert.equal(w.ml.owners.get('movie:900002').owner, w.nicole.Id, 'recorded for nicole');
  assert.deepEqual(used(await N.me()), [10, 0]);

  r = await N.add('movie', 900003);
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { error: 'quota_exceeded', detail: 'You already have 10 of 10 movies. Delete one in My library to add another.', type: 'movie', used: 10, limit: 10 }, 'the quota body');
  assert.equal(w.ml.lookup('movie', '900003').added, false, 'nothing was added');
  assert.equal(w.ml.adds.length, 1, 'only the 10th add reached the arr');
  // at the limit even an already-added title answers quota_exceeded (no arr call is made)
  r = await N.add('movie', 900002);
  assert.equal(r.json?.error, 'quota_exceeded', 'at the limit the quota check comes first');

  // series are their own quota; another user is unaffected; an admin has none
  r = await N.add('tv', 400002);
  assert.equal(r.status, 202, 'a show still fits');
  assert.deepEqual(used(await N.me()), [10, 1], 'a series counts once');
  assert.equal((await B.add('movie', 900003)).status, 202, 'bob\'s quota is his own');
  w.ml.fill('kirill', 'movie', 12);
  assert.equal((await K.add('movie', 900004)).status, 202, 'kirill (admin) adds a 13th movie');
  assert.deepEqual((await K.me()).quota.movie, { used: 13, limit: null }, 'admin: counted, no limit');

  // a delete frees the slot at once
  r = await N.del('movie', filled[0].id);
  assert.equal(r.status, 200);
  assert.deepEqual(used(await N.me()), [9, 1]);
  r = await N.add('movie', 900005);
  assert.equal(r.status, 202, 'the freed slot takes a new add');
  // …and so does an undo
  r = await N.undo('movie', '900005', r.json.undo);
  assert.equal(r.status, 200, 'undo');
  assert.equal(w.ml.owners.has('movie:900005'), false, 'undo drops the record');
  assert.deepEqual(used(await N.me()), [9, 1]);
  // a title that left the arr outside reel-api frees its slot too (the record is pruned)
  w.ml.lookup('movie', filled[1].id).added = false;
  assert.deepEqual(used(await N.me()), [8, 1]);
  assert.equal(w.ml.owners.has('movie:' + filled[1].id), false, 'the record of a title gone from the arr is dropped');

  // limits come from config; 0 turns adding off
  w.ml.quota.tv = 1;
  r = await N.add('tv', 400003);
  assert.deepEqual(r.json, { error: 'quota_exceeded', detail: 'You already have 1 of 1 show. Delete one in My library to add another.', type: 'tv', used: 1, limit: 1 }, 'singular, "show"');
  w.ml.quota.tv = 0;
  r = await N.add('tv', 400003);
  assert.equal(r.json.detail, 'Adding shows is turned off for your account.');
  assert.equal((await N.me()).quota.tv.limit, 0);
});

test('fake ownership: delete with files — owner or admin only, legacy titles admin-only, 400/409/already_removed like the backend', { app: 'none', fast: true }, async (t) => {
  const { srv } = t;
  const w = srv.world;
  const N = as(srv, 'nicole'), B = as(srv, 'bob'), K = as(srv, 'kirill');
  const nl = series(w, 'Northern Line');

  w.ml.own('movie', '900002', 'nicole');
  const grab = addPending(w, { type: 'movie', media_id: '900002', progress: 0.5 });
  w.ml.own('movie', '900003', 'kirill');

  // neither or both of undo / delete_files
  let r = await N.call('DELETE', '/api/library/movie/900002');
  assert.deepEqual([r.status, r.json?.error], [400, 'bad_request'], 'neither');
  r = await N.call('DELETE', '/api/library/movie/900002?undo=abcdefgh12&delete_files=true');
  assert.deepEqual([r.status, r.json?.error], [400, 'bad_request'], 'both');

  // not yours: 403, nothing touched
  r = await B.del('movie', '900002');
  assert.deepEqual(r.json, { error: 'not_owner', detail: 'Only the person who added “Iron Tide” can delete it.' }, 'bob on nicole\'s');
  r = await N.del('movie', '900003');
  assert.equal(r.status, 403, 'nicole on kirill\'s');
  r = await N.del('movie', '900001');
  assert.deepEqual(r.json, { error: 'not_owner', detail: '“Glass Meridian Rising” was added by an admin; only an admin can delete it.' }, 'nicole on a legacy title');
  r = await N.del('tv', nl.ProviderIds.Tvdb);
  assert.equal(r.status, 403, 'nicole on a legacy series');
  assert.deepEqual([w.ml.deletes.length, w.ml.activity.includes(grab), w.ml.lookup('movie', '900002').added], [0, true, true], 'every 403 left the world alone');

  // an importing grab: 409, nothing touched
  grab.status = 'importing';
  r = await N.del('movie', '900002');
  assert.deepEqual([r.status, r.json?.error], [409, 'importing']);
  assert.equal(r.json.detail, '“Iron Tide” is being imported right now — try again in a minute.');
  assert(w.ml.activity.includes(grab) && w.ml.owners.has('movie:900002'), 'nothing touched');
  grab.status = 'downloading';

  // the owner deletes: grabs gone, not added any more, record dropped, recorded in deletes
  r = await N.del('movie', '900002');
  assert.deepEqual(r.json, { id: '900002', type: 'movie', title: 'Iron Tide', status: 'deleted', downloads_removed: 1 });
  assert(!w.ml.activity.includes(grab), 'the grab left the feed');
  assert.equal(w.ml.lookup('movie', '900002').added, false, 'lookup offers it again');
  assert.equal(w.ml.owners.has('movie:900002'), false, 'record dropped');
  assert.deepEqual(w.ml.deletes, [{ type: 'movie', id: '900002', user: 'nicole' }]);
  // a retry of a finished delete (lost answer) is already_removed, not a 403
  r = await N.del('movie', '900002');
  assert.deepEqual([r.status, r.json?.status, r.json?.downloads_removed], [200, 'already_removed', 0], 'retry');

  // admins delete anything: someone else's, and legacy (a series: its seasons' records and news go too)
  r = await K.del('movie', '900001');
  assert.deepEqual([r.status, r.json?.status, r.json?.downloads_removed], [200, 'deleted', 1], 'kirill deletes the legacy downloading movie');
  const hs = series(w, 'The Hollow Signal');
  w.ml.seasons.set(`tv:${hs.ProviderIds.Tvdb}:5`, { owner: w.nicole.Id, at: '2026-10-05T12:00:00Z' });
  r = await K.del('tv', hs.ProviderIds.Tvdb);
  assert.equal(r.json?.status, 'deleted');
  assert.equal(w.ml.seasons.size, 0, 'the series\' season records went with it');
  assert(!w.ml.news.some((n) => n.media_id === hs.ProviderIds.Tvdb), 'and its news (Sonarr no longer has it)');
  assert(w.byName('Series', 'The Hollow Signal'), 'Jellyfin keeps the item until its own scan (not modelled)');
});

test('fake ownership: cancel, undo and season Get permissions; activity mine / can_cancel per caller', { app: 'none', fast: true }, async (t) => {
  const { srv } = t;
  const w = srv.world;
  const N = as(srv, 'nicole'), B = as(srv, 'bob'), K = as(srv, 'kirill');
  const hs = series(w, 'The Hollow Signal').ProviderIds.Tvdb;

  // nicole adds a show (a queued grab appears), kirill owns another title with a grab
  let r = await N.add('tv', 400002);
  assert.equal(r.status, 202);
  const addToken = r.json.undo;
  w.ml.own('movie', '900004', 'kirill');
  addPending(w, { type: 'movie', media_id: '900004' });

  // everyone may Get a season; the requester holds it
  r = await N.call('POST', '/api/news/search', { id: hs, season: 5 });
  assert.equal(r.status, 202, 'a normal user may Get a season');
  const getToken = r.json.undo;
  assert.equal(w.ml.seasons.get(`tv:${hs}:5`)?.owner, w.nicole.Id, 'season request recorded for nicole');
  const s5 = addPending(w, { type: 'tv', media_id: hs, season: 5, episode: 1, download_id: 'c'.repeat(40) });
  const s4 = addPending(w, { type: 'tv', media_id: hs, season: 4, episode: 6, download_id: 'c'.repeat(40) }); // one pack: S4 + S5

  // activity flags, per caller
  const flags = (items) => Object.fromEntries(items.map((a) => [a.id, [a.mine, a.can_cancel]]));
  let f = flags(await N.feed());
  assert.deepEqual(f['q-tv-400002'], [true, true], 'nicole: her show');
  assert.deepEqual(f['q-movie-900004'], [false, false], 'nicole: kirill\'s movie');
  assert.deepEqual(f['q-movie-900001'], [false, false], 'nicole: a legacy grab');
  assert.deepEqual(f[s5.id], [true, true], 'nicole: the season she asked for');
  assert.deepEqual(f[s4.id], [false, false], 'nicole: the other season of that series');
  f = flags(await K.feed());
  assert.deepEqual([f['q-tv-400002'], f['q-movie-900004'], f['q-movie-900001']], [[false, true], [true, true], [false, true]], 'kirill: mine only for his, may cancel everything');

  // cancel: own title yes, others' / legacy no; a pack that spans a season she doesn't hold: no, untouched
  const n0 = w.ml.activity.length;
  for (const [type, id] of [['movie', '900004'], ['movie', '900001']]) {
    r = await N.cancel(type, id);
    assert.deepEqual([r.status, r.json?.error], [403, 'not_owner'], 'nicole cancels ' + id);
  }
  assert.equal(r.json.detail, 'Only the person who added “Glass Meridian Rising” can cancel its download.');
  r = await N.cancel('tv', hs, '?season=5');
  assert.deepEqual([r.status, r.json?.error], [403, 'not_owner'], 'the S4+S5 pack is not all hers');
  assert.equal(w.ml.activity.length, n0, 'every 403 removed nothing');
  assert.equal((await B.cancel('tv', '400002')).status, 403, 'bob cancels nicole\'s show');
  s4.download_id = 'd'.repeat(40); // now S5 is its own torrent
  r = await N.cancel('tv', hs, '?season=5');
  assert.deepEqual([r.status, r.json?.status], [200, 'cancelled'], 'nicole cancels her season');
  r = await N.cancel('tv', '400002');
  assert.equal(r.status, 200, 'nicole cancels her show');
  r = await K.cancel('movie', '900001');
  assert.equal(r.status, 200, 'kirill cancels a legacy grab');
  // order: no matching row is still 404, all-importing 409, before the permission check
  assert.equal((await N.cancel('movie', '900009')).status, 404, 'nothing queued → 404 not_in_queue');
  w.ml.activity.find((a) => a.id === 'q-movie-900004').status = 'importing';
  assert.equal((await N.cancel('movie', '900004')).json?.error, 'importing', 'importing → 409 before the 403');

  // undo of an add: the adder or an admin
  r = await B.undo('tv', '400002', addToken);
  assert.deepEqual(r.json, { error: 'not_owner', detail: 'Only the person who added “Golden Frontier” can undo that.' }, 'bob with nicole\'s token');
  assert.equal(w.ml.lookup('tv', '400002').added, true, 'still added');
  r = await K.undo('tv', '400002', addToken);
  assert.deepEqual([r.status, r.json?.status], [200, 'removed'], 'kirill may undo it');
  assert.equal(w.ml.owners.has('tv:400002'), false, 'record dropped');

  // undo of a Get: the requester or an admin
  r = await B.call('DELETE', '/api/news/search/' + getToken);
  assert.deepEqual(r.json, { error: 'not_owner', detail: 'Only the person who asked for that season can undo it.' }, 'bob undoes nicole\'s Get');
  r = await N.call('DELETE', '/api/news/search/' + getToken);
  assert.deepEqual([r.status, r.json?.status], [200, 'reverted'], 'nicole undoes her Get');
  assert.equal(w.ml.seasons.has(`tv:${hs}:5`), false, 'season record dropped');
});

test('fake ownership: /api/me lists the caller\'s titles — status from the feed (size-weighted progress), in_library from Jellyfin, waiting otherwise; in-flight first', { app: 'none', fast: true }, async (t) => {
  const { srv } = t;
  const w = srv.world;
  const nl = series(w, 'Northern Line');
  const harbor = w.list('Movie').find((m) => m.Name === 'The Silent Harbor');

  w.ml.own('movie', harbor.ProviderIds.Tmdb, 'nicole', { at: '2026-10-01T10:00:00Z' }); // in Jellyfin
  w.ml.own('movie', '900006', 'nicole', { at: '2026-10-02T10:00:00Z' }); // nothing grabbed yet
  w.ml.own('tv', nl.ProviderIds.Tvdb, 'nicole', { at: '2026-10-03T10:00:00Z' }); // in Jellyfin + a grab in flight (seed: S3E7 71 %)
  w.ml.own('movie', '900002', 'nicole', { at: '2026-10-04T10:00:00Z' });
  addPending(w, { id: 'g1', type: 'movie', media_id: '900002', progress: 0.2, size_bytes: 1_000_000_000, download_id: 'e'.repeat(40) });
  addPending(w, { id: 'g2', type: 'movie', media_id: '900002', progress: 0.8, size_bytes: 3_000_000_000, download_id: 'f'.repeat(40) });
  w.ml.own('movie', '900003', 'kirill');

  const me = await as(srv, 'nicole').me();
  assert.deepEqual(me.quota, { movie: { used: 3, limit: 10 }, tv: { used: 1, limit: 10 } });
  const rows = me.titles.map((x) => [x.type, x.id, x.status, x.progress, x.has_files]);
  assert.deepEqual(rows, [
    ['movie', '900002', 'downloading', 0.65, false],
    ['tv', nl.ProviderIds.Tvdb, 'downloading', 0.71, true],
    ['movie', '900006', 'waiting', null, false],
    ['movie', harbor.ProviderIds.Tmdb, 'in_library', null, true]
  ], 'statuses, size-weighted progress over distinct downloads, order (in flight newest first, waiting, in library)');
  const t0 = me.titles[0];
  assert.deepEqual([t0.title, t0.year, t0.added_at], ['Iron Tide', 2023, '2026-10-04T10:00:00Z'], 'title/year from the catalog, added_at from the record');
  assert.match(t0.poster, /^http:\/\/127\.0\.0\.1:\d+\/__fixture\/img\/poster-movie-900002\.png$/, 'absolute poster URL');
  assert.deepEqual((await as(srv, 'kirill').me()).titles.map((x) => x.id), ['900003'], 'kirill sees his own record only (legacy titles are listed for nobody)');
});

test('fake ownership: oldBackend — no /api/me (FastAPI 404), activity without mine/can_cancel, no permission or quota checks', { app: 'none', fast: true }, async (t) => {
  const { srv } = t;
  const w = srv.world;
  w.ml.oldBackend = true;
  const N = as(srv, 'nicole');
  let r = await N.call('GET', '/api/me');
  assert.deepEqual([r.status, r.json], [404, { detail: 'Not Found' }], 'an old reel-api has no /api/me');
  const items = await N.feed();
  assert(items.length && items.every((a) => !('mine' in a) && !('can_cancel' in a)), 'no ownership flags');
  w.ml.fill('nicole', 'movie', 10);
  assert.equal((await N.add('movie', '900002')).status, 202, 'no quota');
  r = await N.cancel('movie', '900001');
  assert.equal(r.status, 200, 'anyone cancels anything');
});
