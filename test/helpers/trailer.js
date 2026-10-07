/* A fake reel-api trailer job (trailers.py) for trailerstream.js tests.
 *
 *   const srv = trailerServer({ net, mse: () => mse, base, ...opts });
 *
 * Routes on `base`: POST/GET `base` = the job status, `base/index.m3u8`,
 * `base/init.mp4`, `base/sNNN.m4s` (helpers/mse.js fake segments carrying their
 * media range), `base/subs.vtt`.
 *   status   array of status objects (the POST answers the first, every GET the next; the last repeats)
 *            or a function (n, t) → status, t = ms since start; { httpStatus, body } answers an HTTP error
 *   segs     the playlist ([{ start, end, name }]); `srv.segs` is live (push to grow it)
 *   complete EXT-X-ENDLIST present (`srv.complete` is live)
 *   media    (seg) → [a, b] — the media range a segment really holds (default its EXTINF range)
 *   hold     (name) → true: that segment's fetch waits until srv.release(name)
 *   vtt      subs.vtt body
 * srv.fetched lists init/segment/subs downloads in order, srv.statusCalls { method, t }. */

export const READY = { state: 'ready', duration: 100, codecs: 'avc1.640028,mp4a.40.2', subs_done: true, subs: null };

/** `n` segments of `len` s each: [{ start, end, name }] */
export function uniform(n, len = 4, from = 0) {
  return Array.from({ length: n }, (_, i) => ({ start: from + i * len, end: from + (i + 1) * len, name: 's' + String(i).padStart(3, '0') + '.m4s' }));
}

export function m3u8(segs, complete) {
  let s = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI="init.mp4"\n';
  for (const g of segs) s += '#EXTINF:' + (g.end - g.start).toFixed(3) + ',\n' + g.name + '\n';
  if (complete) s += '#EXT-X-ENDLIST\n';
  return s;
}

export function trailerServer({ net, mse, base: BASE, ...o }) {
  const s = {
    segs: o.segs || uniform(25),
    complete: o.complete ?? true,
    fetched: [],
    statusCalls: [],
    held: new Map(),
    release(name) {
      const r = s.held.get(name);
      s.held.delete(name);
      r && r();
    }
  };
  const t0 = Date.now();
  const status = (n) => {
    if (typeof o.status === 'function') return o.status(n, Date.now() - t0);
    const list = o.status || [READY];
    return list[Math.min(n, list.length - 1)];
  };
  net.on(null, BASE, (req) => {
    s.statusCalls.push({ method: req.method, t: Date.now() - t0 });
    const st = status(s.statusCalls.length - 1);
    return st && st.httpStatus ? net.status(st.httpStatus, st.body) : st;
  });
  net.on('GET', BASE + '/index.m3u8', () => net.text(m3u8(s.segs, s.complete), 'application/vnd.apple.mpegurl'));
  net.on('GET', BASE + '/init.mp4', () => {
    s.fetched.push('init.mp4');
    return mse().initSegment(600);
  });
  net.on('GET', (req) => req.url.startsWith(BASE + '/s') && req.url.endsWith('.m4s'), (req) => {
    const name = req.url.slice(BASE.length + 1);
    const seg = s.segs.find((g) => g.name === name);
    if (!seg) return net.status(404);
    s.fetched.push(name);
    const [a, b] = o.media ? o.media(seg) : [seg.start, seg.end];
    const buf = mse().segment(a, b, 2048);
    if (o.hold && o.hold(name)) return new Promise((res) => s.held.set(name, () => res(buf)));
    return buf;
  });
  net.on('GET', BASE + '/subs.vtt', () => {
    s.fetched.push('subs.vtt');
    return net.text(o.vtt ?? 'WEBVTT\n\n00:00.500 --> 00:02.000\nHello\n', 'text/vtt');
  });
  return s;
}
