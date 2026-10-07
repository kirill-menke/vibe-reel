/* The small src/lib modules: played.js, libview.svelte.js, account.svelte.js,
 * toast.svelte.js, header.svelte.js, icons.js, decoded.js.
 *
 * CLAUDE.md:
 * - Watched state: "`setPlayed(id, bool)` → `POST/DELETE /UserPlayedItems/{id}?userId=`
 *   (the legacy `/Users/{uid}/PlayedItems` route is not in 12.1's spec) …
 *   `invalidatePlayState()` drops Home's SWR entries for Resume, Latest and
 *   `/Shows/NextUp`"; api.js: "`invalidatePlayState()` also drops parked item warms".
 * - Library grid: "Sort / filter are server-side (SortBy/SortOrder comma lists …).
 *   Shows' 'New episodes' sorts by `DateLastContentAdded`. Per-tab view
 *   (`reel.libview`, localStorage) survives restarts."
 * - Avatar = accounts: "`reel.accounts` remembers every account signed in on the TV
 *   (token included) … Switching and signing out reload the app … The picture is
 *   `/UserImage?userId=` (the `/Users/{id}/Images` route is gone since 10.9); a 404
 *   falls back to the initial."
 * - Toast Undo: "The toast offers ▶ Undo — the remote's Play key while it is up
 *   (`toast(msg, undo)` / `takeUndo()`)"; phone: "an Undo needs time to reach with a
 *   thumb (design: 5 s)".
 * - Icons: "Icons are inline SVG via `src/lib/icons.js` + `Icon.svelte` … never glyphs."
 * - Engine costs: "Give big images their src only after a detached `Image.decode()`:
 *   `use:decoded={url}` (`src/lib/decoded.js`)". */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { freshImport, TEST_SERVER, TEST_USER, TEST_TOKEN } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock, flushPromises } from '../helpers/time.js';
import { readJSON } from '../helpers/storage.js';

const PHONE = __PHONE__;
const ROOT = path.resolve(import.meta.dirname, '../..');

describe('played.js', () => {
  let played, api, net, n;
  beforeEach(async () => {
    ({ played, api } = await freshImport({ modules: { played: 'src/lib/played.js', api: 'src/lib/api.js' } }));
    net = mockFetch();
    n = 0;
    net.on('GET', () => true, () => ({ n: ++n, Items: [] }));
  });

  it('setPlayed(id, true) POSTs /UserPlayedItems/{id}?userId=, false DELETEs; resolves to the UserData', async () => {
    net.on('POST', '/UserPlayedItems/ep1', { Played: true, PlaybackPositionTicks: 0 });
    net.on('DELETE', '/UserPlayedItems/ep1', { Played: false });
    expect(await played.setPlayed('ep1', true)).toEqual({ Played: true, PlaybackPositionTicks: 0 });
    expect(await played.setPlayed('ep1', false)).toEqual({ Played: false });
    expect(net.calls.map((c) => c.method + ' ' + c.url)).toEqual([
      'POST ' + TEST_SERVER + '/UserPlayedItems/ep1?userId=' + TEST_USER,
      'DELETE ' + TEST_SERVER + '/UserPlayedItems/ep1?userId=' + TEST_USER
    ]);
  });

  async function fill(paths) {
    for (const p of paths) await api.revalidate(p);
    return () => paths.filter((p) => api.cached(p) != null);
  }

  const resume = '/UserItems/Resume?userId=u1&Limit=12';
  const latest = '/Items/Latest?userId=u1&ParentId=lib';
  const nextUp = '/Shows/NextUp?userId=u1&EnableResumable=false';
  const seasons = '/Shows/s1/Seasons?userId=u1';
  const grid = '/Items?userId=u1&ParentId=lib&StartIndex=0';

  it('a watched toggle drops Resume, Latest, Next Up, the seasons warm and every item warm — not the grid', async () => {
    const item = '/Items/ep1?userId=u1';
    const left = await fill([resume, latest, nextUp, seasons, grid, item]);
    net.on('POST', () => true, {});
    await played.setPlayed('ep1', true);
    expect(left()).toEqual([grid]);
  });

  it('a failed toggle invalidates nothing', async () => {
    const left = await fill([resume, nextUp]);
    net.on('POST', () => true, net.status(500));
    await expect(played.setPlayed('ep1', true)).rejects.toThrow();
    expect(left()).toEqual([resume, nextUp]);
  });

  it('invalidatePlayState(itemId) (a playback stop) drops only that item’s warm, so Up Next’s warm of the next episode survives', async () => {
    const left = await fill([resume, '/Items/ep1?userId=u1', '/Items/ep2?userId=u1', grid]);
    played.invalidatePlayState('ep1');
    expect(left()).toEqual(['/Items/ep2?userId=u1', grid]);
  });

  it('parked prefetches go too (a warm carries UserData)', async () => {
    const p1 = api.prefetch('/Items/ep1?userId=u1');
    await p1;
    played.invalidatePlayState('ep1');
    const p2 = api.prefetch('/Items/ep1?userId=u1');
    expect(p2).not.toBe(p1);
    expect((await p2).n).toBe(2);
  });
});

