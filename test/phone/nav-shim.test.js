/* The phone's nav.svelte.js: phone/vite.config.js redirects every import of
 * src/lib/nav.svelte.js to phone/src/lib/nav.svelte.js, which maps the TV's
 * open*() calls onto the phone router (one push stack per tab, sheets, the
 * player and login modals). The test imports the TV path, exactly as the shared
 * engine does, and gets the shim.
 *
 * CLAUDE.md: "Sharing = three module redirects + one define … nav.svelte.js →
 * the phone router shim (exports every TV name; S.screen = 'player' opens the
 * player modal)". The shim's own rule: "while the player modal is up, an
 * open*() whose target is the route already under the modal only closes the
 * modal — the page is still mounted, it just refetches play state off
 * R.playerClosed. Any other target closes the modal and pushes." */
import { describe, it, expect, beforeEach } from 'vitest';
import { freshImport } from '../helpers/modules.js';

let N, S, R, router;

beforeEach(async () => {
  const m = await freshImport({
    modules: { nav: 'src/lib/nav.svelte.js', router: 'phone/src/lib/router.svelte.js' }
  });
  N = m.nav;
  router = m.router;
  R = router.R;
  S = N.S;
  router.markBooted();
});

const names = (tab) => router.stack(tab).map((r) => r.name);

describe('the redirect', () => {
  it('src/lib/nav.svelte.js resolves to the shim: the router’s S, and every TV export', () => {
    expect(S).toBe(router.S);
    for (const k of ['openHome', 'returnHome', 'openLibrary', 'openItem', 'openPerson', 'openLookup', 'openPending', 'openLogin',
      'openSearch', 'closeSearch', 'closeSearchChart', 'openFromSearch', 'onBack', 'takeGridFocus', 'takeHomeFocus',
      'peekHomeFocus', 'takeDetailFocus']) {
      expect(typeof N[k], k).toBe('function');
    }
  });

  it('the TV focus memories are the D-pad’s concern: always null here', () => {
    expect([N.takeGridFocus(), N.takeHomeFocus(), N.peekHomeFocus(), N.takeDetailFocus()]).toEqual([null, null, null, null]);
  });
});

describe('open*() pushes onto the active tab, and S mirrors the top route', () => {
  it('openItem → a detail route; S.screen / S.base / S.detailId / S.detailType follow, epoch bumps', () => {
    const e = S.epoch;
    N.openItem('m1', 'Movie');
    expect(names('home')).toEqual(['home', 'detail']);
    expect(router.top().params).toEqual({ id: 'm1', type: 'Movie' });
    expect([S.screen, S.base, S.detailId, S.detailType]).toEqual(['detail', 'detail', 'm1', 'Movie']);
    expect(S.epoch).toBe(e + 1);
  });

  it('openPerson / openLookup / openPending', () => {
    N.openPerson('p1', 'Actor');
    expect([S.screen, S.personId, S.personName]).toEqual(['person', 'p1', 'Actor']);
    N.openPerson('p2');
    expect(S.personName).toBe('');
    const look = { title: 'X', tmdbId: 3 };
    N.openLookup(look);
    expect(S.screen).toBe('lookup');
    expect(S.lookup).toBe(look);   // $state.raw: the caller's object itself
    N.openPending('g1');
    expect([S.screen, S.pendingKey]).toEqual(['pending', 'g1']);
    expect(names('home')).toEqual(['home', 'person', 'person', 'lookup', 'pending']);
  });

  it('openLibrary switches tab (the movies/shows roots are "library" in TV words)', () => {
    N.openLibrary('shows');
    expect(R.tab).toBe('shows');
    expect([S.screen, S.base, S.tab]).toEqual(['shows', 'library', 'shows']);
    N.openLibrary('anything-else');
    expect(R.tab).toBe('movies');
  });

  it('openHome from another tab switches back to Home as it was left; on Home a pushed page stays', () => {
    N.openItem('m1', 'Movie');
    N.openLibrary('movies');
    N.openHome();
    expect(R.tab).toBe('home');
    expect(names('home')).toEqual(['home', 'detail']);
    N.openHome();
    expect(names('home')).toEqual(['home', 'detail']);
    N.returnHome('hero-resume');   // the same thing on the phone
    expect(R.tab).toBe('home');
  });

  it('openSearch is the Search tab; closeSearch has nothing to lower', () => {
    N.openSearch();
    expect(R.tab).toBe('search');
    expect(N.closeSearch()).toBeNull();
    expect(R.tab).toBe('search');
  });

  it('closeSearchChart pops an open chart route and clears S.searchChart', () => {
    N.openSearch();
    router.push('chart', { key: 'top250' });
    expect(S.searchChart).toBe('top250');
    expect(N.closeSearchChart()).toBeNull();
    expect(names('search')).toEqual(['search']);
    expect(S.searchChart).toBeNull();
    expect(N.closeSearchChart()).toBeNull();   // nothing open: no pop of the root
    expect(names('search')).toEqual(['search']);
  });

  it('openFromSearch just opens (Search is a tab: its stack is still there on Back)', () => {
    N.openSearch();
    N.openFromSearch('res-1', () => N.openItem('s1', 'Series'));
    expect(names('search')).toEqual(['search', 'detail']);
    N.onBack();
    expect(names('search')).toEqual(['search']);
  });
});

