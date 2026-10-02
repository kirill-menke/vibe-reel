import { cfg } from './config.js';
import { api, invalidate, qs, itemPath } from './api.js';

/* Everything Home paints from a user's play state: Resume (hero + Continue
 * Watching), Next Up, and Latest (which drops played items for users with
 * "hide played in Latest"). Called after playback stops and after the watched
 * toggle below, so Home never paints play state this app itself just changed
 * out of its SWR cache. */
export function invalidatePlayState(itemId) {
  /* Parked item warms (Tile, SeriesDetail episode rows, Up Next) carry UserData
   * too, and would otherwise resume from a stale position. With `itemId` (a
   * playback stop) only that item's warm goes — Up Next's warm of the *next*
   * episode must survive the roll-on; without it (a watched toggle, which can
   * mark a whole season) every '/Items/…' warm goes. The library grid
   * ('/Items?…') matches neither. */
  // '/Shows/' also covers the seasons warm (Tile/Detail), whose UserData would
  // otherwise show a season's old watched state.
  invalidate(['/UserItems/Resume', '/Items/Latest', '/Shows/', itemId ? itemPath(itemId) : '/Items/']);
}

/* Mark an item watched (or unwatched). A season or series marks every episode
 * under it. Resolves to the item's new UserData (Played, PlaybackPositionTicks
 * reset to 0, …) so the caller can update its row in place.
 *
 * /UserPlayedItems is the 10.9+ route; the older /Users/{id}/PlayedItems is
 * not in 12.1's API spec. */
export function setPlayed(id, played) {
  return api('/UserPlayedItems/' + id + qs({ userId: cfg.userId }), { method: played ? 'POST' : 'DELETE' }).then(
    (ud) => {
      invalidatePlayState();
      return ud;
    }
  );
}
