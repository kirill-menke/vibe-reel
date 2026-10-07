/* Shared, framework-free helpers for the title pages (workstream D):
 * phone-style formatting ("1 h 59 min", "E4 · 50 min"), the tech badge row,
 * the details list and the slow-link hint. The data logic is the TV's
 * (tracks.js heroBadges / TechGrid); only the wording is the phone design's. */
import { TICKS } from '$lib/api.js';
import { fmtDate } from '$lib/format.js';
import { getQualityCap } from '$lib/player.svelte.js';
import {
  pickSource,
  videoStream,
  describeTracks,
  streamByIndex,
  chLayout,
  langName,
  audioLabel,
  isSdh,
  audioBadge,
  resShort,
  resTier,
  hdrLabel
} from '$lib/tracks.js';

/* "1 h 59 min" / "47 min" from seconds (at least 1 min). */
/** @param {number | null | undefined} sec @returns {string} */
export function hmin(sec) {
  const t = Math.max(1, Math.round((sec || 0) / 60));
  const h = Math.floor(t / 60);
  const m = t % 60;
  return h ? h + ' h' + (m ? ' ' + m + ' min' : '') : m + ' min';
}

/** @param {number | null | undefined} ticks @returns {string} */
export function runtimeOf(ticks) {
  return ticks ? hmin(ticks / TICKS) : '';
}

/* "31 min left" for a partly watched item, '' otherwise. */
/** @param {Pick<Jf.BaseItemDto, 'UserData' | 'RunTimeTicks'> | null | undefined} item @returns {string} */
export function leftOf(item) {
  const ud = item?.UserData || {};
  const rem = (item?.RunTimeTicks || 0) / TICKS - (ud.PlaybackPositionTicks || 0) / TICKS;
  return rem > 0 && ud.PlaybackPositionTicks ? hmin(rem) + ' left' : '';
}

/** @param {Pick<Jf.BaseItemDto, 'UserData'> | null | undefined} item @returns {number} */
export function resumeSecOf(item) {
  return ((item?.UserData || {}).PlaybackPositionTicks || 0) / TICKS;
}

/* 0–1 progress of a partly watched item (0 when played or untouched). */
/** @param {Pick<Jf.BaseItemDto, 'UserData'> | null | undefined} item @returns {number} */
export function progressOf(item) {
  const ud = item?.UserData || {};
  if (ud.Played || !ud.PlayedPercentage) return 0;
  return Math.min(100, ud.PlayedPercentage) / 100;
}

/** @param {Pick<Jf.BaseItemDto, 'ParentIndexNumber' | 'IndexNumber'>} e @returns {string} */
export function seLabel(e) {
  return 'S' + (e.ParentIndexNumber ?? 0) + ' · E' + (e.IndexNumber ?? 0);
}

/* Two-letter code for a subtitle language chip ("EN · DE"). */
/** @type {Record<string, string>} */
const SHORT = { eng: 'EN', en: 'EN', ger: 'DE', deu: 'DE', de: 'DE', fre: 'FR', fra: 'FR', fr: 'FR', spa: 'ES', es: 'ES', ita: 'IT', it: 'IT', jpn: 'JA', ja: 'JA', hun: 'HU', hu: 'HU', por: 'PT', pt: 'PT', dut: 'NL', nld: 'NL', nl: 'NL', swe: 'SV', sv: 'SV', dan: 'DA', da: 'DA', nor: 'NO', nob: 'NO', no: 'NO', fin: 'FI', fi: 'FI', pol: 'PL', pl: 'PL', rus: 'RU', ru: 'RU', kor: 'KO', ko: 'KO', chi: 'ZH', zho: 'ZH', zh: 'ZH', tur: 'TR', tr: 'TR', ara: 'AR', ar: 'AR', cze: 'CS', ces: 'CS', cs: 'CS', gre: 'EL', ell: 'EL', el: 'EL', heb: 'HE', he: 'HE', hin: 'HI', hi: 'HI' };
const SUB_PREF = ['EN', 'DE'];
const SUB_CAP = 3;

