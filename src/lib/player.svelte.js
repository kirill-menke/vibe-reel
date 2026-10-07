import { cfg } from './config.js';
import { api, qs, errText, TICKS, prefetch, holdReads, itemPath } from './api.js';
import { invalidatePlayState } from './played.js';
import { ticksToSec, fmtTime } from './format.js';
import {
  describeTracks, deviceProfile, needsBurnIn, streamByIndex, isBurnCodec, pickSource,
  videoStream, resShort, hdrLabel, audioBadge, langKey, isSdh, PHONE_CAP_BOX
} from './tracks.js';
import { findMarkers, communityMarkers } from './segments.js';
import { mlSegments } from './medialib.js';
import { createTrailerSource } from './trailerstream.js';
import { startTracks, rememberAudio, rememberSub } from './trackprefs.js';
import { toast } from './toast.svelte.js';
import { SET } from './settings.svelte.js';
import { S, openHome, openItem, openPending, openLookup, returnHome } from './nav.svelte.js';
import { focusKey } from './focus.js';
import { resetRefreshRate, cancelRefreshReset } from './refresh60.js';
/* loadPgs() is made by the lazy-libpgs plugin in vite.config.js: the vendored
 * module body only runs the first time a PGS track is shown. */
import { loadPgs } from '../vendor/libpgs.js';

/* Reactive slice of player state — what the OSD and the dropdown panel read. */
/** @type {VR.PlayerState} */
export const P = $state(/** @satisfies {VR.PlayerState} */ ({
  item: null,
  source: null,
  /* true while playing a still-downloading file streamed straight from the
   * media-library service (see playPendingStream): no Jellyfin item exists, so
   * every Jellyfin side call (progress reports, intro lookup, subtitle fetch,
   * session info) is gated off and exit returns to the pending screen. */
  pending: false,
  trailer: false,     // a YouTube trailer in our own player (playTrailerStream) — P.pending is set too
  sessionId: '',
  audioIndex: -1,
  subIndex: -1,
  playMethod: 'DirectPlay',
  detailItem: null,
  series: null,
  seasons: null,
  panel: null,        // which OSD dropdown is open: null | 'audio' | 'subs' | 'picture'
  osdShown: false,
  spinner: false,
  paused: true,
  pos: 0,
  dur: 0,
  skips: [],          // [{ kind: 'intro'|'recap'|'preview', start, end, from }] — the Skip chip's windows (segments.js)
  skipped: null,      // 'kind:start' of the window just skipped — its chip stays down (see skipSegment)
  credits: null,      // { start, end, from } for this item's closing credits, or null
  next: null,         // the episode Up Next would play (a Jellyfin item), or null
  upNextOff: false,   // the Up Next card was dismissed with Back for this pass
  trick: null,        // trickplay sheet layout for this item (see lookUpTrickplay), or null
  scrub: null,        // pending scrubber target in seconds while previewing, or null
  pictureModes: [],
  pictureMode: null,
  picErr: false,
  picLoading: false,  // /modes request in flight (the panel shows "Loading…" only then)
  picPending: null,   // mode asked of the service, not yet confirmed
  subOffset: 0,       // subtitle timing shift in seconds (+ = later); reset per item
  /* transport / loading / error (the OSD side) */
  loading: false,     // from startPlayback() until the first frame plays — the backdrop card
  loadingItem: null,  // what the loading card describes while Up Next is swapping items
  loadingFrom: 0,     // start position the loading card announces ("Resuming from 1:23:45"), seconds
  downloadId: null,   // pending streams: the grab's info-hash, for "Waiting for download — 43%"
  error: null,        // { title, detail, tech } while the playback error card is up
  slowNet: null,      // { need, got } Mbit/s once stalls show the link can't carry this file (stall watchdog)
  link: null,         // { got, at }: the last slowNet measurement, kept across playbacks for TechGrid's detail-page note
  chapters: [],       // [{ at, name }] for the scrubber ticks and the Chapters list
  // phone: the stream's quality under the Settings cap (phoneQuality), null while uncapped
  ...(__PHONE__ ? { quality: null } : {})
}));

/* Seek step for ⏪/⏩ and the remote's Rewind/FastForward — one convention
 * everywhere: a short hop back to re-catch a line, a longer one forward. */
export const SEEK_BACK = 10;
export const SEEK_FWD = 30;

/* ---------------- phone: streaming quality cap ----------------
 * Settings → "Streaming quality" (and the player's Quality picker, pmSetQuality):
 * 'original' | 8000000 | 4000000 (bit/s). iOS Safari has no
 * navigator.connection, so the app can't tell cellular from Wi-Fi: a chosen cap
 * applies to every stream until set back to Original. A file above the cap is
 * re-encoded on the NAS — H.264, boxed to 1080p / 720p, HDR tone-mapped to SDR
 * (tracks.js PHONE_CAP_BOX has the measurements); a file under it still plays
 * as it is. Stored per device (localStorage reel.qualityCellular — the key
 * predates the merge into one setting). Plain functions, not $state: Settings
 * keeps its own reactive copy, the player reads P.quality. TV: unused
 * (tree-shaken). */
const QUALITY_KEY = 'reel.qualityCellular';
/** Wider than VR.QualityCap, so `.includes(Number(v))` type-checks.
 * @type {Array<number | 'original'>} */
export const QUALITY_CAPS = ['original', 8000000, 4000000];
const OSD_HIDE_PHONE = 3500;   // SPEC §6 --dur-hide

export function getQualityCap() {
  let v = null;
  try {
    v = localStorage.getItem(QUALITY_KEY);
  } catch {}
  const n = Number(v);
  return QUALITY_CAPS.includes(n) ? n : 'original';
}

/** @param {number | 'original'} v bit/s, or 'original' (no cap) */
export function setQualityCap(v) {
  try {
    if (QUALITY_CAPS.includes(v) && v !== 'original') localStorage.setItem(QUALITY_KEY, String(v));
    else localStorage.removeItem(QUALITY_KEY);
  } catch {}
}

function phoneBitrate() {
  const c = getQualityCap();
  return c === 'original' ? 200000000 : c;
}

/* What the stream actually runs at, for the slow-link hint: the file's bitrate,
 * or the cap when Jellyfin re-encodes above it (the encoder's VBR stays under
 * it: measured 5.8–8.0 Mbit/s at 8, 3.1–3.8 at 4 — so "got" errs high, never low). */
function phoneStreamBps() {
  const b = (P.source && P.source.Bitrate) || 0;
  return b ? Math.min(b, phoneBitrate()) : 0;
}

/* The running stream under a cap, for the player's info line and Quality
 * picker: null while uncapped, else { cap, mbit, reduced, res, label }. `reduced`:
 * Jellyfin re-encodes the video to fit — its URL then carries the box as
 * MaxWidth (the profile's Conditions apply only to a video re-encode) and
 * ContainerBitrateExceedsLimit. Otherwise the file fits and is copied. */
/** @param {VR.PlayerSource | null} src @returns {VR.PhoneQuality | null} */
function phoneQuality(src) {
  const cap = getQualityCap();
  if (cap === 'original' || !src) return null;
  let q = null;
  try {
    q = new URL(src.TranscodingUrl || '', location.href).searchParams;
  } catch {}
  const mbit = Math.round(cap / 1e6);
  const reduced = !!q && !!src.TranscodingUrl && (!!q.get('MaxWidth') || /ContainerBitrateExceedsLimit/.test(q.get('TranscodeReasons') || ''));
  if (!reduced) return { cap, mbit, reduced: false, res: '', label: 'Original · fits ' + mbit + ' Mbit/s' };
  const v = videoStream(src);
  const box = PHONE_CAP_BOX[cap];
  let w = v && v.Width;
  let h = v && v.Height;
  if (w && h && box) {
    const k = Math.min(1, box[0] / w, box[1] / h);
    w = Math.round(w * k);
    h = Math.round(h * k);
  }
  const res = w && h ? resShort(w, h) : '';
  return { cap, mbit, reduced: true, res, label: [res, mbit + ' Mbit/s (reduced)'].filter(Boolean).join(' · ') };
}

/* The player's Quality picker: the same per-device setting as Settings (so it
 * holds for the next video too), and the running stream restarts at the same
 * position under the new cap — the audio switch's restart. Trailers and
 * pending streams never go through PlaybackInfo, so there it only stores. */
/** @param {number | 'original'} v */
export function pmSetQuality(v) {
  if (!__PHONE__ || !QUALITY_CAPS.includes(v) || v === getQualityCap()) return;
  setQualityCap(v);
  if (P.pending || !P.item || S.screen !== 'player') return;
  const pos = restartPos();
  P.loading = true;
  P.loadingFrom = pos;
  restartPlayback(pos);
}

/* Non-reactive internals: element handles, timers, the PGS renderer. */
/** @type {HTMLVideoElement | null} */
let video = null;
/** @type {HTMLCanvasElement | null} */
let pgsCanvas = null;
/** @type {import('../vendor/libpgs.js').PgsRenderer | null} */
let pgsRenderer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let reportTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let osdTimer = null;
/** Seconds; set for ~900 ms after a seek (see effectivePos). @type {number | null} */
let seekTarget = null;
let introReq = 0;       // generation counter — a late marker/next-episode lookup must not land on the next item
let advancing = false;  // playNext() is tearing down one episode and starting the next
/* Bumped by every play() and every exitPlayer(). A start whose requests are
 * still in flight when the player is closed (Back during the spinner, or the
 * app being parked) checks it and gives up instead of starting playback over
 * the page the user already went back to. */
let playGen = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let seekClearT = null;
/* Transport bookkeeping for the error card's Retry: what was last started
 * (a Jellyfin id, or the pending stream's URL), and the last good position. */
/** @type {string | null} */
let lastPlayId = null;
/** @type {string | null} */
let lastUrl = null;
let lastPos = 0;
let startGen = 0;       // bumped by every startPlayback(): a stale once-listener from a failed start stays quiet
/** @type {string | null} */
let stoppedSession = null;  // the PlaySessionId already reported Stopped — never report one twice
/** @type {Map<string, string>} */
const newestSession = new Map();  // item id → its latest PlaySessionId (postStopped's retry guard)
let autoSkipped = new Set();  // kinds the auto-skip settings already skipped for this item (once each)
/** @type {string | null} */
let warmedNext = null;  // the Up Next episode whose item was prefetched
/** @type {number | null} */
let upNextFrom = null;  // where the playhead entered the Up Next window this pass (upNextWindow())
/** @type {string | null} */
let homeReturn = null;  // focus key on Home to exit to, when playback started there (play())
/** @type {string | null} */
let homeReturnNext = null;  // playFromHome(): the tile the next play() came from

/** @param {HTMLVideoElement | null} el */
export function setVideoEl(el) {
  video = el;
}
/** @param {HTMLCanvasElement | null} el */
export function setPgsCanvas(el) {
  pgsCanvas = el;
  sizePgs();
}
export function videoEl() {
  return video;
}

export function sizePgs() {
  if (!pgsCanvas) return;
  pgsCanvas.width = window.innerWidth;
  pgsCanvas.height = window.innerHeight;
}

/* Seed the track selection from a fully-loaded item, then play it. This is what
 * the detail screen did inline before calling play(); the hero tiles now go
 * through it too, so P.detailItem always describes the item actually playing
 * (the vanilla hero button could start a new item while detailItem still
 * pointed at whatever detail page was last opened). */
/** @param {Jf.BaseItemDto} item a fully-loaded item (MediaSources, UserData) @param {number} [resumeSec] */
export function playItem(item, resumeSec) {
  P.pending = false;
  P.detailItem = item;
  const src = pickSource(item);
  P.source = src;
  // The series' remembered audio/subtitle choice where this file has it, the
  // describeTracks() default otherwise (trackprefs.js). Resolved here, before
  // play(), because play() decides DirectPlay vs burn-in from P.subIndex — a
  // remembered VobSub/DVB choice has to reach it as a burn-in request.
  const t = startTracks(src, item);
  P.audioIndex = t.audio;
  P.subIndex = t.sub;
  P.subOffset = 0;
  play(item.Id, resumeSec || 0);
}

