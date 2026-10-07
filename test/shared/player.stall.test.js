/* player.svelte.js — the stall watchdog (startStallWatch / stallFail).
 *
 * CLAUDE.md, "Stall watchdog": the TV's pipeline often fires no 'waiting' at
 * all (an iptables DROP of the NAS froze currentTime silently), so every 500 ms
 * a currentTime unchanged for 2 s raises the ring, 30 s becomes the "Playback
 * stalled" card with Retry from the last position, and a loading card up 60 s is
 * "The video never started". It stands down while paused, hidden, in a seek
 * window and between Up Next episodes; 'playing' restarts its clock. The card
 * needs 30 s with neither currentTime nor the buffered end moving, and a range
 * ending ≤ 30 s behind the playhead counts as progress (the refill after a
 * resume). Pending streams legitimately stall: they never get the card.
 *
 * Timing: the watchdog's interval is armed when the src is set (time 0 of the
 * fake clock) and ticks every 500 ms. `baseline(h)` runs the first tick, which
 * records the playhead (movedAt = 500); from there "still" grows 500 ms a tick. */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, episode, source, video, audio } from '../helpers/media.js';

const PHONE = __PHONE__;

async function baseline(h) {
  await h.clock.tick(500);
  expect(h.P.spinner).toBe(false);
}

/** grow the buffered end by `perTick` media seconds every 500 ms for `ms` */
async function growBuffer(h, ms, perTick, { from = 0, start } = {}) {
  let end = start ?? h.video.currentTime + 5;
  for (let t = 0; t < ms; t += 500) {
    end += perTick;
    h.video.setBuffered([[from, end]]);
    await h.clock.tick(500);
  }
  return end;
}

function hide(hidden) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

afterEach(() => {
  delete document.hidden;
});

describe('stall watchdog: the ring', () => {
  beforeAll(warmPlayer, 120000);

  it('a playhead unchanged for 2 s raises the ring with no waiting event; 1.5 s does not', async () => {
    const h = await startPlayer();
    await baseline(h);
    await h.clock.tick(1500);
    expect(h.P.spinner).toBe(false);
    await h.clock.tick(500);
    expect(h.P.spinner).toBe(true);
    expect(h.P.error).toBe(null);
  });

  it('movement clears the ring even when no playing event arrives', async () => {
    const h = await startPlayer();
    await baseline(h);
    await h.clock.tick(2500);
    expect(h.P.spinner).toBe(true);
    h.video.advance(0.4);   // timeupdate only, no 'playing'
    await h.clock.tick(500);
    expect(h.P.spinner).toBe(false);
    // and the clock starts over from that movement
    await h.clock.tick(1500);
    expect(h.P.spinner).toBe(false);
    await h.clock.tick(500);
    expect(h.P.spinner).toBe(true);
  });

  it("'playing' restarts the still-clock: the ring comes 2 s after it, not 2 s after the last movement", async () => {
    const h = await startPlayer();
    await baseline(h);
    await h.clock.tick(1000);   // still 1 s
    h.video.emit('playing');   // after a seek this TV fires 'playing' ~0.5 s before currentTime moves
    await h.clock.tick(1500);   // 2.5 s since the last movement, 1.5 s since 'playing'
    expect(h.P.spinner).toBe(false);
    await h.clock.tick(500);
    expect(h.P.spinner).toBe(true);
  });

  it('stands down while paused, and pausing takes down a watchdog ring', async () => {
    const h = await startPlayer();
    await baseline(h);
    await h.clock.tick(2000);
    expect(h.P.spinner).toBe(true);
    h.video.pause();
    await h.clock.tick(500);
    expect(h.P.spinner).toBe(false);
    await h.clock.tick(60000);
    expect(h.P.spinner).toBe(false);
    expect(h.P.error).toBe(null);
  });

  it('stands down while the page is hidden', async () => {
    const h = await startPlayer();
    await baseline(h);
    hide(true);
    await h.clock.tick(40000);
    expect(h.P.spinner).toBe(false);
    expect(h.P.error).toBe(null);
    hide(false);
    // the still-clock restarts from the last hidden tick
    await h.clock.tick(1500);
    expect(h.P.spinner).toBe(false);
    await h.clock.tick(500);
    expect(h.P.spinner).toBe(true);
  });

  it('stands down in the seek window (seekTarget): the ring needs 2 s of stillness after it', async () => {
    const h = await startPlayer();
    await baseline(h);
    await h.clock.tick(1500);   // still 1.5 s
    h.player.seekTo(600);   // seekTarget held ~900 ms; currentTime frozen at 600 from now on
    await h.clock.tick(500);   // a tick inside the window: resets the still-clock
    expect(h.P.spinner).toBe(false);
    await h.clock.tick(1500);   // 2 s after the seek, 1.5 s after the in-window tick
    expect(h.P.spinner).toBe(false);
    await h.clock.tick(500);
    expect(h.P.spinner).toBe(true);
  });

  // The window itself resets the clock, not the jump it usually comes with: a seek
  // that leaves currentTime where it was (re-seeking the spot the picture froze on)
  // still restarts the 2 s. (Final audit: mutant 988, seekTarget != null → false.)
  it('a seek that leaves currentTime unchanged still restarts the still-clock', async () => {
    const h = await startPlayer();
    h.video.advance(100);
    await baseline(h);
    await h.clock.tick(1500);   // still 1.5 s at 100
    h.player.seekTo(100);   // same spot: currentTime does not change
    await h.clock.tick(500);   // a tick inside the window
    expect(h.P.spinner).toBe(false);
    await h.clock.tick(1500);
    expect(h.P.spinner).toBe(false);
    await h.clock.tick(500);
    expect(h.P.spinner).toBe(true);
  });

  // Only a pause takes a ring down from the stand-down branch: a hidden page or a
  // pending seek leave a watchdog ring up (movement clears it), and a 'waiting'
  // ring is the pipeline's own — a pause leaves that one alone too.
  it('a hidden page keeps a watchdog ring up; only a pause takes it down', async () => {
    const h = await startPlayer();
    await baseline(h);
    await h.clock.tick(2000);
    expect(h.P.spinner).toBe(true);
    hide(true);
    await h.clock.tick(500);
    expect(h.P.spinner).toBe(true);
    hide(false);
  });

  it("a pause leaves a 'waiting' ring (not the watchdog's) up", async () => {
    const h = await startPlayer();
    await baseline(h);
    h.video.emit('waiting');
    expect(h.P.spinner).toBe(true);
    h.video.pause();
    await h.clock.tick(500);
    expect(h.P.spinner).toBe(true);
  });

  it('stands down off the player screen', async () => {
    const h = await startPlayer();
    await baseline(h);
    h.S.screen = 'detail';
    await h.clock.tick(40000);
    expect(h.P.spinner).toBe(false);
    expect(h.P.error).toBe(null);
  });
});

