/* Media stream inspection + the device profile. This is the heart of the
 * no-transcode contract — see README.md before touching it. */
import { SET } from './settings.svelte.js';

export function pickSource(item) {
  return (item.MediaSources || [])[0] || null;
}

export function videoStream(src) {
  return src ? (src.MediaStreams || []).find((s) => s.Type === 'Video') || null : null;
}

export function streamByIndex(src, i) {
  return src ? (src.MediaStreams || []).find((s) => s.Index === i) || null : null;
}

export function isAtmos(s) {
  return /atmos/i.test(s.Profile || '') || /atmos/i.test(s.Title || '') || /atmos/i.test(s.DisplayTitle || '');
}

export function isCommentary(s) {
  return /commentary/i.test(s.Title || '') || /commentary/i.test(s.DisplayTitle || '');
}

export function isSdh(s) {
  return /sdh|hearing/i.test(s.Title || '');
}

export function codecPretty(codec) {
  codec = (codec || '').toLowerCase();
  return codec === 'eac3' ? 'DD+'
    : codec === 'ac3' ? 'DD'
    : codec === 'truehd' ? 'TrueHD'
    : codec === 'dts' ? 'DTS'
    : codec === 'aac' ? 'AAC'
    : codec === 'flac' ? 'FLAC'
    : codec === 'opus' ? 'Opus'
    : codec.toUpperCase();
}

/* ffmpeg's layout names ('stereo', '5.1(side)') → the numbers people read. */
export function chLayout(s) {
  const raw = (s.ChannelLayout || '').toLowerCase().replace(/\(.*\)$/, '').trim();
  const named = { mono: 'Mono', stereo: '2.0', quad: '4.0', downmix: '2.0' }[raw];
  if (named) return named;
  if (/^\d\.\d(\.\d)?$/.test(raw)) return raw;
  return { 1: 'Mono', 2: '2.0', 6: '5.1', 8: '7.1' }[s.Channels] || s.ChannelLayout || (s.Channels ? s.Channels + 'ch' : '');
}

/* ---- menu labels ----
 * "English · DD+ 5.1 · Atmos", "English · SDH", "Japanese · Signs & Songs".
 * A stream Title is shown only when it says something the rest of the label
 * doesn't — most muxers just repeat the language/codec there ("English",
 * "Surround 5.1", "English SDH"), which would double every row. */
const TITLE_NOISE = new Set([
  'full', 'sub', 'subs', 'subtitle', 'subtitles', 'sdh', 'cc', 'hi', 'forced', 'default', 'dialogue', 'dialog',
  'stereo', 'surround', 'mono', 'dolby', 'digital', 'plus', 'atmos', 'truehd', 'true', 'hd', 'dts', 'dts-hd', 'ma',
  'x', 'es', 'aac', 'ac3', 'ac-3', 'eac3', 'e-ac-3', 'e-ac3', 'dd', 'dd+', 'ddp', 'flac', 'opus', 'pcm', 'lpcm', 'mp3',
  'srt', 'pgs', 'ass', 'ssa', 'vtt', 'vobsub', 'text', 'kbps', 'channel', 'channels', 'ch', 'track', 'audio',
  'original', 'main', 'commentary', 'the', 'and', 'with', 'for'
]);

function langNameSet() {
  const s = new Set();
  for (const [k, v] of Object.entries(LANG_NAMES)) {
    s.add(k);
    s.add(v.toLowerCase());
  }
  return s;
}
let LANG_WORDS = null;

/* The stream Title when it adds information, else ''. */
export function usefulTitle(s) {
  const t = (s.Title || '').trim();
  if (!t) return '';
  LANG_WORDS ||= langNameSet();
  const rest = t
    .toLowerCase()
    .split(/[^a-z0-9+\-]+/)
    .filter((w) => w && !TITLE_NOISE.has(w) && !LANG_WORDS.has(w) && !/^[\d.+\-]+(ch|k|kbps|bit)?$/.test(w));
  if (!rest.some((w) => w.length >= 2)) return '';
  return t.length > 40 ? t.slice(0, 38).trimEnd() + '…' : t;
}

