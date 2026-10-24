// The device probe — OPTIONAL, never run by the player itself. It measures a device with a real
// clip and answers a HardwareProfile: decode throughput, decoder start-up, how many decoders the
// device grants, encode throughput (if asked), the display refresh, a memory budget, and enough
// about the platform to recognise it again. The app decides when to probe; `storedProfile()`
// reads the last one kept on this device; `profiles.js` keeps the ones we know.
// "As phones get better the numbers move and the policy does not."

const KEY = 'video-hfp:profile';

/**
 * A floor profile made from a measured one: what optimize() hands the player. The measured decode rate
 * (at the clip's own pixel count), the measured re-target time, and the baseline's margin.
 */
export function floorFromProfile(profile, base) {
  const pixels = (profile.width || 1920) * (profile.height || 1080);
  return { ...base, label: `measured here: ${profile.label}`, platform: profile.platform, ua: profile.ua, decodeFps: profile.decodeFps, decodeFpsAtPixels: pixels, decoderStartupMs: profile.decoderStartupMs, decoderRestartMs: profile.decoderRestartMs ?? profile.decoderStartupMs, decoders: profile.decoders, refreshHz: profile.refreshHz, measuredAt: profile.measuredAt, notes: ['sized from this device by optimize(); the margin is the baseline floor\'s'] };
}

/**
 * The profile last measured and stored on THIS device, or null. Stored in localStorage, which the
 * browser shares across every page of the origin — the widest scope a page can reach (no page can
 * read another origin's storage) — so one measurement serves every video page on the site. It is
 * kept until the browser changes (the user agent string must match: a browser update brings new
 * decoders) or `maxAgeMs` passes (no limit by default).
 */
export function storedProfile({ maxAgeMs = Infinity } = {}) {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (d.ua !== navigator.userAgent || Date.now() - d.measuredAt > maxAgeMs) return null;
    return d;
  } catch { return null; }
}
/** Forget the stored profile (the next optimize() measures again) and what playback learned on top of it. */
export function forgetStoredProfile() { try { globalThis.localStorage?.removeItem(KEY); globalThis.localStorage?.removeItem(TUNE_KEY); } catch { /* */ } }

