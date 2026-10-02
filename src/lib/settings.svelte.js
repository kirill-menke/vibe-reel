/* App-wide viewer preferences, edited from the avatar menu's Settings screen.
 *
 * A per-TV convenience, so plain localStorage like the rest of the client config
 * (`reel.settings`). Read `SET.*` anywhere; write only through setSetting(), which
 * persists. Per-series track memory (trackprefs.js) still wins over these — they
 * are the defaults for a title nothing has been remembered for.
 *
 *   audioLang     preferred audio language (ISO 639-2, 'eng'); the anime→Japanese
 *                 rule in tracks.js still applies on top
 *   subLang       preferred subtitle language (ISO 639-2, 'eng')
 *   subMode       'auto'   → forced subs, or full subs when the audio isn't in
 *                             subLang (a container "default" flag alone is ignored)
 *                 'always' → subLang subtitles whenever the file has them
 *                 'off'    → only forced subtitles
 *   autoplayNext  Up Next rolls on by itself when its countdown ends
 *   autoSkipIntro skip the intro without waiting for OK on the chip
 *   autoSkipRecap the same for "Previously on…" recaps and next-episode previews
 *   subSize       subtitle size in % of the default (player subtitle menu, SUB_SIZE_*) */

const KEY = 'reel.settings';

/* The languages the Settings menu offers, stored as the code Jellyfin reports in
 * MediaStream.Language. That is ffprobe's tag, which for Matroska is ISO 639-2/B —
 * the *bibliographic* codes: 'ger' not 'deu', 'fre' not 'fra', 'dut', 'chi', 'cze'.
 * Some muxers write the /T form or a 2-letter code instead; tracks.js collapses
 * those aliases onto one key before comparing, so either side may use any of them. */
export const LANGS = [
  ['eng', 'English'],
  ['ger', 'German'],
  ['fre', 'French'],
  ['spa', 'Spanish'],
  ['ita', 'Italian'],
  ['por', 'Portuguese'],
  ['dut', 'Dutch'],
  ['swe', 'Swedish'],
  ['pol', 'Polish'],
  ['rus', 'Russian'],
  ['tur', 'Turkish'],
  ['jpn', 'Japanese'],
  ['kor', 'Korean'],
  ['chi', 'Chinese']
];

export const SUB_MODES = [
  ['auto', 'Automatic', 'Forced subtitles, plus full ones when the audio isn’t in your subtitle language.'],
  ['always', 'Always', 'Subtitles in your language whenever the file has them.'],
  ['off', 'Off', 'Only forced subtitles — signs and foreign-language lines.']
];

export const DEFAULTS = {
  audioLang: 'eng',
  subLang: 'eng',
  subMode: 'auto',
  autoplayNext: true,
  autoSkipIntro: false,
  autoSkipRecap: false,
  subSize: 100
};

export const SUB_SIZE_MIN = 60;
export const SUB_SIZE_MAX = 160;
export const SUB_SIZE_STEP = 10;

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return v && typeof v === 'object' ? { ...DEFAULTS, ...v } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export const SET = $state(load());

export function setSetting(key, value) {
  if (!(key in DEFAULTS)) return;
  SET[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify($state.snapshot(SET)));
  } catch {}
}
