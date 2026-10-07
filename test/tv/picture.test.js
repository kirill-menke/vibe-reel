/* player.svelte.js — picture-mode control through the TV's companion service
 * (svcGetModes / svcSetPicture / setPictureMode / loadPictureModes /
 * prettyMode / rangeLabel). TV only: the phone build rejects both service
 * calls without a request (test/phone/player.phone-branches.test.js).
 *
 * CLAUDE.md, "Companion service": the app fetches http://127.0.0.1:8791
 * (/modes, /picture?mode=). "Everything has a deadline … the picture service
 * 6 s (a wedged call blocked every later mode change)." "On a timeout
 * setPictureMode() waits 4.5 s and re-reads /modes (not queued) and believes
 * the TV's `current` over the timeout. ⚠️ It has to treat AbortError as the
 * timeout" — Chromium 120 rejects a timed-out fetch with AbortError, not
 * TimeoutError. Picture modes are dimension-scoped (dolbyHdr* / hdr* / plain).
 *
 * The service is never contacted: the mock fetch answers the loopback URLs. */
import { describe, it, expect, beforeAll } from 'vitest';
import { freshImport } from '../helpers/modules.js';
import { warmPlayer } from '../helpers/player.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock } from '../helpers/time.js';

const SVC = 'http://127.0.0.1:8791';
const MODES = SVC + '/modes';
const HEALTH = SVC + '/health';
const pictureUrl = (m) => SVC + '/picture?mode=' + encodeURIComponent(m);

async function load() {
  const mods = await freshImport({ modules: { player: 'src/lib/player.svelte.js', toast: 'src/lib/toast.svelte.js' } });
  const clock = useClock();
  const net = mockFetch();
  const { player, toast } = mods;
  return { player, P: player.P, toast: toast.toastState, clock, net };
}

/** a fetch that never answers until its deadline aborts it — rejecting with `name` (Chromium 120: AbortError) */
function timesOut(name) {
  return (req) =>
    new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new DOMException('aborted', name)), { once: true }));
}

describe('picture modes: labels', () => {
  it('prettyMode drops the dynamic-range prefix and labels the base mode', async () => {
    const { player } = await load();
    expect(player.prettyMode('dolbyHdrCinema')).toBe('Cinema');
    expect(player.prettyMode('hdrFilmMaker')).toBe('Filmmaker');
    expect(player.prettyMode('expert1')).toBe('Expert (Dark)');
    expect(player.prettyMode('dolbyHdrCinemaBright')).toBe('Cinema (bright)');
    expect(player.prettyMode('normal')).toBe('Standard');
    expect(player.prettyMode('hdrSomethingNew')).toBe('Something New');   // unknown: camelCase split
    expect(player.prettyMode('')).toBe('—');
    expect(player.prettyMode(null)).toBe('—');
  });

  it('rangeLabel names the signal by the mode prefix', async () => {
    const { player } = await load();
    expect(player.rangeLabel('dolbyHdrCinema')).toBe('Dolby Vision');
    expect(player.rangeLabel('hdrStandard')).toBe('HDR');
    expect(player.rangeLabel('cinema')).toBe('SDR');
    expect(player.rangeLabel(undefined)).toBe('SDR');
  });
});

describe('probePictureService (the Picture button exists only on a rooted TV)', () => {
  beforeAll(warmPlayer, 120000);

  it('a /health answer turns the button on for the session: no second probe', async () => {
    const h = await load();
    expect(h.P.picSvc).toBe(null);
    h.net.on('GET', HEALTH, { ok: true, name: 'com.webos.app.multiviewsettings-reel' });
    await h.player.probePictureService();
    expect(h.P.picSvc).toBe(true);
    expect(h.clock.timeouts).toEqual([6000]);
    await h.player.probePictureService();
    expect(h.net.callsTo(HEALTH)).toHaveLength(1);
  });

  it('stock firmware (nothing on 8791) keeps it off, and the next playback asks again', async () => {
    const h = await load();
    h.net.on('GET', HEALTH, h.net.networkError());
    await h.player.probePictureService();
    expect(h.P.picSvc).toBe(false);
    h.net.on('GET', HEALTH, { ok: true });
    await h.player.probePictureService();
    expect(h.P.picSvc).toBe(true);
    expect(h.net.callsTo(HEALTH)).toHaveLength(2);
  });

  it('one probe at a time', async () => {
    const h = await load();
    h.net.on('GET', HEALTH, { ok: true });
    const a = h.player.probePictureService();
    const b = h.player.probePictureService();
    await Promise.all([a, b]);
    expect(h.net.callsTo(HEALTH)).toHaveLength(1);
  });
});

