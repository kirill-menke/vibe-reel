/* Type test (T12): describeTracks() rows and the pending stream's synthetic source. */
import { describeTracks } from '../../../src/lib/tracks.js';
import { sourceFromProbe } from '../../../src/lib/pendingplay.js';

/** CLAUDE.md "Watch while downloading": the probe becomes a Jellyfin-shaped MediaSource so the
 * audio menu works unchanged — sourceFromProbe() → describeTracks() must type-check end to end. */
const t = describeTracks(sourceFromProbe(null), { Genres: ['Anime'] });
/** @type {VR.TrackList} */ export const list = t;
/** Menu rows carry a finished `label` (numberDupes() turned `parts` into it). */
/** @type {string} */ export const firstAudio = t.audio[0].label;
/** The subs list starts with the 'None' row: index -1. */
/** @type {number} */ export const noneIndex = t.subs[0].index;
// @ts-expect-error a subtitle row's `burn` is a boolean flag, not the codec name.
export const badBurn = /** @type {VR.SubTrack} */ ({ label: 'x', index: 1, lang: 'eng', burn: 'vobsub' });

/** Pending-stream / trailer items need no Jellyfin Id (pendingplay.js builds one without). */
/** @type {VR.PlayerItem} */ export const pendingItem = { Type: 'Movie', Name: 'Dune', Genres: [], RunTimeTicks: 0 };
