/* web/src/lib/pagesa11y.js — the title pages' shared phone markup made
 * accessible on the live DOM (lane pages, C-15 / C-12):
 *  - a download's live state (.btn--status, the phone's disabled button) is a
 *    progressbar named "Download": value = the %, text = the visible line,
 *    not disabled, out of the Tab order;
 *  - initials under a photo and the avatar initial in a named row are
 *    aria-hidden. */
import { describe, it, expect, beforeEach } from 'vitest';
import { statusAsProgress, fixPages, initPagesA11y } from '../../web/src/lib/pagesa11y.js';

const status = (inner) => {
  const b = document.createElement('button');
  b.className = 'btn btn--status btn--block';
  b.disabled = true;
  b.innerHTML = inner;
  return b;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('download status as a progressbar', () => {
  it('turns the disabled status button into a named progressbar with the % and the line', () => {
    const b = status('<span class="btn__fill"></span><span><span class="btn__pct">43%</span> · <span class="btn__rate">7.1 MB/s</span> · 1 h 11 min left</span>');
    statusAsProgress(b);
    expect(b.disabled).toBe(false);
    expect(b.getAttribute('role')).toBe('progressbar');
    expect(b.getAttribute('tabindex')).toBe('-1');
    expect(b.getAttribute('aria-label')).toBe('Download');
    expect(b.getAttribute('aria-valuemin')).toBe('0');
    expect(b.getAttribute('aria-valuemax')).toBe('100');
    expect(b.getAttribute('aria-valuenow')).toBe('43');
    expect(b.getAttribute('aria-valuetext')).toBe('43% · 7.1 MB/s · 1 h 11 min left');
  });

  it('is indeterminate (no value) while there is no % — queued, waiting, importing', () => {
    const b = status('<span>Queued · waiting for a slot</span>');
    statusAsProgress(b);
    expect(b.hasAttribute('aria-valuenow')).toBe(false);
    expect(b.getAttribute('aria-valuetext')).toBe('Queued · waiting for a slot');
  });

  it('follows the poll: a new % updates the value, losing it drops the value', () => {
    const b = status('<span><span class="btn__pct">10%</span> · 1 h left</span>');
    statusAsProgress(b);
    b.querySelector('.btn__pct').textContent = '11%';
    statusAsProgress(b);
    expect(b.getAttribute('aria-valuenow')).toBe('11');
    b.innerHTML = '<span>Importing into your library…</span>';
    statusAsProgress(b);
    expect(b.hasAttribute('aria-valuenow')).toBe(false);
    expect(b.getAttribute('aria-valuetext')).toBe('Importing into your library…');
  });
});

describe('initials out of accessible names', () => {
  it('hides cast / person initials and an avatar inside a row, not an avatar elsewhere', () => {
    document.body.innerHTML =
      '<button class="cast"><span class="cast__photo"><span class="cast__initials">JT</span></span><span class="cast__name">John Travolta</span></button>' +
      '<div class="person__photo"><span class="cast__initials">DD</span></div>' +
      '<button class="row"><span class="avatar">K</span><span class="row__title">kirill</span></button>' +
      '<button class="avatarbtn"><span class="avatar">K</span></button>';
    fixPages(document.body);
    expect([...document.querySelectorAll('.cast__initials')].map((e) => e.getAttribute('aria-hidden'))).toEqual(['true', 'true']);
    expect(document.querySelector('.row .avatar').getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('.avatarbtn .avatar').hasAttribute('aria-hidden')).toBe(false);
  });
});

describe('initPagesA11y', () => {
  it('fixes what is there and what a page mounts later (one observer)', async () => {
    document.body.innerHTML = '<div class="screen"></div>';
    initPagesA11y(document.body);
    initPagesA11y(document.body); // once only
    const b = status('<span><span class="btn__pct">5%</span></span>');
    document.querySelector('.screen').append(b);
    await flush();
    expect(b.getAttribute('role')).toBe('progressbar');
    expect(b.getAttribute('aria-valuenow')).toBe('5');
    b.querySelector('.btn__pct').firstChild.data = '6%';
    await flush();
    expect(b.getAttribute('aria-valuenow')).toBe('6');
  });

  it('ignores mutations inside the player (its clock ticks several times a second)', async () => {
    const p = document.createElement('div');
    p.className = 'wplayer';
    document.body.append(p);
    await flush();
    // a status inside the player would only be fixed by an outside mutation
    const b = status('<span>x</span>');
    p.append(b);
    await flush();
    expect(b.hasAttribute('role')).toBe(false);
  });
});

describe('the pending page’s Cancel pill', () => {
  it('is named "Cancel download"; other actions keep their names', () => {
    document.body.innerHTML = '<div class="detail__body"><div class="actions"><button class="action"><span class="action__icon"></span>Trailer</button><button class="action"><span class="action__icon"></span>Cancel</button></div></div>';
    fixPages(document.body);
    const [trailer, cancel] = document.querySelectorAll('.action');
    expect(cancel.getAttribute('aria-label')).toBe('Cancel download');
    expect(trailer.hasAttribute('aria-label')).toBe(false);
  });
});
