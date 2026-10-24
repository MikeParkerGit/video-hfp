// ByteSources: where a clip's bytes come from. The demuxers and the Clip read through one of
// these, so a whole file in memory and a file fetched by byte ranges look the same.
//
//   BufferSource(bytes)             — everything resident (small clips, tests, Node)
//   RangeSource(url, size, opts)    — windows fetched on demand with Range requests, LRU-bounded

export class BufferSource {
  constructor(bytes) {
    // A plain Uint8Array view, never a Node Buffer: Buffer.slice shares memory where Uint8Array.slice copies.
    this.bytes = bytes instanceof Uint8Array ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
    this.size = this.bytes.length; this.url = null;
  }
  async read(offset, length) { return this.bytes.subarray(offset, Math.min(this.size, offset + length)); }
  has() { return true; }
  slice(offset, length) { return this.bytes.subarray(offset, offset + length); }
  async ensure() { /* resident */ }
  get residentBytes() { return this.size; }
  close() { /* nothing to release */ }
}

/**
 * Byte windows over HTTP ranges. `slice()` is synchronous and answers only resident bytes;
 * `ensure()` fetches the window(s) covering a range. Windows are `windowBytes` wide and aligned,
 * so successive GOPs of a clip usually land in one or two requests; the LRU keeps `budgetBytes`.
 */
export class RangeSource {
  constructor(url, size, { windowBytes = 1 << 20, budgetBytes = 64 << 20, fetch: fetchFn = globalThis.fetch.bind(globalThis), pin = null } = {}) {
    this.url = url; this.size = size; this.windowBytes = windowBytes; this.budgetBytes = budgetBytes; this._fetch = fetchFn;
    this._windows = new Map();   // windowIndex -> { bytes, last }
    this._inflight = new Map();  // windowIndex -> Promise
    this._tick = 0; this._resident = 0;
    this.pin = pin;              // optional [start, end) byte range never evicted (a loop's window)
    this.stats = { requests: 0, bytes: 0, evictions: 0 };
  }
  get residentBytes() { return this._resident; }
  _index(offset) { return Math.floor(offset / this.windowBytes); }
  has(offset, length) {
    for (let w = this._index(offset); w <= this._index(offset + length - 1); w++) if (!this._windows.has(w)) return false;
    return true;
  }
  slice(offset, length) {
    const w0 = this._index(offset), w1 = this._index(offset + length - 1);
    const first = this._windows.get(w0);
    if (!first) return null;
    first.last = ++this._tick;
    if (w0 === w1) { const o = offset - w0 * this.windowBytes; return first.bytes.subarray(o, o + length); }
    const out = new Uint8Array(length); let p = 0;
    for (let w = w0; w <= w1; w++) {
      const win = this._windows.get(w); if (!win) return null; win.last = this._tick;
      const start = Math.max(offset, w * this.windowBytes), end = Math.min(offset + length, w * this.windowBytes + win.bytes.length);
      out.set(win.bytes.subarray(start - w * this.windowBytes, end - w * this.windowBytes), p); p += end - start;
    }
    return out;
  }
  async read(offset, length) { await this.ensure(offset, length); return this.slice(offset, length); }
  async ensure(offset, length) {
    const w0 = this._index(offset), w1 = this._index(Math.min(this.size, offset + length) - 1);
    const waits = [];
    for (let w = w0; w <= w1; w++) if (!this._windows.has(w)) waits.push(this._load(w));
    await Promise.all(waits);
  }
  _load(w) {
    if (this._inflight.has(w)) return this._inflight.get(w);
    const start = w * this.windowBytes, end = Math.min(this.size, start + this.windowBytes) - 1;
    const p = (async () => {
      const res = await this._fetch(this.url, { headers: { range: `bytes=${start}-${end}` } });
      if (res.status !== 206) throw new Error(`range request for ${this.url} answered ${res.status} (the server must support byte ranges)`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      this.stats.requests++; this.stats.bytes += bytes.length;
      this._windows.set(w, { bytes, last: ++this._tick }); this._resident += bytes.length;
      this._evict();
    })().finally(() => this._inflight.delete(w));
    this._inflight.set(w, p);
    return p;
  }
  _evict() {
    if (this._resident <= this.budgetBytes) return;
    const order = [...this._windows.entries()].sort((a, b) => a[1].last - b[1].last);
    for (const [w, win] of order) {
      if (this._resident <= this.budgetBytes) break;
      const s = w * this.windowBytes, e = s + win.bytes.length;
      if (this.pin && e > this.pin[0] && s < this.pin[1]) continue;
      this._windows.delete(w); this._resident -= win.bytes.length; this.stats.evictions++;
    }
  }
  close() { this._windows.clear(); this._resident = 0; }
}

/**
 * Learn a URL's size and whether it answers ranges (one HEAD, falling back to a 1-byte GET).
 * @returns {{ size: number, ranges: boolean }}
 */
export async function probeUrl(url, fetchFn = globalThis.fetch.bind(globalThis), { timeoutMs = 6000, onProgress } = {}) {
  // A proxy between the page and the server may not answer HEAD, or may sit on it: bound each
  // attempt and fall through — HEAD, then a one-byte ranged GET, then a plain GET (no ranges).
  const timed = async (init, label) => {
    onProgress?.(label);
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctl && setTimeout(() => ctl.abort(), timeoutMs);
    try { return await fetchFn(url, { ...init, signal: ctl?.signal }); }
    catch { return null; }
    finally { if (t) clearTimeout(t); }
  };
  let res = await timed({ method: 'HEAD' }, 'HEAD');
  if (!res || !res.ok) res = await timed({ headers: { range: 'bytes=0-0' } }, 'ranged GET');
  if (!res || (!res.ok && res.status !== 206)) {
    res = await timed({}, 'GET');
    if (!res || !res.ok) throw new Error(`loadClip: ${url} → ${res ? res.status : 'no answer'}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { size: bytes.length, ranges: false, bytes };
  }
  const ranges = /bytes/i.test(res.headers.get('accept-ranges') || '') || res.status === 206;
  let size = Number(res.headers.get('content-length'));
  const cr = res.headers.get('content-range');
  if (cr) { const m = /\/(\d+)$/.exec(cr); if (m) size = Number(m[1]); }
  if (res.status === 206 && res.body) { try { await res.arrayBuffer(); } catch { /* ignore */ } }
  return { size: Number.isFinite(size) ? size : 0, ranges };
}
