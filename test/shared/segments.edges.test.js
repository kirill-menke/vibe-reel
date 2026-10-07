/* segments.js: the sanity bounds at their edges (oracle-mutants-core).
 * The bounds are inclusive: a window of exactly 5 s or exactly 300 s is a
 * skip, credits of exactly 10 s are credits; a window that starts before 0 is
 * not (IntroDB hands out raw viewer-marked numbers). */
import { describe, it, expect, beforeEach } from 'vitest';
import { findMarkers, communityMarkers } from '../../src/lib/segments.js';
import { cfg } from '../../src/lib/config.js';
import { mockFetch } from '../helpers/fetch.js';
import { segment, resetIds } from '../helpers/media.js';
import { sec } from '../helpers/time.js';
import { TEST_SERVER, TEST_TOKEN, TEST_USER } from '../helpers/modules.js';

const ID = 'ep1';
const RUNTIME = 3000;
let net;
beforeEach(() => {
  resetIds();
  cfg.server = TEST_SERVER;
  cfg.token = TEST_TOKEN;
  cfg.userId = TEST_USER;
  net = mockFetch();
});
function serve(segs) {
  net.on('GET', '/MediaSegments/' + ID, { Items: segs });
  net.on('GET', '/Items', { Items: [{ Id: ID }], TotalRecordCount: 1 });
}
const item = () => ({ Id: ID, RunTimeTicks: sec(RUNTIME) });

describe('Preview segments: 5–300 s inclusive', () => {
  it.each([[2900, 2905], [2600, 2900]])('%i–%i is a preview', async (a, b) => {
    serve([segment('Preview', a, b)]);
    const r = await findMarkers(ID, item());
    expect(r.skips).toStrictEqual([{ kind: 'preview', start: a, end: b, from: 'segment' }]);
  });

  it.each([[2900, 2904.9], [2600, 2900.1]])('%i–%i is not', async (a, b) => {
    serve([segment('Preview', a, b)]);
    expect((await findMarkers(ID, item())).skips).toStrictEqual([]);
  });
});

describe('IntroDB recap bounds', () => {
  it('exactly 5 s and exactly 300 s are recaps', () => {
    expect(communityMarkers({ recap: { start: 10, end: 15 } }, RUNTIME).skips).toStrictEqual([{ kind: 'recap', start: 10, end: 15, from: 'introdb' }]);
    expect(communityMarkers({ recap: { start: 0, end: 300 } }, RUNTIME).skips).toStrictEqual([{ kind: 'recap', start: 0, end: 300, from: 'introdb' }]);
  });

  it('a recap starting before 0 is rejected', () => {
    expect(communityMarkers({ recap: { start: -2, end: 30 } }, RUNTIME).skips).toStrictEqual([]);
  });
});

describe('credits: at least 10 s, inclusive', () => {
  it('an Outro segment of exactly 10 s is the credits', async () => {
    serve([segment('Outro', 2990, 3000)]);
    expect((await findMarkers(ID, item())).credits).toStrictEqual({ start: 2990, end: 3000, from: 'segment' });
  });

  it('IntroDB outro of exactly 10 s too; 9.9 s is not', () => {
    expect(communityMarkers({ outro: { start: 2990, end: 3000 } }, RUNTIME).credits).toStrictEqual({ start: 2990, end: 3000, from: 'introdb' });
    expect(communityMarkers({ outro: { start: 2990.1, end: 3000 } }, RUNTIME).credits).toBe(null);
  });
});

/* Chapter names: whitespace-tolerant (muxers double spaces and pad names) but
 * anchored — a name that merely contains the word is not that kind of chapter. */
describe('chapter names', () => {
  const run = async (ch) => {
    net.on('GET', '/MediaSegments/' + ID, { Items: [] });
    net.on('GET', '/Items', { Items: [{ Id: ID, Chapters: ch }], TotalRecordCount: 1 });
    return findMarkers(ID, item());
  };
  const C = (list) => list.map(([Name, s]) => ({ Name, StartPositionTicks: sec(s) }));

  it.each(['Main  Titles', 'Opening  Credits', 'Title  Sequence', 'Theme  Song'])('intro: %j', async (name) => {
    const r = await run(C([['Cold Open', 0], [name, 60], ['Act 1', 150]]));
    expect(r.skips).toStrictEqual([{ kind: 'intro', start: 60, end: 150, from: 'chapter' }]);
  });

  it.each(['Previously  on Succession', '  Recap'])('recap: %j', async (name) => {
    const r = await run(C([[name, 0], ['Act 1', 40]]));
    expect(r.skips).toStrictEqual([{ kind: 'recap', start: 0, end: 40, from: 'chapter' }]);
  });

  it.each(['Next  Time', 'Next  On Succession', 'Sneak  Peek', 'Preview ', '  Teaser'])('preview: %j', async (name) => {
    const r = await run(C([['Act 1', 0], [name, 2900]]));
    expect(r.skips).toStrictEqual([{ kind: 'preview', start: 2900, end: 3000, from: 'chapter' }]);
  });

  it.each(['End  Credits', 'Ending  Theme', 'Closing  Credits', 'End  Titles', '  Credits'])('credits: %j', async (name) => {
    const r = await run(C([['Act 1', 0], [name, 2800]]));
    expect(r.credits).toStrictEqual({ start: 2800, end: 3000, from: 'chapter' });
  });

  it.each([
    ['Season 1 Recap', 0, 40, 'recap'],
    ['Plot Summary', 0, 40, 'recap'],
    ['Preview of the Finale', 2900, 3000, 'preview'],
    ['Last Week Teaser', 2900, 3000, 'preview']
  ])('%j is not a %s', async (name, a, b) => {
    const r = await run(C(a === 0 ? [[name, 0], ['Act 1', b]] : [['Act 1', 0], [name, a]]));
    expect(r.skips).toStrictEqual([]);
  });

  it("'Post Credits' is not the credits", async () => {
    const r = await run(C([['Act 1', 0], ['Post Credits', 2800], ['Stinger', 2900]]));
    expect(r.credits).toBe(null);
  });
});
