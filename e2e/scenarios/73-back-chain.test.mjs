/* Back always reaches a parent (CLAUDE.md "Navigation state": one $state
 * object, no history stack — onBack() in nav.svelte.js derives the parent;
 * Keys.svelte peels overlays first). From every reachable screen, repeated
 * Back walks a parent chain that ends on Home, and Back on Home is a no-op.
 * After every press: the screen is the expected parent, focus sits on a real
 * element of the active scope (never <body>), and the focus invariants hold.
 *
 * The expected parents, as onBack() + Keys.svelte derive them:
 *
 *   from                      Back →                        why
 *   player (OSD up)           player, OSD hidden            Keys: first Back hides the OSD
 *   player (OSD hidden)       the screen it started from    exitPlayer()
 *   .lvmenu (bell / sort)     its screen, focus on its button   Keys: a menu is modal
 *   Search keyboard           Search (bar)                  Keys: S.searchKb first
 *   Search chart grid         Search (its card)             closeSearchChart()
 *   Search                    the tab it was raised from    Keys: S.search
 *   person                    detail (the cast member)      trail
 *   detail/pending/lookup     the page/Search it was opened from (trail, searchReturn),
 *                             else the tab's grid (movies/shows) or Home
 *   library / home, focus below the tab row
 *                             the same screen, focus on its tab   Keys: backToTabs()
 *   library (tab row)         home                          onBack(): openHome()
 *   home (tab row)            home, focus unchanged         root: nothing to derive
 */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, focused, steer, checkFocusInvariants, holds } from '../lib/tv.mjs';
import { startAndPlay } from '../lib/player.mjs';
import { movie } from '../lib/world.mjs';

/* where the app is, from the DOM alone (runs in the page) */
function whereInPage() {
  const vis = (el) => !!el && !el.hidden && el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
  const q = (css) => document.querySelector(css);
  if (vis(q('#video-layer'))) return q('#osd')?.classList.contains('show') ? 'player:osd' : 'player';
  const search = q('#search');
  if (search?.classList.contains('on')) {
    if (vis(search.querySelector('.skb'))) return 'search:kb';
    const cards = [...search.querySelectorAll('.catcard')];
    if (cards.length && !cards.some(vis) && vis(search.querySelector('.grid'))) return 'search:chart';
    return 'search';
  }
  const scr = q('.screen');
  if (!scr) return 'none';
  let s;
  if (scr.classList.contains('home')) s = 'home';
  else if (scr.classList.contains('login')) s = 'login';
  else if (scr.querySelector('.personhead')) s = 'person';
  else if (scr.querySelector('[data-focus="lv-sort"]')) s = 'library:' + (q('.tab.active')?.dataset.focus || '').replace('tab-', '');
  else if (scr.querySelector('[data-focus^="pd-"], [data-focus^="pdseason-"], .hero .btn.stat')) s = 'pending';
  else if (scr.querySelector('[data-focus^="lk-"], [data-focus^="lkseason-"]')) s = 'lookup';
  else if (scr.querySelector('[data-focus="play"], [data-focus="watched"], [data-focus^="season-"], [data-focus="restart"]')) s = 'detail';
  else s = 'screen?';
  return [...document.querySelectorAll('.lvmenu')].some(vis) ? 'menu:' + s : s;
}
const where = (page) => page.eval(`(${whereInPage})()`);

/* Only Home's rails share tile-<id> keys by design (the same title in
 * Continue Watching and Latest); on every other screen — Library grids, detail
 * rails, Person, PendingDetail, Search, menus — a repeated key is a defect. */
async function invariants(page) {
  const opts = (await where(page)) === 'home' ? { dupOk: ['tile-'] } : {};
  let bad = await checkFocusInvariants(page, opts);
  if (bad.length && bad.every((b) => b.endsWith('(one copy is an inert outro)'))) {
    await page.waitFor(() => !document.querySelector('.screen [inert]'), { what: 'outro finished', timeout: 3000 });
    bad = await checkFocusInvariants(page, opts);
  }
  return bad;
}

