// AudioEngine — sample-accurate audio for the Player without holding a whole track in memory.
//
// A clip's audio is decoded in WINDOWS (a few seconds each) from the track's samples with
// WebCodecs AudioDecoder, into AudioBuffers kept in a small LRU; a playing segment schedules an
// AudioBufferSourceNode per window piece at an absolute context time (`start(when, offset,
// duration)` is sample-accurate), a few seconds ahead of the clock. Loops and cutovers are just
// where the next piece starts — every piece is positioned from the timeline, never chained from
// the previous one, so nothing drifts. Where AudioDecoder is missing or the codec is not
// supported, the whole file is decoded once with decodeAudioData (the "yes, but memory" path).
//
// Timeline: player time t (the Player's clock) ↔ clip media time m. A segment starting at
// player time tStart on frame startIndex has m(t) = mStart + (t − tStart), wrapping over
// [mFrom, mTo) when it loops. Audio for media time m is scheduled at ctx time ctxTime(t).

const TS_OFFSET_US = 10_000_000;          // chunk timestamps stay positive even for trimmed lead-ins
const PREROLL = { opus: 0.08, 'mp4a': 0.05, mp3: 0.08, vorbis: 0.05, flac: 0, pcm: 0 };
const FADE = 0.003;

export class AudioEngine {
  constructor(ctx, { windowSeconds = 6, aheadSeconds = 8, maxWindows = 6 } = {}) {
    this.ctx = ctx;
    this.windowSeconds = windowSeconds;
    this.aheadSeconds = aheadSeconds;
    this.maxWindows = maxWindows;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this._clips = new Map();
    this.stats = { windowsDecoded: 0, late: 0, trimmedStarts: 0, mode: null };
  }
  clipAudio(clip) {
    let ca = this._clips.get(clip);
    if (!ca) { ca = new ClipAudio(this, clip); this._clips.set(clip, ca); }
    return ca;
  }
  createSegment(spec) { return new AudioSegment(this, spec); }
  release(clip) { const ca = this._clips.get(clip); if (ca) { ca.close(); this._clips.delete(clip); } }
  dispose() { for (const ca of this._clips.values()) ca.close(); this._clips.clear(); this.master.disconnect(); }
}

class ClipAudio {
  constructor(engine, clip) {
    this.engine = engine; this.clip = clip; this.track = clip.audio;
    this.sampleRate = this.track.sampleRate || engine.ctx.sampleRate;
    this.channels = this.track.channels || 2;
    this.windowSeconds = engine.windowSeconds;
    this._windows = new Map();   // index -> { buffer, promise, last }
    this._tick = 0;
    this._decoder = null; this._chain = Promise.resolve();
    this._whole = null;          // AudioBuffer from decodeAudioData, fallback mode
    this.mode = null;            // 'webcodecs' | 'whole'
    this.duration = this.track.samples.length ? this.track.samples[this.track.samples.length - 1].pts + this.track.samples[this.track.samples.length - 1].duration : 0;
    this.preroll = PREROLL[this.track.codec.split('.')[0]] ?? 0.05;
  }
  async _pickMode() {
    if (this.mode) return this.mode;
    let ok = false;
    if (typeof AudioDecoder !== 'undefined') {
      try { ok = !!(await AudioDecoder.isConfigSupported(this._config())).supported; } catch { ok = false; }
    }
    this.mode = ok ? 'webcodecs' : 'whole';
    this.engine.stats.mode = this.mode;
    return this.mode;
  }
  _config() {
    const cfg = { codec: this.track.codec, sampleRate: this.sampleRate, numberOfChannels: this.channels };
    if (this.track.description) cfg.description = this.track.description;
    return cfg;
  }
  /** The AudioBuffer for media window i, covering [i·W, (i+1)·W). Silent (null) past the track's end. */
  window(i) {
    const w = this._windows.get(i);
    if (w) { w.last = ++this._tick; return w.promise; }
    const entry = { buffer: null, promise: null, last: ++this._tick, done: false };
    entry.promise = this._build(i).then((b) => { entry.buffer = b; entry.done = true; this.engine.stats.windowsDecoded++; this._evict(); return b; });
    this._windows.set(i, entry);
    return entry.promise;
  }
  /** The decoded buffer for window i, `false` for a silent window past the track's end, null while not decoded. */
  windowReady(i) { const w = this._windows.get(i); if (!w || !w.done) return null; return w.buffer ?? false; }
  async _build(i) {
    const mode = await this._pickMode();
    const W = this.windowSeconds, start = i * W;
    if (start >= this.duration) return null;
    if (mode === 'whole') return this._sliceWhole(start, Math.min(W, this.duration - start));
    return this._decodeWindow(start, W);
  }
  _evict() {
    while (this._windows.size > this.engine.maxWindows) {
      let oldest = null, oldestT = Infinity;
      for (const [k, w] of this._windows) if (w.done && w.last < oldestT) { oldest = k; oldestT = w.last; }
      if (oldest == null) break;
      this._windows.delete(oldest);
    }
  }