describe('stall watchdog: the "Playback stalled" card', () => {
  beforeAll(warmPlayer, 120000);

  it('a dead link (playhead and buffered end frozen) cards at 30 s, not before; the video is paused under it', async () => {
    const h = await startPlayer();
    h.video.advance(42);   // lastPos (Retry's position) = 42
    await baseline(h);
    await h.clock.tick(29500);   // still 29.5 s
    expect(h.P.error).toBe(null);
    expect(h.P.spinner).toBe(true);
    await h.clock.tick(500);   // still 30 s
    expect(h.P.error).toMatchObject({ title: 'Playback stalled' });
    expect(h.P.error.detail).toContain('No video has arrived from the server for 30 s');
    expect(h.P.error.detail).toContain('Retry from 0:42');
    expect(h.P.spinner).toBe(false);
    // stallFail: a late-recovering pipeline must not play on under the card
    expect(h.video.paused).toBe(true);
    expect(h.video.calls.at(-1)).toEqual(['pause']);
  });

  it('after the card the watchdog is off: no second card, no ring', async () => {
    const h = await startPlayer();
    await baseline(h);
    await h.clock.tick(30000);
    const err = h.P.error;
    expect(err.title).toBe('Playback stalled');
    await h.clock.tick(60000);
    expect(h.P.error).toBe(err);
    expect(h.P.spinner).toBe(false);
  });

  it('a slow link still delivering (buffered end growing) keeps the ring and never cards', async () => {
    const h = await startPlayer();
    await baseline(h);
    const end = await growBuffer(h, 60000, 0.1);   // 0.2 media-s per wall-s, playhead frozen
    expect(h.P.spinner).toBe(true);
    expect(h.P.error).toBe(null);
    // the download stops too: now it is a dead link, 30 s later
    h.video.setBuffered([[0, end]]);
    await h.clock.tick(29500);
    expect(h.P.error).toBe(null);
    await h.clock.tick(500);
    expect(h.P.error).toMatchObject({ title: 'Playback stalled' });
    // the card counts the 30 s nothing arrived, not the playhead's 90 s (V-F9)
    expect(h.P.error.detail).toMatch(/ for 30 s\./);
  });

  it('a playhead that played out a frozen buffer first: the card counts only the 30 s both stood still (V-F9)', async () => {
    const h = await startPlayer();
    h.video.setBuffered([[0, 100]]);   // a full buffer the download has stopped topping up
    await baseline(h);
    for (let i = 0; i < 80; i++) {     // 40 s of normal playback out of it
      h.video.advance(0.5);
      await h.clock.tick(500);
    }
    expect(h.P.error).toBe(null);
    await h.clock.tick(30000);         // then the playhead freezes too
    expect(h.P.error).toMatchObject({ title: 'Playback stalled' });
    expect(h.P.error.detail).toMatch(/ for 30 s\./);
  });

  it('buffered growth under 0.05 s a tick does not count as download progress', async () => {
    const h = await startPlayer();
    await baseline(h);
    await growBuffer(h, 30000, 0.04);
    expect(h.P.error).toMatchObject({ title: 'Playback stalled' });
  });

  it('a range ending up to 30 s BEHIND the playhead counts as progress (the refill after a resume)', async () => {
    const h = await startPlayer();
    h.video.setTime(659);
    await baseline(h);
    // buffered 0–630 … growing, playhead at 659: 29 s behind and moving
    await growBuffer(h, 45000, 0.2, { start: 630 });
    expect(h.P.error).toBe(null);
    expect(h.P.spinner).toBe(true);
  });

  it('a range ending more than 30 s behind the playhead is not progress', async () => {
    const h = await startPlayer();
    h.video.setTime(700);
    await baseline(h);
    await growBuffer(h, 30000, 0.2, { start: 600 });   // ends 600…612, > 30 s behind 700
    expect(h.P.error).toMatchObject({ title: 'Playback stalled' });
  });

  // the 30 s tolerance at both edges: 25–30 s behind is still progress, 30–35 s is not
  it('a range ending 25–30 s behind the playhead for the whole stall is progress (no card)', async () => {
    const h = await startPlayer();
    h.video.setTime(659);
    await baseline(h);
    const end = await growBuffer(h, 35000, 0.06, { start: 629.1 });   // ends 629.16 … 633.3
    expect(end).toBeLessThan(634);
    expect(h.P.error).toBe(null);
    expect(h.P.spinner).toBe(true);
  });

  it('a range ending 30–35 s behind the playhead is not progress (card at 30 s)', async () => {
    const h = await startPlayer();
    h.video.setTime(659);
    await baseline(h);
    const end = await growBuffer(h, 35000, 0.06, { start: 624.5 });   // ends 624.56 … 628.7
    expect(end).toBeLessThan(629);
    expect(h.P.error).toMatchObject({ title: 'Playback stalled' });
  });

  it('a range starting ahead of the playhead (> 0.5 s) is not progress either', async () => {
    const h = await startPlayer();
    h.video.setTime(100);
    await baseline(h);
    await growBuffer(h, 30000, 0.2, { from: 101, start: 110 });
    expect(h.P.error).toMatchObject({ title: 'Playback stalled' });
  });

  // A seek lands in another range: its end minus the old range's end is a jump,
  // not download progress (lastBuf reset in the window). Counted, it would push
  // the dead-link card half a second further out — and a seek forward into an
  // unfilled stretch is exactly when the link may be dead.
  it('a seek forward into a frozen range cards 30 s after the seek window, the jump not counted as download', async () => {
    const h = await startPlayer();
    h.video.setBuffered([[0, 20]]);
    await baseline(h);   // lastBuf = 20 at t = 500
    h.player.seekTo(600);   // window until 1400; the in-window tick at 1000 resets both clocks
    h.video.setBuffered([[600, 610]]);   // the new range never grows
    await h.clock.tick(30000);   // t = 30500: 29.5 s since the window tick
    expect(h.P.error).toBe(null);
    await h.clock.tick(500);   // t = 31000
    expect(h.P.error).toMatchObject({ title: 'Playback stalled' });
  });

  it('Retry from the stall card resumes at the last good position', async () => {
    const h = await startPlayer();
    h.video.advance(42);
    await baseline(h);
    await h.clock.tick(30000);
    expect(h.P.error.title).toBe('Playback stalled');
    const before = h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST').length;
    h.player.retryPlayback();
    await h.settle();
    expect(h.P.error).toBe(null);
    expect(h.P.loadingFrom).toBe(42);
    const pis = h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST');
    expect(pis).toHaveLength(before + 1);
    if (!PHONE) expect(pis.at(-1).body.StartTimeTicks).toBe(42 * 10000000);
  });
});

