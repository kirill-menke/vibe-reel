/* The desktop player's keyboard map and volume memory, kept free of Svelte
 * and of the engine so test/web can pin them (test/web/shortcuts.test.js).
 * WebPlayer.svelte decides what an action does in the current state (a seek
 * only while something plays, Shift+N only with a next episode, …); this file
 * only says which action a key means, and lists the keys for the "?" overlay.
 * Docs: docs/web/ARCHITECTURE.md → the shell → player/WebPlayer.svelte. */

export const SEEK_STEP = 10;
export const VOL_STEP = 0.05;
export const VOL_KEY = 'reel.web.volume';

/** @typedef {'close' | 'pause' | 'seek' | 'jump' | 'volume' | 'mute' | 'subs' | 'skip' | 'full' | 'pip' | 'next' | 'help'} PlayerAct */

/** The action a key press means, or null for a key the player leaves alone
 * (anything with Ctrl, ⌘ or Alt — browser and OS shortcuts stay theirs).
 *   seek    arg = seconds (±SEEK_STEP)
 *   jump    arg = fraction of the runtime (digit keys: 0 = start … 9 = 90 %)
 *   volume  arg = change (±VOL_STEP)
 * @param {{ key: string, shiftKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean }} e
 * @returns {{ act: PlayerAct, arg?: number } | null} */
export function keyAction(e) {
  if (!e || typeof e.key !== 'string' || e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  switch (k) {
    case 'Escape':
      return { act: 'close' };
    case ' ':
    case 'k':
      return { act: 'pause' };
    case 'ArrowLeft':
    case 'j':
      return { act: 'seek', arg: -SEEK_STEP };
    case 'ArrowRight':
    case 'l':
      return { act: 'seek', arg: SEEK_STEP };
    case 'ArrowUp':
      return { act: 'volume', arg: VOL_STEP };
    case 'ArrowDown':
      return { act: 'volume', arg: -VOL_STEP };
    case 'm':
      return { act: 'mute' };
    case 'c':
      return { act: 'subs' };
    case 's':
      return { act: 'skip' };
    case 'f':
      return { act: 'full' };
    case 'p':
      return { act: 'pip' };
    case 'n':
      return e.shiftKey ? { act: 'next' } : null;
    case '?':
      return { act: 'help' };
  }
  // digits: also typed with Shift on layouts such as AZERTY
  if (/^[0-9]$/.test(k)) return { act: 'jump', arg: Number(k) / 10 };
  return null;
}

/** The "?" overlay's rows: [alternative keys, what they do] — 'Shift+N' is one
 * combination. Keep in step with keyAction. */
/** @type {[string[], string][]} */
export const SHORTCUTS = [
  [['Space', 'K'], 'Play / pause'],
  [['←', 'J'], 'Back 10 s'],
  [['→', 'L'], 'Forward 10 s'],
  [['0–9'], 'Jump to 0 … 90 %'],
  [['↑', '↓'], 'Volume'],
  [['M'], 'Mute'],
  [['C'], 'Subtitles on / off'],
  [['S'], 'Skip intro / recap'],
  [['Shift+N'], 'Next episode'],
  [['F'], 'Full screen (or double-click)'],
  [['P'], 'Picture in Picture'],
  [['?'], 'This list'],
  [['Esc'], 'Close a panel, then the player']
];

/** @param {number} v */
export function clampVolume(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, Math.round(n * 100) / 100)) : 1;
}

/** The volume left from the last visit (0…1), or null for none / unreadable
 * storage (a private window or blocked site data can make the accessor throw). */
export function loadVolume() {
  try {
    const s = globalThis.localStorage.getItem(VOL_KEY);
    if (s == null || s === '') return null;
    const v = Number(s);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
  } catch {
    return null;
  }
}

/** @param {number} v */
export function saveVolume(v) {
  try {
    globalThis.localStorage.setItem(VOL_KEY, String(clampVolume(v)));
  } catch {}
}
