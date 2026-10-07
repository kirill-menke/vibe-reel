/* Screenshot baselines (optional, few and small): a settled 1920×1080 TV
 * screen, box-downscaled to 960×540, compared per pixel against a committed
 * PNG in e2e/baselines/ with a tolerance. Zero dependencies: PNG decode and
 * encode via node:zlib.
 *
 *   await matchBaseline(t, 'tv-home', { mask: ['.qc-code'] })
 *
 * - settle: fonts loaded, every <img> on screen decoded (or failed), the text
 *   caret made transparent (test-only style — a blinking caret is not a
 *   regression), then two consecutive captures 400 ms apart must agree
 *   exactly; a screen that never stops moving fails ("didn't settle").
 * - mask: CSS selectors (or {x,y,width,height} in CSS px) whose boxes are
 *   filled with one flat colour before saving/comparing — for values that
 *   legitimately change between runs (a Quick Connect code, the server URL
 *   with its random port).
 * - compare: a pixel differs when any channel is off by more than `tol`
 *   (default 40 of 255 — anti-aliasing/gradient dither noise stays under it);
 *   the screen fails when more than `maxRatio` (default 0.4 %) of the pixels
 *   differ. A failure writes <name>.actual.png and <name>.diff.png (differing
 *   pixels red over a dimmed baseline) to the test's out dir (e2e/.out/).
 * - update: only with `node e2e/run.mjs --update-baselines` (sets
 *   E2E_UPDATE_BASELINES=1 for the workers); a missing baseline is a failure
 *   otherwise, never silently created. */
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './page.mjs';

export const BASELINE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'baselines');
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.out');
export const MAX_BASELINE_BYTES = 150 * 1024;

/* ---------------- PNG ---------------- */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/* → { width, height, data: Uint8Array RGB } — 8-bit, non-interlaced,
 * colour types 0 (grey), 2 (RGB), 4 (grey+alpha), 6 (RGBA); alpha dropped. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, w = 0, h = 0, ct = 0, depth = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const d = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') (w = d.readUInt32BE(0)), (h = d.readUInt32BE(4)), (depth = d[8]), (ct = d[9]), (interlace = d[12]);
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  if (depth !== 8 || !ch || interlace) throw new Error(`unsupported PNG (depth ${depth}, colour type ${ct}, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[dst + x - ch] : 0, b = y ? px[prev + x] : 0, c = x >= ch && y ? px[prev + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error('bad PNG filter ' + f);
      px[dst + x] = v & 255;
    }
  }
  const out = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++, j += ch) {
    if (ch < 3) out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = px[j];
    else (out[i * 3] = px[j]), (out[i * 3 + 1] = px[j + 1]), (out[i * 3 + 2] = px[j + 2]);
  }
  return { width: w, height: h, data: out };
}

/* RGB → PNG, per-row adaptive filter (min sum of |signed residual|), so the
 * gradients of the generated artwork stay small. */
export function encodePng({ width, height, data }) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  const cand = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const cur = y * stride, prev = cur - stride;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const o = cand[f];
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= 3 ? data[cur + x - 3] : 0, b = y ? data[prev + x] : 0, c = x >= 3 && y ? data[prev + x - 3] : 0;
        let p = 0;
        if (f === 1) p = a;
        else if (f === 2) p = b;
        else if (f === 3) p = (a + b) >> 1;
        else if (f === 4) {
          const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
          p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const v = (data[cur + x] - p) & 255;
        o[x] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) (bestSum = sum), (best = f);
    }
    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (type, d) => {
    const td = Buffer.concat([Buffer.from(type, 'ascii'), d]);
    const len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- image ops ---------------- */

/* integer box downscale by `k` (1920×1080, k=2 → 960×540) */
export function downscale(img, k = 2) {
  const w = Math.floor(img.width / k), h = Math.floor(img.height / k);
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) s += img.data[((y * k + dy) * img.width + x * k + dx) * 3 + c];
        out[(y * w + x) * 3 + c] = Math.round(s / (k * k));
      }
  return { width: w, height: h, data: out };
}

/* fill rects (in the image's pixels) with one flat colour */
export function fillRects(img, rects, rgb = [255, 0, 255]) {
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(img.width, Math.ceil(r.x + r.width)), y1 = Math.min(img.height, Math.ceil(r.y + r.height));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.set(rgb, (y * img.width + x) * 3);
  }
  return img;
}

