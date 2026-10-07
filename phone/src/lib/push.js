/* Web Push: "Ready to watch" (and optionally new seasons) as iPhone
 * notifications. The server half is reel-api's push.py (/ml/api/push/…): it
 * polls the Sonarr/Radarr import history, waits until Jellyfin has the title
 * and pushes once per title/episode to every subscription of the user.
 *
 * iOS rules (16.4+): Web Push only exists for a web app opened from the Home
 * Screen (`navigator.standalone`), and Notification.requestPermission() must be
 * called from a user gesture — enablePush() therefore calls it *first*,
 * synchronously inside the tap, before any await.
 *
 * A subscription is registered with the signed-in user's Jellyfin token (the
 * server checks it and looks titles up as that user). syncPush() re-registers
 * on every start while permission is granted: it follows account switches and
 * a push endpoint iOS may have rotated, and brings back a subscription the
 * server dropped (it drops one when Jellyfin rejects its token).
 *
 * Signing out or switching accounts first takes this device off the server
 * (pushSignOut, from the Accounts sheet): the server keys a subscription by its
 * endpoint and keeps the old user's token, so the signed-out user's "Ready to
 * watch" kept arriving. The browser subscription itself stays (the prefs too):
 * the next signed-in start re-registers it without needing a tap. syncPush does
 * the same whenever it starts with nobody signed in.
 *
 * Taps: sw.js focuses (or opens) the app and hands over `open` — either as a
 * postMessage to a running page or as `/?open=Type:Id` on a cold start;
 * initPushLinks() routes both. */
import { cfg } from '$lib/config.js';
import { mlHeaders } from '$lib/medialib.js';
import { toast } from '$lib/toast.svelte.js';
import { S, openItem } from './nav.svelte.js';
import { R, openSheet, switchTab, onPlayerClose } from './router.svelte.js';

const PREFS = 'reel.push';   // { ready, seasons } this device asked for

const base = () => cfg.medialib + '/api/push';

/** POST to reel-api's /api/push…; rejects with a VR.ApiError carrying the HTTP status.
 * @template [T=unknown] @param {string} path @param {object} body @returns {Promise<T>} */
async function post(path, body) {
  const r = await fetch(base() + path, {
    method: 'POST',
    headers: mlHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const b = await r.json().catch(/** @returns {null} */ () => null);
  if (!r.ok) {
    const e = /** @type {VR.ApiError} */ (new Error((b && b.detail) || 'HTTP ' + r.status));
    e.status = r.status;
    throw e;
  }
  return b;
}

/* 'ok' | 'browser' (open in Safari, not the Home Screen app) | 'unsupported' */
/** @returns {VR.PushSupport} */
export function pushSupport() {
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const api = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (api && standalone) return 'ok';
  // iOS Safari tabs have no PushManager at all; other browsers do but the
  // feature is meant for the installed app — a desktop browser still works.
  if (api && !/iPhone|iPad|iPod/.test(navigator.userAgent)) return 'ok';
  return /iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone ? 'browser' : 'unsupported';
}

/** @returns {NotificationPermission} */
export function permission() {
  return 'Notification' in window ? Notification.permission : 'denied';
}

/** @returns {VR.PushPrefs} */
function loadPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS) || 'null');
    return v && typeof v === 'object' ? { ready: !!v.ready, seasons: !!v.seasons } : { ready: false, seasons: false };
  } catch {
    return { ready: false, seasons: false };
  }
}

/** @param {VR.PushPrefs} p */
function savePrefs(p) {
  try {
    if (p.ready || p.seasons) localStorage.setItem(PREFS, JSON.stringify(p));
    else localStorage.removeItem(PREFS);
  } catch {}
}

/** @returns {VR.PushPrefs} */
export function pushPrefs() {
  return loadPrefs();
}

async function registration() {
  const reg = await navigator.serviceWorker.ready;
  return reg;
}

/** @param {string} b64 base64url @returns {Uint8Array<ArrayBuffer>} */
function keyBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** @param {VR.PushPrefs} prefs @returns {Promise<PushSubscription>} */
async function subscribeAndRegister(prefs) {
  /** @type {Reel.PushConfig | null} */
  const conf = await fetch(base() + '/config', { headers: mlHeaders(), signal: AbortSignal.timeout(10000) }).then((r) => r.json());
  if (!conf || !conf.enabled || !conf.key) throw new Error('Notifications aren’t set up on the server');
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // a subscription made for another server key can't be used: replace it
  if (sub && sub.options && sub.options.applicationServerKey) {
    const have = new Uint8Array(sub.options.applicationServerKey);
    const want = keyBytes(conf.key);
    if (have.length !== want.length || have.some((b, i) => b !== want[i])) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(conf.key) });
  await post('/subscribe', /** @type {Reel.PushSubscribeBody} */ ({
    subscription: sub.toJSON(),
    token: cfg.token,
    user_id: cfg.userId,
    device_id: cfg.deviceId,
    ready: prefs.ready,
    seasons: prefs.seasons
  }));
  return sub;
}

