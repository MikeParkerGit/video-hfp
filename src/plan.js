// plan() — the optimization suite. OPTIONAL, never run by the player. You say what you intend
// (resolution, frame rate, GOP, how many targets prepared at once, how fast a cold switch must
// land, the loops you want, how far ahead a cutover is known) and it says, per hardware profile,
// which limits that plan hits and what would lift them. It composes the budget model (budget.js)
// over a synthetic clip with the plan's structure; the answers are advice for the designer, and
// the player stays fully capable regardless of what is said here.

import { canDo, DEFAULT_PROFILE, coldSeekMs, memoryLevel, MEMORY_WARNING, MEMORY_CRITICAL } from './budget.js';
import { KNOWN_PROFILES } from './profiles.js';
import { maxBridgeFrames } from './bridge.js';

/** A clip-shaped object with the plan's structure: keyframes every `gop`, constant frame rate. */
export function syntheticClip({ width = 1280, height = 720, fps = 30, gop = 250, reorderDepth = 2, frames = 10 * 60 * 30, bytesResident = true } = {}) {
  const frameDuration = 1 / fps;
  return {
    width, height, fps, frameDuration, gop, reorderDepth, frameCount: frames, synthetic: true,
    keyframeAtOrBefore: (p) => Math.floor(p / gop) * gop,
    isKeyframe: (p) => p % gop === 0,
    frameTime: (p) => p * frameDuration,
    rangeEnd: (to) => to * frameDuration,
    decodeIndexOf: (p) => p,
    hasDecodeRange: () => bytesResident,
  };
}

/**
 * @param {object} plan
 *   width, height, fps, gop, reorderDepth, bytesResident — the files
 *   prepared: how many targets are held prepared at once (default 0)
 *   switchWithinFrames: a cold (unprepared) switch must show within this many frames (default: none asked)
 *   cutoverLeadFrames: a cutover is known this many frames ahead (default: none asked)
 *   loop: { lengthFrames, leadInFrames } — a loop of this length whose start is this far past a keyframe (default: none)
 *   lookahead: the player's lookahead (default 6)
 * @param {object[]|object} profiles  one profile, a list, or omitted for the known group
 */
export function plan(planSpec, profiles = KNOWN_PROFILES) {
  const list = Array.isArray(profiles) ? profiles : [profiles];
  const clip = syntheticClip(planSpec);
  const lookahead = planSpec.lookahead ?? 6;
  const out = { plan: planSpec, profiles: [], summary: [] };
  for (const profile of list) {
    const prof = { ...DEFAULT_PROFILE, ...profile };
    const r = { label: prof.label, ok: true, limits: [], warnings: [], remedies: [], facts: {} };
    const take = (name, v) => { r.facts[name] = v; if (!v.ok) { r.ok = false; r.limits.push(`${name}: ${v.notes.filter(Boolean).join('; ')}`); for (const m of v.remedies) if (!r.remedies.some((x) => x.note === m.note)) r.remedies.push(m); } };
    r.facts.coldSeekWorstMs = Math.round(coldSeekMs(clip.gop, prof));
    if (planSpec.prepared) take('prepared', canDo({ kind: 'prepare', count: planSpec.prepared, clips: [clip] }, { profile: prof, player: { lookahead } }));
    if (planSpec.switchWithinFrames) take('coldSwitch', canDo({ kind: 'switch', clip, index: clip.gop - 1, withinFrames: planSpec.switchWithinFrames }, { profile: prof, player: { lookahead } }));
    if (planSpec.cutoverLeadFrames) take('cutover', canDo({ kind: 'cutover', clip, from: clip.gop - 1, leadTimeMs: planSpec.cutoverLeadFrames * clip.frameDuration * 1000 }, { profile: prof, player: { lookahead } }));
    if (planSpec.loop) { const from = clip.gop + (planSpec.loop.leadInFrames ?? Math.min(clip.gop - 1, 30)); take('loop', canDo({ kind: 'loop', clip, from, to: from + planSpec.loop.lengthFrames }, { profile: prof, player: { lookahead } })); }
    // memory across everything held at once: the decoders' lookaheads plus the prepared bridges (raw frames)
    const frameBytes = Math.round(clip.width * clip.height * 1.5);
    const sources = 1;
    const bridge = maxBridgeFrames(clip);
    const bridges = (planSpec.prepared ?? 0) * bridge * frameBytes + (r.facts.loop?.bridgeBytes ?? 0);
    const resident = sources * (lookahead + clip.reorderDepth) * frameBytes + bridges;
    r.facts.residentFrameBytes = resident; r.facts.bridgeFrames = bridge; r.facts.bridgeBytes = bridges; r.facts.memoryLevel = memoryLevel(resident);
    // the boundaries are page totals, the same on every profile; the plan only says where this plan stands against them
    const what = `${Math.round(resident / 1048576)} MB of raw frames (one decoder + ${planSpec.prepared ?? 0} bridges of ${bridge} frames${r.facts.loop?.bridgeFrames ? ` + the loop's bridge of ${r.facts.loop.bridgeFrames}` : ''})`;
    if (r.facts.memoryLevel === 'critical') { r.ok = false; r.limits.push(`memory: CRITICAL — ${what}, past the ${Math.round(MEMORY_CRITICAL / 1048576)} MB boundary: expect the page to be killed on a phone`); }
    else if (r.facts.memoryLevel === 'warning') r.warnings.push(`memory: WARNING — ${what}, past the ${Math.round(MEMORY_WARNING / 1048576)} MB boundary: a page this size can be killed on a phone`);
    if (r.facts.memoryLevel !== 'ok' && !r.remedies.some((m) => m.kind === 'lower-resolution')) r.remedies.push({ kind: 'lower-resolution', note: `at ${clip.width}x${clip.height} a raw frame is ${Math.round(frameBytes / 1024)} KB and a bridge ${Math.round(bridge * frameBytes / 1048576)} MB; a lower resolution, fewer targets, or a shorter GOP (a shorter bridge) brings it down` });
    out.profiles.push(r);
  }
  const failing = out.profiles.filter((p) => !p.ok);
  out.ok = failing.length === 0;
  out.summary = failing.length ? failing.map((p) => `${p.label}: ${p.limits.join(' | ')}`) : [`fits every profile checked (${out.profiles.length})`];
  for (const p of out.profiles) for (const w of p.warnings) out.summary.push(`${p.label}: ${w}`);
  return out;
}
