/* searchrank.js: one relevance scale for the merged Sonarr + Radarr lookup.
 *
 * score = TIER_BONUS[tier] + log10(votes + 1) + 1 if in the library
 *         + YEAR_BONUS when the query ends in the item's year (±1)
 * Tiers: 4 exact · 3 prefix · 2 every query word (or a typo) · 1 some word ·
 * 0 fuzzy-only. Stop words don't count; ties keep upstream order with shows
 * before movies; once an exact/prefix match exists, fuzzy-only results are
 * dropped; past ENOUGH (8) real matches the non-matching rest goes. */
import { describe, it, expect } from 'vitest';
import { rankLookup, aliasesFor, TIER_BONUS } from '../../src/lib/searchrank.js';

const t = (title, o = {}) => ({ title, ...o });
const titles = (list) => list.map((x) => x.title);
const rank = (q, tv, mv = [], bonus) => titles(rankLookup(q, tv, mv, bonus));

describe('match tiers', () => {
  it('exact > prefix > every word; a fuzzy-only result is dropped once a strong match exists', () => {
    const tv = [t('Children of Dune'), t('Dude'), t('Dune Messiah'), t('Dune')];
    expect(rank('dune', tv)).toEqual(['Dune', 'Dune Messiah', 'Children of Dune']);
  });

  it('some-word matches rank below every-word matches', () => {
    const mv = [t('Breaking Point'), t('Breaking Bad Habits'), t('Bad Breaking News')];
    // "breaking bad": prefix, then every word (Bad Breaking News), then one word (Breaking Point)
    expect(rank('breaking bad', [], mv)).toEqual(['Breaking Bad Habits', 'Bad Breaking News', 'Breaking Point']);
  });

  it('a half-typed last word still matches every word', () => {
    const tv = [t('Star Wars: The Empire Strikes Back'), t('Star Trek')];
    expect(rank('star wa emp', [], tv)).toEqual(['Star Wars: The Empire Strikes Back', 'Star Trek']);
  });

  it('stop words are ignored: "of mice" does not partly match "Lord of War"', () => {
    expect(rank('of mice', [], [t('Lord of War'), t('Of Mice and Men')])).toEqual(['Of Mice and Men']);
  });

  it('a query of stop words only matches nothing beyond exact/prefix', () => {
    // "lord of war" is no prefix of 'of' and qw is empty → tier 0, dropped beside the prefix match
    expect(rank('of', [t('Lord of War'), t('Of Mice and Men')])).toEqual(['Of Mice and Men']);
  });

  it('with no strong match, a non-matching result is kept (below the matches)', () => {
    expect(rank('zzqx', [t('Foo'), t('Bar')])).toEqual(['Foo', 'Bar']);
  });
});

describe('ordering on ties', () => {
  it('keeps upstream order, shows before movies', () => {
    const tv = [t('Dark', { k: 'tv1' }), t('Dark', { k: 'tv2' })];
    const mv = [t('Dark', { k: 'mv1' })];
    expect(rankLookup('dark', tv, mv).map((x) => x.k)).toEqual(['tv1', 'tv2', 'mv1']);
  });

  it('accepts the query as a string or an array', () => {
    const tv = [t('Dark'), t('Darker')];
    expect(rank(['dark'], tv)).toEqual(rank('dark', tv));
  });
});

describe('popularity and library bonus', () => {
  it('a much more popular prefix match beats an obscure exact one (Dune: Part Two over a short "Dune")', () => {
    const mv = [t('Dune', { votes: 10 }), t('Dune: Part Two', { votes: 600000 })];
    expect(rank('dune', [], mv)).toEqual(['Dune: Part Two', 'Dune']);
  });

  it('an exact title beats a slightly more popular prefix ("casino" → Casino, not Casino Royale)', () => {
    const mv = [t('Casino Royale', { votes: 700000 }), t('Casino', { votes: 500000 })];
    expect(rank('casino', [], mv)).toEqual(['Casino', 'Casino Royale']);
  });

  it('already in the library adds 1', () => {
    const mv = [t('Dark', { votes: 100, k: 'a' }), t('Dark', { votes: 100, added: true, k: 'b' })];
    expect(rankLookup('dark', [], mv).map((x) => x.k)).toEqual(['b', 'a']);
  });

  it('votes order results within a tier', () => {
    const mv = [t('Alien 3', { votes: 300 }), t('Aliens', { votes: 700000 }), t('Alien Nation', { votes: 9000 })];
    expect(rank('alie', [], mv)).toEqual(['Aliens', 'Alien Nation', 'Alien 3']);
  });
});