/* OK on a Continue Watching / Next Up tile: play straight away, and let Back
 * out of the player return to Home on `key` (that tile) instead of the hero. */
/** @param {Jf.BaseItemDto} item @param {string} key the Home tile's data-focus */
export function playFromHome(item, key) {
  const sec = ticksToSec((item.UserData || {}).PlaybackPositionTicks);
  homeReturnNext = key;
  playItem(item, sec > 30 ? Math.floor(sec) : 0);
}

/* Resolves true once playback of the episode has been requested, false if the
 * item couldn't be loaded (already toasted) — playNext() needs to know.
 * `wanted` is re-checked once the item arrives; false drops the start. */
/** @param {string} id @param {() => boolean} [wanted] @returns {Promise<boolean>} */
export function playEpisode(id, wanted = () => true) {
  const epoch = S.epoch;   // see play(): Back while this loads cancels the start
  return /** @type {Promise<Jf.BaseItemDto>} */ (api(itemPath(id)))
    .then((ep) => {
      if (!wanted() || epoch !== S.epoch) return false;
      // Episodes rarely carry genres; borrow the series' (the detail page's
      // item, or the previous episode that already borrowed them) so anime
      // episodes still pick the Japanese track.
      const ctx = P.detailItem;
      if (!ep.Genres?.length && ctx && (ctx.Id === ep.SeriesId || ctx.SeriesId === ep.SeriesId)) ep.Genres = ctx.Genres;
      const resume = ticksToSec((ep.UserData || {}).PlaybackPositionTicks);
      playItem(ep, resume > 30 ? Math.floor(resume) : 0);
      return true;
    })
    .catch((e) => {
      toast('Couldn’t start this episode: ' + errText(e));
      return false;
    });
}

/* ---------------- start playback ---------------- */
/** @param {string} id @param {number} [resumeSec] */
export function play(id, resumeSec) {
  const gen = ++playGen;
  /* Every open*() bumps S.epoch; the player itself never does. So a start from
   * a detail page whose PlaybackInfo is still in flight when the user backs out
   * (or opens another page) is dropped instead of launching the video over the
   * screen they went to. Retries/restarts inside the player are unaffected. */
  const epoch = S.epoch;
  const restart = S.screen === 'player';
  // Started from Home (the hero, or a Continue Watching / Next Up tile via
  // playFromHome()): Back out of the player returns there, on that tile or the
  // hero's primary button. Restarts
  // and Up Next roll-ons keep what the first start decided.
  if (!restart) homeReturn = S.base === 'home' ? homeReturnNext || 'hero-resume' : null;
  homeReturnNext = null;
  lastPlayId = id;
  lastPos = resumeSec || 0;
  const burn = needsBurnIn(P.source, P.subIndex);
  /** @type {Jf.PlaybackInfoDto} */
  const body = {
    UserId: cfg.userId,
    DeviceProfile: __PHONE__ ? deviceProfile(burn, phoneBitrate()) : deviceProfile(burn),
    AutoOpenLiveStream: true,
    MaxStreamingBitrate: __PHONE__ ? phoneBitrate() : 400000000
  };
  if (__PHONE__) {
    // A first start is (almost always) inside the tap that asked for it: load()
    // on the still-empty element there is what lets the play() after the
    // PlaybackInfo round trip make sound — iOS lifts a media element's
    // user-gesture restriction on its first load()/play() inside a gesture.
    if (!restart && video && !video.getAttribute('src')) {
      try {
        video.load();
      } catch {}
    }
    /* The HLS remux carries exactly one audio track, and Jellyfin only honours
     * AudioStreamIndex / SubtitleStreamIndex together with a MediaSourceId
     * (measured on 12.1). Subtitles other than VobSub/DVB are never part of the
     * stream (-1): text and PGS render client-side, as on the TV. */
    if (P.source && P.source.Id) body.MediaSourceId = P.source.Id;
    if (P.audioIndex >= 0) body.AudioStreamIndex = P.audioIndex;
    body.SubtitleStreamIndex = burn ? P.subIndex : -1;
    body.StartTimeTicks = Math.floor((resumeSec || 0) * TICKS);
  } else if (burn) {
    // Jellyfin only evaluates the burn against a specific source, so pass the id.
    if (P.source && P.source.Id) body.MediaSourceId = P.source.Id;
    body.SubtitleStreamIndex = P.subIndex;
    if (P.audioIndex >= 0) body.AudioStreamIndex = P.audioIndex;
  } else {
    body.StartTimeTicks = Math.floor((resumeSec || 0) * TICKS);
  }
  /** @type {Promise<Jf.PlaybackInfoResponse>} */ (api('/Items/' + id + '/PlaybackInfo', { method: 'POST', body }))   // UserId rides in the body (the query form is deprecated)
    .then((/** @type {Jf.PlaybackInfoResponse} */ info) => {
      if (gen !== playGen || epoch !== S.epoch) return;   // the player was closed / the page left meanwhile
      const src = (info.MediaSources || [])[0];
      if (!src || (__PHONE__ && !src.SupportsDirectPlay && !src.TranscodingUrl)) {
        failStart('No playable source', __PHONE__ ? 'Jellyfin offered no stream this iPhone can play for this title.' : 'Jellyfin found no file this TV can play for this title.');
        return;
      }
      /* A restart inside the player (Retry, burn-in audio/sub switch) opens a
       * new PlaySessionId. The old one was never stopped, so its HLS transcode
       * kept running on the NAS until Jellyfin's idle timeout. Close it out
       * once the new src is set below (same tick, so no error from the old
       * stream can reach the card). */
      const prev =
        restart && P.sessionId && P.sessionId !== stoppedSession && P.item && P.source
          ? { ItemId: P.item.Id, MediaSourceId: P.source.Id, PlaySessionId: P.sessionId }
          : null;
      P.item = P.detailItem || { Id: id };
      P.item.Id = id;
      P.source = src;
      P.sessionId = info.PlaySessionId || '';
      newestSession.set(id, P.sessionId);
      if (P.audioIndex === -1) P.audioIndex = startTracks(src, P.detailItem).audio;
      let url;
      /** @type {Jf.PlayMethod} */
      let method;
      if (__PHONE__) {
        /* A progressive MP4 Safari takes as is: the static file, like the TV.
         * Anything else (every MKV): Jellyfin's HLS fMP4 remux. PlayMethod
         * 'DirectStream' marks that remux — the engine keeps 'Transcode' for the
         * burn-in stream, whose restart/subtitle rules are the TV's. */
        if (src.SupportsDirectPlay && !burn) {
          url = directUrl(src);
          method = 'DirectPlay';
        } else {
          /* The media playlist, not master.m3u8: for an HDR/HEVC source Jellyfin's
           * master also lists an SDR and an H.264 re-encode at the same bandwidth,
           * Safari hops between the variants, and every hop restarts the one
           * server job — a 4K re-encode never catches up, so the start hung on
           * the loading card (measured 2026-09-29). main.m3u8 with the master's
           * own query is the first variant: the stream copy. */
          url = cfg.server + /** @type {NonNullable<typeof src.TranscodingUrl>} */ (src.TranscodingUrl).replace('/master.m3u8', '/main.m3u8');
          method = burn ? 'Transcode' : 'DirectStream';
          if (burn) toast('DVD subtitles need transcoding — burning them in…');
        }
      } else if (burn && src.TranscodingUrl) {
        url = cfg.server + src.TranscodingUrl;
        method = 'Transcode';
        toast('DVD subtitles need transcoding — burning them in…');
      } else {
        url = directUrl(src);
        method = 'DirectPlay';
      }
      P.playMethod = method;
      if (__PHONE__) P.quality = phoneQuality(src);
      startPlayback(url, method, resumeSec || 0);
      if (prev && prev.PlaySessionId !== P.sessionId) {
        stoppedSession = prev.PlaySessionId;
        api('/Sessions/Playing/Stopped', {
          method: 'POST',
          body: { ...prev, PositionTicks: Math.floor((resumeSec || 0) * TICKS) }
        }).catch(() => {});
      }
    })
    .catch((e) => {
      if (gen === playGen && epoch === S.epoch) failStart('Couldn’t start playback', errText(e));
    });
}

/* A start that fails before any video exists. From a detail page that is a
 * toast (nothing is on screen to put a card in); inside the player — a Retry,
 * a burn-in restart, an Up Next roll — it is the error card. */
/** @param {string} title @param {string} [detail] */
function failStart(title, detail) {
  if (S.screen === 'player') showPlayError(title, detail, lastPos);
  else toast(title + (detail ? ': ' + detail : ''));
}

/** @param {VR.PlayerSource} src @returns {string} */
function directUrl(src) {
  const container = src.Container || 'mkv';
  return (
    cfg.server +
    '/Videos/' +
    /** @type {NonNullable<typeof P.item>} */ (P.item).Id +
    '/stream.' +
    container +
    qs({
      static: 'true',
      mediaSourceId: src.Id,
      api_key: cfg.token,
      PlaySessionId: P.sessionId,
      deviceId: cfg.deviceId
    })
  );
}

/* Play a file that is still downloading, streamed by the media-library service
 * (Range requests against the growing file; the server waits at the download
 * frontier). `item` is a synthetic Jellyfin-shaped item for the OSD/info
 * overlay; `source` is a synthetic MediaSource built from the server's ffprobe
 * of the partial file (see pendingplay.js), which is what makes the audio menu
 * and tech summary work exactly as for a library item. In-container subtitles
 * can't be extracted without Jellyfin, so subs stay off. */
/** @param {VR.PendingStreamArgs} args */
export function playPendingStream({ url, item, source, downloadId }) {
  P.pending = true;
  P.downloadId = downloadId || null;
  P.detailItem = item;
  P.item = { Id: null, Name: item.Name };
  P.source = source;
  P.sessionId = '';
  P.audioIndex = describeTracks(source, item).defaultAudio;
  P.subIndex = -1;
  P.subOffset = 0;
  P.playMethod = 'DirectPlay';
  startPlayback(url, 'DirectPlay', 0);
}

/* ---------------- phone: MediaSource-fed streams ----------------
 * iPhone only. A pending download (livefeed.js: reel-api remuxes the growing
 * file to fMP4 segments) or an offline copy (offline.js: segments in Cache
 * Storage), appended to a (Managed)MediaSource by segfeed.js. Runs as a
 * pending stream (P.pending gates off every Jellyfin call). `open({ audioIndex,
 * position, jump, onFail })` makes a fresh feeder — Retry and an audio switch
 * need a new MediaSource. `exit(pos, dur, started)`, when given, is told where
 * playback ended and the player just closes over the page it was started from
 * (the offline list); without it exit is the pending stream's. `started` is
 * false when no frame ever played (closed on the loading card): `pos` is then
 * only the start position handed in, not something the user watched to.
 * `checkpoint(pos, dur)` is told the position on every pause and when the app
 * goes to the background (checkpointFeed) — iOS kills a suspended home-screen
 * app without a pagehide, so exit alone would lose it. */
/** @type {VR.FeedRun | null} */
let feedRun = null;   // { open, exit, checkpoint, feeder, started }

/** @param {VR.FeedStreamOptions} options */
export function playFeedStream({ item, source, downloadId, open, exit, checkpoint, start = 0, audioIndex, subIndex = -1 }) {
  if (!__PHONE__) return;
  if (feedRun && feedRun.feeder) feedRun.feeder.stop();
  feedRun = { open, exit, checkpoint, feeder: null, started: false };
  P.pending = true;
  P.downloadId = downloadId || null;
  P.detailItem = item;
  P.item = { Id: null, Name: item.Name };
  P.source = source;
  P.sessionId = '';
  P.audioIndex = audioIndex ?? describeTracks(source, item).defaultAudio;
  P.subIndex = subIndex;
  P.subOffset = 0;
  P.playMethod = 'DirectPlay';
  startFeed(start);
}

