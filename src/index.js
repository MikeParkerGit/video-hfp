// video-hfp — the core, side-effect free. `video-hfp/element` defines <video-hfp>.
export { Player } from './player.js';
export { Clip, loadClip, WHOLE_FILE_LIMIT } from './clip.js';
export { FrameSource } from './frame-source.js';
export { AudioEngine } from './audio.js';
export { WorkerSource, DecodePool } from './worker-source.js';
export { BufferSource, RangeSource, probeUrl } from './loader.js';
export { demuxMp4, parseMoov } from './demux/mp4.js';
export { demuxWebm } from './demux/webm.js';
export { probeDevice, storedProfile, forgetStoredProfile, floorFromProfile } from './probe.js';
export { canDo, DEFAULT_PROFILE, coldSeekMs, gopForBudgetMs, bitrateCostForGop, MEMORY_WARNING, MEMORY_CRITICAL, memoryLevel } from './budget.js';
export { KNOWN_PROFILES, HARDWARE_FLOOR, knownProfile } from './profiles.js';
export { plan, syntheticClip } from './plan.js';
export { probeBridgeCompression } from './bridge-probe.js';
export { Bridge, BridgeSource, buildBridge, bridgeFrames, maxBridgeFrames, adjustBridge, MIN_BRIDGE_FRAMES } from './bridge.js';

/** Quick capability check for the current browser/webview. */
export async function probeSupport() {
  // secureContext: WebCodecs and AudioContext only exist in one (https, localhost, or an app's own
  // scheme) — a LAN IP over plain http is not one, and that is the usual reason videoDecoder is false.
  const out = {
    secureContext: globalThis.isSecureContext === true,
    videoDecoder: typeof VideoDecoder !== 'undefined',
    audioDecoder: typeof AudioDecoder !== 'undefined',
    videoEncoder: typeof VideoEncoder !== 'undefined',
    h264: false, hevc: false, vp9: false, av1: false,
    audio: typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined',
  };
  if (!out.videoDecoder) return out;
  // description is required for avc1 on Safari; this is a real avcC (Main 3.1, 1280x720)
  const avcC = new Uint8Array([1,77,64,31,255,225,0,25,103,77,64,31,217,0,80,5,187,1,16,0,0,3,0,16,0,0,3,3,192,241,131,36,128,1,0,5,104,235,192,140,178]);
  const ask = async (cfg) => { try { return !!(await VideoDecoder.isConfigSupported(cfg)).supported; } catch { return false; } };
  out.h264 = await ask({ codec: 'avc1.4d401f', description: avcC });
  out.hevc = await ask({ codec: 'hvc1.1.6.L93.B0' });
  out.vp9 = await ask({ codec: 'vp09.00.31.08' });
  out.av1 = await ask({ codec: 'av01.0.04M.08' });
  return out;
}
