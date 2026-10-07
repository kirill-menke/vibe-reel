/* player.svelte.js picture-mode control — the labels and the guards
 * test/tv/picture.test.js leaves open (lane r3-tv-unit, mutation-backed:
 * Stryker on player.svelte.js 1765–2079).
 *
 * CLAUDE.md, "Companion service": the panel lists the modes the service reports
 * for the live signal; prettyMode() drops the dynamic-range prefix and labels
 * the base mode (MODE_LABELS, else the camelCase split, capitalised). "A refused
 * or failed set means the list on screen may be stale … Re-ask it" — a set that
 * worked, directly or after the 4.5 s re-read, does not. picGen: "a slow /modes
 * answer from an earlier open (or a Retry pressed twice) must not overwrite a
 * newer one", nor end the newer one's "Loading…". TV only. */
import { describe, it, expect, beforeAll } from 'vitest';
import { freshImport } from '../helpers/modules.js';
import { warmPlayer } from '../helpers/player.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock } from '../helpers/time.js';

const SVC = 'http://127.0.0.1:8791';
const MODES = SVC + '/modes';
const pictureUrl = (m) => SVC + '/picture?mode=' + encodeURIComponent(m);

async function load() {
  const mods = await freshImport({ modules: { player: 'src/lib/player.svelte.js', toast: 'src/lib/toast.svelte.js' } });
  const clock = useClock();
  const net = mockFetch();
  return { player: mods.player, P: mods.player.P, toast: mods.toast.toastState, clock, net };
}

describe('prettyMode: every label of the table', () => {
  beforeAll(warmPlayer, 120000);

  it.each([
    ['filmMaker', 'Filmmaker'], ['cinema', 'Cinema'], ['hdrCinemaBright', 'Cinema (bright)'], ['normal', 'Standard'],
    ['dolbyHdrStandard', 'Standard'], ['vivid', 'Vivid'], ['eco', 'Eco'], ['sports', 'Sports'], ['game', 'Game'],
    ['photo', 'Photo'], ['personalized', 'Personalized'], ['expert1', 'Expert (Dark)'], ['hdrExpert2', 'Expert (Bright)']
  ])('%s → %s', async (mode, label) => {
    const { player } = await load();
    expect(player.prettyMode(mode)).toBe(label);
  });

  it('an unknown mode without a prefix: split at the capitals and capitalised', async () => {
    const { player } = await load();
    expect(player.prettyMode('aiPictureMode')).toBe('Ai Picture Mode');
  });
});

describe('after a set that worked, the list is not re-read', () => {
  beforeAll(warmPlayer, 120000);

  it('confirmed at once, with the panel open', async () => {
    const h = await load();
    h.P.panel = 'picture';
    h.net.on('GET', pictureUrl('vivid'), { returnValue: true });
    h.net.on('GET', MODES, { modes: ['vivid'], current: 'vivid' });
    h.player.setPictureMode('vivid');
    await h.clock.flush();
    expect(h.P.pictureMode).toBe('vivid');
    await h.clock.tick(100);
    expect(h.net.callsTo(MODES)).toHaveLength(0);
  });

  it('confirmed by the re-read after a timeout, with the panel open: that one read only', async () => {
    const h = await load();
    h.P.panel = 'picture';
    h.net.on('GET', pictureUrl('vivid'), (req) => new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(new DOMException('a', 'AbortError')), { once: true })));
    h.net.on('GET', MODES, { modes: ['vivid'], current: 'vivid' });
    h.player.setPictureMode('vivid');
    await h.clock.tick(6000 + 4500);
    await h.clock.flush();
    expect(h.P.pictureMode).toBe('vivid');
    await h.clock.tick(100);
    expect(h.net.callsTo(MODES)).toHaveLength(1);
  });
});

describe('loadPictureModes: a stale answer', () => {
  beforeAll(warmPlayer, 120000);

  it('an earlier load answering last does not overwrite the newer list', async () => {
    const h = await load();
    let first;
    h.net.once('GET', MODES, () => new Promise((res) => (first = res)));
    const a = h.player.loadPictureModes();
    await h.clock.flush();
    h.net.on('GET', MODES, { modes: ['new'], current: 'new' });
    await h.player.loadPictureModes();
    first({ modes: ['old'], current: 'old' });
    await a;
    expect(h.P.pictureModes).toEqual(['new']);
    expect(h.P.pictureMode).toBe('new');
  });

  it('an earlier load failing while a newer one is still loading leaves "Loading…" up and no error', async () => {
    const h = await load();
    let failFirst;
    let answerSecond;
    h.net.once('GET', MODES, () => new Promise((_, rej) => (failFirst = rej)));
    const a = h.player.loadPictureModes();
    await h.clock.flush();
    h.net.once('GET', MODES, () => new Promise((res) => (answerSecond = res)));
    const b = h.player.loadPictureModes();
    await h.clock.flush();
    failFirst(new TypeError('Failed to fetch'));
    await a;
    expect(h.P.picLoading).toBe(true);
    expect(h.P.picErr).toBe(false);
    answerSecond({ modes: ['x'], current: 'x' });
    await b;
    expect(h.P.picLoading).toBe(false);
  });
});
