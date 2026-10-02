import { cfg } from './config.js';
import { api, qs } from './api.js';
import { ticksToSec } from './format.js';

/* Where "this stretch is the intro / recap / preview" (and "the credits start
 * here") comes from.
 *
 * Two sources, tried in order of trust:
 *
 * 1. **Jellyfin's Media Segments API** (`/MediaSegments/{id}`, server 10.10+).
 *    It is the canonical home for an Intro/Outro/Recap marker, but the server
 *    only ever *serves* segments; nothing in core produces them, a provider
 *    plugin has to. **Intro Skipper** 1.10.11.23 is installed on the NAS for
 *    exactly that: it chroma-fingerprints each season and finds the stretch
 *    every episode shares, then writes it here. So this is the primary path —
 *    it covers whatever the fingerprinter can find, which is most shows with a
 *    real title sequence, and it keeps up with new episodes on its own.
 *
 * 2. **A Matroska chapter named "Intro"**, read off `item.Chapters`. Measured
 *    over the 63 episodes on the NAS, 3 have one: an episode of one drama
 *    (2:30–3:47) and two of another (0:00–1:32). Everything else ships generic
 *    "Chapter 01…" marks, and a chapter *boundary* carries no notion of what
 *    the chapter is — guessing an intro from one is how you get a skip button
 *    that throws away the cold open. So unnamed chapters are ignored outright.
 *    This is the safety net for an episode added since the last analysis run,
 *    not the main path — the plugin covers all 63 today.
 *
 * The button is therefore honest by construction: it appears only when the data
 * actually says there is an intro here, and stays away otherwise.
 *
 * **Previews** (a next-episode teaser) ride the same two paths as a `Preview`
 * segment or a named chapter, and get the same chip, labelled by kind.
 *
 * **Recaps do not come from Jellyfin segments.** Intro Skipper's recap
 * detector looks for a sting shared across a season (the HBO / Netflix / "An
 * Apple Original" card) and calls everything from 0:00 to the last black frame
 * before the intro a recap. Measured 2026-09-28: of its 26 Recap segments on
 * the NAS, the ones checked frame by frame (trickplay sheets) on five
 * episodes of three different series were studio card + *cold open* — a
 * "Skip recap" there throws away the scene the episode opens on. Only one
 * series' were real. So a recap comes from a chapter named like one,
 * or from **IntroDB** (communityMarkers() below): hand-marked by viewers, and
 * it agreed with the one real case (1–35 s vs 0–36 s on one episode).
 * IntroDB also fills in an intro or credits Jellyfin has nothing for — a new
 * episode before Intro Skipper's nightly run, say.
 *
 * The **credits** come from the same two places — an `Outro` segment, or a
 * chapter named "Credits"/"Outro"/"Ending" — and drive when the Up Next card
 * appears (player.svelte.js). No credits data is a normal answer there too: the
 * card then falls back to the last seconds of the file.
 *
 * ⚠️ Measured 2026-09-27: after the 12.1 upgrade the server returns **no
 * segments at all** — Intro Skipper 1.10.11.24 reports NotSupported, and the
 * 12.x build (12.0.4.0) is installed but waits for a Jellyfin restart. Until it
 * has run once, only the chapter path can produce anything. */


/* Chapter names seen in the wild for an opening title sequence. Anchored, so a
 * plot-summary chapter title that merely *contains* "opening" doesn't match. */
const INTRO_NAME =
  /^\s*(intro|introduction|opening|opening\s+(credits|titles)|main\s+titles?|title\s+sequence|theme(\s+song)?|op)\s*$/i;
/* "Previously on…" and the next-episode teaser. Anchored like the others; a
 * "Previously on <Show>" chapter title is the common muxed form. */
const RECAP_NAME = /^\s*(recap|previously(\s+on\b.*)?|summary)\s*$/i;
const PREVIEW_NAME = /^\s*(preview|next\s+(time|episode)|next\s+on\b.*|sneak\s+peek|teaser)\s*$/i;
/* Same idea for the closing sequence ("ED" is the anime convention). */
const CREDITS_NAME =
  /^\s*(credits|end\s+credits|ending(\s+(credits|theme|titles))?|closing(\s+credits)?|end\s+titles|outro|ed)\s*$/i;

/* Sanity bounds. A title sequence is tens of seconds and sits near the front of
 * the episode — anything outside this is a mislabelled chapter, not an intro,
 * and skipping it would eat real content. */
const MIN_LEN = 5;
const MAX_LEN = 300;
const MAX_START = 1200;
/* A recap opens the episode, before or right after a short cold open. */
const MAX_RECAP_START = 600;

/* Credits: a short tail in the second half of the file. The lower bound on
 * length keeps a stray end-of-episode chapter mark from cutting off the last
 * scene. */
const MIN_CREDITS = 10;

/* Resolve { skips, credits } for an item. `skips` is every stretch the Skip chip
 * offers, sorted by start — each a { kind: 'intro'|'recap'|'preview', start,
 * end, from } window, at most one per kind — and `credits` the closing window
 * or null. Never rejects: no marker is the normal answer, and a failed lookup
 * must not touch playback. One segments request serves all of them; the
 * chapters are only read when something is missing — from `withChapters`, a
 * promise of this item fetched with Fields=Chapters that the player already
 * has in flight for the scrubber, so this costs no request of its own. */
