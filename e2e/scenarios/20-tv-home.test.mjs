/* TV Home: the rails come from the fake's play state, and the D-pad keeps the
 * focus invariants while walking into them. */
import { test, assert } from '../lib/runner.mjs';
import { ep as epOf, movie, setPosition } from '../lib/world.mjs';
import { bootTv, waitFocus, focused, press, checkFocusInvariants, scopeKeys } from '../lib/tv.mjs';

async function rails(page) {
  return page.eval(() =>
    [...document.querySelectorAll('.screen.home .rails .rail')].map((r) => ({
      title: r.querySelector('h2')?.textContent.trim(),
      keys: [...r.querySelectorAll('.strip .focus')].map((e) => e.dataset.focus)
    }))
  );
}

test('tv home: rails reflect play state and trending; D-pad keeps focus invariants', { fast: true }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  await page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 4, { what: 'four rails', timeout: 10000 });

  const R = await rails(page);
  assert.deepEqual(R.map((r) => r.title), ['Continue Watching', 'Next Up', 'Trending · Shows', 'Trending · Movies'], 'rail order');
  const movies = w.list('Movie');
  const ep = (s, n, e) => epOf(w, s, n, e);
  // Continue Watching: most recently played first (seed: NL S1E3 1 h ago, movie[2] 2 h, movie[5] 26 h)
  assert.deepEqual(R[0].keys, [ep('Northern Line', 1, 3).Id, movies[2].Id, movies[5].Id].map((id) => 'tile-' + id), 'Continue Watching');
  // Next Up: the episode after the last watched, resumable ones excluded (NL is in Continue Watching)
  assert.deepEqual(R[1].keys, [ep('Paper Kingdom', 2, 1).Id, ep('Electric Orchard', 1, 5).Id].map((id) => 'tile-' + id), 'Next Up');
  assert.equal(R[2].keys.length, w.ml.trending.tv.length, 'Trending · Shows count');
  assert.equal(R[3].keys.length, w.ml.trending.movie.length, 'Trending · Movies count');

  // the hero shows the head of Continue Watching with a Resume button
  const hero = await page.eval(() => ({ title: document.querySelector('.hero.home .title')?.textContent, btn: document.querySelector('[data-focus="hero-resume"]')?.textContent }));
  assert.equal(hero.title, 'Northern Line', 'hero title (an episode shows its series)');
  assert.match(hero.btn, /Resume · 20:00/, 'hero resume button');

  // walk: tab row → hero buttons → rails → along the rail; invariants after every press
  const path = [];
  for (const k of ['Down', 'Right', 'Right', 'Left', 'Down', 'Right', 'Right', 'Down', 'Down', 'Up', 'Up', 'Up']) {
    await page.key(k, { settle: 120 });
    const f = await focused(page);
    path.push(k + '→' + f);
    let bad = await checkFocusInvariants(page, { dupOk: ['tile-'] });
    // A hero swap (250 ms after the D-pad rests) keeps the old `.info` in the DOM,
    // inert, for its 220 ms outro — duplicate hero-* keys for that moment. That is
    // DOM reality (byKey() and Home's ▲ skip the inert copy since F-006). Only when
    // EVERY problem is such a duplicate with an inert copy, check again once the
    // outro has finished; anything else fails.
    if (bad.length && bad.every((b) => b.endsWith('(one copy is an inert outro)'))) {
      t.log(`F-006 outro duplicates after ${k}: ${bad.join('; ')}`);
      await page.waitFor(() => !document.querySelector('.screen [inert]'), { what: 'hero outro finished', timeout: 3000 });
      bad = await checkFocusInvariants(page, { dupOk: ['tile-'] });
    }
    assert.deepEqual(bad, [], `invariants after ${path.join(' ')}`);
  }
  t.log(path.join('  '));
  assert(path.some((p) => p.includes('tile-')), 'reached a rail tile: ' + path.join(' '));

  // Back on Home is a no-op (Home is the root): still Home, focus somewhere real
  await page.key('Back', { settle: 200 });
  assert(await page.eval(() => !!document.querySelector('.screen.home')), 'still on Home after Back');
  assert((await focused(page)) !== '<body>', 'focus not on body after Back');

  const scope = await scopeKeys(page);
  assert(scope.keys.includes('tab-home') && scope.keys.includes('nav-account'), 'tab row in scope: ' + scope.keys.slice(0, 8));
});

