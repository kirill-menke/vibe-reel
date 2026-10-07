/* Custom DOM attributes/events the templates use, added to Svelte's element typings.
 * (A module file — the `export {}` makes `declare module` an augmentation.) */
import 'svelte/elements';

declare module 'svelte/elements' {
  export interface HTMLAttributes<T> {
    /** Hold-OK gesture (TV): Keys.svelte dispatches `new CustomEvent('okhold')`
     * on an element with `data-hold` after a 500 ms OK hold. */
    onokhold?: ((event: CustomEvent<null> & { currentTarget: EventTarget & T }) => any) | undefined | null;
  }
  export interface HTMLVideoAttributes {
    /** Pre-iOS-10 spelling of `playsinline` (the phone player sets both). */
    'webkit-playsinline'?: boolean | undefined | null;
    /** Safari: enter PiP by itself when the page goes to the background (a Safari tab). */
    autopictureinpicture?: boolean | undefined | null;
    /** Safari: offer AirPlay for this element. */
    'x-webkit-airplay'?: 'allow' | 'deny' | undefined | null;
  }
  export interface HTMLInputAttributes {
    /** iOS Safari 17.4+ native switch control: `<input type="checkbox" switch>` (the phone's
     * Switch.svelte; not in Svelte's typings yet). */
    switch?: boolean | undefined | null;
  }
}

export {};
