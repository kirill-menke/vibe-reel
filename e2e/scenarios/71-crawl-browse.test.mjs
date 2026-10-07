/* Invariant crawls of the browse screens: the Movies and Shows grids (with
 * the library bar and its modal dropdowns), MovieDetail (TechGrid "+N" chips
 * side path), SeriesDetail (season pills, episode rows, a pending row from the
 * activity feed) and Person — and Back from each to the element it was
 * opened from. Every screen is reached by D-pad + OK only. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, focused, screen } from '../lib/tv.mjs';
import { crawl, crawlSummary, walkTo, probe } from '../lib/crawler.mjs';

const report = (t, r) => {
  t.log(crawlSummary(r));
  if (r.leaves.length) t.log('leaves: ' + r.leaves.map((l) => `${l.from} ${l.key} → ${l.to}`).join(' ; '));
  if (r.varying.length) t.log('varying: ' + r.varying.slice(0, 8).join(' ; '));
};
const edge = (r, from, key) => r.observed.filter((e) => e.from === from && e.key === key).map((e) => e.to);

/* a movie file with more audio tracks / subtitle languages than the compact
 * TechGrid shows (AUDIO_CAP 4, SUB_CAP 3), so its "+N" chips exist */
function manyTracks(world) {
  const LANGS = [['fre', 'French'], ['spa', 'Spanish'], ['ita', 'Italian'], ['jpn', 'Japanese']];
  for (const m of world.list('Movie')) {
    const ms = m.MediaSources[0];
    const streams = ms.MediaStreams;
    const a0 = streams.find((s) => s.Type === 'Audio');
    const s0 = streams.find((s) => s.Type === 'Subtitle' && s.Codec === 'subrip' && !s.IsForced);
    let idx = Math.max(...streams.map((s) => s.Index)) + 1;
    for (const [code, name] of LANGS) {
      streams.push({ ...a0, Index: idx++, Codec: 'ac3', Channels: 6, ChannelLayout: '5.1', Language: code, Title: 'AC3 5.1', DisplayTitle: `${name} - Dolby Digital - 5.1`, IsDefault: false, Profile: undefined });
      const sub = { ...s0, Index: idx++, Language: code, DisplayTitle: `${name} - SUBRIP` };
      sub.DeliveryUrl = `/Videos/${m.Id}/${m.Id}/Subtitles/${sub.Index}/0/Stream.vtt`;
      streams.push(sub);
    }
    for (const s of streams) if (s.Profile === undefined) delete s.Profile;
  }
}

/* Home → tab → OK: the library grid, focus on a real element */
const notTile = (id) => !/^(tile|pend)-/.test(id);

async function openLibrary(t, tab) {
  const { page } = t;
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  for (let i = 0; i < 4 && (await focused(page)) !== 'tab-' + tab; i++) await page.key('Right', { settle: 120 });
  assert.equal(await focused(page), 'tab-' + tab, 'reached the tab by D-pad');
  await page.key('OK', { settle: 300 });
  await page.waitFor((n) => document.querySelectorAll('.screen .grid .tile').length >= n, { what: 'library grid', timeout: 10000 }, Math.min(10, t.srv.world.list(tab === 'movies' ? 'Movie' : 'Series').length));
  await page.waitFor(() => document.activeElement && document.activeElement !== document.body, { what: 'focus after opening the library' });
}

/* Library grid → first tile → OK: the detail page with its Play button */
async function openFirstTile(t) {
  const { page } = t;
  // the first Jellyfin tile (a PendingTile from the activity feed may lead the grid)
  const tile = await page.eval(() => document.querySelector('.screen .grid .tile.focus[data-focus^="tile-"]')?.dataset.focus);
  for (let i = 0; i < 4 && !/^(tile|pend)-/.test(await focused(page)); i++) await page.key('Down', { settle: 250 });
  for (let i = 0; i < 4 && (await focused(page)) !== tile; i++) await page.key('Right', { settle: 250 });
  assert.equal(await focused(page), tile, 'D-pad reached the first Jellyfin grid tile');
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'play', 10000);
  return tile;
}