/** @param {VR.PlayerSource | null | undefined} src @returns {string[]} */
function subCodes(src) {
  /** @type {string[]} */
  const out = [];
  for (const s of (src?.MediaStreams || []).filter((/** @type {VR.PlayerStream} */ x) => x.Type === 'Subtitle')) {
    const c = (s.Language || '').toLowerCase();
    if (!c || c === 'und') continue;
    const k = SHORT[c] || c.slice(0, 2).toUpperCase();
    if (!out.includes(k)) out.push(k);
  }
  const rank = (/** @type {string} */ k) => (SUB_PREF.indexOf(k) < 0 ? SUB_PREF.length : SUB_PREF.indexOf(k));
  return out.map((k, i) => /** @type {[string, number]} */ ([k, i])).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
}

/* The TechBadges row: resolution and HDR format strong, then the audio the
 * player would pick (DD+ Atmos) and its channels, then subtitle languages. */
/** @param {VR.PlayerItem} item @param {Pick<VR.PlayerItem, 'Genres'> | null} [ctx] @returns {VR.TechBadge[]} */
export function techBadges(item, ctx = item) {
  const src = pickSource(item);
  if (!src) return [];
  /** @type {VR.TechBadge[]} */
  const out = [];
  const v = videoStream(src);
  if (v) {
    const rs = resShort(v.Width, v.Height);
    if (rs) out.push({ label: rs, strong: true });
    const h = hdrLabel(v);
    if (h) out.push({ label: h, strong: true });
  }
  const t = describeTracks(src, ctx);
  const a = streamByIndex(src, t.defaultAudio);
  if (a) {
    const ab = audioBadge(a);
    if (ab) out.push(ab);
    const l = chLayout(a);
    if (l && l !== 'Mono') out.push(l);
  }
  const subs = subCodes(src);
  if (subs.length) out.push('Subs ' + subs.slice(0, SUB_CAP).join(' · ') + (subs.length > SUB_CAP ? ' +' + (subs.length - SUB_CAP) : ''));
  return out;
}

/* The details list (.kv): Director, Audio, Subtitles, File. */
/** @param {VR.PlayerItem} item @param {Pick<VR.PlayerItem, 'Genres'> | null} [ctx] @returns {VR.DetailRow[]} */
export function detailRows(item, ctx = item) {
  /** @type {VR.DetailRow[]} */
  const rows = [];
  const people = item.People || [];
  const dir = people.filter((p) => p.Type === 'Director').map((p) => p.Name);
  if (dir.length) rows.push({ k: dir.length > 1 ? 'Directors' : 'Director', v: dir.slice(0, 3).join(', ') });
  const wri = people.filter((p) => p.Type === 'Writer').map((p) => p.Name);
  if (wri.length) rows.push({ k: 'Writing', v: wri.slice(0, 3).join(', ') });
  if (item.Studios?.length) rows.push({ k: 'Studio', v: item.Studios.slice(0, 2).map((s) => s.Name).join(', ') });
  const src = pickSource(item);
  if (src) {
    const streams = src.MediaStreams || [];
    const t = describeTracks(src, ctx);
    const order = t.audio.map((x) => x.index);
    const audio = streams.filter((s) => s.Type === 'Audio').sort((a, b) => order.indexOf(a.Index) - order.indexOf(b.Index));
    if (audio.length) {
      const lines = audio.slice(0, 6).map(audioLabel);
      if (audio.length > 6) lines.push('+' + (audio.length - 6) + ' more');
      rows.push({ k: 'Audio', lines });
    }
    const subs = streams.filter((s) => s.Type === 'Subtitle');
    if (subs.length) {
      /** @type {string[]} */
      const seen = [];
      for (const s of subs) {
        let n = langName(s.Language);
        if (isSdh(s)) n += ' SDH';
        else if (s.IsForced) n += ' Forced';
        if (!seen.includes(n)) seen.push(n);
      }
      rows.push({ k: 'Subtitles', v: seen.slice(0, 12).join(', ') + (seen.length > 12 ? ' +' + (seen.length - 12) : '') });
    }
    const v = videoStream(src);
    const file = [];
    if (v) {
      file.push(resTier(v.Width, v.Height));
      if (v.Codec) file.push(v.Codec.toUpperCase() === 'H264' ? 'H.264' : v.Codec.toUpperCase());
      const h = hdrLabel(v);
      if (h) file.push(h + (h === 'Dolby Vision' && v.DvProfile != null ? ' ' + v.DvProfile + (v.DvBlSignalCompatibilityId != null ? '.' + v.DvBlSignalCompatibilityId : '') : ''));
    }
    /* no-break spaces: a wrapped line never strands a unit ("8.0 / GB") */
    if (src.Size) file.push((src.Size / 1073741824).toFixed(1) + '\u00a0GB');
    if (src.Bitrate) file.push(Math.round(src.Bitrate / 1e6) + '\u00a0Mbit/s');
    if (file.length) rows.push({ k: 'File', v: file.filter(Boolean).join(' · ') });
  }
  if (item.DateCreated) {
    const d = fmtDate(item.DateCreated);
    if (d && !/NaN/.test(d)) rows.push({ k: 'Added', v: d });
  }
  return rows;
}