/** @param {number} pos */
function startFeed(pos) {
  const run = feedRun;
  if (/** @type {NonNullable<typeof run>} */ (run).feeder) /** @type {NonNullable<typeof run>} */ (run).feeder.stop();
  const f = /** @type {NonNullable<typeof run>} */ (run).open({
    audioIndex: P.audioIndex,
    position: effectivePos,
    jump: (t) => seekTo(t, true),
    onFail: (e) => {
      if (feedRun !== run || /** @type {NonNullable<typeof run>} */ (run).feeder !== f || S.screen !== 'player') return;
      showPlayError(
        e && e.code === 'unsupported' ? 'This iPhone can’t play this file' : P.downloadId ? 'The download stream broke off' : 'This download can’t be played',
        (e && e.message) || '',
        lastPos
      );
    }
  });
  /** @type {NonNullable<typeof run>} */ (run).feeder = f;
  startPlayback(f.url, 'Feed', pos);
}

/* Phone: hand an offline copy's position to its checkpoint hook — from onpause
 * and from lifecycle.js when the app goes to the background. Only once a frame
 * has played: before that the position is just where the start was asked for. */
export function checkpointFeed() {
  if (!__PHONE__ || !feedRun || !feedRun.started || !feedRun.checkpoint || S.screen !== 'player') return;
  feedRun.checkpoint(restartPos(), seekDur());
}

/* ---------------- trailers ----------------
 * A YouTube trailer in our own player: reel-api fetches it with yt-dlp and
 * remuxes it to fMP4 segments, trailerstream.js appends them to a MediaSource
 * once a few seconds are preloaded. It runs as a pending-style stream (P.pending
 * gates off everything Jellyfin: reports, markers, trickplay, subtitles) plus
 * P.trailer for what differs: the source is a blob URL, a failure falls back to
 * the YouTube app, and exit just lowers the player over the page it was started
 * from — nothing about that page changed, so it isn't remounted — with focus
 * back on the Trailer button. */
/** @type {VR.TrailerSource | null} */
let trailerSrc = null;
/** @type {VR.TrailerRun | null} */
let trailerRun = null;   // { id, item, onFail, back, saved } of the trailer playing

/** @param {VR.TrailerStreamArgs} args */
export function playTrailerStream({ id, title, art, onFail }) {
  const a = /** @type {HTMLElement | null} */ (document.activeElement);
  trailerRun = {
    id,
    onFail,
    back: (a && a.dataset && a.dataset.focus) || null,
    // the detail page seeded these for its tech grid and Play button
    saved: {
      detailItem: P.detailItem, item: P.item, source: P.source, series: P.series,
      audioIndex: P.audioIndex, subIndex: P.subIndex, subOffset: P.subOffset,
      sessionId: P.sessionId, playMethod: P.playMethod
    }
  };
  P.pending = true;
  P.trailer = true;
  P.downloadId = null;
  P.detailItem = { Id: null, Name: title || 'Trailer', _art: art || null, _sub: 'Trailer' };
  P.item = { Id: null, Name: title || 'Trailer' };
  P.source = null;
  P.sessionId = '';
  P.audioIndex = -1;
  P.subIndex = -1;
  P.subOffset = 0;
  P.playMethod = 'DirectPlay';
  startTrailer(0);
}

/** @param {number} pos */
function startTrailer(pos) {
  if (trailerSrc) trailerSrc.stop();
  const run = trailerRun;
  const src = createTrailerSource(/** @type {NonNullable<typeof run>} */ (run).id, {
    position: effectivePos,
    jump: (t) => seekTo(t, true),
    onInfo: (st) => {
      if (trailerRun !== run) return;
      // what the OSD's tech line ("4K HDR10 · Opus") and seekDur() read
      const [vc = '', ac = ''] = String(st.codecs || '').split(',');
      const acodec = /^ec-3/.test(ac) ? 'eac3' : /^ac-3/.test(ac) ? 'ac3' : /^mp4a/.test(ac) ? 'aac' : ac;
      P.source = {
        Id: 'trailer',
        RunTimeTicks: Math.round((st.duration || 0) * TICKS),
        MediaStreams: [
          { Type: 'Video', Index: 0, Codec: vc.split('.')[0], Width: st.width, Height: st.height, VideoRangeType: st.hdr || 'SDR' },
          { Type: 'Audio', Index: 1, Codec: acodec, IsDefault: true }
        ]
      };
      P.audioIndex = 1;
    },
    // English subtitles, on by default (the Subtitles button turns them off)
    onSubs: (vtt, subs) => {
      if (trailerRun !== run || !P.source) return;
      P.source = {
        ...P.source,
        MediaStreams: [
          .../** @type {NonNullable<typeof P.source.MediaStreams>} */ (P.source.MediaStreams).filter((m) => m.Type !== 'Subtitle'),
          {
            Type: 'Subtitle', Index: 2, Codec: 'webvtt', Language: 'eng', _vtt: vtt,
            Title: subs.kind === 'auto' ? 'Auto-generated' : subs.kind === 'translated' ? 'Auto-translated' : ''
          }
        ]
      };
      if (/** @type {NonNullable<typeof run>} */ (run).subsOff) return;   // switched off on an earlier start of this trailer (Retry)
      P.subIndex = 2;
      attachSubtitles(P.source);
    },
    onFail: (e) => {
      if (trailerRun !== run || !P.trailer) return;
      const f = /** @type {NonNullable<typeof run>} */ (run).onFail;
      exitPlayer();
      if (f) f(e);
    }
  });
  trailerSrc = src;
  startPlayback(src.url, 'Trailer', pos);
}

/* The trailer ended, failed or was left: stop feeding, put back what the page
 * had seeded, and lower the player onto the page, on the button. */
function endTrailer() {
  if (trailerSrc) trailerSrc.stop();
  trailerSrc = null;
  const run = trailerRun;
  trailerRun = null;
  P.trailer = false;
  P.pending = false;
  if (run) Object.assign(P, run.saved);
  S.screen = S.base;
  if (run && run.back) focusKey(run.back);
}

/** @param {string} url @param {VR.StartMethod} method @param {number} resumeSec seconds */
function startPlayback(url, method, resumeSec) {
  const sg = ++startGen;
  S.screen = 'player';
  P.spinner = true;
  P.loading = true;
  P.loadingItem = null;
  P.loadingFrom = resumeSec || 0;
  P.error = null;
  P.osdShown = false;
  P.upNextOff = false;
  upNextFrom = null;
  lastUrl = url;
  lastPos = resumeSec || 0;
  cancelScrub();
  if (P.pending) {
    P.skips = [];
    P.credits = null;
    P.next = null;
    P.trick = null;
    P.chapters = [];
  } else {
    // One request for the trickplay layout and the chapters; the marker lookup
    // reads its chapters too, when segments leave a kind unanswered.
    const extra = /** @type {Promise<Jf.QueryResult>} */ (api('/Items' + qs({ Ids: /** @type {NonNullable<typeof P.item>} */ (P.item).Id, UserId: cfg.userId, Fields: 'Trickplay,Chapters', Limit: 1 })))
      .then((r) => ((r && r.Items) || [])[0] || {});
    lookUpMarkers(/** @type {Jf.BaseItemDto} a Jellyfin item here, never a stub */ (P.item).Id, P.detailItem, extra);
    lookUpTrickplay(/** @type {Jf.BaseItemDto} a Jellyfin item here, never a stub */ (P.item).Id, P.source && P.source.Id, extra);
  }
  if (!video) return;
  // Nothing in the app mutes on purpose, and the element lives for the whole
  // session: a mute left behind (a DevTools test, 2026-09-28) silenced every
  // later film and trailer until a restart.
  video.muted = false;
  // A ManagedMediaSource (iOS trailers) refuses to attach unless remote
  // playback is off; every other stream keeps AirPlay.
  if (__PHONE__) video.disableRemotePlayback = !!((method === 'Trailer' && trailerSrc && trailerSrc.managed) || (method === 'Feed' && feedRun && feedRun.feeder && feedRun.feeder.managed));
  if (!__PHONE__) cancelRefreshReset();   // TV-only (refresh60.js)
  video.src = url;
  video.load();
  // iPhone: WebKit in Low Power Mode may not load metadata at all until
  // play() is called, so every start would hang under the loading card until
  // the 60 s "never started" card. Kick it here; the play() on loadedmetadata
  // below (and its refusal handling) stays the one that counts. The loading
  // card still waits for 'playing', so an early play() is not "started".
  if (__PHONE__) video.play().catch(() => {});
  // Transcoded (burn-in) streams already have subtitles baked in; the HLS
  // playlist spans the whole runtime so we still seek client-side.
  if (method === 'Transcode' || method === 'Trailer') clearSubs();
  else attachSubtitles(P.source);
  let resumed = false;
  video.addEventListener(
    'loadedmetadata',
    () => {
      if (sg !== startGen) return;
      P.spinner = false;
      if (!resumed && resumeSec > 1) {
        try {
          /** @type {NonNullable<typeof video>} */ (video).currentTime = resumeSec;
        } catch {}
        resumed = true;
      }
      if (method === 'DirectPlay') applyAudioSelection();
      // A refused play() never reaches 'playing': drop the loading card so the
      // paused first frame (and the OSD's Play) is what the user sees.
      /** @type {NonNullable<typeof video>} */ (video).play().catch(() => {
        if (sg === startGen && /** @type {NonNullable<typeof video>} */ (video).paused) {
          P.loading = false;
          showOsd();
          focusKey('c-play');
        }
      });
    },
    { once: true }
  );
  video.addEventListener(
    'playing',
    () => {
      if (sg !== startGen) return;
      P.spinner = false;
      P.loading = false;   // the first frame is up: fade the backdrop card out
      if (__PHONE__ && method === 'Feed' && feedRun) feedRun.started = true;
      reportStart();
      showOsd();
      // A recap/intro starting at 0:00 means the Skip chip has already claimed
      // focus by now (it wins whenever its lookup beat the first frame) — taking
      // it back here would leave OK on play/pause with the chip sitting focusless.
      if (!skipVisible()) focusKey('c-play');
    },
    { once: true }
  );
  bindVideoEvents();
}

/** @param {number} pos */
export function restartPlayback(pos) {
  clearSubs();
  play(/** @type {Jf.BaseItemDto} a Jellyfin item here, never a stub */ (P.item).Id, Math.floor(pos || 0));
}

/* ---------------- playback error card ----------------
 * Replaces the old 3.5 s toast over a black screen: the card says what failed
 * in plain words (plus container/codecs when known) and offers Retry — the
 * same start again, at the last good position — or Back to the detail page. */
/** MediaError.code → [title, detail]. @type {Record<number, [string, string]>} */
const MEDIA_ERR = __PHONE__
  ? {
      1: ['Playback was interrupted', 'The stream was aborted before it finished loading.'],
      2: ['Lost the connection to the server', 'The iPhone stopped receiving the video over the network.'],
      3: ['The iPhone couldn’t decode this video', 'The stream started, but its video or audio broke the iPhone’s decoder.'],
      4: ['The iPhone can’t play this stream', 'Its format isn’t supported by Safari — the server’s remux may have failed.']
    }
  : {
      1: ['Playback was interrupted', 'The stream was aborted before it finished loading.'],
      2: ['Lost the connection to the server', 'The TV stopped receiving the video over the network.'],
      3: ['The TV couldn’t decode this video', 'The file started, but its video or audio broke the TV’s decoder.'],
      4: ['The TV can’t play this file', 'Its container or codec isn’t supported for direct play on this TV.']
    };

function techLine() {
  const s = P.source;
  if (!s) return '';
  const v = videoStream(s);
  const a = streamByIndex(s, P.audioIndex);
  return [
    s.Container && s.Container.toUpperCase(),
    v && [v.Codec && v.Codec.toUpperCase(), resShort(v.Width, v.Height), hdrLabel(v)].filter(Boolean).join(' '),
    a && (audioBadge(a) || (a.Codec || '').toUpperCase())
  ]
    .filter(Boolean)
    .join(' · ');
}

