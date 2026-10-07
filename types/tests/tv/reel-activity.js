/* Type test: reel-api activity / probe / cancel / undo payloads (types/reel-api.d.ts, T03).
 * Fixtures are invented (no real library data), shaped like backend/src/reel_api's
 * pydantic models serialise them: every field present, null when unknown. */
import { sourceFromProbe } from '../../../src/lib/pendingplay.js';

/** A season-pack episode downloading — current backend, every extended field present. */
/** @type {Reel.ActivityItem} */
export const downloadingEpisode = {
  id: '1042',
  type: 'tv',
  title: 'Harbour Lights',
  subtitle: 'S02E03 · The Lighthouse Keeper',
  status: 'downloading',
  progress: 0.4312,
  size_bytes: 21_474_836_480,
  timeleft: '1:11:24',
  quality: 'WEBDL-2160p',
  download_speed: 7_759_462,
  message: null,
  media_id: '7654321',
  season: 2,
  episode: 3,
  episode_title: 'The Lighthouse Keeper',
  poster: 'https://artworks.example.invalid/posters/7654321.jpg',
  year: 2022,
  download_id: '0123456789abcdef0123456789abcdef01234567'
};

/** A movie still queued: no torrent yet, so no download_id; Sonarr/Radarr's own eta. */
/** @type {Reel.ActivityItem} */
export const queuedMovie = {
  id: '77',
  type: 'movie',
  title: 'Glass Orchard',
  subtitle: '2021',
  status: 'queued',
  progress: 0,
  size_bytes: null,
  timeleft: null,
  quality: 'Bluray-1080p',
  download_speed: 0,
  message: null,
  media_id: '424242',
  season: null,
  episode: null,
  episode_title: null,
  poster: null,
  year: 2021,
  download_id: null
};

/** An OLDER backend's item: only the base fields (activity.svelte.js parses `subtitle`). */
/** @type {Reel.ActivityItem} */
export const oldBackendItem = {
  id: '9', type: 'tv', title: 'Harbour Lights', subtitle: 'S01E01 · Pilot', status: 'importing',
  progress: 1, size_bytes: 1_000_000_000, timeleft: null, quality: 'HDTV-720p', download_speed: 0
};

/** @type {Reel.ActivityResponse} */
export const activity = { items: [downloadingEpisode, queuedMovie, oldBackendItem] };

/** A probe of a growing 4K DV remux. */
/** @type {Reel.ProbeResponse} */
export const probe = {
  container: 'matroska',
  duration_s: 7860.5,
  bitrate: 68_000_000,
  size_bytes: 61_000_000_000,
  video: { index: 0, codec: 'hevc', width: 3840, height: 2160, hdr: 'DV', fps: 23.976 },
  audio: [
    { index: 1, codec: 'truehd', channels: 8, layout: '7.1', lang: 'eng', title: 'TrueHD Atmos 7.1', atmos: true, default: true },
    { index: 2, codec: 'eac3', channels: 6, layout: '5.1(side)', lang: 'ger', title: null, atmos: false, default: false }
  ],
  subtitles: [{ index: 3, codec: 'hdmv_pgs_subtitle', lang: 'eng', title: null, forced: false, default: false }]
};

/** @type {Reel.ProbeNotReady} */
export const notReady = { error: 'not_ready', detail: 'file header not downloaded yet' };

/** The probe feeds sourceFromProbe() unchanged. */
export const pendingSource = sourceFromProbe(probe);

/** @type {Reel.CancelResponse} */
export const cancelled = {
  id: '7654321', type: 'tv', status: 'cancelled', downloads_removed: 1,
  episodes: [{ season: 2, episode: 3 }, { season: 2, episode: 4 }], unmonitored: 2, kept: 0
};

/** @type {Reel.LibraryAddResult} */
export const added = { id: '424242', type: 'movie', title: 'Glass Orchard', status: 'added', undo: 'tok-abc' };
/** @type {Reel.LibraryUndoResult} */
export const undone = { id: '424242', type: 'movie', title: 'Glass Orchard', status: 'removing', downloads_removed: 1 };
/** @type {Reel.SeasonSearchResult} */
export const searching = { id: '7654321', season: 3, title: 'Harbour Lights', status: 'searching', undo: null };
/** @type {Reel.SeasonSearchUndoResult} */
export const reverted = { id: '7654321', season: 3, title: 'Harbour Lights', status: 'reverted', downloads_removed: 0, kept: 1 };

/* ---- negatives ---- */

// @ts-expect-error 'stalled' is not an activity status (the backend maps stalled to 'downloading').
/** @type {Reel.ActivityStatus} */ export const badStatus = 'stalled';

// @ts-expect-error camelCase `downloadId` is the arr's field; the JSON says download_id.
/** @type {Reel.ActivityItem} */ export const camel = { ...oldBackendItem, downloadId: 'x' };

// @ts-expect-error progress is a 0–1 float, not the '43%' string the UI renders.
/** @type {Reel.ActivityItem} */ export const pctString = { ...oldBackendItem, progress: '43%' };

// @ts-expect-error a probe's hdr is 'DV', not Jellyfin's 'DOVI' (sourceFromProbe translates it).
/** @type {Reel.ProbeVideo} */ export const doviHdr = { index: 0, codec: 'hevc', width: 1, height: 1, hdr: 'DOVI', fps: null };

// @ts-expect-error a 409 probe answer is not a ProbeResponse.
/** @type {Reel.ProbeResponse} */ export const notReadyAsProbe = notReady;
