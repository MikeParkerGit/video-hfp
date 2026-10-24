# Changelog

## 0.2.0-beta.2 — 2026-10-24
- **Playback rate.** `playbackRate` (0.25–4) on the element and `rate` on the engine scale the clock and re-anchor what is playing so the frame on screen stays put; audio pieces are scheduled at the rate, and a pitch shifter on the output (two sawtooth-modulated delay lines, crossfaded — standard nodes, no worklet) keeps the pitch; `preservesPitch` (default true) turns it off for the old-fashioned pitch shift and reads false where the context cannot; `ratechange`; `defaultPlaybackRate` applies on load; `AudioEngine.output` is the node to tap for what the listener hears; `canDo` takes a `rate`; bridges grow with the rate. The suite plays the loop at 2×: twice the media frames a second, the wrap exact, the beep at 445 Hz with the shifter and 879 without.
- **Controls.** `<video-hfp controls>` draws its own bar in the shadow root — play/pause, a frame step either way, the time, a scrubber in frames that seeks on release, mute, full screen — hiding while playing and returning on a touch, a move or a key (space/k, arrows 5 s, shift+arrow one frame, j/l 10 s, m, f); `controlslist="nofullscreen"`. `play()` now resumes the AudioContext first, synchronously, so a tap's activation is not lost while the clip is still opening (iOS).
- **Rotation.** A phone's portrait recording is stored sideways with a 90° display matrix, which `<video>` applies and the canvas did not: the MP4 demuxer reads the track header's matrix (and the WebM one a Projection roll), the clip carries `rotation` (degrees clockwise) and the upright `displayWidth`/`displayHeight`, the engine turns the frame as it draws, and the element's `videoWidth`/`videoHeight` and intrinsic size are the upright ones. The test clips gain `A-rot.mp4` (`ffmpeg -display_rotation -90`, a metadata-only copy); the smoke test proves 90° and 720×1280, the playback suite draws it upright.

## 0.2.0-beta.1 — 2026-10-24 — video-hfp: the element, the bridge (the first published release, as a beta: `npm install video-hfp@beta`)

The package is **video-hfp** (high frame precision). The public interface is the `<video-hfp>`
element; the `Player` class is the engine behind it.

- **`<video-hfp>`** (`src/element.js`, `import 'video-hfp/element'`): the `<video>` surface to the
  extent it is honoured — `src`, `width`/`height`, `poster`, `muted`, `volume`, `loop`, `autoplay`,
  `preload`, `playsinline`, `crossorigin`; `play()` (rejects with `NotAllowedError` before a
  gesture when the clip has audio, fires `blocked`), `pause()`, `currentTime` (seconds; a seek),
  `duration`, `paused`, `ended`, `readyState`, `networkState`, `requestVideoFrameCallback`, the
  events in `<video>`'s order; `playbackRate`, `srcObject`, `mediaKeys`, picture-in-picture, text
  tracks THROW `NotSupportedError`. The frame-exact verbs in frames: `open()`, `seek()`, `play({
  from, to, loop })`, `loopRange()`, `prepare()`, `cut()`, `cutAfter()`, `cancelCut()`;
  `currentFrame`, `frameRate`, `frameCount`, `clip`, `prepared`, `engine`; events `frame`,
  `switch`, `loop`, `stall`, `decoderrefused`. Declarative `<hfp-clip name src prepare-at>`.
  Attributes `loop-start` / `loop-end` loop a range with no script.
- **The bridge** (`src/bridge.js`): a prepared target is raw frames and no decoder. `prepare(clip,
  frame)` decodes `bridgeFrames(clip, frame)` frames with a software decoder, copies the planes out
  (one buffer per bridge), releases the decoder, fetches the hand-off bytes and warms the audio
  window; `cut()` plays the bridge from the next display frame while the playing decoder is
  **re-targeted** (`FrameSource.retarget`) and takes over at the bridge's end by the two-source
  swap. The length is a formula per target from the clip's index and `HARDWARE_FLOOR`
  (`profiles.js`, assumed until a 2022 midrange phone is measured). Decoder parking is gone.