/** @param {string} title @param {string} [detail] @param {number} [pos] seconds; default the last good position */
export function showPlayError(title, detail, pos) {
  clearInterval(reportTimer);
  clearInterval(stallTimer);   // Retry's startPlayback() arms a fresh one
  P.spinner = false;
  P.loading = false;
  P.loadingItem = null;
  P.panel = null;
  P.osdShown = false;
  cancelScrub();
  lastPos = pos || lastPos;
  P.error = { title, detail: detail || '', tech: techLine() };
  focusKey('err-retry');
}

export function retryPlayback() {
  const pos = Math.floor(lastPos || 0);
  P.error = null;
  P.loading = true;   // the backdrop card covers the PlaybackInfo round trip too
  P.loadingFrom = pos;
  if (P.trailer && trailerRun) {
    startTrailer(pos);   // a fresh MediaSource: the old blob URL is spent
    return;
  }
  if (__PHONE__ && P.pending && feedRun) {
    startFeed(pos);   // likewise a fresh MediaSource
    return;
  }
  if (P.pending) {
    if (lastUrl) startPlayback(lastUrl, 'DirectPlay', pos);
    return;
  }
  clearSubs();
  const id = lastPlayId || (P.item && P.item.Id);
  if (id) play(id, pos);
}

function bindVideoEvents() {
  if (!video) return;
  video.onwaiting = () => {
    P.spinner = true;
  };
  video.onplaying = () => {
    P.spinner = false;
    P.paused = false;
    wdKick = Date.now();   // the watchdog's still-clock restarts here
  };
  let hiddenMirrorAt = 0;
  video.ontimeupdate = () => {
    const t = effectivePos();
    if (t > 0 && seekTarget == null) lastPos = t;   // where Retry resumes after an error
    // Settings → skip intros / recaps automatically: once per kind per item, so
    // seeking back into one on purpose shows the chip instead of being thrown
    // out again. Previews go with recaps — both are "the show telling you about
    // itself". Pending streams have no segments, so this never fires there.
    const seg = !P.panel && segmentAt(t);
    if (seg && !autoSkipped.has(seg.kind) && t < seg.end - 1 &&
        (seg.kind === 'intro' ? SET.autoSkipIntro : SET.autoSkipRecap)) {
      autoSkipped.add(seg.kind);
      skipTo(seg);
      toast('Skipped ' + seg.kind);
      return;
    }
    // The Skip chip is the one control that lives outside the OSD, so it needs
    // a live position even while the OSD is down. Mirror at full rate from a few
    // seconds *before* a window until just after it: the lead-in is what makes
    // the chip land on time, since inside the heartbeat below we only get to
    // re-evaluate every 2 s and would otherwise show up that late.
    const nearIntro = P.skips.some((s) => t >= s.start - 5 && t <= s.end + 2);
    // The Up Next card is the same kind of control, and its countdown needs the
    // live position to tick.
    const un = upNextWindow();
    const nearNext = !!un && t >= un.at - 5;
    // The roll-on is Items/{next} → PlaybackInfo, serial (~85 ms for the item on
    // the TV): fetch the item as the card is about to show, so playEpisode()
    // picks it up parked (prefetch() dedupes, so this runs once per window).
    if (nearNext && /** @type {NonNullable<typeof P.next>} */ (P.next).Id !== warmedNext) {
      warmedNext = /** @type {NonNullable<typeof P.next>} */ (P.next).Id;
      prefetch(itemPath(/** @type {NonNullable<typeof P.next>} */ (P.next).Id)).catch(() => {});
    }
    // Out of the window again (seeked back, or a rewatch of this episode):
    // re-arm, so the next approach warms again — prefetch() dedupes within its
    // 30 s TTL, and a warm older than that can no longer be served anyway.
    else if (!nearNext) warmedNext = null;
    if (un) {
      // Seeking back out of the credits re-arms a dismissed card.
      if (P.upNextOff && t < un.at - 1) P.upNextOff = false;
      // Landing inside the credits (a resume point there, or a seek into them)
      // gives the card its full countdown from that point instead of rolling on
      // at once — the user chose to be here. Crossing in by playing is unchanged.
      if (t < un.at - 1) upNextFrom = null;
      else if (P.credits && t >= un.at && (upNextFrom == null || (seekTarget == null && t < upNextFrom))) {
        // Also lowered when the TV decodes from a keyframe *before* the
        // requested resume/seek point (the countdown used to open at "in 12"/
        // "in 15"). Only once the post-seek window is over — currentTime reads
        // garbage until then — and a garbage read below the credits already
        // falls into the reset above.
        upNextFrom = t;
        un.go = /** @type {NonNullable<ReturnType<typeof upNextWindow>>} inside the window */ (upNextWindow()).go;
      }
      // The countdown ran out: roll on. (Without credits data `go` is the end of
      // the file, and onended below does this instead.) Settings can turn the
      // roll off: the card then just waits for OK or Back.
      if (SET.autoplayNext && !P.upNextOff && !P.panel && t >= un.go && un.go < P.dur - 0.5) {
        playNext();
        return;
      }
    }
    // The OSD is otherwise the only reader of P.pos/P.dur — while it's hidden,
    // drop the ~5 Hz text/scrubber updates (style recalc + layout for invisible
    // UI) to a 2 s heartbeat. The heartbeat (rather than a hard cutoff) is a
    // fail-safe: even if some path desynced P.osdShown from the visible OSD, the
    // scrubber could stall for at most 2 s. showOsd() still seeds fresh values
    // on wake, and progress reporting reads video.currentTime directly.
    if (!P.osdShown && !nearIntro && !nearNext) {
      const now = Date.now();
      if (now - hiddenMirrorAt < 2000) return;
      hiddenMirrorAt = now;
    }
    P.pos = t;
    P.dur = seekDur();
  };
  video.onpause = () => {
    P.paused = true;
    reportProgress(true);
    if (__PHONE__) checkpointFeed();   // an offline copy reports nothing: save its spot here
  };
  video.onplay = () => {
    P.paused = false;
  };
  video.onended = () => {
    // A dismissed card means "let me watch the credits", not "stop the binge
    // for good" — but at the very end there is nothing left to watch, and
    // landing back on the series page is the honest answer to having said no.
    // With autoplay off the card stays up on the last frame until OK (play it)
    // or Back (dismissUpNext, which then exits since nothing is left).
    // A pending stream "ends" wherever the server gave up on it — reel-api
    // closes it after ~2 min without download progress, or the grab was removed
    // — which used to drop the user back on the pending page mid-film with no
    // word why. Well short of the probed runtime, that is an error with Retry.
    if (P.pending && !P.trailer) {
      const full = Math.max(ticksToSec(P.source && P.source.RunTimeTicks), seekDur());
      const at = Math.max(lastPos, effectivePos());
      if (full > 120 && at < full - 60) {
        showPlayError(
          'The download stopped here',
          'The stream ended at ' + fmtTime(at) + ' of ' + fmtTime(full) +
            ' — the download stalled or was removed. Retry picks up from here once more has arrived.',
          at
        );
        return;
      }
    }
    if (P.next && !P.upNextOff) {
      if (SET.autoplayNext) playNext();
      else {
        P.pos = seekDur();
        P.dur = seekDur();
      }
    } else exitPlayer();
  };
  video.onerror = () => {
    // exitPlayer() empties the element; that is not a failure worth a card.
    if (S.screen !== 'player' || !/** @type {NonNullable<typeof video>} */ (video).getAttribute('src')) return;
    const code = /** @type {NonNullable<typeof video>} */ (video).error ? /** @type {NonNullable<typeof video>} */ (video).error.code : 0;
    let [title, detail] = MEDIA_ERR[code] || ['Playback failed', __PHONE__ ? 'The iPhone’s media pipeline reported an error.' : 'The TV’s media pipeline reported an error.'];
    // A pending stream failing is almost always the download side (stalled,
    // removed, or imported and gone from the client), not the TV — "can't play
    // this file" would send the user looking in the wrong place.
    if (P.trailer) [title, detail] = ['The trailer stopped', 'The media library stopped serving it.'];
    else if (P.pending && code !== 3)
      [title, detail] = ['The download stream broke off', 'The media library stopped serving this file — the download may have stalled, been removed, or finished importing (then play it from the library).'];
    const msg = /** @type {NonNullable<typeof video>} */ (video).error && /** @type {NonNullable<typeof video>} */ (video).error.message;
    showPlayError(title, detail + (msg ? ' (' + msg + ')' : ''), lastPos);
  };
  clearInterval(reportTimer);
  reportTimer = setInterval(() => reportProgress(/** @type {NonNullable<typeof video>} */ (video).paused), 10000);
  startStallWatch();
}

/* ---------------- stall watchdog ----------------
 * This TV's pipeline does not reliably fire 'waiting'/'stalled': with the NAS
 * cut off mid-video (iptables DROP, measured round 3) the picture froze and
 * currentTime stopped, but no event came, so no ring either. So poll the
 * playhead instead: playing (not paused/ended), past the loading card, and
 * currentTime unchanged for STALL_SPIN_MS → show the ring (VideoLayer adds
 * "Buffering…" 3 s later). Movement clears it again, even if 'playing' never
 * arrives. A stall past STALL_FAIL_MS becomes the error card with Retry from the
 * last good position (a dead connection rarely recovers by itself here) —
 * except for pending streams, which legitimately wait at the download frontier
 * (reel-api ends those after ~2 min, and onended above reports that).
 * The seek window (seekTarget set, currentTime unreliable) resets the clock. */
const STALL_SPIN_MS = 2000;
const STALL_FAIL_MS = 30000;
const START_FAIL_MS = 60000;   // loading card up this long with no first frame
/** @type {ReturnType<typeof setInterval> | null} */
let stallTimer = null;
let wdSpinner = false;         // the ring is up because of the watchdog, not 'waiting'
// Last 'playing' event. After a seek this TV fires 'playing' ~0.5 s before
// currentTime starts moving (it reads the seek target until then), so without
// this the watchdog re-raised the ring 250–500 ms after 'playing' cleared it.
let wdKick = 0;

/* End of the buffered range holding t (the download head in media time), or -1.
 * Also a range ending up to 30 s *behind* t: while this TV refills after a start
 * or resume, buffered reads e.g. 0–656 → 0–659 with currentTime already at 659
 * (measured round 13, 4K on 2.4 GHz: 23–28 s like that), and that growth is
 * download progress too — without it the fill counted as a dead link. It is
 * *not* a rate sample, though (the preroll before the range start is invisible,
 * so it read 3–7 Mbit/s on a ~11 Mbit/s link): bufHeld says which case it was. */
let bufHeld = false;
/** @param {number} t @returns {number} */
function bufferedEnd(t) {
  let best = -1;
  bufHeld = false;
  try {
    const b = /** @type {NonNullable<typeof video>} */ (video).buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) > t + 0.5) continue;
      if (b.end(i) >= t - 0.5) {
        bufHeld = true;
        return b.end(i);
      }
      if (b.end(i) >= t - 30 && b.end(i) > best) best = b.end(i);
    }
  } catch {}
  return best;
}

/* Slow-link estimate. While the ring is up the pipeline is fetching as fast as
 * the link allows, so media seconds buffered per wall second × the file's
 * bitrate ≈ the throughput the TV actually gets (the media element's fetches
 * aren't in Resource Timing). Round 12: 2.4 GHz Wi-Fi gave the TV ~13 Mbit/s
 * against a 36 Mbit/s 4K remux — it buffered forever with no word why. */
const SLOW_MIN_WALL_MS = 8000;   // stalled time measured before judging
const SLOW_RATIO = 0.85;         // got < 85 % of the file's bitrate → hint