  // ---- WebCodecs path: decode the samples covering a window, with a pre-roll, into a buffer
  _decodeWindow(start, W) {
    const run = async () => {
      const t = this.track, s = t.samples;
      const sr = this.sampleRate, ch = this.channels;
      const frames = Math.round(W * sr);
      const planes = Array.from({ length: ch }, () => new Float32Array(frames));
      // first sample at or before start − preroll; last sample before start + W
      let a = 0; while (a + 1 < s.length && s[a + 1].pts <= start - this.preroll) a++;
      let b = a; while (b + 1 < s.length && s[b + 1].pts < start + W) b++;
      if (s[a].pts >= start + W) return this._toBuffer(planes, sr);
      await this.clip.source.ensure(s[a].offset, (s[b].offset + s[b].size) - s[a].offset);
      if (!this._decoder || this._decoder.state === 'closed') {
        this._decoder = new AudioDecoder({ output: (ad) => this._onData(ad), error: (e) => { this._decoderError = e; } });
        this._decoder.configure(this._config());
      }
      this._sink = { planes, start, frames, sr, ch };
      for (let i = a; i <= b; i++) {
        const bytes = this.clip.source.slice(s[i].offset, s[i].size);
        if (!bytes) throw new Error('audio: sample bytes not resident after ensure');
        this._decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(s[i].pts * 1e6) + TS_OFFSET_US, duration: Math.round(s[i].duration * 1e6), data: bytes }));
      }
      await this._decoder.flush();
      if (this._decoderError) { const e = this._decoderError; this._decoderError = null; try { this._decoder.close(); } catch { /* */ } this._decoder = null; throw e; }
      this._sink = null;
      return this._toBuffer(planes, sr);
    };
    // one decoder, one window at a time
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }
  _onData(ad) {
    const sink = this._sink;
    if (!sink) { ad.close(); return; }
    const t = (ad.timestamp - TS_OFFSET_US) / 1e6;                   // media seconds of this chunk's first sample
    const pos = Math.round((t - sink.start) * sink.sr);               // sample position in the window
    const n = ad.numberOfFrames;
    const dstStart = Math.max(0, pos), dstEnd = Math.min(sink.frames, pos + n);
    if (dstEnd > dstStart) {
      const srcStart = dstStart - pos, count = dstEnd - dstStart;
      const tmp = new Float32Array(n);
      for (let c = 0; c < sink.ch; c++) {
        const plane = Math.min(c, ad.numberOfChannels - 1);
        if (ad.format === 'f32-planar') { ad.copyTo(tmp, { planeIndex: plane, format: 'f32-planar' }); sink.planes[c].set(tmp.subarray(srcStart, srcStart + count), dstStart); }
        else {
          // interleaved or other formats: ask for f32-planar conversion (supported by the spec); fall back to plane 0
          try { ad.copyTo(tmp, { planeIndex: plane, format: 'f32-planar' }); sink.planes[c].set(tmp.subarray(srcStart, srcStart + count), dstStart); }
          catch { const all = new Float32Array(n * ad.numberOfChannels); ad.copyTo(all, { planeIndex: 0, format: 'f32' }); for (let k = 0; k < count; k++) sink.planes[c][dstStart + k] = all[(srcStart + k) * ad.numberOfChannels + plane]; }
        }
      }
    }
    ad.close();
  }
  _toBuffer(planes, sr) {
    const buf = this.engine.ctx.createBuffer(planes.length, planes[0].length, sr);
    for (let c = 0; c < planes.length; c++) buf.copyToChannel(planes[c], c);
    return buf;
  }

  // ---- fallback: the whole file through decodeAudioData, windows sliced from it
  async _sliceWhole(start, len) {
    if (!this._whole) {
      const bytes = await this.clip.source.read(0, this.clip.source.size);
      const copy = bytes.slice().buffer;
      this._whole = await this.engine.ctx.decodeAudioData(copy);
      this.sampleRate = this._whole.sampleRate; this.channels = this._whole.numberOfChannels;
    }
    const sr = this._whole.sampleRate, ch = this._whole.numberOfChannels;
    const s0 = Math.round(start * sr), n = Math.round(len * sr);
    const buf = this.engine.ctx.createBuffer(ch, n, sr);
    for (let c = 0; c < ch; c++) { const src = this._whole.getChannelData(c); buf.copyToChannel(src.subarray(s0, Math.min(src.length, s0 + n)), c); }
    return buf;
  }
  close() { this._windows.clear(); this._whole = null; if (this._decoder) { try { this._decoder.close(); } catch { /* */ } this._decoder = null; } }
}

