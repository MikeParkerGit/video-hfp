// Clip — an opened file: the demuxed index (video samples in decode order, presentation times,
// keyframes, the decoder config, the audio track) over a ByteSource that holds the bytes, whole
// or fetched by range. The player addresses frames by PRESENTATION index p (0 … frameCount−1);
// the clip maps that to decode order, byte ranges and times.
import { demuxMp4 } from './demux/mp4.js';
import { demuxWebm } from './demux/webm.js';
import { BufferSource, RangeSource, probeUrl } from './loader.js';

export class Clip {
  /**
   * @param {object} index  the demuxer's result ({ container, duration, video, audio })
   * @param {BufferSource|RangeSource} source
   */
  constructor(index, source, { name = '', url = null } = {}) {
    this.name = name;
    this.url = url;
    this.index = index;
    this.container = index.container;
    this.source = source;
    this.audio = index.audio && index.audio.codec ? index.audio : null;
    const v = index.video;
    this.codec = v.codec;
    this.format = v.format;
    this.width = v.codedWidth;
    this.height = v.codedHeight;
    this.pixelAspect = v.pixelAspect || 1;
    this.description = v.description;
    this.samples = v.samples;                      // decode order
    const n = this.frameCount = this.samples.length;
    if (!n) throw new Error('clip: no video frames');

    // presentation order = by pts (stable on decode order)
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => this.samples[a].pts - this.samples[b].pts || a - b);
    this.decodeOf = order;                          // p → decode index
    this.presOf = new Int32Array(n);                // decode index → p
    for (let p = 0; p < n; p++) this.presOf[order[p]] = p;
    this.frameTimes = new Float64Array(n);
    for (let p = 0; p < n; p++) this.frameTimes[p] = this.samples[order[p]].pts;
    this.frameDurations = new Float64Array(n);
    for (let p = 0; p < n - 1; p++) this.frameDurations[p] = this.frameTimes[p + 1] - this.frameTimes[p];
    this.frameDurations[n - 1] = this.samples[order[n - 1]].duration || (n > 1 ? this.frameDurations[n - 2] : 1 / 30);
    // nominal frame rate: the most common sample duration, in the container's own units so 30 fps is exactly 30
    const timescale = v.timescale || 1e6;
    const counts = new Map();
    for (let p = 0; p < n; p++) { const k = this.samples[order[p]].durationUnits ?? Math.round(this.frameDurations[p] * timescale); counts.set(k, (counts.get(k) || 0) + 1); }
    let best = 0, bestK = 0;
    for (const [k, c] of counts) if (c > best) { best = c; bestK = k; }
    this.fpsNum = timescale; this.fpsDen = bestK || Math.round(timescale / 30);
    this.frameDuration = this.fpsDen / this.fpsNum;
    this.fps = this.fpsNum / this.fpsDen;
    let off = 0;
    for (let p = 0; p < n; p++) if (Math.abs(this.frameDurations[p] - this.frameDuration) > this.frameDuration * 0.02) off++;
    this.vfr = off > 2;                             // more than a couple of odd durations: a variable-rate file
    this.keyframes = [];
    this.keyBefore = new Int32Array(n);
    this.prefixMaxDecode = new Int32Array(n);
    let k = 0, maxD = -1;
    for (let p = 0; p < n; p++) {
      const d = order[p];
      if (this.samples[d].key) { k = p; this.keyframes.push(p); }
      this.keyBefore[p] = k;
      if (d > maxD) maxD = d;
      this.prefixMaxDecode[p] = maxD;
    }
    if (!this.samples[order[0]].key) throw new Error('clip: the first frame is not a keyframe');
    // reorder depth: how many frames a decoder holds back for B-frames (0 for decode order == display order);
    // the FrameSource adds it to its lookahead so the queue still fills
    let depth = 0;
    for (let d = 0; d < n; d++) depth = Math.max(depth, d - this.presOf[d]);
    this.reorderDepth = depth;
    let gop = 0;
    for (let i = 0; i < this.keyframes.length; i++) {
      const next = i + 1 < this.keyframes.length ? this.keyframes[i + 1] : n;
      gop = Math.max(gop, next - this.keyframes[i]);
    }
    this.gop = gop;
    this.duration = this.frameEnd(n - 1);
    this.audioOffset = 0;                           // seconds added to the audio read position; a per-platform nudge
  }

  // ---- times --------------------------------------------------------------------------------
  frameTime(p) { return this.frameTimes[p]; }
  frameEnd(p) { return this.frameTimes[p] + this.frameDurations[p]; }
  /** Time of the slot after `to-1`: frameEnd(to-1); for to == frameCount that is the clip's end. */
  rangeEnd(to) { return this.frameEnd(to - 1); }
  /** Largest p in [lo, hi) whose frame starts at or before t (lo when t is before the range). */
  frameAt(t, lo = 0, hi = this.frameCount) {
    if (!this.vfr) { const p = lo + Math.floor((t - this.frameTimes[lo]) / this.frameDuration + 1e-6); return Math.max(lo, Math.min(hi - 1, p)); }
    let a = lo, b = hi - 1;
    while (a < b) { const m = (a + b + 1) >> 1; if (this.frameTimes[m] <= t) a = m; else b = m - 1; }
    return a;
  }

  // ---- structure ----------------------------------------------------------------------------
  isKeyframe(p) { return this.samples[this.decodeOf[p]].key; }
  keyframeAtOrBefore(p) { return this.keyBefore[p]; }
  /** Decode index of presentation frame p. */
  decodeIndexOf(p) { return this.decodeOf[p]; }
  /** Presentation index of the frame at decode index d. */
  presIndexOf(d) { return this.presOf[d]; }
  /** Highest decode index among presentation frames < to (feed up to and including it to show every frame before `to`). */
  lastDecodeIndexBefore(to) { return this.prefixMaxDecode[to - 1]; }

  // ---- bytes --------------------------------------------------------------------------------
  /** Encoded bytes of the frame at DECODE index d, or null when they are not resident yet (see ensureDecodeRange). */
  sampleBytes(d) { const s = this.samples[d]; return this.source.slice(s.offset, s.size); }
  hasDecodeRange(d0, d1) { const a = this.samples[d0], b = this.samples[Math.min(d1, this.frameCount - 1)]; return this.source.has(a.offset, b.offset + b.size - a.offset); }
  /** Fetch the bytes for decode indices d0..d1 (inclusive, clamped). */
  async ensureDecodeRange(d0, d1) {
    d1 = Math.min(d1, this.frameCount - 1);
    const a = this.samples[d0], b = this.samples[d1];
    const start = Math.min(a.offset, b.offset), end = Math.max(a.offset + a.size, b.offset + b.size);
    await this.source.ensure(start, end - start);
  }
  /** Keep a presentation range's bytes resident across evictions (a loop's window). */
  pinRange(from, to) {
    if (!('pin' in this.source)) return;
    if (from == null) { this.source.pin = null; return; }
    let lo = Infinity, hi = 0;
    for (let p = this.keyBefore[from]; p < to; p++) { const s = this.samples[this.decodeOf[p]]; lo = Math.min(lo, s.offset); hi = Math.max(hi, s.offset + s.size); }
    this.source.pin = [lo, hi];
  }

  decoderConfig() {
    // the low-latency hint only makes sense for a stream with no reordering; with B-frames some hardware decoders misbehave under it
    const cfg = { codec: this.codec, codedWidth: this.width, codedHeight: this.height, optimizeForLatency: this.reorderDepth === 0 };
    if (this.description) cfg.description = this.description;
    return cfg;
  }
  async isSupported() {
    if (typeof VideoDecoder === 'undefined' || !this.codec) return false;
    try { return !!(await VideoDecoder.isConfigSupported(this.decoderConfig())).supported; } catch { return false; }
  }
  /** Everything a lightweight copy needs (a worker, a listing): no samples, no bytes. */
  describe() {
    return { name: this.name, url: this.url, container: this.container, codec: this.codec, width: this.width, height: this.height, fps: this.fps, vfr: this.vfr,
      frameCount: this.frameCount, gop: this.gop, keyframes: this.keyframes.length, duration: this.duration,
      audio: this.audio ? { codec: this.audio.codec, sampleRate: this.audio.sampleRate, channels: this.audio.channels } : null };
  }
  /** The index plus a way to the bytes, for a decode worker: a copy of a whole-file source (transferred), or the URL for a range source. */
  toTransferable() {
    const src = this.source;
    if (src.url && 'windowBytes' in src) return { index: this.index, source: { kind: 'range', url: src.url, size: src.size, windowBytes: src.windowBytes, budgetBytes: src.budgetBytes }, transfer: [] };
    const bytes = src.bytes.slice();
    return { index: this.index, source: { kind: 'buffer', bytes }, transfer: [bytes.buffer] };
  }
  close() { this.source.close(); }
}

