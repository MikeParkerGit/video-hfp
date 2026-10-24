// node test/smoke.mjs  — no browser needed. Needs demo/clips (run `npm run clips` first).
//
// 1. The demuxers agree with ffprobe on every demo clip: frame count, keyframes, decode-order
//    timestamps, sample offsets and sizes, the audio track.
// 2. FrameSource against a mock decoder that REORDERS like a real one (B-frames): decode-order
//    feeding delivers presentation order from a mid-GOP start, loop wraps are seamless with a
//    continuous presentation number, dropBefore/reseek, and a range end flushes once.
// 3. The budget model reproduces the worked example with a fixed device.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { demuxMp4 } from '../src/demux/mp4.js';
import { demuxWebm } from '../src/demux/webm.js';
import { BufferSource } from '../src/loader.js';
import { Clip } from '../src/clip.js';
import { FrameSource } from '../src/frame-source.js';
import { canDo } from '../src/budget.js';
import { plan } from '../src/plan.js';
import { KNOWN_PROFILES, knownProfile, HARDWARE_FLOOR } from '../src/profiles.js';
import { bridgeFrames, maxBridgeFrames, adjustBridge, MIN_BRIDGE_FRAMES } from '../src/bridge.js';
import { syntheticClip } from '../src/plan.js';

const clips = ['demo/clips/A.mp4', 'demo/clips/B.mp4', 'demo/clips/A-normal.mp4', 'demo/clips/A-vp9.webm', 'demo/clips/A-rot.mp4'].filter(existsSync);
assert.ok(clips.length >= 3, 'run `npm run clips` first');
const probe = (f, stream, what) => JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-select_streams', stream, `-show_${what}`, '-of', 'json', f], { maxBuffer: 1 << 26 }).stdout);
const open = async (f) => { const b = new Uint8Array(readFileSync(f)); const s = new BufferSource(b); const idx = f.endsWith('.webm') ? await demuxWebm(s) : await demuxMp4(s); return new Clip(idx, s, { name: f }); };

// ---- 1. demuxers vs ffprobe --------------------------------------------------------------
for (const f of clips) {
  const clip = await open(f);
  const vp = probe(f, 'v:0', 'packets').packets, ap = probe(f, 'a:0', 'packets').packets;
  assert.equal(clip.frameCount, vp.length, `${f}: frame count`);
  const hdr = f.endsWith('.webm') ? 4 : 0;
  for (let d = 0; d < clip.frameCount; d++) {
    const p = vp[d], s = clip.samples[d];
    assert.ok(Math.abs(Number(p.pts_time ?? p.dts_time) - s.pts) < 2e-3, `${f}: pts of decode index ${d}`);
    assert.equal(Number(p.pos) + hdr, s.offset, `${f}: offset of ${d}`);
    assert.equal(Number(p.size), s.size, `${f}: size of ${d}`);
    assert.equal((p.flags || '').startsWith('K'), s.key, `${f}: keyframe flag of ${d}`);
  }
  assert.ok(clip.audio, `${f}: audio track`); assert.equal(clip.audio.samples.length, ap.length, `${f}: audio packets`);
  for (let p = 1; p < clip.frameCount; p++) assert.ok(clip.frameTime(p) > clip.frameTime(p - 1), `${f}: frame times increase`);
  console.log(`✓ ${f}: ${clip.codec} ${clip.frameCount}f @${clip.fps} gop ${clip.gop} reorder ${clip.reorderDepth} audio ${clip.audio.codec} — matches ffprobe`);
}

