/* segments.js: where the Skip chip's windows and the credits start come from.
 *
 * CLAUDE.md (Skip Intro / Skip Recap / Preview): the intro comes from
 * Jellyfin's Media Segments (one unfiltered /MediaSegments/{id} call) and,
 * failing that, a Matroska chapter *named* Intro. "Do not infer an intro from
 * an unnamed chapter boundary — that skips cold opens." Every segment/named
 * chapter of the kind is tried in turn and the first SANE one wins (a bogus
 * first Intro used to hide a valid later one). Recaps never come from
 * Jellyfin's Recap segments (Intro Skipper's are the cold open); they come from
 * a chapter named like one or from IntroDB. Preview segments are trusted. */
import { describe, it, expect, beforeEach } from 'vitest';
import { findMarkers, communityMarkers } from '../../src/lib/segments.js';
import { cfg } from '../../src/lib/config.js';
import { mockFetch } from '../helpers/fetch.js';
import { segment, chapters, resetIds } from '../helpers/media.js';
import { sec } from '../helpers/time.js';
import { TEST_SERVER, TEST_TOKEN, TEST_USER } from '../helpers/modules.js';

const ID = 'ep1';
const RUNTIME = 3000; // 50 min

let net;
beforeEach(() => {
  resetIds();
  cfg.server = TEST_SERVER;
  cfg.token = TEST_TOKEN;
  cfg.userId = TEST_USER;
  net = mockFetch();
});

/* Answer /MediaSegments/ep1 with `segs` and the Fields=Chapters item query with `ch`. */
function serve(segs = [], ch = null) {
  net.on('GET', '/MediaSegments/' + ID, { Items: segs });
  net.on('GET', '/Items', (req) => ({ Items: ch ? [{ Id: ID, Chapters: ch }] : [{ Id: ID }], TotalRecordCount: 1 }));
}
const item = (o = {}) => ({ Id: ID, RunTimeTicks: sec(RUNTIME), ...o });
const strip = (w) => w && { start: w.start, end: w.end, from: w.from };
const kinds = (r) => r.skips.map((s) => s.kind);
const segReqs = () => net.calls.filter((c) => c.path.startsWith('/MediaSegments/'));
const chapterReqs = () => net.calls.filter((c) => c.path === '/Items');

describe('intro from Jellyfin segments', () => {
  it('an Intro segment becomes the intro window', async () => {
    serve([segment('Intro', 62, 151)]);
    const r = await findMarkers(ID, item());
    expect(r.skips).toStrictEqual([{ kind: 'intro', start: 62, end: 151, from: 'segment' }]);
    expect(r.credits).toBe(null);
    expect(net.unmatched).toEqual([]);
  });

  it('one unfiltered /MediaSegments/{id} call', async () => {
    serve([segment('Intro', 62, 151), segment('Outro', 2900, 3000)]);
    await findMarkers(ID, item());
    expect(segReqs()).toHaveLength(1);
    expect(segReqs()[0].query).toBe('');
    expect(segReqs()[0].url).toBe(TEST_SERVER + '/MediaSegments/' + ID);
  });

  it('the first SANE Intro wins: a bogus first one does not hide a valid later one', async () => {
    serve([segment('Intro', 0, 900), segment('Intro', 30, 32), segment('Intro', 95, 180), segment('Intro', 200, 280)]);
    const r = await findMarkers(ID, item());
    expect(r.skips).toStrictEqual([{ kind: 'intro', start: 95, end: 180, from: 'segment' }]);
  });

  it.each([
    ['too short (< 5 s)', 100, 104.9, false],
    ['exactly 5 s', 100, 105, true],
    ['exactly 300 s', 100, 400, true],
    ['too long (> 300 s)', 100, 400.5, false],
    ['starts at 1200 s', 1200, 1290, true],
    ['starts after 1200 s', 1200.5, 1290, false],
    ['negative start', -3, 60, false],
    ['end before start', 200, 100, false]
  ])('sanity bounds: %s', async (_, s, e, ok) => {
    serve([segment('Intro', s, e)]);
    const r = await findMarkers(ID, item());
    expect(r.skips.length).toBe(ok ? 1 : 0);
  });

  it('a segment Intro wins over a named Intro chapter', async () => {
    serve([segment('Intro', 62, 151)], chapters([['Intro', 10], ['Chapter 02', 100], ['Chapter 03', 1500]]));
    const r = await findMarkers(ID, item());
    expect(strip(r.skips[0])).toStrictEqual({ start: 62, end: 151, from: 'segment' });
  });
});