/* The slow-link hint (TechGrid's P.link note): a file far above what the
 * stall watchdog measured in the last 30 min. null when it doesn't apply.
 * Under the Settings quality cap the stream runs at the cap, not the file's
 * bitrate (`capped`: the server converts it). */
const LINK_FRESH_MS = 30 * 60 * 1000;
/** @param {VR.LinkSample | null | undefined} link @param {VR.PlayerItem | null | undefined} item @returns {VR.SlowLinkHint | null} */
export function slowLink(link, item) {
  const src = item ? pickSource(item) : null;
  const file = src && src.Bitrate ? src.Bitrate : 0;
  const cap = getQualityCap();
  const capped = cap !== 'original' && file > cap;
  const need = (capped ? cap : file) / 1e6;
  if (!link || !need || Date.now() - link.at > LINK_FRESH_MS || link.got >= need * 0.85) return null;
  return { need: Math.round(need), got: link.got, capped };
}

/* An episode title that says something: Sonarr lists unannounced ones as
 * "TBA" / "TBD" — treat those as unknown (the row then reads "Episode 3"). */
/** @param {...(string | null | undefined)} ts @returns {string} */
export function epTitle(...ts) {
  return ts.find((t) => t && !/^\s*(tba|tbd|to be announced)\s*$/i.test(t)) || '';
}

