/* A YouTube trailer as a MediaSource for our own <video> — the feeding half of
 * in-app trailers (the player half is playTrailerStream() in player.svelte.js).
 *
 * reel-api (`trailers.py`) fetches the trailer with yt-dlp — the best video up
 * to 4K (AV1/VP9/H.264, HDR where offered) and the original-language audio —
 * and remuxes it, without re-encoding, into an HLS *event* playlist of fMP4
 * segments while it downloads. The TV's own HLS player can't be handed that
 * playlist while it grows — measured 2026-09-28: it treats it as live, joins
 * 4–20 s in at the "live edge", ignores EXT-X-START and a seek to 0, and reports
 * an infinite duration. So this appends the segments itself through Media
 * Source Extensions (what the YouTube TV app does on this Chromium): the
 * duration is known up front (yt-dlp), playback starts at 0, and seeking works.
 *
 * "Preload, then play": nothing is appended until PRELOAD_S seconds of segments
 * are in memory, so the first frame the element shows is the start of a buffer
 * that already runs several seconds ahead; the rest streams in behind it.
 *
 * A 4K trailer is ~150 MB — more than a SourceBuffer holds — so this is a small
 * buffer manager, not a one-way pipe: it keeps up to AHEAD_S seconds appended
 * ahead of the playhead, drops what lies more than BEHIND_S behind it, and
 * after a seek into a stretch that isn't (or is no longer) buffered, fetches
 * from the segment the playhead landed in. Segments are addressed by their
 * cumulative #EXTINF start times; ffmpeg's fMP4 segments carry absolute
 * timestamps (tfdt), so they land at the right place in whatever order. */

import { cfg } from './config.js';

const PRELOAD_S = 6;
/* iPhone: a 1080p trailer (see createTrailerSource) at 3–8 Mbit/s — 30 s ahead
 * is plenty, and memory is tighter than on the TV. */
const AHEAD_S = __PHONE__ ? 30 : 45;
const BEHIND_S = __PHONE__ ? 5 : 15;
const POLL_MS = 300;
const SUBS_WAIT_MS = 1500;
const READY_TIMEOUT_MS = 45000;   // yt-dlp resolves in ~2 s; this is "YouTube said no"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* iPhone: iOS 17.1+ has no MediaSource on iPhone, only ManagedMediaSource —
 * the same API plus two rules: the page must turn remote playback off on the
 * <video> (startPlayback does, from `managed` below), and the UA says when it
 * wants data ('startstreaming'/'endstreaming', `ms.streaming`) and may evict
 * buffered ranges on its own. The feeder already re-fetches whatever isn't
 * buffered any more; it only has to stop fetching ahead while streaming is off. */
function mediaSourceClass() {
  if (__PHONE__ && !window.MediaSource && window.ManagedMediaSource) return window.ManagedMediaSource;
  return window.MediaSource;
}

/* `onFail(err)`: the trailer can't be had (yt-dlp failed, the service is down,
 * the codec is refused). `onInfo(status)`: the server's status once known
 * (duration, resolution, codecs) — for the OSD. `position()`: the playhead;
 * `jump(t)`: a quiet seek, for stepping over a hole between buffered ranges.
 * `onSubs(vttText, subs)`: English subtitles exist (the server fetches them next to
 * the video, usually done before the first frame); never called without.
 * Returns { url, stop }. */