describe('intro from named chapters', () => {
  it('a chapter named Intro, ending where the next begins', async () => {
    serve([], chapters([['Chapter 01', 0], ['Intro', 150], ['Chapter 03', 227], ['Chapter 04', 1500]]));
    const r = await findMarkers(ID, item());
    expect(r.skips).toStrictEqual([{ kind: 'intro', start: 150, end: 227, from: 'chapter' }]);
  });

  it('NEVER from an unnamed chapter boundary', async () => {
    serve([], chapters([['Chapter 01', 0], ['Chapter 02', 92], ['Chapter 03', 180], ['Chapter 04', 1500], ['Chapter 05', 2900]]));
    const r = await findMarkers(ID, item());
    expect(r).toStrictEqual({ skips: [], credits: null });
  });

  it.each(['Intro', 'intro', ' INTRODUCTION ', 'Opening', 'Opening Credits', 'opening titles', 'Main Title', 'Main Titles', 'Title Sequence', 'Theme', 'Theme Song', 'OP'])(
    'matches %j',
    async (name) => {
      serve([], chapters([['Cold open', 0], [name, 60], ['Act 1', 150]]));
      const r = await findMarkers(ID, item());
      expect(r.skips.map(strip)).toStrictEqual([{ start: 60, end: 150, from: 'chapter' }]);
    }
  );

  it.each(['The Opening Night', 'Intro to Evil', 'Opening act of war', 'Operation', 'Chapter 1 - Intro', 'Themes', 'Top'])(
    'anchored: does not match %j',
    async (name) => {
      serve([], chapters([['Cold open', 0], [name, 60], ['Act 1', 150]]));
      const r = await findMarkers(ID, item());
      expect(r.skips).toStrictEqual([]);
    }
  );

  it('an Intro chapter with nothing after it has no end and is ignored', async () => {
    serve([], chapters([['Chapter 01', 0], ['Intro', 60]]));
    const r = await findMarkers(ID, item());
    expect(r.skips).toStrictEqual([]);
  });

  it('first sane named chapter wins', async () => {
    serve([], chapters([['Intro', 0], ['Chapter 02', 2], ['Intro', 60], ['Act 1', 150]]));
    const r = await findMarkers(ID, item());
    expect(strip(r.skips[0])).toStrictEqual({ start: 60, end: 150, from: 'chapter' });
  });

  it('chapters are sorted by start before use', async () => {
    serve([], chapters([['Act 1', 150], ['Intro', 60], ['Cold open', 0]]));
    const r = await findMarkers(ID, item());
    expect(strip(r.skips[0])).toStrictEqual({ start: 60, end: 150, from: 'chapter' });
  });

  it('fewer than two chapters → nothing', async () => {
    serve([], chapters([['Intro', 60]]));
    expect((await findMarkers(ID, item())).skips).toStrictEqual([]);
  });

  it('a chapter without a Name is treated as unnamed', async () => {
    serve([], [{ StartPositionTicks: 0 }, { StartPositionTicks: sec(60) }, { Name: 'Act', StartPositionTicks: sec(150) }]);
    expect((await findMarkers(ID, item())).skips).toStrictEqual([]);
  });
});

