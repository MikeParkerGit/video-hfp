// FrameSource — one VideoDecoder bound to one Clip, producing decoded VideoFrames for a
// presentation range [from, to), optionally looping, with a small decoded lookahead.
//
// Chunks are fed in DECODE order (B-frames and all); the decoder returns frames in presentation
// order, and every delivered frame carries a presentation number `p` (counting from pStart at
// startIndex, continuing across loop wraps), so the Player picks frames by `p` and never sees the
// reordering. Bytes come from the clip's source; when a range is not resident yet the source
// fetches it and feeding resumes.

export class FrameSource {
  /**
   * @param {import('./clip.js').Clip} clip
   * @param {{lookahead?: number, VideoDecoder?: any, EncodedVideoChunk?: any}} opts
   */
  constructor(clip, { lookahead = 6, maxInflight = 24, VideoDecoder = globalThis.VideoDecoder, EncodedVideoChunk = globalThis.EncodedVideoChunk } = {}) {
    if (!VideoDecoder) throw new Error('WebCodecs VideoDecoder is not available in this context');
    this.clip = clip;
    this.lookahead = lookahead;       // decoded frames held here, waiting to be shown
    this.maxInflight = maxInflight;   // chunks fed but not yet output: a hardware decoder may buffer many before its first frame
    this.error = null;
    this.onerror = null;
    this.dropped = 0;
    this.fetchWaits = 0;

    this._Chunk = EncodedVideoChunk;
    this._queue = [];            // delivered, not yet consumed: {frame, p, index}
    this._pending = new Map();   // chunk timestamp (µs) -> {index (p), p, wanted}
    this._wantedInflight = 0;
    this._from = 0; this._to = clip.frameCount; this._loop = false; this._loopResume = 0;
    this._feedD = 0;             // next DECODE index to feed
    this._lastD = -1;            // last decode index of the current pass
    this._discardBelow = 0;      // presentation index below which outputs are closed unseen
    this._pass = 0;              // loop pass counter (timestamps stay monotonic across wraps)
    this._passBase = 0;          // p of presentation frame `from` in the current pass
    this._pBase0 = 0;            // the same for pass 0 (indexForP)
    this._maxFedP = -1;
    this._ended = true; this._flushing = false; this._closed = false; this._gen = 0; this._awaiting = false;
    this._primed = false;          // a silent decoder has been given leave to buffer past the lookahead
    this._primeTimer = null;

    this._decoder = new VideoDecoder({ output: (frame) => this._onOutput(frame), error: (e) => this._onError(e) });
  }

  get queued() { return this._queue.length; }
  /** Presentation number of the next frame this source will hand out (approximate while frames are in flight). */
  get nextP() {
    if (this._queue.length) return this._queue[0].p;
    let min = Infinity;
    for (const e of this._pending.values()) if (e.wanted && e.p < min) min = e.p;
    return min !== Infinity ? min : this._maxFedP + 1;
  }
  get ended() { return this._ended && this._queue.length === 0; }
  get range() { return { from: this._from, to: this._to, loop: this._loop }; }
  get stats() { return { queued: this._queue.length, inflight: this._wantedInflight, decodeQueue: this._decoder.decodeQueueSize, dropped: this.dropped, fetchWaits: this.fetchWaits, awaiting: this._awaiting }; }

  /**
   * Begin producing frames for [from, to), starting at `startIndex` (defaults to `from`),
   * numbering delivered frames from `pStart`. Safe to call repeatedly (re-seeks).
   */
  start({ from = 0, to = this.clip.frameCount, loop = false, startIndex = from, pStart = startIndex - from, loopResume = from } = {}) {
    if (this._closed) throw new Error('FrameSource is closed');
    if (!(from >= 0 && to <= this.clip.frameCount && from < to)) throw new RangeError(`bad range [${from}, ${to})`);
    if (!(startIndex >= from && startIndex < to)) throw new RangeError(`startIndex ${startIndex} outside [${from}, ${to})`);
    if (!(loopResume >= from && loopResume < to)) throw new RangeError(`loopResume ${loopResume} outside [${from}, ${to})`);
    this._from = from; this._to = to; this._loop = loop; this._loopResume = loopResume;
    this._reset();
    this._pass = 0;
    this._pBase0 = this._passBase = pStart - (startIndex - from);
    this._maxFedP = pStart - 1;
    this._feedD = this.clip.decodeIndexOf(this.clip.keyframeAtOrBefore(startIndex));
    this._lastD = this.clip.lastDecodeIndexBefore(to);
    this._discardBelow = startIndex;
    this._ended = false;
    this.fill();
  }

  /**
   * After each wrap, resume OUTPUT at presentation index `index` (the frames before it are decoded and discarded):
   * a loop whose wrap is covered by a bridge lets the decoder skip the bridged frames. Returns the pass number
   * (0 = the pass this source started in) from which the new resume point applies: the next wrap.
   */
  setLoopResume(index) {
    if (!(index >= this._from && index < this._to)) throw new RangeError(`loopResume ${index} outside [${this._from}, ${this._to})`);
    this._loopResume = index;
    return this._pass + 1;
  }
  /** Bind this source — and its decoder — to another clip; the next start() configures the decoder for it. */
  retarget(clip) { if (this._closed) throw new Error('FrameSource is closed'); this.clip = clip; }

  /** Re-seek inside the current range (the scheduler's catch-up after a stall). */
  reseek(index, p) { this.start({ from: this._from, to: this._to, loop: this._loop, startIndex: index, pStart: p, loopResume: this._loopResume }); }

