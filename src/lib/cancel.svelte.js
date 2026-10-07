/* Cancel a download in flight — the phone's long-press "Cancel download" on a
 * downloading/queued episode row (SeriesDetail, PendingDetail), a pending tile
 * (Library) and PendingDetail's whole title. The server (DELETE
 * /api/activity/…, mlCancelDownload) removes the grabs from Sonarr/Radarr and
 * qBittorrent with their partial data and unmonitors what they were for, so
 * the arr doesn't simply grab it again.
 *
 * A torrent is all-or-nothing: one episode of a season pack cancels the pack.
 * packOf() tells the UI up front so the confirm can say so.
 *
 * Rows dim at once (`cancelling`, by activity item id) and disappear with the
 * next activity poll; a failed cancel un-dims them. Only the phone imports
 * this module. */
import { mlCancelDownload } from './medialib.js';
import { act, boostActivity } from './activity.svelte.js';
import { toast } from './toast.svelte.js';
import { errText } from './api.js';

/* activity item id -> Date.now() of the cancel */
/** @type {Record<string, number>} */
export const cancelling = $state({});
/* activity group key -> true once the whole title was cancelled (PendingDetail
 * says "cancelled" instead of "being added to your library") */
/** @type {Record<string, boolean>} */
export const cancelledGroups = $state({});

/* Longer than a poll or two: past this, a row still in the feed un-dims — the
 * cancel evidently didn't take. */
const DIM_FOR = 60000;

/* May the signed-in user cancel this grab? reel-api says per row
 * (`can_cancel`: an admin, or the user's own title / a season they asked
 * for); a row without the field is from a backend older than ownership, where
 * anyone could. The UI hides Cancel otherwise — the server refuses it anyway
 * (403 not_owner). */
/** @param {Reel.ActivityItem} it @returns {boolean} */
export function canCancel(it) {
  return it.can_cancel !== false;
}

/* A whole title's cancel takes every row with it, so it needs every one. */
/** @param {Pick<VR.ActivityGroup, 'items'>} g @returns {boolean} */
export function canCancelGroup(g) {
  return g.items.every(canCancel);
}

/* One row's cancel takes its whole torrent (packOf), so it needs every row of
 * it — a pack may span a season that isn't the user's. */
/** @param {Reel.ActivityItem} it @returns {boolean} */
export function canCancelPack(it) {
  return packOf(it).every(canCancel);
}

/** @param {Reel.ActivityItem} it @returns {boolean} */
export function isCancelling(it) {
  const t = cancelling[it.id];
  return !!t && Date.now() - t < DIM_FOR;
}

/* Every activity item a cancel of `it` takes with it: the rows sharing its
 * torrent (all episodes of a season pack), else just `it`. Reactive. */
/** @param {Reel.ActivityItem} it @returns {Reel.ActivityItem[]} */
export function packOf(it) {
  if (!it.download_id) return [it];
  const rows = act.items.filter((i) => i.download_id === it.download_id);
  return rows.length ? rows : [it];
}

/* "S1 · E3", or "Season 1 · 6 episodes" / "6 episodes" for a pack. */
/** @param {Reel.ActivityItem} it @returns {string} */
export function cancelWhat(it) {
  if (it.type !== 'tv') return it.title;
  const pack = packOf(it);
  if (pack.length > 1) {
    const seasons = [...new Set(pack.map((p) => p.season))];
    return (seasons.length === 1 && seasons[0] != null ? 'Season ' + seasons[0] + ' · ' : '') + pack.length + ' episodes';
  }
  return 'S' + (it.season ?? '?') + ' · E' + (it.episode ?? '?');
}

/* The confirm step's menu rows (ContextMenu items). `what` is the thing
 * cancelled ("S1 · E3", a title); `n` > 1 spells out a season pack. */
/** @param {string} what @param {number} n rows the cancel takes @param {() => void} onConfirm @returns {VR.MenuRow[]} */
export function confirmItems(what, n, onConfirm) {
  return [
    {
      label: (n > 1 ? 'They come as one download. ' : '') + 'Cancel ' + what + '? What has arrived so far is deleted.',
      disabled: true
    },
    { label: n > 1 ? 'Cancel all ' + n + ' episodes' : 'Cancel download', icon: 'trash', danger: true, action: onConfirm },
    { sep: true },
    { label: 'Keep downloading', action: () => {} }
  ];
}

/** @param {Parameters<typeof mlCancelDownload>[0]} target @param {Reel.ActivityItem[]} rows dimmed meanwhile @param {string} what @returns {Promise<boolean>} */
async function run(target, rows, what) {
  const now = Date.now();
  for (const r of rows) cancelling[r.id] = now;
  try {
    await mlCancelDownload(target);
    boostActivity(); // the rows go with the next poll, not up to 30 s later
    toast('Cancelled — ' + what);
    return true;
  } catch (e) {
    if (/** @type {VR.ApiError} */ (e).status === 404) {
      // nothing of it in the queue any more: the result the user wanted
      toast('Already gone — ' + what);
      return true;
    }
    for (const r of rows) delete cancelling[r.id];
    toast(
      /** @type {VR.ApiError} */ (e).status === 403
        ? errText(/** @type {VR.ApiError} */ (e)) // not_owner: the server's sentence
        : /** @type {VR.ApiError} */ (e).code === 'importing'
          ? 'Too late — it’s being added to your library'
          : /** @type {VR.ApiError} */ (e).retriable
            ? 'Library busy — try again in a moment'
            : 'Couldn’t cancel: ' + errText(/** @type {VR.ApiError} */ (e))
    );
    return false;
  }
}

/* One activity item: an episode's grab (its pack with it) or a movie's. */
/** @param {Reel.ActivityItem} it @returns {Promise<boolean>} */
export function cancelItem(it) {
  if (!it.media_id) {
    toast('Can’t cancel this one from here');
    return Promise.resolve(false);
  }
  const tv = it.type === 'tv';
  /** @type {Parameters<typeof mlCancelDownload>[0]} */
  const target = { type: it.type, id: it.media_id };
  if (tv && it.season != null) target.season = it.season;
  if (tv && it.season != null && it.episode != null) target.episode = it.episode;
  const rows = packOf(it);
  return run(target, rows, tv ? it.title + ' ' + cancelWhat(it) : it.title);
}

/* A whole activity group (pendingGroups()): every grab of the title. */
/** @param {VR.ActivityGroup} g @returns {Promise<boolean>} */
export async function cancelGroup(g) {
  if (!g.mediaId) {
    toast('Can’t cancel this one from here');
    return false;
  }
  const ids = new Set(g.items.map((i) => i.download_id).filter(Boolean));
  const rows = act.items.filter((i) => g.items.includes(i) || (i.download_id && ids.has(i.download_id)));
  const ok = await run({ type: g.type, id: g.mediaId }, rows.length ? rows : g.items, g.title);
  if (ok) cancelledGroups[g.key] = true;
  return ok;
}
