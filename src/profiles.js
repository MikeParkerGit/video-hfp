// Known hardware profiles — the record. Each is a HardwareProfile as probe.js answers it (with the
// app's outputLatencyMs added), measured on a real device on a real day. The plan() tool checks a
// plan against one of these, the stored one on this device, or the whole group. Add a device by
// running the probe there (the demo's "Measure this device" button prints the object) and pasting
// it here with a label that says what it was.

export const KNOWN_PROFILES = [
  {
    kind: 'HardwareProfile', version: 1,
    label: 'Mac mini, Apple silicon, Chromium 151 headless, hardware decode (2026-10-20)',
    platform: 'macOS', codec: 'avc1.64001f', resolution: '1280x720', width: 1280, height: 720,
    decodeFps: 1546, decoderStartupMs: 5, decoders: 8, decodersAtLeast: true, encodeFps: 460, refreshHz: 60,
    outputLatencyMs: 16, measuredAt: Date.UTC(2026, 9, 20), notes: [],
    // bridge compression (probeBridgeCompression), by resolution; measured 2026-10-22 on REAL phone footage:
    bridge: {
      '1280x720': {
        source: 'real footage',
        raw: { bytesPerFrame: 1382400, copyOutMs: 0.12, rebuildMs: 0.07 },
        jpeg: { bytesPerFrame: 231043, encodeMs: 3.6, decodeMs: 2.17, decode3ParallelMs: 2.7 },
        intra: { codec: 'avc1.64002a', bitsPerPixel: 0.6, bytesPerFrame: 137171, encodeMsPerFrame: 4.73, decoderStartToFirstFrameMs: 3.4, decoderRestartToFirstFrameMs: 2.9, decodeMsPerFrame: 1.7 },
        intraAt: { '0.2': { bytesPerFrame: 89893, encodeMsPerFrame: 5.01, ratio: 15.38 } },
        // no H.264 encoder here (hardware or software) offers the constant-quantizer mode; the VP9 hardware one does
        intraQuantizer: { codec: 'vp09.00.40.08', '20': { bytesPerFrame: 240994, encodeMsPerFrame: 10.71, ratio: 5.74 }, '36': { bytesPerFrame: 183557, encodeMsPerFrame: 9.81, ratio: 7.53 } },
      },
    },
  },
  {
    kind: 'HardwareProfile', version: 1,
    label: 'Mac mini, Apple silicon, Chromium 151 headless, software decode (2026-10-20)',
    platform: 'macOS', codec: 'avc1.64001f', resolution: '1280x720', width: 1280, height: 720,
    decodeFps: 549, decoderStartupMs: 6, decoders: 80, decodersAtLeast: true, encodeFps: 582, refreshHz: 60,
    outputLatencyMs: 16, measuredAt: Date.UTC(2026, 9, 20), notes: ['80 software decoders prepared at once at 1080p without a refusal'],
  },
  {
    kind: 'HardwareProfile', version: 1,
    label: 'Pixel 9a (2025), Android 17, Chrome 155 WebView, hardware decode, 1080p (2026-10-20)',
    platform: 'Android', ua: 'Mozilla/5.0 (Linux; Android 17; Pixel 9a Build/CP3A.261005.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/155.0.8059.43 Mobile Safari/537.36',
    codec: 'avc1.640029', resolution: '1920x1080', width: 1920, height: 1080,
    decodeFps: 124, decoderStartupMs: 122, decoders: 3, decodersAtLeast: true, encodeFps: 39, refreshHz: 60,
    outputLatencyMs: 24, measuredAt: Date.UTC(2026, 9, 20), notes: ['decoders: the probe stopped at its cap of 3; the true grant is at least that'],
    // bridge compression (probeBridgeCompression), by resolution; measured 2026-10-22. The canvas JPEG
    // encoder is software and slow here (178–280 ms a frame: 3–4 s for a 15-frame bridge); the video
    // encoder is hardware (28–31 ms). Its rate control IGNORES the bitrate target for all-key runs:
    // at 1080p the same 0.6 bits/pixel target (155 KB) gave 501 KB in one run and 341 KB in the next,
    // and a 0.2 target gave 485 KB — so `bitrate` is not a lever here; a constant quantizer is, where
    // an encoder offers the mode (intraQuantizer, once measured). A re-targeted decoder is no faster
    // than a fresh one (58 vs 53 ms), so nothing is kept between cuts.
    bridge: {
      '1280x720': {
        source: 'test pattern (clip A); real footage compresses ~3× less',
        raw: { bytesPerFrame: 1382400, copyOutMs: 1.23, rebuildMs: 0.22 },
        jpeg: { bytesPerFrame: 65505, encodeMs: 177.6, decodeMs: 8.9 },
        intra: { codec: 'avc1.64002a', bitsPerPixel: 0.6, bytesPerFrame: 56592, encodeMsPerFrame: 28, decoderStartToFirstFrameMs: 24.6, decodeMsPerFrame: 3.95 },
      },
      '1920x1080': {
        source: 'real footage (clip 8911, GOP 30); the second of two runs — the first gave intra 513197 bytes, encode 31.35, decode 15.48, start 45.7 ms; JPEG encode 280 ms',
        raw: { bytesPerFrame: 3110400, copyOutMs: 2.39, rebuildMs: 0.47 },
        jpeg: { bytesPerFrame: 351525, encodeMs: 195.38, decodeMs: 17.09 },
        intra: { codec: 'avc1.64002a', bitsPerPixel: 0.6, bytesPerFrame: 349217, encodeMsPerFrame: 29.06, decoderStartToFirstFrameMs: 53.3, decoderRestartToFirstFrameMs: 58.3, decodeMsPerFrame: 11.56 },
        intraAt: { '0.2': { bytesPerFrame: 496795, encodeMsPerFrame: 15.65, ratio: 6.26 } },
      },
    },
  },
];

/**
 * The HARDWARE FLOOR: the slowest device the bridge is sized for — a four-year-old midrange phone
 * (a Pixel 6a and an iPhone SE, both 2022). ASSUMED until measured on one; the Pixel 9a above is
 * three generations newer and is the nearest data point (its decoder start-up is 122 ms, its
 * 1080p decode 124 fps, so a 6a will sit below both).
 */
export const HARDWARE_FLOOR = {
  kind: 'HardwareProfile', version: 1, label: 'the floor: a 2022 midrange phone (Pixel 6a / iPhone SE 2022) — ASSUMED until measured',
  platform: 'floor',
  decodeFps: 150, decodeFpsAtPixels: 1920 * 1080,   // decode rate at 1080p; bridgeFrames scales it by the clip's pixel count
  decoderStartupMs: 250, decoderRestartMs: 250,     // a fresh decoder's start, and a decoder re-targeted (reset + configure) to its first frame
  marginMs: 150,                                    // on top, so a bridge is never exactly as long as the gap
  decoders: 2, encodeFps: 20, refreshHz: 60, outputLatencyMs: 40, measuredAt: null,
  notes: ['assumed: no 2022 midrange phone has been measured yet; replace with a probe from a Pixel 6a or an iPhone SE (2022)'],
};

/** A profile by label substring, or null. */
export function knownProfile(labelPart) { return KNOWN_PROFILES.find((p) => p.label.toLowerCase().includes(labelPart.toLowerCase())) ?? null; }
