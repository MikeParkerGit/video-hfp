// probeBridgeCompression — OPTIONAL, never run by the player. How a bridge could be held in less
// memory on THIS device: per-frame encode time, size and decode time for the forms a browser can
// compress and recover a frame quickly — the raw copy (baseline), JPEG and WebP through the image
// codecs, and an all-intra video run through VideoEncoder and a software VideoDecoder: a fresh
// decoder's start to its first frame, the same decoder re-targeted (reset, configure, first frame —
// what one warm bridge decoder per player would cost at a cut), and the size at a second, lower
// bitrate target. Run it when nothing is playing; it decodes `frames` frames of the clip from
// `from` and closes everything.
import { FrameSource } from './frame-source.js';
import { softDecoderClass } from './bridge.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (t) => Math.round(t * 100) / 100;

export async function probeBridgeCompression(clip, { frames: N = 16, from = 0, quality = 0.9, intra = true, bitsPerPixel = [0.6, 0.2], quantizers = null, webp = false, onProgress } = {}) {
  const stage = (s) => { try { onProgress?.(s); } catch { /* */ } };
  stage('decoding frames');
  const SoftDecoder = softDecoderClass();
  const src = new FrameSource(clip, { lookahead: N + 4, VideoDecoder: SoftDecoder });
  const start = Math.min(from, Math.max(0, clip.frameCount - N - 1));
  src.start({ from: start, to: Math.min(clip.frameCount, start + N), loop: false });
  const tw = performance.now();
  while (src.queued < N && performance.now() - tw < 15000 && !src.error) await sleep(10);
  if (src.error) { src.close(); throw src.error; }
  const frames = []; while (frames.length < N && src.queued) frames.push(src.shift().frame);
  const n = frames.length;
  const rect = frames[0].visibleRect, W = rect.width, H = rect.height, fmt = frames[0].format;
  const res = { kind: 'BridgeCompressionProbe', version: 1, clip: clip.describe().name, size: `${W}x${H}`, format: fmt, frames: n, quality, measuredAt: Date.now(), ua: typeof navigator !== 'undefined' ? navigator.userAgent : 'node' };
  try {
    // raw: copy out, and the rebuild a bridge does at draw time
    stage('raw copy');
    { const size = frames[0].allocationSize({ rect }); const bufs = []; let tc = 0, tr = 0;
      for (const f of frames) { const b = new ArrayBuffer(size); const t0 = performance.now(); await f.copyTo(b, { rect }); tc += performance.now() - t0; bufs.push(b); }
      for (const b of bufs) { const t0 = performance.now(); const vf = new VideoFrame(b, { format: fmt, codedWidth: W, codedHeight: H, timestamp: 0 }); tr += performance.now() - t0; vf.close(); }
      res.raw = { bytesPerFrame: size, copyOutMs: ms(tc / n), rebuildMs: ms(tr / n) }; }
    // image codecs through a canvas
    for (const [name, type] of [['jpeg', 'image/jpeg'], ...(webp ? [['webp', 'image/webp']] : [])]) {
      stage(`${name} encode + decode`);
      const oc = new OffscreenCanvas(W, H); const ctx = oc.getContext('2d');
      const blobs = []; let te = 0, td = 0;
      for (const f of frames) { ctx.drawImage(f, 0, 0); const t1 = performance.now(); const blob = await oc.convertToBlob({ type, quality }); te += performance.now() - t1; blobs.push(blob); }
      for (const b of blobs) { const t0 = performance.now(); const bm = await createImageBitmap(b); td += performance.now() - t0; bm.close(); }
      // three at once — how a cut would decode a JPEG head while the intra decoder starts
      const tp = performance.now(); const bms = await Promise.all(blobs.slice(0, 3).map((b) => createImageBitmap(b))); const parallel3 = performance.now() - tp; for (const bm of bms) bm.close();
      const bytes = blobs.reduce((a, b) => a + b.size, 0) / n;
      res[name] = { bytesPerFrame: Math.round(bytes), encodeMs: ms(te / n), decodeMs: ms(td / n), decode3ParallelMs: ms(parallel3), ratio: ms(res.raw.bytesPerFrame / bytes) };
    }
    // all-intra video: every frame a keyframe, then a fresh software decoder, then the same decoder re-targeted
    if (intra && typeof VideoEncoder !== 'undefined') {
      const vp9 = clip.codec.startsWith('vp09');
      const codec = vp9 ? 'vp09.00.40.08' : 'avc1.64002a';
      const base = () => ({ codec, width: W, height: H, framerate: 30, latencyMode: 'quality', ...(vp9 ? {} : { avc: { format: 'avc' } }) });
      // a bitrate TARGET in bits per pixel (hardware encoders overshoot it for all-key runs — and some ignore it)
      const cfgAt = (bpp) => ({ ...base(), bitrate: Math.round(W * H * 30 * bpp) });
      // every frame a keyframe through one encoder config; `perFrame` goes on each encode() call
      const encodeRun = async (ecfg, perFrame = {}) => {
        const sup = await VideoEncoder.isConfigSupported(ecfg).catch(() => ({ supported: false }));
        if (!sup.supported) return null;
        const chunks = []; let desc = null;
        const enc = new VideoEncoder({ output: (c, meta) => { if (meta?.decoderConfig?.description) desc = meta.decoderConfig.description; chunks.push(c); }, error: () => {} });
        enc.configure(ecfg);
        const t0 = performance.now();
        for (const f of frames) enc.encode(f, { keyFrame: true, ...perFrame });
        await enc.flush(); const te = performance.now() - t0; enc.close();
        const bytes = Math.round(chunks.reduce((a, c) => a + c.byteLength, 0) / n);
        return { chunks, desc, encodeMsPerFrame: ms(te / n), bytesPerFrame: bytes, ratio: ms(res.raw.bytesPerFrame / bytes) };
      };
      // decode `chunks` on a configured decoder whose callbacks read `h`: time to its first frame and to all of them
      const decodeAll = (dec, chunks, h) => new Promise((resolve, reject) => {
        let got = 0, tFirst = 0; const t1 = performance.now();
        const timer = setTimeout(() => reject(new Error('intra decode: no answer within 10 s')), 10000);
        h.output = (f) => { got++; if (got === 1) tFirst = performance.now() - t1; f.close(); if (got === chunks.length) { clearTimeout(timer); resolve({ tFirst, tAll: performance.now() - t1 }); } };
        h.error = (e) => { clearTimeout(timer); reject(e); };
        for (const c of chunks) dec.decode(c); dec.flush().catch(h.error);
      });
      stage('intra video encode + decode');
      const main = await encodeRun(cfgAt(bitsPerPixel[0]));
      if (!main) res.intra = { unsupported: codec };
      else {
        const h = {}; const dec = new SoftDecoder({ output: (f) => h.output?.(f), error: (e) => h.error?.(e) });
        const dcfg = { codec, codedWidth: W, codedHeight: H }; if (main.desc) dcfg.description = main.desc;
        try {
          dec.configure(dcfg);
          const fresh = await decodeAll(dec, main.chunks, h);
          dec.reset(); dec.configure(dcfg);                       // re-targeted, as one warm bridge decoder would be at a cut
          const warm = await decodeAll(dec, main.chunks.slice(0, 1), h);
          res.intra = { codec, bitsPerPixel: bitsPerPixel[0], bytesPerFrame: main.bytesPerFrame, encodeMsPerFrame: main.encodeMsPerFrame, decoderStartToFirstFrameMs: ms(fresh.tFirst), decoderRestartToFirstFrameMs: ms(warm.tFirst), decodeMsPerFrame: ms((fresh.tAll - fresh.tFirst) / Math.max(1, n - 1)), ratio: main.ratio };
        } finally { try { dec.close(); } catch { /* already closed */ } }
        for (const bpp of bitsPerPixel.slice(1)) {
          stage(`intra video at ${bpp} bits/pixel`);
          const r = await encodeRun(cfgAt(bpp)); if (!r) continue;
          (res.intraAt ??= {})[bpp] = { bytesPerFrame: r.bytesPerFrame, encodeMsPerFrame: r.encodeMsPerFrame, ratio: r.ratio };
        }
        // a constant quantizer per frame — the direct size/quality lever, where an encoder offers the mode. The bridge
        // is our own store, so its codec need not be the clip's: H.264 first (hardware, then software), then VP9.
        let qused = null;
        for (const [qcodec, hw] of [['avc1.64002a', true], ['avc1.64002a', false], ['vp09.00.40.08', true], ['vp09.00.40.08', false]]) {
          const cfg = { codec: qcodec, width: W, height: H, framerate: 30, latencyMode: 'quality', bitrateMode: 'quantizer', ...(qcodec.startsWith('avc1') ? { avc: { format: 'avc' } } : {}), ...(hw ? {} : { hardwareAcceleration: 'prefer-software' }) };
          const sup = await VideoEncoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
          if (sup.supported) { qused = cfg; break; }
        }
        if (!qused) res.intraQuantizer = { unsupported: true };
        else {
          const qvp9 = qused.codec.startsWith('vp09');
          res.intraQuantizer = { codec: qused.codec, ...(qused.hardwareAcceleration ? { software: true } : {}) };
          for (const qp of quantizers ?? (qvp9 ? [20, 36] : [22, 30])) {
            stage(`intra video at quantizer ${qp}`);
            const r = await encodeRun(qused, qvp9 ? { vp9: { quantizer: qp } } : { avc: { quantizer: qp } }); if (!r) continue;
            res.intraQuantizer[qp] = { bytesPerFrame: r.bytesPerFrame, encodeMsPerFrame: r.encodeMsPerFrame, ratio: r.ratio };
          }
        }
      }
    }
  } finally { for (const f of frames) f.close(); src.close(); }
  return res;
}