describe('recaps never from Jellyfin Recap segments', () => {
  it('a Recap segment alone yields no recap', async () => {
    serve([segment('Recap', 0, 85)], chapters([['Chapter 01', 0], ['Chapter 02', 1500]]));
    const r = await findMarkers(ID, item());
    expect(r.skips).toStrictEqual([]);
  });

  it('a Recap segment never wins over (or replaces) a recap chapter', async () => {
    serve([segment('Recap', 0, 85)], chapters([['Previously on Succession', 1], ['Chapter 02', 35], ['Chapter 03', 1500]]));
    const r = await findMarkers(ID, item());
    expect(r.skips).toStrictEqual([{ kind: 'recap', start: 1, end: 35, from: 'chapter' }]);
  });

  it.each(['Recap', 'recap', 'Previously', 'Previously on', 'Previously on Peaky Blinders', 'Summary'])('recap chapter %j', async (name) => {
    serve([], chapters([[name, 0], ['Chapter 02', 40], ['Chapter 03', 1500]]));
    const r = await findMarkers(ID, item());
    expect(r.skips).toStrictEqual([{ kind: 'recap', start: 0, end: 40, from: 'chapter' }]);
  });

  it.each(['Recapitulation', 'A summary of events', 'Previouslyon'])('anchored: not a recap %j', async (name) => {
    serve([], chapters([[name, 0], ['Chapter 02', 40], ['Chapter 03', 1500]]));
    expect((await findMarkers(ID, item())).skips).toStrictEqual([]);
  });

  it('a recap chapter starting after 600 s is rejected; at 600 s accepted', async () => {
    serve([], chapters([['Act', 0], ['Recap', 600.5], ['Act 2', 640]]));
    expect((await findMarkers(ID, item())).skips).toStrictEqual([]);
    net = mockFetch();
    serve([], chapters([['Act', 0], ['Recap', 600], ['Act 2', 640]]));
    expect(kinds(await findMarkers(ID, item()))).toStrictEqual(['recap']);
  });

  it('recap length bounds 5–300 s', async () => {
    serve([], chapters([['Recap', 0], ['Act', 4]]));
    expect((await findMarkers(ID, item())).skips).toStrictEqual([]);
    net = mockFetch();
    serve([], chapters([['Recap', 0], ['Act', 301]]));
    expect((await findMarkers(ID, item())).skips).toStrictEqual([]);
  });
});

describe('previews', () => {
  it('a Preview segment is trusted', async () => {
    serve([segment('Preview', 2950, 2990)]);
    const r = await findMarkers(ID, item());
    expect(r.skips).toStrictEqual([{ kind: 'preview', start: 2950, end: 2990, from: 'segment' }]);
  });

  it('a preview chapter may be the last one and run to the end of the file', async () => {
    serve([], chapters([['Chapter 01', 0], ['Chapter 02', 1500], ['Next Episode', 2960]]));
    const r = await findMarkers(ID, item());
    expect(r.skips).toStrictEqual([{ kind: 'preview', start: 2960, end: RUNTIME, from: 'chapter' }]);
  });

  it('a trailing preview chapter without a runtime has no end', async () => {
    serve([], chapters([['Chapter 01', 0], ['Chapter 02', 1500], ['Preview', 2960]]));
    const r = await findMarkers(ID, { Id: ID });
    expect(r.skips).toStrictEqual([]);
  });

  it.each(['Preview', 'Next Time', 'Next Episode', 'Next on Silo', 'Sneak Peek', 'Teaser'])('preview chapter %j', async (name) => {
    serve([], chapters([['Chapter 01', 0], [name, 2900], ['End', 2940]]));
    expect((await findMarkers(ID, item())).skips.map((s) => s.kind)).toStrictEqual(['preview']);
  });

  it('a preview may start anywhere (no start bound), but is still 5–300 s long', async () => {
    serve([segment('Preview', 2500, 2501), segment('Preview', 2600, 2700)]);
    expect((await findMarkers(ID, item())).skips.map(strip)).toStrictEqual([{ start: 2600, end: 2700, from: 'segment' }]);
  });
});

describe('credits', () => {
  it('from an Outro segment, >= 10 s and in the second half', async () => {
    serve([segment('Outro', 2880, 3000)]);
    const r = await findMarkers(ID, item());
    expect(r.credits).toStrictEqual({ start: 2880, end: 3000, from: 'segment' });
  });

  it('an Outro in the first half or shorter than 10 s is skipped for the next sane one', async () => {
    serve([segment('Outro', 100, 200), segment('Outro', 2900, 2909), segment('Outro', 2910, 3000)]);
    expect((await findMarkers(ID, item())).credits).toStrictEqual({ start: 2910, end: 3000, from: 'segment' });
  });

  it('starting exactly at half the runtime is accepted', async () => {
    serve([segment('Outro', 1500, 1600)]);
    expect((await findMarkers(ID, item())).credits).toStrictEqual({ start: 1500, end: 1600, from: 'segment' });
  });

  it('without a runtime only the length is checked', async () => {
    serve([segment('Outro', 100, 200)]);
    expect((await findMarkers(ID, { Id: ID })).credits).toStrictEqual({ start: 100, end: 200, from: 'segment' });
  });

  it.each(['Credits', 'End Credits', 'Ending', 'Ending Theme', 'ending credits', 'Closing', 'Closing Credits', 'End Titles', 'Outro', 'ED'])(
    'credits chapter %j, last chapter runs to the end of the file',
    async (name) => {
      serve([], chapters([['Chapter 01', 0], ['Chapter 02', 1500], [name, 2870]]));
      expect((await findMarkers(ID, item())).credits).toStrictEqual({ start: 2870, end: RUNTIME, from: 'chapter' });
    }
  );

  it('a credits chapter followed by another ends where it begins', async () => {
    serve([], chapters([['Chapter 01', 0], ['Credits', 2800], ['Post-credits scene', 2950]]));
    expect((await findMarkers(ID, item())).credits).toStrictEqual({ start: 2800, end: 2950, from: 'chapter' });
  });

  it('a credits chapter in the first half is ignored', async () => {
    serve([], chapters([['Chapter 01', 0], ['Credits', 1000], ['Chapter 03', 1100]]));
    expect((await findMarkers(ID, item())).credits).toBe(null);
  });

  it('an Outro segment wins over a Credits chapter', async () => {
    serve([segment('Outro', 2900, 3000)], chapters([['Chapter 01', 0], ['Credits', 2800]]));
    expect((await findMarkers(ID, item())).credits.from).toBe('segment');
  });

  it('Edition / Ed Wood are not credits (anchored)', async () => {
    serve([], chapters([['Chapter 01', 0], ['Ed Wood', 2800], ['Edition', 2900]]));
    expect((await findMarkers(ID, item())).credits).toBe(null);
  });
});

