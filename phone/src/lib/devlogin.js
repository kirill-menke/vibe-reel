/* DEV ONLY (imported behind import.meta.env.DEV in main.js).
 * /?devlogin → fetch the dev account from the dev server's /__devcreds
 * (phone/dev/plugin.js, reads the gitignored phone/.devcreds.json) and store it
 * as this browser's session: token, userId, userName, and the token's deviceId
 * when the file has one (else the phone keeps its own) — plus the /jf proxy.
 * Then reload without the query. Nothing is logged. */
export async function devLogin() {
  try {
    const r = await fetch('/__devcreds', { cache: 'no-store' });
    if (!r.ok) throw new Error('no dev credentials (' + r.status + ')');
    const c = await r.json();
    if (!c.token || !c.userId) throw new Error('dev credentials incomplete');
    localStorage.setItem('reel.token', c.token);
    localStorage.setItem('reel.userId', c.userId);
    localStorage.setItem('reel.userName', c.userName || '');
    // a token minted by `phone/dev-chrome.sh login` belongs to DeviceId
    // reel-chrome-dev: send that, so Jellyfin sees one consistent device
    if (c.deviceId) localStorage.setItem('reel.deviceId', c.deviceId);
    localStorage.setItem('reel.server', location.origin + '/jf');
    localStorage.setItem('reel.medialib', location.origin + '/ml');
    // the account list, so the Accounts sheet / Login have a remembered row
    const acc = { server: location.origin + '/jf', userId: c.userId, userName: c.userName || '', token: c.token };
    let list = [];
    try {
      list = JSON.parse(localStorage.getItem('reel.accounts') || '[]');
    } catch {}
    list = (Array.isArray(list) ? list : []).filter((a) => a && a.userId !== acc.userId);
    list.unshift(acc);
    localStorage.setItem('reel.accounts', JSON.stringify(list));
  } catch (e) {
    console.warn('[devlogin]', /** @type {Error} */ (e).message);
    return;
  }
  location.replace(location.pathname);
  await new Promise(() => {}); // never resolves: the page is going away
}
