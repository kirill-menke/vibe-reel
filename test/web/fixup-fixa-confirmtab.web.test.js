/* web/src/lib/confirmtab.js: Tab / Shift+Tab walk the confirm dialog's answers
 * in the order they are drawn (Cancel first — web.css `order`), wrap, and keep
 * focus inside the dialog (S2-5). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { drawnOrder, onKey, initConfirmTab } from '../../web/src/lib/confirmtab.js';

/** the phone ActionSheet's markup: the action first, Cancel in its own group */
function sheet({ inert = false, disabledAction = false } = {}) {
  document.body.innerHTML = `
    <button id="page">page</button>
    <div class="actsheet"${inert ? ' inert' : ''}>
      <div class="actsheet__scrim"></div>
      <div class="actsheet__box" role="alertdialog">
        <div class="actsheet__group">
          <div class="actsheet__head"><p class="actsheet__title">Delete?</p></div>
          <button type="button" class="actsheet__btn actsheet__btn--danger"${disabledAction ? ' disabled' : ''}>Delete</button>
        </div>
        <div class="actsheet__group">
          <button type="button" class="actsheet__btn actsheet__btn--cancel">Keep</button>
        </div>
      </div>
    </div>`;
  const $ = (/** @type {string} */ s) => /** @type {HTMLButtonElement} */ (document.querySelector(s));
  return { page: $('#page'), del: $('.actsheet__btn--danger'), keep: $('.actsheet__btn--cancel') };
}

/** @param {Partial<KeyboardEventInit>} [o] */
function tab(o = {}) {
  const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, ...o });
  onKey(e);
  return e;
}

const name = () => document.activeElement?.textContent;

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('drawnOrder', () => {
  it('puts Cancel first, then the action', () => {
    const { del, keep } = sheet();
    expect(drawnOrder(/** @type {Element} */ (document.querySelector('.actsheet__box')))).toEqual([keep, del]);
  });
  it('leaves out a disabled answer', () => {
    const { keep } = sheet({ disabledAction: true });
    expect(drawnOrder(/** @type {Element} */ (document.querySelector('.actsheet__box')))).toEqual([keep]);
  });
});

describe('Tab inside the confirm', () => {
  it('goes Keep → Delete → Keep and never leaves the dialog', () => {
    const { keep } = sheet();
    keep.focus();
    expect(tab().defaultPrevented).toBe(true);
    expect(name()).toBe('Delete');
    tab();
    expect(name()).toBe('Keep');
  });

  it('Shift+Tab walks the other way and wraps', () => {
    const { del } = sheet();
    del.focus();
    tab({ shiftKey: true });
    expect(name()).toBe('Keep');
    tab({ shiftKey: true });
    expect(name()).toBe('Delete');
  });

  it('brings focus back in from outside: Tab to the first answer, Shift+Tab to the last', () => {
    const { page } = sheet();
    page.focus();
    tab();
    expect(name()).toBe('Keep');
    page.focus();
    tab({ shiftKey: true });
    expect(name()).toBe('Delete');
  });

  it('leaves Tab alone while no confirm is up, or one is on its way out (inert)', () => {
    const { page } = sheet({ inert: true });
    page.focus();
    expect(tab().defaultPrevented).toBe(false);
    expect(name()).toBe('page');
    document.body.innerHTML = '<button>x</button>';
    expect(tab().defaultPrevented).toBe(false);
  });

  it('ignores other keys, modified Tabs and an already-handled Tab', () => {
    const { keep } = sheet();
    keep.focus();
    for (const o of [{ key: 'Enter' }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      expect(tab(o).defaultPrevented).toBe(false);
      expect(name()).toBe('Keep');
    }
    const e = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    e.preventDefault();
    onKey(e);
    expect(name()).toBe('Keep');
  });

  it('is installed on the window (capture) by initConfirmTab', () => {
    const { keep } = sheet();
    initConfirmTab();
    keep.focus();
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    keep.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(name()).toBe('Delete');
  });
});
