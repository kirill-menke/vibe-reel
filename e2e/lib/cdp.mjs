/* Minimal Chrome DevTools Protocol client over Node 22's global WebSocket,
 * flat sessions (Target.attachToTarget { flatten: true }). No Puppeteer. */

export class CDP {
  static connect(wsUrl, { timeout = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const t = setTimeout(() => reject(new Error('CDP connect timeout ' + wsUrl)), timeout);
      ws.onopen = () => {
        clearTimeout(t);
        resolve(new CDP(ws));
      };
      ws.onerror = (e) => {
        clearTimeout(t);
        reject(new Error('CDP connect failed: ' + (e.message || wsUrl)));
      };
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set(); // { method, sessionId, fn }
    this.closed = false;
    ws.onmessage = (ev) => this.onMessage(JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')));
    ws.onclose = () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'));
      this.pending.clear();
    };
  }

  onMessage(msg) {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ' ' + msg.error.data : ''}`), { cdp: msg.error }));
      else p.resolve(msg.result);
      return;
    }
    for (const l of [...this.listeners]) {
      if (l.method !== '*' && l.method !== msg.method) continue;
      if (l.sessionId !== undefined && l.sessionId !== (msg.sessionId ?? null)) continue;
      try {
        l.fn(msg.params, msg.sessionId ?? null, msg.method);
      } catch (e) {
        console.error('CDP listener error', msg.method, e);
      }
    }
  }

  send(method, params = {}, sessionId = null, { timeout = 30000 } = {}) {
    if (this.closed) return Promise.reject(new Error('CDP closed (' + method + ')'));
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('CDP timeout: ' + method));
      }, timeout);
      this.pending.set(id, {
        method,
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e))
      });
      this.ws.send(JSON.stringify(msg));
    });
  }

  /* sessionId: undefined = any session, null = browser only, string = that one */
  on(method, fn, sessionId) {
    const l = { method, fn, sessionId };
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  waitFor(method, pred = () => true, { timeout = 10000, sessionId } = {}) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        off();
        reject(new Error('timeout waiting for ' + method));
      }, timeout);
      const off = this.on(method, (p, s) => {
        if (!pred(p, s)) return;
        clearTimeout(t);
        off();
        resolve(p);
      }, sessionId);
    });
  }

  session(sessionId) {
    return {
      id: sessionId,
      send: (m, p, o) => this.send(m, p, sessionId, o),
      on: (m, fn) => this.on(m, fn, sessionId),
      waitFor: (m, pred, o = {}) => this.waitFor(m, pred, { ...o, sessionId })
    };
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}
