/* Type test (T15): the player engine's exported API (src/lib/player.svelte.js). Nothing here
 * runs — each line only has to type-check (or, under @ts-expect-error, fail to). */
import {
  playNext, trickAt, seekTo, scrubBy, videoEl, svcGetModes, prettyMode, playEpisode, setQualityCap
} from '../../../src/lib/player.svelte.js';

/** VideoLayer.svelte: `onclick={playNext}` hands the click Event to `manual`, which is why
 * playNext() compares `manual !== true` strictly (CLAUDE.md "Up Next"). */
playNext(new MouseEvent('click'));
playNext(true);
playNext();

/** Trickplay preview: a sheet URL plus the crop offset, or null without a layout. */
/** @type {VR.TrickThumb | null} */ export const thumb = trickAt(42);
/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<ReturnType<typeof trickAt>>>>} */ export const thumbTyped = true;

/** The <video> handle is the real element type (audioTracks via types/globals.d.ts). */
/** @type {TypeTest.Assert<TypeTest.Equal<ReturnType<typeof videoEl>, HTMLVideoElement | null>>} */ export const el = true;
const v = videoEl();
/** @type {MediaAudioTrackList | undefined} */ export const tracks = v ? v.audioTracks : undefined;

/** Picture service replies are typed (service/service.js). */
/** @type {Promise<VR.PictureReply>} */ export const modes = svcGetModes();
/** @type {string} */ export const label = prettyMode('dolbyHdrCinema');

/** playEpisode() tells playNext() whether the start was requested. */
/** @type {Promise<boolean>} */ export const started = playEpisode('ep-1');

seekTo(90, true);
scrubBy(1, true);
setQualityCap('original');
setQualityCap(8000000);

// @ts-expect-error seekTo takes seconds as a number, not a timestamp string.
seekTo('1:30');
// @ts-expect-error the quality cap is bit/s or 'original', nothing else.
setQualityCap('high');
// @ts-expect-error playEpisode's second argument is a predicate, not a resume position.
playEpisode('ep-1', 30);
