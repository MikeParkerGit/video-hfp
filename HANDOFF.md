# HANDOFF — read this first

video-hfp — high frame precision video (package `video-hfp`, GitHub `MikeParkerGit/video-hfp`). Version 0.2.0-beta.2 is on npm under the `beta` dist-tag. **Releasing:** bump `package.json` and `CHANGELOG.md`, commit, push a `v<version>` tag; `.github/workflows/publish.yml` runs the tests and publishes by npm trusted publishing (OIDC, configured on npmjs.com 2026-10-25) with provenance — a prerelease goes out as `beta`, a plain version as `latest`. No token or npm login is needed anywhere (an `npm login` lasts two hours anyway). npm required a `latest` on the first publish, so `latest` points at 0.2.0-beta.1 until a stable release moves it. Built in a Claude cloud session on
2026-10-20 as a strict-container player, reviewed and rebuilt the same day on Mike's Mac mini
under the ruling below. Everything a next session needs is here; `README.md` has the design,
the API and the measured numbers.

## The ruling (Mike, 2026-10-20): encoding is advice, never a requirement

The player plays ordinary files (MP4/MOV, WebM/MKV; H.264, HEVC, VP9, AV1; long GOPs, B-frames,
any length). A re-encode is a performance lever for particular actions a designer might want;
the player knows its budgets (`probeDevice` + the clip's keyframe map) and, when an action would
miss its budget on this device with this file, `canDo()` says which re-encode or other lever
delivers it and what it costs. Nobody re-encodes until they push a limit. The loop and the
cutover never came from the encoding — they come from owning the decoder and the clock.

## State (2026-10-20, branch `ordinary-files` merged to `main`)

Built and verified (`npm test`, `npm run test:playback`, headless Chromium 151, software and
hardware decode, muted):
- MP4/WebM demuxers match ffprobe packet by packet on every test clip (`src/demux/`).
- B-frames: chunks fed in decode order, frames addressed by presentation number.
- Frames range-loaded by byte windows; audio decoded in windows with `AudioDecoder` and
  scheduled sample-accurately; the whole-file `decodeAudioData` path is the fallback.
- The clock subtracts the output latency; silent clips play before a gesture on a wall clock;
  `play()` anchors on the first decoded frame and audio window; two-decoder loops on long-GOP
  files; a dead decoder is rebuilt; `destroy()` closes its own AudioContext.
- `canDo()` and `probeDevice()`; `tools/pack.js` writes standard MP4/WebM with `--seek-budget`.
- Opt-in decode in a module Worker (`new Player(canvas, { worker: true })`).
- GitHub CI is green (`.github/workflows/ci.yml`): clips generated with apt ffmpeg, `npm test`, and the
  playback test on Playwright's Linux Chromium — VP9/Opus and the Worker pairing pass; the H.264
  pairings are skipped there (that build has no H.264 decoder).
- Playback results, all pairings: loop `[30,90)` wraps `A 89 → A 30` with no reversal; cutover
  `A 75 → B 438` exactly, audio boundary within one analyser window; prepared switch lands on
  the next frame; the ordinary GOP-250 file loops `A 259 → A 200` on one decoder plus its wrap
  bridge; zero frames dropped. Under a 40 ms-every-150 ms busy main thread the Worker keeps the decoder fed
  (zero stalls) but the main thread still misses animation frames (drops) — presentation cannot
  be moved off the main thread.

Verified on Mike's Android phone, in a WebView (2026-10-20): the packed pair and his own
1080p GOP-30 recording play over byte ranges with zero drops and zero stalls (device probe: decode
124 fps at 1080p, start-up 122 ms, 3 decoders, output latency 24 ms). Two phone lessons are in the
code: a hardware decoder may buffer more chunks than the lookahead before its first frame (the
inflight cap is separate now), and the device probe must not run while something plays.

NOT yet verified (do this first):
- **Safari / WKWebView / iPhone** — the platform Mike cares most about. The avcC description and
  AVC-format chunks Safari needs are in place; `AudioDecoder` availability there decides whether
  audio streams or falls back to the whole file. `demo/transcode-probe.html` and the device probe
  give the first phone numbers.
- Firefox desktop, WebKitGTK, real Android.

## Design rule (Mike, 2026-10-21): probes and plans are tools; the player has no limits

Probes are optional and the player never runs one. The probe's result is a **HardwareProfile**
(`probeDevice()`), the last one measured on a device is kept there (`storedProfile()`), and
`src/profiles.js` is the record of known ones (this Mac in hardware and software decode, Mike's
Android phone). The optimization suite `plan(spec, profiles)` takes what you intend (resolution,
GOP, prepared count, cold-switch budget, loops, cutover lead) and reports per profile which limits
bite and what lifts them; `canDo()` is the one-action form. The answers are advice. The player is
fully capable of frame-exact switches with no artificial limit: it asks for every decoder it is
told to prepare and reports a refusal; a loop's second decoder is a structural decision
(lead-in longer than the lookahead) with a `pingPong` override. The demo and the tool have
"Measure this device" and "Plan against known profiles" buttons; nothing probes on load.

## The interface and prepare: RULED 2026-10-21/22, BUILT 2026-10-22 (0.2.0)

Built and verified through the element (`npm run test:playback`): `<video-hfp>` (`src/element.js`),
the bridge (`src/bridge.js`), the re-targeted decoder, `cut`/`cutAfter`/`cancelCut`, the `<video>`
surface (compat.html: event order, attributes-only loop, throwing setters, pause/seek/resume), play()
before a gesture (gesture-probe.html). The rulings, as built:

- **The public interface is an element**, `<video-hfp>` (was to be `<mikes-video>`; renamed with the package), shaped like `<video>` (its attributes,
  properties and events to the extent we support them; unsupported setters throw), with the
  frame-exact verbs beside it in frames: `open()`, `seek()`, `loop()`, `cut(target, frame)`,
  `cutAfter(frame, target, atFrame)`. The `Player` class is the engine. Item lwzxt8z05v (done).
- **Every prepared target is a bridge** — parked pixels, no parked decoder (decoder parking is to
  be deleted). `prepare(clip, frame)` decodes the target's first N frames with a software decoder,
  copies the pixels out, releases the decoder; `cut()` plays the bridge from the next display
  frame while the decoder that played the previous clip is re-targeted behind it and takes over
  at N by the two-source swap. N comes from one formula per target over the clip's index and a
  HARDWARE FLOOR profile (a four-year-old midrange phone: Pixel 6a / iPhone SE 2022; assumed
  numbers until measured) — see the hand-off rule below.
  No runtime probe, no cap: memory is the caller's and `plan()` says how much. Item 925n88m05v (done).
- **Loops use the bridge too** (ruled 2026-10-22, built the same day): a loop whose lead-in is longer
  than the lookahead parks its first frames once and shows them at every wrap while its ONE decoder
  decodes the lead-in behind them and resumes past the bridge (`FrameSource.setLoopResume`). The
  second decoder ("ping-pong") is deleted. A loop shorter than its bridge lives on the bridge alone.
  The bridge length is solved against the HAND-OFF frame (frame + N), not the target: the decoder
  behind a bridge starts from the keyframe before the hand-off, and a keyframe inside the bridge
  shortens it (`bridgeFrames` scans N upward; `maxBridgeFrames` is a GOP's worst).
- **Memory boundaries** (ruled 2026-10-22): 500 MB of frames held is a WARNING, 1 GB is CRITICAL;
  neither is a cap. The player keeps the total (`stats.memoryBytes`: bridges + decoders' lookaheads)
  and says a crossing once, on the console and as a `memory` event; the plan reports the same levels
  (`warnings` past 500 MB, a limit past 1 GB). The per-profile "memory budget" is gone — it was a
  made-up number; on a phone the OS memory killer decides, foreground app last, not gracefully.
- **optimize()** (ruled 2026-10-22): the player may measure the device itself — `v.optimize()` runs
  the probe on the current clip (nothing playing) and sizes bridges from the measured decode rate
  and re-target time with the baseline's margin (`floorFromProfile`, `engine.floor`). Without a
  call, the baseline floor ships. The probe's throughput is steady-state now (first output to last).
  **The profile is shared across the origin** (ruled 2026-10-22): stored in localStorage — the
  widest scope a page has — and every new player on the origin starts from it (`stats.floor:
  'stored'`); `optimize()` reuses it, `{ force: true }` re-measures; kept until the user agent changes.
- **Three layers, each superseding the one below** (ruled 2026-10-22, built): the baseline floor,
  the measured floor (`optimize()`, stored for the origin), and what playback OBSERVES at every
  hand-off (`Player._observe`, `adjustBridge` in bridge.js): the decoder behind a bridge reports
  when its first frame is queued → the frames used; stalls right after a hand-off → slots late.
  Late by k → n + k + 2; under 75 % used → used + 10 % (min 2); never under MIN_BRIDGE_FRAMES = 5.
  Learned as a scale on the floor's answer (`tune.scale`, stored per origin with the floor's
  basis; a new measurement resets it); a loop's wrap bridge is rebuilt to the exact length in the
  background and swapped in at a wrap. The screen at a short bridge shows 6 6 6 9 (hold, then
  skip): the clock never waits, audio runs on.
- **The bridge is stored RAW** (ruled 2026-10-22): the frames as the decoder hands them over
  (I420/NV12 planes, 1.5 bytes a pixel), one buffer per bridge, rebuilt as VideoFrames at draw
  time (0.1–0.6 ms measured). No compression: it was measured on the Mac and the Pixel 9a
  (`probeBridgeCompression`, figures on the profiles) and every form behaved differently per
  device — JPEG 3.5 ms on the Mac and 195–280 ms on the phone, the phone's hardware encoder
  ignoring its bitrate target, a quantizer mode on some encoders and not others — which would
  have meant a per-device strategy, a second system. The probe stays as a tool; the record is
  in item 925n88m05v. The bridge is sized per TARGET from the clip's index, which is complete
  at load: `frame − keyBefore(frame)` is the exact decode run the re-targeted decoder must do,
  so no GOP default is ever needed.

## Where it is used

The first consumer is a Merotools toolbox (a WebCodecs-capable WebView on Android, Safari on
the iPhone). Its rig — servers, ids, the phone procedure — lives with that project, not here.
The engine has run on a Pixel 9a (Android 17, Chrome 155 WebView); the element, the bridged cut
and the bridged loop have not been on a phone yet, and no iPhone has run any of it.

## Next task

The phone pass of the element: a long clip loops (watch the hand-off lines: `used`, `late`, the
relearned bridge), a prepared cut lands on the next display frame, `optimize()` stores a profile
the next page starts from. Then the iPhone: `AudioDecoder` availability decides whether audio
streams or falls back to the whole file. Record both in README's support table and here.

## Commands

```
npm run clips            # ffmpeg (libx264, libvpx, aac, libopus; no libfreetype needed): the five test clips
npm test                 # demuxers vs ffprobe, FrameSource with a reordering mock decoder, the budget model
npm run test:playback    # headless Chromium, muted, through the element; add --gpu for hardware decode
node tools/run-page.mjs demo/compat.html          # one page headless; --gesture-required for the autoplay policy
npm run serve            # http://localhost:8080/demo/  (?a=A-normal.mp4&b=B.mp4&worker=1&stream=1)
```
