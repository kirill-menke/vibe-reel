/* R.playerQuiet (router.svelte.js): true while the player modal shows a
 * trailer. A trailer reports nothing to Jellyfin and its page isn't even
 * remounted, so its close must not bump R.playerClosed — that made Home reload
 * every rail, the Detail page re-read its item and each grid re-read its whole
 * loaded range, for nothing.
 *
 * Timing: the engine sets P.trailer before it raises the modal and clears it
 * in the same task that lowers it (endTrailer → closePlayer), so the value
 * closePlayer() reads is the one this effect wrote after the open; it re-runs
 * only after the close. Kept apart from the router because it reads the
 * engine (see there). Imported for its effect by main.js. */
import { P } from '$lib/player.svelte.js';
import { R } from './router.svelte.js';

$effect.root(() => {
  $effect(() => {
    R.playerQuiet = R.modal === 'player' && P.trailer;
  });
});
