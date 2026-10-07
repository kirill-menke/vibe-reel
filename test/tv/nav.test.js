/* nav.svelte.js (TV only — the phone build swaps it for the router shim):
 * one $state object, no history stack; onBack() derives the parent screen.
 *
 * CLAUDE.md, "Navigation state":
 * - "S.epoch — bumped by every open*(). App.svelte wraps the screen in
 *   {#key S.epoch}, so re-navigating to the same screen remounts and refetches."
 * - "S.base — the browse screen mounted behind any overlay."
 * - Search "is not a tab": S.search raises it over whatever tab is mounted,
 *   "S.screen/S.base don't change … Back closes it and restores focus to the tab
 *   it was raised from"; openFromSearch() "remembers the card, so Back from any
 *   of those raises Search again on it".
 * - "openLookup()/openPending() now push the detail trail, so Back from a
 *   collection film returns to the tile it was opened from"
 * - "Back from a detail screen re-focuses the Home tile it came from
 *   (takeHomeFocus(), like the grid's takeGridFocus())".
 * - "Add account opens Login with S.addingAccount: Back returns to Home". */
import { describe, it, expect, beforeEach } from 'vitest';
import { freshImport } from '../helpers/modules.js';

let N, S;

beforeEach(async () => {
  N = (await freshImport({ modules: { nav: 'src/lib/nav.svelte.js' } })).nav;
  S = N.S;
});

/** what the focusin handler (Keys.svelte) would have recorded */
const focusOn = (k) => (S.focusKey = k);

function where() {
  return { screen: S.screen, base: S.base };
}

describe('S: the initial state', () => {
  it('boots on the splash with Home mounted behind it', () => {
    expect(S.screen).toBe('boot');
    expect(S.base).toBe('home');
    expect(S.tab).toBe('home');
    expect(S.epoch).toBe(0);
    expect(S.search).toBe(false);
  });
});

describe('open*(): screen + base set, S.epoch bumped (remount + refetch)', () => {
  const cases = [
    ['openHome', () => N.openHome(), 'home'],
    ['openLibrary', () => N.openLibrary('movies'), 'library'],
    ['openItem', () => N.openItem('i1', 'Movie'), 'detail'],
    ['openPerson', () => N.openPerson('p1', 'Actor'), 'person'],
    ['openLookup', () => N.openLookup({ title: 'X' }), 'lookup'],
    ['openPending', () => N.openPending('g1'), 'pending'],
    ['openLogin', () => N.openLogin(), 'login']
  ];
  for (const [name, call, scr] of cases) {
    it(name + ' → ' + scr, () => {
      const e = S.epoch;
      call();
      expect(where()).toEqual({ screen: scr, base: scr });
      expect(S.epoch).toBe(e + 1);
      call();   // the same screen again still remounts
      expect(S.epoch).toBe(e + 2);
    });
  }

  it('openItem / openPerson / openLookup / openPending carry their address', () => {
    N.openItem('i1', 'Series');
    expect([S.detailId, S.detailType]).toEqual(['i1', 'Series']);
    N.openPerson('p1', 'Actor Name');
    expect([S.personId, S.personName]).toEqual(['p1', 'Actor Name']);
    N.openPerson('p2');
    expect(S.personName).toBe('');
    const look = { title: 'X', tmdbId: 5 };
    N.openLookup(look);
    expect(S.lookup).toEqual(look);
    N.openPending('g1');
    expect(S.pendingKey).toBe('g1');
  });

  it('openLibrary / openHome set the tab', () => {
    N.openLibrary('shows');
    expect(S.tab).toBe('shows');
    N.openHome();
    expect(S.tab).toBe('home');
  });

  it('openLogin(true) is the avatar menu’s Add account; openLogin() a plain sign-in', () => {
    N.openLogin(true);
    expect(S.addingAccount).toBe(true);
    N.openLogin();
    expect(S.addingAccount).toBe(false);
  });

  it('openPending leaves S.tab on the library tab it was opened from (that is where Back goes)', () => {
    N.openLibrary('shows');
    N.openPending('g1');
    expect(S.tab).toBe('shows');
  });
});