describe('loadPictureModes', () => {
  beforeAll(warmPlayer, 120000);

  it('GETs /modes with a 6 s deadline and fills the panel', async () => {
    const h = await load();
    h.net.on('GET', MODES, { modes: ['hdrCinema', 'hdrStandard'], current: 'hdrCinema' });
    const p = h.player.loadPictureModes();
    expect(h.P.picLoading).toBe(true);
    await p;
    expect(h.net.callsTo(MODES)).toHaveLength(1);
    expect(h.clock.timeouts).toEqual([6000]);
    expect(h.P).toMatchObject({ pictureModes: ['hdrCinema', 'hdrStandard'], pictureMode: 'hdrCinema', picErr: false, picLoading: false });
  });

  it('a dead service is the Retry row (picErr), not a list whose every pick fails', async () => {
    const h = await load();
    h.net.on('GET', MODES, h.net.networkError());
    await h.player.loadPictureModes();
    expect(h.P).toMatchObject({ pictureModes: [], picErr: true, picLoading: false });
    // a good answer clears it
    h.net.on('GET', MODES, { modes: ['cinema'], current: 'cinema' });
    await h.player.loadPictureModes();
    expect(h.P).toMatchObject({ pictureModes: ['cinema'], pictureMode: 'cinema', picErr: false });
  });

  it('a hung /modes ends at 6 s instead of loading forever', async () => {
    const h = await load();
    h.net.on('GET', MODES, h.net.hang());
    const p = h.player.loadPictureModes();
    await h.clock.tick(5999);
    expect(h.P.picLoading).toBe(true);
    await h.clock.tick(1);
    await p;
    expect(h.P).toMatchObject({ picErr: true, picLoading: false });
  });

  it('a slow answer from an earlier load never overwrites a newer one (picGen)', async () => {
    const h = await load();
    let first;
    h.net.once('GET', MODES, () => new Promise((res) => (first = () => res({ modes: ['old'], current: 'old' }))));
    const a = h.player.loadPictureModes();
    h.net.on('GET', MODES, { modes: ['hdrCinema'], current: 'hdrCinema' });
    await h.clock.flush();
    const b = h.player.loadPictureModes();
    await b;
    expect(h.P.pictureMode).toBe('hdrCinema');
    first();
    await a;
    expect(h.P).toMatchObject({ pictureModes: ['hdrCinema'], pictureMode: 'hdrCinema', picLoading: false });
  });

  it('an answer without a modes list is an empty list', async () => {
    const h = await load();
    h.net.on('GET', MODES, { returnValue: false, errorText: 'x' });
    await h.player.loadPictureModes();
    expect(h.P).toMatchObject({ pictureModes: [], pictureMode: null, picErr: false });
  });
});