/* Press Back once per entry of `chain` ([where, focusKey|RegExp|null]) and
 * check each landing. ['home', null] after Home is the root no-op: nothing
 * changes, focus included. */
async function backChain(t, chain, from) {
  const { page } = t;
  const trail = [from || (await where(page))];
  for (const [exp, fkey] of chain) {
    const prev = trail.at(-1);
    const f0 = await focused(page);
    await page.key('Back', { settle: 60 });
    if (prev === 'home' && exp === 'home' && fkey == null) {
      // the root: Back changes nothing (and doesn't drop focus) for a while
      await holds(async () => (await where(page)) === 'home' && (await focused(page)) === f0, 500, `Back on Home's tab row is a no-op (stays on ${f0})`);
    } else {
      await page.waitFor((src, exp, key) => {
        const a = document.activeElement;
        return new Function('return (' + src + ')')()() === exp && a && a !== document.body && a.isConnected && a.dataset.focus && (!key || a.dataset.focus === key);
      }, { what: `Back from ${prev} → ${exp}${typeof fkey === 'string' ? ' on ' + fkey : ''} (trail: ${trail.join(' → ')})`, timeout: 10000 }, whereInPage.toString(), exp, typeof fkey === 'string' ? fkey : null);
    }
    const f = await focused(page);
    trail.push(exp);
    t.log(`Back → ${exp} on ${f}`);
    assert(f !== '<body>', `focus on <body> after Back to ${exp}`);
    if (fkey instanceof RegExp) assert.match(f, fkey, `focus after Back to ${exp}`);
    else if (fkey) assert.equal(f, fkey, `focus after Back to ${exp}`);
    assert.deepEqual(await invariants(page), [], `focus invariants on ${exp} (trail: ${trail.join(' → ')})`);
  }
  assert.equal(trail.at(-1), 'home', 'the chain ends on Home');
  return trail;
}

async function home(t) {
  await bootTv(t);
  await waitFocus(t.page, 'tab-home');
  await t.page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 4, { what: 'Home rails', timeout: 10000 });
}

async function openTabGrid(t, tab) {
  const { page } = t;
  await steer(page, 'tab-' + tab, { settle: 120 });
  await page.key('OK', { settle: 250 });
  await page.waitFor(() => document.querySelectorAll('.screen .grid .tile').length >= 7, { what: tab + ' grid', timeout: 10000 });
  assert.equal(await where(page), 'library:' + tab);
}

async function okInto(page, key, exp) {
  await steer(page, key, { settle: 150 });
  await page.key('OK', { settle: 250 });
  await page.waitFor((src, exp) => new Function('return (' + src + ')')()() === exp && document.activeElement?.dataset.focus, { what: 'OK on ' + key + ' → ' + exp, timeout: 10000 }, whereInPage.toString(), exp);
  return focused(page);
}

async function raiseSearch(page) {
  await steer(page, 'tab-home', { settle: 120 });
  await page.key('Up', { settle: 300 });
  await page.waitFor(() => document.getElementById('search')?.classList.contains('on'), { what: 'Search up' });
  await waitFocus(page, 'q2');
}

test('back chain: Library → MovieDetail → Person: Back walks Person → MovieDetail (cast member) → Movies (its tile) → Movies tab → Home, then Home stays', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const m = movie(srv.world, 1);
  await home(t);
  await openTabGrid(t, 'movies');
  await okInto(page, 'tile-' + m.Id, 'detail');
  await waitFocus(page, 'play', 8000);
  await page.key('Down', { settle: 300 });
  const cast = await focused(page);
  assert.match(cast, /^cast-/, '▼ from the buttons reaches the cast rail');
  await page.key('OK', { settle: 300 });
  await page.waitFor(() => document.querySelector('.screen .personhead') && document.activeElement?.dataset.focus, { what: 'Person', timeout: 8000 });
  await backChain(t, [['detail', cast], ['library:movies', 'tile-' + m.Id], ['library:movies', 'tab-movies'], ['home', 'tab-home'], ['home', null]], 'person');
});