/* → { differing, ratio, diff (image) } */
export function compare(a, b, { tol = 40 } = {}) {
  if (a.width !== b.width || a.height !== b.height) return { differing: a.width * a.height, ratio: 1, diff: null, size: `${a.width}×${a.height} vs ${b.width}×${b.height}` };
  const n = a.width * a.height;
  const diff = new Uint8Array(n * 3);
  let differing = 0;
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    const d = Math.max(Math.abs(a.data[j] - b.data[j]), Math.abs(a.data[j + 1] - b.data[j + 1]), Math.abs(a.data[j + 2] - b.data[j + 2]));
    if (d > tol) {
      differing++;
      diff[j] = 255;
    } else {
      const g = Math.round((b.data[j] + b.data[j + 1] + b.data[j + 2]) / 9); // dimmed baseline
      diff[j] = diff[j + 1] = diff[j + 2] = g;
    }
  }
  return { differing, ratio: differing / n, diff: { width: a.width, height: a.height, data: diff } };
}

/* ---------------- capture ---------------- */

const CARET_CSS = '*{caret-color:transparent!important}';

async function rawCapture(page) {
  const r = await page.s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, { timeout: 10000 });
  return decodePng(Buffer.from(r.data, 'base64'));
}

/* Wait until the screen is quiet, then return the downscaled, masked frame. */
export async function captureSettled(page, { mask = [], k = 2, timeout = 15000, interval = 400 } = {}) {
  await page.eval((css) => {
    if (!document.getElementById('e2e-visual-css')) {
      const s = document.createElement('style');
      s.id = 'e2e-visual-css';
      s.textContent = css;
      document.head.append(s);
    }
    return true;
  }, CARET_CSS);
  await page.waitFor(
    () => document.fonts.status === 'loaded' && [...document.images].every((i) => {
      const r = i.getBoundingClientRect();
      const onScreen = r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      return !onScreen || !i.getAttribute('src') || i.complete;
    }),
    { timeout, what: 'fonts + on-screen images loaded' }
  );
  const rects = async () => {
    const css = await page.eval((sels) => sels.flatMap((s) => [...document.querySelectorAll(s)].map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })), mask.filter((m) => typeof m === 'string'));
    return [...css, ...mask.filter((m) => typeof m === 'object')].map((r) => ({ x: r.x / k, y: r.y / k, width: r.width / k, height: r.height / k }));
  };
  const t0 = Date.now();
  let prev = fillRects(downscale(await rawCapture(page), k), await rects());
  for (;;) {
    await sleep(interval);
    const cur = fillRects(downscale(await rawCapture(page), k), await rects());
    if (compare(cur, prev, { tol: 0 }).differing === 0) return cur;
    if (Date.now() - t0 > timeout) {
      const c = compare(cur, prev, { tol: 0 });
      throw new Error(`screen didn't settle in ${timeout} ms (${c.differing} px still changing between frames)`);
    }
    prev = cur;
  }
}

export const updating = () => process.env.E2E_UPDATE_BASELINES === '1';

/* Capture `name` settled and compare it with e2e/baselines/<name>.png.
 * Returns { ratio, differing } on a match; throws on a mismatch. */
export async function matchBaseline(t, name, { mask = [], tol = 40, maxRatio = 0.004, timeout } = {}) {
  const img = await captureSettled(t.page, { mask, timeout });
  const file = path.join(BASELINE_DIR, name + '.png');
  if (updating()) {
    mkdirSync(BASELINE_DIR, { recursive: true });
    const png = encodePng(img);
    if (png.length > MAX_BASELINE_BYTES) throw new Error(`baseline ${name}.png would be ${png.length} B (> ${MAX_BASELINE_BYTES}) — mask more or pick a quieter screen`);
    writeFileSync(file, png);
    t.log(`baseline ${name}.png written (${png.length} B)`);
    return { written: true, bytes: png.length };
  }
  if (!existsSync(file)) throw new Error(`no baseline e2e/baselines/${name}.png — create it with node e2e/run.mjs --update-baselines --grep visual`);
  const base = decodePng(readFileSync(file));
  const c = compare(img, base, { tol });
  t.log(`${name}: ${c.differing} px differ (${(c.ratio * 100).toFixed(3)} %, limit ${(maxRatio * 100).toFixed(2)} %)`);
  if (c.ratio > maxRatio) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(path.join(OUT_DIR, name + '.actual.png'), encodePng(img));
    if (c.diff) writeFileSync(path.join(OUT_DIR, name + '.diff.png'), encodePng(c.diff));
    throw new Error(`${name} differs from its baseline: ${c.differing} px (${(c.ratio * 100).toFixed(2)} % > ${(maxRatio * 100).toFixed(2)} %)${c.size ? ' — size ' + c.size : ''}; see e2e/.out/${name}.actual.png and .diff.png`);
  }
  return { differing: c.differing, ratio: c.ratio };
}
