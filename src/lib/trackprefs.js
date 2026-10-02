/* Per-series memory of the audio / subtitle choice.
 *
 * Picking a track in the player menu is remembered for the series, and every
 * later episode — started from the series page, Continue Watching or the Up
 * Next roll-on, which all end in playItem() — opens on the equivalent track.
 * Without a remembered choice the defaults are exactly describeTracks()'s.
 *
 * Remembered by MEANING, never by stream index: the index of "English" moves
 * between releases and even within one (one series' first episode carries two
 * commentary tracks, its third one, so its subtitles start at 4 in one file and
 * 3 in the next).
 *
 *   audio  { lang }                        → that language, and within it the
 *                                            usual score() pick (DD+/Atmos first,
 *                                            commentary last)
 *   subs   { off: true }                   → None, even where the file flags a
 *                                            default track (whole series ship
 *                                            with English SDH as default)
 *          { lang, forced, sdh, burn }     → that language with the same forced-
 *                                            ness; SDH-ness only breaks ties
 *
 * Commentary-ness is deliberately NOT carried over: a commentary is an extra of
 * one episode (different speakers each time, most episodes have none), so
 * choosing one says "this language", not "commentary from now on".
 *
 * If an episode doesn't have the remembered language, that dimension falls back
 * to today's default — never to some other random track.
 *
 * Why localStorage and not Jellyfin's RememberAudioSelections /
 * RememberSubtitleSelections: those make the server store the raw stream
 * *indexes* the client reports, per *item*, and feed them back through
 * PlaybackInfo's DefaultAudio/SubtitleStreamIndex. That neither carries across
 * episodes nor survives an index shift, "None" is indistinguishable from
 * "never chose" under SubtitleMode Default, and this app computes its own
 * defaults (the DD+-over-TrueHD rule) instead of reading the server's anyway.
 * The client config lives in localStorage already; this is one more key per
 * account (see storeKey below) — each Jellyfin user keeps their own choices.
 *
 * Series only. A movie has nothing after it to inherit the choice, and a global
 * "last language" would leak one film's dub into every unrelated title — the
 * English / anime-Japanese default is the better guess there. Pending streams
 * (watch-while-downloading) have no Jellyfin SeriesId, so they neither read nor
 * write a preference. */
import { langKey, isAtmos, isCommentary, isSdh, isBurnCodec, score, describeTracks, pickDefaultSub } from './tracks.js';

import { cfg } from './config.js';

/* Per Jellyfin account: `reel.trackPrefs.<userId>` = { [SeriesId]: { a, s, t } }.
 * One key per user rather than one nested map, so an account's prefs are read
 * and capped on their own and a corrupted entry can only cost that account.
 * The user is read from cfg at call time, so an account switch takes effect on
 * the very next playItem(); with nobody signed in, reads are empty and writes
 * are dropped. */
const LEGACY = 'reel.trackPrefs';   // pre-accounts: one map shared by everyone
const MAX_SERIES = 300;   // per account; oldest-touched entries are dropped past this

/* The series an item belongs to, or null when there is nothing to remember
 * against (movies, synthetic pending items). */
export function prefKey(item) {
  return item && item.Type === 'Episode' && item.SeriesId ? item.SeriesId : null;
}

function storeKey() {
  return cfg.userId ? LEGACY + '.' + cfg.userId : null;
}

