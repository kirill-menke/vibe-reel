/* Watch-while-downloading: turn an activity item (a grab that is still coming
 * in) into a playback the normal player engine understands.
 *
 * The server side (reel-api) forces arr grabs to download sequentially and
 * serves the growing file with Range support, so the TV's <video> can follow
 * behind the download frontier through the exact same DirectPlay pipeline as
 * a library item. What the player needs from Jellyfin — a MediaSource with
 * MediaStreams for the audio menu / tech summary, and an item for the OSD —
 * is synthesized here from the service's ffprobe of the partial file.
 *
 * Framework-free on purpose (a plain src/lib module): the screens own the
 * reactive state; this is the imperative "OK was pressed on a pending row"
 * path. */
import { TICKS } from './api.js';
import { mlMetadata, mlProbe, mlStreamUrl } from './medialib.js';
import { playPendingStream, playFeedStream, videoEl } from './player.svelte.js';
import { liveOpener } from './livefeed.js';
import { feedSupported } from './segfeed.js';
import { toast } from './toast.svelte.js';
import { S } from './nav.svelte.js';

/* An activity item the stream endpoint can serve right now-ish: the grab has
 * reached the download client and bytes are (or will momentarily be) flowing.
 * A grab parked by the download client's queue slots (or paused) counts too
 * once it has ANY progress — the server force-starts it when the stream
 * opens, so pressing Play is what un-parks it. Only a 0% queued grab keeps
 * the status toast: nothing is on disk and the probe would refuse anyway. */
/** @param {Reel.ActivityItem | null | undefined} it @returns {boolean} */
export function canStream(it) {
  if (!it || !it.download_id) return false;
  if (it.status === 'downloading' || it.status === 'importing') return true;
  return (it.status === 'queued' || it.status === 'paused') && (it.progress || 0) > 0;
}

/* ffprobe's neutral shape -> a Jellyfin-shaped MediaSource, so describeTracks,
 * the OSD tech summary and applyAudioSelection() work unchanged. Subtitle
 * streams are deliberately omitted: without Jellyfin there is no way to fetch
 * them as VTT, so the subs menu honestly offers only "None". */
/** @param {Reel.ProbeResponse | null | undefined} probe @returns {VR.PlayerSource} */
export function sourceFromProbe(probe) {
  /** @type {VR.PlayerStream[]} */
  const streams = [];
  const v = probe && probe.video;
  if (v) {
    streams.push({
      Type: 'Video',
      Index: v.index ?? 0,
      Codec: v.codec,
      Width: v.width,
      Height: v.height,
      VideoRangeType: v.hdr === 'DV' ? 'DOVI' : v.hdr || ''
    });
  }
  for (const a of (probe && probe.audio) || []) {
    streams.push({
      Type: 'Audio',
      Index: /** @type {number} */ (a.index), // ffprobe numbers every stream (F08: unlike video, no ?? fallback)
      Codec: a.codec,
      Channels: a.channels,
      ChannelLayout: a.layout,
      Language: a.lang,
      Title: a.title,
      // isAtmos() sniffs Profile/Title — carry the server's verdict through
      Profile: a.atmos ? 'Atmos' : '',
      IsDefault: !!a.default
    });
  }
  return {
    Id: 'pending',
    Container: probe && probe.container === 'matroska' ? 'mkv' : (probe && probe.container) || 'mkv',
    RunTimeTicks: probe && probe.duration_s ? Math.floor(probe.duration_s * TICKS) : 0,
    Bitrate: (probe && probe.bitrate) || 0,
    MediaStreams: streams
  };
}

/* Start playing a pending grab. `group` names the title; `em` is the episode's
 * Sonarr metadata (title/overview) when the caller has it. The probe is
 * best-effort: not_ready falls back to a toast, but an older backend without
 * /probe still plays — just without track names in the menu. */