describe('setPictureMode', () => {
  beforeAll(warmPlayer, 120000);

  it('the mark moves only once the service confirms; pending meanwhile', async () => {
    const h = await load();
    h.P.pictureMode = 'hdrStandard';
    let answer;
    h.net.on('GET', pictureUrl('hdrCinema'), () => new Promise((res) => (answer = () => res({ returnValue: true }))));
    h.player.setPictureMode('hdrCinema');
    expect(h.P.picPending).toBe('hdrCinema');
    expect(h.P.pictureMode).toBe('hdrStandard');
    await h.clock.flush();
    expect(h.clock.timeouts).toEqual([6000]);
    answer();
    await h.clock.flush();
    expect(h.P).toMatchObject({ pictureMode: 'hdrCinema', picPending: null });
    expect(h.toast.msg).toBe('Picture mode → Cinema');
  });

  it('the current mode, or a second pick while one is pending, sends nothing', async () => {
    const h = await load();
    h.P.pictureMode = 'cinema';
    h.net.on('GET', (r) => r.url.startsWith(SVC + '/picture'), () => new Promise(() => {}));
    h.player.setPictureMode('cinema');
    expect(h.net.calls).toHaveLength(0);
    h.player.setPictureMode('vivid');
    h.player.setPictureMode('standard');
    await h.clock.flush();
    expect(h.net.calls.map((c) => c.url)).toEqual([pictureUrl('vivid')]);
    expect(h.P.picPending).toBe('vivid');
  });

  it('a refused set keeps the old mark, says why, and re-reads the list when the panel is open', async () => {
    const h = await load();
    h.P.pictureMode = 'hdrStandard';
    h.P.panel = 'picture';
    h.net.on('GET', pictureUrl('hdrCinema'), { returnValue: false, errorText: 'No matched extended item' });
    h.net.on('GET', MODES, { modes: ['dolbyHdrCinema'], current: 'dolbyHdrCinema' });
    h.player.setPictureMode('hdrCinema');
    await h.clock.flush();
    expect(h.toast.msg).toBe('Couldn’t set picture mode: No matched extended item');
    expect(h.P.picPending).toBe(null);
    expect(h.net.callsTo(MODES)).toHaveLength(1);
    await h.clock.flush();
    expect(h.P.pictureModes).toEqual(['dolbyHdrCinema']);
  });

  it('a refused set with the panel closed does not re-read; no errorText → no colon', async () => {
    const h = await load();
    h.net.on('GET', pictureUrl('vivid'), { returnValue: false });
    h.player.setPictureMode('vivid');
    await h.clock.flush();
    expect(h.toast.msg).toBe('Couldn’t set picture mode');
    expect(h.net.callsTo(MODES)).toHaveLength(0);
  });

  it('a service that refuses the connection: "Picture control unavailable", no 4.5 s wait', async () => {
    const h = await load();
    h.net.on('GET', pictureUrl('vivid'), h.net.networkError());
    h.player.setPictureMode('vivid');
    await h.clock.flush();
    expect(h.toast.msg).toBe('Picture control unavailable');
    expect(h.P.picPending).toBe(null);
    await h.clock.tick(10000);
    expect(h.net.callsTo(MODES)).toHaveLength(0);
  });

  describe.each(['AbortError', 'TimeoutError'])('a set that times out (%s)', (name) => {
    it('waits 4.5 s, re-reads /modes and believes the TV when it reports the new mode', async () => {
      const h = await load();
      h.P.pictureMode = 'hdrStandard';
      h.net.on('GET', pictureUrl('hdrCinema'), timesOut(name));
      h.net.on('GET', MODES, { modes: ['hdrCinema', 'hdrStandard'], current: 'hdrCinema' });
      h.player.setPictureMode('hdrCinema');
      await h.clock.tick(6000);   // the deadline
      expect(h.P.picPending).toBe('hdrCinema');
      await h.clock.tick(4499);
      expect(h.net.callsTo(MODES)).toHaveLength(0);
      await h.clock.tick(1);
      expect(h.net.callsTo(MODES)).toHaveLength(1);
      expect(h.P).toMatchObject({ pictureMode: 'hdrCinema', picPending: null });
      expect(h.toast.msg).toBe('Picture mode → Cinema');
    });

    it('…and says it failed when the TV still reports another mode', async () => {
      const h = await load();
      h.P.pictureMode = 'hdrStandard';
      h.net.on('GET', pictureUrl('hdrCinema'), timesOut(name));
      h.net.on('GET', MODES, { modes: ['hdrCinema', 'hdrStandard'], current: 'hdrStandard' });
      h.player.setPictureMode('hdrCinema');
      await h.clock.tick(10500);
      expect(h.P).toMatchObject({ pictureMode: 'hdrStandard', picPending: null });
      expect(h.toast.msg).toBe('Couldn’t set picture mode');
    });
  });

  it('timed out and /modes dead too: the service is gone ("unavailable"), and the pick is free again', async () => {
    const h = await load();
    h.net.on('GET', pictureUrl('vivid'), timesOut('AbortError'));
    h.net.on('GET', MODES, h.net.hang());
    h.player.setPictureMode('vivid');
    await h.clock.tick(6000 + 4500 + 6000);
    expect(h.toast.msg).toBe('Picture control unavailable');
    expect(h.P.picPending).toBe(null);
  });
});
