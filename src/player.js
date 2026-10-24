// Player — the engine behind <video-hfp>: a frame-accurate scheduler driving one canvas from frame
// sources, clocked by an AudioContext so audio and video share a sample-accurate timeline.
//
//   const engine = new Player(canvas);
//   const a = await loadClip('a.mp4'), b = await loadClip('b.mp4');
//   engine.play(a, { from: 0, to: a.frameCount, loop: true });
//   const h = await engine.prepare(b, 438);     // a BRIDGE: b's frames from 438 on, parked raw; no decoder held
//   engine.cut(h);                               // the next display frame shows b#438; the playing decoder re-targets behind the bridge
//   engine.cutAfter(1527, b, 438);               // after a shows 1527, b#438 takes the next slot (bridged when prepared, else cold)
//
// A loop whose lead-in (from the keyframe before `from`) is longer than the lookahead gets a bridge
// too: the loop's first frames, parked once and played at every wrap while the one decoder decodes
// the lead-in behind them and resumes past the bridge. One decoder, one bridge, no second decoder.
//
// Events: 'segmentstart' {clip, from, to, loop, tStart}, 'switch' {fromClip, fromFrame, toClip, toFrame},
//         'frame' {clip, index, p}, 'loop' {clip, pass}, 'ended' {clip}, 'stall' {clip, p},
//         'error' {error, clip, recovered}, 'blocked' {clip} (audio needs a gesture),
//         'memory' {bytes, level, previous}, 'optimized' {profile, floor, source: 'stored' | 'measured'},
//         'handoff' {clip, bridge, used, late, next}, 'tuned' {clip, bridge, used, late, next, scale}
//
// The clock. Video time is the AudioContext's clock minus the device's output latency, so a
// frame is drawn when its audio is HEARD, not when it was scheduled. A clip with no audio (or a
// muted player) can play before any gesture: the clock then runs on performance.now() until the
// context is running, and hands over without a jump. `avOffset` is a manual nudge on top
// (positive = video earlier).
//
// The player imposes no limits of its own: it asks for every decoder it needs and reports what the
// device refuses. A bridge is sized in three layers, each superseding the one below (ruled
// 2026-10-22): the BASELINE floor (profiles.js: an assumed phone), the MEASURED floor (optimize()
// runs the probe on this device; stored for the origin), and what playback OBSERVES at every hand-off
// — the decoder behind a bridge reports when its first frame is ready, so the slots it did not need
// are known, and a late decoder shows as stalls right after the hand-off. Late by k: the next bridge
// is n + k + 2. Ready with less than three quarters used: the next is what was used plus a tenth, at
// least two frames, never under MIN_BRIDGE_FRAMES. The result is a scale on the floor's answer
// (`tune.scale`, stored for the origin with the floor it was learned on); a loop's own wrap bridge is
// rebuilt to the exact new length in the background and swapped in at a wrap. Memory has two
// boundaries (budget.js), neither a cap: past 500 MB of frames the player warns, past 1 GB it says a
// crash is likely — on the console and as a 'memory' event.

import { FrameSource } from './frame-source.js';
import { AudioEngine } from './audio.js';
import { DecodePool, WorkerSource } from './worker-source.js';
import { BridgeSource, buildBridge, bridgeFrames, adjustBridge, MIN_BRIDGE_FRAMES } from './bridge.js';
import { HARDWARE_FLOOR } from './profiles.js';
import { probeDevice, floorFromProfile, storedProfile, storedTune, storeTune } from './probe.js';
import { MEMORY_WARNING, MEMORY_CRITICAL, memoryLevel } from './budget.js';

const START_DELAY_PLAY = 0.03;     // seconds; play() can afford a margin for decoder/audio setup
const START_DELAY_SWITCH = 0.005;  // a cut promises the next display frame
const MIN_LEAD = 0.002;            // re-anchor when setup ate the delay
const MAX_RECOVERIES = 2;
const MAX_START_WAIT_MS = 1500;   // play() waits this long for a cold decoder's first frame before starting anyway

