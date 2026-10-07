/* The streaming-quality default for this browser, from where it is.
 *
 * The NAS answers GET /net.json with {"via":"lan"} at home and {"via":"tunnel"}
 * through the Cloudflare tunnel. Until the user picks a quality themselves
 * (Settings or the player's Quality picker — the phone's one per-device
 * setting, localStorage reel.qualityCellular, via getQualityCap/setQualityCap),
 * the tunnel defaults to 8 Mbit/s and the LAN to Original. No /net.json (the
 * dev server, an old NAS) = Original.
 *
 * "Picked by the user" needs no hook into Settings: we remember the value we
 * set last (reel.web.qualityAuto); a stored value that differs from it was
 * chosen by hand, and from then on (reel.web.qualityChosen) we never touch it.
 * A hand pick equal to the automatic value is indistinguishable and stays
 * automatic — harmless, it is what the user wanted on that network. */
import { getQualityCap, setQualityCap } from '$lib/player.svelte.js';

const AUTO_KEY = 'reel.web.qualityAuto';
const CHOSEN_KEY = 'reel.web.qualityChosen';
const TUNNEL_CAP = 8000000;

/** @type {'lan' | 'tunnel' | null} */
export let via = null;

/** @param {string} k */
function get(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
/** @param {string} k @param {string} v */
function set(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}

/** @returns {Promise<'lan' | 'tunnel' | null>} */
async function where() {
  try {
    const r = await fetch('/net.json', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!r.ok || !/json/i.test(r.headers.get('content-type') || '')) return null;
    const j = await r.json();
    return j && (j.via === 'lan' || j.via === 'tunnel') ? j.via : null;
  } catch {
    return null;
  }
}

/* Once at start; never blocks the first paint. */
export async function initQualityDefault() {
  via = await where();
  if (get(CHOSEN_KEY) === '1') return;
  const cur = String(getQualityCap());
  const auto = get(AUTO_KEY);
  if (auto != null && auto !== cur) {
    set(CHOSEN_KEY, '1'); // changed since we set it: the user's choice
    return;
  }
  /** @type {number | 'original'} */
  const want = via === 'tunnel' ? TUNNEL_CAP : 'original';
  setQualityCap(want);
  set(AUTO_KEY, String(want));
}
