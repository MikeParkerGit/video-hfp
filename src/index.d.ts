// video-hfp — type declarations (hand-written; the source is plain ES modules).
// `video-hfp` is the core (side-effect free); `video-hfp/element` defines <video-hfp> and <hfp-clip>.

export interface VideoSample { offset: number; size: number; dts: number; pts: number; duration: number; durationUnits?: number; key: boolean }
export interface AudioSample { offset: number; size: number; dts: number; pts: number; duration: number; key: boolean }
export interface VideoTrack { kind: 'video'; codec: string | null; format: string; codedWidth: number; codedHeight: number; rotation?: number; description?: Uint8Array; pixelAspect?: number; timescale: number; duration: number; editOffset: number; samples: VideoSample[] }
export interface AudioTrack { kind: 'audio'; codec: string | null; format: string; sampleRate: number; channels: number; description?: Uint8Array; preSkip: number; duration: number; editOffset: number; samples: AudioSample[] }
export interface DemuxResult { container: 'mp4' | 'webm'; duration: number; video: VideoTrack; audio: AudioTrack | null }

export interface ByteSource {
  size: number; url: string | null;
  read(offset: number, length: number): Promise<Uint8Array>;
  has(offset: number, length: number): boolean;
  slice(offset: number, length: number): Uint8Array | null;
  ensure(offset: number, length: number): Promise<void>;
  readonly residentBytes: number;
  close(): void;
}
export class BufferSource implements ByteSource {
  constructor(bytes: ArrayBuffer | Uint8Array);
  size: number; url: null; residentBytes: number;
  read(offset: number, length: number): Promise<Uint8Array>; has(): boolean; slice(offset: number, length: number): Uint8Array; ensure(): Promise<void>; close(): void;
}
export class RangeSource implements ByteSource {
  constructor(url: string, size: number, opts?: { windowBytes?: number; budgetBytes?: number; fetch?: typeof fetch; pin?: [number, number] | null });
  size: number; url: string; residentBytes: number; pin: [number, number] | null;
  stats: { requests: number; bytes: number; evictions: number };
  read(offset: number, length: number): Promise<Uint8Array>; has(offset: number, length: number): boolean; slice(offset: number, length: number): Uint8Array | null; ensure(offset: number, length: number): Promise<void>; close(): void;
}
export function probeUrl(url: string, fetchFn?: typeof fetch): Promise<{ size: number; ranges: boolean }>;
export function demuxMp4(src: { size: number; read(offset: number, length: number): Promise<Uint8Array> }): Promise<DemuxResult>;
export function parseMoov(moovPayload: Uint8Array): DemuxResult;
export function demuxWebm(src: { size: number; read(offset: number, length: number): Promise<Uint8Array> }): Promise<DemuxResult>;

export class Clip {
  constructor(index: DemuxResult, source: ByteSource, opts?: { name?: string; url?: string | null });
  name: string; url: string | null; container: string; source: ByteSource;
  codec: string; format: string; width: number; height: number; pixelAspect: number; description?: Uint8Array;
  /** degrees clockwise the stored frame is turned for display (a phone's portrait recording: 90), from the container's display matrix */ rotation: 0 | 90 | 180 | 270;
  /** the upright size: width/height swapped for 90 and 270 */ displayWidth: number; displayHeight: number;
  audio: AudioTrack | null; audioOffset: number;
  samples: VideoSample[]; frameCount: number; frameDuration: number; fps: number; fpsNum: number; fpsDen: number; vfr: boolean;
  frameTimes: Float64Array; frameDurations: Float64Array; keyframes: number[]; gop: number; reorderDepth: number; duration: number;
  frameTime(p: number): number; frameEnd(p: number): number; rangeEnd(to: number): number; frameAt(t: number, lo?: number, hi?: number): number;
  isKeyframe(p: number): boolean; keyframeAtOrBefore(p: number): number; decodeIndexOf(p: number): number; presIndexOf(d: number): number; lastDecodeIndexBefore(to: number): number;
  sampleBytes(d: number): Uint8Array | null; hasDecodeRange(d0: number, d1: number): boolean; ensureDecodeRange(d0: number, d1: number): Promise<void>; pinRange(from: number | null, to?: number): void;
  decoderConfig(): VideoDecoderConfig; isSupported(): Promise<boolean>;
  describe(): { name: string; url: string | null; container: string; codec: string; width: number; height: number; rotation: number; displayWidth: number; displayHeight: number; fps: number; vfr: boolean; frameCount: number; gop: number; keyframes: number; duration: number; audio: { codec: string; sampleRate: number; channels: number } | null };
  close(): void;
}
export const WHOLE_FILE_LIMIT: number;
export function loadClip(src: string | Blob | ArrayBuffer | Uint8Array, opts?: { name?: string; stream?: boolean | 'auto'; windowBytes?: number; budgetBytes?: number; fetch?: typeof fetch }): Promise<Clip>;

