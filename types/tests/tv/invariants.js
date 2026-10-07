/* Type test (T30): documented invariants of the project rulebook (the local-only CLAUDE.md of
 * the main checkout), each pinned at the type level. Every block quotes the rule it encodes
 * (with its CLAUDE.md line as of 2026-10-03), so a type change that breaks the rule fails the
 * lane check here, next to the reason. Fixtures are invented (no real library data). */
import { focusEl, focusNow, focusKey, byKey } from '../../../src/lib/focus.js';
import { hideFromHome, hiddenFilter } from '../../../src/lib/homehide.js';
import { rememberAudio, rememberSub, trackPrefs, matchSub } from '../../../src/lib/trackprefs.js';
import { deviceProfile } from '../../../src/lib/tracks.js';
import { S } from '../../../src/lib/nav.svelte.js';

/* ---- 1. Track memory is stored by meaning, never by stream index ----
 * CLAUDE.md:566 "Stored **by meaning, not stream index** — audio `{lang}` (then the usual
 * `score()` within it; commentary-ness isn't carried), subs `{off}` or `{lang, forced, sdh, burn}`." */
/** @type {TypeTest.Assert<TypeTest.Equal<keyof VR.AudioPref, 'lang'>>} */
export const audioPrefIsLangOnly = true;
/** @type {TypeTest.Assert<TypeTest.Equal<keyof VR.SubPref, 'off' | 'lang' | 'forced' | 'sdh' | 'burn'>>} */
export const subPrefIsMeaning = true;
/** @type {TypeTest.Assert<TypeTest.Equal<keyof VR.TrackPrefEntry, 'a' | 's' | 't'>>} */
export const prefEntryKeys = true;
/** What a read hands the player is that entry, not an index. */
/** @type {VR.TrackPrefEntry | null} */
export const readBack = trackPrefs({ Type: 'Episode', SeriesId: 'series-0001' });
/** @type {VR.AudioPref} */
export const audioPref = { lang: 'en' };
/** @type {VR.SubPref} */
export const subOff = { off: true };
/** @type {VR.SubPref} */
export const subForced = { lang: 'de', forced: true, sdh: false, burn: false };
// @ts-expect-error an audio pref carries no stream Index: indexes differ between episodes' files.
/** @type {VR.AudioPref} */ export const audioByIndex = { lang: 'en', Index: 2 };
// @ts-expect-error a sub pref carries no stream index either (matchSub() resolves it per file).
matchSub(null, { index: 3 });
/* The writers take the menu's stream index and translate it themselves (pmSetAudio/pmSetSub are
 * the only callers; CLAUDE.md:562 "the *only* writers"). */
rememberAudio({ Type: 'Episode', SeriesId: 'series-0001' }, null, 1);
rememberSub({ Type: 'Episode', SeriesId: 'series-0001' }, null, -1);

/* ---- 2. Home hiding is local, per account, and keyed by the thing that brings a tile back ----
 * CLAUDE.md:778-779 "Continue Watching by item id + its `LastPlayedDate` stamp (playing it again
 * brings it back), Next Up by **series id → episode id** (a different next episode reappears)." */
/** @type {TypeTest.Assert<TypeTest.Equal<keyof VR.HomeHidden, 'cw' | 'nu'>>} */
export const hiddenKeys = true;
/** @type {VR.HomeHidden} */
export const hidden = {
  cw: { 'item-0001': '2026-09-30T20:15:00.0000000Z' },
  nu: { 'series-0001': 'episode-0007' }
};
/** Only the two playing rails can hide a tile (CLAUDE.md:773 "Hold OK removes the tile"). */
/** @type {TypeTest.Assert<TypeTest.Equal<Parameters<typeof hideFromHome>[0], 'cw' | 'nextup'>>} */
export const hideKinds = true;
/** The undo the toast offers (CLAUDE.md:779 "The toast offers **▶ Undo**"). */
/** @type {() => void} */
export const undo = hideFromHome('cw', { Id: 'item-0001', Type: 'Movie', Name: 'Invented Film' });
/** @type {(it: Jf.BaseItemDto) => boolean} */
export const cwFilter = hiddenFilter().cw;
// @ts-expect-error a hidden Next Up entry is series id -> episode id (a string), not a flag.
/** @type {VR.HomeHidden} */ export const nuAsFlag = { cw: {}, nu: { 'series-0001': true } };
// @ts-expect-error 'latest' is not a rail that can hide tiles (Jellyfin has no hide; it's local).
hideFromHome('latest', { Id: 'item-0002' });

