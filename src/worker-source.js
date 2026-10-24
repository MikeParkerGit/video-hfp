// WorkerSource — the main-thread half of a FrameSource that lives in decode-worker.js. Same
// surface as FrameSource (start/reseek/indexForP/peek/shift/dropBefore/close, queued/nextP/ended/
// range/stats/error/onerror), so the Player does not care which it holds. Frames arrive
// transferred from the worker and are closed here when drawn or dropped.

let nextId = 1;

export class DecodePool {
  constructor() {
    this.worker = new Worker(new URL('./decode-worker.js', import.meta.url), { type: 'module' });
    this.sources = new Map();   // id -> WorkerSource
    this.clips = new Map();     // Clip -> clipId
    this.worker.onmessage = (e) => { const m = e.data; const s = this.sources.get(m.id); if (s) s._onMessage(m); else if (m.type === 'frame') m.frame.close(); };
    this.worker.onerror = (e) => { for (const s of this.sources.values()) s._onError(new Error(e.message || 'decode worker failed')); };
  }
  clipId(clip) {
    let id = this.clips.get(clip);
    if (id) return id;
    id = `c${nextId++}`;
    const t = clip.toTransferable();
    this.worker.postMessage({ type: 'open', clipId: id, index: t.index, source: t.source, name: clip.name }, t.transfer);
    this.clips.set(clip, id);
    return id;
  }
  release(clip) { const id = this.clips.get(clip); if (id) { this.worker.postMessage({ type: 'closeClip', clipId: id }); this.clips.delete(clip); } }
  terminate() { this.worker.terminate(); for (const s of this.sources.values()) s._closeLocal(); this.sources.clear(); }
}

export class WorkerSource {
  constructor(clip, { lookahead = 6, pool }) {
    if (!pool) throw new Error('WorkerSource needs a DecodePool');
    this.clip = clip; this.pool = pool; this.lookahead = lookahead;
    this.id = `s${nextId++}`;
    this.error = null; this.onerror = null; this.dropped = 0; this.fetchWaits = 0;
    this._queue = []; this._gen = 0; this._ended = true; this._workerNextP = 0; this._closed = false;
    this._from = 0; this._to = clip.frameCount; this._loop = false; this._loopResume = 0; this._pBase0 = 0; this._maxP = -1; this._resumeWaiters = new Map();
    pool.sources.set(this.id, this);
    pool.worker.postMessage({ type: 'create', id: this.id, clipId: pool.clipId(clip), lookahead });
  }
  get queued() { return this._queue.length; }
  get nextP() { return this._queue.length ? this._queue[0].p : Math.max(this._workerNextP, this._maxP + 1); }
  get ended() { return this._ended && this._queue.length === 0; }
  get range() { return { from: this._from, to: this._to, loop: this._loop }; }
  get stats() { return { queued: this._queue.length, inflight: 0, decodeQueue: 0, dropped: this.dropped, fetchWaits: this.fetchWaits, awaiting: false, worker: true }; }

  start({ from = 0, to = this.clip.frameCount, loop = false, startIndex = from, pStart = startIndex - from, loopResume = from } = {}) {
    if (this._closed) throw new Error('WorkerSource is closed');
    if (!(from >= 0 && to <= this.clip.frameCount && from < to)) throw new RangeError(`bad range [${from}, ${to})`);
    if (!(startIndex >= from && startIndex < to)) throw new RangeError(`startIndex ${startIndex} outside [${from}, ${to})`);
    if (!(loopResume >= from && loopResume < to)) throw new RangeError(`loopResume ${loopResume} outside [${from}, ${to})`);
    this._from = from; this._to = to; this._loop = loop; this._loopResume = loopResume; this._pBase0 = pStart - (startIndex - from);
    this._clearQueue();
    this._gen++; this._ended = false; this._workerNextP = pStart; this._maxP = pStart - 1;
    for (const r of this._resumeWaiters.values()) r.reject(new Error('restarted')); this._resumeWaiters.clear();
    this.pool.worker.postMessage({ type: 'start', id: this.id, gen: this._gen, opts: { from, to, loop, startIndex, pStart, loopResume } });
  }
  reseek(index, p) { this.start({ from: this._from, to: this._to, loop: this._loop, startIndex: index, pStart: p, loopResume: this._loopResume }); }
  /** As FrameSource.setLoopResume, across the worker boundary: resolves to the pass number from which the new resume point applies. */
  setLoopResume(index) {
    if (this._closed) return Promise.reject(new Error('WorkerSource is closed'));
    if (!(index >= this._from && index < this._to)) return Promise.reject(new RangeError(`loopResume ${index} outside [${this._from}, ${this._to})`));
    this._loopResume = index;
    const token = `r${nextId++}`;
    return new Promise((resolve, reject) => {
      this._resumeWaiters.set(token, { resolve, reject, gen: this._gen });
      try { this.pool.worker.postMessage({ type: 'loopResume', id: this.id, index, token }); } catch (e) { this._resumeWaiters.delete(token); reject(e); }
    });
  }
  indexForP(p) {
    const len = this._to - this._from, q = p - this._pBase0;
    return this._loop ? this._from + ((q % len) + len) % len : Math.min(this._from + Math.max(0, q), this._to - 1);
  }
  peek() { return this._queue.length ? this._queue[0] : null; }
  shift() { const it = this._queue.shift(); if (it) this._consumed(1); return it; }
  dropBefore(target) {
    let n = 0;
    while (this._queue.length && this._queue[0].p < target) { this._queue.shift().frame.close(); n++; }
    if (n) { this.dropped += n; this._consumed(n); }
    return n;
  }
  fill() { /* the worker fills on its own */ }
  close() {
    if (this._closed) return;
    this._closed = true;
    this._closeLocal();
    this.pool.sources.delete(this.id);
    try { this.pool.worker.postMessage({ type: 'close', id: this.id }); } catch { /* terminated */ }
  }
  _closeLocal() { this._clearQueue(); for (const r of this._resumeWaiters.values()) r.reject(new Error('closed')); this._resumeWaiters.clear(); }
  _clearQueue() { for (const it of this._queue) it.frame.close(); this._queue.length = 0; }
  _consumed(n) { try { this.pool.worker.postMessage({ type: 'consumed', id: this.id, n }); } catch { /* terminated */ } }
  _onMessage(m) {
    if (m.type === 'frame') {
      if (m.gen !== this._gen || this._closed) { m.frame.close(); return; }
      this._queue.push({ frame: m.frame, p: m.p, index: m.index });
      if (m.p > this._maxP) this._maxP = m.p;
      this._workerNextP = m.nextP;
    } else if (m.type === 'state') { if (m.gen === this._gen) { this._workerNextP = m.nextP; if (m.ended) this._ended = true; } }
    else if (m.type === 'loopResume') { const w = this._resumeWaiters.get(m.token); if (w) { this._resumeWaiters.delete(m.token); if (m.gen === w.gen) w.resolve(m.pass); else w.reject(new Error('restarted')); } }
    else if (m.type === 'error') { if (m.gen === this._gen || m.gen === -1) this._onError(new Error(m.message)); }
  }
  _onError(e) { if (this.error) return; this.error = e; if (this.onerror) this.onerror(e); }
}