function audioParts(s) {
  const title = usefulTitle(s);
  let c = codecPretty(s.Codec);
  const l = chLayout(s);
  if (l) c += ' ' + l;
  const parts = [langName(s.Language), c];
  if (isAtmos(s)) parts.push('Atmos');
  if (isCommentary(s) && !/commentary/i.test(title)) parts.push('Commentary');
  if (title) parts.push(title);
  return parts;
}

export function audioLabel(s) {
  return audioParts(s).join(' · ');
}

export function subFmt(codec) {
  codec = (codec || '').toLowerCase();
  return codec === 'subrip' || codec === 'srt' ? 'SRT'
    : codec === 'pgssub' || codec === 'pgs' ? 'PGS'
    : codec === 'dvdsub' || codec === 'vobsub' || codec === 'dvd_subtitle' ? 'DVD'
    : codec === 'dvbsub' ? 'DVB'
    : codec === 'ass' ? 'ASS'
    : codec === 'ssa' ? 'SSA'
    : codec === 'vtt' ? 'VTT'
    : codec.toUpperCase();
}

/* ISO 639-1/2/2-T → display name. The detail view lists *languages*, not stream
 * variants, so the alias pairs (deu/ger, fra/fre, …) have to collapse onto one
 * name or a file tagged by two different muxers shows the same language twice. */
const LANG_NAMES = {
  ara: 'Arabic', ar: 'Arabic',
  bul: 'Bulgarian', bg: 'Bulgarian',
  ces: 'Czech', cze: 'Czech', cs: 'Czech',
  chi: 'Chinese', zho: 'Chinese', zh: 'Chinese',
  dan: 'Danish', da: 'Danish',
  deu: 'German', ger: 'German', de: 'German',
  ell: 'Greek', gre: 'Greek', el: 'Greek',
  eng: 'English', en: 'English',
  est: 'Estonian', et: 'Estonian',
  fin: 'Finnish', fi: 'Finnish',
  fra: 'French', fre: 'French', fr: 'French',
  heb: 'Hebrew', he: 'Hebrew',
  hin: 'Hindi', hi: 'Hindi',
  hrv: 'Croatian', hr: 'Croatian',
  hun: 'Hungarian', hu: 'Hungarian',
  ind: 'Indonesian', id: 'Indonesian',
  ita: 'Italian', it: 'Italian',
  jpn: 'Japanese', ja: 'Japanese',
  kor: 'Korean', ko: 'Korean',
  lav: 'Latvian', lv: 'Latvian',
  lit: 'Lithuanian', lt: 'Lithuanian',
  nld: 'Dutch', dut: 'Dutch', nl: 'Dutch',
  nor: 'Norwegian', nob: 'Norwegian', no: 'Norwegian', nb: 'Norwegian',
  pol: 'Polish', pl: 'Polish',
  por: 'Portuguese', pt: 'Portuguese',
  ron: 'Romanian', rum: 'Romanian', ro: 'Romanian',
  rus: 'Russian', ru: 'Russian',
  slk: 'Slovak', slo: 'Slovak', sk: 'Slovak',
  slv: 'Slovenian', sl: 'Slovenian',
  spa: 'Spanish', es: 'Spanish',
  srp: 'Serbian', sr: 'Serbian',
  swe: 'Swedish', sv: 'Swedish',
  tha: 'Thai', th: 'Thai',
  tur: 'Turkish', tr: 'Turkish',
  ukr: 'Ukrainian', uk: 'Ukrainian',
  vie: 'Vietnamese', vi: 'Vietnamese',
  // added with the player-menu labels (these used to render as "ISL", "CAT", …)
  isl: 'Icelandic', ice: 'Icelandic', is: 'Icelandic',
  cat: 'Catalan', ca: 'Catalan',
  eus: 'Basque', baq: 'Basque', eu: 'Basque',
  glg: 'Galician', gl: 'Galician',
  msa: 'Malay', may: 'Malay', ms: 'Malay',
  fil: 'Filipino', tgl: 'Filipino', tl: 'Filipino',
  fas: 'Persian', per: 'Persian', fa: 'Persian',
  urd: 'Urdu', ur: 'Urdu',
  ben: 'Bengali', bn: 'Bengali',
  tam: 'Tamil', ta: 'Tamil',
  tel: 'Telugu', te: 'Telugu',
  und: 'Unknown'
};