function parse(raw) {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/* One-time move of the shared map to whoever is signed in when it is first
 * touched (normally module load, right after the update). Other accounts start
 * empty. Entries the account already has win; the legacy key is removed
 * afterwards, which is what makes this run once. */
function migrate(key) {
  try {
    const raw = localStorage.getItem(LEGACY);
    if (raw == null) return;
    const old = parse(raw);
    if (Object.keys(old).length) {
      const mine = parse(localStorage.getItem(key));
      saveAll(key, { ...old, ...mine });
    }
    localStorage.removeItem(LEGACY);
  } catch {}
}

function loadAll(key) {
  try {
    return parse(localStorage.getItem(key));
  } catch {
    return {};
  }
}

function saveAll(key, all) {
  try {
    const ids = Object.keys(all);
    if (ids.length > MAX_SERIES) {
      const t = (id) => (all[id] && typeof all[id] === 'object' && all[id].t) || 0;
      ids.sort((a, b) => t(a) - t(b));
      for (const id of ids.slice(0, ids.length - MAX_SERIES)) delete all[id];
    }
    localStorage.setItem(key, JSON.stringify(all));
  } catch {}
}

/* The signed-in account's storage key, migrated; null when nobody is. */
function userKey() {
  const key = storeKey();
  if (key) migrate(key);
  return key;
}

userKey();

export function trackPrefs(item) {
  const k = prefKey(item);
  const key = k && userKey();
  if (!key) return null;
  const e = loadAll(key)[k];
  return e && typeof e === 'object' ? e : null;
}

function update(item, dim, value) {
  const k = prefKey(item);
  const key = k && userKey();
  if (!key) return;
  const all = loadAll(key);
  // A non-object entry (hand-edited / corrupted storage) would make the
  // assignment below throw — and pmSetAudio/pmSetSub call this *before*
  // applying the switch, so the menu pick would silently do nothing.
  const e = all[k] && typeof all[k] === 'object' ? all[k] : {};
  e[dim] = value;
  e.t = Date.now();
  all[k] = e;
  saveAll(key, all);
}

function streamsOf(src, type) {
  return ((src && src.MediaStreams) || []).filter((s) => s.Type === type);
}

/* Called from the player menu only — computed defaults are never remembered. */
export function rememberAudio(item, src, index) {
  const s = streamsOf(src, 'Audio').find((x) => x.Index === index);
  if (s) update(item, 'a', { lang: langKey(s.Language) });
}

export function rememberSub(item, src, index) {
  if (index < 0) return update(item, 's', { off: true });
  const s = streamsOf(src, 'Subtitle').find((x) => x.Index === index);
  if (s) update(item, 's', { lang: langKey(s.Language), forced: !!s.IsForced, sdh: isSdh(s), burn: isBurnCodec(s.Codec) });
}

/* The remembered language's best track by the usual score() — the language
 * bonus is equal for every candidate, so codec/Atmos/commentary decide. */
export function matchAudio(src, pref) {
  if (!pref) return null;
  const c = streamsOf(src, 'Audio')
    .filter((s) => langKey(s.Language) === pref.lang)
    .map((s) => ({ index: s.Index, codec: (s.Codec || '').toLowerCase(), atmos: isAtmos(s), commentary: isCommentary(s), lang: '' }));
  if (!c.length) return null;
  c.sort((a, b) => score(b) - score(a));
  return c[0].index;
}

/* -1 for a remembered None; a stream index; or null = no usable match. A
 * VobSub/DVB track (burn-in transcode) is only ever chosen when the remembered
 * choice was one too — the same "never start a transcode unasked" rule
 * describeTracks() applies to file defaults — and a client-side format in the
 * same language wins over it even then. */
export function matchSub(src, pref) {
  if (!pref) return null;
  if (pref.off) return -1;
  const c = streamsOf(src, 'Subtitle').filter(
    (s) => langKey(s.Language) === pref.lang && !!s.IsForced === !!pref.forced && (pref.burn || !isBurnCodec(s.Codec))
  );
  if (!c.length) return null;
  // Client-side format outranks the SDH match: with the weights the other way
  // round, a remembered plain DVD track picked the next file's plain VobSub over
  // its English SDH SRT and started a burn-in transcode the SRT made needless.
  const rank = (s) => (isBurnCodec(s.Codec) ? 0 : 4) + (isSdh(s) === !!pref.sdh ? 2 : 0) + (s.IsDefault ? 1 : 0);
  c.sort((a, b) => rank(b) - rank(a) || a.Index - b.Index);
  return c[0].Index;
}

/* The tracks an item should start on: the series' remembered choice where it
 * matches this file, today's describeTracks() default otherwise — per
 * dimension, so a remembered "subs off" still leaves audio on its default. */
export function startTracks(src, item) {
  const t = describeTracks(src, item);
  const p = trackPrefs(item);
  const a = p ? matchAudio(src, p.a) : null;
  const s = p ? matchSub(src, p.s) : null;
  // The subtitle default depends on the audio language (SET.subMode 'auto'), so
  // a remembered audio choice re-derives it against that track.
  return { audio: a ?? t.defaultAudio, sub: s ?? (a != null ? pickDefaultSub(src, a) : t.defaultSub) };
}
