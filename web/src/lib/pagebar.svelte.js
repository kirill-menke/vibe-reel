/* The pushed pages' header, desktop edition. On the phone every pushed page
 * draws its own bar (phone/src/components/NavBar.svelte: back disc, title,
 * trailing slot) under the status bar. The desktop has ONE fixed bar, WebNav:
 * the web NavBar variant (web/src/components/NavBar.svelte) draws nothing in
 * the page and publishes its props here, keyed by the route it sits in, and
 * WebNav turns the active tab's stack into a breadcrumb after the sections
 * ("‹ Movies › Pulp Fiction").
 *
 *   BARS.byKey[routeKey]   { title, solid, onback, trailing } of that route
 *   crumbsFor(stack)       the stack as crumbs: { key, label, depth }[] */

/** @typedef {{ title: string, solid: boolean, onback: (() => unknown) | null, trailing?: VR.Snip, owner: number }} PageBar */

export const BARS = $state({ byKey: /** @type {Record<string, PageBar>} */ ({}) });

let seq = 0;
/** A NavBar instance's id: two may briefly share a route (Detail's loading
 * bar hands over to MovieDetail's), and only the current owner may drop it. */
export const barOwner = () => ++seq;

/** @param {string} key @param {PageBar} bar */
export function setBar(key, bar) {
  const was = BARS.byKey[key];
  if (was && was.owner === bar.owner && was.title === bar.title && was.solid === bar.solid && was.onback === bar.onback && was.trailing === bar.trailing) return;
  BARS.byKey = { ...BARS.byKey, [key]: bar };
}

/** @param {string} key @param {number} owner */
export function dropBar(key, owner) {
  if (BARS.byKey[key]?.owner !== owner) return;
  const { [key]: _gone, ...rest } = BARS.byKey;
  BARS.byKey = rest;
}

/** @type {Record<string, string>} */
export const ROOT_LABEL = { home: 'Home', movies: 'Movies', shows: 'Shows', search: 'Search' };

/* What a route is called before (or without) its page publishing a title:
 * the params a URL carries (a person's name, a chart's or lookup's title). */
/** @param {VR.Route} r @returns {string} */
function paramLabel(r) {
  const p = /** @type {Record<string, any>} */ (r.params || {});
  if (r.name === 'settings') return 'Settings';
  if (r.name === 'mylibrary') return 'My library';
  return String(p.name || p.title || p.item?.title || '');
}

/** @param {VR.Route} r @param {Record<string, PageBar>} bars */
export function labelOf(r, bars = BARS.byKey) {
  return ROOT_LABEL[r.name] || bars[r.key]?.title || paramLabel(r);
}

/** @param {VR.Route[]} stack @returns {{ key: string, label: string, depth: number }[]} */
export function crumbsFor(stack) {
  return stack.map((r, depth) => ({ key: r.key, label: labelOf(r), depth }));
}

/* Long trails collapse in the middle: root, …, the last `keep` ancestors. */
/** @template T @param {T[]} ancestors @param {number} [keep] @returns {(T | null)[]} null = the "…" */
export function collapse(ancestors, keep = 1) {
  if (ancestors.length <= keep + 2) return ancestors;
  return [ancestors[0], null, ...ancestors.slice(-keep)];
}