export function langName(code) {
  const c = (code || '').toLowerCase();
  return LANG_NAMES[c] || (c ? c.toUpperCase() : 'Unknown');
}

/* One comparable key per language, whatever alias a muxer wrote ('ger' and
 * 'deu' are the same track to the viewer). Untagged stays '' rather than
 * 'Unknown' so it never collides with a real code. */
export function langKey(code) {
  return code && code.toLowerCase() !== 'und' ? langName(code) : '';
}

/* Text formats all render the same way (as VTT) so their codec is noise; the
 * image formats are named because they behave differently — PGS decodes on the
 * TV, DVD/DVB need a burn-in transcode. */
function subParts(s) {
  const title = usefulTitle(s);
  const parts = [langName(s.Language)];
  if (isSdh(s) && !/sdh/i.test(title)) parts.push('SDH');
  if (s.IsForced && !/forced/i.test(title)) parts.push('Forced');
  if (title) parts.push(title);
  const c = (s.Codec || '').toLowerCase();
  if (c === 'pgssub' || c === 'pgs') parts.push('PGS');
  else if (isBurnCodec(c)) parts.push(subFmt(c) + ' · burn-in');
  return parts;
}

/* Rows that would still read identically get numbered after the language —
 * "English", "English 2", … — so a file with 37 subtitle streams stays usable. */
function numberDupes(rows) {
  const seen = new Map();
  for (const r of rows) {
    const k = r.parts.join(' · ');
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    if (n > 1) r.parts = [r.parts[0] + ' ' + n, ...r.parts.slice(1)];
  }
  for (const r of rows) {
    r.label = r.parts.join(' · ');
    delete r.parts;
  }
}

/* Graphical subtitles with no client-side decoder (VobSub / DVB) — the only way
 * to show these on the TV is a Jellyfin burn-in transcode. */
export function isBurnCodec(c) {
  c = (c || '').toLowerCase();
  return c === 'dvdsub' || c === 'vobsub' || c === 'dvd_subtitle' || c === 'dvbsub' || c === 'dvb_subtitle' || c === 'xsub';
}

export function needsBurnIn(src, subIndex) {
  if (subIndex < 0) return false;
  const s = streamByIndex(src, subIndex);
  return !!s && isBurnCodec(s.Codec);
}

/* Prefer the best passthrough track for THIS TV: DD+/E-AC3 (often the Atmos
 * carrier) beats a container-default TrueHD, which the webOS app path can only
 * decode to lossy PCM anyway.
 *
 * Languages are compared as langKey()s ('English'), so whichever alias a muxer
 * wrote ('en', 'eng') matches the Settings value ('eng'). */
const JAPANESE = 'Japanese';

/* Anime plays in Japanese, everything else in the Settings audio language
 * (SET.audioLang, English by default). Genre alone can't tell anime from a
 * Western cartoon that ships a Japanese dub (one animated film's release does),
 * and Jellyfin doesn't expose a title's original language -- but the NAS's
 * strip-subtitles job knows it (from Sonarr/Radarr) and makes the container's
 * default track Japanese for anime, English otherwise. So for an Anime/Animation
 * title, a Japanese default track is the signal. Episodes usually have no genres
 * of their own; playEpisode() lends them the series'. Returns one langKey. */
export function preferredAudioLang(item, src) {
  const pref = langKey(SET.audioLang || 'eng') || 'English';
  const animated = ((item && item.Genres) || []).some((g) => /^anim(e|ation)$/i.test(g));
  if (!animated) return pref;
  const audio = ((src && src.MediaStreams) || []).filter((s) => s.Type === 'Audio');
  const def = audio.find((s) => s.IsDefault) || audio[0];
  return def && langKey(def.Language) === JAPANESE ? JAPANESE : pref;
}

