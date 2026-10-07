/* One page (own browser context = own localStorage/cache/SW) driven over CDP.
 *
 *   await page.goto(url)                    navigate, wait for load
 *   await page.eval(fn, ...args)            run fn in the page, by value
 *   await page.waitFor(fn, {timeout}, ...)  poll until fn returns truthy
 *   await page.key('Down'|'Back'|…)          trusted key (Input.dispatchKeyEvent)
 *   await page.type('text')                 Input.insertText into the focus
 *   await page.chars('text')                trusted key events per character (USB keyboard)
 *   await page.tap(x, y) / page.tapSel(css) trusted touch (phone)
 *   await page.press(x, y, ms)              trusted touch held still (phone long-press)
 *   page.errors                             console errors, exceptions, failed loads
 */
import { writeFileSync } from 'node:fs';

/* webOS remote keycodes as Keys.svelte reads them (e.keyCode). */
export const KEYS = {
  Left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  Up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  Right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  OK: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Back: { key: 'GoBack', code: '', keyCode: 461 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Play: { key: 'MediaPlay', code: '', keyCode: 415 },
  Pause: { key: 'MediaPause', code: '', keyCode: 19 },
  Stop: { key: 'MediaStop', code: '', keyCode: 413 },
  Rewind: { key: 'MediaRewind', code: '', keyCode: 412 },
  FastForward: { key: 'MediaFastForward', code: '', keyCode: 417 }
};

export const IPHONE = {
  width: 393, height: 852, deviceScaleFactor: 3, mobile: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
};

export class Page {
  constructor(cdp, sessionId, opts) {
    this.cdp = cdp;
    this.s = cdp.session(sessionId);
    this.sessionId = sessionId;
    this.opts = opts;
    this.errors = [];
    this.console = [];
    this.offs = [];
  }

  async init() {
    const s = this.s;
    this.offs.push(
      s.on('Runtime.consoleAPICalled', (p) => {
        const text = p.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ');
        this.console.push({ type: p.type, text });
        if (p.type === 'error' || p.type === 'assert') this.errors.push({ kind: 'console.' + p.type, text });
      }),
      s.on('Runtime.exceptionThrown', (p) => {
        const d = p.exceptionDetails;
        this.errors.push({ kind: 'exception', text: (d.exception?.description || d.text || '').split('\n').slice(0, 4).join(' | ') });
      }),
      s.on('Log.entryAdded', (p) => {
        if (p.entry.level === 'error') this.errors.push({ kind: 'log.' + p.entry.source, text: p.entry.text + (p.entry.url ? ' ' + p.entry.url : '') });
      })
    );
    await s.send('Runtime.enable');
    await s.send('Log.enable');
    await s.send('Page.enable');
    if (this.opts.mobile) {
      const m = IPHONE;
      await s.send('Emulation.setDeviceMetricsOverride', { width: m.width, height: m.height, deviceScaleFactor: m.deviceScaleFactor, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } });
      await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await s.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
      await s.send('Emulation.setUserAgentOverride', { userAgent: m.userAgent, platform: 'iPhone' });
    } else {
      await s.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    }
  }

  async goto(url, { timeout = 15000 } = {}) {
    const loaded = this.s.waitFor('Page.loadEventFired', () => true, { timeout });
    const r = await this.s.send('Page.navigate', { url });
    if (r.errorText) throw new Error('navigate ' + url + ': ' + r.errorText);
    await loaded;
  }

  async reload() {
    const loaded = this.s.waitFor('Page.loadEventFired', () => true, { timeout: 15000 });
    await this.s.send('Page.reload', {});
    await loaded;
  }

  /* fn: a function (serialised with its args) or an expression string */
  async eval(fn, ...args) {
    const expression = typeof fn === 'function' ? `(${fn})(...${JSON.stringify(args)})` : fn;
    const r = await this.s.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) {
      throw new Error('page eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  async waitFor(fn, { timeout = 8000, interval = 50, what } = {}, ...args) {
    const t0 = Date.now();
    let last;
    for (;;) {
      try {
        last = await this.eval(fn, ...args);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      if (Date.now() - t0 > timeout) throw new Error(`waitFor timed out after ${timeout} ms: ${what || String(fn).slice(0, 160)} (last: ${JSON.stringify(last)?.slice(0, 200)})`);
      await sleep(interval);
    }
  }

  /* holds() for an in-page condition: fn (serialised like eval) stays truthy for ms */
  async holds(fn, { ms, what, interval = 150 } = {}, ...args) {
    return holds(() => this.eval(fn, ...args), ms, what, { interval });
  }

  /* One trusted key press. Then wait two animation frames — spatialMove()
   * coalesces moves to one per frame — plus `settle` ms for focus handlers. */
  async key(name, { settle = 60, repeat = false } = {}) {
    const k = KEYS[name];
    if (!k) throw new Error('unknown key ' + name);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, autoRepeat: repeat };
    await this.s.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
    await this.s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await this.frames(2);
    if (settle) await sleep(settle);
  }

  /* hold a key (OK-hold gestures): keyDown, wait, keyUp */
  async hold(name, ms = 700) {
    const k = KEYS[name];
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await this.s.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text } : {}) });
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      await sleep(100);
      await this.s.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, autoRepeat: true });
    }
    await this.s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await this.frames(2);
  }

  /* a physical (USB) keyboard typing printable characters, one trusted
   * keyDown/keyUp per character with the keyCode a US layout gives */
  async chars(text, { settle = 30 } = {}) {
    for (const c of text) {
      const up = c.toUpperCase();
      const keyCode = c === ' ' ? 32 : /[A-Z0-9]/.test(up) ? up.charCodeAt(0) : { "'": 222, '-': 189, '&': 55 }[c] ?? up.charCodeAt(0);
      const base = { key: c, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await this.s.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: c, unmodifiedText: c });
      await this.s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      if (settle) await sleep(settle);
    }
    await this.frames(1);
  }

  async type(text) {
    await this.s.send('Input.insertText', { text });
    await this.frames(1);
  }

  async frames(n = 1) {
    await this.eval((n) => new Promise((res) => {
      let i = 0;
      const f = () => (++i >= n ? res(true) : requestAnimationFrame(f));
      requestAnimationFrame(f);
      setTimeout(() => res(true), 200 * n); // a hidden page gets no frames
    }), n);
  }

  async tap(x, y) {
    const pt = [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }];
    await this.s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
    await sleep(40);
    await this.s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await this.frames(2);
  }

  /* a finger held still for ms (default 700: the phone's longpress fires at 500) */
  async press(x, y, ms = 700) {
    const pt = [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }];
    await this.s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
    await sleep(ms);
    await this.s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await this.frames(2);
  }

  /* tap the centre of the first element matching css (must be on screen) */
  async tapSel(css, { timeout = 8000 } = {}) {
    const r = await this.waitFor((css) => {
      const el = document.querySelector(css);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height || b.bottom < 0 || b.top > innerHeight) return null;
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, { timeout, what: 'tappable ' + css }, css);
    await this.tap(r.x, r.y);
    return r;
  }

  async swipe(x0, y0, x1, y1, { steps = 8, ms = 200 } = {}) {
    await this.s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 1 }] });
    for (let i = 1; i <= steps; i++) {
      await sleep(ms / steps);
      await this.s.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps, id: 1 }] });
    }
    await this.s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await this.frames(2);
  }

  async screenshot(file) {
    const r = await this.s.send('Page.captureScreenshot', { format: 'png' }, { timeout: 10000 });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  async close() {
    for (const off of this.offs) off();
    try {
      await this.cdp.send('Target.closeTarget', { targetId: this.opts.targetId }, null, { timeout: 5000 });
    } catch {}
    try {
      await this.cdp.send('Target.disposeBrowserContext', { browserContextId: this.opts.browserContextId }, null, { timeout: 5000 });
    } catch {}
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* An observation window instead of a bare sleep: `fn` (Node-side, may be
 * async) must stay truthy for `ms`; checked every `interval` ms and once more
 * at the end. Fails as soon as it turns false (with the elapsed time), so an
 * "X does not happen for N s" assertion fails fast and says when it broke.
 *   await holds(() => polls() === n, 2500, 'no poll after sign-in');      */
export async function holds(fn, ms, what, { interval = 100 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    const dt = Date.now() - t0;
    if (!v) throw new Error(`${what || 'condition'} stopped holding after ${dt} ms (of ${ms})`);
    if (dt >= ms) return v;
    await sleep(Math.min(interval, ms - dt));
  }
}
