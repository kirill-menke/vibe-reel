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
export const cancelling = $state({});
/* activity group key -> true once the whole title was cancelled (PendingDetail
 * says "cancelled" instead of "being added to your library") */
export const cancelledGroups = $state({});

/* Longer than a poll or two: past this, a row still in the feed un-dims — the
 * cancel evidently didn't take. */
const DIM_FOR = 60000;

export function isCancelling(it) {
  const t = cancelling[it.id];
  return !!t && Date.now() - t < DIM_FOR;
}

/* Every activity item a cancel of `it` takes with it: the rows sharing its
 * torrent (all episodes of a season pack), else just `it`. Reactive. */
export function packOf(it) {
  if (!it.download_id) return [it];
  const rows = act.items.filter((i) => i.download_id === it.download_id);
  return rows.length ? rows : [it];
}

/* "S1 · E3", or "Season 1 · 6 episodes" / "6 episodes" for a pack. */
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

async function run(target, rows, what) {
  const now = Date.now();
  for (const r of rows) cancelling[r.id] = now;
  try {
    await mlCancelDownload(target);
    boostActivity(); // the rows go with the next poll, not up to 30 s later
    toast('Cancelled — ' + what);
    return true;
  } catch (e) {
    if (e.status === 404) {
      // nothing of it in the queue any more: the result the user wanted
      toast('Already gone — ' + what);
      return true;
    }
    for (const r of rows) delete cancelling[r.id];
    toast(
      e.code === 'importing'
        ? 'Too late — it’s being added to your library'
        : e.retriable
          ? 'Library busy — try again in a moment'
          : 'Couldn’t cancel: ' + errText(e)
    );
    return false;
  }
}

/* One activity item: an episode's grab (its pack with it) or a movie's. */
export function cancelItem(it) {
  if (!it.media_id) {
    toast('Can’t cancel this one from here');
    return Promise.resolve(false);
  }
  const tv = it.type === 'tv';
  const target = { type: it.type, id: it.media_id };
  if (tv && it.season != null) target.season = it.season;
  if (tv && it.season != null && it.episode != null) target.episode = it.episode;
  const rows = packOf(it);
  return run(target, rows, tv ? it.title + ' ' + cancelWhat(it) : it.title);
}

/* A whole activity group (pendingGroups()): every grab of the title. */
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
