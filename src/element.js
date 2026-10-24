// <video-hfp> — high frame precision video for the web. Shaped like <video>: its attributes, properties
// and events to the extent they mean something here, and what cannot be supported THROWS instead of
// failing quietly. Beside it, the frame-exact verbs, in FRAMES: open(), seek(), loop(), play({ from, to,
// loop }), prepare(), cut(), cutAfter(). Seconds only on the compatible surface (currentTime, duration).
// One element = one output: a canvas in its shadow root. Many clips, one timeline. The Player
// (player.js) is the engine behind it — `v.engine` reaches it; the probe and the plan stay module
// functions (the element plays, the tools advise).
//
//   <video-hfp src="a.mp4" autoplay loop loop-start="30" loop-end="90"></video-hfp>
//   <video-hfp src="a.mp4"><hfp-clip name="b" src="b.mp4" prepare-at="438"></hfp-clip></video-hfp>
//
//   const b = await v.open('b.mp4');           // a Clip, opened once per URL; File/Blob accepted
//   await v.prepare(b, 438);                   // a bridge; no decoder held
//   v.cut(b, 438);                             // the next display frame
//   v.cutAfter(1527, 'b', 438);                // after the current clip shows 1527; a declared clip by name
//
// Importing this module defines the elements. `video-hfp` (index.js) is the side-effect-free core.
import { Player } from './player.js';
import { loadClip } from './clip.js';
import { buildBridge } from './bridge.js';
import { storedProfile } from './probe.js';

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z"/></svg>',
  muted: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9zm13 1.5-1.5-1.5-2 2-2-2L9 10.5l2 2-2 2L10.5 16l2-2 2 2L16 14.5l-2-2z"/></svg>',
  fullscreen: '<svg viewBox="0 0 24 24"><path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z"/></svg>',
  exitFullscreen: '<svg viewBox="0 0 24 24"><path d="M8 4h2v6H4V8h4zm6 0h2v4h4v2h-6zM4 14h6v6H8v-4H4zm10 0h6v2h-4v4h-2z"/></svg>',
};
const TEMPLATE = `<style>
:host{display:inline-block;position:relative;overflow:hidden;background:#000;width:var(--video-hfp-width,300px);height:var(--video-hfp-height,auto);aspect-ratio:var(--video-hfp-aspect,2/1);outline:none}
:host([hidden]){display:none}
canvas{display:block;width:100%;height:100%;object-fit:inherit}
.hfp-controls{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:2px;padding:6px 8px;box-sizing:border-box;background:linear-gradient(to top,rgba(0,0,0,.75),rgba(0,0,0,0));color:#fff;font:13px/1 system-ui,sans-serif;transition:opacity .25s;user-select:none;-webkit-user-select:none}
.hfp-controls[hidden]{display:none}
.hfp-controls.hfp-away{opacity:0;pointer-events:none}
.hfp-controls button{appearance:none;border:0;background:transparent;color:inherit;min-width:44px;min-height:44px;padding:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border-radius:8px;flex:none}
.hfp-controls button:hover,.hfp-controls button:focus-visible{background:rgba(255,255,255,.15);outline:none}
.hfp-controls svg{width:22px;height:22px;fill:currentColor}
.hfp-time{flex:none;padding:0 6px;font-variant-numeric:tabular-nums;white-space:nowrap}
.hfp-scrub{flex:1;min-width:40px;height:44px;margin:0;accent-color:var(--mt-accent,#4ea1ff);cursor:pointer}
.hfp-controls[data-nofullscreen] .hfp-fs{display:none}
@media (max-width:420px){.hfp-step{display:none}}
</style><canvas width="300" height="150"></canvas>
<div class="hfp-controls" part="controls" hidden>
  <button class="hfp-play" aria-label="Play">${ICON.play}</button>
  <button class="hfp-step hfp-prev" aria-label="Previous frame">${ICON.prev}</button>
  <button class="hfp-step hfp-next" aria-label="Next frame">${ICON.next}</button>
  <span class="hfp-time"><span class="hfp-cur">0:00</span> / <span class="hfp-dur">0:00</span></span>
  <input class="hfp-scrub" type="range" min="0" max="0" step="1" value="0" aria-label="Seek">
  <button class="hfp-mute" aria-label="Mute">${ICON.sound}</button>
  <button class="hfp-fs" aria-label="Full screen">${ICON.fullscreen}</button>
</div>`;
const HIDE_AFTER_MS = 2500;
const fmtTime = (t) => { if (!Number.isFinite(t) || t < 0) t = 0; const s = Math.floor(t), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; const p = (n) => String(n).padStart(2, '0'); return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`; };
const UNSUPPORTED = { playbackRate: 1, defaultPlaybackRate: 1, preservesPitch: true, srcObject: null, mediaKeys: null, disablePictureInPicture: false, disableRemotePlayback: false };
const notSupported = (what) => new DOMException(`${what} is not supported by <video-hfp>`, 'NotSupportedError');
const TIMEUPDATE_MS = 250;
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.trunc(Number(v))));

/** A declared clip: <hfp-clip name src prepare-at>. The parent <video-hfp> opens it; this element holds the attributes. */
const HTMLElementBase = typeof HTMLElement === 'undefined' ? class {} : HTMLElement;   // importable where there is no DOM (a server render); define() then does nothing

export class HFPClip extends HTMLElementBase {
  get name() { return this.getAttribute('name') || ''; }
  set name(v) { this.setAttribute('name', v); }
  get src() { return this.getAttribute('src') || ''; }
  set src(v) { this.setAttribute('src', v); }
  /** The frame to prepare on load, or null. */
  get prepareAt() { const v = this.getAttribute('prepare-at'); return v == null || v === '' ? null : Number(v); }
  set prepareAt(v) { if (v == null) this.removeAttribute('prepare-at'); else this.setAttribute('prepare-at', String(v)); }
}

export class VideoHFP extends HTMLElementBase {
  static get observedAttributes() { return ['src', 'width', 'height', 'poster', 'muted', 'loop', 'preload', 'loop-start', 'loop-end', 'controls', 'controlslist']; }
  static HAVE_NOTHING = 0; static HAVE_METADATA = 1; static HAVE_CURRENT_DATA = 2; static HAVE_FUTURE_DATA = 3; static HAVE_ENOUGH_DATA = 4;
  static NETWORK_EMPTY = 0; static NETWORK_IDLE = 1; static NETWORK_LOADING = 2; static NETWORK_NO_SOURCE = 3;

  constructor() {
    super();
    this._root = this.attachShadow({ mode: 'open' });
    this._root.innerHTML = TEMPLATE;
    this._canvas = this._root.querySelector('canvas');
    this._engine = null;
    this._engineOpts = {};
    this._clips = new Map();        // name → Clip (declared children, open({ name }))
    this._opened = new Map();       // absolute URL or Blob → Promise<Clip>
    this._declared = new WeakMap(); // <hfp-clip> → { src, prepareAt } handled
    this._main = null; this._mainPromise = null;
    this._readyState = 0; this._networkState = 0;
    this._paused = true; this._ended = false; this._seeking = false; this._waiting = false; this._playingPending = false; this._playPending = false;
    this._pos = null;               // where a paused playback resumes: { clip, from, to, loop, index }
    this._volume = 1; this._muted = null;
    this._error = null;
    this._rvfc = new Map(); this._rvfcId = 0;
    this._timeupdate = 0; this._lastTimeupdate = 0;
    this._dataFiredFor = null;      // the clip loadeddata / canplay were fired for
    this._observer = null;
    this._connected = false;
    this._controls = { bar: this._root.querySelector('.hfp-controls'), hideTimer: 0, scrubbing: false, resumeAfterScrub: false };
    this._wireControls();
  }

  // ---- lifecycle ----------------------------------------------------------------------------
  /** The engine behind the element (a Player). Created on first connection; `engineOptions` before that sets lookahead / avOffset / audioContext. */
  get engine() { return this._engine ?? this._makeEngine(); }
  set engineOptions(opts) { if (this._engine) throw new Error('engineOptions must be set before the element is connected'); this._engineOpts = { ...opts }; }
  _makeEngine() {
    const engine = this._engine = new Player(this._canvas, { worker: this.hasAttribute('worker'), ...this._engineOpts });
    engine.addEventListener('frame', (e) => this._onFrame(e));
    engine.addEventListener('switch', (e) => this._fire('switch', { fromClip: e.fromClip, fromFrame: e.fromFrame, toClip: e.toClip, toFrame: e.toFrame }));
    engine.addEventListener('loop', (e) => this._fire('loop', { clip: e.clip, pass: e.pass }));
    engine.addEventListener('stall', (e) => { this._waiting = true; this._readyState = 2; this._fire('stall', { clip: e.clip, p: e.p }); this._fire('waiting'); });
    engine.addEventListener('ended', (e) => this._onEnded(e));
    engine.addEventListener('blocked', (e) => this._fire('blocked', { clip: e.clip }));
    engine.addEventListener('memory', (e) => this._fire('memory', { bytes: e.bytes, level: e.level, previous: e.previous }));
    engine.addEventListener('optimized', (e) => this._fire('optimized', { profile: e.profile, floor: e.floor, source: e.source }));
    engine.addEventListener('handoff', (e) => this._fire('handoff', { clip: e.clip, bridge: e.bridge, used: e.used, late: e.late, next: e.next }));
    engine.addEventListener('tuned', (e) => this._fire('tuned', { clip: e.clip, bridge: e.bridge, used: e.used, late: e.late, next: e.next, scale: e.scale }));
    engine.addEventListener('error', (e) => {
      if (e.recovered) { this._fire('decoderrefused', { error: e.error, clip: e.clip }); return; }
      this._error = { code: 3, message: e.error?.message ?? String(e.error), error: e.error, clip: e.clip };
      this._fire('error', { error: e.error, clip: e.clip });
    });
    this._applyVolume();
    return engine;
  }
  connectedCallback() {
    this._connected = true;
    this.engine;
    this._observer ??= new MutationObserver(() => this._scanChildren());
    this._observer.observe(this, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'name', 'prepare-at'] });
    this._scanChildren();
    this._syncControls();
    if (this.hasAttribute('src') && !this._mainPromise) this._load();
  }
  disconnectedCallback() { this._connected = false; this._observer?.disconnect(); }
  attributeChangedCallback(name, old, val) {
    if (old === val) return;
    switch (name) {
      case 'src': if (this._connected) this._load(); break;
      case 'width': case 'height': this._applySize(); break;
      case 'poster': this._applyPoster(); break;
      case 'muted': if (this._muted == null && this._engine) { this._applyVolume(); this._fire('volumechange'); } break;   // the attribute parsed with the element is the default, not a change
      case 'preload': if (val === 'auto' && this._main && this._readyState < 2) this._warm(this._main); break;
      case 'controls': case 'controlslist': this._syncControls(); break;
      case 'loop': case 'loop-start': case 'loop-end': break;   // read at the next play()
    }
  }
  /** Release the engine, its decoders, bridges and AudioContext. The element is empty afterwards. */
  destroy() { this.pause(); this._engine?.destroy(); this._engine = null; this._main = null; this._mainPromise = null; this._clips.clear(); this._opened.clear(); this._readyState = 0; this._networkState = 0; }

  // ---- the <video> surface ------------------------------------------------------------------
  get src() { return this.getAttribute('src') ?? ''; }
  set src(v) { this.setAttribute('src', v); }
  get currentSrc() { return this._main?.url ?? ''; }
  get width() { return Number(this.getAttribute('width')) || 0; }
  set width(v) { this.setAttribute('width', String(v)); }
  get height() { return Number(this.getAttribute('height')) || 0; }
  set height(v) { this.setAttribute('height', String(v)); }
  get poster() { return this.getAttribute('poster') ?? ''; }
  set poster(v) { this.setAttribute('poster', v); }
  get preload() { return this.getAttribute('preload') ?? 'metadata'; }
  set preload(v) { this.setAttribute('preload', v); }
  get autoplay() { return this.hasAttribute('autoplay'); }
  set autoplay(v) { this.toggleAttribute('autoplay', !!v); }
  get loop() { return this.hasAttribute('loop'); }
  set loop(v) { this.toggleAttribute('loop', !!v); }
  get playsInline() { return this.hasAttribute('playsinline'); }
  set playsInline(v) { this.toggleAttribute('playsinline', !!v); }
  get crossOrigin() { return this.getAttribute('crossorigin'); }
  set crossOrigin(v) { if (v == null) this.removeAttribute('crossorigin'); else this.setAttribute('crossorigin', v); }
  get controlsList() { return (this.getAttribute('controlslist') || '').split(/\s+/).filter(Boolean); }
  set controlsList(v) { this.setAttribute('controlslist', Array.isArray(v) ? v.join(' ') : String(v)); }
  get controls() { return this.hasAttribute('controls'); }
  set controls(v) { this.toggleAttribute('controls', !!v); }
  /** Muted: the property, else the attribute (the attribute is the default, as on <video>). */
  get muted() { return this._muted ?? this.hasAttribute('muted'); }
  set muted(v) { this._muted = !!v; this._applyVolume(); this._fire('volumechange'); }
  get defaultMuted() { return this.hasAttribute('muted'); }
  set defaultMuted(v) { this.toggleAttribute('muted', !!v); }
  get volume() { return this._volume; }
  set volume(v) { v = Number(v); if (!(v >= 0 && v <= 1)) throw new DOMException('volume must be between 0 and 1', 'IndexSizeError'); this._volume = v; this._applyVolume(); this._fire('volumechange'); }
  get paused() { return this._paused; }
  get ended() { return this._ended; }
  get seeking() { return this._seeking; }
  get readyState() { return this._readyState; }
  get networkState() { return this._networkState; }
  get error() { return this._error; }
  get duration() { const c = this._currentClip(); return c ? c.duration : NaN; }
  get videoWidth() { return this._currentClip()?.displayWidth ?? 0; }
  get videoHeight() { return this._currentClip()?.displayHeight ?? 0; }
  /** Seconds, for compatibility; setting is a seek to the frame at that time. */
  get currentTime() { const c = this._currentClip(); if (!c) return 0; const f = this.currentFrame; return f >= 0 ? c.frameTime(f) : 0; }
  set currentTime(t) { const c = this._currentClip(); if (!c) return; this.seek(c.frameAt(Number(t) || 0)); }
  fastSeek(t) { this.currentTime = t; }
  get textTracks() { return []; }
  addTextTrack() { throw notSupported('text tracks'); }
  requestPictureInPicture() { return Promise.reject(notSupported('picture-in-picture')); }
  canPlayType(type) { return /^video\/(mp4|webm|quicktime|x-matroska)/i.test(type) ? 'probably' : ''; }
  captureStream(fps) { return fps == null ? this._canvas.captureStream() : this._canvas.captureStream(fps); }
  load() { this._load(); }
  /** Also the canvas, for anyone who needs to draw on top or read pixels. */
  get canvas() { return this._canvas; }

  // ---- the frame-exact surface ----------------------------------------------------------------
  /** The clip on screen (the one playing, or the one paused on). */
  get clip() { return this._currentClip(); }
  /** Declared and named clips, by name. */
  get clips() { return this._clips; }
  get frameRate() { return this._currentClip()?.fps ?? 0; }
  get frameCount() { return this._currentClip()?.frameCount ?? 0; }
  /** The frame on screen: the last one drawn while playing, the one paused on otherwise. */
  get currentFrame() {
    const e = this._engine;
    if (!this._paused && e && e.clip) return e.stats.index;
    return this._pos ? this._pos.index : (this._main && e && e.stats.index >= 0 ? e.stats.index : -1);
  }
  get loopStart() { return Number(this.getAttribute('loop-start')) || 0; }
  set loopStart(v) { this.setAttribute('loop-start', String(v)); }
  get loopEnd() { const v = this.getAttribute('loop-end'); return v == null || v === '' ? null : Number(v); }
  set loopEnd(v) { if (v == null) this.removeAttribute('loop-end'); else this.setAttribute('loop-end', String(v)); }
  /** Bridges held right now. */
  get prepared() { return this._engine ? this._engine.prepared : []; }
  /** The floor profile bridges are sized from: the baseline until optimize() measures this device. Settable. */
  get floor() { return this.engine.floor; }
  set floor(f) { this.engine.floor = f; }
  /**
   * Size bridges from this device: the profile this origin already measured, or a measurement now (the
   * probe on the current clip; nothing may be playing; `{ force: true }` re-measures). Resolves to the
   * HardwareProfile; fires `optimized`. A new element starts from the stored profile on its own.
   */
  async optimize(opts = {}) {
    const clip = this._currentClip() ?? (opts.force || !storedProfile() ? await this._ensureMain() : null);
    return this.engine.optimize(clip, opts);
  }

  /**
   * Open a clip (URL, File or Blob) once; the same URL answers the same Clip. `name` registers it for
   * targets by name. The rest of `opts` goes to loadClip (stream, windowBytes, budgetBytes, onProgress).
   */
  open(src, { name, ...rest } = {}) {
    const key = typeof src === 'string' ? new URL(src, this.ownerDocument?.baseURI ?? location.href).href : src;
    let p = this._opened.get(key);
    if (!p) {
      p = loadClip(typeof src === 'string' ? key : src, { name, ...rest });
      this._opened.set(key, p);
      p.catch(() => { if (this._opened.get(key) === p) this._opened.delete(key); });
    }
    if (name) p.then((c) => { this._clips.set(name, c); if (!c.name || c.name === 'clip') c.name = name; }).catch(() => {});
    return p;
  }

  /**
   * Play: with no argument, resume where pause() left off, or the main clip from its start (the whole
   * clip, or [loop-start, loop-end) when `loop` is set). With { clip?, from, to, loop, startIndex },
   * exactly that range. Rejects with NotAllowedError when the clip has audio and the page has had no
   * gesture yet, as <video> does (and fires `blocked`); a silent or muted clip plays on the wall clock.
   */
  async play(range) {
    const engine = this.engine;
    const resumed = engine.resume();   // first, synchronously: an AudioContext may only start inside the tap that called us
    const explicit = !!(range && typeof range === 'object');
    let clip = explicit && range.clip != null ? this._clipOf(range.clip) : (this._pos?.clip ?? null);
    if (!clip) clip = await this._ensureMain();
    await resumed;
    if (clip.audio && !this.muted && engine.audioContext.state !== 'running') {
      this._fire('blocked', { clip });
      throw new DOMException("play() failed because the user didn't interact with the document first.", 'NotAllowedError');
    }
    let from, to, loop, startIndex;
    if (explicit) { from = range.from ?? 0; to = range.to ?? clip.frameCount; loop = !!range.loop; startIndex = range.startIndex ?? from; }
    else if (this._pos && this._pos.clip === clip && !this._ended) { ({ from, to, loop } = this._pos); startIndex = this._pos.index; }
    else { loop = this.loop; from = loop ? clampInt(this.loopStart, 0, clip.frameCount - 1) : 0; to = loop && this.loopEnd != null ? clampInt(this.loopEnd, from + 1, clip.frameCount) : clip.frameCount; startIndex = from; }
    this._begin(clip, { from, to, loop, startIndex });
    engine.play(clip, { from, to, loop, startIndex });
  }
  /** Loop [from, to) of the current (or main) clip, starting now. */
  loop_(from, to) { return this.play({ clip: this._currentClip() ?? undefined, from, to, loop: true }); }
  pause() {
    if (this._paused) return;
    const e = this._engine; const seg = e?._segment ?? e?._next;
    if (seg) { const shown = e.stats.index; this._pos = { clip: seg.clip, from: seg.from, to: seg.to, loop: seg.loop, index: e.clip === seg.clip && shown >= seg.from && shown < seg.to ? shown : seg.startIndex }; }
    e?.stop();
    this._paused = true; this._playingPending = false; this._playPending = false;
    this._stopTimeupdate();
    this._fire('timeupdate'); this._fire('pause');
  }
  /** Show frame `frame` of the current clip: a cold seek while playing; the frame itself while paused. */
  seek(frame) {
    const clip = this._currentClip();
    if (!clip) throw new DOMException('seek: nothing is open', 'InvalidStateError');
    frame = clampInt(frame, 0, clip.frameCount - 1);
    this._seeking = true; this._ended = false; this._fire('seeking');
    if (!this._paused) {
      const seg = this._engine._next ?? this._engine._segment;
      let { from, to, loop } = seg && seg.clip === clip ? seg : { from: 0, to: clip.frameCount, loop: false };
      if (!(frame >= from && frame < to)) { from = 0; to = clip.frameCount; loop = false; }
      this._pos = { clip, from, to, loop, index: frame };
      this._engine.play(clip, { from, to, loop, startIndex: frame });
      return;
    }
    const base = this._pos && this._pos.clip === clip && frame >= this._pos.from && frame < this._pos.to ? this._pos : { clip, from: 0, to: clip.frameCount, loop: false };
    this._pos = { ...base, index: frame };
    this._showFrame(clip, frame).then(() => { this._seeking = false; this._fire('timeupdate'); this._fire('seeked'); }, (e) => { this._seeking = false; this._fire('error', { error: e, clip }); });
  }
  /**
   * Show `target`'s `frame` now — the next display frame when it was prepared, else as fast as the device
   * decodes it. `target`: a Clip, a declared clip's name, or a Prepared handle. opts: { from, to, loop }.
   */
  cut(target, frame, opts = {}) {
    const { clip, handle } = this._target(target, frame);
    this._begin(clip, { from: opts.from ?? frame, to: opts.to ?? clip.frameCount, loop: !!opts.loop, startIndex: frame });
    this.engine.cut(handle ?? clip, frame, opts);
  }
  /** After the current clip shows `at`, `target`'s `frame` takes the next slot. Returns the player time of the boundary. */
  cutAfter(at, target, frame, opts = {}) {
    const { clip, handle } = this._target(target, frame);
    const t = this.engine.cutAfter(at, handle ?? clip, frame, opts);
    this._begin(clip, { from: opts.from ?? frame, to: opts.to ?? clip.frameCount, loop: !!opts.loop, startIndex: frame }, true);
    return t;
  }
  cancelCut() { this._engine?.cancelCut(); }
  /** Prepare a target (a bridge), or an array of { clip, frame }. Resolves to the handle(s). */
  prepare(target, frame, opts) {
    if (Array.isArray(target)) return this.engine.prepare(target.map((t) => ({ ...t, clip: this._clipOf(t.clip) })), undefined, opts);
    return this.engine.prepare(this._clipOf(target), frame, opts);
  }
  release(handle) { this._engine?.release(handle); }
  releaseAll() { this._engine?.releaseAll(); }
  /** One callback per presented frame; metadata carries the frame number and clip. One-shot, like the <video> API. */
  requestVideoFrameCallback(cb) { const id = ++this._rvfcId; this._rvfc.set(id, cb); return id; }
  cancelVideoFrameCallback(id) { this._rvfc.delete(id); }

  // ---- the controls bar ---------------------------------------------------------------------------
  /** <video-hfp controls>: a bar in the shadow root — play/pause, a frame at a time, the time, a scrubber in frames, mute, full screen; it hides while playing and comes back on a touch, a move or a key. */
  _wireControls() {
    const c = this._controls, q = (sel) => c.bar.querySelector(sel);
    c.play = q('.hfp-play'); c.prev = q('.hfp-prev'); c.next = q('.hfp-next'); c.cur = q('.hfp-cur'); c.dur = q('.hfp-dur'); c.scrub = q('.hfp-scrub'); c.mute = q('.hfp-mute'); c.fs = q('.hfp-fs');
    const stop = (e) => { e.stopPropagation(); };
    c.play.addEventListener('click', (e) => { stop(e); if (this._paused) this.play().catch(() => {}); else this.pause(); });
    c.prev.addEventListener('click', (e) => { stop(e); this._stepFrame(-1); });
    c.next.addEventListener('click', (e) => { stop(e); this._stepFrame(1); });
    c.mute.addEventListener('click', (e) => { stop(e); this.muted = !this.muted; });
    c.fs.addEventListener('click', (e) => { stop(e); this._toggleFullscreen(); });
    // scrubbing: the label follows the thumb; the seek lands on release (each seek while paused decodes the frame)
    c.scrub.addEventListener('pointerdown', () => { c.scrubbing = true; c.resumeAfterScrub = !this._paused; if (!this._paused) this.pause(); });
    c.scrub.addEventListener('input', () => { const clip = this._currentClip(); if (clip) c.cur.textContent = fmtTime(clip.frameTime(Number(c.scrub.value))); });
    const release = () => { if (!c.scrubbing) return; c.scrubbing = false; this.seek(Number(c.scrub.value)); if (c.resumeAfterScrub) { c.resumeAfterScrub = false; this.play().catch(() => {}); } };
    c.scrub.addEventListener('change', release); c.scrub.addEventListener('pointerup', release); c.scrub.addEventListener('pointercancel', release);
    c.bar.addEventListener('click', stop); c.bar.addEventListener('pointerdown', stop);
    // the bar follows the element's own events
    this.addEventListener('play', () => this._controlsState()); this.addEventListener('pause', () => this._controlsState()); this.addEventListener('ended', () => this._controlsState());
    this.addEventListener('volumechange', () => this._controlsState());
    this.addEventListener('loadedmetadata', () => this._controlsMeta()); this.addEventListener('durationchange', () => this._controlsMeta());
    this.addEventListener('timeupdate', () => this._controlsTime()); this.addEventListener('seeked', () => this._controlsTime());
    // presence: a move, a touch or a key brings the bar back; it leaves on its own while playing
    const wake = () => this._showControls();
    this.addEventListener('pointermove', wake); this.addEventListener('pointerdown', wake); this.addEventListener('focusin', wake);
    this.addEventListener('pointerleave', () => { if (!this._paused) this._hideControlsSoon(0); });
    this.addEventListener('keydown', (e) => this._controlsKey(e));
    const onFs = () => this._controlsState();
    document.addEventListener('fullscreenchange', onFs); document.addEventListener('webkitfullscreenchange', onFs);
  }
  _syncControls() {
    const c = this._controls, on = this.hasAttribute('controls');
    c.bar.hidden = !on;
    if (this.controlsList.includes('nofullscreen')) c.bar.setAttribute('data-nofullscreen', ''); else c.bar.removeAttribute('data-nofullscreen');
    if (on && !this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0');
    this._controlsMeta(); this._controlsState(); this._controlsTime(); this._showControls();
  }
  _controlsMeta() {
    const c = this._controls, clip = this._currentClip();
    c.scrub.max = clip ? String(Math.max(0, clip.frameCount - 1)) : '0';
    c.dur.textContent = fmtTime(clip ? clip.duration : 0);
  }
  _controlsState() {
    const c = this._controls;
    c.play.innerHTML = this._paused ? ICON.play : ICON.pause; c.play.setAttribute('aria-label', this._paused ? 'Play' : 'Pause');
    c.mute.innerHTML = this.muted ? ICON.muted : ICON.sound; c.mute.setAttribute('aria-label', this.muted ? 'Unmute' : 'Mute');
    const fs = (document.fullscreenElement || document.webkitFullscreenElement) === this;
    c.fs.innerHTML = fs ? ICON.exitFullscreen : ICON.fullscreen; c.fs.setAttribute('aria-label', fs ? 'Exit full screen' : 'Full screen');
    if (this._paused) this._showControls(); else this._hideControlsSoon();
  }
  _controlsTime() {
    const c = this._controls; if (c.scrubbing) return;
    const f = this.currentFrame, clip = this._currentClip();
    if (f >= 0) c.scrub.value = String(f);
    c.cur.textContent = fmtTime(clip && f >= 0 ? clip.frameTime(f) : 0);
    c.cur.title = f >= 0 ? `frame ${f}` : '';
  }
  _showControls() { const c = this._controls; c.bar.classList.remove('hfp-away'); if (!this._paused) this._hideControlsSoon(); }
  _hideControlsSoon(ms = HIDE_AFTER_MS) { const c = this._controls; clearTimeout(c.hideTimer); c.hideTimer = setTimeout(() => { if (!this._paused && !c.scrubbing) c.bar.classList.add('hfp-away'); }, ms); }
  _stepFrame(dir) { const clip = this._currentClip(); if (!clip) return; if (!this._paused) this.pause(); this.seek(Math.max(0, Math.min(clip.frameCount - 1, this.currentFrame + dir))); }
  _toggleFullscreen() {
    if ((document.fullscreenElement || document.webkitFullscreenElement) === this) { (document.exitFullscreen || document.webkitExitFullscreen)?.call(document); return; }
    const req = this.requestFullscreen || this.webkitRequestFullscreen;
    if (req) { const p = req.call(this); if (p && p.catch) p.catch(() => {}); }
  }
  /** Keyboard, when the element has focus (controls give it a tabindex): space/k play-pause, arrows 5 s (shift: one frame), j/l 10 s, m mute, f full screen. */
  _controlsKey(e) {
    if (!this.hasAttribute('controls') || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const clip = this._currentClip(); if (!clip) return;
    const by = (sec) => this.seek(clip.frameAt(this.currentTime + sec));
    switch (e.key) {
      case ' ': case 'k': if (this._paused) this.play().catch(() => {}); else this.pause(); break;
      case 'ArrowRight': if (e.shiftKey) this._stepFrame(1); else by(5); break;
      case 'ArrowLeft': if (e.shiftKey) this._stepFrame(-1); else by(-5); break;
      case 'l': by(10); break;
      case 'j': by(-10); break;
      case 'm': this.muted = !this.muted; break;
      case 'f': this._toggleFullscreen(); break;
      default: return;
    }
    e.preventDefault(); this._showControls();
  }

  // ---- internals ------------------------------------------------------------------------------
  _fire(type, detail) { const ev = new Event(type, { bubbles: false }); if (detail) Object.assign(ev, detail); this.dispatchEvent(ev); }
  _currentClip() { const e = this._engine; return (!this._paused && e?.clip) || this._pos?.clip || this._main || null; }
  _clipOf(x) {
    if (typeof x === 'string') { const c = this._clips.get(x); if (!c) throw new DOMException(`no clip named "${x}" (declare it with <hfp-clip name> or open(src, { name }))`, 'NotFoundError'); return c; }
    if (x && x.kind === 'Prepared') return x.clip;
    if (!x || typeof x.frameCount !== 'number') throw new TypeError('expected a Clip, a clip name, or a Prepared handle');
    return x;
  }
  _target(target, frame) {
    if (target && target.kind === 'Prepared') return { clip: target.clip, handle: target };
    const clip = this._clipOf(target);
    if (!Number.isInteger(frame) || frame < 0 || frame >= clip.frameCount) throw new RangeError(`frame ${frame} is outside ${clip.name} [0, ${clip.frameCount})`);
    return { clip, handle: null };
  }
  /** Playback state for a segment that starts now (or, `later`, at a boundary ahead). */
  _begin(clip, range, later = false) {
    const wasPaused = this._paused;
    this._paused = false; this._ended = false;
    if (!later) this._pos = { clip, ...range, index: range.startIndex };
    this._playingPending = true;
    if (wasPaused) { if (this._dataFiredFor === clip) this._fire('play'); else this._playPending = true; }
    this._startTimeupdate();
  }
  async _ensureMain() {
    if (this._main) return this._main;
    if (!this._mainPromise) { if (!this.hasAttribute('src')) throw new DOMException('play(): no source', 'NotSupportedError'); this._load(true); }
    return this._mainPromise;
  }
  _load(force = false) {
    const src = this.getAttribute('src');
    this._main = null; this._readyState = 0; this._error = null; this._pos = null; this._dataFiredFor = null;
    if (!src) { this._mainPromise = null; this._networkState = 0; this._fire('emptied'); return; }
    if (!force && this.preload === 'none' && !this.autoplay) { this._mainPromise = null; this._networkState = 1; return; }
    this._networkState = 2; this._fire('loadstart');
    const p = this._mainPromise = this.open(src).then((clip) => {
      if (this._mainPromise !== p) return clip;
      this._main = clip; this._readyState = 1; this._networkState = 1;
      this._applySize();
      this._fire('durationchange'); this._fire('loadedmetadata');
      if (this.autoplay) this.play().catch(() => {});
      else if (this.preload === 'auto') this._warm(clip);
      return clip;
    }, (e) => { if (this._mainPromise === p) { this._networkState = 3; this._error = { code: 4, message: e.message, error: e }; this._fire('error', { error: e }); } throw e; });
    p.catch(() => {});
  }
  _warm(clip) { this._showFrame(clip, 0).catch(() => {}); }
  /** Decode one frame (a one-frame bridge) and draw it: posters, paused seeks, preload=auto. */
  async _showFrame(clip, index) {
    const bridge = await buildBridge(clip, index, { count: 1 });
    try { const f = bridge.frameAt(index); try { this.engine.draw(f, clip.rotation); } finally { f.close(); } } finally { bridge.close(); }
    if (this._readyState < 2) this._readyState = 2;
    this._firstData(clip);
  }
  _firstData(clip) {
    if (this._dataFiredFor === clip) return;
    this._dataFiredFor = clip;
    this._fire('loadeddata'); this._fire('canplay'); this._fire('canplaythrough');
  }
  _onFrame(e) {
    this._readyState = 4;
    this._firstData(e.clip);
    if (this._playPending) { this._playPending = false; this._fire('play'); }
    if (this._playingPending) { this._playingPending = false; this._fire('playing'); }
    else if (this._waiting) { this._waiting = false; this._fire('playing'); }
    if (this._seeking) { this._seeking = false; this._fire('seeked'); }
    if (this._pos && this._pos.clip === e.clip) this._pos.index = e.index;
    this._fire('frame', { clip: e.clip, index: e.index, p: e.p });
    if (this._rvfc.size) {
      const cbs = [...this._rvfc.values()]; this._rvfc.clear();
      const now = performance.now();
      const meta = { presentationTime: now, expectedDisplayTime: now, width: e.clip.displayWidth, height: e.clip.displayHeight, mediaTime: e.clip.frameTime(e.index), presentedFrames: this._engine.stats.rendered, frameNumber: e.index, clip: e.clip };
      for (const cb of cbs) { try { cb(now, meta); } catch (err) { setTimeout(() => { throw err; }); } }
    }
    if (now_() - this._lastTimeupdate >= TIMEUPDATE_MS) { this._lastTimeupdate = now_(); this._fire('timeupdate'); }
  }
  _onEnded(e) {
    const seg = this._engine?._segment;
    this._pos = { clip: e.clip, from: seg?.from ?? 0, to: seg?.to ?? e.clip.frameCount, loop: false, index: Math.max(0, (seg?.to ?? e.clip.frameCount) - 1) };
    this._paused = true; this._ended = true; this._playingPending = false;
    this._engine.stop();
    this._stopTimeupdate();
    this._fire('timeupdate'); this._fire('pause'); this._fire('ended');
  }
  _startTimeupdate() { if (!this._timeupdate) this._timeupdate = setInterval(() => { if (!this._paused) this._fire('timeupdate'); }, TIMEUPDATE_MS); }
  _stopTimeupdate() { if (this._timeupdate) { clearInterval(this._timeupdate); this._timeupdate = 0; } }
  _applyVolume() { const e = this._engine; if (!e) return; const muted = this.muted; e.muted = muted; e.masterGain.gain.value = muted ? 0 : this._volume; }
  /** Like <video>: the width/height attributes when given, else the clip's own size; one of them given, the other follows the aspect ratio. */
  _applySize() {
    const w = this.width, h = this.height, c = this._main;
    const vw = c?.displayWidth ?? 0, vh = c?.displayHeight ?? 0;
    if (vw && vh) this.style.setProperty('--video-hfp-aspect', `${vw} / ${vh}`);
    if (w && h) { this.style.setProperty('--video-hfp-width', `${w}px`); this.style.setProperty('--video-hfp-height', `${h}px`); }
    else if (w) { this.style.setProperty('--video-hfp-width', `${w}px`); this.style.removeProperty('--video-hfp-height'); }
    else if (h) { this.style.setProperty('--video-hfp-height', `${h}px`); this.style.setProperty('--video-hfp-width', `${vw && vh ? Math.round(h * vw / vh) : h * 2}px`); }
    else if (vw) { this.style.setProperty('--video-hfp-width', `${vw}px`); this.style.removeProperty('--video-hfp-height'); }
  }
  _applyPoster() {
    const url = this.getAttribute('poster');
    if (!url || this._readyState >= 2) return;
    const img = new Image();
    img.onload = () => { if (this._readyState >= 2) return; const e = this.engine; e.canvas.width = img.naturalWidth; e.canvas.height = img.naturalHeight; e.ctx.drawImage(img, 0, 0); };
    img.src = url;
  }
  _scanChildren() {
    for (const el of this.querySelectorAll(':scope > hfp-clip')) {
      const src = el.getAttribute('src'), name = el.getAttribute('name') || null, prepareAt = el.getAttribute('prepare-at');
      if (!src) continue;
      const done = this._declared.get(el);
      if (done && done.src === src && done.name === name && done.prepareAt === prepareAt) continue;
      this._declared.set(el, { src, name, prepareAt });
      const p = this.open(src, name ? { name } : {});
      if (prepareAt != null && prepareAt !== '') p.then((clip) => this.prepare(clip, Number(prepareAt))).catch(() => {});
    }
  }
}
// loop(from, to) is the verb; the method above is named loop_ so the `loop` attribute's getter/setter can keep its <video> meaning
Object.defineProperty(VideoHFP.prototype, 'loopRange', { value: VideoHFP.prototype.loop_, writable: true, configurable: true });
for (const [name, value] of Object.entries(UNSUPPORTED)) {
  Object.defineProperty(VideoHFP.prototype, name, { get() { return value; }, set() { throw notSupported(name); }, configurable: true });
}
const now_ = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Define <video-hfp> and <hfp-clip> (once). Called on import. */
export function define() {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get('hfp-clip')) customElements.define('hfp-clip', HFPClip);
  if (!customElements.get('video-hfp')) customElements.define('video-hfp', VideoHFP);
}
define();
