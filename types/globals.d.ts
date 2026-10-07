/// <reference types="vite/client" />
/* Ambient globals for the whole client (TV src/ and phone/src). Type-only:
 * nothing here reaches a bundle. Included by jsconfig.json and phone/jsconfig.json.
 * The reference above makes `import.meta.env` resolve even when a config outside the repo
 * extends ours (the ratchet's strict.* passes write theirs to the OS temp dir, where the
 * `types: ["vite/client"]` entry can't be found). */

/** Build-time constant: phone/vite.config.js defines it `true`, vite.config.js `'false'`.
 * Every phone branch in shared src/lib code sits behind it and is constant-folded
 * out of the TV app.js. */
declare const __PHONE__: boolean;

/** clearTimeout/clearInterval(null): the timer vars across the client start out `null`. WebIDL
 * converts the `optional long id = 0` argument, null → 0, which cancels nothing (HTML timers);
 * TypeScript's DOM lib only admits `number | undefined`. */
declare function clearTimeout(id: number | null | undefined): void;
declare function clearInterval(id: number | null | undefined): void;

/** Safari 17.1+ (iOS) Managed Media Source — the only MSE the iPhone has.
 * Not in TypeScript's DOM lib yet: MediaSource plus the UA's buffering hint (Media Source
 * Extensions 2, "ManagedMediaSource"). `streaming` false = "enough buffered for now" (after an
 * 'endstreaming' event); 'startstreaming' asks for more. trailerstream.js / segfeed.js wait on it. */
interface ManagedMediaSource extends MediaSource {
  readonly streaming: boolean;
  onstartstreaming: ((this: ManagedMediaSource, ev: Event) => any) | null;
  onendstreaming: ((this: ManagedMediaSource, ev: Event) => any) | null;
}
/** The ManagedMediaSource constructor (absent outside Safari 17.1+). */
interface ManagedMediaSourceConstructor {
  prototype: ManagedMediaSource;
  new (): ManagedMediaSource;
  isTypeSupported(type: string): boolean;
}
declare var ManagedMediaSource: ManagedMediaSourceConstructor | undefined;

/** HTMLMediaElement.audioTracks (HTML "AudioTrackList"): not in TypeScript's DOM lib because
 * desktop Chromium ships it behind a flag. The webOS Chromium 120 has it, and the TV's audio
 * switch depends on it (player.svelte.js applyAudioSelection(): `tracks[i].enabled`). Optional:
 * code must feature-test it. */
interface MediaAudioTrack {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly language: string;
  enabled: boolean;
}
interface MediaAudioTrackList extends EventTarget {
  readonly length: number;
  [index: number]: MediaAudioTrack;
  getTrackById(id: string): MediaAudioTrack | null;
}
interface HTMLMediaElement {
  readonly audioTracks?: MediaAudioTrackList;
}

/** iOS Safari: true when running as a home-screen web app (no PiP there — phone Player.svelte,
 * lifecycle.js, push.js, viewport.js). Undefined elsewhere. */
interface Navigator {
  readonly standalone?: boolean;
}

/** WebKit's prefixed video presentation / AirPlay API (iOS Safari; the phone player's PiP and
 * AirPlay buttons and lifecycle.js's "still watching" check). Feature-tested before use. */
interface HTMLVideoElement {
  readonly webkitPresentationMode?: 'inline' | 'picture-in-picture' | 'fullscreen';
  webkitSetPresentationMode?(mode: 'inline' | 'picture-in-picture' | 'fullscreen'): void;
  webkitSupportsPresentationMode?(mode: 'inline' | 'picture-in-picture' | 'fullscreen'): boolean;
  readonly webkitCurrentPlaybackTargetIsWireless?: boolean;
  webkitShowPlaybackTargetPicker?(): void;
}

interface Window {
  ManagedMediaSource?: ManagedMediaSourceConstructor;
  /** WebKit's AirPlay availability event constructor: present only where AirPlay exists. */
  WebKitPlaybackTargetAvailabilityEvent?: { prototype: Event };
  /** Phone dev handle (freshness.svelte.js, DEV builds only). */
  __freshness?: { check: () => Promise<void>; state: () => { sig: VR.FreshnessSig | null; lastCheck: number; period: number } };
  /** Phone debug handle (router.svelte.js): the router from the console / CDP. The functions
   * are only `Function` so the TV project doesn't pull the phone router in. */
  __router?: {
    R: VR.RouterState;
    S: VR.PhoneNavState;
    push: Function;
    pop: Function;
    replace: Function;
    switchTab: Function;
    openSheet: Function;
    closeSheet: Function;
  };
}
