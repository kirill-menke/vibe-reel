/* player.svelte.js — the Skip chip (skipVisible / skipSegment / skipTo, the
 * auto-skip in ontimeupdate, and lookUpMarkers' merge of Jellyfin + IntroDB).
 *
 * CLAUDE.md, "Skip Intro" / "Skip Recap / Preview": every window derives from
 * the playhead; the first by start wins where two overlap; the chip retires a
 * second before its window ends and yields to an open panel and to the Up Next
 * card. A skip lands a few seconds short (the TV decodes from the keyframe
 * before the target), so the skipped window keeps its chip down (P.skipped)
 * until the next seek of any other kind — the intro chip used to flash back
 * for ~2.5 s after every skip. Settings → Skip recaps automatically also takes
 * previews; each kind auto-skips once per item. IntroDB only fills kinds that
 * Jellyfin (segments + named chapters) left empty, and recaps never come from
 * Jellyfin's Recap segments. */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { episode, movie, segment, chapters, playbackInfo } from '../helpers/media.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** the playhead reaches t by playing (no seek): timeupdate at t */
function at(h, t) {
  h.video.setTime(t);
  h.video.emit('timeupdate');
}

/** the toast module of the same fresh graph startPlayer() imported */
async function toastOf() {
  return (await import(/* @vite-ignore */ path.resolve(ROOT, 'src/lib/toast.svelte.js'))).toastState;
}

async function play(o = {}) {
  const h = await startPlayer({ item: o.item || episode(), segments: o.segments || [], chapters: o.chapters, next: o.next, seriesItem: o.seriesItem, introdb: o.introdb, routes: o.routes });
  await h.settle();
  return h;
}

/** past the 900 ms post-seek window, where effectivePos() reads the target */
async function settleSeek(h) {
  await h.clock.tick(901);
}

describe('skipVisible: the window the playhead is in', () => {
  beforeAll(warmPlayer, 120000);

  it('shows from the window start and retires 1 s before its end', async () => {
    const h = await play({ segments: [segment('Intro', 60, 150)] });
    expect(h.P.skips).toEqual([{ kind: 'intro', start: 60, end: 150, from: 'segment' }]);
    at(h, 59.9);
    expect(h.player.skipVisible()).toBe(null);
    at(h, 60);
    expect(h.player.skipVisible()).toMatchObject({ kind: 'intro', start: 60, end: 150 });
    at(h, 148.9);
    expect(h.player.skipVisible()).toMatchObject({ kind: 'intro' });
    at(h, 149);
    expect(h.player.skipVisible()).toBe(null);
    at(h, 150);
    expect(h.player.skipVisible()).toBe(null);
  });

  it('first by start wins where two overlap; the recap hands over to the intro at its own end', async () => {
    // recap from a named chapter 0–40, intro segment 30–120
    const h = await play({ segments: [segment('Intro', 30, 120)], chapters: chapters([['Previously on', 0], ['Chapter 2', 40], ['Chapter 3', 600]]) });
    expect(h.P.skips.map((s) => [s.kind, s.start, s.end, s.from])).toEqual([
      ['recap', 0, 40, 'chapter'],
      ['intro', 30, 120, 'segment']
    ]);
    at(h, 35);
    expect(h.player.skipVisible()).toMatchObject({ kind: 'recap' });
    // the recap's last second: it has retired, and the intro still waits behind it
    at(h, 39.5);
    expect(h.player.skipVisible()).toBe(null);
    at(h, 40);
    expect(h.player.skipVisible()).toMatchObject({ kind: 'intro' });
  });

  it('hidden while a panel is open', async () => {
    const h = await play({ segments: [segment('Intro', 60, 150)] });
    at(h, 70);
    expect(h.player.skipVisible()).not.toBe(null);
    h.P.panel = 'audio';
    expect(h.player.skipVisible()).toBe(null);
    h.P.panel = null;
    expect(h.player.skipVisible()).toMatchObject({ kind: 'intro' });
  });

  it('yields to the Up Next card (a teaser inside the credits); dismissing the card brings it back', async () => {
    const next = episode({ IndexNumber: 2 });
    const h = await play({
      next,
      segments: [segment('Outro', 2500, 2690), segment('Preview', 2600, 2650)],
      routes: (net) => net.on('POST', '/Items/' + next.Id + '/PlaybackInfo', playbackInfo(next.MediaSources[0]))
    });
    expect(h.P.skips).toEqual([{ kind: 'preview', start: 2600, end: 2650, from: 'segment' }]);
    h.settings.setSetting('autoplayNext', false);   // keep the card up instead of rolling on
    at(h, 2610);
    expect(h.player.upNextVisible()).toBe(true);
    expect(h.player.skipVisible()).toBe(null);
    h.player.dismissUpNext();
    expect(h.player.skipVisible()).toMatchObject({ kind: 'preview' });
  });

  it('a recap chapter at 0:00 is offered before the first frame', async () => {
    const h = await startPlayer({ item: movie(), chapters: chapters([['Recap', 0], ['Chapter 2', 30], ['Chapter 3', 600]]), reach: 'metadata' });
    await h.settle();
    expect(h.player.skipVisible()).toMatchObject({ kind: 'recap', start: 0 });
  });
});

