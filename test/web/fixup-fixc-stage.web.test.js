/* The fix-up round's player pieces (fixc):
 *   - stageClicks (web/src/player/stage.js): a click pauses after the double
 *     click window; a slow double click puts back only the pause its own first
 *     click fired — a deliberate click, then a double click a moment later,
 *     keeps the deliberate pause (S3-7);
 *   - fullScreenStuck: the "Full screen didn't work" check holds at any page
 *     zoom — Chrome scales innerWidth with the zoom but not screen.* (S3-1);
 *   - chipName: the audio / subtitle chips are named by what they are plus
 *     the words they show (S2-8);
 *   - describeTracks: a trailer's untagged audio reads "Original audio"
 *     (S3-11). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stageClicks, fullScreenStuck, chipName } from '../../web/src/player/stage.js';
import { describeTracks } from '../../src/lib/tracks.js';

describe('stageClicks', () => {
  let paused, full, can, st;
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    paused = false;
    full = vi.fn();
    can = true;
    st = stageClicks({ pause: () => (paused = !paused), full, can: () => can });
  });
  afterEach(() => vi.useRealTimers());

  it('a single click pauses after the double-click window', () => {
    st.click(1);
    vi.advanceTimersByTime(249);
    expect(paused).toBe(false);
    vi.advanceTimersByTime(1);
    expect(paused).toBe(true);
  });

  it('a quick double click: full screen, nothing paused on the way', () => {
    st.click(1);
    vi.advanceTimersByTime(120);
    st.click(2);
    st.dbl();
    vi.advanceTimersByTime(1000);
    expect(paused).toBe(false);
    expect(full).toHaveBeenCalledTimes(1);
  });

  it('a slow double click puts back the pause its first click fired', () => {
    st.click(1);
    vi.advanceTimersByTime(300); // paused at 250
    expect(paused).toBe(true);
    st.click(2);
    st.dbl();
    expect(paused).toBe(false);
    expect(full).toHaveBeenCalledTimes(1);
  });

  it('a deliberate click, then a double click 350 ms later: the pause stays (S3-7)', () => {
    st.click(1);
    vi.advanceTimersByTime(250);
    expect(paused).toBe(true);
    vi.advanceTimersByTime(350); // the gap
    st.click(1); // a new sequence
    vi.advanceTimersByTime(100);
    st.click(2);
    st.dbl();
    vi.advanceTimersByTime(1000);
    expect(paused).toBe(true);
    expect(full).toHaveBeenCalledTimes(1);
  });

  it('…and the reverse: a click to play is not undone by the double click after it', () => {
    paused = true;
    st.click(1);
    vi.advanceTimersByTime(250);
    expect(paused).toBe(false);
    vi.advanceTimersByTime(200);
    st.click(1);
    st.click(2);
    st.dbl();
    expect(paused).toBe(false);
  });

  it('the undo only counts within 600 ms of the pause', () => {
    st.click(1);
    vi.advanceTimersByTime(250 + 600);
    st.dbl(); // a dblclick with no new first click (synthetic): too late to be this pause's
    expect(paused).toBe(true);
  });

  it('can() false: the pending pause is dropped and the double click does not toggle', () => {
    st.click(1);
    can = false;
    vi.advanceTimersByTime(300);
    expect(paused).toBe(false);
    can = true;
    st.click(1);
    vi.advanceTimersByTime(300);
    can = false;
    st.dbl();
    expect(paused).toBe(true);
    expect(full).toHaveBeenCalledTimes(1);
  });

  it('cancel() drops a pending pause', () => {
    st.click(1);
    st.cancel();
    vi.advanceTimersByTime(1000);
    expect(paused).toBe(false);
  });
});

describe('fullScreenStuck', () => {
  const scr = { width: 2560, height: 1600 };
  it('Chrome at 150 % zoom in a real full screen: not stuck (inner 1707×1067, outer 2560×1600)', () => {
    expect(fullScreenStuck({ w: 960, h: 542 }, { innerWidth: 1707, innerHeight: 1067, outerWidth: 2560, outerHeight: 1600 }, scr)).toBe(false);
  });
  it('Chrome at 125 %: not stuck', () => {
    expect(fullScreenStuck({ w: 1152, h: 650 }, { innerWidth: 2048, innerHeight: 1280, outerWidth: 2560, outerHeight: 1600 }, scr)).toBe(false);
  });
  it('a window that stayed 1440×900 (a window manager that ignored it): stuck, at any zoom', () => {
    expect(fullScreenStuck({ w: 1440, h: 813 }, { innerWidth: 1440, innerHeight: 813, outerWidth: 1440, outerHeight: 900 }, scr)).toBe(true);
    expect(fullScreenStuck({ w: 960, h: 542 }, { innerWidth: 960, innerHeight: 542, outerWidth: 1440, outerHeight: 900 }, scr)).toBe(true);
  });
  it('a window that grew but not to the screen is not called stuck (it did something)', () => {
    expect(fullScreenStuck({ w: 1440, h: 813 }, { innerWidth: 1440, innerHeight: 900, outerWidth: 1440, outerHeight: 900 }, scr)).toBe(false);
  });
  it('a window already screen-sized (kiosk / F11) that cannot grow: not stuck', () => {
    expect(fullScreenStuck({ w: 2560, h: 1600 }, { innerWidth: 2560, innerHeight: 1600, outerWidth: 2560, outerHeight: 1600 }, scr)).toBe(false);
  });
});

describe('chipName', () => {
  it('names the chip by what it is, keeping the words it shows in order', () => {
    expect(chipName('Subtitles', { main: 'English', dim: '' })).toBe('Subtitles: English');
    expect(chipName('Subtitles', { main: 'English', dim: 'Forced' })).toBe('Subtitles: English Forced');
    expect(chipName('Subtitles', { main: 'Subtitles', dim: 'Off' })).toBe('Subtitles: Off');
    expect(chipName('Audio', { main: 'English', dim: 'DD+ 5.1' })).toBe('Audio: English DD+ 5.1');
    expect(chipName('Audio', { main: 'Audio', dim: '' })).toBe('Audio');
  });
});

describe('a trailer’s audio track (describeTracks, web build)', () => {
  const trailer = (extra = {}) => ({
    Id: 'trailer',
    MediaStreams: [
      { Type: 'Video', Index: 0, Codec: 'vp9', Width: 3840, Height: 2160 },
      { Type: 'Audio', Index: 1, Codec: 'opus', IsDefault: true, ...extra }
    ]
  });
  it('untagged: "Original audio", not "Unknown"', () => {
    expect(describeTracks(/** @type {any} */ (trailer()), null).audio.map((a) => a.label)).toEqual(['Original audio · Opus']);
  });
  it('a tagged one keeps its language', () => {
    expect(describeTracks(/** @type {any} */ (trailer({ Language: 'eng' })), null).audio[0].label).toMatch(/^English/);
  });
  it('a Jellyfin file with an untagged track still says Unknown', () => {
    const src = { ...trailer(), Id: 'abc' };
    expect(describeTracks(/** @type {any} */ (src), null).audio[0].label).toMatch(/^Unknown/);
  });
});
