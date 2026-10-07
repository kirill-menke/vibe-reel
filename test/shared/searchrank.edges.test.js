/* searchrank.js: title normalisation, forms and the typo rules at the edges
 * the mutation run (oracle-mutants-api) showed open. Each case sets an exact
 * (or real) match against a more popular competitor, so the order flips the
 * moment the rule it names stops holding:
 *
 * - "(US)"/"(2012)" tags are dropped, however many and however spaced, so
 *   "The Office (US)" is an EXACT match for "office";
 * - leading punctuation is trimmed before the article goes ("(500) Days of
 *   Summer"), and only a LEADING article is dropped ("Cobra Kai" keeps its "a");
 * - apostrophes join words in titles ("Schindler's" → schindlers);
 * - only the segments AFTER ": " are extra forms; the original title is a form;
 * - query words must START title words (half-typed "star wa emp");
 * - typo distance: an adjacent swap is one edit, two swaps are two; 8+ letters
 *   allow two edits;
 * - a 4-letter near miss counts only when it is more popular than every REAL
 *   (tier ≥ 2) match — and when it doesn't, it is pushed below them. */
import { describe, it, expect } from 'vitest';
import { rankLookup, aliasesFor } from '../../src/lib/searchrank.js';

const t = (title, o = {}) => ({ title, ...o });
const rank = (q, tv, mv = []) => rankLookup(q, tv, mv).map((x) => x.title);

/* `exact` (1000 votes) against a prefix match with 3× the votes: the exact one
 * leads only if it really is tier 4 (3.5 + 3 vs 2.5 + 3.48). */
const exactLeads = (q, exact, prefix) => expect(rank(q, [t(prefix, { votes: 3000 })], [t(exact, { votes: 1000 })])[0]).toBe(exact);

describe('disambiguation tags are not part of the title', () => {
  it.each([
    ['office', 'The Office (US)', 'Office Space'],
    ['dune', 'Dune (2021)', 'Dune Messiah'],
    ['shameless', 'Shameless (US) (2011)', 'Shameless Hour'],
    ['doctor who', 'Doctor Who(2005)', 'Doctor Who Confidential']
  ])('%j: %j is exact', (q, exact, prefix) => exactLeads(q, exact, prefix));
});

describe('punctuation and articles', () => {
  it('leading punctuation is trimmed: "(500) Days of Summer" is exact', () => {
    exactLeads('500 days of summer', '(500) Days of Summer', '500 Days of Summer: Behind the Scenes');
  });

  it('apostrophes join words: "schindlers list" is exact for "Schindler\'s List"', () => {
    exactLeads('schindlers list', "Schindler's List", 'Schindlers List: Making Of');
  });

  it('only a leading article is dropped: "Cobra Kai" stays a prefix match for "cobra"', () => {
    expect(rank('cobra', [t('Cobra Kai', { votes: 1000 })], [t('Cobra', { votes: 10 })])).toEqual(['Cobra Kai', 'Cobra']);
  });
});

describe('title forms', () => {
  it('the part before ": " is not a form of its own (Dune: Part Two is a prefix match, not exact)', () => {
    expect(rank('dune', [], [t('Dune: Part Two', { votes: 1000 }), t('Dune', { votes: 1000 })])).toEqual(['Dune', 'Dune: Part Two']);
  });

  it("the original title is a form ('cidade de deus' → City of God over a popular partial match)", () => {
    const mv = [t('Cidade Nova', { votes: 100000 }), t('City of God', { votes: 1000, original_title: 'Cidade de Deus' })];
    expect(rank('cidade de deus', [], mv)).toEqual(['City of God', 'Cidade Nova']);
  });

  it('half-typed query words must start title words', () => {
    const mv = [t('Star Trek'), t('Star Wars: Episode V - The Empire Strikes Back')];
    expect(rank('star wa emp', [], mv)).toEqual(['Star Wars: Episode V - The Empire Strikes Back', 'Star Trek']);
  });
});

describe('typo distance', () => {
  const vs = (q) => rank(q, [t('Dexter', { votes: 1000 })], [t('The Exorcist', { votes: 5000 })]);

  it('one adjacent swap is one edit: "dexetr" → Dexter', () => {
    expect(vs('dexetr')).toEqual(['Dexter', 'The Exorcist']);
  });

  it('two swaps are two edits, too many for a 6-letter query: "dxeetr" is no Dexter', () => {
    expect(vs('dxeetr')).toEqual(['The Exorcist', 'Dexter']);
  });

  it('8 letters allow two edits: "chrnobil" → Chernobyl', () => {
    expect(rank('chrnobil', [t('Chicago Fire', { votes: 10000 }), t('Chernobyl', { votes: 1000 })])).toEqual(['Chernobyl', 'Chicago Fire']);
  });
});

describe('4-letter near misses', () => {
  it('a near miss less popular than a real every-word match is pushed below it, even from the library', () => {
    // "dune" doesn't mean Dude: Children of Dune (tier 2, 1000 votes) is the real match
    const tv = [t('Dude', { votes: 900, added: true }), t('Children of Dune', { votes: 1000 })];
    expect(rank('dune', tv)).toEqual(['Children of Dune', 'Dude']);
  });

  it('only real matches set the bar: a popular unmatched result does not demote the near miss ("faro" → Fargo)', () => {
    expect(rank('faro', [t('Pharaoh', { votes: 5000 })], [t('Fargo', { votes: 1000 })])).toEqual(['Fargo', 'Pharaoh']);
  });
});

describe('stop words never decide a match', () => {
  // "the bear" must not count "the" as a word to find: a query word that says
  // nothing is skipped, so 'Dead Night' still has every query word (tier 2)
  // and stays above a far more popular one-word match.
  it.each(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to'])('"night %s dead" → Dead Night first', (w) => {
    const tv = [t('Night Shift', { votes: 1000 }), t('Dead Night', { votes: 10 })];
    expect(rank(`night ${w} dead`, tv)).toEqual(['Dead Night', 'Night Shift']);
  });
});

describe('aliasesFor: every shorthand', () => {
  it.each([
    ['hotd', 'house of the dragon'], ['lotr', 'the lord of the rings'], ['himym', 'how i met your mother'],
    ['tbbt', 'the big bang theory'], ['iasip', "it's always sunny in philadelphia"], ['bcs', 'better call saul'],
    ['svu', 'law & order: special victims unit'], ['parks and rec', 'parks and recreation']
  ])('%s → %s', (q, alias) => {
    expect(aliasesFor(q)).toEqual([alias]);
  });
});