export interface Frame { frame: VideoFrame; p: number; index: number }
export class FrameSource {
  constructor(clip: Clip, opts?: { lookahead?: number; VideoDecoder?: any; EncodedVideoChunk?: any });
  clip: Clip; lookahead: number; error: Error | null; onerror: ((e: Error) => void) | null; dropped: number; fetchWaits: number;
  readonly queued: number; readonly nextP: number; readonly ended: boolean; readonly range: { from: number; to: number; loop: boolean };
  readonly stats: { queued: number; inflight: number; decodeQueue: number; dropped: number; fetchWaits: number; awaiting: boolean };
  start(opts?: { from?: number; to?: number; loop?: boolean; startIndex?: number; pStart?: number; /** where output resumes after each wrap (past a loop's bridge) */ loopResume?: number }): void;
  /** After each wrap, resume output at `index`; returns the pass number (0 = the pass this source started in) from which it applies. */
  setLoopResume(index: number): number;
  /** Bind this source and its decoder to another clip; the next start() configures the decoder for it. */
  retarget(clip: Clip): void;
  reseek(index: number, p: number): void; indexForP(p: number): number;
  peek(): Frame | null; shift(): Frame | undefined; dropBefore(target: number): number; fill(): void; close(): void;
}

export class AudioEngine {
  constructor(ctx: AudioContext, opts?: { windowSeconds?: number; aheadSeconds?: number; maxWindows?: number });
  ctx: AudioContext; master: GainNode; windowSeconds: number; aheadSeconds: number;
  stats: { windowsDecoded: number; late: number; mode: 'webcodecs' | 'whole' | null };
  release(clip: Clip): void; dispose(): void;
}

export interface SegmentStartEvent extends Event { clip: Clip; from: number; to: number; loop: boolean; tStart: number }
export interface SwitchEvent extends Event { fromClip: Clip | null; fromFrame: number; toClip: Clip; toFrame: number }
export interface FrameEvent extends Event { clip: Clip; index: number; p: number }
export interface LoopEvent extends Event { clip: Clip; pass: number }
export interface EndedEvent extends Event { clip: Clip; reason?: 'decoder' }
export interface StallEvent extends Event { clip: Clip; p: number }
export interface PlayerErrorEvent extends Event { error: Error; clip: Clip; recovered: boolean }
export interface BlockedEvent extends Event { clip: Clip }
export interface PlayRange { from?: number; to?: number; loop?: boolean; startIndex?: number; /** force or forbid a loop's wrap bridge; default: structural (lead-in longer than the lookahead) */ bridge?: boolean }
export interface CutRange { from?: number; to?: number; loop?: boolean; bridge?: boolean }

/** A prepared target: a bridge of raw frames from `frame` on, and no decoder. cut() consumes it; release() drops it. */
export interface Prepared {
  kind: 'Prepared'; clip: Clip; frame: number;
  /** frames in the bridge (bridgeFrames(clip, frame) unless given) */ bridgeFrames: number;
  /** bytes held once ready */ bytes: number;
  ready: boolean; consumed: boolean; error: Error | null;
  promise: Promise<Prepared>;
  release(): void;
}