const td = new TextDecoder();
function sniff(head) {
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  if (head.length >= 8) { const t = td.decode(head.subarray(4, 8)); if (['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip', 'pnot'].includes(t)) return 'mp4'; }
  return null;
}

export const WHOLE_FILE_LIMIT = 8 << 20;   // below this, fetch whole: one request and no window bookkeeping

/**
 * Open a clip from a URL, a Blob/File, or bytes.
 * @param {string|Blob|ArrayBuffer|Uint8Array} src
 * @param {{ name?: string, stream?: boolean|'auto', windowBytes?: number, budgetBytes?: number, fetch?: typeof fetch }} opts
 *   stream: 'auto' (default) fetches whole files under WHOLE_FILE_LIMIT and ranges above it when the server answers them.
 */
export async function loadClip(src, { name, stream = 'auto', windowBytes, budgetBytes, fetch: fetchFn, onProgress } = {}) {
  let source, url = null;
  const stage = (s) => { try { onProgress?.(s); } catch { /* */ } };
  if (typeof src === 'string') {
    url = typeof location !== 'undefined' ? new URL(src, location.href).href : src;   // absolute, so a worker or a listing can reach it
    fetchFn = fetchFn || globalThis.fetch.bind(globalThis);
    const info = await probeUrl(url, fetchFn, { onProgress: (s) => stage(`asking the server about the file (${s})`) });
    const useRanges = stream === true || (stream === 'auto' && info.ranges && info.size >= WHOLE_FILE_LIMIT);
    if (useRanges && !info.ranges) throw new Error(`loadClip: ${url} does not answer byte ranges`);
    if (info.bytes) source = new BufferSource(info.bytes);
    else if (useRanges) source = new RangeSource(url, info.size, { windowBytes, budgetBytes, fetch: fetchFn });
    else { stage(`fetching the whole file (${(info.size / 1048576).toFixed(1)} MB)`); const res = await fetchFn(url); if (!res.ok) throw new Error(`loadClip: ${url} → ${res.status}`); source = new BufferSource(await res.arrayBuffer()); }
  } else if (typeof Blob !== 'undefined' && src instanceof Blob) { source = new BufferSource(await src.arrayBuffer()); name = name ?? src.name; }
  else source = new BufferSource(src);
  stage('reading the index');
  const head = await source.read(0, 12);
  const kind = sniff(head);
  if (!kind) throw new Error('loadClip: not an MP4/MOV or WebM/MKV file');
  const index = kind === 'mp4' ? await demuxMp4(source) : await demuxWebm(source);
  stage('indexed');
  return new Clip(index, source, { name: name ?? (url ? url.split('/').pop().replace(/\.[^.]*$/, '') : 'clip'), url });
}