test('back chain: Home → detail (hero More info) and Home → LookupDetail (Trending tile): Back returns to Home on what opened it', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  await home(t);
  await okInto(page, 'hero-info', 'detail');
  await backChain(t, [['home', 'hero-info'], ['home', 'tab-home'], ['home', null]], 'detail');
  const tile = 'lk-tv-' + srv.world.ml.trending.tv[0].id;
  await okInto(page, tile, 'lookup');
  await backChain(t, [['home', tile], ['home', 'tab-home'], ['home', null]], 'lookup');
});

test('back chain: Search → keyboard → results → LookupDetail: Back raises Search on the card, closes Search onto its tab, then Home stays; the keyboard closes before Search', { fast: false, timeout: 90000 }, async (t) => {
  const { page } = t;
  await home(t);
  await raiseSearch(page);
  await page.key('OK', { settle: 200 });
  await waitFocus(page, 'kb-a');
  await page.chars('harbor');
  await steer(page, 'kb-done', { settle: 100 });
  await page.key('OK', { settle: 300 });
  await page.waitFor(() => document.activeElement?.closest('#search .grid'), { what: 'first result focused after Done', timeout: 8000 });
  const card = await focused(page);
  await page.key('OK', { settle: 300 });
  await page.waitFor((src) => new Function('return (' + src + ')')()() === 'lookup', { what: 'LookupDetail', timeout: 8000 }, whereInPage.toString());
  await backChain(t, [['search', card], ['home', 'tab-home'], ['home', null]], 'lookup');
  // the keyboard is its own layer
  await raiseSearch(page);
  await page.key('OK', { settle: 200 });
  await waitFocus(page, 'kb-a');
  await backChain(t, [['search', 'q2'], ['home', 'tab-home']], 'search:kb');
});

test('back chain: a Search chart grid → its card → Home; a menu (bell on Home, sort on Movies) closes onto its button first', { fast: false, timeout: 90000 }, async (t) => {
  const { page } = t;
  await home(t);
  await raiseSearch(page);
  await page.waitFor(() => document.querySelectorAll('#search .catcard').length >= 3, { what: 'category cards', timeout: 10000 });
  await okInto(page, 'cat-top-movie', 'search:chart');
  await backChain(t, [['search', 'cat-top-movie'], ['home', 'tab-home'], ['home', null]], 'search:chart');

  await okInto(page, 'nav-news', 'menu:home');
  await backChain(t, [['home', 'nav-news'], ['home', null]], 'menu:home');

  await openTabGrid(t, 'movies');
  await okInto(page, 'lv-sort', 'menu:library:movies');
  await backChain(t, [['library:movies', 'lv-sort'], ['home', 'tab-home'], ['home', null]], 'menu:library:movies');
});

test('back chain: PendingDetail from the Movies and Shows grids → its pending tile → the tab → Home', { fast: false, timeout: 90000 }, async (t) => {
  const { page } = t;
  await home(t);
  await openTabGrid(t, 'movies');
  await okInto(page, 'pend-movie:900001', 'pending');
  await backChain(t, [['library:movies', 'pend-movie:900001'], ['library:movies', 'tab-movies'], ['home', 'tab-home'], ['home', null]], 'pending');
  await openTabGrid(t, 'shows');
  await okInto(page, 'pend-tv:400001', 'pending');
  await backChain(t, [['library:shows', 'pend-tv:400001'], ['library:shows', 'tab-shows'], ['home', 'tab-home']], 'pending');
});

test('back chain: the player (OSD up) → OSD hidden → MovieDetail → Movies (tile, then tab) → Home', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const m = movie(srv.world, 1);
  await home(t);
  await openTabGrid(t, 'movies');
  await okInto(page, 'tile-' + m.Id, 'detail');
  await waitFocus(page, 'play', 8000);
  await startAndPlay(t, m);
  if ((await where(page)) !== 'player:osd') await page.key('Play', { settle: 150 }); // re-raises the OSD while playing
  assert.equal(await where(page), 'player:osd', 'OSD up');
  await backChain(t, [['player', null], ['detail', 'play'], ['library:movies', 'tile-' + m.Id], ['library:movies', 'tab-movies'], ['home', 'tab-home'], ['home', null]], 'player:osd');
});