function startStallWatch() {
  clearInterval(stallTimer);
  wdSpinner = false;
  P.slowNet = null;
  const sg = startGen;
  let lastBuf = -1;      // bufferedEnd() at the previous tick
  let lastHeld = false;  // …and whether that range held the playhead
  let bufMovedAt = Date.now();
  let slowWall = 0;      // ms spent stalled with a measurable buffer
  let slowBuf = 0;       // media seconds buffered during that time
  /* Stalled ms since the buffered end last grew. A gap between deliveries is
   * part of the link's rate, but only data arriving again proves it was a gap:
   * it joins slowWall then. A link that died never adds it, so the reading
   * stays the last live one — the card's "was only getting about N, and then
   * nothing" quotes what the hint said, not an average diluted by the dead
   * seconds it then counts separately. */
  let slowGap = 0;
  /* Measured from when *this* loading card went up, not from arming: an Up Next
   * roll raises P.loading on the old watch (no new startPlayback until the next
   * episode's PlaybackInfo answers), and an episode-long startedAt fired "never
   * started" in that round trip — a card flashing up between episodes. */
  let loadSince = Date.now();
  let lastT = -1;
  let movedAt = Date.now();
  stallTimer = setInterval(() => {
    if (!video || sg !== startGen || S.screen !== 'player' || P.error) {
      movedAt = Date.now();
      return;
    }
    const now = Date.now();
    if (P.loading) {
      // No first frame for a minute: the start hung (server unreachable after
      // PlaybackInfo, or the file stream never answers). Pending streams can wait.
      if (!loadSince) loadSince = now;
      if (!P.pending && !advancing && now - loadSince > START_FAIL_MS)
        stallFail('The video never started', __PHONE__
          ? 'The server stopped answering before the first frame arrived. Check that the iPhone can reach it (Wi-Fi or Tailscale), then Retry.'
          : 'The server stopped answering before the first frame arrived. Check that the TV can reach it, then Retry.');
      movedAt = now;
      return;
    }
    loadSince = 0;
    const t = video.currentTime;
    if (seekTarget != null || video.paused || video.ended || document.hidden) {
      lastT = t;
      movedAt = now;
      bufMovedAt = now;
      lastBuf = -1;   // a seek lands in another range; don't count the jump as download
      slowGap = 0;
      if (wdSpinner && video.paused) {
        wdSpinner = false;
        P.spinner = false;
      }
      return;
    }
    // Download progress, independent of the playhead: a slow link still moves
    // the buffered end while the picture waits.
    const be = bufferedEnd(t);
    const held = bufHeld && lastHeld;
    const dBuf = lastBuf >= 0 && be >= 0 ? be - lastBuf : 0;
    if (dBuf > 0.05) bufMovedAt = now;
    // Not for pending streams: at the download frontier the limit is the
    // torrent, not the TV's link, and "Waiting for download" already says so.
    // Not for the burn-in transcode either: its segments arrive at the NAS
    // encoder's pace (and its bitrate isn't the source's Bitrate). And only
    // while the buffer ahead is thin — a ring with 20+ s already buffered is a
    // decoder/pipeline hiccup (audio switch, resume) whose zero growth would
    // drag the average under 85 % on a perfectly good link.
    if (P.spinner && !P.pending && P.playMethod !== 'Transcode' && held && lastBuf >= 0 && be >= 0 && dBuf < 5 && be - t < 20) {
      // < 5 s per 500 ms tick: a bigger jump is a new range, not throughput.
      const grew = dBuf > 0;
      if (grew) {
        slowWall += slowGap + 500;
        slowBuf += dBuf;
        slowGap = 0;
      } else slowGap += 500;   // frozen sample: see slowGap
      const bps = __PHONE__ ? phoneStreamBps() : P.source && P.source.Bitrate;
      if (grew && /** @type {NonNullable<typeof bps>} */ (bps) > 0 && slowWall >= SLOW_MIN_WALL_MS) {
        const ratio = slowBuf / (slowWall / 1000);
        // Only with *some* data arriving: a dead link is the stall card's job,
        // and "you're getting 0 Mbit/s" would be a guess about buffered, not a measurement.
        if (ratio > 0.02 && ratio < SLOW_RATIO) {
          const need = Math.round(/** @type {NonNullable<typeof bps>} */ (bps) / 1e6);
          const got = Math.max(1, Math.round((/** @type {NonNullable<typeof bps>} */ (bps) * ratio) / 1e6));
          if (!P.slowNet || P.slowNet.got !== got || P.slowNet.need !== need) {
            P.slowNet = { need, got };
            P.link = { got, at: now };
          } else if (P.link && now - P.link.at > 60000) P.link = { got, at: now };   // steady reading: keep TechGrid's 30-min clock from the latest measurement
        } else if (ratio >= SLOW_RATIO) {
          if (P.slowNet) P.slowNet = null;
          // The link now carries more than it measured before (e.g. moved to 5 GHz): forget it.
          if (P.link && (/** @type {NonNullable<typeof bps>} */ (bps) * ratio) / 1e6 > P.link.got) P.link = null;
        }
      }
    }
    if (be >= 0 || lastBuf < 0) {
      lastBuf = be;
      lastHeld = bufHeld;
    }
    if (t !== lastT) {
      lastT = t;
      movedAt = now;
      slowGap = 0;   // the stall is over: its tail was the pipeline restarting, not the link
      if (P.spinner) P.spinner = false;   // moving again, whether or not 'playing' fired
      wdSpinner = false;
      return;
    }
    if (wdKick > movedAt) movedAt = wdKick;
    const still = now - movedAt;
    if (still >= STALL_SPIN_MS && !P.spinner) {
      P.spinner = true;
      wdSpinner = true;
    }
    // A slow link that is still delivering (buffered end advancing) is not a
    // dead one: keep the ring (and the slow-link hint) instead of the card. The
    // card needs 30 s with neither the playhead nor the download moving.
    if (still >= STALL_FAIL_MS && !P.pending && now - bufMovedAt >= STALL_FAIL_MS) {
      const sn = P.slowNet;
      // "nothing for N s": how long the playhead *and* the download have both
      // stood still — not the playhead's still time alone (a trickle may have
      // arrived during it), nor the download's (a full buffer stops fetching)
      const dead = Math.round((now - Math.max(movedAt, bufMovedAt)) / 1000);
      stallFail(
        'Playback stalled',
        __PHONE__
          ? sn
            ? 'This stream needs about ' + sn.need + ' Mbit/s but the iPhone was only getting about ' + sn.got + ' Mbit/s, and then nothing for ' + dead + ' s. Check the connection or lower the streaming quality, then Retry from ' + fmtTime(lastPos) + '.'
            : 'No video has arrived from the server for ' + dead + ' s. Check the iPhone’s connection, then Retry from ' + fmtTime(lastPos) + '.'
          : sn
          ? 'This file needs about ' + sn.need + ' Mbit/s but the TV was only getting about ' + sn.got + ' Mbit/s, and then nothing for ' + dead + ' s. Check the TV’s connection — 5 GHz Wi-Fi or Ethernet — then Retry from ' + fmtTime(lastPos) + '.'
          : 'No video has arrived from the server for ' + dead + ' s. Check the TV’s connection, then Retry from ' + fmtTime(lastPos) + '.'
      );
    }
  }, 500);
}

/** @param {string} title @param {string} detail */
function stallFail(title, detail) {
  clearInterval(stallTimer);
  wdSpinner = false;
  // Keep a late-recovering pipeline from playing on under the card.
  if (video) {
    try {
      video.pause();
    } catch {}
  }
  showPlayError(title, detail, lastPos);
}

export function applyAudioSelection() {
  try {
    const tl = /** @type {NonNullable<typeof video>} */ (video).audioTracks;
    if (!tl || !tl.length) return;
    const order = describeTracks(P.source).audio.slice().sort((a, b) => a.index - b.index);
    const want = order.findIndex((a) => a.index === P.audioIndex);
    if (want < 0) return;
    for (let j = 0; j < tl.length; j++) tl[j].enabled = j === want;
  } catch {}
}

/* ---------------- progress reporting ---------------- */
/** @returns {Jf.PlaybackProgressInfo} */
function baseReport() {
  return {
    ItemId: /** @type {Jf.BaseItemDto} a Jellyfin item here, never a stub */ (P.item).Id,
    MediaSourceId: /** @type {NonNullable<typeof P.source>} */ (P.source).Id,
    PlaySessionId: P.sessionId,
    PositionTicks: Math.floor(/** @type {NonNullable<typeof video>} */ (video).currentTime * TICKS),
    IsPaused: /** @type {NonNullable<typeof video>} */ (video).paused,
    PlayMethod: P.playMethod || 'DirectPlay',
    CanSeek: true,
    VolumeLevel: 100,
    AudioStreamIndex: P.audioIndex,
    SubtitleStreamIndex: P.subIndex
  };
}

function reportStart() {
  if (P.pending) return;
  api('/Sessions/Playing', { method: 'POST', body: baseReport() }).catch(() => {});
}

/** @param {boolean} paused */
export function reportProgress(paused) {
  if (!P.item || P.pending) return;
  const b = baseReport();
  b.IsPaused = paused;
  api('/Sessions/Playing/Progress', { method: 'POST', body: b }).catch(() => {});
}

/* The Stopped report is the one that saves the resume point and the watched
 * flag (Progress only moves the position; a Stopped at the end is what marks an
 * episode played, which Next Up depends on). It goes out right as the Wi-Fi may
 * be blipping — an exit after a "Playback stalled" card is exactly that — and a
 * lost one leaves the resume point up to 10 s behind, an Up Next roll's episode
 * unwatched, and a ghost "now playing" session on the server. So a network
 * failure or a 5xx is retried a few times, spaced out. 4xx is final. A retry is
 * dropped if the same item has meanwhile started playing again (a late Stopped
 * would rewind the new session's resume point). Returns the first attempt.
 * keepalive: the parked-app path (suspendPlayback) sends this as the webview is
 * being frozen, and the request must outlive that; a retry timer then simply
 * fires once the app is resumed. */
const STOP_RETRY_MS = [3000, 10000, 30000];
/** @param {Jf.PlaybackStopInfo} body @param {number} [attempt] @returns {Promise<unknown>} */
function postStopped(body, attempt = 0) {
  const p = api('/Sessions/Playing/Stopped', { method: 'POST', keepalive: true, body });
  p.catch((e) => {
    if (e?.status >= 400 && e.status < 500) return;
    const wait = STOP_RETRY_MS[attempt];
    if (wait == null) return;
    setTimeout(() => {
      // Not only while that newer session is still on screen: replayed and
      // exited again inside the retry window, the late Stopped would otherwise
      // rewind the resume point the newer session just saved.
      if (newestSession.get(body.ItemId) !== body.PlaySessionId) return;
      postStopped(body, attempt + 1).catch(() => {});
    }, wait);
  });
  return p;
}

/* `finished`: report the position as the end of the file. Up Next rolls on
 * from the start of the credits, which for a short episode can sit below the
 * server's 90% "played" threshold — the user moved on to the next episode, so
 * this one is watched. */
/** @param {boolean} [finished] */
function reportStop(finished) {
  clearInterval(reportTimer);
  if (!P.item || P.pending) return;
  // Once per session: after an Up Next roll whose next episode then failed to
  // start, exiting must not re-stop the old one at its credits position.
  if (P.sessionId && P.sessionId === stoppedSession) return;
  stoppedSession = P.sessionId;
  const b = baseReport();
  const end = seekDur();
  // holdReads: the screen exitPlayer() opens next re-reads this item's
  // UserData; it must not be answered before the new resume point is saved.
  holdReads(postStopped({
    ItemId: b.ItemId,
    MediaSourceId: b.MediaSourceId,
    PlaySessionId: b.PlaySessionId,
    PositionTicks: finished && end ? Math.floor(end * TICKS) : b.PositionTicks
  })).catch(() => {});
  /* We just moved the resume position (and possibly the watched flag) of an
   * item Home paints from the SWR cache — Resume, Next Up and Latest (see
   * invalidatePlayState in played.js). Drop them here rather than letting Home
   * paint last session's progress bar for the ~250 ms until its revalidation
   * lands — the cost is one cold Home load
   * after each playback, and only that one. The library grid lives at
   * /Items?… (not /UserItems/Resume, /Items/Latest or /Items/{id}) and is deliberately untouched:
   * it renders no play state at all. */
  invalidatePlayState(b.ItemId);   // just this item: an Up Next warm of the next one stays
}

/* ---------------- subtitles ---------------- */
/* Every clearSubs() (and so every attachSubtitles()) supersedes the text
 * subtitle request in flight: its answer is dropped and its fetch aborted.
 * subIndex + playGen alone let an off→on round trip on the same track attach
 * both answers — every cue twice. */
