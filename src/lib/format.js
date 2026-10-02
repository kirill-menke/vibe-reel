import { TICKS } from './api.js';

export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function ticksToSec(t) {
  return (t || 0) / TICKS;
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? h + ':' : '') + (h ? String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

export function fmtRuntime(ticks) {
  const s = Math.floor(ticksToSec(ticks));
  if (!s) return '';
  return hm(s);
}

export function timeLeft(item) {
  const ud = item.UserData || {};
  const rem = ticksToSec(item.RunTimeTicks) - ticksToSec(ud.PlaybackPositionTicks);
  if (rem <= 0) return '';
  return hm(rem) + ' left';
}

/* Round to whole minutes *before* splitting off the hours: rounding the
 * minute part alone printed 1:59:40 as "1h 60m". At least 1m, never "0m". */
function hm(sec) {
  const t = Math.max(1, Math.round(sec / 60));
  const h = Math.floor(t / 60);
  return (h ? h + 'h ' : '') + (t % 60) + 'm';
}

export function yearOf(item) {
  return item.ProductionYear || (item.PremiereDate ? item.PremiereDate.slice(0, 4) : '');
}

export function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
  } catch {
    return '';
  }
}