describe('onBack(): the parent is derived', () => {
  it('library → home', () => {
    N.openLibrary('movies');
    N.onBack();
    expect(where()).toEqual({ screen: 'home', base: 'home' });
  });

  it('home, boot, plain login and the player: no-op (the player’s Back is playerKey’s)', () => {
    for (const scr of ['home', 'boot', 'login', 'player']) {
      S.screen = scr;
      S.addingAccount = false;
      const e = S.epoch;
      N.onBack();
      expect(S.screen, scr).toBe(scr);
      expect(S.epoch).toBe(e);
    }
  });

  it('Login raised by Add account: Back returns to Home as the signed-in account', () => {
    N.openHome();
    N.openLogin(true);
    N.onBack();
    expect(S.screen).toBe('home');
  });

  it('detail opened from a library grid → that library tab, re-focusing the tile (one-shot)', () => {
    N.openLibrary('movies');
    N.openItem('m7', 'Movie');
    N.onBack();
    expect(where()).toEqual({ screen: 'library', base: 'library' });
    expect(S.tab).toBe('movies');
    expect(N.takeGridFocus()).toBe('tile-m7');
    expect(N.takeGridFocus()).toBeNull();
  });

  it('pending opened from the grid → the grid on its pend- tile', () => {
    N.openLibrary('shows');
    N.openPending('grp-4');
    N.onBack();
    expect(S.screen).toBe('library');
    expect(N.takeGridFocus()).toBe('pend-grp-4');
  });

  it('the grid memory is per tab', () => {
    N.openLibrary('movies');
    N.openItem('m1', 'Movie');
    N.openLibrary('shows');
    N.openItem('s1', 'Series');
    N.onBack();
    expect(N.takeGridFocus()).toBe('tile-s1');
    N.openLibrary('movies');
    expect(N.takeGridFocus()).toBeNull();   // a plain tab click keeps focus on the pill
    N.openItem('m2', 'Movie');
    N.onBack();
    expect(N.takeGridFocus()).toBe('tile-m2');
  });

  it('detail opened from Home → Home, on the rail tile it came from (one-shot; peek does not consume)', () => {
    N.openHome();
    focusOn('tile-latest-3');
    N.openItem('m1', 'Movie');
    expect(N.peekHomeFocus()).toBeNull();   // not a return yet
    N.onBack();
    expect(where()).toEqual({ screen: 'home', base: 'home' });
    expect(N.peekHomeFocus()).toBe('tile-latest-3');
    expect(N.takeHomeFocus()).toBe('tile-latest-3');
    expect(N.takeHomeFocus()).toBeNull();
    expect(N.peekHomeFocus()).toBeNull();
  });

  it('lookup and pending opened from Home → Home on their tile', () => {
    N.openHome();
    focusOn('trend-2');
    N.openLookup({ title: 'T' });
    N.onBack();
    expect(S.screen).toBe('home');
    expect(N.takeHomeFocus()).toBe('trend-2');
    focusOn('hero-info');
    N.openPending('g1');
    N.onBack();
    expect(N.takeHomeFocus()).toBe('hero-info');
  });

  it('a plain openHome() is not a return: no stale Home focus handed over', () => {
    N.openHome();
    focusOn('tile-x');
    N.openItem('m1', 'Movie');
    N.onBack();
    N.openHome();
    expect(N.takeHomeFocus()).toBeNull();
  });

  it('returnHome(focus) (exit from a video started on Home) → Home on that key', () => {
    S.screen = 'player';
    N.returnHome('hero-resume');
    expect(S.screen).toBe('home');
    expect(N.takeHomeFocus()).toBe('hero-resume');
    N.returnHome();
    expect(N.takeHomeFocus()).toBeNull();
  });

  it('person with no trail (cannot normally happen) falls back to the tab', () => {
    N.openLibrary('shows');
    S.screen = 'person';
    N.onBack();
    expect(S.screen).toBe('library');
  });
});