/** The engine behind <video-hfp>. Use the element unless you are building another surface. */
export class Player extends EventTarget {
  /** The player holds no device numbers and imposes no limits; measuring (probeDevice) and planning (plan) are tools the app may use. */
  constructor(canvas: HTMLCanvasElement, opts?: { audioContext?: AudioContext; lookahead?: number; avOffset?: number; worker?: boolean });
  canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; audioContext: AudioContext; audio: AudioEngine; masterGain: GainNode;
  lookahead: number; avOffset: number; worker: boolean;
  /** a muted player may run on the wall clock before a gesture, as a silent clip does */ muted: boolean;
  stats: { rendered: number; dropped: number; stalls: number; index: number; p: number; decoders: number; bridges: number; /** frames held: bridges + decoders' lookaheads */ memoryBytes: number; memoryLevel: 'ok' | 'warning' | 'critical'; /** where the floor came from */ floor: 'baseline' | 'stored' | 'measured'; /** the learned scale on the floor's answer, and how many hand-offs taught it */ bridgeScale: number; tuned: number; clock: 'audio' | 'wall'; recoveries: number };
  /** what bridges are sized from: the baseline floor until optimize() measures this device; settable */ floor: FloorProfile;
  /** what playback learned on top of the floor (stored for the origin) */ tune: Tune;
  readonly outputLatency: number; readonly now: number; readonly playing: boolean; readonly clip: Clip | null; readonly currentFrame: number;
  /** the bridges held right now */ readonly prepared: Prepared[];
  resume(): Promise<void>;
  play(clip: Clip, opts?: PlayRange): void;
  /** Build a bridge for clip's frame (and fetch the hand-off bytes, warm the audio window). The same clip and frame twice is the same handle. */
  prepare(clip: Clip, frame: number, opts?: { bridge?: number; floor?: HardwareProfile }): Promise<Prepared>;
  prepare(targets: { clip: Clip; frame: number; bridge?: number }[], frame?: undefined, opts?: { bridge?: number; floor?: HardwareProfile }): Promise<Prepared[]>;
  release(handle: Prepared): void; releaseAll(): void;
  /** How many frames a bridge into clip at frame would hold on this player's floor. */ bridgeFramesFor(clip: Clip, frame: number): number;
  /** Size bridges from this device: the origin's stored profile, or a measurement with the clip (nothing playing; `force` re-measures). Resolves to the profile; fires 'optimized'. */ optimize(clip: Clip | null, opts?: { force?: boolean; maxDecoders?: number; frames?: number; cache?: boolean; stepTimeoutMs?: number; onProgress?: (stage: string) => void }): Promise<HardwareProfile>;
  /** Show the target's frame now: the next display frame when prepared (the bridge plays while the decoder re-targets behind it), else as fast as the device decodes it. */
  cut(target: Clip | Prepared, frame?: number, opts?: CutRange): void;
  /** After the current segment shows `at`, the target's frame takes the next slot. Returns the player time of the boundary. */
  cutAfter(at: number, target: Clip | Prepared, frame?: number, opts?: CutRange): number;
  cancelCut(): void;
  stop(): void; destroy(): void;
  /** Draw one frame onto the canvas, turned by `rotation` degrees clockwise (the canvas takes the upright size). */ draw(frame: VideoFrame, rotation?: number): void;
  addEventListener(type: 'segmentstart', listener: (e: SegmentStartEvent) => void): void;
  addEventListener(type: 'switch', listener: (e: SwitchEvent) => void): void;
  addEventListener(type: 'frame', listener: (e: FrameEvent) => void): void;
  addEventListener(type: 'loop', listener: (e: LoopEvent) => void): void;
  addEventListener(type: 'ended', listener: (e: EndedEvent) => void): void;
  addEventListener(type: 'stall', listener: (e: StallEvent) => void): void;
  addEventListener(type: 'error', listener: (e: PlayerErrorEvent) => void): void;
  addEventListener(type: 'blocked', listener: (e: BlockedEvent) => void): void;
  addEventListener(type: 'memory', listener: (e: MemoryEvent) => void): void;
  addEventListener(type: 'optimized', listener: (e: Event & { profile: HardwareProfile; floor: FloorProfile; source: 'stored' | 'measured' }) => void): void;
  addEventListener(type: 'handoff', listener: (e: HandoffEvent) => void): void;
  addEventListener(type: 'tuned', listener: (e: HandoffEvent & { scale: number }) => void): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
}
/** A hand-off observed: the bridge's length, how many of its frames were used before the decoder was ready (null when it was late), how many slots late, and the next length the rule chose (null: no change). */
export interface HandoffEvent extends Event { clip: Clip; bridge: number; used: number | null; late: number; next: number | null }
export interface MemoryEvent extends Event { bytes: number; level: 'ok' | 'warning' | 'critical'; previous: 'ok' | 'warning' | 'critical' }