describe('skipSegment: seek to the window end, the chip stays down after a short landing', () => {
  beforeAll(warmPlayer, 120000);

  it('seeks to the end quietly and marks the window kind:start', async () => {
    const h = await play({ segments: [segment('Intro', 60, 150)] });
    at(h, 70);
    h.P.osdShown = false;
    h.player.skipSegment();
    expect(h.video.seeks.at(-1)).toBe(150);
    expect(h.P.skipped).toBe('intro:60');
    expect(h.P.pos).toBe(150);
    expect(h.P.osdShown).toBe(false);   // quiet: no OSD for a skip
  });

  it('outside every window it does nothing', async () => {
    const h = await play({ segments: [segment('Intro', 60, 150)] });
    at(h, 30);
    const seeks = h.video.seeks.length;
    h.player.skipSegment();
    expect(h.video.seeks.length).toBe(seeks);
    expect(h.P.skipped).toBe(null);
  });

  it('a keyframe-short landing back inside the window keeps the chip down', async () => {
    const h = await play({ segments: [segment('Intro', 60, 150)] });
    at(h, 70);
    h.player.skipSegment();
    await settleSeek(h);
    at(h, 146.4);   // the TV decoded from the keyframe before 150
    expect(h.P.pos).toBe(146.4);
    expect(h.player.skipVisible()).toBe(null);
    at(h, 148);
    expect(h.player.skipVisible()).toBe(null);
  });

  it('a seek of any other kind re-arms it', async () => {
    const h = await play({ segments: [segment('Intro', 60, 150)] });
    at(h, 70);
    h.player.skipSegment();
    await settleSeek(h);
    h.player.seekBy(-60);   // 150 → 90, back into the intro
    expect(h.P.skipped).toBe(null);
    expect(h.player.skipVisible()).toMatchObject({ kind: 'intro' });
  });

  it('a recap skipped into the intro leaves the intro chip up for a second OK', async () => {
    const h = await play({ segments: [segment('Intro', 40, 120)], chapters: chapters([['Recap', 0], ['Chapter 2', 40], ['Chapter 3', 600]]) });
    at(h, 10);
    h.player.skipSegment();
    expect(h.P.skipped).toBe('recap:0');
    expect(h.video.seeks.at(-1)).toBe(40);
    expect(h.player.skipVisible()).toMatchObject({ kind: 'intro' });
    h.player.skipSegment();   // effectivePos() is the 40 s target: the intro
    expect(h.P.skipped).toBe('intro:40');
    expect(h.video.seeks.at(-1)).toBe(120);
  });
});

