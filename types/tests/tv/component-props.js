/* Type test (T10): the TV components' $props() JSDoc types. */
import LoadError from '../../../src/components/LoadError.svelte';
import TopNav from '../../../src/components/TopNav.svelte';
import Tile from '../../../src/components/Tile.svelte';
import LookupTile from '../../../src/components/LookupTile.svelte';
import Splash from '../../../src/components/Splash.svelte';

/** @template {import('svelte').Component<any>} C @typedef {import('svelte').ComponentProps<C>} Props */

/** LoadError: every prop is optional (Detail passes only error + retry; children = extra buttons). */
/** @type {Props<typeof LoadError>} */
export const loadError = { error: null, retry: () => Promise.resolve() };
/** TopNav: `children` (Library's sort/filter bar) is optional — Home renders it bare. */
/** @type {Props<typeof TopNav>} */
export const topNav = { active: 'home' };
/** App.svelte mounts `<Splash />` with no ondone. */
/** @type {Props<typeof Splash>} */
export const splash = {};

/** Tile's kind is the closed set its markup branches on (CLAUDE.md: Continue Watching / Next Up tiles play on OK). */
/** @type {TypeTest.Assert<TypeTest.Equal<NonNullable<Props<typeof Tile>['kind']>, 'cw' | 'nextup' | 'added'>>} */
export const tileKinds = true;
/** @type {Props<typeof Tile>} */
// @ts-expect-error 'resume' is not a Tile kind (it is 'cw').
export const badKind = { item: { Id: 'x' }, kind: 'resume' };

/** LookupTile takes trending / chart results with their extra rating fields. */
/** @type {Props<typeof LookupTile>} */
export const trendingTile = {
  item: { id: '1', type: 'movie', title: 'T', year: 2026, overview: '', poster: null, added: false, rating: 8.1, rating_votes: 12000, digital_release: null },
  onopen: () => {}
};
/** @type {Props<typeof LookupTile>} */
// @ts-expect-error onopen is required: OK on a tile must open something.
export const noOpen = { item: trendingTile.item };
