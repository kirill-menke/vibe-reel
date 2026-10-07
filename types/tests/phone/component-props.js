/* Type test (T20): the phone components' $props() JSDoc types (types/phone-ui.d.ts). */
import Row from '../../../phone/src/components/Row.svelte';
import Rail from '../../../phone/src/components/Rail.svelte';
import Tile from '../../../phone/src/components/Tile.svelte';
import Button from '../../../phone/src/components/Button.svelte';
import StateMessage from '../../../phone/src/components/StateMessage.svelte';
import EpisodeRow from '../../../phone/src/components/detail/EpisodeRow.svelte';
import StatusButton from '../../../phone/src/components/detail/StatusButton.svelte';

/** @template {import('svelte').Component<any>} C @typedef {import('svelte').ComponentProps<C>} Props */

/** Snippet props are optional: every `{@render x?.()}` / `{#if x}` in the markup guards them. */
/** @type {Props<typeof Rail>} */
export const bareRail = { title: 'Trending' };
/** @type {Props<typeof StateMessage>} */
export const bareState = { icon: 'search', title: 'Nothing found' };
/** Row forwards aria-* / data-* / role through `...rest` onto its element. */
/** @type {Props<typeof Row>} */
export const ariaRow = { title: 'Audio', 'aria-checked': true, role: 'menuitemradio' };

/** @type {TypeTest.Assert<TypeTest.Equal<NonNullable<Props<typeof Tile>['variant']>, 'poster' | 'landscape'>>} */
export const tileVariants = true;
/** @type {Props<typeof Tile>} */
// @ts-expect-error a Tile badge kind is '' | 'gold' | 'outline' only.
export const badBadge = { badge: { text: 'New', kind: 'red' } };
/** The quick-add state is lookup.svelte.js's AddState, not any string. */
/** @type {Props<typeof Tile>} */
// @ts-expect-error 'busy' is not an AddState.
export const badAddState = { addState: 'busy' };

/** @type {Props<typeof Button>} */
// @ts-expect-error 'secondary' is not a Button variant.
export const badVariant = { variant: 'secondary' };

/** EpisodeRow calls onclick() with no event (also from Enter / Space). */
/** @type {Props<typeof EpisodeRow>} */
export const epRow = { num: 'E4', onclick: () => {} };

/** StatusButton cannot render without the statusParts() result. */
/** @type {Props<typeof StatusButton>} */
// @ts-expect-error `s` is required.
export const noStatus = { prefix: 'Downloading · ' };