/* ---- 3. The no-transcode contract: TranscodingProfiles is always declared ----
 * CLAUDE.md:547 "`deviceProfile(burn)` declares **empty `TranscodingProfiles`** so Jellyfin has
 * no choice but DirectPlay … **Don't add transcoding profiles for any other reason.**"
 * The emptiness itself is a VALUE (and the phone build's phoneProfile() legitimately has one), so
 * the type pins what it can: the key is required — omitting it would let Jellyfin fall back to
 * its own defaults — and deviceProfile() returns that closed shape for both arguments. */
/** @type {TypeTest.Assert<{} extends Pick<Jf.DeviceProfile, 'TranscodingProfiles'> ? false : true>} */
export const transcodingRequired = true;
/** @type {TypeTest.Assert<TypeTest.Equal<ReturnType<typeof deviceProfile>, Jf.DeviceProfile>>} */
export const profileExact = true;
/** @type {TypeTest.Assert<TypeTest.Equal<Parameters<typeof deviceProfile>[0], boolean>>} */
export const burnIsTheOnlySwitch = true;

/* ---- 4. All focusing goes through focusEl(), which takes any Element ----
 * CLAUDE.md:481 "**all focusing goes through `focusEl()`, which calls
 * `focus({ preventScroll: true })`** — never bare `el.focus()`." It must accept what byKey() and
 * querySelector() return (Element, incl. SVG) and nothing-found (null). */
/** @type {TypeTest.Assert<TypeTest.Equal<Parameters<typeof focusEl>[0], Element | null | undefined>>} */
export const focusElTakesElement = true;
/** @type {TypeTest.Assert<TypeTest.Equal<ReturnType<typeof focusEl>, boolean>>} */
export const focusElReports = true;
/** byKey() feeds it directly. */
/** @type {boolean} */
export const focused = focusEl(byKey('tile-0'));
/** focusKey awaits tick() (CLAUDE.md:512 "Use `focusKey(key)` (which awaits `tick()`)"),
 * focusNow is the synchronous variant. */
/** @type {TypeTest.Assert<ReturnType<typeof focusKey> extends Promise<unknown> ? true : false>} */
export const focusKeyIsAsync = true;
/** @type {TypeTest.Assert<ReturnType<typeof focusNow> extends Promise<unknown> ? false : true>} */
export const focusNowIsSync = true;
// @ts-expect-error focusEl takes the element, not its data-focus key (that is focusNow/focusKey).
focusEl('tile-0');

/* ---- 5. The news bell's kinds are a closed union ----
 * CLAUDE.md:413-416 "seasons with no file that either aired within the last year (`aired`, with a
 * **Get** button …) or are listed but unaired (`upcoming`, with the premiere date)"; the id
 * includes the kind "so a premiere re-notifies". */
/** @type {TypeTest.Assert<TypeTest.Equal<Reel.NewsItem['kind'], 'aired' | 'upcoming'>>} */
export const newsKinds = true;
/** @type {Reel.NewsItem} */
export const upcoming = {
  id: '100001:3:upcoming',
  kind: 'upcoming',
  media_id: '100001',
  title: 'Invented Show',
  year: 2024,
  poster: null,
  fanart: null,
  season: 3,
  premiere: '2026-11-02T02:00:00Z',
  last_aired: null,
  episodes_aired: 0,
  episodes_total: 8,
  monitored: true
};
// @ts-expect-error 'missing' is not a news kind (the bell only knows aired and upcoming seasons).
/** @type {Reel.NewsItem['kind']} */ export const badKind = 'missing';

/* ---- 6. VR.Screen is exactly the set of screens src/ compares against ----
 * CLAUDE.md:223 "`S.screen` — `boot | login | home | library | detail | person | player |
 * pending | lookup`. Drives key dispatch and focus scoping."
 * Grep-driven (2026-10-03):
 *   grep -rhoE "S\.(screen|base) *[!=]==? *'[a-z]+'" src   → the 9 literals below, no others;
 *   grep -rhoE "S\.(screen|base) = '[a-z]+'" src          → a subset of them.
 * A new screen literal in src/ without a VR.Screen member is a type error at that comparison
 * ("This comparison appears to be unintentional"), so the two stay in step. */
/** @typedef {'boot' | 'login' | 'home' | 'library' | 'detail' | 'person' | 'player' | 'pending' | 'lookup'} GreppedScreens */
/** @type {TypeTest.Assert<TypeTest.Equal<VR.Screen, GreppedScreens>>} */
export const screensMatchGrep = true;
/** @type {TypeTest.Assert<TypeTest.Equal<typeof S.screen, VR.Screen>>} */
export const sScreenTyped = true;
/** @type {TypeTest.Assert<TypeTest.Equal<typeof S.base, VR.Screen>>} */
export const sBaseTyped = true;
// @ts-expect-error Search is an overlay (S.search), not a screen (CLAUDE.md: "Search is not a tab").
S.screen = 'search';
// @ts-expect-error music moved to VibeSpin on 2026-09-28; there is no music screen here.
S.base = 'music';
