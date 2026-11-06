// Minimal Web API surface pdf.js touches on its text path; nothing here does I/O.
globalThis.queueMicrotask ??= (f) => Promise.resolve().then(f);
// Timers run in order, without waiting, whenever no promise job is left: nothing here has a clock.
const timers = new Map();
let nextTimer = 0;
globalThis.setTimeout = (f, _ms, ...args) => { nextTimer += 1; timers.set(nextTimer, () => f(...args)); return nextTimer; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
globalThis.__nextTimer = () => { for (const [id, f] of timers) { timers.delete(id); return f; } return null; };
globalThis.console ??= { log() {}, info() {}, warn() {}, error() {}, debug() {} };
globalThis.TextDecoder = class TextDecoder {
  constructor(label = 'utf-8', opts = {}) {
    const l = String(label).toLowerCase();
    if (l === 'utf8') this.encoding = 'utf-8';
    else if (l === 'utf-16' || l === 'utf-16le') this.encoding = 'utf-16le';
    else if (l === 'latin1' || l === 'ascii' || l === 'us-ascii' || l === 'iso-8859-1' || l === 'windows-1252') this.encoding = 'latin1';
    else this.encoding = l;
    if (!['utf-8', 'utf-16le', 'utf-16be', 'latin1'].includes(this.encoding)) throw new RangeError('The encoding label provided is invalid');
    this.fatal = !!opts.fatal; this.ignoreBOM = !!opts.ignoreBOM;
  }
  decode(input) {
    if (input === undefined) return '';
    const b = input instanceof Uint8Array ? input : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
    let s = '';
    if (this.encoding === 'latin1') { for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; }
    if (this.encoding !== 'utf-8') {
      const be = this.encoding === 'utf-16be';
      for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(be ? (b[i] << 8) | b[i + 1] : b[i] | (b[i + 1] << 8));
      if (b.length % 2) { if (this.fatal) throw new TypeError('invalid'); s += '�'; }
      return !this.ignoreBOM && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
    }
    for (let i = 0; i < b.length;) {
      const c = b[i]; let n = 0, cp = 0, min = 0;
      if (c < 0x80) { s += String.fromCharCode(c); i++; continue; }
      if (c >= 0xc2 && c <= 0xdf) { n = 1; cp = c & 0x1f; min = 0x80; }
      else if (c >= 0xe0 && c <= 0xef) { n = 2; cp = c & 0x0f; min = 0x800; }
      else if (c >= 0xf0 && c <= 0xf4) { n = 3; cp = c & 0x07; min = 0x10000; }
      else { if (this.fatal) throw new TypeError('invalid'); s += '�'; i++; continue; }
      let j = 1, ok = true;
      for (; j <= n; j++) {
        const d = b[i + j];
        if (d === undefined || (d & 0xc0) !== 0x80) { ok = false; break; }
        cp = (cp << 6) | (d & 0x3f);
      }
      if (!ok || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) { if (this.fatal) throw new TypeError('invalid'); s += '�'; i += Math.max(1, ok ? 1 : j); continue; }
      s += String.fromCodePoint(cp); i += n + 1;
    }
    return !this.ignoreBOM && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  }
};
globalThis.TextEncoder = class TextEncoder {
  encode(str = '') {
    const out = [];
    for (const ch of String(str)) {
      const c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
};
// pdf.js's fake worker reuses what it posts, so the copy is required even in a single thread.
const clone = (v, seen) => {
  if (typeof v !== 'object' || v === null) return v;
  if (seen.has(v)) return seen.get(v);
  if (v instanceof ArrayBuffer) return v.slice(0);
  if (ArrayBuffer.isView(v)) return v.slice ? v.slice() : new v.constructor(v.buffer.slice(0));
  if (v instanceof Error) {
    const e = new Error(v.message);
    e.name = v.name;
    return e;
  }
  if (v instanceof Map) {
    const m = new Map();
    seen.set(v, m);
    for (const [k, x] of v) m.set(clone(k, seen), clone(x, seen));
    return m;
  }
  if (v instanceof Set) {
    const m = new Set();
    seen.set(v, m);
    for (const x of v) m.add(clone(x, seen));
    return m;
  }
  const o = Array.isArray(v) ? [] : {};
  seen.set(v, o);
  for (const k of Object.keys(v)) o[k] = clone(v[k], seen);
  return o;
};
globalThis.structuredClone = (v) => clone(v, new Map());
globalThis.AbortSignal ??= class AbortSignal { aborted = false; addEventListener() {} removeEventListener() {} throwIfAborted() {} };
globalThis.AbortController ??= class AbortController { signal = new AbortSignal(); abort() { this.signal.aborted = true; } };
globalThis.DOMException ??= class DOMException extends Error { constructor(m, n) { super(m); this.name = n ?? 'Error'; } };
globalThis.URL ??= class URL {
  constructor(u, b) { const s = String(u); if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && b === undefined) throw new TypeError('Invalid URL'); this.href = s; this.protocol = (s.match(/^[a-z][a-z0-9+.-]*:/i) || [''])[0]; }
  toString() { return this.href; }
  static canParse() { return false; }
};
globalThis.ReadableStream ??= class ReadableStream {
  #src; #queue = []; #waiters = []; #closed = false; #err = null; #hasErr = false; #pulling = false;
  #hwm; #size; #ctl; #started = false;
  constructor(src = {}, strategy = {}) {
    this.#src = src; this.#hwm = strategy.highWaterMark ?? 1; this.#size = strategy.size ?? (() => 1);
    const self = this;
    this.#ctl = {
      get desiredSize() { return self.#hwm - self.#queue.reduce((s, q) => s + q.sz, 0); },
      enqueue(chunk) { const w = self.#waiters.shift(); if (w) w.resolve({ value: chunk, done: false }); else self.#queue.push({ chunk, sz: self.#size(chunk) }); },
      close() { self.#closed = true; for (const w of self.#waiters.splice(0)) w.resolve({ value: undefined, done: true }); },
      error(e) { self.#hasErr = true; self.#err = e; for (const w of self.#waiters.splice(0)) w.reject(e); },
    };
    Promise.resolve(src.start?.(this.#ctl)).then(() => { this.#started = true; this.#pull(); }, (e) => this.#ctl.error(e));
  }
  #pull() {
    if (!this.#started || this.#pulling || this.#closed || this.#hasErr || !this.#src.pull) return;
    if (this.#ctl.desiredSize <= 0 && !this.#waiters.length) return;
    this.#pulling = true;
    Promise.resolve(this.#src.pull(this.#ctl)).then(() => { this.#pulling = false; if (this.#waiters.length) this.#pull(); }, (e) => { this.#pulling = false; this.#ctl.error(e); });
  }
  getReader() {
    const self = this;
    return {
      read() {
        if (self.#queue.length) { const q = self.#queue.shift(); self.#pull(); return Promise.resolve({ value: q.chunk, done: false }); }
        if (self.#hasErr) return Promise.reject(self.#err);
        if (self.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => { self.#waiters.push({ resolve, reject }); self.#pull(); });
      },
      cancel(r) { self.#closed = true; self.#queue.length = 0; return Promise.resolve(self.#src.cancel?.(r)); },
      releaseLock() {},
    };
  }
};