/* `want` is a langKey ('' = no language preference, e.g. trackprefs' within-
 * one-language ranking). */
export function score(a, want = '') {
  let s = 0;
  // Language dominates codec: on a dual-audio release (e.g. ITA/SPA Apple TV+
  // rips that carry an English track too) we want the preferred language -- or
  // Japanese, for anime -- even if the other track is a slightly richer codec.
  // Undefined language is left neutral so single-track files are unaffected.
  if (want && langKey(a.lang) === want) s += 10;
  if (a.codec === 'eac3') s += 3;
  if (a.atmos) s += 2;
  if (a.codec === 'ac3') s += 1;
  // A commentary is never what "play" should mean. Without this, a Blu-ray
  // remux with a DTS-HD main track and AC3 commentaries (a whole series) defaulted to
  // the commentary: 10 + 1 for ac3 beat 10 for dts. -6 outweighs every codec
  // bonus (at most 5) but not the language bonus, so the commentary loses to
  // any main track in the same language and still beats a foreign one.
  if (a.commentary) s -= 6;
  return s;
}

/* The default subtitle, by SET.subMode. The container's own "default" flag is
 * deliberately NOT a reason to show subtitles any more: plenty of releases flag
 * an English SDH track default on English audio (a whole series did), which used to
 * switch subs on for every episode. VobSub/DVB are never auto-picked — they can
 * only be shown through a burn-in transcode, which must not fire unasked.
 *
 *   auto    audio the viewer understands (its language is subLang or audioLang,
 *           or untagged) → a forced track only (foreign-dialogue parts);
 *           audio in another language → full subLang subtitles
 *   always  subLang subtitles whenever present (full before forced)
 *   off     forced tracks only
 *
 * Forced tracks are looked for in the audio's language first, then subLang. */
export function pickDefaultSub(src, audioIndex) {
  const subs = ((src && src.MediaStreams) || []).filter((s) => s.Type === 'Subtitle' && !isBurnCodec(s.Codec));
  if (!subs.length) return -1;
  const subLang = langKey(SET.subLang || 'eng') || 'English';
  const audioPref = langKey(SET.audioLang || 'eng') || 'English';
  const a = streamByIndex(src, audioIndex);
  const aLang = a ? langKey(a.Language) : '';
  const rank = (s) => (isSdh(s) ? 0 : 2) + (s.IsDefault ? 1 : 0);
  const best = (list) => (list.length ? list.slice().sort((x, y) => rank(y) - rank(x) || x.Index - y.Index)[0].Index : -1);
  const inLang = (l, forced) => subs.filter((s) => langKey(s.Language) === l && !!s.IsForced === forced);
  const forcedPick = () => {
    const f = aLang ? best(inLang(aLang, true)) : -1;
    return f >= 0 ? f : best(inLang(subLang, true));
  };
  const mode = SET.subMode || 'auto';
  if (mode === 'always') {
    const full = best(inLang(subLang, false));
    return full >= 0 ? full : forcedPick();
  }
  if (mode === 'auto' && aLang && aLang !== subLang && aLang !== audioPref) {
    const full = best(inLang(subLang, false));
    return full >= 0 ? full : forcedPick();
  }
  return forcedPick();
}

