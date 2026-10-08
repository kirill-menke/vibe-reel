/* trailer.js in the desktop web build (`__PHONE__ && __WEB__`).
 *
 * The desktop player keeps a failed trailer on its own error card (with an
 * "Open on YouTube" link — player-engine.web.test.js), so openTrailer's
 * fallback is only a safety net there; but should it run: one fixed sentence
 * (the raw yt-dlp error, 8 lines with URLs, goes to the console), and a YouTube
 * tab the browser blocked is a "no" — never `location.href`, which replaced
 * the whole web app with YouTube. player.svelte.js is stubbed (vi.doMock). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { freshImport } from '../helpers/modules.js';
import { flushPromises } from '../helpers/time.js';

const PLAYER = path.resolve(import.meta.dirname, '../../src/lib/player.svelte.js');
const ID = 'tGpTpVyI_OQ';

let m, stub;

beforeEach(async () => {
  stub = { playTrailerStream: vi.fn() };
  vi.doMock(PLAYER, () => stub);
  m = await freshImport({ modules: { tr: 'src/lib/trailer.js', toast: 'src/lib/toast.svelte.js' } });
});

afterEach(() => {
  vi.doUnmock(PLAYER);
});

describe('openTrailer’s fallback on the desktop', () => {
  it('a fixed sentence, the raw error in the console, then the YouTube tab', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const open = vi.spyOn(window, 'open').mockReturnValue(/** @type {any} */ ({}));
    m.tr.openTrailer(ID, {});
    const err = new Error("yt-dlp: ERROR: [youtube] tGpTpVyI_OQ: Sign in to confirm you're not a bot. See https://github.com/yt-dlp/yt-dlp/wiki/FAQ");
    stub.playTrailerStream.mock.calls[0][0].onFail(err);
    expect(m.toast.toastState.msg).toBe('This trailer can’t play here — opening it on YouTube');
    expect(warn).toHaveBeenCalledWith('Trailer failed:', err);
    await flushPromises();
    expect(open).toHaveBeenCalledWith('https://www.youtube.com/watch?v=' + ID, '_blank');
    expect(m.toast.toastState.msg).toBe('This trailer can’t play here — opening it on YouTube');
  });

  it('a blocked tab says so, and the app stays where it is', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(window, 'open').mockReturnValue(null);
    const before = location.href;
    m.tr.openTrailer(ID, {});
    stub.playTrailerStream.mock.calls[0][0].onFail(new Error('x'));
    await flushPromises();
    expect(m.toast.toastState.msg).toBe('Your browser blocked the YouTube tab');
    expect(location.href).toBe(before);
  });
});

describe('playTrailer on the desktop', () => {
  it('opens the watch page in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(/** @type {any} */ ({}));
    expect(await m.tr.playTrailer(ID)).toBe(true);
    expect(open).toHaveBeenCalledWith('https://www.youtube.com/watch?v=' + ID, '_blank');
  });

  it('a blocked (or throwing) popup is false — never a navigation of the app itself', async () => {
    const before = location.href;
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(await m.tr.playTrailer(ID)).toBe(false);
    vi.spyOn(window, 'open').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(await m.tr.playTrailer(ID)).toBe(false);
    expect(location.href).toBe(before);
  });
});