describe('the player modal: S.screen = "player" raises it, S.screen = S.base lowers it', () => {
  it('raising closes a sheet; lowering bumps R.playerClosed (pages refetch play state)', () => {
    N.openItem('m1', 'Movie');
    router.openSheet('tracks');
    S.screen = 'player';
    expect(R.modal).toBe('player');
    expect(R.sheet).toBeNull();
    expect(S.screen).toBe('player');
    const closed = R.playerClosed;
    S.screen = S.base;
    expect(R.modal).toBeNull();
    expect(S.screen).toBe('detail');
    expect(R.playerClosed).toBe(closed + 1);
  });

  it('a quiet player (a trailer) closes without the bump', () => {
    S.screen = 'player';
    R.playerQuiet = true;
    const closed = R.playerClosed;
    S.screen = S.base;
    expect(R.modal).toBeNull();
    expect(R.playerClosed).toBe(closed);
  });

  it('an open*() to the route under the modal only closes it — no push, no remount', () => {
    N.openItem('m1', 'Movie');
    S.screen = 'player';
    const e = S.epoch;
    N.openItem('m1', 'Movie');
    expect(R.modal).toBeNull();
    expect(names('home')).toEqual(['home', 'detail']);
    expect(S.screen).toBe('detail');
    expect(S.epoch).toBe(e);   // sync(false): the page stays mounted
  });

  it('… for pending (same key), lookup (same object or same ids) and person too', () => {
    N.openPending('g1');
    S.screen = 'player';
    N.openPending('g1');
    expect(names('home')).toEqual(['home', 'pending']);

    const look = { title: 'Film', year: 2024, tmdbId: 9 };
    N.openLookup(look);
    S.screen = 'player';
    N.openLookup({ title: 'Film', year: 2024, tmdbId: 9 });   // an equal copy
    expect(names('home')).toEqual(['home', 'pending', 'lookup']);
    expect(R.modal).toBeNull();

    N.openPerson('p1', 'A');
    S.screen = 'player';
    N.openPerson('p1', 'A');
    expect(names('home')).toEqual(['home', 'pending', 'lookup', 'person']);
  });

  it('any other target closes the modal and pushes', () => {
    N.openItem('ep-1', 'Episode');
    S.screen = 'player';
    N.openItem('series-1', 'Series');
    expect(R.modal).toBeNull();
    expect(names('home')).toEqual(['home', 'detail', 'detail']);
    expect(S.detailId).toBe('series-1');

    S.screen = 'player';
    N.openLookup({ title: 'Other', tmdbId: 1 });
    expect(R.modal).toBeNull();
    expect(router.top().name).toBe('lookup');
  });

  it('openHome / openLibrary / openSearch from the player close it first', () => {
    S.screen = 'player';
    N.openHome();
    expect(R.modal).toBeNull();
    expect(S.screen).toBe('home');
    S.screen = 'player';
    N.openLibrary('movies');
    expect([R.modal, R.tab]).toEqual([null, 'movies']);
    S.screen = 'player';
    N.openSearch();
    expect([R.modal, R.tab]).toEqual([null, 'search']);
  });

  it('openHome from the player on another tab goes to Home', () => {
    N.openLibrary('shows');
    S.screen = 'player';
    N.openHome();
    expect([R.modal, R.tab]).toEqual([null, 'home']);
  });
});

describe('Login and Back', () => {
  it('openLogin(true) raises Login over the session (closing player and sheet); Back cancels it', () => {
    router.openSheet('accounts');
    S.screen = 'player';
    N.openLogin(true);
    expect(R.modal).toBe('login');
    expect(R.sheet).toBeNull();
    expect(S.screen).toBe('login');
    expect(S.addingAccount).toBe(true);
    N.onBack();
    expect(R.modal).toBeNull();
    expect(S.addingAccount).toBe(false);
    expect(S.screen).toBe('home');
  });

  it('a plain sign-in Login ignores Back', () => {
    N.openLogin();
    N.onBack();
    expect(R.modal).toBe('login');
  });

  it('an open*() leaves Login first', () => {
    N.openLogin(true);
    N.openHome();
    expect(R.modal).toBeNull();
    N.openLogin(true);
    N.openLibrary('movies');
    expect(R.modal).toBeNull();
  });

  it('Back closes a sheet before popping; at a root it is a no-op', () => {
    N.openItem('m1', 'Movie');
    router.openSheet('tracks');
    N.onBack();
    expect(R.sheet).toBeNull();
    expect(names('home')).toEqual(['home', 'detail']);
    N.onBack();
    expect(names('home')).toEqual(['home']);
    N.onBack();
    expect(names('home')).toEqual(['home']);
  });

  it('resetTab is re-exported for phone callers', () => {
    N.openLibrary('movies');
    N.openItem('m1', 'Movie');
    N.resetTab('movies');
    expect(names('movies')).toEqual(['movies']);
  });
});