/* `item` (movie, series or episode) only decides the preferred audio language. */
export function describeTracks(src, item) {
  const out = { audio: [], subs: [{ label: 'None', index: -1, lang: '' }], video: '', defaultAudio: -1, defaultSub: -1 };
  if (!src) return out;
  const subRows = [];
  for (const s of src.MediaStreams || []) {
    if (s.Type === 'Video') {
      const v = [s.Codec ? s.Codec.toUpperCase() : '', s.DisplayTitle || (s.Height ? s.Height + 'p' : '')];
      if (s.VideoRange && s.VideoRange !== 'SDR') v.push(s.VideoRange);
      out.video = v.filter(Boolean).join(' · ');
    } else if (s.Type === 'Audio') {
      out.audio.push({ parts: audioParts(s), index: s.Index, codec: (s.Codec || '').toLowerCase(), atmos: isAtmos(s), commentary: isCommentary(s), lang: (s.Language || '').toLowerCase() });
    } else if (s.Type === 'Subtitle') {
      const sc = (s.Codec || '').toLowerCase();
      subRows.push({ parts: subParts(s), index: s.Index, codec: sc, lang: (s.Language || '').toLowerCase(), forced: !!s.IsForced, burn: isBurnCodec(sc) });
    }
  }
  numberDupes(out.audio);
  numberDupes(subRows);
  out.subs.push(...subRows);
  if (out.audio.length) {
    // Highest score wins outright — score() already encodes the DD+/Atmos and
    // language preferences, so the old "find any eac3" override (which could pick
    // a foreign DD+ over an English track) is gone. The sort also puts the
    // preferred language first in the player's audio menu.
    const want = preferredAudioLang(item, src);
    out.audio.sort((a, b) => score(b, want) - score(a, want));
    out.defaultAudio = out.audio[0].index;
  }
  out.defaultSub = pickDefaultSub(src, out.defaultAudio);
  return out;
}

/* The subtitle menu's order: None, the Settings subtitle language, the language
 * of the audio being played, then everything else ("More languages", folded
 * away in the menu). File order within each group. */
export function groupSubs(subs, audioLang) {
  const sl = langKey(SET.subLang || 'eng') || 'English';
  const al = langKey(audioLang);
  const none = subs.filter((s) => s.index < 0);
  const main = subs.filter((s) => s.index >= 0 && langKey(s.lang) === sl);
  const aud = al && al !== sl ? subs.filter((s) => s.index >= 0 && langKey(s.lang) === al) : [];
  const more = subs.filter((s) => s.index >= 0 && !main.includes(s) && !aud.includes(s));
  return { top: [...none, ...main, ...aud], more };
}

/* Resolution tier by WIDTH (a 1920×816 scope movie is still "1080p", not "816p"). */
export function resTier(w, h) {
  w = w || 0;
  h = h || 0;
  if (w >= 3200 || h >= 1800) return '2160p';
  if (w >= 1800 || h >= 1000) return '1080p';
  if (w >= 1200 || h >= 700) return '720p';
  if (w >= 640 || h >= 460) return '480p';
  return h ? h + 'p' : '';
}

export function resShort(w, h) {
  const t = resTier(w, h);
  return t === '2160p' ? '4K' : t;
}

export function resLabel(w, h) {
  const t = resTier(w, h);
  return t === '2160p' ? '4K 2160p' : t;
}

export function hdrLabel(v) {
  const vr = (v.VideoRangeType || v.VideoRange || '').toUpperCase();
  if (vr.includes('DOVI') || /dolby ?vision/i.test(v.Title || '')) return 'Dolby Vision';
  if (vr.includes('HDR10')) return 'HDR10';
  if (vr.includes('HLG')) return 'HLG';
  return '';
}

export function audioBadge(a) {
  if (!a) return '';
  const c = (a.Codec || '').toLowerCase();
  const base = c === 'eac3' ? 'DD+' : c === 'ac3' ? 'DD' : c === 'truehd' ? 'DD+' : c === 'dts' ? 'DTS' : codecPretty(c);
  return base + (isAtmos(a) ? ' Atmos' : '');
}

/* `ctx` supplies the genres for the audio pick when `item` has none (an episode). */
export function heroBadges(item, ctx = item) {
  const src = pickSource(item);
  const v = videoStream(src);
  const out = [];
  if (v) {
    const rs = resShort(v.Width, v.Height);
    if (rs) out.push(rs);
    const h = hdrLabel(v);
    if (h) out.push(h);
  }
  const t = describeTracks(src, ctx);
  const ab = audioBadge(streamByIndex(src, t.defaultAudio));
  if (ab) out.push(ab);
  return out;
}

export function tileTechBadge(item) {
  const v = videoStream(pickSource(item));
  if (!v) return '';
  const parts = [];
  const rs = resShort(v.Width, v.Height);
  if (rs) parts.push(rs);
  const vr = (v.VideoRangeType || v.VideoRange || '').toUpperCase();
  if (vr.includes('DOVI')) parts.push('DV');
  else if (vr.includes('HDR10')) parts.push('HDR10');
  return parts.join(' · ');
}