/** @param {string | null | undefined} name @returns {string} */
export function initials(name) {
  return (name || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/* ---- download activity (pending rows / status button) ---- */
import { act, STATUS_LABEL, humanBytes, qualityRes } from '$lib/activity.svelte.js';

/* A queued title's TechBadges from its release names ("WEBDL-2160p",
 * "Bluray-1080p") in the look of a downloaded file's: the resolution strong
 * ("4K"), then the source ("WEB-DL", "Blu-ray", "Remux"), then the size. */
/** @type {[RegExp, string][]} */
const SOURCE = [
  [/remux/i, 'Remux'],
  [/blu-?ray|bdrip|brrip/i, 'Blu-ray'],
  [/web-?dl/i, 'WEB-DL'],
  [/web-?rip/i, 'WEBRip'],
  [/hdtv/i, 'HDTV'],
  [/dvd/i, 'DVD']
];
/** @param {(string | null | undefined)[] | null | undefined} qualities @param {number | null | undefined} [bytes] @returns {VR.TechBadge[]} */
export function releaseBadges(qualities, bytes) {
  /** @type {VR.TechBadge[]} */
  const out = [];
  const res = [...new Set((qualities || []).map(qualityRes).filter(Boolean))];
  for (const r of res) out.push({ label: r, strong: true });
  const src = [...new Set((qualities || []).map((q) => (SOURCE.find(([re]) => re.test(/** @type {string} */ (q))) || [])[1]).filter(Boolean))];
  out.push(.../** @type {string[]} */ (src));
  if (!res.length && !src.length) out.push(.../** @type {string[]} */ ((qualities || []).filter(Boolean)));
  if (bytes) out.push(humanBytes(bytes));
  return out;
}

/* Sonarr/Radarr "1:15:38" / "1.02:03:04" → "1 h 16 min left" */
/** @param {string | null | undefined} t @returns {string} */
export function etaLeft(t) {
  if (!t) return '';
  const [d, rest] = t.includes('.') ? t.split('.') : ['0', t];
  const s = rest.split(':').reduce((n, x) => n * 60 + (parseInt(x, 10) || 0), 0) + (parseInt(d, 10) || 0) * 86400;
  return s ? hmin(s) + ' left' : '';
}

/* An episode row's status line: "Downloading · 9 min left" / "Queued" */
/** @param {VR.ActivityLike} p @returns {string} */
export function pendStatus(p) {
  if (act.stale) return 'Status unavailable';
  if (p.status === 'downloading') return ['Downloading', etaLeft(p.timeleft)].filter(Boolean).join(' · ');
  return STATUS_LABEL[p.status] || p.status;
}

/* EpisodeRow's dl prop for an activity item / group */
/** @param {VR.ActivityLike} p @returns {VR.TileDownload} */
export function dlOf(p) {
  return { status: p.status === 'downloading' ? 'downloading' : 'queued', p: p.progress || 0 };
}

/* The status button: { pct: '43%' | '', rate: '7.4 MB/s', eta: '1 h 12 min left',
 * rest: rate · eta | 'Queued · waiting for a slot', p }. The ETA reads like the
 * episode rows' ("1 h 12 min left", etaLeft) — one format everywhere, and no
 * seconds digit ticking every poll (DET-10). */
/** @param {VR.ActivityLike} x @param {number | null} [speed] @returns {VR.StatusParts} */
export function statusParts(x, speed) {
  if (act.stale) return { pct: '', rest: 'Download status unavailable', p: 0 };
  if (x.status === 'downloading') {
    const sp = speed ?? x.speed ?? x.download_speed;
    const rate = sp ? humanBytes(sp) + '/s' : '';
    const eta = etaLeft(x.timeleft);
    return { pct: Math.round((x.progress || 0) * 100) + '%', rate, eta, rest: [rate, eta].filter(Boolean).join(' · '), p: x.progress || 0 };
  }
  if (x.status === 'queued') return { pct: '', rest: 'Queued · waiting for a slot', p: 0 };
  if (x.status === 'importing') return { pct: '', rest: 'Importing into your library…', p: 1 };
  return { pct: '', rest: STATUS_LABEL[x.status] || x.status || '', p: x.progress || 0 };
}

/* Scroll offset at which a title page's NavBar turns solid: once the header
 * text (which overlaps the backdrop by 128) reaches the bar. */
import { safeInsets } from '../../lib/safe.js';
/** @param {number | null | undefined} heroH @returns {number} */
export function solidPoint(heroH) {
  return Math.max(40, (heroH || 440) - 128 - (safeInsets().top + 56));
}

/* use:lateIn={late} on a title page's <main class="screen"> (DET-03): when
 * its content arrived late (the skeleton was up > 250 ms), dissolve the text
 * and everything below it in — opacity only, the hero keeps its own fade. Not
 * during the tile → page zoom (`.zoom-card`): the zoom fades swapped-in
 * content itself, on its own clock. Stays under Reduce Motion (a dissolve is
 * what iOS uses instead of motion). */
import { DUR, EASE } from '../../lib/safe.js';
/** @param {HTMLElement} node @param {boolean} late */
export function lateIn(node, late) {
  if (!late || node.closest('.route')?.classList.contains('zoom-card')) return;
  const body = node.querySelector(':scope > .detail__body');
  if (!body) return;
  for (let el = /** @type {Element | null} */ (body); el; el = el.nextElementSibling) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.img, easing: EASE.out });
}

/* DET-09: the add → queued → downloading → landed states morph in one place.
 * `morphFade` is the cross-fade both the outgoing and the incoming state run
 * in the same grid cell (.detail__morph), so nothing below moves; `landIn` is
 * the one-shot arrival of "Open" when an import lands — a small scale up with
 * the fade (the fade alone under Reduce Motion). */
import { springEase, reducedMotion } from '../../lib/safe.js';
export const morphFade = { duration: DUR.fast };
/** @type {VR.TransitionFn} */
export function landIn() {
  const move = !reducedMotion();
  return {
    duration: move ? DUR.springQuick : DUR.fast,
    easing: move ? springEase.snappy : undefined,
    css: (t) => `opacity: ${Math.min(1, t)};` + (move ? ` transform: scale(${0.96 + 0.04 * t});` : '')
  };
}
