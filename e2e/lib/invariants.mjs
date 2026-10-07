/* TV focus invariants (CLAUDE.md "Input" + "Every focusable element needs
 * class focus|opt and a unique data-focus"), checked in the page against the
 * live DOM.
 *
 * The active scope mirrors focus.js focusables() using only the DOM:
 *   Search overlay up (not in the player)  → #search
 *   player (video layer shown)             → #play-error | #chapter-menu | #player-menu | #video-layer
 *   an open .lvmenu in the screen          → that menu (modal)
 *   otherwise                              → the mounted .screen
 *
 * checkFocusInvariants(page, opts) → [] or a list of human-readable problems:
 *   - focus on <body>/nothing (opts.allowBody to skip)
 *   - focus outside the active scope (on something behind an overlay)
 *   - an interactive element in scope (button, input, a[href], [tabindex≥0])
 *     without class focus|opt — the D-pad can never reach it
 *   - a .focus/.opt in scope without data-focus
 *   - duplicate data-focus in scope, except prefixes in opts.dupOk
 *     (Home's rails share tile-<id> keys by design: ['tile-']); the message
 *     ends with "(one copy is an inert outro)" when a copy sits in an [inert]
 *     subtree (a Svelte block mid-outro, F-006)
 */

/* serialisable: runs in the page */
export function inPageScope() {
  const FOC = '.focus:not([hidden]), .opt:not([hidden])';
  const vis = (el) => !!el && !el.hidden && el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
  const search = document.getElementById('search');
  const vl = document.getElementById('video-layer');
  let root = null;
  let kind = '';
  // #search is always in the DOM; `.on` is S.search (Search.svelte)
  const searchUp = !!search && search.classList.contains('on');
  if (vis(vl)) {
    const menu = document.getElementById('play-error') || document.getElementById('chapter-menu') || document.getElementById('player-menu');
    root = menu && !menu.hidden ? menu : vl;
    kind = menu && !menu.hidden ? '#' + menu.id : '#video-layer';
  } else if (searchUp) {
    root = search;
    kind = '#search';
  } else {
    const scr = document.querySelector('.screen');
    const menu = scr && scr.querySelector('.lvmenu');
    root = menu || scr || document.body;
    kind = menu ? '.lvmenu' : scr ? '.screen' : 'document';
  }
  const all = [...root.querySelectorAll(FOC)].filter((e) => !e.disabled && e.checkVisibility());
  return { root, kind, all };
}

export async function checkFocusInvariants(page, opts = {}) {
  return page.eval((scopeSrc, opts) => {
    const scope = new Function('return (' + scopeSrc + ')')()();
    const out = [];
    const a = document.activeElement;
    const desc = (e) => (e.dataset?.focus ? `[data-focus=${e.dataset.focus}]` : `<${e.tagName.toLowerCase()} class="${e.className}">${(e.textContent || '').trim().slice(0, 30)}`);
    if (!a || a === document.body || a === document.documentElement) {
      if (!opts.allowBody) out.push('focus is on <body> (the D-pad has nothing to move from)');
    } else {
      if (!scope.root.contains(a)) out.push(`focus ${desc(a)} is outside the active scope ${scope.kind}`);
      if (!a.matches('.focus, .opt')) out.push(`focused element ${desc(a)} has neither class focus nor opt`);
    }
    const inter = [...scope.root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')].filter(
      (e) => e.checkVisibility() && !e.disabled && e.tabIndex >= 0 && !e.closest('[hidden]')
    );
    for (const e of inter) if (!e.matches('.focus, .opt')) out.push(`interactive ${desc(e)} in ${scope.kind} lacks class focus|opt (unreachable by D-pad)`);
    const seen = new Map();
    for (const e of scope.all) {
      const k = e.dataset.focus;
      if (!k) {
        out.push(`${desc(e)} in ${scope.kind} has no data-focus`);
        continue;
      }
      if (seen.has(k) && !(opts.dupOk || []).some((p) => k.startsWith(p))) {
        // a copy inside an inert subtree is a Svelte block in its outro (F-006: Home's hero .info)
        const inert = scope.all.some((x) => x.dataset.focus === k && x.closest('[inert]'));
        out.push(`duplicate data-focus="${k}" in ${scope.kind}` + (inert ? ' (one copy is an inert outro)' : ''));
      }
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    return out;
  }, inPageScope.toString(), opts);
}

/* data-focus keys in the active scope, DOM order */
export async function scopeKeys(page) {
  return page.eval((scopeSrc) => {
    const scope = new Function('return (' + scopeSrc + ')')()();
    return { kind: scope.kind, keys: scope.all.map((e) => e.dataset.focus || null) };
  }, inPageScope.toString());
}