describe('TIER_BONUS', () => {
  it('is the grid-searched [0, 1, 2, 2.5, 3.5]', () => {
    expect(TIER_BONUS).toEqual([0, 1, 2, 2.5, 3.5]);
  });

  it('an override is used instead of the default', () => {
    const mv = [t('Casino Royale', { votes: 700000 }), t('Casino', { votes: 500000 })];
    expect(rank('casino', [], mv, [0, 0, 0, 0, 0])).toEqual(['Casino Royale', 'Casino']);
    expect(rank('casino', [], mv, [0, 1, 2, 2.5, 10])).toEqual(['Casino', 'Casino Royale']);
  });
});

describe('a trailing year', () => {
  const tv = [t('Fargo', { year: 2014, votes: 800000 })];
  const mv = [t('Fargo', { year: 1996, votes: 700000 })];

  it('without it, popularity decides', () => {
    expect(rankLookup('fargo', tv, mv).map((x) => x.year)).toEqual([2014, 1996]);
  });

  it('"fargo 1996" picks the release instead of being a title word', () => {
    expect(rankLookup('fargo 1996', tv, mv).map((x) => x.year)).toEqual([1996, 2014]);
    expect(rankLookup('fargo 2014', tv, mv).map((x) => x.year)).toEqual([2014, 1996]);
  });

  it('matches within ±1 year, not 2', () => {
    expect(rankLookup('fargo 1997', tv, mv).map((x) => x.year)).toEqual([1996, 2014]);
    expect(rankLookup('fargo 1998', tv, mv).map((x) => x.year)).toEqual([2014, 1996]);
  });

  it('a title ending in a number still matches with it ("blade runner 2049")', () => {
    const mv2 = [t('Blade Runner 2049', { year: 2017, votes: 10 }), t('Blade Runner', { year: 1982, votes: 10 })];
    expect(rank('blade runner 2049', [], mv2)).toEqual(['Blade Runner 2049', 'Blade Runner']);
  });

  it('a year-only query ("1917") is a title, with no year bonus', () => {
    const mv2 = [t('Some 1917 Story', { year: 1917 }), t('1917', { year: 2019 })];
    expect(rank('1917', [], mv2)).toEqual(['1917', 'Some 1917 Story']);
  });

  it('only 19xx/20xx counts as a year', () => {
    const tv = [t('Dark'), t('Zebra')];
    // "dark 2017" is split: Dark is exact, so the non-matching Zebra goes
    expect(rank('dark 2017', tv)).toEqual(['Dark']);
    // "dark 1408" is not: Dark only shares a word, no strong match, Zebra stays
    expect(rank('dark 1408', tv)).toEqual(['Dark', 'Zebra']);
  });
});