// ---- the bridge ------------------------------------------------------------------------------
/** How many frames a bridge into `clip` at `frame` holds on the floor device: the smallest N whose span covers the restart, the decode run to the HAND-OFF frame (frame + N) from the keyframe before it, and the margin. */
export function bridgeFrames(clip: Pick<Clip, 'keyframeAtOrBefore' | 'width' | 'height' | 'fps' | 'frameCount'>, frame: number, floor?: HardwareProfile): number;
/** No bridge is ever shorter than this. */
export const MIN_BRIDGE_FRAMES: number;
/** What a hand-off teaches: late by k → n + k + 2; under three quarters used → used + 10 % (min 2), never under MIN_BRIDGE_FRAMES; else null. */
export function adjustBridge(n: number, outcome: { used?: number | null; late?: number }): number | null;
/** The longest bridge any frame of one GOP needs. */
export function maxBridgeFrames(clip: Pick<Clip, 'keyframeAtOrBefore' | 'width' | 'height' | 'fps' | 'frameCount' | 'gop'>, floor?: HardwareProfile): number;
export class Bridge {
  clip: Clip; frame: number; count: number; format: string; codedWidth: number; codedHeight: number; displayWidth: number; displayHeight: number;
  frameBytes: number; buffer: ArrayBuffer | null; filled: number; closed: boolean;
  readonly bytes: number; readonly end: number;
  has(index: number): boolean;
  /** a fresh VideoFrame of clip frame `index`, rebuilt from the parked planes; the caller closes it */ frameAt(index: number): VideoFrame;
  close(): void;
}
/** Decode `count` frames of `clip` from `frame` with a software decoder, copy each out raw, release the decoder. */
export function buildBridge(clip: Clip, frame: number, opts?: { count?: number; floor?: HardwareProfile; timeoutMs?: number; VideoDecoder?: any }): Promise<Bridge>;
/** A Bridge behind a FrameSource's surface, for the scheduler. */
export class BridgeSource {
  constructor(bridge: Bridge, opts?: { /** closing this source leaves the Bridge alive (a loop's wrap bridge) */ keep?: boolean });
  bridge: Bridge; keep: boolean; clip: Clip; readonly isBridge: true; readonly queued: number; readonly nextP: number; readonly ended: boolean;
  start(opts?: { pStart?: number; indexForP?: (p: number) => number }): void;
  peek(): Frame | null; shift(): Frame | undefined; dropBefore(target: number): number; reseek(index: number, p: number): void; close(): void;
}

// ---- the element -----------------------------------------------------------------------------
/** Metadata handed to requestVideoFrameCallback, with the frame number and clip on top of the <video> fields. */
export interface HFPFrameMetadata { presentationTime: number; expectedDisplayTime: number; width: number; height: number; mediaTime: number; presentedFrames: number; frameNumber: number; clip: Clip }
export type ClipTarget = Clip | string | Prepared;

/**
 * <video-hfp>: shaped like <video> (the attributes, properties and events it can honour; the rest throws NotSupportedError),
 * with the frame-exact verbs in frames. Import 'video-hfp/element' to define it.
 */