/* ================= device profile =================
 * TranscodingProfiles is deliberately EMPTY so Jellyfin has no choice but to
 * DirectPlay. The single exception is burn === true: VobSub/DVB have no
 * client-side decoder, so they are omitted from SubtitleProfiles below, which
 * forces Jellyfin to burn them in via this one-off HLS profile.
 * DON'T ADD TRANSCODING PROFILES FOR ANY OTHER REASON. */
export function deviceProfile(burn, maxBitrate) {
  if (__PHONE__) return phoneProfile(burn, maxBitrate);
  const p = {
    MaxStreamingBitrate: 400000000,
    MaxStaticBitrate: 400000000,
    DirectPlayProfiles: [
      {
        Type: 'Video',
        Container: 'mkv,mp4,m4v,mov,ts,webm,avi',
        VideoCodec: 'h264,hevc,av1,vp9,mpeg2video,vc1',
        AudioCodec: 'aac,ac3,eac3,dts,truehd,mp3,flac,opus,pcm,mp2'
      },
      { Type: 'Audio' }
    ],
    TranscodingProfiles: [],
    ContainerProfiles: [],
    CodecProfiles: [],
    // Text + PGS render client-side; VobSub/DVB are intentionally absent.
    SubtitleProfiles: [
      { Format: 'srt', Method: 'External' },
      { Format: 'subrip', Method: 'External' },
      { Format: 'ass', Method: 'External' },
      { Format: 'ssa', Method: 'External' },
      { Format: 'vtt', Method: 'External' },
      { Format: 'pgssub', Method: 'External' },
      { Format: 'pgs', Method: 'External' }
    ]
  };
  if (burn) {
    p.TranscodingProfiles = [
      {
        Type: 'Video',
        Container: 'ts',
        Protocol: 'hls',
        VideoCodec: 'h264',
        AudioCodec: 'aac,ac3,eac3',
        Context: 'Streaming',
        MaxAudioChannels: '8',
        MinSegments: '1',
        BreakOnNonKeyFrames: true
      }
    ];
  }
  return p;
}

/* ================= iPhone (PWA) device profile =================
 * The TV's contract can't carry over: iOS Safari plays no MKV, TrueHD or DTS.
 * So the phone asks Jellyfin for an HLS fMP4 *remux* — video stream-copied,
 * audio copied when Safari can take it (E-AC3 incl. Atmos, AC3, AAC, FLAC,
 * ALAC), else converted (TrueHD/DTS/Opus → AC3 5.1). Modelled on jellyfin-web's
 * browserDeviceProfile for iOS Safari; this is the profile docs/ios/MEDIA-TEST.md
 * tested case by case against the NAS (Jellyfin 12.1), plus own checks
 * (2026-09-29):
 *   - an MKV HEVC Dolby Vision 8.1 file comes out as fMP4 with the video copied,
 *     tagged dvh1, DV profile 8 kept; the master playlist announces
 *     VIDEO-RANGE=PQ + SUPPLEMENTAL-CODECS="dvh1.08.06/db1p";
 *   - the resume position is NOT part of the HLS URL (the playlist is the whole
 *     runtime from 0, absolute timestamps), so play() seeks client-side on
 *     loadedmetadata exactly like DirectPlay does;
 *   - AudioStreamIndex / SubtitleStreamIndex are only honoured together with
 *     MediaSourceId (play() always sends all three on the phone);
 *   - MaxAudioChannels must be 8: with 6 an 8-channel DD+ track was re-encoded;
 *   - the one hev1-tagged MP4 in the library would black-screen as DirectPlay;
 *     the container-scoped VideoCodecTag condition turns it into a remux, which
 *     retags hvc1/dvh1.
 * DirectPlay is deliberately narrow (progressive MP4/MOV only) so nothing risky
 * is handed to Safari as a static file; every MKV goes through HLS.
 * The capability bits jellyfin-web probes are probed here too (canPlayType):
 * the HEVC level, Dolby Vision profiles 5 / 8 (without them DV plays as its
 * HDR10 base, and DV 5 needs a real transcode), and AV1 (hardware on A17 Pro /
 * M-series and later — copied then, with Opus, instead of transcoded to HEVC).
 * `maxBitrate`: 200 Mbit/s, or the Settings cap — below the file's bitrate
 * Jellyfin re-encodes the video to fit.
 * VobSub/DVB stay out of SubtitleProfiles, exactly as on the TV: a burn-in
 * request (SubtitleStreamIndex of one) makes Jellyfin encode them into the video. */
