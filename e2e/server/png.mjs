/* Zero-dependency PNG generator for the fake servers' artwork: posters,
 * backdrops, stills, avatars and trickplay sheets. Deterministic — the same
 * seed always gives the same bytes — and small (a diagonal two-tone gradient
 * with a band compresses to a few KB at any size). */
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/* A colour pair from any string. */
export function palette(seed) {
  const h = createHash('md5').update(String(seed)).digest();
  return [
    [40 + (h[0] % 160), 40 + (h[1] % 160), 40 + (h[2] % 160)],
    [h[3] % 90, h[4] % 90, h[5] % 90]
  ];
}

/* opts.grid = [cols, rows]: draw a cell grid (trickplay sheets), each cell a
 * different shade so a background-position crop is visibly distinct. */
export function png(width, height, seed, opts = {}) {
  width = Math.max(1, Math.min(4000, Math.round(width)));
  height = Math.max(1, Math.min(4000, Math.round(height)));
  const [a, b] = palette(seed);
  const row = 1 + width * 3;
  const raw = Buffer.alloc(row * height);
  const band0 = Math.floor(height * 0.62);
  const band1 = Math.floor(height * 0.7);
  const [gc, gr] = opts.grid || [0, 0];
  for (let y = 0; y < height; y++) {
    const o = y * row;
    raw[o] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      let t = (x / width + y / height) / 2;
      if (gc) {
        const cell = Math.floor((x / width) * gc) + Math.floor((y / height) * gr) * gc;
        t = (cell % 7) / 7;
      }
      const band = !gc && y >= band0 && y < band1;
      const p = o + 1 + x * 3;
      for (let c = 0; c < 3; c++) raw[p + c] = band ? 230 - c * 30 : Math.round(a[c] * (1 - t) + b[c] * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
