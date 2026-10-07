/* Type test: VR.PlayerState describes P in src/lib/player.svelte.js exactly — same keys both
 * ways (incl. the phone-only `quality`, optional because of the `__PHONE__` spread), and P is
 * assignable to it. If a field is added to P, add it to VR.PlayerState (types/app.d.ts) too.
 * NOTE: since P is declared `@type {VR.PlayerState}`, `typeof P` IS VR.PlayerState, so the two
 * asserts below are only a tripwire for someone dropping that annotation. The real guard is the
 * `@satisfies {VR.PlayerState}` on the $state literal (player.svelte.js): an unknown key, a
 * missing key or a wrongly-typed initial value is a diagnostic there. */
import { P } from '../../../src/lib/player.svelte.js';

/** @type {TypeTest.Assert<TypeTest.SameKeys<VR.PlayerState, typeof P>>} */
export const playerStateKeys = true;

/** @type {VR.PlayerState} */
export const playerStateAssignable = P;

/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<typeof P.item>>>} */
export const itemNotAny = true;
/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<typeof P.skips>>>} */
export const skipsNotAny = true;
/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<typeof P.link>>>} */
export const linkNotAny = true;
/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<typeof P.source>>>} */
export const sourceNotAny = true;
/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<typeof P.trick>>>} */
export const trickNotAny = true;

/* The skip chip's windows carry a closed kind and a closed source. */
/** @type {VR.SkipWindow} */
export const skipOk = { kind: 'intro', start: 1, end: 90, from: 'segment' };
// @ts-expect-error 'outro' is not a skip kind: credits live in P.credits, not P.skips.
/** @type {VR.SkipWindow} */ export const skipBadKind = { kind: 'outro', start: 1, end: 90, from: 'segment' };
// @ts-expect-error 'jellyfin' is not a segment source (segment | chapter | introdb).
/** @type {VR.SegmentWindow} */ export const winBadFrom = { start: 1, end: 2, from: 'jellyfin' };

/* Panels are a closed union (TV audio/subs/picture/chapters, phone tracks/chapters). */
// @ts-expect-error 'quality' is not a panel: the phone's quality picker lives inside 'tracks'.
/** @type {VR.PlayerPanel} */ export const badPanel = 'quality';

/* Trailers / offline copies carry client-only fields Jellyfin items lack. */
/** @type {VR.PlayerItem} */
export const trailerItem = { Id: null, Name: 'Trailer', _art: null, _sub: 'Trailer' };
/** @type {VR.PlayerStream} */
export const trailerSub = { Type: 'Subtitle', Index: 2, Codec: 'webvtt', Language: 'eng', _vtt: 'WEBVTT' };
// @ts-expect-error plain Jellyfin streams have no _vtt: it is a VR.PlayerStream extension.
/** @type {Jf.MediaStream} */ export const jfSubNoVtt = { Type: 'Subtitle', Index: 2, _vtt: 'WEBVTT' };

/* playMethod is Jellyfin's closed PlayMethod. */
// @ts-expect-error 'HLS' is not a Jellyfin PlayMethod.
P.playMethod = 'HLS';