describe('ordering and combination', () => {
  it('skips sorted by start; at most one per kind', async () => {
    serve(
      [segment('Preview', 2950, 2995), segment('Intro', 95, 180), segment('Intro', 400, 480), segment('Outro', 2850, 2950)],
      chapters([['Previously on', 0], ['Cold open', 38], ['Act 1', 95], ['Act 2', 1500]])
    );
    const r = await findMarkers(ID, item());
    expect(r.skips).toStrictEqual([
      { kind: 'recap', start: 0, end: 38, from: 'chapter' },
      { kind: 'intro', start: 95, end: 180, from: 'segment' },
      { kind: 'preview', start: 2950, end: 2995, from: 'segment' }
    ]);
    expect(r.credits).toStrictEqual({ start: 2850, end: 2950, from: 'segment' });
  });

  it('a recap after the intro sorts after it', async () => {
    serve([segment('Intro', 0, 60)], chapters([['Cold open', 0], ['Recap', 60], ['Act 1', 100]]));
    expect(kinds(await findMarkers(ID, item()))).toStrictEqual(['intro', 'recap']);
  });

  it('unknown segment types are ignored', async () => {
    serve([segment('Commercial', 100, 160), segment('Unknown', 10, 50)]);
    expect(await findMarkers(ID, item())).toStrictEqual({ skips: [], credits: null });
  });
});

describe('where chapters come from', () => {
  it('item.Chapters when present: no extra request', async () => {
    serve([]);
    const r = await findMarkers(ID, item({ Chapters: chapters([['Intro', 60], ['Act', 150]]) }));
    expect(kinds(r)).toStrictEqual(['intro']);
    expect(chapterReqs()).toHaveLength(0);
  });

  it('the withChapters promise before an /Items request', async () => {
    serve([]);
    const withChapters = Promise.resolve({ Id: ID, Chapters: chapters([['Intro', 60], ['Act', 150]]) });
    const r = await findMarkers(ID, item(), withChapters);
    expect(kinds(r)).toStrictEqual(['intro']);
    expect(chapterReqs()).toHaveLength(0);
  });

  it('a rejected or chapter-less withChapters falls back to the Fields=Chapters query', async () => {
    serve([], chapters([['Intro', 60], ['Act', 150]]));
    for (const wc of [Promise.reject(new Error('x')), Promise.resolve(null), Promise.resolve({ Id: ID })]) {
      const r = await findMarkers(ID, item(), wc);
      expect(kinds(r)).toStrictEqual(['intro']);
    }
    expect(chapterReqs()).toHaveLength(3);
  });

  it('the fallback asks for exactly Chapters on exactly this id', async () => {
    serve([], chapters([['Intro', 60], ['Act', 150]]));
    await findMarkers(ID, item());
    const q = new URLSearchParams(chapterReqs()[0].query);
    expect(Object.fromEntries(q)).toStrictEqual({ Ids: ID, UserId: TEST_USER, Fields: 'Chapters', Recursive: 'true', Limit: '1' });
  });

  it('every kind found from segments still reads chapters for the recap (recaps are chapter/IntroDB only)', async () => {
    serve([segment('Intro', 60, 150), segment('Preview', 2950, 2990), segment('Outro', 2850, 2950)]);
    const r = await findMarkers(ID, item());
    expect(kinds(r)).toStrictEqual(['intro', 'preview']);
    expect(chapterReqs()).toHaveLength(1);
  });
});

