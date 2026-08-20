// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
// Used to drive a headless Chrome that carries the Naver session cookies, so the
// scrape needs no visible window and no control of the user's mouse or monitor.
const HOST = '127.0.0.1';

export async function httpJson(port, path) {
  const r = await fetch(`http://${HOST}:${port}${path}`);
  if (!r.ok) throw new Error(`CDP HTTP ${r.status} ${path}`);
  return r.json();
}

export async function waitForPort(port, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try { return await httpJson(port, '/json/version'); }
    catch (e) { last = e; await new Promise(r => setTimeout(r, 300)); }
  }
  throw new Error(`CDP port ${port} never came up: ${last && last.message}`);
}

export class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) {
        const ls = this.listeners.get(msg.method) || [];
        ls.forEach(fn => fn(msg.params));
      }
    });
  }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP websocket failed')), { once: true });
    });
    return new Session(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }

  on(method, fn) {
    const ls = this.listeners.get(method) || [];
    ls.push(fn);
    this.listeners.set(method, ls);
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'evaluate threw');
    }
    return r.result.value;
  }

  // Navigate and wait for the SPA to settle, not just for the document to load.
  async goto(url, { settleMs = 1200, timeoutMs = 45000 } = {}) {
    await this.send('Page.enable');
    const loaded = new Promise(res => this.on('Page.loadEventFired', res));
    await this.send('Page.navigate', { url });
    await Promise.race([loaded, new Promise(r => setTimeout(r, timeoutMs))]);
    await new Promise(r => setTimeout(r, settleMs));
  }

  // Poll a predicate in the page until it returns truthy.
  async waitFor(expression, { timeoutMs = 60000, intervalMs = 700 } = {}) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      let v;
      try { v = await this.evaluate(expression); } catch { v = null; }
      if (v) return v;
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return null;
  }

  close() { try { this.ws.close(); } catch {} }
}

export async function firstPage(port) {
  const targets = await httpJson(port, '/json/list');
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('no page target');
  return page;
}