function cond(Condition, Property, Value, IsRequired = false) {
  return { Condition, Property, Value, IsRequired };
}

let phoneCaps = null;
function probePhone() {
  if (phoneCaps) return phoneCaps;
  let v = null;
  try {
    v = document.createElement('video');
  } catch {}
  const can = (t) => {
    try {
      return !!(v && v.canPlayType(t).replace(/no/, ''));
    } catch {
      return false;
    }
  };
  const hevcLevel = can('video/mp4; codecs="hvc1.2.4.L186"') ? 186
    : can('video/mp4; codecs="hvc1.2.4.L183"') ? 183
    : 153;   // every iPhone since the XS answers at least L153
  const dv5 = can('video/mp4; codecs="dvh1.05.06"');
  /* DV profile 8 always: its base layer is plain HDR10/HLG/SDR, which every
   * iPhone shows even if Safari answers the dvh1 probe with "" — without them a
   * DV 8.1 file (an anime series) was re-encoded to SDR and never started. The
   * probe only decides profile 5, which has no fallback layer. */
  let ranges = 'SDR|HDR10|HDR10Plus|HLG|DOVIWithHDR10|DOVIWithHLG|DOVIWithSDR|DOVIWithHDR10Plus';
  if (dv5) ranges += '|DOVI';
  // DOVIWithEL / DOVIInvalid deliberately absent: DV 7 must fall back (MEDIA-TEST.md)
  const av1 = can('video/mp4; codecs="av01.0.15M.10"');
  phoneCaps = { hevcLevel, ranges, av1 };
  return phoneCaps;
}

/* The Settings quality cap (8 / 4 Mbit/s) is a real re-encode on the NAS
 * (Intel N95, QSV) for every file above it. Measured 2026-09-29 on the heaviest
 * file, a 4K HDR10 HEVC film (36 Mbit/s, DTS-HD MA), from segment 0 up:
 * Jellyfin's own pick (HEVC, 2560×1440 by its bitrate table) ran 1.7×, first
 * segment 6.9 s, a seek 7.6 s; HEVC 1080p 2.4×; **H.264 1080p 4.1×** (first
 * segment 2.8 s, seek 4.2 s); H.264 720p 6.6× (2.0 s / 3.9 s). hevc_qsv costs
 * ~1.7× the time of h264_qsv here, so a capped stream encodes H.264 (listed
 * first) with the resolution boxed by `Conditions` — those only apply when
 * Jellyfin re-encodes the video, so a file under the cap is still copied (the
 * other codecs stay listed for exactly that). HDR can't survive a Jellyfin 12.1
 * QSV transcode (it tone-maps every HDR/DV source to SDR, OpenCL bt2390), so
 * a capped HDR title plays SDR. At 4 Mbit/s the audio becomes AAC stereo
 * (256 kbit/s) instead of AC3 5.1 at 640 — a sixth of the budget otherwise. */
export const PHONE_CAP_BOX = { 8000000: [1920, 1080], 4000000: [1280, 720] };