export class Player extends EventTarget {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{audioContext?: AudioContext, lookahead?: number, avOffset?: number, worker?: boolean}} opts
   *   worker: decode in a module Worker (decode-worker.js) so a busy main thread never starves the decoder.
   */
  constructor(canvas, { audioContext, lookahead = 6, avOffset = 0, worker = false } = {}) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this._ownsContext = !audioContext;
    this.audioContext = audioContext ?? new (globalThis.AudioContext || globalThis.webkitAudioContext)({ latencyHint: 'interactive' });
    this.audio = new AudioEngine(this.audioContext);
    this.masterGain = this.audio.master;
    this.lookahead = lookahead;
    this.avOffset = avOffset;
    this.muted = false;          // set by the element: a muted clip with audio may run on the wall clock before a gesture
    this.worker = worker && typeof Worker !== 'undefined';   // decode in a Worker (frames transferred; the clock, audio and drawing stay here)
    this._pool = null;
    this.stats = { rendered: 0, dropped: 0, stalls: 0, index: -1, p: -1, decoders: 0, bridges: 0, memoryBytes: 0, memoryLevel: 'ok', clock: 'audio', recoveries: 0 };
    // what bridges are sized from: the profile this origin already measured and stored, else the baseline until optimize() measures
    const stored = storedProfile();
    this.floor = stored ? floorFromProfile(stored, HARDWARE_FLOOR) : HARDWARE_FLOOR;
    this.stats.floor = stored ? 'stored' : 'baseline';
    // what playback learned on top of that floor, on this origin
    const tune = storedTune(this._basis());
    this.tune = { scale: tune?.scale ?? 1, observations: tune?.observations ?? 0 };
    this.stats.bridgeScale = this.tune.scale; this.stats.tuned = this.tune.observations;
    this._memoryLevel = 'ok';

    this._segment = null;      // currently presenting
    this._next = null;         // scheduled to take over at _next.tStart
    this._prepared = [];       // Prepared handles (bridges)
    this._decoders = new Set();
    this._deferred = null;     // a cut waiting for its bridge to finish building
    this._raf = 0;
    this._offset = 0;          // player time − (context time − output latency); nonzero after a wall-clock period
    this._wall = null;         // { base, perf } while the clock runs on performance.now()
    this._blockedFor = null;
    this._pendingStart = null;
    this._destroyed = false;
    this._tick = this._tick.bind(this);
  }

  // ---- clock -------------------------------------------------------------------------------
  get outputLatency() { return this.audioContext.outputLatency || 0; }
  _audioNow() { return this.audioContext.currentTime - this.outputLatency + this._offset; }
  _wallNow() { return this._wall.base + (performance.now() - this._wall.perf) / 1000; }
  /** The raw player clock (seconds). */
  _clock() {
    const running = this.audioContext.state === 'running';
    if (this._wall) {
      if (!running) return this._wallNow();
      // hand over to the audio clock without a jump
      this._offset = this._wallNow() - (this.audioContext.currentTime - this.outputLatency);
      this._wall = null;
    } else if (!running && this._silentOnly()) {
      this._wall = { base: this._audioNow(), perf: performance.now() };
      return this._wall.base;
    }
    return this._audioNow();
  }
  _silentOnly() { return this.muted || ((!this._segment || !this._segment.clip.audio) && (!this._next || !this._next.clip.audio)); }
  /** Video clock: the raw clock plus avOffset. */
  get now() { return this._clock() + this.avOffset; }
  /** Context time at which audio must START to be heard at player time t. */
  _ctxTime(t) { return t - this._offset; }
  get playing() { return !!(this._segment || this._next || this._pendingStart || this._deferred); }
  get clip() { return this._segment?.clip ?? null; }
  get currentFrame() { return this.stats.index; }
  /** The bridges held right now. */
  get prepared() { return this._prepared.slice(); }

  /** How many frames a bridge into `clip` at `frame` holds here: the floor's answer, scaled by what playback has learned, never under MIN_BRIDGE_FRAMES. */
  bridgeFramesFor(clip, frame) {
    const n = Math.ceil(bridgeFrames(clip, frame, this.floor) * this.tune.scale);
    return Math.min(clip.frameCount - frame, Math.max(MIN_BRIDGE_FRAMES, n));
  }
  _basis() { return this.floor.measuredAt ?? 'baseline'; }
  _saveTune() { this.stats.bridgeScale = this.tune.scale; this.stats.tuned = this.tune.observations; storeTune(this.tune, this._basis()); }

  /**
   * A hand-off has told us something: the decoder behind the bridge was `late` slots (stalls right after
   * the hand-off) or had been ready after `used` of the bridge's `n` frames. Adjust the scale for every
   * bridge from now on, and rebuild a loop's own wrap bridge to the exact new length.
   */
  _observe(seg, n, { used, late }) {
    const next = adjustBridge(n, { used, late });
    this.dispatchEvent(Object.assign(new Event('handoff'), { clip: seg.clip, bridge: n, used, late, next }));
    if (next == null) return;
    this.tune.scale = Math.max(0.01, this.tune.scale * (next / n));
    this.tune.observations++;
    this._saveTune();
    this.dispatchEvent(Object.assign(new Event('tuned'), { clip: seg.clip, bridge: n, used, late, next, scale: this.tune.scale }));
    if (seg.loop && seg.loopBridge && !seg.allBridge && seg.loopBridge.count !== Math.min(next, seg.length)) this._rebuildLoopBridge(seg, Math.min(next, seg.length));
  }
  /** Rebuild a loop's wrap bridge at another length in the background; it takes over at the first wrap after the decoder resumes past it. */
  _rebuildLoopBridge(seg, count) {
    if (seg.rebuilding) return;
    seg.rebuilding = true;
    const link = seg.link;
    buildBridge(seg.clip, seg.from, { count }).then((bridge) => {
      seg.rebuilding = false;
      const live = [this._segment, this._next].find((x) => x && x.link === link);
      if (!live || link.dead) { bridge.close(); return; }
      if (seg.pendingBridge) seg.pendingBridge.bridge.close();
      const dec = seg.swap === 'bridge' ? seg.standby : seg.source;
      let pass = Math.floor(Math.max(seg.lastP, 0) / seg.length) + 1;
      if (dec && typeof dec.setLoopResume === 'function' && bridge.count < seg.length) {
        try { const r = dec.setLoopResume(seg.from + bridge.count); if (r && typeof r.then === 'function') { seg.pendingBridge = { bridge, pass: Infinity }; r.then((pp) => { if (seg.pendingBridge?.bridge === bridge) seg.pendingBridge.pass = (dec.passOffset ?? 0) + pp; }, () => {}); return; } pass = (dec.passOffset ?? 0) + r; }
        catch { /* the current resume stands; the new bridge is used from the next wrap with duplicates dropped at the hand-off */ }
      }
      seg.pendingBridge = { bridge, pass };
    }, () => { seg.rebuilding = false; });
  }

  /**
   * Size bridges from this device. The profile this origin already measured (stored for every page of
   * the site, kept until the browser changes) is used as it is; otherwise — or with `force` — the probe
   * runs on `clip` (decode rate, a fresh decoder's start-up, a re-targeted decoder, the decoder count)
   * and stores the result. The floor becomes the measured figures with the baseline's margin. Resolves
   * to the profile. Without a call, the stored profile applies when there is one, else the baseline
   * floor ships. A measurement needs nothing playing (the probe must not share the decoder).
   */
  async optimize(clip, { force = false, ...opts } = {}) {
    let profile = force ? null : storedProfile();
    let source = 'stored';
    if (!profile) {
      if (!clip) throw new TypeError('optimize: a clip to measure with');
      if (this.playing) throw new DOMException('optimize(): stop playback first — the probe must not share the decoder with a playing clip', 'InvalidStateError');
      profile = await probeDevice(clip, opts);
      profile.outputLatencyMs = Math.round(this.outputLatency * 1000);
      source = 'measured';
    }
    this.floor = floorFromProfile(profile, HARDWARE_FLOOR);
    this.stats.floor = source;
    const tune = source === 'measured' ? null : storedTune(this._basis());   // a new measurement supersedes what playback learned on the old floor
    this.tune = { scale: tune?.scale ?? 1, observations: tune?.observations ?? 0 };
    if (source === 'measured') this._saveTune(); else { this.stats.bridgeScale = this.tune.scale; this.stats.tuned = this.tune.observations; }
    this.dispatchEvent(Object.assign(new Event('optimized'), { profile, floor: this.floor, source }));
    return profile;
  }

  /**
   * The frames this page holds — prepared bridges, loop bridges, and each decoder's lookahead — against
   * the two boundaries. Neither is a cap; crossing one is said once, on the console and as a 'memory' event.
   */
  _account() {
    let bytes = 0;
    for (const h of this._prepared) if (h.ready) bytes += h.bytes;
    for (const seg of [this._segment, this._next]) {
      if (!seg) continue;
      if (seg.loopBridge) bytes += seg.loopBridge.bytes;
      if (seg.loopBridgeSeed) bytes += seg.loopBridgeSeed.bytes;
      if (seg.pendingBridge) bytes += seg.pendingBridge.bridge.bytes;
      if (seg.source?.isBridge && !seg.source.keep) bytes += seg.source.bridge.bytes;
    }
    for (const src of this._decoders) bytes += (this.lookahead + src.clip.reorderDepth) * Math.round(src.clip.width * src.clip.height * 1.5);
    this.stats.memoryBytes = bytes;
    const level = memoryLevel(bytes);
    if (level === this._memoryLevel) return;
    const previous = this._memoryLevel;
    this._memoryLevel = this.stats.memoryLevel = level;
    const mb = Math.round(bytes / 1048576);
    if (level === 'critical') console.error(`[video-hfp] CRITICAL: holding ${mb} MB of frames, past the ${MEMORY_CRITICAL >> 20} MB boundary — expect the page to be killed on a phone`);
    else if (level === 'warning' && previous === 'ok') console.warn(`[video-hfp] WARNING: holding ${mb} MB of frames, past the ${MEMORY_WARNING >> 20} MB boundary — a page this size can be killed on a phone`);
    this.dispatchEvent(Object.assign(new Event('memory'), { bytes, level, previous }));
  }

  /** Resume the AudioContext; call from a user gesture before the first play() on iOS/Safari. */
  async resume() { if (this.audioContext.state !== 'running') { try { await this.audioContext.resume(); } catch { /* needs a gesture */ } } }

  // ---- public ------------------------------------------------------------------------------
  /**
   * Start playing `clip` now, replacing whatever is playing. The clock is anchored once the first
   * frames are decoded (a cold decoder's start-up is waited out, never dropped through).
   */
  play(clip, opts = {}) { this.resume(); this._cancelDeferred(); this._schedule(clip, opts, null, START_DELAY_PLAY, null); }

  /**
   * Prepare a target: build a bridge of `clip`'s frames from `frame` on (bridgeFrames of them, or
   * `bridge`), fetch the bytes of the hand-off run and warm the first audio window. Resolves to a
   * Prepared handle { clip, frame, bridgeFrames, bytes, ready, release() }; the same clip and frame
   * twice is the same handle. An array of { clip, frame } resolves to an array. No decoder is held,
   * and there is no cap: memory is the caller's, and plan() says how much.
   */
  async prepare(target, frame, { bridge, floor = this.floor } = {}) {
    if (Array.isArray(target)) return Promise.all(target.map((t) => this.prepare(t.clip, t.frame, { bridge: t.bridge ?? bridge, floor })));
    const clip = target;
    if (!clip || !Number.isInteger(frame) || frame < 0 || frame >= clip.frameCount) throw new RangeError(`prepare: frame ${frame} is outside ${clip?.name ?? 'the clip'} [0, ${clip?.frameCount})`);
    const have = this._prepared.find((h) => h.clip === clip && h.frame === frame);
    if (have) return have.promise;
    const h = { kind: 'Prepared', clip, frame, bridgeFrames: bridge ?? (floor === this.floor ? this.bridgeFramesFor(clip, frame) : bridgeFrames(clip, frame, floor)), bytes: 0, ready: false, consumed: false, error: null, _bridge: null, release: () => this.release(h) };
    this._prepared.push(h);
    h.promise = this._build(h).then(() => h, (e) => { h.error = e; this._forget(h); throw e; });
    return h.promise;
  }
  async _build(h) {
    const { clip, frame } = h;
    // the hand-off decode run (keyframe before the hand-off frame … a lookahead past it), resident before the cut
    const handoff = Math.min(frame + h.bridgeFrames, clip.frameCount - 1);
    const d0 = clip.decodeIndexOf(clip.keyframeAtOrBefore(handoff));
    const d1 = clip.lastDecodeIndexBefore(Math.min(clip.frameCount, handoff + this.lookahead + 1));
    const bytes = clip.ensureDecodeRange(Math.min(d0, d1), Math.max(d0, d1)).catch(() => {});
    if (clip.audio) { const ca = this.audio.clipAudio(clip); ca.window(Math.floor((clip.frameTime(frame) + clip.audioOffset) / ca.windowSeconds)).catch(() => {}); }
    const bridge = await buildBridge(clip, frame, { count: h.bridgeFrames });
    await bytes;
    if (!this._prepared.includes(h)) { bridge.close(); throw new Error(`prepare(${clip.name}, ${frame}): released while building`); }
    h._bridge = bridge; h.bytes = bridge.bytes; h.ready = true;
    this.stats.bridges = this._prepared.filter((x) => x.ready).length;
    this._account();
  }
  /** Drop a prepared target and its memory. */
  release(h) { if (this._forget(h)) { h._bridge?.close(); h._bridge = null; } }
  releaseAll() { for (const h of this._prepared.slice()) this.release(h); }
  _forget(h) { const i = this._prepared.indexOf(h); if (i < 0) return false; this._prepared.splice(i, 1); this.stats.bridges = this._prepared.filter((x) => x.ready).length; this._account(); return true; }
  _handleFor(target, frame) {
    if (target && target.kind === 'Prepared') return this._prepared.includes(target) ? target : null;
    return this._prepared.find((h) => h.clip === target && h.frame === frame) ?? null;
  }
  static _unpack(target, frame) { return target && target.kind === 'Prepared' ? { clip: target.clip, frame: target.frame } : { clip: target, frame }; }

  /**
   * Show `target`'s `frame` now: on the next display frame when it was prepared (the bridge plays
   * while the decoder re-targets behind it), else as soon as the device decodes it. `target` is a
   * Clip or a Prepared handle (then `frame` is the handle's). A bridge still being built is waited
   * for; the cut lands the moment it is ready.
   * @param {{from?: number, to?: number, loop?: boolean, bridge?: boolean}} opts  the range to play from there: [from, to), default [frame, end); bridge: force or forbid a loop's wrap bridge
   */
  cut(target, frame, opts = {}) {
    this.resume();
    const { clip, frame: f } = Player._unpack(target, frame);
    if (!clip) throw new TypeError('cut: no target');
    const h = this._handleFor(clip, f);
    this._cancelDeferred();
    if (h && !h.ready) {
      const d = this._deferred = { cancelled: false };
      const go = (handle) => { if (d.cancelled) return; this._deferred = null; this._cutNow(clip, f, opts, handle); };
      h.promise.then(() => go(h), () => go(null));
      return;
    }
    this._cutNow(clip, f, opts, h);
  }
  _cutNow(clip, f, { from = f, to = clip.frameCount, loop = false, bridge } = {}, h) { this._schedule(clip, { from, to, loop, startIndex: f, bridge }, null, START_DELAY_SWITCH, h); }

  /**
   * After the current segment presents frame `at`, present `target`'s `frame` in the very next slot
   * (on a looping segment: the next time `at` comes around). Bridged when the target was prepared
   * and is ready; otherwise the decoder starts now and parks on `frame`. Returns the player time of
   * the boundary.
   */
  cutAfter(at, target, frame, opts = {}) {
    const { clip, frame: f } = Player._unpack(target, frame);
    if (!clip) throw new TypeError('cutAfter: no target');
    const h0 = this._handleFor(clip, f);
    const h = h0?.ready ? h0 : null;
    const range = { from: opts.from ?? f, to: opts.to ?? clip.frameCount, loop: !!opts.loop, startIndex: f, bridge: opts.bridge };
    const seg = this._next ?? this._segment;
    if (!seg) { this.resume(); this._cancelDeferred(); this._schedule(clip, range, null, START_DELAY_PLAY, h); return this._clock() + START_DELAY_PLAY; }
    this._cancelDeferred();
    if (this._pendingStart) { this._pendingStart.cancelled = true; this._pendingStart = null; }
    if (!(at >= seg.from && at < seg.to)) throw new RangeError(`cutAfter: frame ${at} is outside the playing range [${seg.from}, ${seg.to})`);
    const c = seg.clip;
    let tB = seg.t0 + (c.frameEnd(at) - c.frameTime(seg.from));
    const earliest = this._clock() + START_DELAY_SWITCH;
    if (seg.loop) { if (tB < earliest) tB += Math.ceil((earliest - tB) / seg.period) * seg.period; }
    else if (tB < earliest) tB = earliest;                     // `at` already went by: cut now
    this._schedule(clip, range, tB, START_DELAY_SWITCH, h);
    return tB;
  }

  /** Cancel a cut that has not happened yet (deferred, pending, or scheduled at a boundary ahead). The current segment plays on. */
  cancelCut() {
    this._cancelDeferred();
    if (this._pendingStart) { this._pendingStart.cancelled = true; this._pendingStart = null; }
    if (!this._next) return;
    const t = this._clock();
    this._dispose(this._next, t);
    this._next = null;
    const seg = this._segment;
    if (seg?.audio && seg.audioStopped) {
      // the current segment's audio was told to stop at the boundary: pick it up again from there
      const at = seg.audioStopAt;
      const where = this._pAt(seg, Math.max(at, t));
      seg.audio = this.audio.createSegment({ clip: seg.clip, from: seg.from, to: seg.to, loop: seg.loop, startIndex: this._indexForP(seg, where ? where.p : 0), tStart: Math.max(at, t), ctxTime: (x) => this._ctxTime(x) });
      seg.audioStopped = false;
      seg.audio.ensure(Math.max(at, t) + this.audio.aheadSeconds).catch((e) => this._emitError(e, seg.clip, true));
    }
  }
  _cancelDeferred() { if (this._deferred) { this._deferred.cancelled = true; this._deferred = null; } }

  /** Stop playback (audio and video), keep the last frame on screen. Prepared targets stay prepared. */
  stop() {
    this._cancelDeferred();
    if (this._pendingStart) { this._pendingStart.cancelled = true; this._pendingStart = null; }
    const t = this._clock();
    if (this._next) this._dispose(this._next, t);
    if (this._segment) this._dispose(this._segment, t);
    this._next = this._segment = null;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.stop();
    this.releaseAll();
    this.audio.dispose();
    if (this._pool) { this._pool.terminate(); this._pool = null; }
    if (this._ownsContext) this.audioContext.close().catch(() => {});
  }

  /** Draw one frame onto the canvas, turned by the clip's rotation (the element uses it for posters and paused seeks). */
  draw(frame, rotation = 0) {
    const w = frame.displayWidth, h = frame.displayHeight;
    const cw = rotation % 180 ? h : w, ch = rotation % 180 ? w : h;   // the canvas is the upright size
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    if (!rotation) { this.ctx.drawImage(frame, 0, 0, w, h); return; }
    const ctx = this.ctx;
    ctx.save(); ctx.translate(cw / 2, ch / 2); ctx.rotate(rotation * Math.PI / 180); ctx.drawImage(frame, -w / 2, -h / 2, w, h); ctx.restore();
  }

  // ---- internals -------------------------------------------------------------------------

  _newSource(clip) {
    const s = this.worker ? new WorkerSource(clip, { lookahead: this.lookahead, pool: (this._pool ??= new DecodePool()) }) : new FrameSource(clip, { lookahead: this.lookahead });
    s.onerror = (e) => this._onSourceError(s, e);
    this._decoders.add(s);
    this.stats.decoders = this._decoders.size;
    this._account();
    return s;
  }
  _closeSource(s) { if (!s) return; s.close(); this._decoders.delete(s); this.stats.decoders = this._decoders.size; this._account(); }

  /**
   * Does a loop of this clip get a wrap bridge? A structural rule, no device assumption: when the lead-in
   * from the keyframe before `from` is longer than the lookahead, one decoder cannot re-decode it inside
   * the lookahead on every wrap, so the loop's first frames are parked once and shown at each wrap while
   * the decoder works behind them. An app that knows its device (plan.js) can force either way with
   * `bridge: true|false`.
   */
  _needsWrapBridge(clip, from, override) {
    if (override != null) return !!override;
    return from - clip.keyframeAtOrBefore(from) > this.lookahead;
  }

  /**
   * Queue a segment that takes over at player time `tStart`, showing frame `startIndex` in that slot.
   * seg.t0 is the player time of p = 0 (frame `from`), so the frame at time t follows from the clip's frame times.
   * With a Prepared handle `h`, the segment starts on the bridge and the decoder takes over at the bridge's end.
   */
  _schedule(clip, { from = 0, to = clip.frameCount, loop = false, startIndex = from, bridge: bridgeOverride }, tStart, minDelay, h) {
    if (!(from >= 0 && to <= clip.frameCount && from < to)) throw new RangeError(`bad range [${from}, ${to})`);
    if (!(startIndex >= from && startIndex < to)) throw new RangeError(`startIndex ${startIndex} outside [${from}, ${to})`);
    const len = to - from, pStart = startIndex - from;
    const wantBridge = loop && this._needsWrapBridge(clip, from, bridgeOverride);
    const indexForP = (p) => (loop ? from + ((p % len) + len) % len : Math.min(from + Math.max(0, p), to - 1));
    if (this._pendingStart) { this._pendingStart.cancelled = true; this._pendingStart = null; }
    let source, standby = null, swap = null, nextPassP = 0, retarget = false, loopBridgeSeed = null;
    if (h) {
      // the bridge plays first; the decoder that is playing re-targets at the takeover (_tick), or a fresh one starts now when nothing plays.
      // A cut to a loop's own start keeps the bridge: it is the wrap bridge from then on.
      this._forget(h); h.consumed = true;
      const keep = loop && h.frame === from;
      source = new BridgeSource(h._bridge, { keep });
      if (keep) loopBridgeSeed = h._bridge;
      h._bridge = null;
      source.start({ pStart, indexForP });
      swap = 'bridge'; nextPassP = pStart + source.bridge.count;
      if (this._segment || this._next) retarget = true;
      else {
        try { standby = this._newSource(clip); this._startDecoder(standby, { from, to, loop, startIndex: indexForP(nextPassP), pStart: nextPassP }, len); }
        catch (e) { this._closeSource(standby); standby = null; this._emitError(e, clip, false); }
      }
    } else {
      source = this._newSource(clip);
      this._startDecoder(source, { from, to, loop, startIndex, pStart }, len);
    }
    clip.pinRange(loop ? from : null, to);
    let audioReady = () => true;
    if (clip.audio) {   // warm the first audio window; a "now" start waits for it too, so the first piece is never late
      const ca = this.audio.clipAudio(clip), wi = Math.floor((clip.frameTime(startIndex) + clip.audioOffset) / ca.windowSeconds);
      ca.window(wi).catch(() => {});
      audioReady = () => ca.windowReady(wi) !== null || ca.mode === 'whole';
    }
    const link = {};
    const seg = { from, to, loop, startIndex, len, source, standby, swap, nextPassP, nextWrapP: (Math.floor(pStart / len) + 1) * len, retarget, indexForP, link, wantBridge, loopBridge: null, loopBridgeSeed, bridgePass: Infinity, allBridge: false, pendingBridge: null, rebuilding: false,
      watch: h && retarget ? { startP: pStart, n: source.bridge.count, readyP: null } : null, after: null };   // watch: a re-targeted decoder behind this bridge is observed; one started while nothing played is not representative
    if (wantBridge && !loopBridgeSeed) this._buildLoopBridge(clip, from, len, link);

    // "now" starts: anchor the clock once the decoder is streaming (a few frames queued, the first audio window
    // decoded) — a cold hardware decoder's start-up is waited out, never dropped through. A bridge or a cut needs one frame.
    const need = h || minDelay === START_DELAY_SWITCH ? 1 : Math.min(3, this.lookahead);
    if (tStart == null && (source.queued < need || !audioReady())) {
      const pending = { cancelled: false };
      this._pendingStart = pending;
      const t0 = performance.now();
      const poll = () => {
        if (pending.cancelled) { if (this._pendingStart === pending) this._pendingStart = null; this._closeSource(source); this._closeSource(standby); link.dead = true; loopBridgeSeed?.close(); return; }
        if (source.error) { this._pendingStart = null; this._closeSource(standby); link.dead = true; loopBridgeSeed?.close(); return; }   // reported by _onSourceError
        if ((source.queued >= need && audioReady()) || performance.now() - t0 > MAX_START_WAIT_MS) { this._pendingStart = null; this._anchor(clip, seg, this._clock() + minDelay, minDelay); return; }
        setTimeout(poll, 4);
      };
      poll();
      return;
    }
    this._anchor(clip, seg, tStart == null ? this._clock() + minDelay : tStart, minDelay);
  }

  /** Start (or restart) a decoder source for a range, remembering which pass of the segment its own pass 0 is. */
  _startDecoder(src, opts, len) { src.start(opts); src.passOffset = Math.floor((opts.pStart ?? (opts.startIndex - opts.from)) / len); }

  /** Build a loop's wrap bridge in the background and attach it to the segment it was built for (found by `link`). */
  _buildLoopBridge(clip, from, len, link) {
    const count = Math.min(this.bridgeFramesFor(clip, from), len);
    buildBridge(clip, from, { count }).then((bridge) => {
      const seg = [this._segment, this._next].find((x) => x && x.link === link);
      if (!seg || link.dead || seg.loopBridge) { bridge.close(); return; }
      this._attachLoopBridge(seg, bridge);
    }, (e) => { const seg = [this._segment, this._next].find((x) => x && x.link === link); if (seg && !link.dead) this._emitError(e, clip, true); });   // the loop runs on its decoder alone; said
  }
  /**
   * From the next wrap on, the loop's first frames come from the bridge; the decoder, told to resume output
   * past them, decodes the lead-in behind it. A bridge as long as the loop carries the whole loop by itself.
   */
  _attachLoopBridge(seg, bridge) {
    seg.loopBridge = bridge;
    this._account();
    if (bridge.count >= seg.length) { seg.allBridge = true; return; }
    const dec = seg.swap === 'bridge' ? seg.standby : seg.source;
    // the bridge is used from the pass the decoder first skips its frames in — the decoder says which (a worker answers later)
    seg.bridgePass = Infinity;
    const apply = (pass) => { if (seg.loopBridge === bridge) seg.bridgePass = (dec.passOffset ?? 0) + pass; };
    if (dec && typeof dec.setLoopResume === 'function') {
      try { const r = dec.setLoopResume(seg.from + bridge.count); if (r && typeof r.then === 'function') r.then(apply, () => {}); else apply(r); }
      catch (e) { this._emitError(e, seg.clip, true); }
    }
  }

  _anchor(clip, s, tStart, minDelay) {
    // timing is fixed only now, after the setup work: if it ate the delay, move the start, never the offset
    const earliest = this._clock() + MIN_LEAD;
    if (tStart < earliest) tStart = this._clock() + minDelay;
    const period = clip.rangeEnd(s.to) - clip.frameTime(s.from);
    const t0 = tStart - (clip.frameTime(s.startIndex) - clip.frameTime(s.from));
    const seg = { clip, ...s, length: s.len, tStart, t0, period, lastP: s.startIndex - s.from - 1, lastIndex: -1, pass: 0, stallP: -1, endedFired: false, audio: null, audioStopped: false, audioStopAt: 0, recoveries: 0 };
    if (clip.audio) {
      seg.audio = this.audio.createSegment({ clip, from: s.from, to: s.to, loop: s.loop, startIndex: s.startIndex, tStart, ctxTime: (t) => this._ctxTime(t) });
      seg.audio.ensure(tStart + this.audio.aheadSeconds).catch((e) => this._emitError(e, clip, true));
      if (this.audioContext.state !== 'running' && !this.muted && this._blockedFor !== clip) { this._blockedFor = clip; this.dispatchEvent(Object.assign(new Event('blocked'), { clip })); }
    }
    if (this._next) this._dispose(this._next, tStart);    // replaced before it ever started
    if (this._segment) this._stopAudioAt(this._segment, tStart);
    this._next = seg;
    if (!this._raf) this._raf = requestAnimationFrame(this._tick);
  }

  _stopAudioAt(seg, t) { if (!seg.audio || seg.audioStopped) return; seg.audioStopped = true; seg.audioStopAt = t; seg.audio.stopAt(t); }
  _dispose(seg, t) { this._stopAudioAt(seg, t); this._closeSource(seg.source); this._closeSource(seg.standby); seg.loopBridge?.close(); seg.loopBridge = null; seg.loopBridgeSeed?.close(); seg.loopBridgeSeed = null; seg.pendingBridge?.bridge.close(); seg.pendingBridge = null; seg.link.dead = true; seg.clip.pinRange(null); this._account(); }

  /** Presentation index for presentation number p of a segment. */
  _indexForP(seg, p) { return seg.loop ? seg.from + ((p % seg.length) + seg.length) % seg.length : Math.min(seg.from + Math.max(0, p), seg.to - 1); }
  /** The presentation number due at player time `now`, or null before the segment starts; `over` past a non-looping end. */
  _pAt(seg, now) {
    const elapsed = now - seg.t0;
    if (elapsed < 0) return null;
    const c = seg.clip;
    let k = 0, o = elapsed;
    if (seg.loop) { k = Math.floor(elapsed / seg.period); o = elapsed - k * seg.period; }
    if (!seg.loop && o >= seg.period) return { p: seg.length - 1, pass: 0, over: true };
    return { p: k * seg.length + (c.frameAt(c.frameTime(seg.from) + o, seg.from, seg.to) - seg.from), pass: k, over: false };
  }

  _onSourceError(source, e) {
    for (const seg of [this._segment, this._next]) {
      if (!seg) continue;
      if (seg.source !== source && seg.standby !== source) continue;
      if (seg.recoveries >= MAX_RECOVERIES) { this._emitError(e, seg.clip, false); this._endSegment(seg); return; }
      seg.recoveries++; this.stats.recoveries++;
      const fresh = this._newSource(seg.clip);
      const skipping = seg.loopBridge && !seg.allBridge;
      const resume = skipping ? seg.from + seg.loopBridge.count : seg.from;
      if (seg.standby === source) {
        // the decoder behind a bridge died: a fresh one starts where it was to take over
        this._closeSource(source); seg.standby = fresh;
        this._startDecoder(fresh, { from: seg.from, to: seg.to, loop: seg.loop, startIndex: this._indexForP(seg, seg.nextPassP), pStart: seg.nextPassP, loopResume: resume }, seg.length);
      } else {
        const p = Math.max(seg.lastP + 1, seg.source.nextP);
        this._closeSource(source); seg.source = fresh;
        this._startDecoder(fresh, { from: seg.from, to: seg.to, loop: seg.loop, startIndex: this._indexForP(seg, p), pStart: p, loopResume: resume }, seg.length);
      }
      if (skipping) seg.bridgePass = fresh.passOffset + 1;   // a resume point given at start applies from the fresh decoder's first wrap
      this._emitError(e, seg.clip, true);
      return;
    }
    // a source still waiting to start (play() polling for its first frame): report it; the poll sees source.error and gives up
    this._emitError(e, source.clip, false);
    this._closeSource(source);
  }
  _emitError(e, clip, recovered) { this.dispatchEvent(Object.assign(new Event('error'), { error: e, clip, recovered })); }
  _endSegment(seg) {
    const t = this._clock();
    if (seg === this._next) { this._dispose(seg, t); this._next = null; }
    else if (seg === this._segment) { this._dispose(seg, t); this._segment = null; if (!seg.endedFired) { seg.endedFired = true; this.dispatchEvent(Object.assign(new Event('ended'), { clip: seg.clip, reason: 'decoder' })); } }
  }

  /** The bridge's last frame is due: the decoder behind it takes over. A cut to a loop's start keeps its bridge as the wrap bridge. */
  _handoff(seg, p) {
    const bs = seg.source;
    seg.source = seg.standby; seg.standby = null; seg.swap = null;
    this._closeSource(bs);   // a kept bridge survives its source
    if (!seg.source) { this._emitError(new Error('the bridge ended with no decoder to take over'), seg.clip, false); this._endSegment(seg); return; }
    seg.nextWrapP = (Math.floor(p / seg.length) + 1) * seg.length;
    if (seg.watch) { seg.after = { p: seg.nextPassP, n: seg.watch.n, used: seg.watch.readyP == null ? null : seg.watch.readyP - seg.watch.startP + 1, stalls: 0 }; seg.watch = null; }
    if (seg.loopBridgeSeed) { const b = seg.loopBridgeSeed; seg.loopBridgeSeed = null; this._attachLoopBridge(seg, b); }
  }
  /** A wrap with a bridge attached: the bridge shows the loop's first frames while the decoder decodes the lead-in behind it. */
  _wrapOntoBridge(seg, k) {
    if (seg.pendingBridge && k >= seg.pendingBridge.pass) {   // the rebuilt bridge takes over now, between two of its sources
      seg.loopBridge.close(); seg.loopBridge = seg.pendingBridge.bridge; seg.pendingBridge = null;
      if (seg.loopBridge.count >= seg.length) seg.allBridge = true;
      this._account();
    }
    const bs = new BridgeSource(seg.loopBridge, { keep: true });
    bs.start({ pStart: k * seg.length, indexForP: seg.indexForP });
    if (seg.allBridge) { this._closeSource(seg.source); seg.source = bs; seg.standby = null; seg.swap = null; seg.nextWrapP = Infinity; return; }   // the loop lives on the bridge: no decoder at all
    seg.standby = seg.source; seg.source = bs; seg.swap = 'bridge'; seg.nextPassP = k * seg.length + seg.loopBridge.count;
    seg.watch = { startP: k * seg.length, n: seg.loopBridge.count, readyP: null };
  }

  _tick() {
    this._raf = 0;
    const now = this.now;
    this.stats.clock = this._wall ? 'wall' : 'audio';

    if (this._next && now >= this._next.tStart) {
      const old = this._segment;
      const s = this._segment = this._next;
      this._next = null;
      if (old) {
        if (s.retarget) {
          // the decoder that played the old clip is re-targeted to the new one behind the bridge; a worker source, or a dead one, is replaced
          s.retarget = false;
          const reuse = old.source instanceof FrameSource && !old.source.error;
          let dec = null;
          try {
            if (reuse) { dec = old.source; dec.retarget(s.clip); }
            else { this._closeSource(old.source); dec = this._newSource(s.clip); }
            this._startDecoder(dec, { from: s.from, to: s.to, loop: s.loop, startIndex: s.indexForP(s.nextPassP), pStart: s.nextPassP }, s.length);
            s.standby = dec;
            if (s.watch) s.watch.startP = s.lastP + 1;   // the clock on the bridge starts now
          } catch (e) { this._closeSource(dec); if (reuse) this._decoders.delete(old.source); s.standby = null; this._emitError(e, s.clip, false); }
        } else this._closeSource(old.source);
        this._closeSource(old.standby);
        old.loopBridge?.close(); old.loopBridge = null; old.loopBridgeSeed?.close(); old.loopBridgeSeed = null; old.pendingBridge?.bridge.close(); old.pendingBridge = null; old.link.dead = true;
        if (old.clip !== s.clip) old.clip.pinRange(null);   // audio already told to stop at tStart
        this._account();
      }
      this.dispatchEvent(Object.assign(new Event('segmentstart'), { clip: s.clip, from: s.from, to: s.to, loop: s.loop, tStart: s.tStart }));
      this.dispatchEvent(Object.assign(new Event('switch'), { fromClip: old?.clip ?? null, fromFrame: old ? old.lastIndex : -1, toClip: s.clip, toFrame: s.startIndex }));
    }

    const seg = this._segment;
    if (!seg) { if (this._next) this._raf = requestAnimationFrame(this._tick); return; }
    const c = seg.clip;
    const at = this._pAt(seg, now);
    if (at) {
      const { p } = at;
      if (at.over && !seg.endedFired) { seg.endedFired = true; this.dispatchEvent(Object.assign(new Event('ended'), { clip: c })); }
      if (at.pass > seg.pass) { seg.pass = at.pass; this.dispatchEvent(Object.assign(new Event('loop'), { clip: c, pass: at.pass })); }

      // the swaps: on a bridge, the decoder behind it takes over at the bridge's end; on the decoder, a loop's wrap goes onto the bridge
      if (seg.swap === 'bridge') {
        if (seg.watch && seg.watch.readyP == null && seg.standby && seg.standby.queued > 0) seg.watch.readyP = p;   // the decoder is ready: this many bridge frames were needed
        if (p >= seg.nextPassP) { this._handoff(seg, p); if (this._segment !== seg) { this._raf = requestAnimationFrame(this._tick); return; } }
      } else if (seg.loop && p >= seg.nextWrapP) {
        const k = Math.floor(p / seg.length);
        seg.nextWrapP = (k + 1) * seg.length;
        if (seg.loopBridge && (seg.allBridge || k >= seg.bridgePass)) this._wrapOntoBridge(seg, k);
      }
      const src = seg.source;
      if (p !== seg.lastP) {
        // Fell far behind (tab hidden, decoder hiccup): skip ahead instead of decoding every frame.
        if (p - src.nextP > c.gop && !src.ended && !seg.swap && !src.isBridge) src.reseek(this._indexForP(seg, p), p);
        this.stats.dropped += src.dropBefore(p);
        const item = src.peek();
        if (item && item.p === p) {
          src.shift();
          this.draw(item.frame, c.rotation);
          item.frame.close();
          seg.lastP = p; seg.lastIndex = item.index;
          this.stats.rendered++;
          this.stats.index = item.index;
          this.stats.p = p;
          this.dispatchEvent(Object.assign(new Event('frame'), { clip: c, index: item.index, p }));
          if (seg.after) { const a = seg.after; seg.after = null; this._observe(seg, a.n, { used: a.used, late: a.stalls }); }   // the first frame after a hand-off closes the book on it
        } else if (seg.stallP !== p) {
          seg.stallP = p;
          this.stats.stalls++;
          if (seg.after && p < seg.after.p + seg.after.n) seg.after.stalls++;   // late slots right after a hand-off: the bridge was short by this much
          this.dispatchEvent(Object.assign(new Event('stall'), { clip: c, p }));
        }
      }
    }
    if (seg.audio && !seg.audioStopped) seg.audio.ensure(now + this.audio.aheadSeconds).catch((e) => this._emitError(e, c, true));
    if (this._next?.audio && !this._next.audioStopped) this._next.audio.ensure(now + this.audio.aheadSeconds).catch((e) => this._emitError(e, this._next.clip, true));
    this._raf = requestAnimationFrame(this._tick);
  }
}
