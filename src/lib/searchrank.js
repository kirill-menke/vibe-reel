/* Relevance ranking for the Search screen's merged show + movie lookup.
 *
 * Sonarr and Radarr each return their own ordering, and the two are not
 * comparable: Sonarr's lookup is fuzzy (for "inception" its #1 is
 * "Conception"; for "dune" it pads with "Dude" and "Dunk"), and neither
 * accounts for popularity (The Office (US) is 9th behind six regional
 * remakes). So every result is scored on one scale:
 *
 *   TIER_BONUS[match tier]  +  log10(votes + 1)  +  1 if already in the library
 *                           +  YEAR_BONUS if the query ends in the item's year
 *
 * Tiers: 4 exact title · 3 title starts with the query · 2 every query word
 * present, or within a typo or two of the query · 1 some query word present ·
 * 0 fuzzy-only. A title matches through any of its forms (see forms()), and a
 * trailing year in the query ("fargo 1996") picks the release instead of
 * being matched as a title word. The bonuses (below) let
 * a much more popular prefix match beat an obscure exact one ("Dune: Part
 * Two" over a 2020 short also called "Dune") while an exact title still beats
 * one that is merely a little more popular ("casino" → Casino, not Casino
 * Royale). `votes` is an IMDb-scale count from reel-api;
 * without it (older backend) the ranking degrades to tier, then upstream order.
 *
 * Once any exact or prefix match exists, fuzzy-only results are dropped, and a
 * result that doesn't match (tier < 2) ranks below the real matches unless it
 * is far more popular — see the end of rankLookup(). */

/* Words that say nothing about which title is meant: "the bear" must not
 * partially match "The Beat" on "the". */
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to']);

/* Lowercase, fold accents (Shōgun → shogun, ³ → 3), drop apostrophes
 * ("Queen's" → queens, as people type it), drop a trailing disambiguation tag
 * like "(US)" or "(2012)", punctuation to spaces, and a leading article — so
 * "The Office (US)" and "office" compare equal. */
/**
 * @param {string | null | undefined} s
 * @param {boolean} [elide] apostrophes → space instead of dropped.
 * @returns {string}
 */
function norm(s, elide = false) {
  return (s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, elide ? ' ' : '')
    .replace(/(\s*\((\d{4}|[a-z]{2})\))+\s*$/, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

/* Title forms an item can match: the title; each segment after a ": " or
 * " - " (the subtitle alone — "maverick", "brotherhood" — is as exact a query
 * as the full title); and Radarr's original title ("cidade de deus" → City of
 * God). Radarr's alternate-title lists were measured too and hurt: they carry
 * loose regional titles ("A Queda" for Dead Space: Downfall). */
/** @param {VR.RankItem} it @returns {string[]} */
function forms(it) {
  const f = [norm(it.title)];
  for (const seg of (it.title || '').split(/\s*:\s+|\s+-\s+/).slice(1)) f.push(norm(seg));
  /* An original title's apostrophes are elisions far more often than
   * possessives (d'une, l'amour, dell'amore), so they split the word instead of
   * joining it: "Anatomie d'une chute" must not hold the word "dune". */
  if (it.original_title) f.push(norm(it.original_title, true));
  return f;
}

/** @param {string} q @param {string} t @returns {number} 0–4 */
function tier(q, t) {
  if (!q || !t) return 0;
  if (t === q) return 4;
  if (t.startsWith(q)) return 3;
  const tw = t.split(' ');
  const qw = q.split(' ').filter((w) => !STOP.has(w));
  if (!qw.length) return 0;
  /* Every query word must start a title word. The lookup fires on a debounce
   * while typing, so the last word may be half-typed ("breaking ba" →
   * "Breaking Bad"), and people abbreviate earlier ones too ("star wa emp"). */
  const hit = qw.map((w) => tw.some((x) => x.startsWith(w)));
  if (hit.every(Boolean)) return 2;
  if (hit.some(Boolean)) return 1;
  return 0;
}

/* Optimal-string-alignment edit distance (adjacent swaps count as one), capped:
 * returns max + 1 as soon as the distance is known to exceed `max`. */
/** @param {string} a @param {string} b @param {number} max @returns {number} */
function dist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  /** @type {number[] | null} */
  let p2 = null;
  let p = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const c = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + cost);
      if (p2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        c[j] = Math.min(c[j], p2[j - 2] + 1);
      low = Math.min(low, c[j]);
    }
    if (low > max) return max + 1;
    p2 = p;
    p = c;
  }
  return p[b.length];
}

/* A title one or two typos from the query ("chernobil" → Chernobyl, "drak" →
 * Dark; below five letters only conditionally, see rankLookup). Applies even when some title matches the query exactly: "faro" must
 * still reach Fargo past a 493-vote film called Faro — votes then decide, and
 * Sonarr's fuzzy padding (Dude for "dune") simply ranks below the real match. */
/** @param {string} q @param {string} title @returns {boolean} */
function typo(q, title) {
  const max = q.length >= 8 ? 2 : q.length >= 4 ? 1 : 0;
  return max > 0 && dist(q, norm(title), max) <= max;
}