// ---- 2. FrameSource with a reordering mock decoder ----------------------------------------
const clip = await open(clips.find((f) => f.includes('normal')) ?? clips[0]);
class MockChunk { constructor(init) { Object.assign(this, init); } }
class MockDecoder {
  constructor({ output }) { this.output = output; this.state = 'unconfigured'; this.decodeQueueSize = 0; this.needKey = true; this.buf = []; this.log = []; this.depth = Math.max(1, clip.reorderDepth); }
  configure() { this.state = 'configured'; this.needKey = true; this.buf = []; this.log.push('configure'); }
  reset() { this.state = 'unconfigured'; this.buf = []; this.log.push('reset'); }
  close() { this.state = 'closed'; }
  decode(chunk) {
    if (this.needKey && chunk.type !== 'key') throw new Error('first chunk after configure/flush must be a keyframe');
    this.needKey = false;
    if (chunk.type === 'key') { for (const c of this.buf.sort((a, b) => a.timestamp - b.timestamp)) this.emit(c); this.buf = []; }
    this.buf.push(chunk); this.buf.sort((a, b) => a.timestamp - b.timestamp);
    while (this.buf.length > this.depth) this.emit(this.buf.shift());
  }
  emit(c) { queueMicrotask(() => this.output({ timestamp: c.timestamp, close() { this.closed = true; }, closed: false, displayWidth: 1, displayHeight: 1 })); }
  flush() { this.log.push('flush'); for (const c of this.buf.sort((a, b) => a.timestamp - b.timestamp)) this.emit(c); this.buf = []; this.needKey = true; return new Promise((r) => setTimeout(r, 0)); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const take = async (src) => { let it = src.shift(); let spins = 0; while (!it && spins++ < 100) { await tick(); it = src.shift(); } assert.ok(it, 'starved'); const out = { index: it.index, p: it.p }; it.frame.close(); return out; };
let dec;
const src = new FrameSource(clip, { lookahead: 4, VideoDecoder: class extends MockDecoder { constructor(a) { super(a); dec = this; } }, EncodedVideoChunk: MockChunk });
src.start({ from: 0, to: clip.frameCount, loop: false, startIndex: 17 });
for (let i = 0; i < 40 && src.queued === 0; i++) await tick();
assert.equal(src.peek().index, 17); assert.equal(src.peek().p, 17);
const seen = []; for (let i = 0; i < 40; i++) seen.push((await take(src)).index);
assert.deepEqual(seen, Array.from({ length: 40 }, (_, i) => 17 + i));
console.log(`✓ decode-order feeding (reorder depth ${clip.reorderDepth}) delivers presentation order from a mid-GOP start`);
src.start({ from: 5, to: 15, loop: true });
const loop = []; for (let i = 0; i < 25; i++) loop.push(await take(src));
assert.deepEqual(loop.map((x) => x.index), [5,6,7,8,9,10,11,12,13,14, 5,6,7,8,9,10,11,12,13,14, 5,6,7,8,9]);
assert.deepEqual(loop.map((x) => x.p), Array.from({ length: 25 }, (_, i) => i));
assert.deepEqual(loop.map((x) => src.indexForP(x.p)), loop.map((x) => x.index));
console.log('✓ loop wrap is seamless and frame-exact, p continuous');
src.start({ from: 0, to: clip.frameCount, loop: false, startIndex: 100 });
for (let i = 0; i < 60 && src.queued < 3; i++) await tick();
assert.equal(src.dropBefore(102), 2); for (let i = 0; i < 10; i++) await tick();
assert.equal(src.peek().p, 102);
src.reseek(150, 150); for (let i = 0; i < 20 && src.queued === 0; i++) await tick();
assert.equal(src.peek().index, 150); assert.equal(src.peek().p, 150);
console.log('✓ dropBefore / reseek');
src.start({ from: clip.frameCount - 7, to: clip.frameCount - 3, loop: false });
const tail = []; for (let i = 0; i < 4; i++) tail.push((await take(src)).index);
assert.deepEqual(tail, [clip.frameCount - 7, clip.frameCount - 6, clip.frameCount - 5, clip.frameCount - 4]);
for (let i = 0; i < 20; i++) await tick();
assert.equal(src.shift(), undefined); assert.ok(src.ended);
assert.equal(dec.log.filter((x) => x === 'flush').length, 1);
src.close();
console.log('✓ range end flushes once and reports ended');

// ---- 3. the budget model ------------------------------------------------------------------
const device = { decodeFps: 500, decoderStartupMs: 6, decoders: 3, encodeFps: 460, refreshHz: 60 };
const strict = await open(clips[0]);
const r1 = canDo({ kind: 'switch', clip: strict, index: 0, withinFrames: 3 }, { device });
assert.ok(r1.ok, 'first frame of a clip is a keyframe: within budget without preparation');
const normal = await open(clips.find((f) => f.includes('normal')) ?? clips[0]);
const r2 = canDo({ kind: 'switch', clip: normal, index: 438, withinFrames: 3 }, { device });
if (normal.gop > 60) { assert.ok(!r2.ok, 'frame 438 of a long-GOP file within 3 frames: over budget'); assert.ok(r2.remedies.some((x) => x.kind === 're-encode'), 'advice names the re-encode'); }
const r3 = canDo({ kind: 'switch', clip: strict, index: 438, withinFrames: 3 }, { device });
assert.ok(r3.ok, 'frame 438 of the GOP-12 file within 3 frames: fine');
console.log(`✓ budget model: first frame ok; frame 438 of a GOP-${normal.gop} file → ${r2.ok ? 'ok' : 'no: ' + r2.remedies.map((x) => x.kind + (x.gop ? ' gop ' + x.gop : '')).join(', ')}; GOP-12 → ok`);

// ---- 3b. rotation: a phone's portrait recording is stored sideways with a display matrix ----------
{
  const plain = await open(clips[0]);
  assert.equal(plain.rotation, 0, 'A has no rotation'); assert.equal(plain.displayWidth, plain.width, 'upright size = coded size');
  const rot = clips.find((f) => f.endsWith('A-rot.mp4'));
  if (rot) {
    const r = await open(rot);
    assert.equal(r.rotation, 90, 'A-rot (ffmpeg -display_rotation -90, as a phone stores portrait) → 90° clockwise for display');
    assert.deepEqual([r.width, r.height, r.displayWidth, r.displayHeight], [1280, 720, 720, 1280], 'coded 1280×720, upright 720×1280');
    assert.equal(r.describe().rotation, 90, 'describe() reports it');
    console.log('✓ rotation: A-rot.mp4 → 90° clockwise, upright 720×1280; A → 0');
  } else console.log('· rotation: no A-rot.mp4 (ffmpeg without -display_rotation); skipped');
}

// ---- 4. the bridge formula: per target, solved against the hand-off frame, from the clip's index and the floor --
{
  const hd = (gop) => syntheticClip({ width: 1920, height: 1080, fps: 30, gop });
  assert.equal(bridgeFrames(hd(12), 12), 12, 'a keyframe target: the restart and the margin alone (12 frames at 30 fps on the floor)');
  assert.equal(bridgeFrames(hd(12), 11), 13, 'GOP 12, frame 11: the next keyframe lands at the hand-off, so 13');
  assert.equal(bridgeFrames(hd(250), 249), 15, 'GOP 250, its last frame: the keyframe inside the bridge makes it short');
  assert.equal(bridgeFrames(hd(250), 187), 62, 'GOP 250, frame 187: the hand-off is the last frame of the GOP — the long run');
  assert.deepEqual([maxBridgeFrames(hd(12)), maxBridgeFrames(hd(30)), maxBridgeFrames(hd(250))], [15, 18, 62], 'the worst frame of a GOP: 15 / 18 / 62 at 1080p on the floor');
  assert.ok(maxBridgeFrames(syntheticClip({ width: 1280, height: 720, fps: 30, gop: 250 })) < 62, 'at 720p the floor decodes faster, so bridges are shorter');
  assert.equal(bridgeFrames(hd(12), 11, { ...HARDWARE_FLOOR, decoderRestartMs: 0, marginMs: 0, decodeFps: 1e9 }), MIN_BRIDGE_FRAMES, 'an instant floor: still the minimum of 5');
  // what a hand-off teaches (ruled): late by k → n + k + 2; under three quarters used → used + 10 % (min 2), never under 5; otherwise nothing
  assert.deepEqual([adjustBridge(6, { late: 2 }), adjustBridge(20, { used: 10 }), adjustBridge(20, { used: 16 }), adjustBridge(6, { used: 1 }), adjustBridge(8, { used: 4 }), adjustBridge(5, { used: 1 }), adjustBridge(33, { used: 0 })], [10, 12, null, 5, 6, null, 5], 'the adjustment rule');
  const real = await open(clips[0]);
  const bf = bridgeFrames(real, 438);
  assert.ok(bf >= 1 && bf <= real.frameCount - 438, 'a real clip: within the frames it has left');
  console.log(`✓ bridge: worst frames of GOP 12/30/250 → 15/18/62 at 1080p on the floor; GOP 250's last frame → 15; ${clips[0]} at 438 → ${bf} frames (${(bf * real.width * real.height * 1.5 / 1048576).toFixed(1)} MB raw)`);
  // a loop: one decoder always; a bridge when the lead-in is longer than the lookahead
  const normalClip = await open(clips.find((f) => f.includes('normal')) ?? clips[0]);
  const l1 = canDo({ kind: 'loop', clip: normalClip, from: 200, to: 260 }, { device: { decodeFps: 500, decoderStartupMs: 6, decoders: 1, refreshHz: 60 } });
  assert.equal(l1.decodersNeeded, 1, 'a loop needs one decoder');
  if (normalClip.gop > 60) assert.ok(l1.ok && l1.bridgeFrames > 0 && l1.residentFrameBytes > l1.bridgeBytes, 'a long lead-in: ok with a wrap bridge, counted in memory');
  const l2 = canDo({ kind: 'loop', clip: normalClip, from: 200, to: 205 }, { device: { decodeFps: 300, decoderStartupMs: 6, decoders: 1, refreshHz: 60 } });
  if (normalClip.gop > 60) assert.ok(!l2.ok && l2.remedies.some((m) => m.kind === 're-encode'), 'a loop shorter than its lead-in decodes: no, with the re-encode');
  console.log(`✓ loop: [200, 260) on the GOP-${normalClip.gop} file → one decoder${l1.bridgeFrames ? ` + a ${l1.bridgeFrames}-frame bridge` : ''}; [200, 205) → ${l2.ok ? 'ok' : 'no: ' + l2.remedies.map((m) => m.kind).join(', ')}`);
}

// ---- 5. the plan suite against the known profiles ------------------------------------------
const phone = knownProfile('Android');
assert.ok(phone, 'the record holds the Android profile');
const p1 = plan({ width: 1280, height: 720, fps: 30, gop: 12, prepared: 6, switchWithinFrames: 1 });
assert.equal(p1.profiles.length, KNOWN_PROFILES.length);
const phoneReport = p1.profiles.find((p) => p.label.includes('Android'));
assert.ok(!phoneReport.ok && phoneReport.limits.some((l) => l.startsWith('coldSwitch')), 'a one-frame cold switch misses on the phone');
assert.ok(!phoneReport.limits.some((l) => l.startsWith('prepared')), 'six 720p bridges fit the phone\'s memory');
assert.ok(p1.profiles.filter((p) => p.label.includes('Mac')).every((p) => p.ok), 'the same plan fits the Mac profiles');
const p2 = plan({ width: 1280, height: 720, fps: 30, gop: 12, prepared: 2, cutoverLeadFrames: 30 }, phone);
assert.ok(p2.ok, 'two prepared and a cutover known a second ahead fit the phone');
// the memory boundaries (ruled 2026-10-22): 500 MB warns, 1 GB is critical; neither is a cap, both are page totals
const p3 = plan({ width: 1920, height: 1080, fps: 30, gop: 12, prepared: 40 }, phone);
assert.ok(!p3.ok && p3.profiles[0].facts.memoryLevel === 'critical' && p3.profiles[0].limits.some((l) => /CRITICAL/.test(l)), 'forty 1080p bridges (≈1.8 GB) are past the critical boundary');
assert.ok(p3.profiles[0].remedies.some((m) => m.kind === 'fewer') && p3.profiles[0].remedies.some((m) => m.kind === 'lower-resolution'), 'the remedies: fewer targets, a lower resolution');
const p4 = plan({ width: 1280, height: 720, fps: 30, gop: 12, prepared: 30 }, phone);
assert.ok(p4.ok && p4.profiles[0].facts.memoryLevel === 'warning' && p4.profiles[0].warnings.length === 1 && p4.summary.some((l) => /WARNING/.test(l)), 'thirty 720p bridges (≈590 MB): ok with a warning');
const p5 = plan({ width: 1280, height: 720, fps: 30, gop: 12, prepared: 20 }, phone);
assert.ok(p5.ok && p5.profiles[0].facts.memoryLevel === 'ok' && p5.profiles[0].warnings.length === 0, 'twenty 720p bridges (≈400 MB): under the warning boundary');
console.log(`✓ plan: 6 prepared + 1-frame cold switch → phone limits: ${phoneReport.limits.map((l) => l.split(':')[0]).join(', ')}; 2 prepared + a cutover 30 frames ahead → fits; memory: 40 × 1080p → critical (${Math.round(p3.profiles[0].facts.residentFrameBytes / 1048576)} MB), 30 × 720p → warning (${Math.round(p4.profiles[0].facts.residentFrameBytes / 1048576)} MB), 20 × 720p → ok (${Math.round(p5.profiles[0].facts.residentFrameBytes / 1048576)} MB)`);
console.log('all good');