describe('never rejects', () => {
  it('a failing /MediaSegments answers from chapters', async () => {
    net.on('GET', '/MediaSegments/' + ID, net.status(500));
    net.on('GET', '/Items', { Items: [{ Chapters: chapters([['Intro', 60], ['Act', 150]]) }] });
    const r = await findMarkers(ID, item());
    expect(kinds(r)).toStrictEqual(['intro']);
  });

  it('both requests failing → empty answer, no rejection', async () => {
    net.on('GET', '/MediaSegments/' + ID, net.networkError());
    net.on('GET', '/Items', net.status(404));
    await expect(findMarkers(ID, item())).resolves.toStrictEqual({ skips: [], credits: null });
  });

  it('an empty / odd segments body is no segments', async () => {
    net.on('GET', '/MediaSegments/' + ID, null);
    net.on('GET', '/Items', { Items: [] });
    await expect(findMarkers(ID, item())).resolves.toStrictEqual({ skips: [], credits: null });
  });

  it('a null item is fine', async () => {
    serve([segment('Outro', 100, 200)]);
    await expect(findMarkers(ID, null)).resolves.toStrictEqual({ skips: [], credits: { start: 100, end: 200, from: 'segment' } });
  });
});

describe('communityMarkers (IntroDB)', () => {
  it('nothing → no skips, no credits', () => {
    expect(communityMarkers(null, 3000)).toStrictEqual({ skips: [], credits: null });
    expect(communityMarkers(undefined)).toStrictEqual({ skips: [], credits: null });
    expect(communityMarkers({}, 3000)).toStrictEqual({ skips: [], credits: null });
  });

  it('recap + intro windows, sorted by start, from introdb', () => {
    const r = communityMarkers({ intro: { start: 40, end: 120 }, recap: { start: 1, end: 35 }, outro: { start: 2880, end: 3000 } }, 3000);
    expect(r).toStrictEqual({
      skips: [
        { kind: 'recap', start: 1, end: 35, from: 'introdb' },
        { kind: 'intro', start: 40, end: 120, from: 'introdb' }
      ],
      credits: { start: 2880, end: 3000, from: 'introdb' }
    });
  });

  it('an intro before the recap sorts first', () => {
    const r = communityMarkers({ intro: { start: 0, end: 60 }, recap: { start: 60, end: 100 } }, 3000);
    expect(r.skips.map((s) => s.kind)).toStrictEqual(['intro', 'recap']);
  });

  it('the same sanity checks: lengths, starts, empty windows', () => {
    expect(communityMarkers({ intro: { start: 10, end: 12 } }, 3000).skips).toStrictEqual([]);
    expect(communityMarkers({ intro: { start: 1300, end: 1400 } }, 3000).skips).toStrictEqual([]);
    expect(communityMarkers({ intro: { start: 50, end: 50 } }, 3000).skips).toStrictEqual([]);
    expect(communityMarkers({ intro: { start: 50, end: 40 } }, 3000).skips).toStrictEqual([]);
    expect(communityMarkers({ recap: { start: 700, end: 760 } }, 3000).skips).toStrictEqual([]);
    expect(communityMarkers({ recap: { start: 0, end: 400 } }, 3000).skips).toStrictEqual([]);
  });

  it('credits: >= 10 s and in the second half of the runtime', () => {
    expect(communityMarkers({ outro: { start: 2995, end: 3000 } }, 3000).credits).toBe(null);
    expect(communityMarkers({ outro: { start: 1000, end: 1100 } }, 3000).credits).toBe(null);
    expect(communityMarkers({ outro: { start: 1000, end: 1100 } }).credits).toStrictEqual({ start: 1000, end: 1100, from: 'introdb' });
    expect(communityMarkers({ outro: { start: 100, end: 90 } }, 3000).credits).toBe(null);
  });

  it('no preview from IntroDB', () => {
    const r = communityMarkers({ preview: { start: 2950, end: 2990 } }, 3000);
    expect(r.skips).toStrictEqual([]);
  });
});