describe('stall watchdog: "The video never started"', () => {
  beforeAll(warmPlayer, 120000);

  it('a loading card up 60 s (no first frame) becomes the card; 60 s exactly does not', async () => {
    const h = await startPlayer({ reach: 'metadata' });
    expect(h.P.loading).toBe(true);
    await h.clock.tick(60000);
    expect(h.P.error).toBe(null);
    await h.clock.tick(500);
    expect(h.P.error).toMatchObject({ title: 'The video never started' });
    expect(h.P.error.detail).toContain(PHONE ? 'Check that the iPhone can reach it' : 'Check that the TV can reach it');
    expect(h.P.loading).toBe(false);
    expect(h.video.paused).toBe(true);
  });

  it('the ring never raises over the loading card, however long it is still', async () => {
    const h = await startPlayer({ reach: 'metadata' });
    h.P.spinner = false;
    await h.clock.tick(30000);
    expect(h.P.spinner).toBe(false);
    expect(h.P.error).toBe(null);
  });

  it('a pending stream may wait on its loading card for good', async () => {
    const h = await startPlayer({ reach: 'src' });
    const src = source([video(), audio()], { Bitrate: 30000000 });
    h.player.playPendingStream({ url: 'http://ml.test/api/downloads/abc/stream', item: { Name: 'Pending film', Type: 'Movie' }, source: src, downloadId: 'abc' });
    await h.settle();
    expect(h.P.pending).toBe(true);
    expect(h.P.loading).toBe(true);
    await h.clock.tick(120000);
    expect(h.P.error).toBe(null);
  });

  it('not between Up Next episodes: a slow next-episode fetch over 60 s raises no card', async () => {
    const next = episode({ IndexNumber: 2 });
    const ep = episode();
    const h = await startPlayer({
      item: ep,
      next,
      routes: (net) => net.on('GET', '/Items/' + next.Id, () => new Promise(() => {}))   // never answers
    });
    await h.settle();
    expect(h.P.next && h.P.next.Id).toBe(next.Id);
    h.player.playNext(true);
    expect(h.P.loading).toBe(true);
    await h.clock.tick(90000);
    expect(h.P.error).toBe(null);
    expect(h.P.loading).toBe(true);
  });

  it('measured from when THIS loading card went up, not from arming', async () => {
    // A film plays for 5 min, then a Retry-free re-raise of the loading card
    // (an Up Next roll does this on the old watch) must not fire at once.
    const h = await startPlayer();
    await baseline(h);
    for (let i = 0; i < 10; i++) {
      h.video.advance(30);
      await h.clock.tick(30000);
    }
    h.P.loading = true;
    await h.clock.tick(500);   // the first tick that sees the card: its clock starts here
    expect(h.P.error).toBe(null);
    await h.clock.tick(60000);
    expect(h.P.error).toBe(null);
    await h.clock.tick(500);
    expect(h.P.error).toMatchObject({ title: 'The video never started' });
  });
});