export async function findMarkers(itemId, item, withChapters) {
  const runtime = ticksToSec(item && item.RunTimeTicks) || 0;
  const segs = await fromSegments(itemId);
  const kinds = [
    { kind: 'intro', type: 'Intro', re: INTRO_NAME, check: saneIntro },
    // type: null — never from a Jellyfin segment, see the header.
    { kind: 'recap', type: null, re: RECAP_NAME, check: saneRecap },
    // A teaser may be the last chapter and run to the end of the file.
    { kind: 'preview', type: 'Preview', re: PREVIEW_NAME, check: saneShort, tail: true }
  ];
  const found = kinds.map((k) => pick(segs, k.type, k.check));
  let credits = pick(segs, 'Outro', (s) => saneCredits(s, runtime));
  if (found.includes(null) || !credits) {
    const marks = await chapterMarks(itemId, item, withChapters);
    kinds.forEach((k, i) => {
      if (!found[i]) found[i] = fromChapters(marks, k.re, (k.tail && runtime) || null, k.check);
    });
    if (!credits) credits = fromChapters(marks, CREDITS_NAME, runtime, (s) => saneCredits(s, runtime));
  }
  const skips = [];
  kinds.forEach((k, i) => found[i] && skips.push({ kind: k.kind, ...found[i] }));
  skips.sort((a, b) => a.start - b.start);
  return { skips, credits };
}

/* IntroDB's answer for an episode (mlSegments), shaped like findMarkers():
 * { skips, credits }, through the same sanity checks. The player only takes
 * from it what findMarkers() left empty. */
export function communityMarkers(r, runtime) {
  const win = (v) => (v && v.end > v.start ? { start: v.start, end: v.end, from: 'introdb' } : null);
  const skips = [];
  const recap = r && saneRecap(win(r.recap));
  if (recap) skips.push({ kind: 'recap', ...recap });
  const intro = r && saneIntro(win(r.intro));
  if (intro) skips.push({ kind: 'intro', ...intro });
  skips.sort((a, b) => a.start - b.start);
  const out = r && win(r.outro);
  return { skips, credits: out ? saneCredits(out, runtime || 0) : null };
}

function fromSegments(itemId) {
  return api('/MediaSegments/' + itemId)
    .then((r) => (r && r.Items) || [])
    .catch(() => []);
}

/* The first segment of that type that passes the sanity check — not just the
 * first one, which may be a bogus window hiding a valid later one. */
function pick(segs, type, check) {
  if (!type) return null;
  for (const seg of segs) {
    if (seg.Type !== type) continue;
    const ok = check({ start: ticksToSec(seg.StartTicks), end: ticksToSec(seg.EndTicks), from: 'segment' });
    if (ok) return ok;
  }
  return null;
}

async function chapterMarks(itemId, item, withChapters) {
  let ch = item && item.Chapters;
  if (!ch && withChapters) ch = ((await withChapters.catch(() => null)) || {}).Chapters;
  if (!ch) {
    /* ITEM_FIELDS deliberately doesn't carry Chapters (see the payload-size note
     * in api.js), and the single-item endpoint takes no Fields, so ask for
     * exactly this one field on exactly this one id. */
    const r = await api(
      '/Items' + qs({ Ids: itemId, UserId: cfg.userId, Fields: 'Chapters', Recursive: true, Limit: 1 })
    ).catch(() => null);
    ch = (((r && r.Items) || [])[0] || {}).Chapters;
  }
  if (!ch || ch.length < 2) return [];
  return ch
    .map((c) => ({ at: ticksToSec(c.StartPositionTicks), name: c.Name || '' }))
    .sort((a, b) => a.at - b.at);
}

/* Chapters carry a start and no end, so a chapter ends where the next one
 * begins — an "Intro" with nothing after it has no measurable end and is out.
 * The credits are the exception: they may be the last chapter, in which case
 * they run to the end of the file (`tailEnd`). */
function fromChapters(marks, re, tailEnd, check) {
  // Every matching chapter in order, first sane one wins (see pick()).
  for (let i = 0; i < marks.length; i++) {
    if (!re.test(marks[i].name)) continue;
    const end = marks[i + 1] ? marks[i + 1].at : tailEnd;
    const ok = end ? check({ start: marks[i].at, end, from: 'chapter' }) : null;
    if (ok) return ok;
  }
  return null;
}

function saneIntro(seg) {
  if (!seg) return null;
  const len = seg.end - seg.start;
  if (!(len >= MIN_LEN && len <= MAX_LEN) || !(seg.start >= 0 && seg.start <= MAX_START)) return null;
  return seg;
}

function saneShort(seg) {
  if (!seg) return null;
  const len = seg.end - seg.start;
  return len >= MIN_LEN && len <= MAX_LEN && seg.start >= 0 ? seg : null;
}

function saneRecap(seg) {
  return saneShort(seg) && seg.start <= MAX_RECAP_START ? seg : null;
}

function saneCredits(seg, runtime) {
  if (!seg) return null;
  if (!(seg.end - seg.start >= MIN_CREDITS)) return null;
  if (runtime && seg.start < runtime / 2) return null;
  return seg;
}
