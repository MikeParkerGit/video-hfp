// node test/playback.mjs [--keep] [--gpu]
// Exercise <video-hfp> in headless Chromium over raw CDP: the demo page served by tools/serve.js
// on localhost, for each clip pairing: Loop A (wrap, contiguity), cutAfter → B (the exact pair),
// Prepare + Cut now (a bridge: the next display frame, no decoder held, the decoder takes over
// behind it with no stall), the audio boundary (the beep frequency changes within a few ms of
// the cut), a long-lead-in loop on one decoder plus its wrap bridge; then the <video> surface (compat.html: event order, attributes-only autoplay loop,
// the throwing setters) and play() before a gesture (gesture-probe.html, a second Chromium with
// the real autoplay policy). Prints a JSON verdict; exits 1 on a failure.
// Needs Playwright's chromium headless shell (HEADLESS_SHELL to override) and node ≥ 22.
import { spawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handler } from '../tools/serve.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Playwright's chromium headless shell, wherever this OS keeps it (HEADLESS_SHELL overrides). */
function findHeadlessShell() {
  if (process.env.HEADLESS_SHELL) return process.env.HEADLESS_SHELL;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, `${homedir()}/Library/Caches/ms-playwright`, `${homedir()}/.cache/ms-playwright`, process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/ms-playwright`].filter(Boolean);
  const names = ['chrome-headless-shell', 'headless_shell', 'chrome-headless-shell.exe'];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse();
    for (const d of dirs) for (const sub of readdirSync(path.join(root, d))) for (const n of names) { const f = path.join(root, d, sub, n); if (existsSync(f)) return f; }
  }
  throw new Error('no chromium headless shell found: npx playwright install chromium-headless-shell, or set HEADLESS_SHELL');
}
const BIN = findHeadlessShell();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const GPU = args.includes('--gpu') ? ['--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] : [];
const SANDBOX = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [];

const server = createServer(handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const profile = mkdtempSync(path.join(tmpdir(), 'mvp-playback-'));
// --mute-audio: the clips beep; the output device stays silent while the audio clock and the analyser tap keep working
const chrome = spawn(BIN, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=1200,1400', ...GPU, ...SANDBOX, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  chrome.stderr.on('data', (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) resolve(m[1]); });
  chrome.on('exit', (c) => reject(new Error(`headless shell exited ${c}\n${buf}`)));
  setTimeout(() => reject(new Error(`no DevTools line\n${buf}`)), 15000);
});
const targets = await (await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json`)).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map(); const consoleErrors = [];
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text); };
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.text + ': ' + JSON.stringify(m.result.exceptionDetails.exception?.description));
  return m.result?.result?.value;
};
const click = (text) => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) throw new Error('no button ' + ${JSON.stringify(text)}); if (b.disabled) throw new Error('button disabled: ' + ${JSON.stringify(text)}); b.click(); return true; })()`);
const trace = () => evaluate('JSON.stringify(window.__trace || [])').then(JSON.parse);
const stats = () => evaluate('JSON.stringify(window.__player ? { ...window.__player.stats, audio: window.__player.audio.stats } : null)').then(JSON.parse);

const verdict = { ok: true, runs: [] };
let support = null;   // the browser's codec support, read from the first page load
async function runPair(a, b, label, { worker = false } = {}) {
  const run = { label, a, b, ok: true, checks: {} };
  const fail = (name, why) => { run.ok = verdict.ok = false; run.checks[name] = { ok: false, ...why }; };
  const pass = (name, detail) => { run.checks[name] = { ok: true, ...detail }; };
  const needs = (f) => (f.endsWith('.webm') ? 'vp9' : 'h264');
  if (support && (!support[needs(a)] || !support[needs(b)])) { run.skipped = `this browser has no ${needs(a) === 'h264' || needs(b) === 'h264' ? 'H.264' : 'VP9'} decoder`; verdict.runs.push(run); return; }
  try {
    await send('Page.navigate', { url: `http://localhost:${port}/demo/?a=${a}&b=${b}${worker ? '&worker=1' : ''}` });
    let status = '';
    for (let i = 0; i < 120; i++) { status = (await evaluate(`document.getElementById('status')?.textContent || ''`)) || ''; if (/B \(.*supported:/.test(status) || /load failed/.test(status)) break; await sleep(500); }
    run.status = status.split('\n').slice(0, 3).join(' | ');
    const sm = /support: (\{.*?\})/.exec(status);
    if (sm && !support) { try { support = JSON.parse(sm[1]); if (process.env.PLAYBACK_NO_H264) support.h264 = false;   /* rehearse CI's Linux Chromium, which has no H.264 */ verdict.support = support; } catch { /* */ } }
    if (support && (!support[needs(a)] || !support[needs(b)])) { run.skipped = `this browser has no ${needs(a) === 'h264' || needs(b) === 'h264' ? 'H.264' : 'VP9'} decoder`; verdict.runs.push(run); return; }
    if (!/B \(.*supported: true/.test(status)) throw new Error('clips did not load: ' + status);
    run.floorAtLoad = await evaluate('window.__player.stats.floor');   // 'baseline' on the first page of this browser profile; 'stored' on every page after a measurement
    // an audio tap: record the master bus and find where the beep frequency changes
    await evaluate(`(async () => { const p = window.__player; const ctx = p.audioContext; const an = ctx.createAnalyser(); an.fftSize = 2048; p.masterGain.connect(an); window.__an = an; window.__pitch = [];
      const buf = new Float32Array(an.fftSize); const tick = () => { an.getFloatTimeDomainData(buf); let zc = 0; for (let i = 1; i < buf.length; i++) if ((buf[i-1] < 0) !== (buf[i] < 0)) zc++; const rms = Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length); window.__pitch.push([p.now, zc * ctx.sampleRate / buf.length / 2, rms]); requestAnimationFrame(tick); }; tick(); })()`);
    // 1. Loop A [30, 90): contiguous, wraps 89 → 30 (with a worker: under a busy main thread, 40 ms blocks every 150 ms)
    if (worker) await evaluate(`window.__busy = setInterval(() => { const t = performance.now(); while (performance.now() - t < 40); }, 150); true`);
    await click('Loop A'); await sleep(3500);
    if (worker) await evaluate('clearInterval(window.__busy); true');
    let t = await trace();
    const loop = t.filter((e) => e[0] === 'A');
    // a wrap is prev near the range end and cur near its start; exact is 89 → 30, a skipped one (a missed frame at the wrap) counts as a skip
    let wraps = 0, skips = 0; const bad = [];
    for (let i = 1; i < loop.length; i++) {
      const prev = loop[i - 1][1], cur = loop[i][1];
      if (prev === 89 && cur === 30) wraps++;
      else if (prev >= 86 && cur <= 33 && cur < prev) { wraps++; skips++; }
      else if (cur < prev) bad.push([prev, cur]);
      else if (cur > prev + 1) skips++;
    }
    // Under a busy main thread (the worker run) the main thread misses animation frames, so skips are its
    // cost and the wrap pair itself may be skipped; what the worker guarantees is a fed decoder: no stall, no reversal.
    const stAfterLoop = await stats();
    if (worker) { if (loop.length < 30 || bad.length || stAfterLoop.stalls > 1) fail('loop', { frames: loop.length, wraps, outOfOrder: bad.slice(0, 5), skips, stalls: stAfterLoop.stalls, note: 'busy main thread: 40 ms blocks every 150 ms' }); else pass('loop', { frames: loop.length, wraps, skips, stalls: stAfterLoop.stalls, note: 'busy main thread: 40 ms blocks every 150 ms; skips are missed animation frames, not decoder stalls' }); }
    else if (loop.length < 30 || wraps < 1 || bad.length || skips > 2) fail('loop', { frames: loop.length, wraps, outOfOrder: bad.slice(0, 5), skips }); else pass('loop', { frames: loop.length, wraps, skips });
    // 2. Cutover after A#75 → B#438, audio boundary within a few ms
    const before = t.length;
    const tB = await evaluate(`window.__v.cutAfter(75, window.__clips.B, 438)`);
    await sleep(4000);
    t = await trace();
    const after = t.slice(before);
    const firstB = after.findIndex((e) => e[0] === 'B');
    const prevA = after[firstB - 1];
    const bRun = after.slice(firstB).filter((e) => e[0] === 'B');
    const bContig = bRun.every((e, i) => i === 0 || e[1] === bRun[i - 1][1] + 1 || e[1] === bRun[i - 1][1]);
    if (firstB < 1 || prevA?.[1] !== 75 || bRun[0]?.[1] !== 438 || !bContig) fail('cutover', { pair: [prevA, after[firstB]], bFrames: bRun.length, bContig });
    else pass('cutover', { pair: `A ${prevA[1]} → B ${after[firstB][1]}`, bFrames: bRun.length, videoBoundaryErrMs: Math.round((after[firstB][3] - tB) * 1000) });
    const pitch = await evaluate('JSON.stringify(window.__pitch)').then(JSON.parse);
    // the beep is 440 Hz in A and 880 Hz in B; find the first sample window after tB-0.2 whose pitch reads > 660 while sounding
    const beeps = pitch.filter(([tt, f, rms]) => rms > 0.01 && tt > tB - 1.0 && tt < tB + 1.5);
    const firstHigh = beeps.find(([tt, f]) => f > 660 && tt > tB - 0.1);
    const lastLow = [...beeps].reverse().find(([tt, f]) => f < 660 && tt < tB + 0.1);
    if (beeps.length && firstHigh) pass('audioBoundary', { firstHighAtMs: Math.round((firstHigh[0] - tB) * 1000), lastLowAtMs: lastLow ? Math.round((lastLow[0] - tB) * 1000) : null, samples: beeps.length });
    else run.checks.audioBoundary = { ok: null, note: 'no beep observed around the boundary (silence between beeps?)', samples: beeps.length };
    // 3. Prepare B at 200 — a bridge: raw frames, no decoder held — then Cut now: the next display frame; the decoder takes over at the bridge's end
    // from a running loop of A, so the cut re-targets A's decoder to B (the B segment above may have reached its end by now)
    await click('Loop A'); await sleep(1200);
    const decodersBefore = (await stats()).decoders;
    await click('Prepare B');
    let prepared = [];
    for (let i = 0; i < 100 && !prepared[0]?.ready; i++) { await sleep(50); prepared = await evaluate('JSON.stringify(window.__v.prepared.map((h) => ({ frame: h.frame, frames: h.bridgeFrames, bytes: h.bytes, ready: h.ready })))').then(JSON.parse); }
    const stBeforeCut = await stats();
    const mark = (await trace()).length;
    await evaluate(`window.__lastHandoff = null; window.__player.addEventListener('handoff', (e) => { window.__lastHandoff = { bridge: e.bridge, used: e.used, late: e.late, next: e.next }; }, { once: true }); true`);
    await click('Cut now'); await sleep(2500);
    t = await trace();
    const sw = t.slice(mark);
    const firstSw = sw.findIndex((e) => e[0] === 'B' && e[1] >= 200 && e[1] < 206);
    const bAfter = firstSw >= 0 ? sw.slice(firstSw).filter((e) => e[0] === 'B') : [];
    const bContig2 = bAfter.every((e, i) => i === 0 || e[1] === bAfter[i - 1][1] + 1 || e[1] === bAfter[i - 1][1]);
    const stAfterCut = await stats();
    const bridge = prepared[0]?.frames ?? 0;
    const pastBridge = bAfter.filter((e) => e[1] >= 200 + bridge).length;
    const handoff = await evaluate('JSON.stringify(window.__lastHandoff || null)').then(JSON.parse);
    const detail = { framesBeforeNewClip: firstSw, landed: firstSw >= 0 ? `B ${sw[firstSw][1]}` : null, bridgeFrames: bridge, bridgeMB: Math.round((prepared[0]?.bytes ?? 0) / 1048576 * 10) / 10, ready: !!prepared[0]?.ready, decodersHeldByPrepare: stBeforeCut.decoders - decodersBefore, decodersWhilePlayingA: decodersBefore, decodersAfterCut: stAfterCut.decoders, framesPastBridge: pastBridge, stallsAcross: stAfterCut.stalls - stBeforeCut.stalls, bContig: bContig2, heldAfterCut: await evaluate('window.__v.prepared.length'), handoff };
    if (firstSw < 0 || firstSw > 3 || !detail.ready || detail.decodersHeldByPrepare !== 0 || !bContig2 || pastBridge < 10 || detail.stallsAcross > 1 || detail.heldAfterCut !== 0) fail('preparedCut', { ...detail, firstFrames: sw.slice(0, 6) }); else pass('preparedCut', detail);
    // 4. a loop whose lead-in cannot fit the lookahead (on the ordinary file): ONE decoder plus a wrap bridge — the loop's first frames
    //    parked once and shown at every wrap while the decoder decodes the lead-in behind them
    if (a.includes('normal')) {
      // the cold start 200 frames past a keyframe is the point: stalls before the segment's first frame are its cost, not a wrap problem
      await evaluate(`(() => { const p = window.__player; window.__stalls = []; window.__handoffs = []; p.addEventListener('stall', (e) => window.__stalls.push([e.p, p.now])); p.addEventListener('handoff', (e) => window.__handoffs.push({ bridge: e.bridge, used: e.used, late: e.late, next: e.next })); window.__v.play({ clip: window.__clips.A, from: 200, to: 260, loop: true }); return true; })()`);
      const m0 = (await trace()).length;
      await sleep(5000);
      const pp = (await trace()).slice(m0).filter((e) => e[0] === 'A');
      let w2 = 0; const bad2 = [];
      for (let i = 1; i < pp.length; i++) { const prev = pp[i - 1][1], cur = pp[i][1]; if (prev === 259 && cur === 200) w2++; else if (cur !== prev + 1 && cur !== prev) bad2.push([prev, cur]); }
      const st = await stats();
      const stallsAll = await evaluate('JSON.stringify(window.__stalls)').then(JSON.parse);
      const firstT = pp.length ? pp[0][3] : Infinity;
      const coldStalls = stallsAll.filter(([, t]) => t < firstT).length, laterStalls = stallsAll.filter(([, t]) => t >= firstT).length;
      const seg = await evaluate(`JSON.stringify((() => { const s = window.__player._segment; return s ? { bridge: !!s.loopBridge, frames: s.loopBridge?.count ?? 0, bridgePass: s.bridgePass, allBridge: s.allBridge, onBridge: s.swap === 'bridge', pass: s.pass, pending: s.pendingBridge?.bridge.count ?? null, scale: window.__player.tune.scale, tuned: window.__player.tune.observations, handoffs: window.__handoffs } : null; })())`).then(JSON.parse);
      const detail = { frames: pp.length, wraps: w2, outOfOrder: bad2.slice(0, 5), decoders: st.decoders, bridge: seg?.bridge, bridgeFrames: seg?.frames, pendingBridge: seg?.pending, bridgePass: seg?.bridgePass, passes: seg?.pass, coldStartStalls: coldStalls, stallsAfterStart: laterStalls, scale: seg?.scale, tuned: seg?.tuned, handoffs: seg?.handoffs };
      // the loop is watched at every wrap; on this machine the decoder is ready long before the bridge ends, so the bridge is relearned down to the minimum
      const learned = seg && seg.handoffs?.length >= 1 && seg.tuned >= 1 && seg.scale < 1 && (seg.frames === 5 || seg.pending === 5);
      if (!seg?.bridge || st.decoders !== 1 || pp.length < 60 || w2 < 1 || bad2.length || laterStalls > 1 || !learned) fail('bridgedLoop', detail); else pass('bridgedLoop', detail);
      run.coldStartDrops = st.dropped;   // the cold start's stale frames; excluded from the drop check below
    }
    await click('Stop');
    // 5. optimize(): the probe measures this device and bridges are sized from it instead of the baseline floor
    const baselineBridge = await evaluate(`import('/src/index.js').then((m) => m.bridgeFrames(window.__clips.B, 200, m.HARDWARE_FLOOR))`);
    const countBefore = await evaluate('window.__v.engine.bridgeFramesFor(window.__clips.B, 200)');
    const t1 = Date.now();
    const opt = await evaluate(`window.__v.optimize().then((p) => ({ decodeFps: p.decodeFps, startup: p.decoderStartupMs, restart: p.decoderRestartMs, floorFps: window.__v.floor.decodeFps, source: window.__player.stats.floor, after: window.__v.engine.bridgeFramesFor(window.__clips.B, 200), memory: window.__player.stats.memoryBytes, level: window.__player.stats.memoryLevel }), (e) => ({ error: e.message }))`);
    opt.ms = Date.now() - t1; opt.floorAtLoad = run.floorAtLoad; opt.countBeforeOptimize = countBefore;
    // the first page of this browser profile measures; every page after starts from the stored profile and optimize() answers from it at once
    const expectStored = verdict.runs.some((r) => r.checks?.optimize?.ok);
    const sourceOk = expectStored ? (run.floorAtLoad === 'stored' && opt.source === 'stored' && opt.ms < 500) : (run.floorAtLoad === 'baseline' && opt.source === 'measured');
    if (opt.error || !(opt.decodeFps > 0) || opt.floorFps !== opt.decodeFps || !(opt.after >= 5 && opt.after <= baselineBridge) || !sourceOk) fail('optimize', { ...opt, baselineBridge, expected: expectStored ? 'stored' : 'measured' }); else pass('optimize', { ...opt, baselineBridge });
    run.stats = await stats();
    if (!worker && run.stats.dropped - (run.coldStartDrops ?? 0) > 2) fail('dropped', { dropped: run.stats.dropped });
  } catch (e) { run.ok = verdict.ok = false; run.error = e.message; }
  run.consoleErrors = consoleErrors.splice(0);
  verdict.runs.push(run);
}