describe('libview.svelte.js', () => {
  async function load(storage = {}) {
    return (await freshImport({ storage, modules: { lv: 'src/lib/libview.svelte.js' } })).lv;
  }

  it('defaults: Recently added, all genres, watched too; nothing filtered', async () => {
    const lv = await load();
    for (const tab of ['movies', 'shows']) {
      expect(lv.viewOf(tab)).toEqual({ sort: 'added', genre: '', unwatched: false });
      expect(lv.isFiltered(tab)).toBe(false);
    }
    expect(lv.LV.open).toBeNull();
  });

  it('sorts are server-side SortBy/SortOrder lists with SortName as the tie-breaker; Shows “New episodes” = DateLastContentAdded', async () => {
    const lv = await load();
    for (const list of Object.values(lv.SORTS)) {
      for (const s of list) {
        expect(s.by.split(',').length).toBe(s.order.split(',').length);
        expect(s.by.split(',').pop()).toBe('SortName');
      }
    }
    expect(lv.sortOf('movies')).toMatchObject({ id: 'added', by: 'DateCreated,SortName', order: 'Descending,Ascending' });
    expect(lv.sortOf('shows')).toMatchObject({ id: 'added', label: 'New episodes', by: 'DateLastContentAdded,SortName' });
    expect(lv.SORTS.movies.find((s) => s.id === 'runtime').order).toBe('Ascending,Ascending');
    expect(lv.SORTS.shows.some((s) => s.id === 'runtime')).toBe(false);
  });

  it('setView persists per tab in reel.libview and survives a restart', async () => {
    let lv = await load();
    lv.setView('shows', { sort: 'rating', genre: 'Drama' });
    lv.setView('movies', { unwatched: true });
    expect(readJSON('reel.libview')).toEqual({
      movies: { sort: 'added', genre: '', unwatched: true },
      shows: { sort: 'rating', genre: 'Drama', unwatched: false }
    });
    lv = await load({ 'reel.libview': localStorage.getItem('reel.libview') });
    expect(lv.viewOf('shows')).toEqual({ sort: 'rating', genre: 'Drama', unwatched: false });
    expect(lv.sortOf('shows').by).toBe('CommunityRating,SortName');
    expect(lv.isFiltered('movies')).toBe(true);
    expect(lv.isFiltered('shows')).toBe(true);
  });

  it('clearFilters keeps the sort', async () => {
    const lv = await load({ 'reel.libview': JSON.stringify({ movies: { sort: 'year', genre: 'Horror', unwatched: true } }) });
    lv.clearFilters('movies');
    expect(lv.viewOf('movies')).toEqual({ sort: 'year', genre: '', unwatched: false });
    expect(lv.isFiltered('movies')).toBe(false);
  });

  it('an unknown sort id falls back to the first; an unknown tab is ignored', async () => {
    const lv = await load({ 'reel.libview': JSON.stringify({ shows: { sort: 'runtime' } }) });
    expect(lv.sortOf('shows').id).toBe('added');   // shows have no runtime sort
    lv.setView('music', { sort: 'title' });
    expect(lv.LV.music).toBeUndefined();
    expect(lv.viewOf('music')).toEqual({ sort: 'added', genre: '', unwatched: false });
    expect(lv.sortOf('music').id).toBe('added');
  });

  it.each([['not JSON', '{x'], ['null', 'null'], ['a string', '"s"']])('a broken store (%s) gives the defaults', async (_, raw) => {
    const lv = await load({ 'reel.libview': raw });
    expect(lv.viewOf('movies')).toEqual({ sort: 'added', genre: '', unwatched: false });
  });

  it('openMenu / closeMenu: the dropdown that is down', async () => {
    const lv = await load();
    lv.openMenu('genre');
    expect(lv.LV.open).toBe('genre');
    lv.closeMenu();
    expect(lv.LV.open).toBeNull();
  });
});