describe('title forms and normalisation', () => {
  it('drops a leading article and a trailing "(US)" / "(2012)" tag', () => {
    const tv = [t('The Office (UK)', { votes: 100 }), t('The Office (US)', { votes: 100 }), t('Officer Down', { votes: 100 })];
    expect(rank('office', tv)).toEqual(['The Office (UK)', 'The Office (US)', 'Officer Down']);
    expect(rank('dallas', [t('Dallas (2012)')])).toEqual(['Dallas (2012)']);
  });

  it('folds accents and drops apostrophes as people type them', () => {
    const tv = [t('Shogunate Tales'), t('Shōgun')];
    expect(rank('shogun', tv)).toEqual(['Shōgun', 'Shogunate Tales']);
    expect(rank('queens gambit', [t('Queen Gambit Story'), t("The Queen's Gambit")])).toEqual(["The Queen's Gambit", 'Queen Gambit Story']);
  });

  it('"&" reads as "and"', () => {
    expect(rank('law and order', [t('Order of Law'), t('Law & Order')])).toEqual(['Law & Order', 'Order of Law']);
  });

  it('the subtitle after ": " or " - " is an exact form ("maverick")', () => {
    const mv = [t('Maverick Mavericks', { votes: 10 }), t('Top Gun: Maverick', { votes: 10 }), t('Assassins Creed - Brotherhood', { votes: 10 })];
    expect(rank('maverick', [], mv)).toEqual(['Top Gun: Maverick', 'Maverick Mavericks']);
    expect(rank('brotherhood', [], mv)).toEqual(['Assassins Creed - Brotherhood']);
  });

  it("Radarr's original title is a form ('cidade de deus' → City of God)", () => {
    const mv = [t('City of God', { original_title: 'Cidade de Deus', votes: 800000 }), t('Cidade Nova', { votes: 50 })];
    expect(rank('cidade de deus', [], mv)).toEqual(['City of God', 'Cidade Nova']);
  });

  it("an original title's apostrophe splits the word: 'Anatomie d'une chute' holds no 'dune'", () => {
    const mv = [t('Anatomy of a Fall', { original_title: "Anatomie d'une chute", votes: 300000 }), t('Children of Dune', { votes: 100 })];
    expect(rank('dune', [], mv)).toEqual(['Children of Dune', 'Anatomy of a Fall']);
  });

  it('items without a title are tolerated', () => {
    expect(() => rankLookup('x', [{}], [{ title: null, votes: 3 }])).not.toThrow();
  });
});

describe('typo tolerance', () => {
  it('two edits from an 8+ letter query count ("chernobil" → Chernobyl)', () => {
    const tv = [t('Chernobyl Diaries'), t('Chernobyl', { votes: 900000 })];
    expect(rank('chernobil', tv)[0]).toBe('Chernobyl');
    expect(rank('chernoobil', [t('Chernobyl', { votes: 5 }), t('Other', { votes: 10 })])[0]).toBe('Chernobyl');
  });

  it('an adjacent swap is one edit ("drak" → Dark, more popular than the real match)', () => {
    const tv = [t('Dark', { votes: 400000 })];
    const mv = [t('Drake', { votes: 100 })];
    expect(rank('drak', tv, mv)).toEqual(['Dark', 'Drake']);
  });

  it('below 4 letters no typo counts ("drk" never reaches Dark)', () => {
    const r = rankLookup('drk', [t('Dark', { votes: 400000 })], [t('Drk', { votes: 1 })]);
    expect(titles(r)).toEqual(['Drk']);
  });

  it('a 4-letter near miss counts only when more popular than every real match ("faro" → Fargo)', () => {
    const tv = [t('Fargo', { votes: 400000 })];
    const mv = [t('Faro', { votes: 493 })];
    expect(rank('faro', tv, mv)).toEqual(['Fargo', 'Faro']);
  });

  it('...and is dropped otherwise ("dune" never means Dude)', () => {
    const mv = [t('Dude', { votes: 100 }), t('Dune', { votes: 900000 })];
    expect(rank('dune', [], mv)).toEqual(['Dune']);
  });

  it('from 5 letters a one-edit typo counts unconditionally', () => {
    const mv = [t('Fargo', { votes: 10 }), t('Fargot', { votes: 100000 })];
    // "fargt": Fargo is one edit (t≥2 via typo), Fargot one edit too; both kept, votes decide
    expect(rank('fargt', [], mv)).toEqual(['Fargot', 'Fargo']);
  });

  it('three edits from a long query is no match', () => {
    const r = rankLookup('chrnbylxx', [t('Chernobyl', { votes: 900000 })], [t('Chrnbylxx', { votes: 1 })]);
    expect(titles(r)).toEqual(['Chrnbylxx']);
  });
});