/* Score bonus per match tier, in log10(votes) units: a gap of 1 between two
 * tiers is worth ten times the votes. Grid-searched offline against
 * 4,393 lookups generated from the IMDb Top 250 movies and shows — exact,
 * lowercase, article-less, with year, half-typed, original-language, subtitle,
 * keyword and typo variants. The optimum is flat; the one step it pins down is
 * exact over prefix at 0.5–1: an exact title wins unless the other has ~10×
 * the votes ("gump" → Forrest Gump, not a 337-vote "Gump"; "psycho" → Psycho,
 * not American Psycho). YEAR_BONUS was insensitive across 1–3. */
export const TIER_BONUS = [0, 1, 2, 2.5, 3.5];
const YEAR_BONUS = 2;
/* Real matches that make the non-matching rest of the lookup redundant. */
const ENOUGH = 8;
/* Extra penalty for a result that doesn't match the query, in log10(votes). */
const UNMATCHED = 2;
/* Query length from which a one-edit typo counts unconditionally. */
const SHORT_TYPO = 5;

/* Shorthands and spellings the lookup can't resolve on its own. Sonarr/Radarr
 * match words, so "got" finds You've Got Mail and "seven" never reaches Se7en;
 * the Search screen looks these up *in addition to* what was typed. Keys are
 * norm()'d, so "Wall-E", "wall e" and "WALL E" all hit one entry. */
/** @type {Record<string, string>} */
const ALIASES = {
  got: 'game of thrones',
  hotd: 'house of the dragon',
  lotr: 'the lord of the rings',
  himym: 'how i met your mother',
  tbbt: 'the big bang theory',
  iasip: "it's always sunny in philadelphia",
  'always sunny': "it's always sunny in philadelphia",
  tlou: 'the last of us',
  twd: 'the walking dead',
  bcs: 'better call saul',
  svu: 'law & order: special victims unit',
  b99: 'brooklyn nine-nine',
  'brooklyn 99': 'brooklyn nine-nine',
  'parks and rec': 'parks and recreation',
  seven: 'se7en',
  'wall e': 'wall·e',
  walle: 'wall·e'
};

/* Extra lookup terms for a typed query (empty when none apply). */
/** @param {string} query @returns {string[]} */
export function aliasesFor(query) {
  const a = ALIASES[norm(query)];
  return a ? [a] : [];
}

/* queries: the typed query, or [typed, ...aliases] — each result is scored by
 * its best-matching term. tv, mv: the lookup results in upstream order.
 * Returns one ranked list; ties keep upstream order, shows before movies. */
/* "fargo 1996", "dark 2017": a trailing year picks the release rather than
 * being a title word. Returns [query without it, year], or [q, null] when
 * there is none or the query is only a year ("1917"). */
/** @param {string} q @returns {[string, number | null]} */
function splitYear(q) {
  const m = /^(.+) ((?:19|20)\d\d)$/.exec(q);
  return m ? [m[1], Number(m[2])] : [q, null];
}

/** @template {VR.RankItem} T @param {string | string[]} queries @param {T[]} tv @param {T[]} mv @param {number[]} [bonus] @returns {T[]} */
export function rankLookup(queries, tv, mv, bonus = TIER_BONUS) {
  const typed = (Array.isArray(queries) ? queries : [queries]).map((q) => norm(q));
  const [text, year] = splitYear(typed[0]);
  // With and without the year: "blade runner 2049" is itself a title.
  const qs = year ? [...typed, text] : typed;
  const items = [...tv, ...mv];
  const scored = items.map((it, n) => {
    const fs = forms(it);
    let t = Math.max(...qs.flatMap((q) => fs.map((f) => tier(q, f))));
    const fz = t < 2 && typo(text, it.title);
    if (fz) t = 2;
    return {
      it,
      t,
      n,
      fz,
      s:
        bonus[t] +
        Math.log10((it.votes || 0) + 1) +
        (it.added ? 1 : 0) +
        (year && it.year && Math.abs(it.year - year) <= 1 ? YEAR_BONUS : 0)
    };
  });
  /* One edit away from a four-letter query is another word as often as a
   * typo: "faro" means Fargo, but "dune" doesn't mean Dude. Such a near miss
   * counts as a match only when it is more popular than every real match —
   * i.e. when it is the likelier reading of what was typed. */
  if (text.length < SHORT_TYPO) {
    const best = Math.max(0, ...scored.filter((r) => r.t >= 2 && !r.fz).map((r) => r.it.votes || 0));
    for (const r of scored)
      if (r.fz && (r.it.votes || 0) <= best) {
        r.t = 0;
        r.s -= bonus[2];
      }
  }
  /* A result that doesn't match the query — Sonarr/Radarr's fuzzy padding,
   * or a title sharing only some of its words — ranks below the real matches
   * unless it is a lot more popular (UNMATCHED in log10(votes) on top of the
   * tier gap): "sunset blvd" still finds Sunset Boulevard, "Anatomy of a Fall"
   * no longer sits between the Dunes. Once ENOUGH real matches are listed,
   * the non-matching rest after them is dropped, and anything sharing no word
   * at all goes as soon as an exact or prefix match exists. */
  for (const r of scored) if (r.t < 2) r.s -= UNMATCHED;
  const strong = scored.some((r) => r.t >= 3);
  const ranked = scored
    .filter((r) => !strong || r.t > 0)
    .sort((a, b) => b.s - a.s || a.n - b.n);
  let real = 0;
  return ranked.filter((r) => (r.t >= 2 ? ++real : real < ENOUGH)).map((r) => r.it);
}
