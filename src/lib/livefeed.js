/* iPhone: watch a download while it is still coming in.
 *
 * The TV plays the growing MKV straight off reel-api's Range endpoint; Safari
 * can't play MKV at all. So reel-api (livehls.py) remuxes the growing file —
 * video copied, audio copied or converted to AC-3/AAC — into an HLS event
 * playlist of fMP4 segments that grows with the download, and segfeed.js
 * appends those segments to a ManagedMediaSource. One server job per
 * (download, audio track): switching the audio track starts a new one.
 *
 * Seeking past what has been downloaded waits at that point — the player's
 * pending-stream wording ("Waiting for download — 43%") covers it. The server
 * drops a job nobody asked about for 10 minutes, so this pings its status
 * while the stream is open, and re-starts a job that has gone (a 404).
 *
 * Phone-only (pendingplay.js calls it inside `if (__PHONE__)`). */
import { cfg } from './config.js';
import { createSegFeeder, parsePlaylist } from './segfeed.js';
import { videoEl } from './player.svelte.js';

const READY_TIMEOUT_MS = 5 * 60 * 1000;
const PING_MS = 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A feeder factory for player.svelte.js's playFeedStream(): open({ audioIndex,
 * position, jump, onFail }) → { url, managed, stop }. */
export function liveOpener(downloadId) {
  const base = cfg.medialib + '/api/downloads/' + encodeURIComponent(downloadId) + '/hls';
  return ({ audioIndex, position, jump, onFail }) => {
    const audio = audioIndex >= 0 ? audioIndex : -1;
    const ac = new AbortController();
    const q = '?audio=' + audio;
    const files = base + '/' + audio + '/';
    const json = async (method) => {
      const r = await fetch(base + q, { method, signal: ac.signal, cache: 'no-store' });
      const b = await r.json().catch(() => null);
      if (!r.ok || !b) {
        const e = new Error((b && b.detail) || 'HTTP ' + r.status);
        e.status = r.status;
        throw e;
      }
      return b;
    };
    let ping = 0;
    let restarting = null;
    const restart = () => (restarting ||= json('POST').catch(() => {}).finally(() => (restarting = null)));

    const feeder = createSegFeeder({
      position,
      jump,
      media: videoEl(),
      onFail: (e) => {
        clearInterval(ping);
        onFail && onFail(e);
      },
      preloadS: 6,
      async prepare() {
        let st = await json('POST');
        const t0 = Date.now();
        while (st.state === 'probing' || !st.codecs) {
          if (st.state === 'error') throw new Error(st.error || 'the download can’t be streamed');
          if (Date.now() - t0 > READY_TIMEOUT_MS) throw new Error('the download didn’t start in time');
          await sleep(1000);
          st = await json('GET');
        }
        if (st.state === 'error') throw new Error(st.error || 'the download can’t be streamed');
        ping = setInterval(() => json('GET').catch((e) => e.status === 404 && restart()), PING_MS);
        return { codecs: st.codecs, duration: st.duration || 0 };
      },
      async playlist() {
        const r = await fetch(files + 'index.m3u8', { signal: ac.signal, cache: 'no-store' });
        if (r.status === 404) {
          restart();
          return { segs: [], complete: false };
        }
        if (!r.ok) throw new Error('playlist: HTTP ' + r.status);
        return parsePlaylist(await r.text());
      },
      async fetchInit() {
        for (let i = 0; i < 30; i++) {
          const r = await fetch(files + 'init.mp4', { signal: ac.signal, cache: 'no-store' });
          if (r.ok) return r.arrayBuffer();
          await sleep(1000);
        }
        return null;
      },
      async fetchSeg(seg) {
        const r = await fetch(files + seg.name, { signal: ac.signal, cache: 'no-store' });
        if (r.status === 404) {
          restart();   // the job was dropped (idle) — it remuxes again from the start
          return null;
        }
        if (!r.ok) throw new Error(seg.name + ': HTTP ' + r.status);
        return r.arrayBuffer();
      }
    });
    return {
      url: feeder.url,
      managed: feeder.managed,
      stop() {
        clearInterval(ping);
        ac.abort();
        feeder.stop();
      }
    };
  };
}