/* Watching a grab while it downloads. The TV plays the growing MKV as is; iOS
 * Safari can't play MKV, so on the phone reel-api remuxes the growing file to
 * fMP4 segments (livehls.py) and livefeed.js/segfeed.js append them to a
 * ManagedMediaSource (iOS 17.1+). Screens hide their Play button without it. */
export const canWatchPending = !__PHONE__ || feedSupported();

/** @param {Reel.ActivityItem} it the grab to watch @param {VR.ActivityGroup | null} [group] its title
 * @param {Reel.EpisodeMetadata | null} [em] the episode's Sonarr metadata, when the caller has it */
export async function playPending(it, group, em) {
  if (__PHONE__ && !canWatchPending) {
    toast('Watching while downloading needs iOS 17.1 or later');
    return;
  }
  if (!it.download_id) {
    toast('Streaming needs the updated library service');
    return;
  }
  // iPhone: still inside the tap — load() on the empty <video> lifts iOS's
  // gesture restriction, so the play() after the probe below has sound (as
  // play() does). The awaits that follow end the gesture.
  if (__PHONE__) {
    const v = videoEl();
    if (v && !v.getAttribute('src')) {
      try {
        v.load();
      } catch {}
    }
  }
  // The probe (and metadata) can take seconds: Back meanwhile cancels the start
  // rather than launching the video over the page the user went to.
  const epoch = S.epoch;
  let probe = null;
  try {
    probe = await mlProbe(it.download_id);
  } catch (e) {
    if (/** @type {VR.ApiError} */ (e).code === 'not_ready' || /** @type {VR.ApiError} */ (e).status === 409) {
      toast('Not enough downloaded yet — try again in a moment');
      return;
    }
    /* The stream endpoint shares the probe's lookup, so these fail it too:
     * a reel-api 404 {error:'not_found'} is a grab that left the queue (an
     * old backend without /probe 404s with FastAPI's bare {detail}, no error
     * code), a 503 other than 'probing unavailable' is the download client
     * being down, and status 0 is the service itself unreachable. */
    if (/** @type {VR.ApiError} */ (e).status === 404 && /** @type {VR.ApiError} */ (e).code === 'not_found') {
      toast('This download is no longer in the queue');
      return;
    }
    if (/** @type {VR.ApiError} */ (e).status === 0 || (/** @type {VR.ApiError} */ (e).status === 503 && /** @type {VR.ApiError} */ (e).detail !== 'probing unavailable')) {
      toast('Download service unavailable — try again in a moment');
      return;
    }
    /* probe unavailable (old backend / no ffprobe): play anyway */
  }
  const source = probe ? sourceFromProbe(probe) : { Id: 'pending', Container: 'mkv', MediaStreams: [] };
  // Genres only steer the audio default (anime → Japanese). The detail screen
  // has already fetched this metadata, so it comes from the session cache.
  /** @type {string[]} */
  let genres = [];
  if (group && group.mediaId) {
    try {
      genres = (await mlMetadata(group.type, group.mediaId)).genres || [];
    } catch {}
  }
  /** @type {VR.PlayerItem} */
  const item =
    it.type === 'tv' || it.season != null
      ? {
          Type: 'Episode',
          Name: (em && em.title) || it.episode_title || '',
          SeriesName: (group && group.title) || it.title,
          ParentIndexNumber: it.season,
          IndexNumber: it.episode,
          Overview: (em && em.overview) || '',
          Genres: genres,
          RunTimeTicks: source.RunTimeTicks
        }
      : {
          Type: 'Movie',
          Name: (group && group.title) || it.title,
          Genres: genres,
          RunTimeTicks: source.RunTimeTicks
        };
  if (epoch !== S.epoch || S.screen === 'player') return;
  if (__PHONE__) {
    playFeedStream({ item, source, downloadId: it.download_id, open: liveOpener(it.download_id) });
    return;
  }
  playPendingStream({ url: mlStreamUrl(it.download_id), item, source, downloadId: it.download_id });
}