class AudioSegment {
  /**
   * @param {{ clip, from, to, loop, startIndex, tStart, ctxTime: (t:number)=>number }} spec
   */
  constructor(engine, spec) {
    this.engine = engine; this.spec = spec;
    const { clip } = spec;
    this.ca = engine.clipAudio(clip);
    this.gain = engine.ctx.createGain();
    this.gain.connect(engine.master);
    const t0 = spec.ctxTime(spec.tStart);
    this.gain.gain.setValueAtTime(0, Math.max(0, t0));
    this.gain.gain.linearRampToValueAtTime(1, Math.max(0, t0) + FADE);
    this.mFrom = clip.frameTime(spec.from) + clip.audioOffset;
    this.mTo = clip.rangeEnd(spec.to) + clip.audioOffset;
    this.mStart = clip.frameTime(spec.startIndex) + clip.audioOffset;
    this.period = this.mTo - this.mFrom;
    this._cursor = spec.tStart;              // player time scheduled up to
    this._media = this.mStart;               // media time at _cursor
    this._nodes = [];
    this._stopAt = Infinity; this._stopped = false; this._filling = false;
    this.late = 0;
  }
  /** Schedule pieces up to player time `until` (async; safe to call every tick). */
  async ensure(until) {
    if (this._stopped || this._filling) return;
    this._filling = true;
    try {
      while (this._cursor < Math.min(until, this._stopAt)) {
        const passEndMedia = this.mTo;
        let m0 = this._media;
        if (m0 >= passEndMedia - 1e-9) { if (!this.spec.loop) break; m0 = this._media = this.mFrom; }
        const W = this.ca.windowSeconds;
        const wi = Math.floor(m0 / W);
        const m1 = Math.min(passEndMedia, (wi + 1) * W, m0 + (Math.min(until, this._stopAt) - this._cursor) + 0.5);
        const len = m1 - m0;
        if (len <= 0) break;
        const buffer = await this.ca.window(wi);
        if (this._stopped) break;
        const when = this.spec.ctxTime(this._cursor);
        if (buffer) {
          const node = this.engine.ctx.createBufferSource();
          node.buffer = buffer;
          node.connect(this.gain);
          const now = this.engine.ctx.currentTime;
          let offset = m0 - wi * W, dur = len, at = when;
          if (when < now) {
            // Late: skip what should already have sounded and keep the timeline. A segment's first piece
            // is often a few ms late by construction (switchNow schedules 5 ms ahead, under the audio
            // clock's update granularity); that is a trimmed start, not a late piece.
            const lateBy = now - when;
            if (this._cursor === this.spec.tStart && lateBy < 0.03) this.engine.stats.trimmedStarts++;
            else { this.late++; this.engine.stats.late++; }
            if (lateBy >= len) { this._cursor += len; this._media = m1; continue; }
            offset += lateBy; dur -= lateBy; at = now;
          }
          node.start(at, offset, dur);
          this._nodes.push(node);
          node.onended = () => { const i = this._nodes.indexOf(node); if (i >= 0) this._nodes.splice(i, 1); };
        }
        this._cursor += len; this._media = m1;
      }
      // keep the next window warm
      const nextW = Math.floor((this._media >= this.mTo - 1e-9 ? this.mFrom : this._media) / this.ca.windowSeconds);
      this.ca.window(nextW).catch(() => {});
    } finally { this._filling = false; }
  }
  /** Fade out and stop at player time t (nodes already scheduled past t are cut by the gain). */
  stopAt(t) {
    if (this._stopped) return;
    this._stopAt = Math.min(this._stopAt, t);
    const ctx = this.engine.ctx, at = Math.max(this.spec.ctxTime(t), ctx.currentTime);
    const g = this.gain.gain;
    g.cancelScheduledValues(Math.max(at - FADE, ctx.currentTime));
    g.setValueAtTime(1, Math.max(at - FADE, ctx.currentTime));
    g.linearRampToValueAtTime(0, at);
    for (const n of this._nodes) { try { n.stop(at); } catch { /* not started */ } }
    this._stopped = true;
    setTimeout(() => this.dispose(), Math.max(0, (at - ctx.currentTime) * 1000) + 50);
  }
  dispose() {
    for (const n of this._nodes) { try { n.stop(); } catch { /* */ } try { n.disconnect(); } catch { /* */ } }
    this._nodes.length = 0;
    try { this.gain.disconnect(); } catch { /* */ }
    this._stopped = true;
  }
}