async function dropdown(t, r, pill, rowPrefix) {
  const { page } = t;
  assert(await walkTo(page, r, pill, { log: t.log }), 'walked to ' + pill + ' by D-pad');
  await page.key('OK', { settle: 250 });
  await page.waitFor(() => document.querySelector('.screen .lvmenu'), { what: pill + ' dropdown open' });
  const m = await crawl(page, { name: pill + ' dropdown', settle: 120, maxStates: 40, timeLimit: 40000, log: t.log });
  report(t, m);
  assert.deepEqual(m.problems, [], pill + ' dropdown crawl problems');
  assert(m.keys.length >= 2 && m.keys.every((k) => k.startsWith(rowPrefix)), `only ${rowPrefix}* rows are reachable while it is open: ${m.keys.join(' ')}`);
  assert.deepEqual(m.leaves, [], 'arrows never leave the modal dropdown');
  await page.key('Back', { settle: 300 });
  assert(!(await page.eval(() => document.querySelector('.screen .lvmenu'))), 'Back closed the dropdown');
  assert.equal(await focused(page), pill, 'Back closed the dropdown onto its pill');
  return m;
}

test('crawl: Movies grid — tiles, library bar pills, sort + genre dropdowns are modal, Back closes onto the pill', { fast: false, timeout: 150000 }, async (t) => {
  const { page } = t;
  await openLibrary(t, 'movies');
  const r = await crawl(page, { name: 'movies grid', settle: 150, maxStates: 40, timeLimit: 70000, prefer: notTile, log: t.log });
  report(t, r);
  assert.deepEqual(r.problems, [], 'Movies grid crawl problems');
  assert(r.states.length >= 30, `>= 30 states, got ${r.states.length}`);
  for (const k of ['tab-movies', 'lv-sort', 'lv-genre', 'lv-unseen']) assert(r.keys.includes(k), 'visited ' + k + ': ' + r.keys.join(' '));
  assert(r.keys.filter((k) => k.startsWith('tile-')).length >= 20, 'visited >= 20 grid tiles');

  await dropdown(t, r, 'lv-sort', 'lv-s-');
  await dropdown(t, r, 'lv-genre', 'lv-g-');

  // Back from the library goes to its parent, Home, with focus on a real element
  await page.key('Back', { settle: 400 });
  await page.waitFor(() => document.querySelector('.screen.home'), { what: 'Home after Back from the library' });
  assert((await focused(page)) !== '<body>', 'focus not on <body> after Back to Home');
});

test('crawl: Shows grid', { fast: false, timeout: 90000 }, async (t) => {
  const { page } = t;
  await openLibrary(t, 'shows');
  const r = await crawl(page, { name: 'shows grid', settle: 150, maxStates: 30, timeLimit: 50000, prefer: notTile, log: t.log });
  report(t, r);
  assert.deepEqual(r.problems, [], 'Shows grid crawl problems');
  const series = t.srv.world.list('Series').map((s) => 'tile-' + s.Id);
  const missing = series.filter((k) => !r.keys.includes(k));
  assert.deepEqual(missing, [], 'every series tile visited');
  for (const k of ['tab-shows', 'lv-sort', 'lv-genre', 'lv-unseen']) assert(r.keys.includes(k), 'visited ' + k);
});

