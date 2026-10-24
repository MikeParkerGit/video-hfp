// The budget model — canDo(action) answers yes / yes-but / no-and-here-is-what-would-deliver-it,
// from a HardwareProfile (probe.js, or a known one from profiles.js) and the clip's keyframe map.
// A TOOL for the app: the player never consults it. Encoding is advice, never a requirement: the
// player plays the file it is given; when an action would miss its budget on a device with a
// file, this says which re-encode (or other lever) delivers it.

import { bridgeFrames, maxBridgeFrames } from './bridge.js';

/** A conservative phone, for when nothing has been measured. */
export const DEFAULT_PROFILE = { kind: 'HardwareProfile', version: 1, label: 'assumed: a conservative phone (nothing measured)', decodeFps: 300, decoderStartupMs: 30, decoderRestartMs: 30, decoders: 3, encodeFps: null, refreshHz: 60, measuredAt: null };

/**
 * The memory boundaries (ruled 2026-10-22). Neither is a cap: a page may hold more, and on a phone the
 * operating system's memory killer decides when it is too much — the foreground app last of all, and
 * not gracefully. At the warning boundary the player and the plan say a crash could happen; at the
 * critical one they say it loudly. They are page totals: the frames held by bridges and decoders.
 */
export const MEMORY_WARNING = 500 << 20;
export const MEMORY_CRITICAL = 1024 << 20;
/** 'ok' | 'warning' | 'critical' for a page holding this many bytes of frames. */
export function memoryLevel(bytes) { return bytes >= MEMORY_CRITICAL ? 'critical' : bytes >= MEMORY_WARNING ? 'warning' : 'ok'; }
const mb = (b) => Math.round(b / 1048576);

/** The measured bitrate cost of a GOP relative to streaming defaults (real 720p footage, B-frames kept). */
export function bitrateCostForGop(gop) {
  if (gop >= 250) return '+0%';
  if (gop >= 48) return '+10%';
  if (gop >= 24) return '+20%';
  if (gop >= 12) return '+38%';
  if (gop >= 6) return '+75%';
  return '+260%';   // all-intra, measured
}
/** Worst-case cold seek (ms) into a clip with this GOP on this device. */
export function coldSeekMs(gop, device) { return device.decoderStartupMs + (gop - 1) * 1000 / device.decodeFps; }
/** The GOP a seek budget allows on this device. */
export function gopForBudgetMs(budgetMs, device) { return Math.max(1, Math.floor((budgetMs - device.decoderStartupMs) / 1000 * device.decodeFps) + 1); }

const frameBytes = (clip) => Math.round(clip.width * clip.height * 1.5);

/**
 * @param {object} action
 *   { kind: 'switch', clip, index, withinFrames?, withinMs?, prepared? }    show clip's frame `index` within a budget
 *   { kind: 'cutover', clip, from, leadTimeMs }                              a known cutover into clip at `from`, known this far ahead
 *   { kind: 'loop', clip, from, to }                                         loop [from, to)
 *   { kind: 'prepare', count, clips? }                                       park this many decoders
 * @param {{ profile?: object, device?: object, player?: { lookahead?: number } }} ctx   profile: a HardwareProfile (device: the same, older name)
 */
