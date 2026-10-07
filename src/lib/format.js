import { TICKS } from './api.js';

export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** @param {number | null | undefined} t ticks @returns {number} seconds */
export function ticksToSec(t) {
  return (t || 0) / TICKS;
}

/** @param {number | null | undefined} sec @returns {string} '1:02:03' / '2:03' */
export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? h + ':' : '') + (h ? String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

/** @param {number | null | undefined} ticks @returns {string} '1h 42m', '' for none */
export function fmtRuntime(ticks) {
  const s = Math.floor(ticksToSec(ticks));
  if (!s) return '';
  return hm(s);
}

/** @param {Pick<Jf.BaseItemDto, 'UserData' | 'RunTimeTicks'>} item @returns {string} */
export function timeLeft(item) {
  const ud = item.UserData || {};
  const rem = ticksToSec(item.RunTimeTicks) - ticksToSec(ud.PlaybackPositionTicks);
  if (rem <= 0) return '';
  return hm(rem) + ' left';
}

/* Round to whole minutes *before* splitting off the hours: rounding the
 * minute part alone printed 1:59:40 as "1h 60m". At least 1m, never "0m". */
/** @param {number} sec @returns {string} */
function hm(sec) {
  const t = Math.max(1, Math.round(sec / 60));
  const h = Math.floor(t / 60);
  return (h ? h + 'h ' : '') + (t % 60) + 'm';
}

/** @param {Pick<Jf.BaseItemDto, 'ProductionYear' | 'PremiereDate'>} item @returns {number | string} */
export function yearOf(item) {
  return item.ProductionYear || (item.PremiereDate ? item.PremiereDate.slice(0, 4) : '');
}

/* A date-only string ('2024-03-05', Sonarr's air_date) is a calendar day:
 * built in local time, since `new Date()` reads it as UTC midnight — the day
 * before west of UTC. Full timestamps (Jellyfin's PremiereDate/DateCreated)
 * are parsed as they are. Unparseable → '' (callers drop falsy parts). */
/** @param {string | number | Date} iso @returns {string} '9 Jul 2026' */
export function fmtDate(iso) {
  try {
    const ymd = typeof iso === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    const d = ymd ? new Date(+ymd[1], +ymd[2] - 1, +ymd[3]) : new Date(iso);
    if (isNaN(d.getTime()) || (ymd && (d.getMonth() !== +ymd[2] - 1 || d.getDate() !== +ymd[3]))) return '';
    return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
  } catch {
    return '';
  }
}