function phoneProfile(burn, maxBitrate) {
  const c = probePhone();
  const br = maxBitrate || 200000000;
  const box = PHONE_CAP_BOX[br] || null;
  const vcodecs = (c.av1 ? 'av1,' : '') + 'hevc,h264';
  const acodecs = 'eac3,ac3,aac,flac,alac' + (c.av1 ? ',opus' : '');
  const stereo = !!box && br <= 4000000;
  const codecProfiles = [
    {
      Type: 'Video',
      Codec: 'h264',
      Conditions: [
        cond('EqualsAny', 'VideoProfile', 'high|main|baseline|constrained baseline'),
        cond('EqualsAny', 'VideoRangeType', 'SDR'),
        cond('LessThanEqual', 'VideoLevel', '52'),
        cond('NotEquals', 'IsInterlaced', 'true')
      ]
    },
    {
      Type: 'Video',
      Codec: 'hevc',
      Conditions: [
        cond('EqualsAny', 'VideoProfile', 'main|main 10'),
        cond('EqualsAny', 'VideoRangeType', c.ranges),
        cond('LessThanEqual', 'VideoLevel', String(c.hevcLevel)),
        cond('NotEquals', 'IsInterlaced', 'true'),
        cond('LessThanEqual', 'VideoFramerate', '60', true)   // Safari: nothing above 60 fps
      ]
    },
    {
      // Safari only takes hvc1/dvh1-tagged HEVC as a file; the remux writes that tag itself
      Type: 'Video',
      Codec: 'hevc',
      Container: 'mp4,m4v,mov',
      Conditions: [cond('EqualsAny', 'VideoCodecTag', 'hvc1|dvh1', true)]
    }
  ];
  if (c.av1) {
    codecProfiles.push({
      Type: 'Video',
      Codec: 'av1',
      Conditions: [cond('EqualsAny', 'VideoRangeType', c.ranges)]
    });
  }
  return {
    Name: 'VibeReel Phone (iOS Safari)',
    MaxStreamingBitrate: br,
    MaxStaticBitrate: br,
    MusicStreamingTranscodingBitrate: 384000,
    DirectPlayProfiles: [
      { Type: 'Video', Container: 'mp4,m4v,mov', VideoCodec: 'h264,hevc', AudioCodec: 'aac,ac3,eac3,flac,alac,mp3' },
      // jellyfin-web's convention; only matters for sources that are HLS themselves
      { Type: 'Video', Container: 'hls', VideoCodec: vcodecs, AudioCodec: acodecs }
    ],
    TranscodingProfiles: [
      {
        Type: 'Video',
        Container: 'mp4',          // HLS with fMP4 segments (HEVC/DV need fMP4; Safari takes no HEVC in TS)
        Protocol: 'hls',
        Context: 'Streaming',
        // a forced transcode (burn-in, AV1 without hardware) encodes the first
        // codec: HEVC; under a quality cap H.264 (see PHONE_CAP_BOX)
        VideoCodec: box ? 'h264,' + (c.av1 ? 'av1,' : '') + 'hevc' : vcodecs,
        AudioCodec: stereo ? 'aac' : acodecs,
        MaxAudioChannels: stereo ? '2' : '8',
        MinSegments: 2,            // jellyfin-web's value for iOS
        BreakOnNonKeyFrames: true, // jellyfin-web sets this for iOS: a seek restarts the remux at once
        ...(box ? { Conditions: [cond('LessThanEqual', 'Width', String(box[0])), cond('LessThanEqual', 'Height', String(box[1]))] } : {})
      },
      // a fallback Jellyfin wants to see; not used for video
      { Type: 'Video', Container: 'mp4', Protocol: 'http', Context: 'Static', VideoCodec: 'h264', AudioCodec: 'aac' }
    ],
    ContainerProfiles: [],
    CodecProfiles: codecProfiles,
    // Text formats are converted to VTT and fetched by attachSubtitles(); PGS goes
    // to libpgs raw — as on the TV. Nothing is ever muxed into the HLS stream.
    SubtitleProfiles: [
      { Format: 'vtt', Method: 'External' },
      { Format: 'srt', Method: 'External' },
      { Format: 'subrip', Method: 'External' },
      { Format: 'mov_text', Method: 'External' },
      { Format: 'pgssub', Method: 'External' },
      { Format: 'pgs', Method: 'External' }
    ],
    ResponseProfiles: [{ Type: 'Video', Container: 'm4v', MimeType: 'video/mp4' }]
  };
}
