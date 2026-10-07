/* Type test (T25): the phone's persisted payloads (types/phone-state.d.ts) and the typed
 * exports of offline.svelte.js / homesnap.svelte.js / restore.svelte.js / push.js. */
import { entryOf, estimateBytes, artUrl, queueDownload } from '../../../phone/src/lib/offline.svelte.js';
import { seedHome } from '../../../phone/src/lib/homesnap.svelte.js';
import { onLibraryChange } from '../../../phone/src/lib/freshness.svelte.js';
import { setPush } from '../../../phone/src/lib/push.js';
import { confirm } from '../../../phone/src/lib/confirm.svelte.js';

/** An offline entry's state is the five-word lifecycle, nothing else. */
/** @type {TypeTest.Assert<TypeTest.Equal<VR.OfflineEntry['state'], 'queued' | 'downloading' | 'paused' | 'done' | 'error'>>} */
export const offlineStates = true;

/** entryOf() may find nothing. */
/** @type {TypeTest.Assert<TypeTest.Equal<ReturnType<typeof entryOf>, VR.OfflineEntry | null>>} */
export const entryOrNull = true;

/** Calls are only type-checked (this file is never run or bundled). */
export function calls() {
  /** A download's quality is a bitrate or 'original' (Settings' QUALITY_CAPS). */
  // @ts-expect-error a quality is a number or 'original', not a label.
  estimateBytes(/** @type {Jf.BaseItemDto} */ ({}), '8 Mbit/s');
  // @ts-expect-error same for queueDownload().
  queueDownload(/** @type {Jf.BaseItemDto} */ ({}), 'high');

  /** artUrl() parts are the three artwork files a download keeps. */
  // @ts-expect-error 'logo' is not one of poster / still / art.
  artUrl('id', ['logo']);
  // @ts-expect-error push kinds are 'ready' | 'seasons'.
  setPush('episodes', true);

  /** A library change names the kind of the last played item, or null. */
  onLibraryChange((c) => {
    /** @type {TypeTest.Assert<TypeTest.Equal<typeof c.type, Reel.MediaType | null>>} */
    const t = true;
    void t;
  });
}

/** The route snapshot (localStorage reel.route) keys stacks by tab. */
/** @type {VR.RouteSnapshot} */
export const snap = { v: 1, user: 'u', at: 0, tab: 'home', stacks: { home: { y0: 0, routes: [{ name: 'detail', params: { id: 'x' }, y: 0 }] } } };
/** @type {VR.RouteSnapshot} */
// @ts-expect-error 'library' is the TV's screen name, not a phone tab.
export const badTab = { v: 1, user: 'u', at: 0, tab: 'library', stacks: {} };

/** seedHome() hands back only the snapshot's Trending lists. */
/** @type {TypeTest.Assert<TypeTest.Equal<ReturnType<typeof seedHome>, { trend: VR.HomeTrend } | null>>} */
export const seeded = true;

/** confirm() resolves to a boolean. */
/** @type {TypeTest.Assert<TypeTest.Equal<ReturnType<typeof confirm>, Promise<boolean>>>} */
export const confirmBool = true;