describe('auto-skip: once per kind per item', () => {
  beforeAll(warmPlayer, 120000);

  it('autoSkipIntro skips the intro on entry, toasts, and leaves a deliberate seek back alone', async () => {
    const h = await play({ segments: [segment('Intro', 60, 150)] });
    const toast = await toastOf();
    h.settings.setSetting('autoSkipIntro', true);
    at(h, 59);
    expect(h.P.skipped).toBe(null);
    at(h, 61);
    expect(h.video.seeks.at(-1)).toBe(150);
    expect(h.P.skipped).toBe('intro:60');
    expect(toast.msg).toBe('Skipped intro');
    await settleSeek(h);
    h.player.seekTo(80);
    await settleSeek(h);
    const seeks = h.video.seeks.length;
    at(h, 80.5);
    expect(h.video.seeks.length).toBe(seeks);   // not thrown out again
    expect(h.player.skipVisible()).toMatchObject({ kind: 'intro' });
  });

  it('autoSkipIntro does not touch recaps or previews; autoSkipRecap takes both', async () => {
    const segs = [segment('Preview', 2600, 2650)];
    const ch = chapters([['Recap', 0], ['Chapter 2', 40], ['Chapter 3', 600]]);
    const a = await play({ segments: segs, chapters: ch });
    a.settings.setSetting('autoSkipIntro', true);
    at(a, 5);
    expect(a.P.skipped).toBe(null);
    at(a, 2610);
    expect(a.P.skipped).toBe(null);

    const b = await play({ segments: segs, chapters: ch });
    b.settings.setSetting('autoSkipRecap', true);
    at(b, 5);
    expect(b.P.skipped).toBe('recap:0');
    expect(b.video.seeks.at(-1)).toBe(40);
    await settleSeek(b);
    at(b, 2610);
    expect(b.P.skipped).toBe('preview:2600');
    expect(b.video.seeks.at(-1)).toBe(2650);
  });

  it('not under an open panel, and not inside the window\'s last second', async () => {
    const h = await play({ segments: [segment('Intro', 60, 150)] });
    h.settings.setSetting('autoSkipIntro', true);
    h.P.panel = 'subs';
    at(h, 70);
    expect(h.P.skipped).toBe(null);
    h.P.panel = null;
    at(h, 149.2);
    expect(h.P.skipped).toBe(null);
    // the kind was not used up by either: the next entry skips
    at(h, 100);
    expect(h.P.skipped).toBe('intro:60');
  });

  it('a new item (the Up Next roll-on) re-arms it', async () => {
    const ep2 = episode({ IndexNumber: 2 });
    const h = await play({
      segments: [segment('Intro', 60, 150)],
      next: ep2,
      routes: (net) => {
        net.on('POST', '/Items/' + ep2.Id + '/PlaybackInfo', playbackInfo(ep2.MediaSources[0], { PlaySessionId: 'ps-2' }));
        net.on('GET', '/MediaSegments/' + ep2.Id, { Items: [segment('Intro', 60, 150)] });
        net.on('GET', (r) => r.path === '/Items' && new URLSearchParams(r.query).get('Ids') === ep2.Id, { Items: [{ Id: ep2.Id }], TotalRecordCount: 1 });
      }
    });
    h.settings.setSetting('autoSkipIntro', true);
    at(h, 61);
    expect(h.P.skipped).toBe('intro:60');
    h.player.playNext(true);
    await h.settle();
    await h.settle();
    expect(h.P.item.Id).toBe(ep2.Id);
    expect(h.P.skipped).toBe(null);
    await h.clock.tick(50);   // the marker lookup settles a few macrotasks later
    expect(h.P.skips).toHaveLength(1);
    await settleSeek(h);
    const seeks = h.video.seeks.length;
    at(h, 61);
    expect(h.video.seeks.length).toBe(seeks + 1);
    expect(h.video.seeks.at(-1)).toBe(150);
    expect(h.P.skipped).toBe('intro:60');
  });
});

describe('IntroDB fills only what Jellyfin left empty', () => {
  beforeAll(warmPlayer, 120000);
  const withImdb = (ep) => ({ Id: ep.SeriesId, Type: 'Series', Name: 'Test Series', ProviderIds: { Imdb: 'tt0000042' } });

  it('a Jellyfin intro wins over IntroDB\'s; IntroDB adds the recap and the credits', async () => {
    const ep = episode();
    const h = await play({
      item: ep,
      seriesItem: withImdb(ep),
      segments: [segment('Intro', 60, 150)],
      introdb: { recap: { start: 0, end: 30 }, intro: { start: 200, end: 290 }, outro: { start: 2500, end: 2690 } }
    });
    expect(h.net.callsTo((r) => r.url.includes('/api/segments/tt0000042/1/1'))).toHaveLength(1);
    expect(h.P.skips).toEqual([
      { kind: 'recap', start: 0, end: 30, from: 'introdb' },
      { kind: 'intro', start: 60, end: 150, from: 'segment' }
    ]);
    expect(h.P.credits).toEqual({ start: 2500, end: 2690, from: 'introdb' });
  });

  it('Jellyfin credits win over IntroDB\'s', async () => {
    const ep = episode();
    const h = await play({ item: ep, seriesItem: withImdb(ep), segments: [segment('Outro', 2400, 2690)], introdb: { outro: { start: 2500, end: 2690 } } });
    expect(h.P.credits).toEqual({ start: 2400, end: 2690, from: 'segment' });
  });

  it('a Jellyfin Recap segment is ignored; the recap comes from IntroDB', async () => {
    const ep = episode();
    const h = await play({ item: ep, seriesItem: withImdb(ep), segments: [segment('Recap', 0, 90)], introdb: { recap: { start: 1, end: 35 } } });
    expect(h.P.skips).toEqual([{ kind: 'recap', start: 1, end: 35, from: 'introdb' }]);
  });

  it('a series without an IMDb id (and a movie) never asks IntroDB', async () => {
    const h = await play({ segments: [segment('Intro', 60, 150)] });
    expect(h.net.callsTo((r) => r.url.includes('/api/segments/'))).toHaveLength(0);
    const m = await play({ item: movie() });
    expect(m.net.callsTo((r) => r.url.includes('/api/segments/'))).toHaveLength(0);
    expect(m.P.skips).toEqual([]);
  });
});
