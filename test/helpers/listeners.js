/* Live listeners on an EventTarget, for "no listener left behind" checks.
 *
 *   const live = trackListeners(target);   // before the code under test adds any
 *   …
 *   live()   // ['updateend', …] — the types of the listeners still registered
 *
 * Wraps the target's own addEventListener/removeEventListener (instance
 * properties, so nothing global changes), honouring `once` and the DOM's dedupe
 * of an identical (type, listener) registration. */
export function trackListeners(target) {
  const recs = [];
  const add = target.addEventListener.bind(target);
  const rem = target.removeEventListener.bind(target);
  target.addEventListener = (type, fn, opts) => {
    if (recs.some((r) => r.type === type && r.fn === fn)) return;
    const rec = { type, fn, once: !!(opts && opts.once) };
    rec.wrap = function (e) {
      const i = recs.indexOf(rec);
      if (rec.once && i >= 0) recs.splice(i, 1);
      return fn.call(this, e);
    };
    recs.push(rec);
    add(type, rec.wrap, opts);
  };
  target.removeEventListener = (type, fn, opts) => {
    // by the listener the code registered, or by our wrapper (a DOM
    // implementation may remove a fired `once` listener through this method)
    const i = recs.findIndex((r) => r.type === type && (r.fn === fn || r.wrap === fn));
    if (i < 0) return rem(type, fn, opts);
    const [rec] = recs.splice(i, 1);
    rem(type, rec.wrap, opts);
  };
  return () => recs.map((r) => r.type);
}