/* Turn a kind on or off: `kind` 'ready' | 'seasons'. Must be called straight
 * from the tap (see the top). Resolves to the new prefs; rejects with a
 * user-facing message. */
/** @param {VR.PushKind} kind @param {boolean} on @returns {Promise<VR.PushPrefs>} */
export function setPush(kind, on) {
  const prefs = { ...loadPrefs(), [kind]: on };
  // the permission prompt first, synchronously in the gesture
  const asked = on && permission() === 'default' ? Notification.requestPermission() : Promise.resolve(permission());
  return asked.then(async (perm) => {
    if (on && perm !== 'granted') {
      throw new Error(perm === 'denied' ? 'Notifications are turned off for VibeReel — allow them in the iPhone’s Settings → Notifications → VibeReel' : 'Notifications weren’t allowed');
    }
    if (prefs.ready || prefs.seasons) {
      await subscribeAndRegister(prefs);
    } else {
      const reg = await registration();
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await post('/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
    }
    savePrefs(prefs);
    return prefs;
  });
}

/* What the server has for this device — the Settings switches show this. */
/** @returns {Promise<Reel.PushStatus | null>} null: no push here, or no permission */
export async function pushServerState() {
  if (pushSupport() !== 'ok' || permission() !== 'granted') return null;
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return { subscribed: false, ready: false, seasons: false };
  return post('/status', { endpoint: sub.endpoint });
}

export async function sendTestPush() {
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) throw new Error('Not subscribed');
  return post('/test', { endpoint: sub.endpoint });
}

/* On start: keep the server's copy of this device current — or, with nobody
 * signed in, make sure it has none. */
export function syncPush() {
  const prefs = loadPrefs();
  if (!(prefs.ready || prefs.seasons) || pushSupport() !== 'ok' || permission() !== 'granted') return;
  if (!cfg.token) {
    pushSignOut();
    return;
  }
  subscribeAndRegister(prefs).catch(() => {});
}

/* Take this device's subscription off the server (not out of the browser — see
 * the top). Best effort, ≤ 4 s: called right before a sign-out / account
 * switch reloads the app. */
export async function pushSignOut() {
  deferred = null;
  try {
    if (pushSupport() !== 'ok' || permission() !== 'granted') return;
    const reg = await Promise.race([registration(), new Promise((r) => setTimeout(r, 1500))]);
    const sub = reg && (await reg.pushManager.getSubscription());
    if (!sub) return;
    await fetch(base() + '/unsubscribe', {
      method: 'POST',
      headers: mlHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ endpoint: sub.endpoint }),
      keepalive: true,
      signal: AbortSignal.timeout(2500)
    });
  } catch {}
}

/* ---- notification taps ---- */

/* A tap refused while the player is up — the toast promises it opens when the
 * player closes, so it is kept (the latest tap wins) and routed by the next
 * close. It belongs to the account it was tapped for: a sign-out or an account
 * switch drops it. */
/** @type {{ open: VR.PushOpen, user: string } | null} */
let deferred = null;
let closeHooked = false;

function openDeferred() {
  const d = deferred;
  deferred = null;
  if (!d || !cfg.token || cfg.userId !== d.user) return;
  route(d.open);
}

/** @param {VR.PushOpen | null | undefined} open */
function route(open) {
  if (!open || typeof open !== 'object') return;
  const go = () => {
    // never yank someone out of a film for a notification they tapped earlier
    if (S.screen === 'player') {
      deferred = { open, user: cfg.userId };
      if (!closeHooked) {
        closeHooked = true;
        onPlayerClose(openDeferred);
      }
      toast('Opens when you close the player');
      return;
    }
    if (open.type === 'item' && open.id) openItem(open.id, open.itemType || 'Movie');
    else if (open.type === 'bell') openSheet('notifications');
    else if (open.type === 'home' && R.tab !== 'home') switchTab('home');
  };
  if (R.booted) go();
  else {
    // cold start: wait for the session check (App.svelte → markBooted)
    const t0 = Date.now();
    const t = setInterval(() => {
      if (R.booted) {
        clearInterval(t);
        go();
      } else if (Date.now() - t0 > 15000) clearInterval(t);
    }, 200);
  }
}

export function initPushLinks() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'vr-open') route(e.data.open);
  });
  const q = new URLSearchParams(location.search);
  const o = q.get('open');
  if (o) {
    const [type, id] = o.split(':');
    q.delete('open');
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
    if (type === 'bell') route({ type: 'bell' });
    else if (type === 'home') route({ type: 'home' });
    else if (id && /^[0-9a-f]{32}$/i.test(id)) route({ type: 'item', id, itemType: type });
  }
}