test('tv home: a fresh account (seed preset empty) has no Continue Watching / Next Up rails; one resume point (setPosition) brings Continue Watching back', { fast: false, seed: { preset: 'empty' } }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  await page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 2, { what: 'trending rails', timeout: 10000 });
  let R = await rails(page);
  assert.deepEqual(R.map((r) => r.title), ['Trending · Shows', 'Trending · Movies'], 'only the trending rails');
  assert(srv.requests({ origin: 'jf', path: '/UserItems/Resume' }).length >= 1, 'Continue Watching was asked for (and empty)');
  assert((await focused(page)) !== '<body>', 'focus not on body');
  for (const k of ['Down', 'Down', 'Right', 'Up', 'Up']) {
    await page.key(k, { settle: 150 });
    assert((await focused(page)) !== '<body>', `focus not on body after ${k}`);
    let bad = await checkFocusInvariants(page, { dupOk: ['tile-'] });
    if (bad.length && bad.every((b) => b.endsWith('(one copy is an inert outro)'))) {
      await page.waitFor(() => !document.querySelector('.screen [inert]'), { what: 'hero outro finished', timeout: 3000 });
      bad = await checkFocusInvariants(page, { dupOk: ['tile-'] });
    }
    assert.deepEqual(bad, [], 'invariants after ' + k);
  }

  // the same account picks up a movie elsewhere: a reload shows it under Continue Watching
  const m = movie(w, 4);
  setPosition(w, 'alice', m, 600);
  await page.reload();
  await waitFocus(page, 'tab-home', 15000);
  await page.waitFor(() => [...document.querySelectorAll('.screen.home .rails .rail h2')].some((h) => h.textContent.trim() === 'Continue Watching'), { what: 'Continue Watching rail', timeout: 10000 });
  R = await rails(page);
  assert.deepEqual(R[0], { title: 'Continue Watching', keys: ['tile-' + m.Id] }, 'the one resumable movie');
});

test('tv home: ▲ from the first rail during the hero crossfade lands on the hero button (F-006)', { fast: false }, async (t) => {
  const { page } = t;
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  await page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 2, { what: 'rails', timeout: 10000 });
  // A capture listener records, for every ▲ keydown, whether the hero's old
  // `.info` was still in its (inert) outro at that moment — so a run where the
  // outro had already ended is retried instead of passing vacuously.
  await page.eval(() => {
    window.__f006 = [];
    window.addEventListener('keydown', (e) => {
      if (e.keyCode === 38) window.__f006.push(!!document.querySelector('.hero.home .info[inert]'));
    }, true);
  });
  await page.key('Down', { settle: 150 });
  await waitFocus(page, 'hero-resume');
  await page.key('Down', { settle: 150 });
  const first = await waitFocus(page, /^tile-/);
  const title0 = await page.eval(() => document.querySelector('.hero.home .info .title')?.textContent);
  let inOutro = false;
  for (let i = 0; i < 5 && !inOutro; i++) {
    await page.key('Right', { settle: 0 });
    await page.waitFor((f) => document.activeElement?.dataset?.focus && document.activeElement.dataset.focus !== f, { what: 'second tile' }, first);
    // the hero follows the tile after 250 ms; wait until it shows the second
    // tile's title and that swap's outro is over
    await page.waitFor((t0) => !document.querySelector('.hero.home .info[inert]') && document.querySelectorAll('.hero.home .info').length === 1
      && document.querySelector('.hero.home .info .title')?.textContent !== t0, { what: 'hero settled on the second tile', timeout: 3000 }, title0);
    await page.key('Left', { settle: 0 });
    await waitFocus(page, first);
    // observable state, not a sleep: the swap back has started its 220 ms outro
    await page.waitFor(() => !!document.querySelector('.hero.home .info[inert]'), { what: 'hero outro started', timeout: 3000, interval: 10 });
    await page.key('Up', { settle: 0 });
    inOutro = (await page.eval(() => window.__f006.at(-1))) === true;
    await page.waitFor(() => !document.querySelector('.hero.home .info[inert]'), { what: 'hero outro finished', timeout: 3000 });
    if (!inOutro) {
      t.log(`attempt ${i + 1}: the outro had ended before ▲ arrived — again`);
      await page.waitFor(() => document.activeElement?.dataset?.focus === 'hero-resume', { what: 'focus on hero-resume', timeout: 3000 });
      await page.key('Down', { settle: 150 });
      await waitFocus(page, first);
    }
  }
  assert(inOutro, '▲ arrived while the old hero .info was still in its outro');
  const f = await focused(page);
  assert.equal(f, 'hero-resume', '▲ from the first rail during the hero crossfade');
  assert(await page.eval(() => !document.activeElement.closest('[inert]')), 'focus is not inside an inert copy');
});
