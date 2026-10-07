/* use:decoded={url} — give an <img> its src only once the image is decoded.
 *
 * A big image that arrives undecoded is decoded by the compositor inside the
 * next commit, and the main thread sits in that commit meanwhile: on the TV a
 * 1920-wide backdrop made every cold detail open a 60–220 ms long task, right
 * where the next D-pad press lands. `decoding="async"` does not help on this
 * Chromium (measured, no change). Decoding a detached Image first moves the
 * decode off the commit; the <img> then reuses the same decoded cache entry.
 * A/B on 16 cold detail opens: longest task median 78 → 59 ms, p90 107 → 77 ms.
 *
 * A failed decode (404, bad data) still sets src, so the <img> reports its own
 * error exactly as before. Only the newest url wins if it changes mid-decode. */
/** Svelte action. @param {HTMLImageElement} img @param {string | null | undefined} url
 * @returns {{ update: (u: string | null | undefined) => void, destroy: () => void }} */
export function decoded(img, url) {
  /** @type {string | null | undefined} */
  let want = null;
  /** @param {string | null | undefined} u */
  function set(u) {
    want = u;
    if (!u) {
      img.removeAttribute('src');
      return;
    }
    if (img.getAttribute('src') === u) return;
    const pre = new Image();
    pre.src = u;
    const apply = () => {
      if (want === u) img.src = u;
    };
    pre.decode().then(apply, apply);
  }
  set(url);
  return {
    update: set,
    destroy() {
      want = null;
    }
  };
}