export class VideoHFP extends HTMLElement {
  // the <video> surface
  src: string; readonly currentSrc: string; width: number; height: number; poster: string; preload: 'none' | 'metadata' | 'auto' | string;
  autoplay: boolean; loop: boolean; playsInline: boolean; crossOrigin: string | null; controls: boolean;
  muted: boolean; defaultMuted: boolean; volume: number;
  readonly paused: boolean; readonly ended: boolean; readonly seeking: boolean; readonly readyState: 0 | 1 | 2 | 3 | 4; readonly networkState: 0 | 1 | 2 | 3;
  readonly error: { code: number; message: string; error?: Error; clip?: Clip } | null;
  readonly duration: number; readonly videoWidth: number; readonly videoHeight: number;
  /** seconds; setting is a seek to the frame at that time */ currentTime: number;
  fastSeek(t: number): void; load(): void; canPlayType(type: string): '' | 'maybe' | 'probably'; captureStream(fps?: number): MediaStream;
  readonly textTracks: never[]; addTextTrack(): never; requestPictureInPicture(): Promise<never>;
  /** throw NotSupportedError when set */ playbackRate: number; defaultPlaybackRate: number; preservesPitch: boolean; srcObject: null; mediaKeys: null; disablePictureInPicture: boolean; disableRemotePlayback: boolean;
  /** play: resume, or the main clip (the whole clip, or [loop-start, loop-end) with `loop`); or exactly a range. Rejects with NotAllowedError when audio needs a gesture. */
  play(range?: { clip?: ClipTarget; from?: number; to?: number; loop?: boolean; startIndex?: number }): Promise<void>;
  pause(): void;
  // the frame-exact surface
  readonly clip: Clip | null; readonly clips: Map<string, Clip>; readonly frameRate: number; readonly frameCount: number; readonly currentFrame: number;
  loopStart: number; loopEnd: number | null;
  readonly prepared: Prepared[];
  /** the floor bridges are sized from; settable */ floor: FloorProfile;
  /** size bridges from this device: the origin's stored profile, or a measurement on the current clip (nothing playing; `force` re-measures) */ optimize(opts?: { force?: boolean; onProgress?: (stage: string) => void; cache?: boolean }): Promise<HardwareProfile>;
  readonly engine: Player; engineOptions: { audioContext?: AudioContext; lookahead?: number; avOffset?: number }; readonly canvas: HTMLCanvasElement;
  open(src: string | Blob, opts?: { name?: string; stream?: boolean | 'auto'; windowBytes?: number; budgetBytes?: number; onProgress?: (stage: string) => void }): Promise<Clip>;
  seek(frame: number): void;
  /** loop [from, to) of the current clip, starting now (also `loop_`) */ loopRange(from: number, to: number): Promise<void>; loop_(from: number, to: number): Promise<void>;
  prepare(target: ClipTarget, frame: number, opts?: { bridge?: number; floor?: HardwareProfile }): Promise<Prepared>;
  prepare(targets: { clip: ClipTarget; frame: number; bridge?: number }[], frame?: undefined, opts?: { bridge?: number; floor?: HardwareProfile }): Promise<Prepared[]>;
  release(handle: Prepared): void; releaseAll(): void;
  cut(target: ClipTarget, frame: number, opts?: CutRange): void;
  cutAfter(at: number, target: ClipTarget, frame: number, opts?: CutRange): number;
  cancelCut(): void;
  requestVideoFrameCallback(cb: (now: number, metadata: HFPFrameMetadata) => void): number; cancelVideoFrameCallback(id: number): void;
  destroy(): void;
  addEventListener(type: 'frame', listener: (e: FrameEvent) => void): void;
  addEventListener(type: 'switch', listener: (e: SwitchEvent) => void): void;
  addEventListener(type: 'loop', listener: (e: LoopEvent) => void): void;
  addEventListener(type: 'stall', listener: (e: StallEvent) => void): void;
  addEventListener(type: 'blocked', listener: (e: BlockedEvent) => void): void;
  addEventListener(type: 'memory', listener: (e: MemoryEvent) => void): void;
  addEventListener(type: 'optimized', listener: (e: Event & { profile: HardwareProfile; floor: FloorProfile; source: 'stored' | 'measured' }) => void): void;
  addEventListener(type: 'handoff', listener: (e: HandoffEvent) => void): void;
  addEventListener(type: 'tuned', listener: (e: HandoffEvent & { scale: number }) => void): void;
  addEventListener(type: 'error' | 'decoderrefused', listener: (e: Event & { error?: Error; clip?: Clip }) => void): void;
  addEventListener(type: 'loadstart' | 'durationchange' | 'loadedmetadata' | 'loadeddata' | 'canplay' | 'canplaythrough' | 'play' | 'playing' | 'waiting' | 'pause' | 'ended' | 'seeking' | 'seeked' | 'timeupdate' | 'volumechange' | 'emptied', listener: (e: Event) => void): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
}
/** <hfp-clip name src prepare-at>: a clip the parent <video-hfp> opens (and prepares at `prepare-at`). */
export class HFPClip extends HTMLElement { name: string; src: string; prepareAt: number | null }
export function define(): void;

