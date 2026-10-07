/* Type-only declaration for the vendored libpgs bundle (libpgs.js stays
 * byte-identical to upstream and is never type-checked itself).
 *
 * NOTE: the module as *built* does not export `PgsRenderer` — the lazy-libpgs
 * plugin (vite.config.js / phone/vite.config.js) rewrites the module body into
 * `loadPgs()`, which returns the PgsRenderer class on first call. These types
 * describe that built shape, which is what src/lib/player.svelte.js imports. */

export interface PgsRendererOptions {
  /** VibeReel always passes 'mainThread' (see attachPgs() in player.svelte.js). */
  mode?: 'mainThread' | 'worker' | 'workerWithoutOffscreenCanvas';
  video: HTMLVideoElement;
  canvas?: HTMLCanvasElement;
  subUrl?: string;
  workerUrl?: string;
  /** Seconds added to the video time before a subtitle is looked up. */
  timeOffset?: number;
  aspectRatio?: 'contain' | 'cover' | 'stretch';
}

export interface PgsRenderer {
  timeOffset: number;
  loadFromUrl(url: string): void;
  loadFromBuffer(buffer: ArrayBuffer): void;
  dispose(): void;
}

export interface PgsRendererConstructor {
  new (options: PgsRendererOptions): PgsRenderer;
}

/** Built by the lazy-libpgs Vite plugin: evaluates the vendored module body once. */
export function loadPgs(): PgsRendererConstructor;