describe('the detail trail: detail → detail → Back', () => {
  it('More Like This: Back re-opens the page in between, on the element it was left on', () => {
    N.openLibrary('movies');
    N.openItem('a', 'Movie');
    focusOn('more-b');
    N.openItem('b', 'Movie');
    focusOn('more-c');
    N.openItem('c', 'Movie');
    const e = S.epoch;
    N.onBack();
    expect([S.screen, S.detailId]).toEqual(['detail', 'b']);
    expect(S.epoch).toBe(e + 1);
    expect(N.takeDetailFocus()).toBe('more-c');
    expect(N.takeDetailFocus()).toBeNull();
    N.onBack();
    expect([S.screen, S.detailId, S.detailType]).toEqual(['detail', 'a', 'Movie']);
    expect(N.takeDetailFocus()).toBe('more-b');
    N.onBack();
    expect(S.screen).toBe('library');
    expect(N.takeGridFocus()).toBe('tile-a');
  });

  it('a cast member: detail → person → Back to the detail on the cast tile; person → title → Back to the person', () => {
    N.openItem('film', 'Movie');
    focusOn('cast-3');
    N.openPerson('p9', 'Someone');
    focusOn('ptile-x');
    N.openItem('x', 'Movie');
    N.onBack();
    expect([S.screen, S.personId, S.personName]).toEqual(['person', 'p9', 'Someone']);
    expect(N.takeDetailFocus()).toBe('ptile-x');
    N.onBack();
    expect([S.screen, S.detailId]).toEqual(['detail', 'film']);
    expect(N.takeDetailFocus()).toBe('cast-3');
  });

  it('a collection film: detail → lookup / pending → Back to the detail on its tile', () => {
    N.openItem('alien', 'Movie');
    focusOn('coll-2');
    N.openLookup({ title: 'Aliens' });
    N.onBack();
    expect([S.screen, S.detailId]).toEqual(['detail', 'alien']);
    expect(N.takeDetailFocus()).toBe('coll-2');
    focusOn('coll-3');
    N.openPending('g-alien3');
    N.onBack();
    expect([S.screen, S.detailId]).toEqual(['detail', 'alien']);
    expect(N.takeDetailFocus()).toBe('coll-3');
  });

  it('lookup → its Jellyfin detail → Back re-opens the lookup with the same item', () => {
    const look = { title: 'L', tmdbId: 1 };
    N.openLookup(look);
    focusOn('lk-open');
    N.openItem('j1', 'Movie');
    N.onBack();
    expect(S.screen).toBe('lookup');
    expect(S.lookup).toEqual(look);
  });

  it('re-opening the detail already shown (a refresh) does not push it onto the trail', () => {
    N.openHome();
    N.openItem('a', 'Movie');
    N.openItem('a', 'Movie');
    N.onBack();
    expect(S.screen).toBe('home');
  });

  it('a detail opened from the player (exit) is not a step forward', () => {
    N.openItem('a', 'Movie');
    S.screen = 'player';
    N.openItem('a', 'Movie');
    N.onBack();
    expect(S.screen).toBe('home');
  });

  it('the trail is capped at 10: the 11th Back goes to the tab, not the oldest page', () => {
    N.openHome();
    for (let i = 0; i <= 11; i++) N.openItem('d' + i, 'Movie');   // pushes d0 … d10
    const seen = [];
    for (let i = 0; i < 10; i++) {
      N.onBack();
      seen.push(S.detailId);
    }
    expect(seen).toEqual(['d10', 'd9', 'd8', 'd7', 'd6', 'd5', 'd4', 'd3', 'd2', 'd1']);
    expect(S.screen).toBe('detail');
    N.onBack();
    expect(S.screen).toBe('home');
  });

  it('a tab switch starts the trail afresh (openHome / openLibrary)', () => {
    N.openItem('a', 'Movie');
    N.openItem('b', 'Movie');
    N.openLibrary('movies');
    N.openItem('c', 'Movie');
    N.onBack();
    expect(S.screen).toBe('library');
    N.openItem('a', 'Movie');
    N.openItem('b', 'Movie');
    N.openHome();
    N.openItem('c', 'Movie');
    N.onBack();
    expect(S.screen).toBe('home');
  });

  it('a new open*() drops a takeDetailFocus nobody consumed', () => {
    N.openItem('a', 'Movie');
    focusOn('x');
    N.openItem('b', 'Movie');
    N.onBack();
    N.openItem('c', 'Movie');
    expect(N.takeDetailFocus()).toBeNull();
  });
});