export function canDo(action, { device = DEFAULT_PROFILE, profile, player } = {}) {
  const dev = { ...DEFAULT_PROFILE, ...(profile || device) };
  const lookahead = player?.lookahead ?? 6;
  const frameMs = (clip) => clip.frameDuration * 1000;
  const out = { ok: true, kind: action.kind, costMs: 0, budgetMs: null, notes: [], remedies: [] };
  const no = (why) => { out.ok = false; out.notes.push(why); };

  switch (action.kind) {
    case 'switch': case 'cutover': {
      const { clip } = action;
      const index = action.kind === 'cutover' ? action.from : action.index;
      const budget = action.kind === 'cutover' ? action.leadTimeMs : (action.withinMs ?? (action.withinFrames ?? 3) * frameMs(clip));
      out.budgetMs = budget;
      const decodes = index - clip.keyframeAtOrBefore(index) + 1;
      const resident = clip.hasDecodeRange(clip.decodeIndexOf(clip.keyframeAtOrBefore(index)), clip.decodeIndexOf(index));
      const cold = dev.decoderStartupMs + (decodes - 1) * 1000 / dev.decodeFps;
      out.costMs = action.prepared ? frameMs(clip) : cold;
      out.decodes = decodes;
      if (!resident) out.notes.push('the bytes for that frame are not loaded yet; add the fetch time, or pin the range ahead of time');
      if (action.prepared) { out.notes.push('prepared: the next display frame (the bridge plays while the decoder re-targets behind it)'); break; }
      if (cold <= budget) { if (decodes > 1) out.notes.push(`cold start: ${decodes} decodes ≈ ${Math.round(cold)} ms`); else out.notes.push(`a keyframe: start-up only ≈ ${Math.round(cold)} ms`); break; }
      no(`cold start to frame ${index} costs ${decodes} decodes ≈ ${Math.round(cold)} ms on this device, over the ${Math.round(budget)} ms budget`);
      const bf = bridgeFrames(clip, index), bridgeMB = Math.round(bf * frameBytes(clip) / 1048576 * 10) / 10;
      const prepareNote = `prepare the target ahead of time (a bridge of ${bf} raw frames, ${bridgeMB} MB): the cut then lands on the next display frame`;
      if (dev.decoderStartupMs >= budget) {
        // no encoding can beat the decoder's own start-up: only a bridge can
        out.notes.push(`this device's decoder start-up alone is ${Math.round(dev.decoderStartupMs)} ms, so no re-encode can meet ${Math.round(budget)} ms; only a prepared target can`);
        out.remedies.push({ kind: 'prepare', note: prepareNote, frames: bf, bytes: bf * frameBytes(clip) });
        break;
      }
      const gop = gopForBudgetMs(budget, dev);
      if (gop >= 1 && coldSeekMs(gop, dev) <= budget) out.remedies.push({ kind: 're-encode', gop, worstCaseMs: Math.round(coldSeekMs(gop, dev)), bitrateCost: bitrateCostForGop(gop), note: `pack with --gop ${gop} (or --seek-budget ${Math.round(budget)}): any frame costs ≤ ${Math.round(coldSeekMs(gop, dev))} ms, bitrate ${bitrateCostForGop(gop)} vs streaming defaults` });
      out.remedies.push({ kind: 'prepare', note: prepareNote, frames: bf, bytes: bf * frameBytes(clip) });
      if (clip.gop > 1) out.remedies.push({ kind: 'nearest-keyframe', index: clip.keyframeAtOrBefore(index), note: `start at the keyframe before (frame ${clip.keyframeAtOrBefore(index)}) and it is start-up only ≈ ${Math.round(dev.decoderStartupMs)} ms` });
      break;
    }
    case 'loop': {
      const { clip, from, to } = action;
      const len = to - from;
      const leadIn = from - clip.keyframeAtOrBefore(from);
      const period = clip.rangeEnd(to) - clip.frameTime(from);
      const perPassS = (leadIn + len) / dev.decodeFps;   // every pass the one decoder decodes the lead-in and the loop
      out.costMs = Math.round(leadIn / dev.decodeFps * 1000); out.leadIn = leadIn; out.periodMs = Math.round(period * 1000); out.decodersNeeded = 1;
      if (leadIn <= lookahead) { out.notes.push(`lead-in of ${leadIn} frames fits the lookahead: one decoder, no bridge`); break; }
      const bf = Math.min(bridgeFrames(clip, from), len);
      out.bridgeFrames = bf; out.bridgeBytes = bf * frameBytes(clip);
      if (perPassS <= period) { out.notes.push(`lead-in of ${leadIn} frames ≈ ${Math.round(leadIn / dev.decodeFps * 1000)} ms: the wrap is covered by a bridge of ${bf} raw frames (${Math.round(out.bridgeBytes / 1048576 * 10) / 10} MB); one decoder`); break; }
      no(`the lead-in (${leadIn} frames) plus the loop (${len} frames) is more decoding than the loop's ${Math.round(period * 1000)} ms allows at ${dev.decodeFps} fps: the decoder falls behind on every pass`);
      const gop = Math.max(1, Math.floor(Math.max(1, period * dev.decodeFps - len)));
      out.remedies.push({ kind: 're-encode', gop, bitrateCost: bitrateCostForGop(gop), note: `pack the clip (or this window) with --gop ${gop}: the lead-in then fits the pass` });
      out.remedies.push({ kind: 'longer-loop', note: `a loop longer than ${Math.round(perPassS * 1000)} ms would give the decoder time for its lead-in` });
      break;
    }
    case 'prepare': {
      // a prepared target is a BRIDGE: raw frames, no decoder. The cost is memory, sized from the worst frame of each clip (the longest decode run).
      const count = action.count ?? 1;
      const clips = action.clips?.length ? action.clips : [];
      const perTarget = clips.length ? Math.max(...clips.map((c) => maxBridgeFrames(c) * frameBytes(c))) : 0;
      const bytes = count * perTarget;
      out.bridgeBytes = bytes; out.bridgeFramesPerTarget = clips.length ? Math.max(...clips.map((c) => maxBridgeFrames(c))) : null;
      if (!clips.length) { out.notes.push(`${count} prepared targets hold raw frames and no decoder; pass the clips to size them`); break; }
      const level = memoryLevel(bytes);
      out.memoryLevel = level;
      if (level === 'ok') { out.notes.push(`${count} prepared targets ≈ ${mb(bytes)} MB of raw frames (${out.bridgeFramesPerTarget} frames each at the worst frame), under the ${mb(MEMORY_WARNING)} MB warning boundary`); break; }
      if (level === 'warning') { out.notes.push(`WARNING: ${count} prepared targets ≈ ${mb(bytes)} MB of raw frames (${out.bridgeFramesPerTarget} frames each), past the ${mb(MEMORY_WARNING)} MB boundary — a page this size can be killed on a phone`); }
      else no(`CRITICAL: ${count} prepared targets ≈ ${mb(bytes)} MB of raw frames (${out.bridgeFramesPerTarget} frames each), past the ${mb(MEMORY_CRITICAL)} MB boundary — expect the page to be killed on a phone`);
      const fit = Math.floor(MEMORY_WARNING / perTarget);
      out.remedies.push({ kind: 'fewer', count: fit, note: `${fit} prepared targets stay under the warning boundary; prepare the most likely and cut the rest cold` });
      const c0 = clips[0];
      if (c0.gop > 2) { const gop = Math.max(1, Math.floor(c0.gop / 4)); out.remedies.push({ kind: 're-encode', gop, bitrateCost: bitrateCostForGop(gop), note: `pack with --gop ${gop}: a shorter decode run makes every bridge shorter (${maxBridgeFrames({ ...c0, gop, keyframeAtOrBefore: (p) => Math.floor(p / gop) * gop })} frames instead of ${out.bridgeFramesPerTarget})` }); }
      out.remedies.push({ kind: 'lower-resolution', note: `at ${c0.width}x${c0.height} a raw frame is ${Math.round(frameBytes(c0) / 1024)} KB; a lower-resolution encode for the targets brings every bridge down` });
      break;
    }
    default: throw new Error(`canDo: unknown action ${action.kind}`);
  }
  // memory: resident decoded frames across the decoders this needs, plus a loop's wrap bridge
  if (action.clip) {
    const sources = out.decodersNeeded ?? 1;
    const bytes = sources * (lookahead + action.clip.reorderDepth) * frameBytes(action.clip) + (action.kind === 'loop' ? out.bridgeBytes ?? 0 : 0);
    out.residentFrameBytes = bytes; out.memoryLevel = memoryLevel(bytes);
    if (out.memoryLevel === 'critical') { no(`CRITICAL: this alone holds ${mb(bytes)} MB of frames, past the ${mb(MEMORY_CRITICAL)} MB boundary`); out.remedies.push({ kind: 'lower-resolution', note: 'play a lower-resolution encode, or a shorter GOP for a shorter bridge' }); }
    else if (out.memoryLevel === 'warning') out.notes.push(`WARNING: this alone holds ${mb(bytes)} MB of frames, past the ${mb(MEMORY_WARNING)} MB boundary`);
  }
  return out;
}
