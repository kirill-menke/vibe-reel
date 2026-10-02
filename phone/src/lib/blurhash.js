/* Blurhash (https://blurha.sh) — the placeholders Jellyfin already sends as
 * `ImageBlurHashes` on every item ({ Backdrop: { <tag>: hash }, Primary: …,
 * Thumb: … }; an episode carries its series' backdrop hashes too).
 *
 *   avgColor(hash)        the image's average colour, 'rgb(r g b)' (the DC term,
 *                         chars 2–5) — a tinted tile placeholder, memoised
 *   drawBlurhash(cv, hash, w = 32, h = 18)
 *                         decode into a small canvas; the compositor's upscale
 *                         of it is the blur (the Home hero's first layer)
 *   blurFor(item, url)    the hash of the exact image imgUrl() built `url` for
 *                         (its /Images/<Type> and tag=), else the first hash of
 *                         that type, else null
 *
 * A 32×18 decode is ~7 k multiply-adds, well under 1 ms. */

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
const D83 = new Map([...CHARS].map((c, i) => [c, i]));

function d83(s) {
  let v = 0;
  for (const c of s) {
    const x = D83.get(c);
    if (x === undefined) return NaN;
    v = v * 83 + x;
  }
  return v;
}

const toLin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toSrgb = (v) => {
  v = v < 0 ? 0 : v > 1 ? 1 : v;
  return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255);
};
const signPow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);

function valid(hash) {
  if (typeof hash !== 'string' || hash.length < 6) return false;
  const size = d83(hash[0]);
  return size >= 0 && hash.length === 4 + 2 * ((size % 9) + 1) * (Math.floor(size / 9) + 1);
}

const avgMemo = new Map();
export function avgColor(hash) {
  if (!hash) return null;
  let c = avgMemo.get(hash);
  if (c !== undefined) return c;
  const v = valid(hash) ? d83(hash.slice(2, 6)) : NaN;
  c = Number.isFinite(v) ? `rgb(${v >> 16} ${(v >> 8) & 255} ${v & 255})` : null;
  if (avgMemo.size > 500) avgMemo.clear();
  avgMemo.set(hash, c);
  return c;
}

export function drawBlurhash(canvas, hash, w = 32, h = 18) {
  if (!canvas || !valid(hash)) return false;
  const size = d83(hash[0]);
  const nx = (size % 9) + 1, ny = Math.floor(size / 9) + 1;
  const max = (d83(hash[1]) + 1) / 166;
  const colors = [];
  for (let i = 0; i < nx * ny; i++) {
    const v = d83(hash.slice(i === 0 ? 2 : 4 + i * 2, i === 0 ? 6 : 6 + i * 2));
    if (i === 0) colors.push([toLin(v >> 16), toLin((v >> 8) & 255), toLin(v & 255)]);
    else {
      const q = [Math.floor(v / 361), Math.floor(v / 19) % 19, v % 19];
      colors.push(q.map((x) => signPow((x - 9) / 9, 2) * max));
    }
  }
  // cosines once per axis
  const cx = new Float32Array(w * nx), cy = new Float32Array(h * ny);
  for (let x = 0; x < w; x++) for (let i = 0; i < nx; i++) cx[x * nx + i] = Math.cos((Math.PI * x * i) / w);
  for (let y = 0; y < h; y++) for (let j = 0; j < ny; j++) cy[y * ny + j] = Math.cos((Math.PI * y * j) / h);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const img = ctx.createImageData(w, h);
  const px = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < ny; j++) {
        const by = cy[y * ny + j];
        for (let i = 0; i < nx; i++) {
          const f = cx[x * nx + i] * by;
          const c = colors[i + j * nx];
          r += c[0] * f;
          g += c[1] * f;
          b += c[2] * f;
        }
      }
      const o = 4 * (x + y * w);
      px[o] = toSrgb(r);
      px[o + 1] = toSrgb(g);
      px[o + 2] = toSrgb(b);
      px[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return true;
}

export function blurFor(item, url) {
  const all = item?.ImageBlurHashes;
  if (!all || !url) return null;
  const m = /\/Images\/(\w+)/.exec(url);
  const type = m?.[1];
  const byTag = type && all[type];
  if (!byTag) return null;
  let tag = null;
  try {
    tag = new URL(url, location.href).searchParams.get('tag');
  } catch {}
  return (tag && byTag[tag]) || Object.values(byTag)[0] || null;
}