let subReq = 0;
/** @type {AbortController | null} */
let subAbort = null;

export function clearSubs() {
  subReq++;
  if (subAbort) {
    subAbort.abort();
    subAbort = null;
  }
  if (!video) return;
  try {
    for (let i = 0; i < video.textTracks.length; i++) video.textTracks[i].mode = 'disabled';
  } catch {}
  const tracks = video.querySelectorAll('track');
  for (const t of tracks) {
    video.removeChild(t);
    // attachSubtitles() minted this blob URL; nothing else holds it, so without
    // a revoke every episode/track switch kept a whole VTT file alive.
    if (t.src.startsWith('blob:')) URL.revokeObjectURL(t.src);
  }
  if (pgsRenderer) {
    try {
      pgsRenderer.dispose();
    } catch {}
    pgsRenderer = null;
  }
  if (pgsCanvas) {
    const ctx = pgsCanvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, pgsCanvas.width, pgsCanvas.height);
    pgsCanvas.style.display = 'none';
  }
}

/** @param {VR.PlayerSource | null} src */
export function attachSubtitles(src) {
  clearSubs();
  if (P.subIndex < 0) return;
  const stream = streamByIndex(src, P.subIndex);
  if (!stream) return;
  const codec = (stream.Codec || '').toLowerCase();
  if (codec === 'pgssub' || codec === 'pgs') {
    attachPgs(/** @type {VR.PlayerSource} a stream was found in it */ (src), stream);   // PGS decodes client-side
    return;
  }
  if (isBurnCodec(codec)) return;   // handled by the burn-in transcode path
  const url =
    cfg.server +
    '/Videos/' + /** @type {NonNullable<typeof P.item>} */ (P.item).Id + '/' + /** @type {NonNullable<typeof src>} */ (src).Id + '/Subtitles/' + stream.Index + '/0/Stream.vtt' +
    qs({ api_key: cfg.token });
  const want = P.subIndex;
  const gen = playGen;   // a slow extraction must not land on the next video
  const req = subReq;    // …nor on a later attach of the same track (see subReq)
  const ac = (subAbort = new AbortController());
  // `_vtt`: the text is already here (a trailer's, fetched by trailerstream.js)
  (stream._vtt != null
    ? Promise.resolve(stream._vtt)
    : fetch(url, { signal: ac.signal }).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }))
    .then((vtt) => {
      if (P.subIndex !== want || gen !== playGen || req !== subReq) return;   // another track/video/attach was picked meanwhile
      if (subAbort === ac) subAbort = null;
      const blob = new Blob([vtt], { type: 'text/vtt' });
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.default = true;
      track.srclang = stream.Language || 'und';
      track.src = URL.createObjectURL(blob);
      // Cues exist only once the track has parsed: apply the timing offset then.
      track.addEventListener('load', () => shiftCues(), { once: true });
      /** @type {NonNullable<typeof video>} */ (video).appendChild(track);
      setTimeout(() => {
        if (req !== subReq) return;   // cleared meanwhile: leave the tracks disabled
        try {
          for (let i = 0; i < /** @type {NonNullable<typeof video>} */ (video).textTracks.length; i++) /** @type {NonNullable<typeof video>} */ (video).textTracks[i].mode = 'showing';
        } catch {}
        shiftCues();
      }, 250);
    })
    .catch(() => {
      if (P.subIndex !== want || gen !== playGen || req !== subReq) return;
      // Don't leave the menu claiming a track that isn't on screen.
      toast('Couldn’t load subtitles');
      P.subIndex = -1;
      clearSubs();
      reportProgress(video ? video.paused : true);
    });
}

/* ---------------- subtitle timing ----------------
 * P.subOffset shifts subtitles in time (+ = later). Text cues are moved in place
 * — each remembers its original times, so repeated steps never accumulate
 * clamping error — and the PGS renderer has a native timeOffset, which it adds
 * to the video time it renders at (so it is the negated offset). Burned-in subs
 * can't be shifted; the menu hides the control for them. */
function shiftCues() {
  if (!video) return;
  const off = P.subOffset || 0;
  try {
    for (let i = 0; i < video.textTracks.length; i++) {
      const cues = video.textTracks[i].cues;
      if (!cues) continue;
      for (let j = 0; j < cues.length; j++) {
        const c = /** @type {TextTrackCue & { _s0?: number, _e0?: number }} */ (cues[j]);
        if (c._s0 == null) {
          c._s0 = c.startTime;
          c._e0 = c.endTime;
        }
        c.startTime = Math.max(0, c._s0 + off);
        c.endTime = Math.max(c.startTime + 0.01, /** @type {NonNullable<typeof c._e0>} */ (c._e0) + off);
      }
    }
  } catch {}
}

export const SUB_OFFSET_STEP = 0.25;

/** @param {number} dir -1 earlier, 1 later */
export function nudgeSubOffset(dir) {
  const v = Math.round(((P.subOffset || 0) + dir * SUB_OFFSET_STEP) * 100) / 100;
  P.subOffset = Math.max(-30, Math.min(30, v));
  shiftCues();
  if (pgsRenderer) {
    try {
      pgsRenderer.timeOffset = -P.subOffset;
    } catch {}
  }
}

/** @param {VR.PlayerSource} src @param {VR.PlayerStream} stream */
function attachPgs(src, stream) {
  const url = stream.DeliveryUrl
    ? cfg.server + stream.DeliveryUrl
    : cfg.server +
      '/Videos/' + /** @type {NonNullable<typeof P.item>} */ (P.item).Id + '/' + src.Id + '/Subtitles/' + stream.Index + '/0/Stream.pgssub' +
      qs({ ApiKey: cfg.token });
  let PgsRenderer = null;
  try {
    PgsRenderer = loadPgs();
  } catch (e) {
    console.warn('libpgs load failed', e);
  }
  if (!PgsRenderer) {
    toast('Couldn’t show these subtitles');
    return;
  }
  if (!pgsCanvas) return;
  pgsCanvas.style.display = 'block';
  /* Main-thread mode, always. libpgs's default on Chrome 120 is its 'worker'
   * mode, which spawns a Worker and *then* calls transferControlToOffscreen()
   * on the canvas — and that throws here every time: #pgs is shared across
   * playbacks and clearSubs() has already given it a 2d context (and a canvas
   * can be transferred once at most). The throw left that Worker orphaned with
   * its onmessage set, so it survived GC: one leaked worker thread + isolate
   * per PGS attach (every PGS episode, every switch to a PGS track) for the
   * whole session — measured on the TV: 3 such workers still alive after two
   * forced GCs. Every PGS render that ever worked went through the mainThread
   * fallback anyway, so this is the same rendering path minus the leak. */
  try {
    pgsRenderer = new PgsRenderer(/** @type {ConstructorParameters<typeof PgsRenderer>[0]} video/canvas are set before any playback (setVideoEl) */ ({ mode: 'mainThread', video, canvas: pgsCanvas, subUrl: url, timeOffset: -(P.subOffset || 0) }));
  } catch (e) {
    console.warn('libpgs init failed', e);
    toast('Couldn’t show these subtitles');
  }
}

/* ---------------- transport ---------------- */
export function seekDur() {
  if (!video) return 0;
  return isFinite(video.duration) && video.duration > 0
    ? video.duration
    : ticksToSec(P.source && P.source.RunTimeTicks) || 0;
}

/* While a seek is pending, webOS can report video.currentTime as 0 transiently
 * — so trust the last intended target during that window. */
export function effectivePos() {
  if (seekTarget != null) return seekTarget;
  if (!video) return 0;
  const t = video.currentTime;
  return isFinite(t) && t >= 0 ? t : 0;
}

/* `quiet` seeks without raising the OSD — for a Skip Intro press, which is a
 * jump the user just asked for and doesn't need the transport to confirm. */
/** @param {number} t seconds @param {boolean} [quiet] */
export function seekTo(t, quiet) {
  const dur = seekDur();
  t = Math.max(0, dur ? Math.min(dur - 1, t) : t);
  seekTarget = t;
  // Any seek but a skip's own re-arms the chip of the window last skipped.
  if (!quiet) P.skipped = null;
  // A seek into the credits restarts the Up Next countdown from where it lands.
  upNextFrom = P.credits && t >= P.credits.start ? t : null;
  try {
    /** @type {NonNullable<typeof video>} */ (video).currentTime = t;
  } catch {}
  clearTimeout(seekClearT);
  seekClearT = setTimeout(() => {
    seekTarget = null;
  }, 900);
  P.pos = t;
  P.dur = dur;
  if (!quiet) showOsd();
}

/** @param {number} sec */
export function seekBy(sec) {
  seekTo(effectivePos() + sec);
}

export function togglePause() {
  if (!video) return;
  if (video.paused) video.play().catch(() => {});
  else video.pause();
  showOsd();
}

/* ---------------- skip intro / recap / preview ----------------
 * See segments.js for where the windows come from. Everything here is derived
 * from P.pos, so seeking back into the intro brings the chip back and seeking
 * past it takes the chip away — there is no separate "already skipped" flag to
 * get out of sync with the playhead. */

/* Resolve asynchronously and off the critical path: playback starts regardless,
 * and the chip simply appears if and when an answer arrives. The generation
 * counter drops an answer for an item we are no longer playing — a fast
 * episode-to-episode switch can otherwise land the previous lookup on the new
 * item and offer to skip a stretch that isn't its intro. */
/** @param {string} id @param {VR.PlayerItem | null} item @param {Promise<Partial<Jf.BaseItemDto>>} withChapters the item with Fields=Chapters (startPlayback's `extra`) */
function lookUpMarkers(id, item, withChapters) {
  const req = ++introReq;
  const current = () => req === introReq && P.item && P.item.Id === id;
  autoSkipped = new Set();
  P.skips = [];
  P.skipped = null;
  P.credits = null;
  P.next = null;
  /* Two sources, merged as each lands: Jellyfin (segments + named chapters)
   * wins per kind, IntroDB fills what it left empty — and is the only source of
   * recaps besides a chapter (segments.js says why). */
  /** @type {VR.Markers | null} */
  let jf = null;
  /** @type {VR.Markers | null} */
  let cm = null;
  const merge = () => {
    if (!current()) return;
    const have = new Set((jf ? jf.skips : []).map((s) => s.kind));
    P.skips = [...(jf ? jf.skips : []), ...(cm ? cm.skips.filter((s) => !have.has(s.kind)) : [])].sort((a, b) => a.start - b.start);
    P.credits = (jf && jf.credits) || (cm && cm.credits) || null;
  };
  findMarkers(id, item, withChapters).then((m) => {
    jf = m;
    merge();
  });
  communityLookup(item).then((r) => {
    if (!r) return;
    cm = communityMarkers(r, ticksToSec(/** @type {NonNullable<typeof item>} */ (item).RunTimeTicks));
    merge();
  });
  if (item && item.Type === 'Episode' && item.SeriesId) {
    // Episodes in the series' own order, starting at this one: the second is
    // what comes next — across a season boundary too. IsMissing=false keeps out
    // the placeholder entries metadata providers create for unaired episodes.
    /** @type {Promise<Jf.QueryResult>} */ (api(
      '/Shows/' + item.SeriesId + '/Episodes' +
        qs({ UserId: cfg.userId, StartItemId: id, Limit: 2, IsMissing: false, EnableImageTypes: 'Primary,Thumb' })
    ))
      .then((r) => {
        const n = ((r && r.Items) || [])[1];
        if (current()) P.next = n && n.Id !== id ? n : null;
      })
      .catch(() => {});
  }
}

/* IntroDB's answer for an episode, or null (a movie, no IMDb id on the series,
 * the service down). The series item is usually in the SWR cache already —
 * SeriesDetail or Home fetched it — and P.series is it when playback started
 * from the series page. */
