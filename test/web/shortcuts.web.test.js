/* The desktop player's keyboard map and volume memory (web/src/player/
 * shortcuts.js). WebPlayer.svelte asks keyAction() what a key means and
 * decides whether it applies right now; the "?" list renders SHORTCUTS, so
 * every key it names has to map to the action it describes. The volume left
 * from the last visit survives in localStorage, and unreadable storage (a
 * private window, blocked site data) falls back to full volume instead of
 * breaking the player. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { keyAction, SHORTCUTS, SEEK_STEP, VOL_STEP, VOL_KEY, clampVolume, loadVolume, saveVolume } from '../../web/src/player/shortcuts.js';

const k = (key, mods = {}) => keyAction({ key, ...mods });

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('keyAction', () => {
  it.each([
    [' ', 'pause'],
    ['k', 'pause'],
    ['K', 'pause'],
    ['Escape', 'close'],
    ['m', 'mute'],
    ['c', 'subs'],
    ['s', 'skip'],
    ['f', 'full'],
    ['F', 'full'],
    ['p', 'pip'],
    ['?', 'help']
  ])('%j → %s', (key, act) => {
    expect(k(key)).toEqual({ act });
  });

  it('seeks ∓SEEK_STEP on ← → and J L', () => {
    expect(SEEK_STEP).toBe(10);
    expect(k('ArrowLeft')).toEqual({ act: 'seek', arg: -SEEK_STEP });
    expect(k('j')).toEqual({ act: 'seek', arg: -SEEK_STEP });
    expect(k('ArrowRight')).toEqual({ act: 'seek', arg: SEEK_STEP });
    expect(k('L')).toEqual({ act: 'seek', arg: SEEK_STEP });
  });

  it('steps the volume on ↑ ↓', () => {
    expect(k('ArrowUp')).toEqual({ act: 'volume', arg: VOL_STEP });
    expect(k('ArrowDown')).toEqual({ act: 'volume', arg: -VOL_STEP });
  });

  it('jumps to a tenth of the runtime per digit, 0 = the start', () => {
    expect(k('0')).toEqual({ act: 'jump', arg: 0 });
    expect(k('5')).toEqual({ act: 'jump', arg: 0.5 });
    expect(k('9')).toEqual({ act: 'jump', arg: 0.9 });
    // AZERTY types digits with Shift: still a jump
    expect(k('3', { shiftKey: true })).toEqual({ act: 'jump', arg: 0.3 });
  });

  it('next episode only on Shift+N, never on a bare N', () => {
    expect(k('N', { shiftKey: true })).toEqual({ act: 'next' });
    expect(k('n')).toBeNull();
  });

  it('leaves browser and OS shortcuts alone (Ctrl, ⌘, Alt)', () => {
    expect(k('f', { ctrlKey: true })).toBeNull();
    expect(k('k', { metaKey: true })).toBeNull();
    expect(k('ArrowLeft', { altKey: true })).toBeNull();
    expect(k('1', { ctrlKey: true })).toBeNull();
  });

  it('ignores keys it has no use for', () => {
    for (const key of ['a', 'Enter', 'Tab', 'Home', 'End', 'F5', '-', 'Dead']) expect(k(key)).toBeNull();
    expect(keyAction(/** @type {any} */ ({}))).toBeNull();
  });
});

describe('SHORTCUTS (the "?" list)', () => {
  /* the list's key names → a KeyboardEvent-ish key */
  const KEY = { Space: ' ', Esc: 'Escape', '←': 'ArrowLeft', '→': 'ArrowRight', '↑': 'ArrowUp', '↓': 'ArrowDown' };
  /** @param {string} name */
  function press(name) {
    if (name === '0–9') return [k('0'), k('9')];
    const parts = name.split('+');
    const key = parts.at(-1);
    return [k(KEY[key] || key, { shiftKey: parts.includes('Shift') })];
  }

  it('names only keys the player answers', () => {
    for (const [keys, what] of SHORTCUTS) {
      for (const name of keys) {
        for (const a of press(name)) expect(a, name + ' (' + what + ')').not.toBeNull();
      }
    }
  });

  it('lists every action the map has', () => {
    const listed = new Set(SHORTCUTS.flatMap(([keys]) => keys.flatMap((n) => press(n).map((a) => a && a.act))));
    expect([...listed].sort()).toEqual(['close', 'full', 'help', 'jump', 'mute', 'next', 'pause', 'pip', 'seek', 'skip', 'subs', 'volume']);
  });

  it('alternatives on one row do the same thing', () => {
    for (const [keys] of SHORTCUTS) {
      const acts = new Set(keys.flatMap((n) => press(n).map((a) => a && a.act)));
      expect(acts.size).toBe(1);
    }
  });
});

describe('volume memory', () => {
  it('clamps to 0…1 in 1 % steps', () => {
    expect(clampVolume(1.3)).toBe(1);
    expect(clampVolume(-0.2)).toBe(0);
    expect(clampVolume(0.954)).toBe(0.95);
    expect(clampVolume(0.85 - 0.05)).toBe(0.8); // float noise of repeated steps
    expect(clampVolume(NaN)).toBe(1);
  });

  it('round-trips through localStorage', () => {
    expect(loadVolume()).toBeNull();
    saveVolume(0.35);
    expect(localStorage.getItem(VOL_KEY)).toBe('0.35');
    expect(loadVolume()).toBe(0.35);
    saveVolume(0);
    expect(loadVolume()).toBe(0); // muted by level is a level, not "none"
  });

  it('ignores a value out of range or not a number', () => {
    for (const bad of ['1.5', '-1', 'loud', '']) {
      localStorage.setItem(VOL_KEY, bad);
      expect(loadVolume()).toBeNull();
    }
  });

  it('survives storage that throws (private window, blocked site data)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(loadVolume()).toBeNull();
    expect(() => saveVolume(0.5)).not.toThrow();
  });
});