export function createTrailerSource(id, { onFail, onInfo, onSubs, position, jump }) {
  // iPhone: at most 1080p (`<id>@1080`, trailers.py) — a 4K trailer is ~150 MB
  // for a screen that shows a fraction of it. The TV gets the best up to 4K.
  // (`let`: a backend from before `@<height>` refuses the key, see run().)
  let base = __PHONE__
    ? cfg.medialib + '/api/trailers/' + encodeURIComponent(id) + '@1080'
    : cfg.medialib + '/api/trailers/' + encodeURIComponent(id);
  const MS = __PHONE__ ? mediaSourceClass() : MediaSource;
  const ms = new MS();
  const managed = __PHONE__ && typeof window.ManagedMediaSource === 'function' && ms instanceof window.ManagedMediaSource;
  const url = URL.createObjectURL(ms);
  const ac = new AbortController();
  let dead = false;

  const fetchJson = async (path, method = 'GET') => {
    const r = await fetch(base + path, { method, signal: ac.signal, cache: 'no-store' });
    const b = await r.json().catch(() => null);
    if (!r.ok || !b) throw new Error((b && (b.detail || b.error)) || 'HTTP ' + r.status);
    return b;
  };
  const fetchBuf = async (name) => {
    const r = await fetch(base + '/' + name, { signal: ac.signal });
    if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
    return r.arrayBuffer();
  };
  /* segments with their start/end on the media timeline */
  const playlist = async () => {
    const r = await fetch(base + '/index.m3u8', { signal: ac.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('playlist: HTTP ' + r.status);
    const text = await r.text();
    const segs = [];
    const re = /#EXTINF:([\d.]+),?\s*\n(s\d+\.m4s)/g;
    let t = 0;
    for (let m; (m = re.exec(text)); ) {
      const d = parseFloat(m[1]);
      segs.push({ start: t, end: t + d, name: m[2] });
      t += d;
    }
    return { segs, complete: text.includes('#EXT-X-ENDLIST') };
  };

  async function run() {
    // 1. start (or join) the server's job and wait until a few seconds exist
    let st = __PHONE__
      ? await fetchJson('', 'POST').catch((e) => {
          // a backend from before `@<height>` answers 400 "not a YouTube video
          // id": play its (up to 4K) trailer rather than none
          if (!/not a YouTube video id/.test(e.message)) throw e;
          base = cfg.medialib + '/api/trailers/' + encodeURIComponent(id);
          return fetchJson('', 'POST');
        })
      : await fetchJson('', 'POST');
    const t0 = Date.now();
    // Also wait (≤ SUBS_WAIT_MS past "enough video") for the subtitle lookup,
    // so the first lines aren't missed — measured: attached ~1 s after the
    // first frame otherwise, and the opening cues were gone.
    let enoughAt = 0;
    for (;;) {
      if (st.state === 'error') throw new Error(st.error || 'the trailer could not be fetched');
      const enough = st.state === 'ready' || (st.state === 'downloading' && st.buffered_s >= PRELOAD_S);
      if (enough && !enoughAt) enoughAt = Date.now();
      if (enough && (st.subs_done || Date.now() - enoughAt > SUBS_WAIT_MS)) break;
      if (Date.now() - t0 > READY_TIMEOUT_MS) throw new Error('the trailer took too long to start');
      await sleep(POLL_MS);
      if (dead) return;
      st = await fetchJson('');
    }
    if (dead) return;
    onInfo && onInfo(st);
    let subsDone = false;
    // The VTT is fetched here, during the preload, and handed over as text:
    // told only the URL, the player fetched it after the first frame and the
    // opening cues were already gone (measured).
    const subsCheck = async (x) => {
      if (subsDone || !x.subs_done) return;
      subsDone = true;
      if (!x.subs || !onSubs) return;
      try {
        const r = await fetch(base + '/subs.vtt', { signal: ac.signal });
        if (r.ok && !dead) onSubs(await r.text(), x.subs);
      } catch {}
    };
    await subsCheck(st);
    let lastStatus = Date.now();

    const mime = 'video/mp4; codecs="' + (st.codecs || (st.vcodec || 'avc1.640028') + ',mp4a.40.2') + '"';
    if (!(__PHONE__ ? MS : MediaSource).isTypeSupported(mime)) throw new Error((__PHONE__ ? 'this iPhone refuses ' : 'the TV refuses ') + mime);
    if (st.duration) ms.duration = st.duration;
    const sb = ms.addSourceBuffer(mime);

    const op = (fn) =>
      new Promise((res, rej) => {
        const done = () => {
          sb.removeEventListener('error', fail);
          res();
        };
        const fail = () => {
          sb.removeEventListener('updateend', done);
          rej(new Error('the TV rejected a segment'));
        };
        sb.addEventListener('updateend', done, { once: true });
        sb.addEventListener('error', fail, { once: true });
        fn();
      });
    const here = () => (position ? position() : 0);
    /* end of the buffered range that contains t (small gaps tolerated), or null */
    const bufferedEnd = (t) => {
      const b = sb.buffered;
      for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.05 && t <= b.end(i) + 0.05) return b.end(i);
      return null;
    };
    const inBuf = new Set();   // segment names appended (the buffer may have dropped some since)
    const trimBehind = async () => {
      const cut = here() - BEHIND_S;
      if (cut > 1 && sb.buffered.length && sb.buffered.start(0) < cut) await op(() => sb.remove(0, cut));
    };
    const append = async (buf) => {
      for (;;) {
        try {
          // (on an 'ended' source this re-opens it — a seek back into a
          // dropped stretch after the last segment went in)
          await op(() => sb.appendBuffer(buf));
          return;
        } catch (e) {
          if (e.name !== 'QuotaExceededError' || dead) throw e;
          await trimBehind();   // full: free what has been watched, or wait for the playhead
          await sleep(500);
          if (dead) return;
        }
      }
    };

    // 2. preload: init + the first PRELOAD_S seconds into memory, then append
    let pl = await playlist();
    const init = await fetchBuf('init.mp4');
    const first = [];
    for (const seg of pl.segs) {
      if (seg.start >= PRELOAD_S) break;
      first.push(await fetchBuf(seg.name));
      if (dead) return;
    }
    await append(init);
    for (let i = 0; i < first.length; i++) {
      if (dead) return;
      await append(first[i]);
      inBuf.add(pl.segs[i].name);
    }

    // 3. keep AHEAD_S seconds ahead of the playhead, wherever it goes
    let lastPoll = Date.now();
    for (;;) {
      if (dead) return;
      if (!pl.complete && Date.now() - lastPoll >= POLL_MS) {
        pl = await playlist();
        lastPoll = Date.now();
      }
      if (!subsDone && Date.now() - lastStatus >= 1000) {
        lastStatus = Date.now();
        await subsCheck(await fetchJson(''));
      }
      const t = here();
      // Step over a small hole the TV won't cross by itself: its pipeline
      // stalls at the end of a buffered range even when the next one starts
      // milliseconds later (hls.js and Shaka do the same "gap jumping").
      if (jump && sb.buffered.length) {
        const b = sb.buffered;
        for (let i = 0; i < b.length - 1; i++) {
          if (t >= b.end(i) - 0.25 && t < b.start(i + 1) && b.start(i + 1) - b.end(i) < 1) jump(b.start(i + 1) + 0.05);
        }
      }
      const from = bufferedEnd(t) ?? t;           // unbuffered playhead: fetch from there
      // The next segment the playhead will need that isn't in the buffer. A
      // segment counts as in when its midpoint is buffered — not by comparing
      // ends, which skipped a 0.17 s segment (measured: s009, 40.214–40.381)
      // and left a hole playback hung in.
      const covered = (seg) => bufferedEnd((seg.start + seg.end) / 2) != null && inBuf.has(seg.name);
      const next = from < t + AHEAD_S ? pl.segs.find((seg) => seg.end > t && !covered(seg)) : null;
      // ManagedMediaSource said "enough for now": hold off fetching ahead, but
      // never while the playhead itself sits outside the buffer.
      if (__PHONE__ && managed && next && !ms.streaming && bufferedEnd(t) != null && from - t >= PRELOAD_S) {
        await waitStreaming();
        continue;
      }
      if (next) {
        const b = await fetchBuf(next.name);
        if (dead) return;
        await trimBehind();
        await append(b);
        inBuf.add(next.name);
        continue;
      }
      // everything to the end is in: close the stream so 'ended' can fire
      const last = pl.segs[pl.segs.length - 1];
      if (pl.complete && last && covered(last) && !pl.segs.some((seg) => seg.end > t && !covered(seg)) &&
          ms.readyState === 'open' && !sb.updating) ms.endOfStream();
      await sleep(POLL_MS);
    }
  }

  // Resolves on the next 'startstreaming' (or after a poll period, so a seek
  // into an evicted stretch is still noticed by the loop).
  const waitStreaming = () =>
    new Promise((res) => {
      const t = setTimeout(done, POLL_MS * 3);
      function done() {
        clearTimeout(t);
        ms.removeEventListener('startstreaming', done);
        res();
      }
      ms.addEventListener('startstreaming', done);
    });

  ms.addEventListener(
    'sourceopen',
    () => {
      run().catch((e) => {
        if (!dead && e.name !== 'AbortError') onFail && onFail(e);
      });
    },
    { once: true }
  );

  return {
    url,
    ...(__PHONE__ ? { managed } : {}),
    stop() {
      dead = true;
      ac.abort();
      URL.revokeObjectURL(url);
    }
  };
}
