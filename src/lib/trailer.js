/* Trailers — played in our own player (openTrailer), with the TV's YouTube app
 * as the fallback (playTrailer).
 *
 * In-app: reel-api fetches the video with yt-dlp and remuxes it to fMP4
 * segments; trailerstream.js preloads a few seconds and feeds them to the
 * <video> through MSE (see there, and playTrailerStream in player.svelte.js).
 * When that fails — yt-dlp broken by a YouTube change, the NAS down — the
 * trailer opens in the YouTube app instead, with a toast saying so.
 *
 * The YouTube-app path:
 *
 * Every trailer this app knows about is a YouTube video: Jellyfin's
 * `RemoteTrailers` (TMDB's list, on a library movie or series) and Radarr's
 * `youTubeTrailerId` (mlMetadata's `trailer`, for a title not in the library).
 * There are no local trailer files on the NAS (LocalTrailerCount 0 everywhere,
 * measured 2026-09-28), and an embedded player is no option from a file://
 * origin, so the trailer opens in `youtube.leanback.v4` through the
 * applicationManager — the same launch the launcher does, which a web app may
 * call. Measured on the TV: YouTube comes forward, shows its "Who's watching?"
 * picker if it has several profiles, then plays `#/watch?v=…`. Back in YouTube
 * stays in YouTube; relaunching VibeReel resumes it on the same page
 * (lifecycle.js restores focus). */

import { playTrailerStream } from './player.svelte.js';
import { toast } from './toast.svelte.js';

const YT_APP = 'youtube.leanback.v4';

/* The Trailer button: `title` and `art` (a backdrop URL) dress the loading card
 * and the OSD. */
/** @param {string | null | undefined} id YouTube video id (none: a no-op) @param {{ title?: string | null, art?: string | null }} [dress] */
export function openTrailer(id, { title, art } = {}) {
  if (!id) return;
  playTrailerStream({
    id,
    title,
    art,
    onFail: (/** @type {Error} */ e) => {
      toast('Couldn’t load the trailer here (' + ((e && e.message) || 'error') + ') — opening YouTube');
      playTrailer(id).then((ok) => ok || toast('Couldn’t open YouTube either'));
    }
  });
}

/* A YouTube video id out of any of the URL shapes TMDB hands out. */
/** @param {string | null | undefined} url @returns {string | null} the 11-character id */
export function youtubeId(url) {
  const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([\w-]{11})/.exec(url || '');
  return m ? m[1] : null;
}

/* The best trailer of a Jellyfin item's RemoteTrailers, or null. TMDB's list
 * mixes in teasers, clips and featurettes, sometimes ahead of the trailer: an
 * "Official Trailer" wins, then any trailer, then a teaser; ties keep TMDB's
 * order. A dub is only taken when no undubbed trailer or teaser is listed:
 * every dubbed trailer stays between a teaser (2) and a clip (0) — 'Official
 * Trailer' dub 1.5, plain 'Trailer' dub 0.5. */
/** @param {Jf.BaseItemDto | null | undefined} item @returns {string | null} a YouTube id */
export function pickTrailer(item) {
  let best = null;
  let bestScore = -Infinity;
  for (const t of (item && item.RemoteTrailers) || []) {
    const id = youtubeId(t.Url);
    if (!id) continue;
    const n = (t.Name || '').toLowerCase();
    let score = 0;
    if (/trailer/.test(n)) score += 4;
    if (/official/.test(n)) score += 1;
    if (/teaser/.test(n)) score += 2;
    if (/\bdub/.test(n)) score -= 3.5;
    if (score > bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}

/* Open the trailer in YouTube. Resolves true once the launch was accepted. */
/** @param {string} id YouTube video id @returns {Promise<boolean>} */
export function playTrailer(id) {
  if (!id) return Promise.resolve(false);
  if (__PHONE__) {
    /* iPhone: the YouTube web page (a universal link — the YouTube app takes it
     * if installed). This runs after the in-app attempt failed, i.e. outside the
     * tap, where Safari may block a popup: then navigate instead — a standalone
     * web app shows off-origin pages in an in-app browser sheet with Done. */
    const web = 'https://www.youtube.com/watch?v=' + id;
    let w = null;
    try {
      w = window.open(web, '_blank');   // no 'noopener': that makes open() return null always
    } catch {}
    if (!w) {
      try {
        location.href = web;
      } catch {
        return Promise.resolve(false);
      }
    }
    return Promise.resolve(true);
  }
  const url = 'https://www.youtube.com/tv?v=' + id;
  if (typeof window.PalmServiceBridge !== 'function') {
    // Dev in a desktop browser: the web page is the closest thing.
    window.open('https://www.youtube.com/watch?v=' + id, '_blank');
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (/** @type {boolean} */ ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    try {
      // typeof-checked above; the narrowing doesn't reach into this executor
      const bridge = new (/** @type {NonNullable<typeof window.PalmServiceBridge>} */ (window.PalmServiceBridge))();
      bridge.onservicecallback = (msg) => {
        let r = null;
        try {
          r = JSON.parse(msg);
        } catch {}
        finish(!!(r && r.returnValue));
      };
      bridge.call(
        'luna://com.webos.applicationManager/launch',
        JSON.stringify({ id: YT_APP, params: { contentTarget: url } })
      );
    } catch {
      finish(false);
    }
    // No answer is not a failure we can report honestly — YouTube may still
    // come up — but the button must not stay "Opening…" forever.
    setTimeout(() => finish(true), 5000);
  });
}