test('crawl: MovieDetail — buttons, TechGrid +N chips side path, cast + rails; Person and Back to the cast tile; Back lands on the grid tile', { fast: false, timeout: 180000 }, async (t) => {
  const { page, srv } = t;
  manyTracks(srv.world);
  await openLibrary(t, 'movies');
  const tile = await openFirstTile(t);
  await page.waitFor(() => document.querySelector('[data-focus="tg-audio"]') && document.querySelector('[data-focus="tg-subs"]') && document.querySelector('.screen .rail .focus'), { what: 'TechGrid +N chips and a rail', timeout: 10000 });
  const r = await crawl(page, { name: 'movie detail', settle: 200, maxStates: 45, timeLimit: 80000, log: t.log });
  report(t, r);
  assert.deepEqual(r.problems, [], 'MovieDetail crawl problems');
  for (const k of ['play', 'watched', 'tg-audio', 'tg-subs']) assert(r.keys.includes(k), 'visited ' + k + ': ' + r.keys.join(' '));
  assert(r.keys.some((k) => k.startsWith('cast-')), 'visited the cast rail');

  // the chips side path (CLAUDE.md, MovieDetail): ▶ from the rightmost button
  // enters them, ▼ steps audio → subtitles → rail, ▲/◀ return to a button
  const btns = await page.eval(() => [...document.querySelectorAll('.screen .hero .actions .focus')].map((e) => e.dataset.focus));
  const last = btns.at(-1);
  assert.deepEqual(edge(r, last, 'Right'), ['tg-audio'], `▶ from the rightmost button (${last}) enters the chips`);
  assert.deepEqual(edge(r, 'tg-audio', 'Down'), ['tg-subs'], '▼ audio → subtitles');
  const subsDown = edge(r, 'tg-subs', 'Down');
  assert(subsDown.length && subsDown.every((k) => /^(cast-|tile-|lk-)/.test(k)), '▼ subtitles → the first rail: ' + subsDown);
  for (const [from, key] of [['tg-audio', 'Up'], ['tg-audio', 'Left'], ['tg-subs', 'Left']]) {
    const to = edge(r, from, key);
    assert(to.length && to.every((k) => btns.includes(k)), `${key} from ${from} returns to an action button: ${to}`);
  }
  assert.deepEqual(edge(r, 'tg-subs', 'Up'), ['tg-audio'], '▲ subtitles → audio');
  // ▼ from the buttons skips the chips, straight onto the first rail
  for (const b of btns) assert(edge(r, b, 'Down').every((k) => /^(cast-|tile-|lk-)/.test(k)), `▼ from ${b} goes to the first rail: ${edge(r, b, 'Down')}`);

  // Person: a cast tile → OK → Person, crawl it, Back → the same cast tile
  const cast = r.keys.find((k) => k.startsWith('cast-'));
  assert(await walkTo(page, r, cast, { log: t.log }), 'walked to ' + cast);
  await page.key('OK', { settle: 400 });
  await page.waitFor(() => document.querySelector('.screen .personhead') && document.querySelector('.screen .grid .tile.focus, [data-focus="person-back"]'), { what: 'Person screen', timeout: 10000 });
  await page.waitFor(() => document.activeElement && document.activeElement !== document.body && document.activeElement.closest('.screen'), { what: 'focus on Person' });
  const p = await crawl(page, { name: 'person', settle: 200, maxStates: 15, timeLimit: 30000, log: t.log });
  report(t, p);
  assert.deepEqual(p.problems, [], 'Person crawl problems');
  assert(p.keys.some((k) => /^tile-/.test(k)), 'Person: filmography tiles reachable: ' + p.keys.join(' '));
  await page.key('Back', { settle: 400 });
  await waitFocus(page, cast, 10000);

  // Back → the grid, focus on the tile the detail was opened from
  await page.key('Back', { settle: 400 });
  await page.waitFor(() => document.querySelector('.screen .grid'), { what: 'grid after Back' });
  await waitFocus(page, tile);
});

test('crawl: SeriesDetail — season pills, episode rows incl. a pending row; Back lands on the grid tile', { fast: false, timeout: 180000 }, async (t) => {
  const { page, srv } = t;
  const nl = srv.world.byName('Series', 'Northern Line');
  await openLibrary(t, 'shows');
  // the grid tile of Northern Line, reached by D-pad (crawl the grid's edges, then walk)
  const g = await crawl(page, { name: 'shows grid (to find Northern Line)', settle: 150, maxStates: 20, timeLimit: 30000 });
  assert(await walkTo(page, g, 'tile-' + nl.Id), 'walked to the Northern Line tile');
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'play', 10000);
  await page.waitFor(() => document.querySelectorAll('.screen .eprow').length > 3 && document.querySelector('[data-focus="season-2"]'), { what: 'episodes + season pills', timeout: 10000 });

  const r = await crawl(page, { name: 'series detail', settle: 200, maxStates: 40, timeLimit: 70000, log: t.log });
  report(t, r);
  assert.deepEqual(r.problems, [], 'SeriesDetail crawl problems');
  for (const k of ['play', 'season-0', 'season-1', 'season-2']) assert(r.keys.includes(k), 'visited ' + k + ': ' + r.keys.join(' '));
  assert(r.keys.filter((k) => k.startsWith('ep-')).length >= 4, 'visited episode rows');

  // season 3 holds the activity feed's S03E07 as a dimmed pending row
  assert(await walkTo(page, r, 'season-2'), 'walked to the Season 3 pill');
  await page.key('OK', { settle: 400 });
  await page.waitFor(() => document.querySelector('.screen .eprow.pend'), { what: 'pending episode row in season 3', timeout: 10000 });
  const r3 = await crawl(page, { name: 'series detail, season 3', settle: 200, maxStates: 30, timeLimit: 50000, log: t.log });
  report(t, r3);
  assert.deepEqual(r3.problems, [], 'season 3 crawl problems');
  assert(r3.keys.some((k) => k.startsWith('pep-')), 'the pending row is reachable: ' + r3.keys.join(' '));

  // Back → the Shows grid on the Northern Line tile
  await page.key('Back', { settle: 400 });
  await waitFocus(page, 'tile-' + nl.Id, 10000);
});