/** What a device measured as — the probe's answer, and the record in profiles.js. */
export interface HardwareProfile {
  kind: 'HardwareProfile'; version: 1; label: string;
  platform?: string; ua?: string; cores?: number | null; deviceMemoryGB?: number | null;
  resolution?: string; width?: number; height?: number; codec?: string;
  decodeFps: number; decoderStartupMs: number; /** a decoder re-targeted (reset + configure) to its first frame */ decoderRestartMs?: number; decoders: number; decodersAtLeast?: boolean; encodeFps: number | null; refreshHz: number;
  outputLatencyMs?: number | null; measuredAt: number | null; notes?: string[];
  /** per-frame bridge storage figures from probeBridgeCompression, by resolution ("1920x1080"), when measured */
  bridge?: Record<string, BridgeFigures & { source?: string }>;
}
export interface IntraFigures { codec: string; bitsPerPixel?: number; bytesPerFrame: number; encodeMsPerFrame: number; decoderStartToFirstFrameMs: number; decoderRestartToFirstFrameMs?: number; decodeMsPerFrame: number; ratio?: number }
export interface BridgeFigures {
  raw?: { bytesPerFrame: number; copyOutMs: number; rebuildMs: number };
  jpeg?: { bytesPerFrame: number; encodeMs: number; decodeMs: number; /** three frames decoded at once, wall time */ decode3ParallelMs?: number; ratio?: number };
  webp?: { bytesPerFrame: number; encodeMs: number; decodeMs: number; decode3ParallelMs?: number; ratio?: number };
  intra?: IntraFigures | { unsupported: string };
  /** the intra size at other bitrate targets, keyed by bits per pixel ("0.2") */
  intraAt?: Record<string, { bytesPerFrame: number; encodeMsPerFrame: number; ratio: number }>;
  /** the intra size at constant quantizers, keyed by the quantizer ("22"), or { unsupported: true } when the encoder has no quantizer mode */
  intraQuantizer?: (Record<string, { bytesPerFrame: number; encodeMsPerFrame: number; ratio: number }> & { /** the encoder that offered the mode (H.264 hardware, H.264 software, VP9 hardware, VP9 software, in that order) */ codec: string; /** no hardware encoder had the mode; these are a software encoder's figures */ software?: true }) | { unsupported: true };
}
export const DEFAULT_PROFILE: HardwareProfile;
export const KNOWN_PROFILES: HardwareProfile[];
/** The slowest device the bridge is sized for; assumed until measured. */
export type FloorProfile = HardwareProfile & { decodeFpsAtPixels: number; decoderRestartMs: number; marginMs: number };
export const HARDWARE_FLOOR: FloorProfile;
/** A floor made from a measured profile: the measured decode rate and re-target time with the baseline's margin (what optimize() installs). */
export function floorFromProfile(profile: HardwareProfile, base: FloorProfile): FloorProfile;
export function knownProfile(labelPart: string): HardwareProfile | null;
/** Optional and never run by the player: measure this device with a clip (nothing is drawn). Run it when nothing is playing. */
export function probeDevice(clip: Clip, opts?: { maxDecoders?: number; frames?: number; encode?: boolean; cache?: boolean; stepTimeoutMs?: number; onProgress?: (stage: string) => void }): Promise<HardwareProfile>;
/** The profile last measured and stored on this ORIGIN (every page of the site shares it), kept until the browser changes; or null. */
export function storedProfile(opts?: { maxAgeMs?: number }): HardwareProfile | null;
/** Forget the stored profile and what playback learned on it; the next optimize() measures again. */
export function forgetStoredProfile(): void;
export interface Tune { scale: number; observations: number }
export function storedTune(basis: number | 'baseline'): (Tune & { basis: string; ua: string; updatedAt: number }) | null;
export function storeTune(tune: Tune, basis: number | 'baseline'): void;
/** The memory boundaries (page totals of frames held): neither is a cap; the player and the plan say a crash could happen past them. */
export const MEMORY_WARNING: number;
export const MEMORY_CRITICAL: number;
export function memoryLevel(bytes: number): 'ok' | 'warning' | 'critical';
export function coldSeekMs(gop: number, profile: HardwareProfile): number;
export function gopForBudgetMs(budgetMs: number, profile: HardwareProfile): number;
export function bitrateCostForGop(gop: number): string;