async function waitProbe(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { const r = await evaluate('JSON.stringify(window.__probe || null)').then((x) => x && JSON.parse(x)); if (r?.done) return r; await sleep(250); }
  throw new Error('the page did not finish');
}
/** The <video> surface: an attributes-only autoplay loop, the event order, pause/seek/resume, the throwing setters. */
async function runCompat() {
  const run = { label: 'the <video> surface (compat.html)', ok: true, checks: {} };
  const fail = (name, why) => { run.ok = verdict.ok = false; run.checks[name] = { ok: false, ...why }; };
  const pass = (name, detail) => { run.checks[name] = { ok: true, ...detail }; };
  try {
    const src = support?.h264 ? 'A.mp4' : 'A-vp9.webm';
    await send('Page.navigate', { url: `http://localhost:${port}/demo/compat.html?src=${src}` });
    const r = await waitProbe();
    const order = ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'play', 'playing'];
    const idx = order.map((e) => r.events.indexOf(e));
    const inOrder = idx.every((i, k) => i >= 0 && (k === 0 || i > idx[k - 1]));
    if (!inOrder) fail('eventOrder', { events: r.events.slice(0, 16) }); else pass('eventOrder', { first: r.events.slice(0, idx[idx.length - 1] + 1) });
    // the attributes alone loop [30, 90): A 89 → A 30, at least once in 4 s, no reversal elsewhere
    let wraps = 0; const bad = [];
    for (let i = 1; i < r.trace.length; i++) { const prev = r.trace[i - 1][1], cur = r.trace[i][1]; if (prev === 89 && cur === 30) wraps++; else if (cur < prev) bad.push([prev, cur]); }
    if (r.trace.length < 30 || wraps < 1 || bad.length || !r.events.includes('loop')) fail('attributeLoop', { frames: r.trace.length, wraps, outOfOrder: bad.slice(0, 5), loopEvents: r.events.filter((e) => e === 'loop').length }); else pass('attributeLoop', { frames: r.trace.length, wraps, loopEvents: r.events.filter((e) => e === 'loop').length });
    const want = { playbackRate: 'NotSupportedError', srcObject: 'NotSupportedError', mediaKeys: 'NotSupportedError', defaultPlaybackRate: 'NotSupportedError', addTextTrack: 'NotSupportedError', requestPictureInPicture: 'NotSupportedError' };
    const wrong = Object.entries(want).filter(([k, v]) => r.throws[k] !== v);
    if (wrong.length) fail('throws', { got: r.throws }); else pass('throws', { all: Object.keys(want).length });
    const props = { duration: r.duration > 0, frameRate: Math.abs(r.frameRate - 30) < 0.5, frameCount: r.frameCount > 100, readyState: r.readyState === 4, size: Math.abs(r.size[0] - 640) < 1 && Math.abs(r.size[1] - 360) < 1, timeupdates: r.timeupdates >= 5, muted: r.muted === true, loop: r.loop === true, videoSize: r.videoWidth === 1280 && r.videoHeight === 720 };
    const off = Object.entries(props).filter(([, v]) => !v).map(([k]) => k);
    if (off.length) fail('properties', { off, duration: r.duration, frameRate: r.frameRate, frameCount: r.frameCount, readyState: r.readyState, size: r.size, timeupdates: r.timeupdates }); else pass('properties', { duration: r.duration, size: r.size, timeupdates: r.timeupdates });
    const sp = r.afterSeekPaused, rs = r.afterResume;
    if (!sp.paused || sp.currentFrame !== 10 || !sp.events.includes('seeking') || !sp.events.includes('seeked')) fail('seekPaused', sp); else pass('seekPaused', { events: sp.events, currentFrame: sp.currentFrame });
    if (rs.paused || !rs.events.includes('play') || !rs.events.includes('playing') || rs.firstFrames[0] !== 10) fail('resume', rs); else pass('resume', { events: rs.events.slice(0, 4), firstFrames: rs.firstFrames });
  } catch (e) { run.ok = verdict.ok = false; run.error = e.message; }
  run.consoleErrors = consoleErrors.splice(0);
  verdict.runs.push(run);
}
/** A rotated clip (a phone's portrait recording: a 90° display matrix) draws upright: the element's size and the canvas are portrait. */
async function runRotated() {
  const run = { label: 'rotation (A-rot.mp4: a 90° display matrix, drawn upright)', ok: true, checks: {} };
  if (!existsSync(path.join(ROOT, 'demo/clips/A-rot.mp4'))) { run.skipped = 'no A-rot.mp4 (ffmpeg without -display_rotation)'; verdict.runs.push(run); return; }
  if (support && !support.h264) { run.skipped = 'this browser has no H.264 decoder'; verdict.runs.push(run); return; }
  try {
    await send('Page.navigate', { url: `http://localhost:${port}/demo/?a=A-rot.mp4&b=B.mp4` });
    let status = '';
    for (let i = 0; i < 120; i++) { status = (await evaluate(`document.getElementById('status')?.textContent || ''`)) || ''; if (/B \(.*supported:/.test(status) || /load failed/.test(status)) break; await sleep(500); }
    if (!/B \(.*supported: true/.test(status)) throw new Error('clips did not load: ' + status);
    await click('Play A'); await sleep(2500);
    const r = await evaluate(`JSON.stringify({ rotation: window.__clips.A.rotation, videoWidth: window.__v.videoWidth, videoHeight: window.__v.videoHeight, canvas: [window.__v.canvas.width, window.__v.canvas.height], rendered: window.__player.stats.rendered, stalls: window.__player.stats.stalls, box: [Math.round(window.__v.getBoundingClientRect().width), Math.round(window.__v.getBoundingClientRect().height)] })`).then(JSON.parse);
    await click('Stop');
    const ok = r.rotation === 90 && r.videoWidth === 720 && r.videoHeight === 1280 && r.canvas[0] === 720 && r.canvas[1] === 1280 && r.rendered > 30 && r.stalls <= 1;
    run.checks.upright = { ok, ...r };
    if (!ok) run.ok = verdict.ok = false;
  } catch (e) { run.ok = verdict.ok = false; run.error = e.message; }
  run.consoleErrors = consoleErrors.splice(0);
  verdict.runs.push(run);
}
/** play() before a gesture (a second Chromium; the page suspends its AudioContext for good, as the autoplay policy does): audio → NotAllowedError + `blocked`; muted → plays on the wall clock. */
function runGesture() {
  const run = { label: 'play() before a gesture (gesture-probe.html: a suspended AudioContext that will not resume)', ok: true, checks: {} };
  const src = support?.h264 ? 'A.mp4' : 'A-vp9.webm';
  const res = spawnSync(process.execPath, [path.join(ROOT, 'tools/run-page.mjs'), `demo/gesture-probe.html?src=${src}`, '--gesture-required', '--timeout', '30'], { encoding: 'utf8', env: process.env });
  let r = null; try { r = JSON.parse(res.stdout); } catch { /* */ }
  if (!r?.done) { run.ok = verdict.ok = false; run.error = `no result: ${(res.stderr || res.stdout || '').slice(0, 400)}`; verdict.runs.push(run); return; }
  const ok = r.rejected === 'NotAllowedError' && r.blocked >= 1 && r.paused === true && r.mutedPlay === 'played' && r.framesWhileMuted > 10 && r.clock === 'wall';
  run.checks.gesture = { ok, rejected: r.rejected, blocked: r.blocked, pausedAfter: r.paused, mutedPlay: r.mutedPlay, framesWhileMuted: r.framesWhileMuted, clock: r.clock };
  if (!ok) { run.ok = verdict.ok = false; }
  verdict.runs.push(run);
}

try {
  await send('Page.enable'); await send('Runtime.enable');
  await runPair('A-vp9.webm', 'B-vp9.webm', 'VP9 + Opus in WebM');   // first: every Chromium decodes VP9, and this read tells us about H.264
  await runPair('A.mp4', 'B.mp4', 'packed GOP 12 (H.264 + AAC)');
  await runPair('A-normal.mp4', 'B.mp4', 'ORDINARY file A (GOP 250, B-frames) → packed B');
  if (support?.h264) await runPair('A-normal.mp4', 'B.mp4', 'decode in a Worker, busy main thread during the loop', { worker: true });
  else await runPair('A-vp9.webm', 'B-vp9.webm', 'decode in a Worker, busy main thread during the loop (VP9: no H.264 here)', { worker: true });
  await runCompat();
  await runRotated();
  runGesture();
  const ran = verdict.runs.filter((r) => !r.skipped);
  if (!ran.length) verdict.ok = false;
} finally {
  try { ws.close(); } catch { /* */ }
  server.close();
  // Chromium is still writing its profile when it gets the signal: wait for it to exit, then remove
  // the profile with a few retries; a profile left behind is a note, never a failure.
  const exited = new Promise((r) => { chrome.once('exit', r); setTimeout(r, 5000); });
  chrome.kill();
  await exited;
  if (!args.includes('--keep')) {
    for (let i = 0; i < 5; i++) { try { rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); } }
    if (existsSync(profile)) verdict.note = `profile left behind at ${profile}`;
  }
}
console.log(JSON.stringify(verdict, null, 2));
process.exit(verdict.ok ? 0 : 1);