describe('stall watchdog: pending streams', () => {
  beforeAll(warmPlayer, 120000);

  async function pendingPlaying() {
    const h = await startPlayer({ reach: 'src' });
    const src = source([video(), audio()], { Bitrate: 30000000, RunTimeTicks: 7200 * 10000000 });
    h.player.playPendingStream({ url: 'http://ml.test/api/downloads/abc/stream', item: movie({ Name: 'Pending film', MediaSources: [src] }), source: src, downloadId: 'abc' });
    await h.settle();
    h.video.setDuration(7200);
    h.video.emit('loadedmetadata');
    await h.settle();
    h.video.emit('playing');
    await h.settle();
    expect(h.P.loading).toBe(false);
    return h;
  }

  it('waiting at the download frontier raises the ring but never the stall card', async () => {
    const h = await pendingPlaying();
    await baseline(h);
    await h.clock.tick(2000);
    expect(h.P.spinner).toBe(true);
    await h.clock.tick(120000);
    expect(h.P.error).toBe(null);
    expect(h.P.spinner).toBe(true);
    expect(h.video.paused).toBe(false);
  });

  it('and gets no slow-link hint (the limit there is the torrent)', async () => {
    const h = await pendingPlaying();
    await baseline(h);
    await growBuffer(h, 20000, 0.1);
    expect(h.P.spinner).toBe(true);
    expect(h.P.slowNet).toBe(null);
  });
});