- **Loops use the bridge too.** A loop whose lead-in is longer than the lookahead parks its first
  frames once (`bridgeFrames(clip, from)`, at most the loop's length) and shows them at every wrap
  while its one decoder decodes the lead-in behind them and resumes past the bridge
  (`FrameSource.setLoopResume`, `loopResume`). The two-decoder wrap (`pingPong`) is gone; the
  override is `bridge: true|false`. A cut to a loop's own start keeps its bridge as the wrap bridge.
  A loop shorter than its bridge lives on the bridge alone, with no decoder.
- The bridge length is solved against the HAND-OFF frame: the decoder behind a bridge starts from
  the keyframe before `frame + N`, so `bridgeFrames` scans N upward until the span covers restart +
  that run + margin; a keyframe inside the bridge shortens it. `maxBridgeFrames` is a GOP's worst;
  `canDo('prepare')` and `plan()` use it. `canDo('loop')` answers one decoder plus a bridge, and
  says no only when the lead-in plus the loop is more decoding than the period allows.
- **Memory boundaries** (ruled): 500 MB of frames held warns, 1 GB is critical; neither is a cap. The
  player accounts bridges and decoder lookaheads (`stats.memoryBytes`, `stats.memoryLevel`) and says a
  crossing once on the console and as a `memory` event; `canDo` and `plan` report the same levels
  (`warnings` past 500 MB, a limit past 1 GB). The per-profile `memoryBudgetBytes` is gone.
- **`optimize()`** (ruled): `v.optimize()` / `engine.optimize(clip)` runs the probe when nothing is
  playing and sizes bridges from this device (`floorFromProfile`, `engine.floor`, `bridgeFramesFor`,
  the `optimized` event); the baseline floor ships otherwise. The probe's decode rate is steady-state
  (first output to last), so start-up is no longer charged twice. The profile is stored for the whole
  origin (localStorage, kept until the browser changes) and every new player starts from it, so no page
  measures twice; `optimize({ force: true })` re-measures, `forgetStoredProfile()` clears it.
- **Three layers size a bridge** (ruled): the baseline floor, the measured floor, and what playback
  observes at every hand-off — the frames of the bridge actually used before the decoder was ready,
  or the slots it was late. `adjustBridge`: late by k → n + k + 2; under three quarters used → used
  + 10 % (min 2); never under `MIN_BRIDGE_FRAMES` (5). Learned as `tune.scale` on the floor's answer,
  stored for the origin with the floor it was learned on (`storedTune`/`storeTune`; a new measurement
  resets it); a loop's wrap bridge is rebuilt to the learned length and swapped in at a wrap. Events
  `handoff` and `tuned`; `stats.bridgeScale`, `stats.tuned`. On the Mac the GOP-250 loop's 33-frame
  wrap bridge relearns down to 5 after its first wrap.
- `Player`: `prepare()` → a `Prepared` handle (the same clip+frame twice is the same handle;
  arrays accepted), `cut(target, frame, { from, to, loop })`, `cutAfter(at, target, frame)`,
  `cancelCut()` (re-arms the current segment's audio), `release()`/`releaseAll()`, `muted` (a muted
  clip with audio runs on the wall clock before a gesture), `draw()`, `stats.bridges`, events
  `switch` and `loop`. `switchNow`/`cutover` are gone.
- `probeDevice` measures `decoderRestartMs` (the same decoder reset + configured → first frame);
  `canDo({ kind: 'prepare' })` is a memory question (bridges), with `fewer`, `re-encode` and
  `lower-resolution` remedies; `plan()` adds the bridges' memory and reports `bridgeFrames`.
- `probeBridgeCompression` (a record, not the player): the same decoder re-targeted, a second
  bitrate target, constant quantizers through the first encoder offering the mode, three JPEG
  frames decoded at once. Measured on the Mac and the Pixel 9a; compression was set aside — every
  form behaved differently per device. The profile record carries the figures by resolution.
- `tools/run-page.mjs` runs one demo page headless (muted; `--gesture-required`). `demo/compat.html`
  and `demo/gesture-probe.html` exercise the `<video>` surface; the playback suite drives the
  element and adds those two runs.

## 0.1.0 — 2026-10-20

First version: WebCodecs player over a packed `.mtv` container (H.264 Main, no B-frames, GOP 12)
with an audio sidecar; seamless loop, frame-exact cutover, zero-lag switch; verified in headless
Chromium.
