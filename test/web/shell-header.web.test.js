/* lane shell: the desktop's one bar — the pushed pages' header published by
 * the web NavBar (web/src/lib/pagebar.svelte.js) and the small pure helpers
 * of App.svelte (web/src/lib/shellkeys.js). */
import { describe, it, expect, beforeEach } from 'vitest';
import { BARS, setBar, dropBar, barOwner, labelOf, crumbsFor, collapse } from '../../web/src/lib/pagebar.svelte.js';
import { isTyping, isUndoKey, navInset, OVERLAY_SCROLLBAR } from '../../web/src/lib/shellkeys.js';

/** @param {string} name @param {string} key @param {Record<string, any>} [params] */
const route = (name, key, params = {}) => /** @type {VR.Route} */ ({ name, key, params });

beforeEach(() => {
  BARS.byKey = {};
});

describe('page bars', () => {
  it('a NavBar publishes its route header and only its owner drops it', () => {
    const a = barOwner();
    const b = barOwner();
    setBar('detail-1', { title: 'Loading', solid: false, onback: null, owner: a });
    // Detail's loading bar hands over to MovieDetail's in the same route
    setBar('detail-1', { title: 'Pulp Fiction', solid: false, onback: null, owner: b });
    dropBar('detail-1', a); // the old one's late cleanup must not drop the new one
    expect(BARS.byKey['detail-1'].title).toBe('Pulp Fiction');
    dropBar('detail-1', b);
    expect(BARS.byKey['detail-1']).toBeUndefined();
  });

  it('an unchanged header is not re-published (no store churn per scroll)', () => {
    const o = barOwner();
    setBar('k', { title: 'T', solid: true, onback: null, owner: o });
    const before = BARS.byKey;
    setBar('k', { title: 'T', solid: true, onback: null, owner: o });
    expect(BARS.byKey).toBe(before);
    setBar('k', { title: 'T', solid: false, onback: null, owner: o });
    expect(BARS.byKey).not.toBe(before);
  });

  it('labels: tab roots by name, pages by their published title, else what their params carry', () => {
    setBar('detail-2', { title: 'Mad Men', solid: false, onback: null, owner: barOwner() });
    expect(labelOf(route('movies', 'movies-1'))).toBe('Movies');
    expect(labelOf(route('detail', 'detail-2', { id: 'x' }))).toBe('Mad Men');
    expect(labelOf(route('person', 'person-3', { id: 'p', name: 'Jon Hamm' }))).toBe('Jon Hamm');
    expect(labelOf(route('chart', 'chart-4', { key: 'top', title: 'IMDb Top 250' }))).toBe('IMDb Top 250');
    expect(labelOf(route('lookup', 'lookup-5', { item: { id: '1', type: 'movie', title: 'Iron Tide' } }))).toBe('Iron Tide');
    expect(labelOf(route('settings', 'settings-6'))).toBe('Settings');
    expect(labelOf(route('mylibrary', 'mylibrary-7'))).toBe('My library');
    expect(labelOf(route('detail', 'detail-8', { id: 'y' }))).toBe(''); // not mounted yet: WebNav says "Back"
  });

  it('crumbs carry their depth (a crumb pops to its level)', () => {
    const c = crumbsFor([route('movies', 'm'), route('detail', 'd', { id: '1' }), route('person', 'p', { name: 'Uma Thurman' })]);
    expect(c.map((x) => [x.label, x.depth])).toEqual([
      ['Movies', 0],
      ['', 1],
      ['Uma Thurman', 2]
    ]);
  });

  it('a long trail collapses in the middle', () => {
    expect(collapse([1, 2, 3])).toEqual([1, 2, 3]);
    expect(collapse([1, 2, 3, 4])).toEqual([1, null, 4]);
    expect(collapse([1, 2, 3, 4, 5, 6], 2)).toEqual([1, null, 5, 6]);
    expect(collapse([])).toEqual([]);
  });
});

describe('shell keys', () => {
  it('typing: text fields, textareas, selects and contenteditable — not buttons or checkboxes', () => {
    const mk = (/** @type {string} */ tag, /** @type {Record<string, string>} */ attrs = {}) => {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    };
    expect(isTyping(mk('input'))).toBe(true);
    expect(isTyping(mk('input', { type: 'search' }))).toBe(true);
    expect(isTyping(mk('input', { type: 'checkbox' }))).toBe(false);
    expect(isTyping(mk('input', { type: 'range' }))).toBe(false);
    expect(isTyping(mk('textarea'))).toBe(true);
    expect(isTyping(mk('select'))).toBe(true);
    expect(isTyping(mk('button'))).toBe(false);
    const ce = mk('div');
    Object.defineProperty(ce, 'isContentEditable', { value: true });
    expect(isTyping(ce)).toBe(true);
    expect(isTyping(null)).toBe(false);
    expect(isTyping(window)).toBe(false);
  });

  it('Undo is Ctrl+Z (⌘Z on a Mac), never with Shift (redo) or Alt', () => {
    expect(isUndoKey({ key: 'z', ctrlKey: true })).toBe(true);
    expect(isUndoKey({ key: 'Z', ctrlKey: true })).toBe(true); // Caps Lock
    expect(isUndoKey({ key: 'z', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isUndoKey({ key: 'z', ctrlKey: true, altKey: true })).toBe(false);
    expect(isUndoKey({ key: 'z', metaKey: true })).toBe(false);
    expect(isUndoKey({ key: 'z' })).toBe(false);
    expect(isUndoKey({ key: 'y', ctrlKey: true })).toBe(false);
    expect(isUndoKey({ key: 'z', metaKey: true }, true)).toBe(true);
    expect(isUndoKey({ key: 'z', ctrlKey: true }, true)).toBe(false);
  });

  it('the bar keeps clear of a classic scrollbar, and leaves a strip for an overlay thumb', () => {
    expect(navInset(10)).toEqual({ right: 10, pad: 0 }); // Chrome's styled gutter
    expect(navInset(6.4)).toEqual({ right: 6, pad: 0 }); // Firefox thin
    expect(navInset(0)).toEqual({ right: OVERLAY_SCROLLBAR, pad: OVERLAY_SCROLLBAR }); // GTK / macOS overlay
    expect(navInset(-1)).toEqual({ right: OVERLAY_SCROLLBAR, pad: OVERLAY_SCROLLBAR });
  });
});