/** @param {VR.PlayerItem | null} item @returns {Promise<Reel.SegmentsResponse | null>} */
async function communityLookup(item) {
  if (!item || item.Type !== 'Episode' || !item.SeriesId || item.ParentIndexNumber == null || item.IndexNumber == null) return null;
  try {
    const series = P.series && P.series.Id === item.SeriesId ? P.series : await /** @type {Promise<Jf.BaseItemDto>} */ (api(itemPath(item.SeriesId)));
    const imdb = series && series.ProviderIds && series.ProviderIds.Imdb;
    if (!imdb) return null;
    return await mlSegments(imdb, item.ParentIndexNumber, item.IndexNumber);
  } catch {
    return null;
  }
}

/* ---------------- trickplay ----------------
 * Jellyfin's trickplay task renders a thumbnail every `Interval` ms and packs
 * them into JPEG sheets of TileWidth × TileHeight. The item's `Trickplay` field
 * maps media source id → width → that layout; a thumbnail is a crop out of
 * sheet floor(n / perSheet). Nothing is decoded on the TV — the preview is a
 * background-position into an image the HTTP cache keeps.
 *
 * With a layout present, ◀▶ on the scrubber stop seeking the video on every
 * press: they move a pending target (P.scrub) with the preview above it, and
 * the one real seek happens once the D-pad rests (SCRUB_COMMIT), on OK, or when
 * focus leaves the scrubber. Back abandons it. Seeking a 4K HEVC stream is the
 * slow part, so this is what makes a long scrub feel instant. */
const SCRUB_COMMIT = 900;
/** @type {ReturnType<typeof setTimeout> | null} */
let scrubT = null;
let scrubRun = 0;

/** @param {string} id @param {string | null | undefined} sourceId @param {Promise<Partial<Jf.BaseItemDto>>} extra */
function lookUpTrickplay(id, sourceId, extra) {
  const req = introReq;
  P.trick = null;
  P.chapters = [];
  // Chapters ride on the same one-item request (`extra`): the scrubber's tick
  // marks and the OSD's Chapters list. A single chapter (or none) is no
  // navigation at all.
  extra
    .then((it0) => {
      if (req === introReq && P.item && P.item.Id === id) {
        const ch = (it0.Chapters || [])
          .map((c, i) => ({ at: ticksToSec(c.StartPositionTicks) || 0, name: (c.Name || '').trim() || 'Chapter ' + (i + 1) }))
          .sort((a, b) => a.at - b.at);
        P.chapters = ch.length >= 2 ? ch : [];
      }
      const tp = /** @type {Jf.TrickplayManifest} */ (it0.Trickplay || {});
      const bySource = tp[/** @type {string} null → undefined → the fallbacks */ (sourceId)] || tp[(sourceId || '').replace(/-/g, '')] || Object.values(tp)[0];
      if (!bySource) return;
      // The narrowest resolution is plenty for a ~400px preview, and the
      // smallest sheets load fastest.
      const w = Object.keys(bySource).map(Number).sort((a, b) => a - b)[0];
      const t = bySource[w];
      if (!t || !t.ThumbnailCount || req !== introReq || !P.item || P.item.Id !== id) return;
      P.trick = {
        id,
        sourceId: sourceId || '',
        res: w,
        w: t.Width,
        h: t.Height,
        cols: t.TileWidth,
        rows: t.TileHeight,
        count: t.ThumbnailCount,
        interval: t.Interval / 1000
      };
    })
    .catch(() => {});
}

/* Where the thumbnail for position `sec` lives: { url, x, y } in sheet pixels. */
/** @param {number} sec @returns {VR.TrickThumb | null} */
export function trickAt(sec) {
  const t = P.trick;
  if (!t) return null;
  const n = Math.max(0, Math.min(t.count - 1, Math.floor(sec / t.interval)));
  const per = t.cols * t.rows;
  const sheet = Math.floor(n / per);
  const k = n % per;
  return { url: trickSheet(sheet), x: (k % t.cols) * t.w, y: Math.floor(k / t.cols) * t.h };
}

/** @param {number} i sheet number @returns {string} */
function trickSheet(i) {
  const t = P.trick;
  return (
    cfg.server + '/Videos/' + /** @type {NonNullable<typeof t>} */ (t).id + '/Trickplay/' + /** @type {NonNullable<typeof t>} */ (t).res + '/' + i + '.jpg' +
    qs({ MediaSourceId: /** @type {NonNullable<typeof t>} */ (t).sourceId, ApiKey: cfg.token })
  );
}

/* One scrubber step from the D-pad. `repeat` is the key's auto-repeat flag:
 * holding ◀▶ accelerates from 10 s to 30 s to 60 s steps. */
/** @param {number} dir -1 back, 1 forward @param {boolean} [repeat] the key's auto-repeat flag */
export function scrubBy(dir, repeat) {
  scrubRun = repeat ? scrubRun + 1 : 0;
  if (!P.trick) {
    seekBy(dir * 30);   // no previews: every step is a real seek, as before
    return;
  }
  const step = scrubRun < 6 ? 10 : scrubRun < 20 ? 30 : 60;
  const dur = seekDur();
  const from = P.scrub != null ? P.scrub : effectivePos();
  P.scrub = Math.max(0, dur ? Math.min(dur - 1, from + dir * step) : from + dir * step);
  // warm the next sheet in the direction of travel
  const t = P.trick;
  const n = Math.floor(P.scrub / t.interval);
  const next = Math.floor(n / (t.cols * t.rows)) + dir;
  if (next >= 0 && next * t.cols * t.rows < t.count) new Image().src = trickSheet(next);
  showOsd();
  clearTimeout(scrubT);
  scrubT = setTimeout(commitScrub, SCRUB_COMMIT);
}

/* Seek to the pending target, if there is one. True when it did. */
export function commitScrub() {
  clearTimeout(scrubT);
  if (P.scrub == null) return false;
  const t = P.scrub;
  P.scrub = null;
  seekTo(t);
  return true;
}

export function cancelScrub() {
  clearTimeout(scrubT);
  const had = P.scrub != null;
  P.scrub = null;
  if (had) showOsd();
  return had;
}

/* The skip window the playhead is in, or null. The first by start wins where
 * two overlap; a recap that runs straight into the intro hands over to it the
 * moment its own window ends, so a second OK skips that too. */
/** @param {number} t @returns {VR.SkipWindow | null} */
function segmentAt(t) {
  for (const s of P.skips) if (t >= s.start && t < s.end) return s;
  return null;
}

/* Reactive: reads P.pos and P.skips, so callers can wrap it in $derived — the
 * window the chip offers to skip, or null. The chip yields to an open dropdown
 * and to the Up Next card, which share its corner (a teaser can sit inside the
 * credits), and retires a second early so a press at the very edge is never a
 * no-op. */
export function skipVisible() {
  if (P.panel) return null;
  const s = segmentAt(P.pos);
  return s && P.pos < s.end - 1 && P.skipped !== s.kind + ':' + s.start && !upNextVisible() ? s : null;
}

export function skipSegment() {
  const s = segmentAt(effectivePos());
  if (s) skipTo(s);
}

/* The TV decodes from the keyframe *before* the target, so a skip to 0:35
 * lands at ~0:31 (measured) — back inside the window, and the chip used to
 * come back for the seconds it took to play out of it. The skipped window
 * keeps its chip down until the next seek of any other kind. */
/** @param {VR.SkipWindow} s */
function skipTo(s) {
  P.skipped = s.kind + ':' + s.start;
  seekTo(s.end, true);
}

/* ---------------- up next ----------------
 * The next episode is offered from the start of the credits, with a countdown
 * that rolls on by itself. Like the intro chip, all of it is derived from the
 * playhead: pausing freezes the countdown, seeking back before the credits takes
 * the card away. Without credits data the card shows for the last UPNEXT_TAIL
 * seconds and the end of the file is the "go". */
const UPNEXT_COUNT = 10;
const UPNEXT_TAIL = 20;

/** @returns {VR.UpNextWindow | null} */
function upNextWindow() {
  if (!P.next || P.pending) return null;
  const dur = P.dur;
  if (!dur) return null;
  if (P.credits && P.credits.start < dur - 2) {
    const from = Math.max(P.credits.start, upNextFrom ?? 0);
    return { at: P.credits.start, go: Math.min(from + UPNEXT_COUNT, dur) };
  }
  return { at: Math.max(0, dur - UPNEXT_TAIL), go: dur };
}

/* Reactive (P.pos/P.dur/P.next/P.credits): true while the card is up. */
export function upNextVisible() {
  const w = upNextWindow();
  return !!w && !P.upNextOff && !P.panel && P.pos >= w.at;
}

/* Whole seconds left on the countdown. */
export function upNextLeft() {
  const w = upNextWindow();
  // Capped: a countdown never opens above its length, even for the few frames
  // before ontimeupdate has caught upNextFrom up with a short landing.
  return w ? Math.max(0, Math.min(P.credits && P.credits.start < P.dur - 2 ? UPNEXT_COUNT : UPNEXT_TAIL, Math.ceil(w.go - P.pos))) : 0;
}

export function dismissUpNext() {
  P.upNextOff = true;
  // Autoplay off and the file already over: "not now" leaves nothing to watch.
  if (video && video.ended) exitPlayer();
}

/* Stop this episode (reported as finished) and start the next one without
 * leaving the player. On a failed load, fall back to the normal exit.
 * `manual === true` is the OSD's Next episode button, pressed at any point:
 * the episode only counts as watched once the Up Next window (the credits, or
 * the last seconds) has been reached — otherwise the real position is reported
 * and the server's own played threshold decides. (A click handler passes its
 * event here, hence the strict comparison.) */
/** @param {boolean | Event} [manual] true = the OSD's Next episode button (a click handler passes its Event) */
export function playNext(manual) {
  const n = P.next;
  if (!n || advancing) return;
  advancing = true;
  const w = upNextWindow();
  reportStop(manual !== true || (!!w && effectivePos() >= w.at));
  const from = P.detailItem;
  if (video) {
    video.onpause = null;   // see exitPlayer
    video.pause();
  }
  clearSubs();
  P.panel = null;
  P.skips = [];
  P.credits = null;
  P.next = null;
  P.trick = null;
  P.chapters = [];
  cancelScrub();
  P.upNextOff = false;
  P.osdShown = false;
  P.pos = 0;
  P.spinner = true;
  P.loading = true;      // the backdrop card, describing the episode being fetched
  P.loadingItem = n;
  introReq++;
  const gen = playGen;
  const wanted = () => gen === playGen;
  playEpisode(n.Id, wanted).then((ok) => {
    advancing = false;
    if (!ok && wanted()) {
      P.spinner = false;
      P.loading = false;
      P.loadingItem = null;
      P.item = null;   // already reported stopped
      P.detailItem = from;
      exitPlayer();
    }
  });
}

/* ---------------- OSD visibility ---------------- */
export function showOsd() {
  if (video && !P.osdShown) {
    // ontimeupdate doesn't mirror position while the OSD is hidden — seed it so
    // the scrubber is current on the frame the OSD fades in.
    P.pos = effectivePos();
    P.dur = seekDur();
  }
  P.osdShown = true;
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => {
    if (video && !video.paused && !P.panel && P.scrub == null) P.osdShown = false;
  }, __PHONE__ ? OSD_HIDE_PHONE : 5000);
}

export function hideOsd() {
  P.osdShown = false;
}

export function closePanel() {
  P.panel = null;
  showOsd();
  focusKey(S.lastPill || 'c-audio');
}

export function osdTechSummary() {
  const v = videoStream(P.source);
  const parts = [];
  if (v) parts.push([resShort(v.Width, v.Height), hdrLabel(v)].filter(Boolean).join(' '));
  const ab = audioBadge(streamByIndex(P.source, P.audioIndex));
  if (ab) parts.push(ab);
  const sub = streamByIndex(P.source, P.subIndex);
  // "English forced subs", like the menu's names — not the raw "ENG" tag
  if (sub) parts.push([langKey(sub.Language), sub.IsForced ? 'forced' : isSdh(sub) ? 'SDH' : '', 'subs'].filter(Boolean).join(' '));
  return parts.filter(Boolean).join(' · ');
}

