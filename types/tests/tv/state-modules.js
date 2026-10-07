/* Type test (T16): the shared $state objects of src/lib are typed, not `any`. */
import { act, pendingGroups, matchGroup, statLabel } from '../../../src/lib/activity.svelte.js';
import { news } from '../../../src/lib/news.svelte.js';
import { SET, setSetting } from '../../../src/lib/settings.svelte.js';
import { LV } from '../../../src/lib/libview.svelte.js';
import { landed } from '../../../src/lib/landed.svelte.js';
import { adds, trending } from '../../../src/lib/lookup.svelte.js';
import { toastState } from '../../../src/lib/toast.svelte.js';

/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<typeof act.items>>>} */ export const a1 = true;
/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<typeof news.items>>>} */ export const a2 = true;
/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<typeof SET>>>} */ export const a3 = true;
/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<typeof landed.items>>>} */ export const a4 = true;
/** @type {TypeTest.Assert<TypeTest.Equal<typeof SET.subMode, 'auto' | 'always' | 'off'>>} */ export const a5 = true;
/** @type {TypeTest.Assert<TypeTest.Equal<(typeof adds)[string], VR.AddState>>} */ export const a6 = true;

/** Groups are built from the activity feed (VR.ActivityGroup from Reel.ActivityItem). */
/** @type {VR.ActivityGroup[]} */ export const groups = pendingGroups('tv');
/** @type {Reel.ActivityItem[]} */ export const grabs = groups[0].items;

/** landed.svelte.js matches a Jellyfin item against partial groups: matchGroup() keeps their type. */
const partial = matchGroup([{ type: 'movie', mediaId: '603', title: 'Example Film' }], { Type: 'Movie', Name: 'Example Film', ProviderIds: { Tmdb: '603' } });
/** @type {{ type: Reel.MediaType, mediaId: string | null, title: string } | null} */ export const matched = partial;

/** statLabel() takes a hand-built `{ status, progress, speed }` too. */
/** @type {string} */ export const lbl = statLabel({ status: 'downloading', progress: 0.43, speed: 7.4e6, timeleft: '1:11:24' });

setSetting('subSize', 120);
setSetting('subMode', 'always');
LV.open = 'genre';
trending.tv = null;
toastState.undo = () => {};

// @ts-expect-error a setting's value must match its key (subSize is a number).
setSetting('subSize', 'large');
// @ts-expect-error 'subtitles' is not a subtitle mode.
setSetting('subMode', 'subtitles');
// @ts-expect-error the library bar has no 'filter' dropdown.
LV.open = 'filter';
// @ts-expect-error an activity status is one of the backend's words.
statLabel({ status: 'stalled', progress: 0 });