const TUNE_KEY = 'video-hfp:tune';
/** What playback learned about bridge length on this origin, on top of a floor (`basis`: the floor's measuredAt, or 'baseline'); null when it was learned on another floor or browser. */
export function storedTune(basis) {
  try {
    const raw = globalThis.localStorage?.getItem(TUNE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (d.ua !== navigator.userAgent || String(d.basis) !== String(basis)) return null;
    return d;
  } catch { return null; }
}
export function storeTune(tune, basis) {
  try { globalThis.localStorage?.setItem(TUNE_KEY, JSON.stringify({ ...tune, basis, ua: navigator.userAgent, updatedAt: Date.now() })); } catch { /* private mode */ }
}

/**
 * Measure the device with `clip` (its first frames are decoded; nothing is drawn). Well under a second on a
 * laptop; a phone with a slow decoder start-up takes longer. Run it when nothing is playing.
 * @returns {Promise<{decodeFps:number, decoderStartupMs:number, decoderRestartMs:number, decoders:number, encodeFps:number|null, refreshHz:number, resolution:string, measuredAt:number, ua:string}>}
 */
export async function probeDevice(clip, { maxDecoders = 3, frames = 30, encode = false, cache = true, stepTimeoutMs = 4000, onProgress } = {}) {
  const cfg = clip.decoderConfig();
  const n = Math.min(frames, clip.frameCount);
  const lastD = clip.lastDecodeIndexBefore(n);
  const notes = [];
  const stage = (s) => { try { onProgress?.(s); } catch { /* */ } };
  // a decoder that never answers must not hang the probe: each step races a timeout and falls back to a default
  const bounded = (label, promise, fallback) => {
    let timer = null;
    const timeout = new Promise((r) => { timer = setTimeout(() => { notes.push(`${label}: no answer within ${stepTimeoutMs} ms, using a default`); r(fallback); }, stepTimeoutMs); });
    return Promise.race([promise, timeout]).catch((e) => { notes.push(`${label}: ${e?.message || e}, using a default`); return fallback; }).finally(() => clearTimeout(timer));
  };
  stage('fetching the first frames');
  await bounded('fetch', clip.ensureDecodeRange(0, lastD), undefined);
  const chunk = (d) => { const s = clip.samples[d]; return new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: Math.round(s.pts * 1e6) + 1e7, duration: Math.round(s.duration * 1e6), data: clip.sampleBytes(d) }); };

  // refresh rate
  stage('refresh rate');
  const refreshHz = await bounded('refresh', new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'undefined') return resolve(60);
    const times = []; const tick = (t) => { times.push(t); if (times.length < 24) requestAnimationFrame(tick); else { const d = times.slice(4).map((x, i, a) => i ? x - a[i - 1] : 0).filter(Boolean); d.sort((a, b) => a - b); resolve(Math.round(1000 / d[d.length >> 1])); } };
    requestAnimationFrame(tick);
  }), 60);

  // start-up: fresh decoder, one keyframe → first output; then the SAME decoder re-targeted (reset + configure → first output),
  // which is what the decoder behind a bridge does at a cut
  stage('decoder start-up');
  let startDec = null; const h = {};
  const startup = await bounded('start-up', new Promise((resolve, reject) => {
    let t0 = 0;
    const dec = startDec = new VideoDecoder({ output: (f) => h.output?.(f), error: (e) => h.error?.(e) });
    h.output = (f) => { f.close(); resolve(performance.now() - t0); }; h.error = reject;
    dec.configure(cfg); t0 = performance.now(); dec.decode(chunk(clip.decodeIndexOf(0))); dec.flush().catch(() => {});
  }), 30);
  stage('decoder re-target');
  const restart = await bounded('re-target', new Promise((resolve, reject) => {
    const dec = startDec; if (!dec || dec.state === 'closed') return reject(new Error('no decoder to re-target'));
    let t0 = 0;
    h.output = (f) => { f.close(); resolve(performance.now() - t0); }; h.error = reject;
    dec.reset(); dec.configure(cfg); t0 = performance.now(); dec.decode(chunk(clip.decodeIndexOf(0))); dec.flush().catch(() => {});
  }), startup);
  try { startDec?.close(); } catch { /* */ }

  // throughput: the first GOP (or `frames`), outputs closed at once
  stage('decode throughput');
  const kept = [];
  let tpDec = null;
  // steady state: from the first output to the last, so the decoder's start-up (measured above) is not charged twice
  const decodeFps = await bounded('throughput', new Promise((resolve, reject) => {
    let got = 0, tFirst = 0, tLast = 0;
    const dec = tpDec = new VideoDecoder({ output: (f) => { got++; const t = performance.now(); if (got === 1) tFirst = t; tLast = t; if (encode && kept.length < 60 && typeof VideoEncoder !== 'undefined') kept.push(f); else f.close(); }, error: reject });
    dec.configure(cfg);
    const t0 = performance.now();
    for (let d = 0; d <= lastD; d++) dec.decode(chunk(d));
    dec.flush().then(() => { const s = got > 1 ? (tLast - tFirst) / 1000 : (performance.now() - t0) / 1000; resolve(Math.round((got > 1 ? got - 1 : got) / Math.max(s, 1e-3))); }, reject);
  }), 300);
  try { tpDec?.close(); } catch { /* */ }

  // encoder throughput, only when asked (it is for the on-device re-encode idea, and it is the heaviest step)
  let encodeFps = null;
  if (encode && typeof VideoEncoder !== 'undefined' && kept.length) {
    stage('encode throughput');
    try {
      const ecfg = { codec: clip.codec.startsWith('vp09') ? 'vp09.00.31.08' : 'avc1.4d401f', width: clip.width, height: clip.height, bitrate: 6_000_000, framerate: Math.round(clip.fps), latencyMode: 'realtime' };
      if (ecfg.codec.startsWith('avc1')) ecfg.avc = { format: 'avc' };
      if ((await VideoEncoder.isConfigSupported(ecfg)).supported) {
        let enc = null;
        encodeFps = await bounded('encode', new Promise((resolve, reject) => {
          let got = 0, t0 = 0;
          enc = new VideoEncoder({ output: () => { got++; }, error: reject });
          enc.configure(ecfg); t0 = performance.now();
          for (let i = 0; i < kept.length; i++) enc.encode(kept[i], { keyFrame: i % 12 === 0 });
          enc.flush().then(() => { const s = (performance.now() - t0) / 1000; resolve(Math.round(got / s)); }, reject);
        }), null);
        try { enc?.close(); } catch { /* */ }
      }
    } catch { encodeFps = null; }
  }
  for (const f of kept) f.close();

  // decoder grant: open decoders until one fails to produce a frame
  stage('decoder count');
  let decoders = 0;
  const open = [];
  try {
    for (let i = 0; i < maxDecoders; i++) {
      const ok = await new Promise((resolve) => {
        const dec = new VideoDecoder({ output: (f) => { f.close(); resolve(true); }, error: () => resolve(false) });
        open.push(dec);
        try { dec.configure(cfg); dec.decode(chunk(clip.decodeIndexOf(0))); dec.flush().catch(() => resolve(false)); } catch { resolve(false); }
        setTimeout(() => resolve(false), 1000);
      });
      if (!ok) break;
      decoders++;
    }
  } finally { for (const d of open) { try { d.close(); } catch { /* */ } } }
  await new Promise((r) => setTimeout(r, 150));   // let the codec instances the grant test held go back to the device

  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const platform = nav.userAgentData?.platform || nav.platform || 'unknown';
  const result = {
    kind: 'HardwareProfile', version: 1,
    label: `${platform} · ${clip.codec.split('.')[0]} ${clip.width}x${clip.height} · ${new Date().toISOString().slice(0, 10)}`,
    platform, ua: nav.userAgent || 'node', cores: nav.hardwareConcurrency ?? null, deviceMemoryGB: nav.deviceMemory ?? null,
    resolution: `${clip.width}x${clip.height}`, width: clip.width, height: clip.height, codec: clip.codec,
    decodeFps, decoderStartupMs: Math.round(startup * 10) / 10, decoderRestartMs: Math.round(restart * 10) / 10, decoders: Math.max(1, decoders), decodersAtLeast: decoders >= maxDecoders, encodeFps, refreshHz,
    outputLatencyMs: null,   // the app fills this from its AudioContext, which the probe does not own
    measuredAt: Date.now(), notes,
  };
  if (cache) { try { globalThis.localStorage?.setItem(KEY, JSON.stringify(result)); } catch { /* private mode */ } }   // notes and all: a partial probe beats re-probing on every load
  return result;
}
