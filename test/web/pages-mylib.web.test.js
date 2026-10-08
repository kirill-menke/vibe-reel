/* phone/src/lib/mylib.js in the web build (lane pages):
 *  - B-15: after a confirmed Delete the row (and its focused button) goes;
 *    focus moves to the next row's Delete, else the previous row's, else the
 *    page heading. A failed delete keeps the row and its button gets focus.
 *  - E-11: the boot-time /api/me keeps an answer up to 10 s old, so a deep
 *    link to My library (which asked at mount) makes one request, not two.
 * The page is a DOM stand-in for MyLibrary.svelte's markup; the delete runs
 * against a mocked reel-api. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { freshImport, TEST_MEDIALIB } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';

const title = (id, name) => ({ type: 'movie', id, title: name, year: 2020, poster: null, status: 'waiting', progress: null });
const ME_BODY = (titles) => ({ user: { id: 'u1', name: 'Tester' }, admin: false, quota: { movie: { used: titles.length, limit: 10 }, tv: { used: 0, limit: 10 } }, titles });

let m;
let realRects;
beforeEach(async () => {
  m = await freshImport({ modules: { mylib: 'phone/src/lib/mylib.js', me: 'src/lib/me.svelte.js', confirm: 'phone/src/lib/confirm.svelte.js' } });
  // happy-dom lays nothing out: every element counts as shown unless it is in [hidden]
  realRects = Element.prototype.getClientRects;
  Element.prototype.getClientRects = function () {
    return /** @type {any} */ (this.closest('[hidden]') ? [] : [{}]);
  };
});
afterEach(() => {
  Element.prototype.getClientRects = realRects;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

/* MyLibrary's list for these titles; the "Svelte" here is the test: it drops
 * a row when ME.me.titles loses it */
function page(keys) {
  document.body.innerHTML =
    '<main class="screen mylib"><header class="pagehead"><h1 class="pagehead__title">My library</h1></header><div class="list">' +
    keys.map((k) => `<div class="mylib__item" data-key="movie:${k}"><button class="row">${k}</button><button class="mylib__del">Delete ${k}</button></div>`).join('') +
    '</div></main>';
}
function syncRows() {
  const keep = new Set(m.me.ME.me.titles.map((t) => 'movie:' + t.id));
  for (const r of document.querySelectorAll('.mylib__item')) if (!keep.has(r.getAttribute('data-key'))) r.remove();
}
async function deleteVia(net, id, { ok = true } = {}) {
  net.on('DELETE', new RegExp(`/api/library/movie/${id}\\?delete_files=true$`), ok ? { deleted: true } : net.status(409, { detail: { code: 'importing', message: 'It is importing' } }));
  document.querySelector(`[data-key="movie:${id}"] .mylib__del`).focus();
  const p = m.mylib.askDelete(m.me.ME.me.titles.find((t) => t.id === id));
  await Promise.resolve();
  m.confirm.CONFIRM.req.resolve(true);
  // the delete's own toast/await chain, then the page re-renders
  const res = await p.then((v) => v, (e) => e);
  return res;
}

function seed(ids) {
  const titles = ids.map((id) => title(id, 'Film ' + id));
  m.me.ME.me = ME_BODY(titles);
  m.me.ME.state = 'ok';
  m.me.ME.at = Date.now();
  page(ids);
  const net = mockFetch();
  net.on('GET', `${TEST_MEDIALIB}/api/me`, () => ME_BODY(m.me.ME.me.titles));
  return net;
}

describe('focus after a confirmed Delete (B-15)', () => {
  it('goes to the next row’s Delete', async () => {
    const net = seed(['1', '2', '3']);
    const obs = new MutationObserver(syncRows);
    obs.observe(document.body, { subtree: true, childList: true });
    const p = deleteVia(net, '2');
    // the store changed: drop the row like Svelte would, before the refocus looks
    await vi.waitFor(() => expect(m.me.ME.me.titles.map((t) => t.id)).toEqual(['1', '3']));
    syncRows();
    expect(await p).toBe(true);
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Delete 3'));
    obs.disconnect();
  });

  it('goes to the previous row’s Delete when the last row went', async () => {
    const net = seed(['1', '2']);
    const p = deleteVia(net, '2');
    await vi.waitFor(() => expect(m.me.ME.me.titles.length).toBe(1));
    syncRows();
    await p;
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Delete 1'));
  });

  it('goes to the page heading when no row is left', async () => {
    const net = seed(['1']);
    const p = deleteVia(net, '1');
    await vi.waitFor(() => expect(m.me.ME.me.titles.length).toBe(0));
    syncRows();
    await p;
    const h = document.querySelector('.pagehead__title');
    await vi.waitFor(() => expect(document.activeElement).toBe(h));
    expect(h.tabIndex).toBe(-1);
  });

  it('a failed delete keeps the row and focuses its own Delete again', async () => {
    const net = seed(['1', '2']);
    document.querySelector('[data-key="movie:1"] .mylib__del').focus();
    expect(await deleteVia(net, '2', { ok: false })).toBe(false);
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Delete 2'));
    expect(document.querySelectorAll('.mylib__item').length).toBe(2);
  });

  it('a cancelled confirm deletes nothing and moves nothing', async () => {
    const net = seed(['1', '2']);
    const btn = document.querySelector('[data-key="movie:2"] .mylib__del');
    btn.focus();
    const p = m.mylib.askDelete(m.me.ME.me.titles[1]);
    await Promise.resolve();
    m.confirm.CONFIRM.req.resolve(false);
    expect(await p).toBe(false);
    expect(document.activeElement).toBe(btn);
    expect(net.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });
});

describe('meAtBoot keeps a fresh answer (E-11)', () => {
  it('does not ask again within 10 s of an answer', async () => {
    vi.useFakeTimers();
    const net = seed(['1']);
    m.mylib.meAtBoot(2000);
    await vi.advanceTimersByTimeAsync(2100);
    expect(net.calls.filter((c) => c.path === '/api/me')).toEqual([]);
  });

  it('asks when the answer is older than that, or there is none', async () => {
    vi.useFakeTimers();
    const net = seed(['1']);
    m.me.ME.at = Date.now() - 20000;
    m.mylib.meAtBoot(2000);
    await vi.advanceTimersByTimeAsync(2100);
    expect(net.calls.filter((c) => c.path === '/api/me').length).toBe(1);
  });
});