describe('Search: an overlay, not a screen', () => {
  it('openSearch raises it without touching screen/base/epoch; closeSearch returns the tab key it came from', () => {
    N.openLibrary('movies');
    focusOn('tab-movies');
    const before = { ...where(), epoch: S.epoch };
    N.openSearch();
    expect(S.search).toBe(true);
    expect({ ...where(), epoch: S.epoch }).toEqual(before);
    focusOn('q2');
    N.openSearch();   // already up: keeps the original return key
    S.searchChart = 'top250';
    S.searchKb = true;
    expect(N.closeSearch()).toBe('tab-movies');
    expect(S.search).toBe(false);
    expect(S.searchChart).toBeNull();
    expect(S.searchKb).toBe(false);
    expect(N.closeSearch()).toBeNull();
  });

  it('closeSearchChart returns its card key (cat-<key>) and closes the category', () => {
    S.searchChart = 'genre-drama';
    expect(N.closeSearchChart()).toBe('cat-genre-drama');
    expect(S.searchChart).toBeNull();
  });

  it('a result → its detail → Back raises Search again on the same card, over the rebuilt tab', () => {
    N.openLibrary('shows');
    N.openSearch();
    N.openFromSearch('res-4', () => N.openItem('s1', 'Series'));
    expect(S.search).toBe(false);
    expect(S.screen).toBe('detail');
    N.onBack();
    expect(where()).toEqual({ screen: 'library', base: 'library' });
    expect(S.tab).toBe('shows');
    expect(S.search).toBe(true);
    expect(S.searchFocus).toBe('res-4');
    expect(N.takeGridFocus()).toBeNull();   // the grid memory was not written by a search result
  });

  it('… the same from Home, for lookup and pending results, without handing Home a tile', () => {
    for (const open of [() => N.openLookup({ title: 'X' }), () => N.openPending('g1')]) {
      N.openHome();
      focusOn('tab-home');
      N.openSearch();
      N.openFromSearch('res-1', open);
      N.onBack();
      expect(S.screen).toBe('home');
      expect(S.search).toBe(true);
      expect(S.searchFocus).toBe('res-1');
      expect(N.takeHomeFocus()).toBeNull();
      N.closeSearch();
    }
  });

  it('result → detail → More Like This → Back, Back: the trail first, then Search', () => {
    N.openHome();
    N.openSearch();
    N.openFromSearch('res-2', () => N.openItem('a', 'Movie'));
    N.openItem('b', 'Movie');
    N.onBack();
    expect([S.screen, S.detailId, S.search]).toEqual(['detail', 'a', false]);
    N.onBack();
    expect(S.search).toBe(true);
    expect(S.searchFocus).toBe('res-2');
  });

  it('a tab switch forgets the search return', () => {
    N.openLibrary('movies');
    N.openSearch();
    N.openFromSearch('res-1', () => N.openItem('a', 'Movie'));
    N.openLibrary('movies');
    N.openItem('b', 'Movie');
    N.onBack();
    expect(S.search).toBe(false);
    expect(N.takeGridFocus()).toBe('tile-b');
  });
});