describe('non-matching results', () => {
  it('rank below real matches unless far more popular ("sunset blvd")', () => {
    const mv = [t('Sunset Strip', { votes: 1000 }), t('Sunset Boulevard', { votes: 250000 })];
    expect(rank('sunset blvd', [], mv)).toEqual(['Sunset Boulevard', 'Sunset Strip']);
    const mv2 = [t('Popular Thing', { votes: 1e7 }), t('Wars Among Stars', { votes: 10 })];
    // the unmatched one needs UNMATCHED (2) + the tier gap in log10(votes) to come first
    expect(rank('stars wars', [], mv2)).toEqual(['Popular Thing', 'Wars Among Stars']);
  });

  it('after 8 real matches the non-matching rest is dropped', () => {
    const words = ['one', 'two', 'six', 'ten', 'red', 'blue', 'gold', 'grey'];
    const real = words.map((w) => t(`Wars Among Star ${w}`));
    const mv = [...real, t('Star Trek Famous', { votes: 1e6 }), t('Star Trek Obscure')];
    const r = rank('star wars', [], mv);
    expect(r[0]).toBe('Star Trek Famous');
    expect(r).toHaveLength(9);
    expect(r).not.toContain('Star Trek Obscure');
  });

  it('with 7 real matches the rest is kept', () => {
    const words = ['one', 'two', 'six', 'ten', 'red', 'blue', 'gold'];
    const mv = [...words.map((w) => t(`Wars Among Star ${w}`)), t('Star Trek Obscure')];
    expect(rank('star wars', [], mv).at(-1)).toBe('Star Trek Obscure');
  });
});

describe('aliasesFor', () => {
  it.each([
    ['tlou', 'the last of us'],
    ['TWD', 'the walking dead'],
    ['b99', 'brooklyn nine-nine'],
    ['Brooklyn 99', 'brooklyn nine-nine'],
    ['got', 'game of thrones'],
    ['Always Sunny', "it's always sunny in philadelphia"],
    ['seven', 'se7en'],
    ['Wall-E', 'wall·e'],
    ['WALL E', 'wall·e'],
    ['walle', 'wall·e']
  ])('%s → %s', (q, alias) => {
    expect(aliasesFor(q)).toEqual([alias]);
  });

  it('no alias → []', () => {
    expect(aliasesFor('dune')).toEqual([]);
    expect(aliasesFor('')).toEqual([]);
    expect(aliasesFor(undefined)).toEqual([]);
  });

  it('rankLookup scores each result by its best-matching term', () => {
    const tv = [t('Tlou Island', { votes: 10 }), t('The Last of Us', { votes: 10 })];
    expect(rank('tlou', tv)).toEqual(['Tlou Island']);
    expect(rank(['tlou', ...aliasesFor('tlou')], tv)).toEqual(['The Last of Us', 'Tlou Island']);
  });

  it('se7en and wall·e are reached through their alias', () => {
    const mv = [t('Seven Pounds', { votes: 300000 }), t('Se7en', { votes: 100000 })];
    expect(rank('seven', [], mv)).toEqual(['Seven Pounds', 'Se7en']);
    expect(rank(['seven', ...aliasesFor('seven')], [], mv)).toEqual(['Se7en', 'Seven Pounds']);
    const mv2 = [t('Wall Street', { votes: 300000 }), t('WALL·E', { votes: 1000 })];
    expect(rank(['walle', ...aliasesFor('walle')], [], mv2)).toEqual(['WALL·E', 'Wall Street']);
  });

  // F01: rankLookup() normalised every term after the first with apostrophes
  // → spaces (Array.map's index landed in norm()'s `elide`), so an alias with
  // an apostrophe ("it's always sunny…") was only a word match (tier 2), never
  // the exact one the same text gets when typed — and a more popular partial
  // match (3× the votes) beat the real show.
  it("an alias with an apostrophe is an exact match, as when it is typed (F01)", () => {
    const tv = [
      t("It's Always Sunny in Philadelphia: Sunny Side Up", { votes: 3000 }),
      t("It's Always Sunny in Philadelphia", { votes: 1000 })
    ];
    const want = ["It's Always Sunny in Philadelphia", "It's Always Sunny in Philadelphia: Sunny Side Up"];
    expect(rank("it's always sunny in philadelphia", tv)).toEqual(want);
    expect(rank(['iasip', ...aliasesFor('iasip')], tv)).toEqual(want);
    expect(rank(['always sunny', ...aliasesFor('always sunny')], tv)).toEqual(want);
  });
});