export function endsAt() {
  const d = new Date(Date.now() + Math.max(0, P.dur - P.pos) * 1000);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export function exitPlayer() {
  playGen++;
  // phone feeds: where it ended, read before the element is emptied below —
  // restartPos(), not the raw playhead: on the loading card (or right after a
  // seek) currentTime reads 0, and an offline copy would save that as its spot
  /** @type {[pos: number, dur: number, started: boolean] | null} */
  const feedEnd = __PHONE__ && feedRun ? [restartPos(), seekDur(), !!feedRun.started] : null;
  reportStop();
  if (!__PHONE__) resetRefreshRate();   // TV-only (refresh60.js)
  clearInterval(stallTimer);
  if (video) {
    // The pause handler reports progress, which would land *after* the Stopped
    // above and leave the server showing a paused session that has ended.
    // bindVideoEvents() re-binds it for the next playback.
    video.onpause = null;
    video.pause();
    try {
      video.removeAttribute('src');
      video.load();
    } catch {}
  }
  clearSubs();
  P.osdShown = false;
  P.panel = null;
  P.skips = [];
  P.credits = null;
  P.next = null;
  P.trick = null;
  P.chapters = [];
  cancelScrub();
  P.spinner = false;
  P.loading = false;
  P.loadingItem = null;
  P.error = null;
  startGen++;   // a start still waiting on loadedmetadata/playing must stay quiet
  introReq++;
  if (P.trailer) {
    endTrailer();
    return;
  }
  if (__PHONE__ && feedRun) {
    const r = feedRun;
    feedRun = null;
    if (r.feeder) r.feeder.stop();
    if (r.exit) {
      // an offline copy: hand over the position, lower the player over its list
      P.pending = false;
      r.exit(/** @type {NonNullable<typeof feedEnd>} */ (feedEnd)[0], /** @type {NonNullable<typeof feedEnd>} */ (feedEnd)[1], /** @type {NonNullable<typeof feedEnd>} */ (feedEnd)[2]);
      S.screen = S.base;
      return;
    }
  }
  if (P.pending) {
    // A pending stream has no Jellyfin item to navigate to — go back to the
    // screen it was started from, which is still S.base under the overlay.
    P.pending = false;
    if (S.base === 'pending') openPending(/** @type {string} set by openPending() */ (S.pendingKey));
    else if (S.base === 'lookup' && S.lookup) openLookup(S.lookup);
    else if (S.base === 'detail') openItem(/** @type {string} set by openItem() */ (S.detailId), S.detailType);
    else openHome();
    return;
  }
  /* Back to the page playback was started from — refreshed, since watched state
   * just changed. An episode started from its series page returns to the
   * series; one started from Home's hero returns to Home (on the hero, which
   * then offers Resume on whatever is now most recent — the episode Up Next
   * rolled on to included); any other episode (an episode's own page) opens its
   * own detail page. This used to key off
   * P.series, which is whatever series page was opened *last* and so could
   * send a Continue Watching episode to an unrelated show. */
  const d = P.detailItem;
  if (homeReturn && S.base === 'home') returnHome(homeReturn);
  else if (d && d.Type === 'Episode' && S.base === 'detail' && S.detailType === 'Series' && S.detailId === d.SeriesId)
    openItem(/** @type {string} === S.detailId */ (d.SeriesId), 'Series');
  else if (d) openItem(/** @type {string} */ (d.Id), d.Type);
  else openHome();
}

/* The app was sent to the background (Home button, input switch) or closed
 * mid-video (lifecycle.js: visibilitychange → hidden, and pagehide).
 * webOS parks the webview rather than killing it, so nothing would otherwise
 * tell Jellyfin playback ended: the resume point would be up to one 10 s
 * progress tick stale and the session would linger on the dashboard. So close
 * playback out properly — the detail page it lands on offers Resume
 * at the exact position. The Stopped report goes out with keepalive. */
export function suspendPlayback() {
  if (S.screen === 'player') exitPlayer();
}

/* ---------------- audio / subtitle selection ---------------- */
/* Both setters are the explicit-choice path — the only place a track
 * preference is written (trackprefs.js no-ops for movies and pending streams).
 * Remembering happens before any burn-in restart, which replays P.item via
 * play() and so never re-resolves the start tracks. */
/* Where a burn-in restart resumes. Not raw video.currentTime: the panel stays
 * usable under the loading card (Keys: `P.loading && !P.panel`), so a second
 * pick while the first restart's stream is still loading read 0 and restarted
 * the film from the top; and right after a seek currentTime reads garbage. */
function restartPos() {
  const t = effectivePos();
  return P.loading || !(t > 0) ? lastPos : t;
}

/** @param {number} idx stream index */
export function pmSetAudio(idx) {
  P.audioIndex = idx;
  if (!P.pending) rememberAudio(P.detailItem, P.source, idx);
  // In a burn-in transcode the audio is baked into the HLS, so switching it
  // needs a restart; a DirectPlay stream can switch tracks client-side.
  // On the phone the HLS remux carries only the selected audio track, so every
  // switch is the same restart (at the same position, old session stopped).
  if (__PHONE__ && P.pending && feedRun) {
    // a phone feed carries one audio track too: a new server job for this one
    const pos = restartPos();
    P.loading = true;
    P.loadingFrom = pos;
    startFeed(pos);
  } else if (__PHONE__ && (P.playMethod === 'Transcode' || P.playMethod === 'DirectStream')) {
    // Phone: raise the loading card now — the PlaybackInfo round trip used to
    // leave the old track playing for a second with no sign the tap landed.
    const pos = restartPos();
    P.loading = true;
    P.loadingFrom = pos;
    restartPlayback(pos);
  } else if (P.playMethod === 'Transcode') restartPlayback(restartPos());
  else {
    applyAudioSelection();
    reportProgress(/** @type {NonNullable<typeof video>} */ (video).paused);
  }
}

/** @param {number} idx stream index, -1 = off */
export function pmSetSub(idx) {
  if (P.trailer && trailerRun) trailerRun.subsOff = idx < 0;
  const wasBurn = P.playMethod === 'Transcode';
  const willBurn = needsBurnIn(P.source, idx);
  P.subIndex = idx;
  if (!P.pending) rememberSub(P.detailItem, P.source, idx);
  if ((wasBurn || willBurn) && __PHONE__) {
    const pos = restartPos();   // as pmSetAudio: the card goes up with the tap
    P.loading = true;
    P.loadingFrom = pos;
    restartPlayback(pos);
  } else if (wasBurn || willBurn) restartPlayback(restartPos());   // cross the DirectPlay↔burn-in boundary
  else {
    attachSubtitles(P.source);
    reportProgress(/** @type {NonNullable<typeof video>} */ (video).paused);
  }
}

/* ---------------- picture mode (companion service) ----------------
 * The web app is ACG-blocked from com.webos.settingsservice, and SSAP's
 * setSystemSettings returns 401 on this C4, so a small elevated helper service
 * makes the call and exposes it on loopback. See service/. */
const PIC_SVC = 'http://127.0.0.1:8791';

/* Belt and braces over the service's own 2.5 s luna deadline: a hung setPictureMode() would
 * leave P.picPending set — which refuses every later mode change for the
 * session. Loopback answers in milliseconds when healthy. */
const PIC_TIMEOUT = 6000;

/** @returns {Promise<VR.PictureReply>} */
export function svcGetModes() {
  if (__PHONE__) return Promise.reject(new Error('picture control is TV-only'));
  return fetch(PIC_SVC + '/modes', { signal: AbortSignal.timeout(PIC_TIMEOUT) }).then((r) => r.json());
}

/** @param {string} mode @returns {Promise<VR.PictureReply>} */
export function svcSetPicture(mode) {
  if (__PHONE__) return Promise.reject(new Error('picture control is TV-only'));
  return fetch(PIC_SVC + '/picture?mode=' + encodeURIComponent(mode), {
    signal: AbortSignal.timeout(PIC_TIMEOUT)
  }).then((r) => r.json());
}

/** @type {Record<string, string>} */
const MODE_LABELS = {
  filmMaker: 'Filmmaker', cinema: 'Cinema', cinemaBright: 'Cinema (bright)', normal: 'Standard',
  standard: 'Standard', vivid: 'Vivid', eco: 'Eco', sports: 'Sports', game: 'Game', photo: 'Photo',
  personalized: 'Personalized', expert1: 'Expert (Dark)', expert2: 'Expert (Bright)'
};

/* Picture modes are dimension-specific — a Dolby Vision signal exposes
 * dolbyHdr* modes, HDR10 exposes hdr*, SDR the plain ones. The panel is already
 * scoped to the live signal, so drop the range prefix and label the base. */
/** @param {string | null | undefined} m @returns {string} */
export function prettyMode(m) {
  if (!m) return '—';
  let base = m.replace(/^dolbyHdr/, '').replace(/^hdr/, '');
  base = base.charAt(0).toLowerCase() + base.slice(1);
  return (
    MODE_LABELS[base] ||
    base.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim()
  );
}

/** @param {string | null | undefined} s @returns {string} */
export function rangeLabel(s) {
  s = s || '';
  return /^dolbyHdr/.test(s) ? 'Dolby Vision' : /^hdr/.test(s) ? 'HDR' : 'SDR';
}

/* The selection mark moves only once the service confirms: until then the row
 * shows as pending (P.picPending) and the old mode stays marked, so a failure
 * needs no revert beyond clearing the pending state. */
/** @param {string} mode */
export function setPictureMode(mode) {
  if (mode === P.pictureMode || P.picPending) return;
  P.picPending = mode;
  let ok = false;
  svcSetPicture(mode)
    .then((r) => {
      if (r && r.returnValue) {
        ok = true;
        P.pictureMode = mode;
        toast('Picture mode → ' + prettyMode(mode));
      } else {
        toast('Couldn’t set picture mode' + (r && r.errorText ? ': ' + r.errorText : ''));
      }
    })
    .catch((e) => {
      // The TV's Chromium 120 rejects a timed-out fetch as AbortError, not
      // TimeoutError (measured); nothing else aborts this one. Refused = TypeError.
      if (e?.name !== 'TimeoutError' && e?.name !== 'AbortError') return toast('Picture control unavailable');
      /* Timed out, not refused: the service runs sets one at a time, so this one
       * can still be queued behind an earlier set (one abandoned by a reload, a
       * second client) and land after our 6 s. The service keeps at most one
       * waiting set, so ≤ 4 s more settles it — then believe the TV, not the
       * timeout. /modes isn't queued; if it times out too the service is gone. */
      return new Promise((res) => setTimeout(res, 4500))
        .then(svcGetModes)
        .then((r) => {
          if (r && r.current === mode) {
            ok = true;
            P.pictureMode = mode;
            toast('Picture mode → ' + prettyMode(mode));
          } else toast('Couldn’t set picture mode');
        })
        .catch(() => toast('Picture control unavailable'));
    })
    .finally(() => {
      P.picPending = null;
      /* A refused or failed set means the list on screen may be stale: the
       * companion service restarted (a different current mode), the signal
       * changed dimension under the panel ("No matched extended item"), or the
       * service is gone. Re-ask it, which also turns a dead service into the
       * panel's Retry row instead of a list whose every pick fails. */
      if (!ok && P.panel === 'picture') loadPictureModes();
    });
}

/* picGen: a slow /modes answer from an earlier open (or a Retry pressed twice)
 * must not overwrite a newer one. picErr is only cleared by a good answer, so
 * the panel's Retry row stays put (reading "Retrying…") while a retry runs. */
let picGen = 0;
export function loadPictureModes() {
  const gen = ++picGen;
  P.picLoading = true;
  return svcGetModes()
    .then((r) => {
      if (gen !== picGen) return;
      P.pictureModes = Array.isArray(r && r.modes) ? /** @type {string[]} */ (r.modes) : [];
      P.pictureMode = (r && r.current) || null;
      P.picErr = false;
    })
    .catch(() => {
      if (gen !== picGen) return;
      P.pictureModes = [];
      P.picErr = true;
    })
    .finally(() => {
      if (gen === picGen) P.picLoading = false;
    });
}
