// Bridge — a prepared target. The first frames of a clip from `frame` on, decoded ahead of time by a
// SOFTWARE decoder and held RAW: the planes as the decoder hands them over (I420/NV12, 1.5 bytes a
// pixel), one ArrayBuffer per bridge, rebuilt as VideoFrames at draw time (well under a millisecond).
// No decoder is held between prepare and cut. At a cut the bridge plays from the next display frame
// while the decoder that was playing re-targets behind it, and hands over at `count` — the same
// frame-exact two-source swap the loops use.
//
// The bridge is sized per TARGET from the clip's index, which is complete at load: `frame −
// keyBefore(frame)` is the exact decode run the re-targeted decoder has to do before it can show
// `frame`, and a HARDWARE FLOOR profile (profiles.js) says how long that takes on the slowest device
// we size for. No GOP default is ever needed; no device is measured at runtime.
import { FrameSource } from './frame-source.js';
import { HARDWARE_FLOOR } from './profiles.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let Soft = null;
/** A VideoDecoder that asks for software decode: a bridge must not take a hardware decoder from the clip that plays. */
export function softDecoderClass() {
  if (!Soft) {
    if (typeof VideoDecoder === 'undefined') throw new Error('WebCodecs VideoDecoder is not available in this context');
    Soft = class SoftDecoder extends VideoDecoder { configure(cfg) { return super.configure({ ...cfg, hardwareAcceleration: 'prefer-software' }); } };
  }
  return Soft;
}

/**
 * How many frames a bridge into `clip` at `frame` holds: the smallest N whose span at the clip's
 * frame rate covers the floor device's decoder restart, the decode run from the keyframe before
 * the HAND-OFF frame (frame + N — that is where the decoder behind the bridge starts) to it, and a
 * margin. Solved by scanning N upward: a keyframe inside the bridge shortens the run, so a target
 * late in a long GOP needs far fewer frames than its own lead-in suggests. Clamped to the frames
 * the clip has left.
 */
export function bridgeFrames(clip, frame, floor = HARDWARE_FLOOR) {
  const pixels = Math.max(1, clip.width * clip.height);
  const decodeFps = floor.decodeFps * (floor.decodeFpsAtPixels ?? 1920 * 1080) / pixels;   // the floor's decode rate is given at one resolution and scales with the pixel count
  const fixed = floor.decoderRestartMs / 1000 + floor.marginMs / 1000;
  const last = clip.frameCount - 1;
  const left = clip.frameCount - frame;
  for (let n = 1; n < left; n++) {
    const handoff = Math.min(last, frame + n);
    const run = handoff - clip.keyframeAtOrBefore(handoff);
    if (n / clip.fps >= fixed + run / decodeFps) return Math.min(left, Math.max(MIN_BRIDGE_FRAMES, n));
  }
  return Math.max(1, left);
}

/** No bridge is ever shorter than this (ruled 2026-10-22), however fast the device measures or plays. */
export const MIN_BRIDGE_FRAMES = 5;

/**
 * What a hand-off taught us (ruled 2026-10-22): the next length for a bridge of `n` frames after a
 * hand-off where the decoder was `late` slots (the screen held the bridge's last frame that long)
 * or, when it was on time, had been ready after `used` of the bridge's frames. Late: grow to n +
 * late + 2. Early, with less than three quarters of the bridge used: shrink to what was used plus a
 * tenth (at least two frames), never below MIN_BRIDGE_FRAMES. Otherwise null: leave it.
 */
export function adjustBridge(n, { used = null, late = 0 } = {}) {
  if (late > 0) return n + late + 2;
  if (used == null || used >= 0.75 * n) return null;
  const next = Math.max(MIN_BRIDGE_FRAMES, used + Math.max(2, Math.ceil(used * 0.1)));
  return next < n ? next : null;
}
/** The longest bridge any frame of a clip (or a synthetic one) needs: the worst frame of one GOP. */
export function maxBridgeFrames(clip, floor = HARDWARE_FLOOR) {
  const span = Math.min(clip.frameCount, Math.max(1, clip.gop || 1));
  let worst = 1;
  for (let f = 0; f < span; f++) worst = Math.max(worst, bridgeFrames(clip, f, floor));
  return worst;
}