export type Action =
  | { kind: 'switch'; clip: Clip; index: number; withinFrames?: number; withinMs?: number; prepared?: boolean }
  | { kind: 'cutover'; clip: Clip; from: number; leadTimeMs: number }
  | { kind: 'loop'; clip: Clip; from: number; to: number }
  | { kind: 'prepare'; count: number; clips?: Clip[] };
export interface Remedy { kind: 're-encode' | 'prepare' | 'nearest-keyframe' | 'longer-loop' | 'fewer' | 'cold-start' | 'lower-resolution'; note: string; gop?: number; worstCaseMs?: number; bitrateCost?: string; index?: number; frames?: number; bytes?: number; count?: number }
export interface Verdict { ok: boolean; kind: string; costMs: number; budgetMs: number | null; notes: string[]; remedies: Remedy[]; decodes?: number; decodersNeeded?: number; leadIn?: number; periodMs?: number; residentFrameBytes?: number; memoryLevel?: 'ok' | 'warning' | 'critical'; bridgeFrames?: number; bridgeBytes?: number; bridgeFramesPerTarget?: number | null }
export function canDo(action: Action, ctx?: { profile?: Partial<HardwareProfile>; device?: Partial<HardwareProfile>; player?: { lookahead?: number } }): Verdict;

/** The optimization suite: what you intend, checked against one profile, a list, or the known group. */
export interface PlanSpec { width?: number; height?: number; fps?: number; gop?: number; reorderDepth?: number; frames?: number; bytesResident?: boolean; prepared?: number; switchWithinFrames?: number; cutoverLeadFrames?: number; loop?: { lengthFrames: number; leadInFrames?: number }; lookahead?: number }
export interface PlanProfileReport { label: string; ok: boolean; limits: string[]; /** past the warning boundary, still ok */ warnings: string[]; remedies: Remedy[]; facts: Record<string, any> & { residentFrameBytes?: number; memoryLevel?: 'ok' | 'warning' | 'critical'; bridgeFrames?: number; bridgeBytes?: number } }
export interface PlanReport { plan: PlanSpec; ok: boolean; profiles: PlanProfileReport[]; summary: string[] }
export function plan(spec: PlanSpec, profiles?: HardwareProfile | HardwareProfile[]): PlanReport;
export function syntheticClip(spec: PlanSpec): any;

export function probeSupport(): Promise<{ secureContext: boolean; videoDecoder: boolean; audioDecoder: boolean; videoEncoder: boolean; h264: boolean; hevc: boolean; vp9: boolean; av1: boolean; audio: boolean }>;

/** Optional, never run by the player: per-frame size, encode and decode time for the forms a bridge could be held in on this device. */
export function probeBridgeCompression(clip: Clip, opts?: { frames?: number; from?: number; quality?: number; intra?: boolean; /** bitrate targets for the intra run; the first is the one decoded and timed, the rest sized only (default [0.6, 0.2]) */ bitsPerPixel?: number[]; /** constant quantizers to size (default [22, 30] for H.264, [20, 36] for VP9), through the first encoder that offers the mode */ quantizers?: number[]; webp?: boolean; onProgress?: (stage: string) => void }): Promise<BridgeFigures & { kind: 'BridgeCompressionProbe'; version: 1; clip: string; size: string; format: string; frames: number; quality: number; measuredAt: number; ua: string; raw: { bytesPerFrame: number; copyOutMs: number; rebuildMs: number } }>;