  /** Presentation index that presentation number p maps to in the current range. */
  indexForP(p) {
    const len = this._to - this._from, q = p - this._pBase0;
    return this._loop ? this._from + ((q % len) + len) % len : Math.min(this._from + Math.max(0, q), this._to - 1);
  }

  peek() { return this._queue.length ? this._queue[0] : null; }
  /** Take the next frame. Caller owns it and must close() it. */
  shift() { const item = this._queue.shift(); if (item) this.fill(); return item; }
  /** Drop (close) queued frames with p < target. Returns how many were dropped. */
  dropBefore(target) {
    let n = 0;
    while (this._queue.length && this._queue[0].p < target) { this._queue.shift().frame.close(); n++; }
    if (n) { this.dropped += n; this.fill(); }
    return n;
  }

  /** Feed the decoder until the lookahead is satisfied (or the bytes run out, in which case it resumes when they land). */
  fill() {
    if (this._closed || this.error || this._ended || this._flushing || this._awaiting) return;
    const clip = this.clip;
    for (;;) {
      if (this._feedD > this._lastD) {
        if (this._loop) {
          // wrap: next pass starts at the keyframe before the resume point (`from`, or past a loop's bridge); outputs below it are discarded
          this._pass++;
          this._passBase += this._to - this._from;
          this._feedD = clip.decodeIndexOf(clip.keyframeAtOrBefore(this._loopResume));
          this._discardBelow = this._loopResume;
          continue;
        }
        this._flushing = true;
        const gen = this._gen;
        this._decoder.flush().then(
          () => { if (gen === this._gen) { this._flushing = false; this._ended = true; } },
          (e) => { if (gen === this._gen) { this._flushing = false; this._ended = true; if (e?.name !== 'AbortError') this._onError(e); } });
        return;
      }
      const d = this._feedD;
      const pres = clip.presIndexOf(d);
      const wanted = pres >= this._discardBelow && pres < this._to;
      // Hold `lookahead` decoded frames plus the reorder depth in flight — unless the decoder has gone
      // silent with that much queued, which is a hardware decoder that outputs nothing until its pipeline
      // is full (Android): then feed it up to maxInflight. Keeps a parked source's memory at its lookahead.
      if (wanted) {
        if (this._queue.length >= this.lookahead) return;
        const normal = this.lookahead + clip.reorderDepth;
        if (this._wantedInflight >= normal && (!this._primed || this._wantedInflight >= this.maxInflight)) { this._armPrime(); return; }
      }
      const bytes = clip.sampleBytes(d);
      if (!bytes) {
        // not resident: fetch this GOP's worth and come back
        this._awaiting = true; this.fetchWaits++;
        const gen = this._gen;
        clip.ensureDecodeRange(d, Math.min(d + Math.max(clip.gop, 1), clip.frameCount - 1)).then(
          () => { if (gen !== this._gen) return; this._awaiting = false; this.fill(); },
          (e) => { if (gen !== this._gen) return; this._awaiting = false; this._onError(e); });
        return;
      }
      this._feed(d, pres, wanted, bytes);
      this._feedD++;
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    for (const it of this._queue) it.frame.close();
    this._queue.length = 0;
    this._pending.clear();
    if (this._primeTimer) { clearTimeout(this._primeTimer); this._primeTimer = null; }
    try { this._decoder.close(); } catch { /* already closed */ }
  }

  // ---- internals -------------------------------------------------------------------------

  _reset() {
    for (const it of this._queue) it.frame.close();
    this._queue.length = 0;
    this._pending.clear();
    this._wantedInflight = 0;
    this._flushing = false; this._awaiting = false;
    if (this._primeTimer) { clearTimeout(this._primeTimer); this._primeTimer = null; }
    this._gen++;
    if (this._decoder.state === 'closed') throw new Error('VideoDecoder is closed');
    if (this._decoder.state !== 'unconfigured') this._decoder.reset();
    this._decoder.configure(this.clip.decoderConfig());
  }

  _feed(d, pres, wanted, bytes) {
    const clip = this.clip;
    const p = this._passBase + (pres - this._from);
    // presentation-ordered, unique across passes: the decoder reorders by this
    const timestamp = (this._pass * (clip.frameCount + 1) + pres) * 1000;
    this._pending.set(timestamp, { index: pres, p, wanted });
    if (wanted) { this._wantedInflight++; if (p > this._maxFedP) this._maxFedP = p; }
    const chunk = new this._Chunk({
      type: clip.samples[d].key ? 'key' : 'delta',
      timestamp,
      duration: Math.max(1, Math.round(clip.frameDurations[pres] * 1e6)),
      data: bytes,
    });
    try { this._decoder.decode(chunk); } catch (e) { this._onError(e); }
  }

  /** Arm a check: if nothing comes out within a moment while the lookahead's worth is in flight, let the decoder buffer more. */
  _armPrime() {
    if (this._primed || this._primeTimer) return;
    const gen = this._gen;
    this._primeTimer = setTimeout(() => {
      this._primeTimer = null;
      if (gen !== this._gen || this._closed) return;
      if (this._queue.length === 0 && this._wantedInflight > 0) { this._primed = true; this.fill(); }
    }, 120);
  }

  _onOutput(frame) {
    const entry = this._pending.get(frame.timestamp);
    if (!entry || this._closed) { frame.close(); return; }   // stale (from before a reset)
    this._pending.delete(frame.timestamp);
    if (!entry.wanted) { frame.close(); return; }
    this._wantedInflight--;
    this._queue.push({ frame, p: entry.p, index: entry.index });
    this.fill();
  }

  _onError(e) {
    if (this.error) return;
    this.error = e;
    if (this.onerror) this.onerror(e);
  }
}