export class Bridge {
  /** @param {{format: string, codedWidth: number, codedHeight: number, displayWidth: number, displayHeight: number, frameBytes: number, count: number}} shape */
  constructor(clip, frame, shape) {
    this.clip = clip;
    this.frame = frame;
    this.count = shape.count;
    this.format = shape.format;
    this.codedWidth = shape.codedWidth; this.codedHeight = shape.codedHeight;
    this.displayWidth = shape.displayWidth; this.displayHeight = shape.displayHeight;
    this.frameBytes = shape.frameBytes;
    this.layout = null;              // the plane layout copyTo reported (the same for every frame)
    this.buffer = new ArrayBuffer(shape.frameBytes * shape.count);
    this.filled = 0;
    this.closed = false;
  }
  get bytes() { return this.frameBytes * this.count; }
  get end() { return this.frame + this.count; }
  has(index) { return !this.closed && index >= this.frame && index < this.frame + this.filled; }
  /** A fresh VideoFrame of clip frame `index`, rebuilt from the parked planes. The caller closes it. */
  frameAt(index) {
    if (!this.has(index)) throw new RangeError(`bridge: frame ${index} is not in [${this.frame}, ${this.frame + this.filled})`);
    const i = index - this.frame;
    const init = { format: this.format, codedWidth: this.codedWidth, codedHeight: this.codedHeight, timestamp: Math.round(this.clip.frameTime(index) * 1e6), displayWidth: this.displayWidth, displayHeight: this.displayHeight };
    if (this.layout) init.layout = this.layout;
    return new VideoFrame(new Uint8Array(this.buffer, i * this.frameBytes, this.frameBytes), init);
  }
  close() { this.closed = true; this.buffer = null; }
}

/** The copy-out shape for a decoded frame: its own format when it has one; through a canvas (RGBX) when the decoder's frames are opaque. */
function shapeOf(frame, count) {
  const rect = frame.visibleRect;
  if (frame.format) return { format: frame.format, codedWidth: rect.width, codedHeight: rect.height, displayWidth: frame.displayWidth, displayHeight: frame.displayHeight, frameBytes: frame.allocationSize({ rect }), count, rect, viaCanvas: false };
  return { format: 'RGBX', codedWidth: rect.width, codedHeight: rect.height, displayWidth: frame.displayWidth, displayHeight: frame.displayHeight, frameBytes: rect.width * rect.height * 4, count, rect, viaCanvas: true };
}

/**
 * Build a bridge: decode `count` frames of `clip` from `frame` with a software decoder, copy each out,
 * release the decoder. Resolves to the Bridge; rejects when the decoder cannot deliver (then nothing
 * is held). `count` defaults to bridgeFrames(clip, frame, floor).
 */