describe('account.svelte.js', () => {
  let acc, config, net, reload;
  const other = { server: 'http://jf2.test', userId: 'u2', userName: 'zoe', token: 'tok-u2' };

  async function load(storage = {}) {
    ({ acc, config } = await freshImport({ storage, modules: { acc: 'src/lib/account.svelte.js', config: 'src/lib/config.js' } }));
    net = mockFetch();
    reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload, href: window.location.href, origin: window.location.origin });
  }

  it('keeps only well-formed accounts from reel.accounts', async () => {
    await load({ 'reel.accounts': JSON.stringify([null, 'x', { server: 's' }, other, { server: 'a', userId: 'b' }]) });
    expect(acc.accounts.list).toEqual([other]);
  });

  it.each([['not JSON', '[x'], ['an object', '{}'], ['null', 'null']])('a broken store (%s) is an empty list', async (_, raw) => {
    await load({ 'reel.accounts': raw });
    expect(acc.accounts.list).toEqual([]);
  });

  it('rememberCurrent adds the session once and refreshes its token', async () => {
    await load({ 'reel.accounts': JSON.stringify([other]) });
    acc.rememberCurrent();
    acc.rememberCurrent();
    expect(acc.accounts.list).toHaveLength(2);
    expect(acc.accounts.list[1]).toEqual({ server: TEST_SERVER, userId: TEST_USER, userName: 'Tester', token: TEST_TOKEN });
    config.cfg.token = 'tok-new';
    acc.rememberCurrent();
    expect(readJSON('reel.accounts')[1].token).toBe('tok-new');
  });

  it('rememberCurrent without a session does nothing', async () => {
    await load({ 'reel.token': '', 'reel.userId': '' });
    acc.rememberCurrent();
    expect(acc.accounts.list).toEqual([]);
    expect(localStorage.getItem('reel.accounts')).toBeNull();
  });

  it('isCurrent needs the same user on the same server', async () => {
    await load();
    expect(acc.isCurrent({ server: TEST_SERVER, userId: TEST_USER })).toBe(true);
    expect(acc.isCurrent({ server: 'http://jf2.test', userId: TEST_USER })).toBe(false);
    expect(acc.isCurrent({ server: TEST_SERVER, userId: 'u2' })).toBe(false);
  });

  it('avatarUrl is /UserImage?userId= on the account’s own server; initial falls back to ?', async () => {
    await load();
    expect(acc.avatarUrl(other)).toBe('http://jf2.test/UserImage?userId=u2&maxHeight=96&quality=90');
    expect(acc.avatarUrl({ server: 'http://s', userId: 'a b' }, 200)).toBe('http://s/UserImage?userId=a%20b&maxHeight=200&quality=90');
    expect(acc.initial({ userName: '  zoe' })).toBe('Z');
    expect(acc.initial({ userName: '' })).toBe('?');
    expect(acc.initial({})).toBe('?');
  });

  it('switchTo another account saves its session and reloads; the current one is a no-op', async () => {
    await load();
    acc.switchTo({ server: TEST_SERVER, userId: TEST_USER });
    expect(reload).not.toHaveBeenCalled();
    acc.switchTo(other);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('reel.server')).toBe('http://jf2.test');
    expect(localStorage.getItem('reel.userId')).toBe('u2');
    expect(localStorage.getItem('reel.token')).toBe('tok-u2');
  });

  it('signOut revokes the token, forgets the account and carries on as the next one', async () => {
    await load({ 'reel.accounts': JSON.stringify([{ server: TEST_SERVER, userId: TEST_USER, userName: 'Tester', token: TEST_TOKEN }, other]) });
    net.on('POST', '/Sessions/Logout', null);
    await acc.signOut();
    expect(net.callsTo('/Sessions/Logout')).toHaveLength(1);
    expect(net.calls[0].headers.Authorization).toContain('Token="' + TEST_TOKEN + '"');
    expect(readJSON('reel.accounts')).toEqual([other]);
    expect(localStorage.getItem('reel.userId')).toBe('u2');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('signOut of the last account (even with the server unreachable) clears the session for Login', async () => {
    await load({ 'reel.accounts': JSON.stringify([{ server: TEST_SERVER, userId: TEST_USER, userName: 'Tester', token: TEST_TOKEN }]) });
    net.on('POST', '/Sessions/Logout', net.networkError());
    await acc.signOut();
    expect(acc.accounts.list).toEqual([]);
    expect(config.cfg.token).toBe('');
    expect(config.cfg.userId).toBe('');
    expect(localStorage.getItem('reel.token') || '').toBe('');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('toast.svelte.js', () => {
  let T, clock;
  beforeEach(async () => {
    ({ T } = await freshImport({ modules: { T: 'src/lib/toast.svelte.js' } }));
    clock = useClock();
  });

  it('a short message stays 3.5 s', async () => {
    T.toast('Saved');
    expect(T.toastState).toMatchObject({ msg: 'Saved', show: true, undo: null });
    await clock.tick(3499);
    expect(T.toastState.show).toBe(true);
    await clock.tick(1);
    expect(T.toastState.show).toBe(false);
  });

  it('a long one ~55 ms per character on top of 1.8 s, capped at 9 s', async () => {
    const msg = 'x'.repeat(60);   // 1800 + 3300 = 5100 ms
    T.toast(msg);
    await clock.tick(5099);
    expect(T.toastState.show).toBe(true);
    await clock.tick(1);
    expect(T.toastState.show).toBe(false);
    T.toast('y'.repeat(500));
    await clock.tick(8999);
    expect(T.toastState.show).toBe(true);
    await clock.tick(1);
    expect(T.toastState.show).toBe(false);
  });

  it('a new toast replaces the old one and restarts the clock', async () => {
    T.toast('one');
    await clock.tick(3000);
    T.toast('two');
    await clock.tick(3000);
    expect(T.toastState).toMatchObject({ msg: 'two', show: true });
    await clock.tick(500);
    expect(T.toastState.show).toBe(false);
  });

  it(PHONE ? 'phone: an undoable toast stays at least 5 s' : 'TV: an undoable toast keeps the usual 3.5 s', async () => {
    T.toast('Added', () => {});
    await clock.tick(3500);
    expect(T.toastState.show).toBe(PHONE);
    await clock.tick(1500);
    expect(T.toastState.show).toBe(false);
    expect(T.toastState.undo).toBeNull();
  });

  it('takeUndo runs the action once and drops the toast; nothing to undo is false', async () => {
    const undo = vi.fn();
    T.toast('Hidden from Continue Watching', undo);
    expect(T.takeUndo()).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(T.toastState).toMatchObject({ show: false, undo: null });
    expect(T.takeUndo()).toBe(false);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the undo expires with the toast', async () => {
    const undo = vi.fn();
    T.toast('x', undo);
    await clock.tick(10000);
    expect(T.takeUndo()).toBe(false);
    expect(undo).not.toHaveBeenCalled();
  });

  it(PHONE ? 'phone: a thumb on the toast pauses it; lifting hides it 2 s later' : 'TV: pauseToast / resumeToast do nothing', async () => {
    T.toast('Saved');
    T.pauseToast();
    await clock.tick(10000);
    expect(T.toastState.show).toBe(PHONE);
    T.resumeToast();
    await clock.tick(1999);
    expect(T.toastState.show).toBe(PHONE);
    await clock.tick(1);
    expect(T.toastState.show).toBe(false);
  });

  it('resumeToast of a toast already gone does not bring it back', async () => {
    T.toast('a');
    await clock.tick(4000);
    T.resumeToast(500);
    await clock.tick(1000);
    expect(T.toastState.show).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('header.svelte.js', () => {
  it('no menu down at start; each menu closes onto its tab-row button', async () => {
    const { h } = await freshImport({ modules: { h: 'src/lib/header.svelte.js' } });
    expect(h.HM.open).toBeNull();
    expect(h.HM_BUTTON).toEqual({ news: 'nav-news', account: 'nav-account', settings: 'nav-account', mylib: 'nav-account', 'mylib-del': 'nav-account' });
  });
});

describe('icons.js', () => {
  let ICONS, GLYPH;
  beforeEach(async () => {
    ({ ICONS, GLYPH } = (await freshImport({ modules: { i: 'src/lib/icons.js' } })).i);
  });

  const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'g', 'text']);

  /* a minimal well-formedness check of an SVG fragment: balanced tags, known
   * shape elements, quoted attributes, path data made of path-command characters */
  function svgProblems(body) {
    const out = [];
    const stack = [];
    const re = /<(\/?)([a-zA-Z]+)((?:\s+[a-zA-Z-]+="[^"]*")*)\s*(\/?)>/g;
    let last = 0;
    for (let m; (m = re.exec(body)); ) {
      const between = body.slice(last, m.index);
      if (/[<>]/.test(between)) out.push('stray markup: ' + between);
      last = re.lastIndex;
      const [, close, tag, attrs, self] = m;
      if (!SHAPES.has(tag)) out.push('unknown element <' + tag + '>');
      if (close) {
        if (stack.pop() !== tag) out.push('unbalanced </' + tag + '>');
      } else if (!self) stack.push(tag);
      for (const a of attrs.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
        if (a[1] === 'd' && !/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/.test(a[2])) out.push('bad path data: ' + a[2]);
        if (a[1] === 'd' && !/^\s*[Mm]/.test(a[2])) out.push('path data must start with a moveto: ' + a[2]);
      }
    }
    if (/[<>]/.test(body.slice(last))) out.push('stray markup at the end');
    if (stack.length) out.push('unclosed <' + stack.join('>, <') + '>');
    if (last === 0) out.push('no element');
    return out;
  }

  it('every ICONS entry is a well-formed inline-SVG body', () => {
    expect(Object.keys(ICONS).length).toBeGreaterThan(20);
    for (const [name, body] of Object.entries(ICONS)) {
      expect([name, svgProblems(body)]).toEqual([name, []]);
    }
    expect(svgProblems(GLYPH)).toEqual([]);
  });

  it('text inside icons is digits only (the one thing the webOS font reliably has)', () => {
    for (const [name, body] of Object.entries(ICONS)) {
      for (const t of body.matchAll(/<text[^>]*>([^<]*)<\/text>/g)) expect([name, /^\d+$/.test(t[1])]).toEqual([name, true]);
    }
  });

  it('the checker itself rejects broken markup', () => {
    expect(svgProblems('<path d="M1 1L2 2"/>')).toEqual([]);
    expect(svgProblems('<path d="M1 1L2 2">')).not.toEqual([]);
    expect(svgProblems('<path d="M1 1 X"/>')).not.toEqual([]);
    expect(svgProblems('<blink/>')).not.toEqual([]);
    expect(svgProblems('▸')).not.toEqual([]);
  });

  it('every icon name a TV component asks for exists', () => {
    const files = [];
    for (const dir of ['src/components', 'src/screens']) {
      for (const f of fs.readdirSync(path.join(ROOT, dir))) if (f.endsWith('.svelte')) files.push(path.join(ROOT, dir, f));
    }
    const names = new Set();
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/<Icon\b[^>]*?\bname=(?:"([^"]+)"|\{([^}]+)\})/g)) {
        if (m[1]) names.add(m[1]);
        // name={cond ? 'a' : 'b'}: the branch results, not the literals compared against
        else for (const lit of m[2].matchAll(/[?:]\s*'([a-z0-9-]+)'/g)) names.add(lit[1]);
      }
    }
    expect(names.size).toBeGreaterThan(20);
    expect([...names].filter((n) => !(n in ICONS))).toEqual([]);
  });
});

describe('decoded.js (use:decoded)', () => {
  let decoded, created;

  class FakeImage {
    constructor() {
      this.src = '';
      created.push(this);
      this.decode = vi.fn(() => new Promise((res, rej) => ((this.resolve = res), (this.reject = rej))));
    }
  }

  beforeEach(async () => {
    ({ decoded } = (await freshImport({ modules: { d: 'src/lib/decoded.js' } })).d);
    created = [];
    vi.stubGlobal('Image', FakeImage);
  });

  it('the <img> gets its src only after a detached Image decoded it', async () => {
    const img = document.createElement('img');
    decoded(img, 'http://jf.test/b1.jpg');
    expect(created).toHaveLength(1);
    expect(created[0].src).toBe('http://jf.test/b1.jpg');
    expect(created[0].decode).toHaveBeenCalledTimes(1);
    expect(img.getAttribute('src')).toBeNull();
    created[0].resolve();
    await flushPromises();
    expect(img.getAttribute('src')).toBe('http://jf.test/b1.jpg');
  });

  it('a failed decode still sets src (the <img> reports its own error)', async () => {
    const img = document.createElement('img');
    decoded(img, 'http://jf.test/404.jpg');
    created[0].reject(new Error('EncodingError'));
    await flushPromises();
    expect(img.getAttribute('src')).toBe('http://jf.test/404.jpg');
  });

  it('only the newest url wins if it changes mid-decode', async () => {
    const img = document.createElement('img');
    const a = decoded(img, 'http://jf.test/a.jpg');
    a.update('http://jf.test/b.jpg');
    created[1].resolve();
    await flushPromises();
    expect(img.getAttribute('src')).toBe('http://jf.test/b.jpg');
    created[0].resolve();
    await flushPromises();
    expect(img.getAttribute('src')).toBe('http://jf.test/b.jpg');
  });

  it('the same url again is no new decode; no url removes src', async () => {
    const img = document.createElement('img');
    const a = decoded(img, 'http://jf.test/a.jpg');
    created[0].resolve();
    await flushPromises();
    a.update('http://jf.test/a.jpg');
    expect(created).toHaveLength(1);
    a.update(null);
    expect(img.hasAttribute('src')).toBe(false);
    expect(created).toHaveLength(1);
  });

  it('destroyed before the decode finished: src is never set', async () => {
    const img = document.createElement('img');
    const a = decoded(img, 'http://jf.test/a.jpg');
    a.destroy();
    created[0].resolve();
    await flushPromises();
    expect(img.getAttribute('src')).toBeNull();
  });
});