export async function buildBridge(clip, frame, { count, floor = HARDWARE_FLOOR, timeoutMs, VideoDecoder: Dec } = {}) {
  if (!(Number.isInteger(frame) && frame >= 0 && frame < clip.frameCount)) throw new RangeError(`bridge: frame ${frame} is outside [0, ${clip.frameCount})`);
  count = Math.max(1, Math.min(count ?? bridgeFrames(clip, frame, floor), clip.frameCount - frame));
  const src = new FrameSource(clip, { lookahead: count + clip.reorderDepth + 2, VideoDecoder: Dec ?? softDecoderClass() });
  src.start({ from: frame, to: frame + count, loop: false, startIndex: frame });
  const deadline = performance.now() + (timeoutMs ?? Math.max(6000, 150 * count));
  let bridge = null, canvas = null, got = 0;
  try {
    while (got < count) {
      if (src.error) throw src.error;
      const item = src.peek();
      if (item) {
        src.shift();
        try {
          if (item.index !== frame + got) throw new Error(`bridge: expected frame ${frame + got}, the decoder gave ${item.index}`);
          const shape = bridge ? null : shapeOf(item.frame, count);
          if (!bridge) { bridge = new Bridge(clip, frame, shape); bridge._rect = shape.rect; bridge._viaCanvas = shape.viaCanvas; }
          const dest = new Uint8Array(bridge.buffer, got * bridge.frameBytes, bridge.frameBytes);
          if (!bridge._viaCanvas) { const layout = await item.frame.copyTo(dest, { rect: bridge._rect }); bridge.layout ??= layout; }
          else {
            canvas ??= new OffscreenCanvas(bridge.codedWidth, bridge.codedHeight);
            canvas.getContext('2d').drawImage(item.frame, 0, 0);
            const f2 = new VideoFrame(canvas, { timestamp: 0 });
            try { const layout = await f2.copyTo(dest); bridge.layout ??= layout; bridge.format = f2.format; } finally { f2.close(); }
          }
        } finally { item.frame.close(); }
        got++; bridge.filled = got;
        continue;
      }
      if (src.ended) throw new Error(`bridge: the decoder ended after ${got} of ${count} frames of ${clip.name}`);
      if (performance.now() > deadline) throw new Error(`bridge: no frame from the decoder within ${Math.round((deadline - performance.now()) / 1000) || 'the'} time allowed (${got} of ${count} frames of ${clip.name})`);
      await sleep(4);
    }
  } catch (e) { bridge?.close(); throw e; }
  finally { src.close(); }
  return bridge;
}

/**
 * BridgeSource — a Bridge behind the same surface a FrameSource has (peek / shift / dropBefore /
 * reseek / close, queued / nextP / ended), so the scheduler plays it like any source. Frames are
 * rebuilt one at a time, on peek, and the player closes each after drawing it.
 */
export class BridgeSource {
  /** @param {{keep?: boolean}} opts  keep: closing this source leaves the Bridge alive (a loop's wrap bridge is used every pass) */
  constructor(bridge, { keep = false } = {}) {
    this.bridge = bridge;
    this.keep = keep;
    this.clip = bridge.clip;
    this.error = null; this.onerror = null;
    this.dropped = 0; this.fetchWaits = 0;
    this._p = 0; this._indexForP = (p) => bridge.frame + p; this._item = null; this._closed = false;
  }
  get isBridge() { return true; }
  /** @param {{pStart?: number, indexForP?: (p: number) => number}} opts  pStart: the presentation number of the bridge's first frame; indexForP: the segment's mapping */
  start({ pStart = 0, indexForP } = {}) { this._drop(); this._p = pStart; if (indexForP) this._indexForP = indexForP; }
  reseek(index, p) { this._drop(); this._p = p; }
  get queued() { if (this._closed) return 0; let n = 0; while (n < this.bridge.count && this.bridge.has(this._indexForP(this._p + n))) n++; return n; }
  get nextP() { return this._p; }
  get ended() { return this._closed || !this.bridge.has(this._indexForP(this._p)); }
  get range() { return { from: this.bridge.frame, to: this.bridge.end, loop: false }; }
  get stats() { return { queued: this.queued, inflight: 0, decodeQueue: 0, dropped: this.dropped, fetchWaits: 0, awaiting: false, bridge: true }; }
  peek() {
    if (this._closed) return null;
    const index = this._indexForP(this._p);
    if (!this.bridge.has(index)) return null;
    if (!this._item) this._item = { frame: this.bridge.frameAt(index), p: this._p, index };
    return this._item;
  }
  shift() { const it = this.peek(); if (!it) return undefined; this._item = null; this._p++; return it; }
  dropBefore(target) {
    let n = 0;
    if (this._item && this._item.p < target) this._drop();
    while (this._p < target) { if (this.bridge.has(this._indexForP(this._p))) n++; this._p++; }
    this.dropped += n;
    return n;
  }
  fill() { /* nothing to feed: the frames are parked */ }
  _drop() { if (this._item) { this._item.frame.close(); this._item = null; } }
  close() { if (this._closed) return; this._closed = true; this._drop(); if (!this.keep) this.bridge.close(); }
}
