# video-hfp

**High frame precision video for the web.** A `<video>`-shaped element on WebCodecs that plays
ordinary files and keeps its promises to the frame:

- **Seamless loop** — frame `to-1` is followed by frame `from` on the next display frame, and the
  audio loops sample-accurately with it.
- **Frame-exact cut at a boundary** — "after A shows frame 1527, show B frame 438": the switch
  lands in exactly that frame slot, audio switches on the same sample.
- **Prepared cut** — `prepare()` builds a *bridge* (the target's first frames, parked raw, no
  decoder held); `cut()` then shows the target on the **next display frame** and the decoder
  takes over behind the bridge, frame-exact, on any device.

It plays the files people have: MP4/MOV and WebM/MKV, H.264, HEVC, VP9 and AV1 wherever the
browser decodes them, long GOPs, B-frames, any length. **Encoding is advice, never a
requirement.** When something you ask for would miss its budget on a device with a file, the
budget model says so and names the lever (a re-encode, a prepared target, fewer targets) that
delivers it. The player itself sets no limits.

Plain ES modules, no build step, no dependencies. Chrome/Edge (WebView2, Android WebView),
Safari 16.4+ / WKWebView, Firefox 130+ (desktop), WebKitGTK ≥ 2.44 — see the support table.

```sh
npm install video-hfp@beta      # the newest beta; a plain install gets `latest`, still the first beta
```

```html
<script type="module">import 'video-hfp/element';</script>

<video-hfp src="a.mp4" autoplay loop loop-start="30" loop-end="90" muted></video-hfp>
```

One import defines the element (and `<hfp-clip>`); the core, `import { … } from 'video-hfp'`, is
side-effect free and holds the probe, the plan and the engine for anyone building another
surface. Plain ES modules with no dependencies: any bundler takes them as they are (Vite emits
the decode worker as its own chunk), and a `<script type="module">` from a CDN works too.

```js
const v = document.querySelector('video-hfp');
const b = await v.open('b.mp4');          // a Clip: opened once per URL; File/Blob accepted
await v.prepare(b, 438);                  // a bridge: b's frames from 438 on, raw, no decoder
v.cut(b, 438);                            // the next display frame shows b#438
v.cutAfter(1527, b, 438);                 // or: after the current clip shows 1527, b#438 takes the next slot
v.addEventListener('frame', (e) => console.log(e.clip.name, e.index));
```

```
src/
  element.js         <video-hfp> and <hfp-clip>: the <video> surface, the frame verbs (defines on import)
  player.js          Player: the engine — the scheduler, the clock, loops, cuts, bridges, recovery
  bridge.js          bridgeFrames(), buildBridge(), Bridge, BridgeSource: a prepared target
  frame-source.js    one VideoDecoder over a presentation range, fed in decode order
  clip.js            Clip (the index) + loadClip(url | Blob | bytes)
  loader.js          BufferSource (whole file) and RangeSource (byte windows on demand)
  demux/mp4.js       MP4/MOV: moov → samples, keyframes, pts/dts, avcC/hvcC/vpcC/av1C, esds/dOps/dfLa
  demux/webm.js      WebM/MKV: clusters → blocks, CodecPrivate
  audio.js           AudioEngine: windowed AudioDecoder → sample-accurate scheduling
  probe.js           probeDevice() → a HardwareProfile (optional; never run by the player)
  bridge-probe.js    probeBridgeCompression() → what a compressed bridge would cost here (a record; bridges are raw)
  profiles.js        KNOWN_PROFILES: the devices measured so far; HARDWARE_FLOOR: the device bridges are sized for
  budget.js          canDo(): yes / yes-but / no-and-here-is-the-lever, one action, one profile
  plan.js            plan(): the optimization suite — a plan against one profile or the known group
  index.js           the core (side-effect free); index.d.ts: types
tools/pack.js        re-encode for a seek budget → standard MP4/WebM, verified through the demuxer
tools/serve.js       static server with byte ranges (localhost is a secure context)
tools/run-page.mjs   one demo page headless, muted; prints window.__probe
demo/                index.html (loop / cut / prepare / budget), compat.html (the <video> surface), gesture-probe.html
test/smoke.mjs       demuxers vs ffprobe, a reordering mock decoder, the bridge formula, the budget model, the plan
test/playback.mjs    headless Chromium: the three features, the audio boundary, the <video> surface, play() before a gesture
```

## Quick start

```sh
npm run clips            # ffmpeg generates frame-numbered test clips: packed GOP 12, an ordinary GOP 250 file, VP9/Opus WebM
npm test                 # demuxers vs ffprobe, FrameSource with a reordering mock decoder, the bridge formula, budget, plan
npm run test:playback    # headless Chromium (muted): loop wrap, A 75 → B 438, the bridged cut, audio boundary, the <video> surface
npm run serve            # http://localhost:8080/demo/
```

The test clips have their frame number burned in, so boundaries read straight off the picture:
loop `[30, 90)` shows `A 89 → A 30`; `cutAfter(75, B, 438)` shows `A 75 → B 438`.

## The element

One `<video-hfp>` is one output: a canvas in its shadow root, sized like `<video>` (`width`/`height`
attributes or the clip's own size, `object-fit` honoured, `requestFullscreen()` works because it is
an element, `captureStream()` from the canvas). Many clips, one timeline.

**The `<video>` surface, honestly scoped.** Same meaning: `src`, `width`, `height`, `poster`,
`muted`, `volume`, `loop`, `autoplay`, `playsinline`, `crossorigin`, `preload` (`none` → nothing;
`metadata` → the index; `auto` → the first frame too). `play()` returns a promise that **rejects
with `NotAllowedError`** when the clip has audio and the page has had no gesture, exactly as
`<video>` does (and fires `blocked`); a silent or muted clip plays. `pause()`, `paused`, `ended`,
`duration`, `videoWidth`, `videoHeight`, `readyState`, `networkState`, `currentTime` (seconds, for
compatibility; setting is a seek), `fastSeek`, `requestVideoFrameCallback` (one callback per
presented frame; the metadata carries `frameNumber` and `clip`). Events at the matching moments:
`loadstart`, `durationchange`, `loadedmetadata`, `loadeddata`, `canplay`, `canplaythrough`, `play`,
`playing`, `waiting` (a stall), `pause`, `ended`, `seeking`, `seeked`, `timeupdate`, `volumechange`,
`emptied`, `error`. **`controls` draws the element's own bar** — a drop-in for `<video controls>`:
a scrubber that works in frames and seeks on release, on its own row above play/pause, 10 s back
and forward, the time, mute and full screen; it leaves while playing and comes back on a touch, a
move or a key (space, arrows 5 s, shift+arrow one frame, j/l 10 s, m, f). One set of buttons, and
the page picks the subset with `controlslist`: `framestep` adds the single-frame buttons either
side of play (for frame-by-frame work), `noskip` drops the 10 s skips, `nofullscreen` the
full-screen button. **Removing the element pauses it**, as it pauses a `<video>`, and releases its
decoders, bridges and AudioContext; a move within the page is not a removal, and an element put
back plays again from where it stopped. A `pause()` that comes before a pending `play()` has
started wins: that `play()` rejects with `AbortError`. **`playbackRate`** (0.25–4) scales the clock, keeping the frame on screen
where it is; the audio keeps its pitch through a pitch shifter on the output (`preservesPitch`,
default true; set it false and the pitch moves with the rate, the old-fashioned way); the `ratechange`
event. **Not supported, and setting them throws `NotSupportedError`** so nobody is surprised
quietly: `srcObject`, `mediaKeys`, picture-in-picture, text tracks, remote playback.

**The frame-exact surface** — frames everywhere in our verbs, seconds only above:

```js
v.currentFrame; v.frameRate; v.frameCount; v.clip;          // read
v.seek(frame);                                              // a cold seek while playing; the frame itself while paused
v.play({ from, to, loop });  v.loopRange(from, to);         // attributes: loop-start / loop-end, in frames
const b = await v.open('b.mp4', { name: 'b' });             // a Clip, opened once per URL; a name makes it a target by name
const h = await v.prepare(b, 438);                          // { clip, frame, bridgeFrames, bytes, ready, release() }
v.cut(b, 438);            // now: the next display frame when prepared, else as fast as the device decodes it
v.cutAfter(1527, 'b', 438);  // after the current clip shows 1527, b#438 takes the next slot; returns the boundary time
v.cancelCut();  v.prepared;  v.releaseAll();
```

Events on top of the `<video>` set: `frame` (`clip`, `index`, `p`), `switch` (`fromClip`,
`fromFrame`, `toClip`, `toFrame`), `loop` (a wrap), `stall`, `blocked`, `decoderrefused`.
Declarative clips: children `<hfp-clip name="b" src="b.mp4" prepare-at="438">` are opened (and
prepared) when the element connects; a target may be a Clip, a declared name, or a handle.

`v.engine` is the `Player` behind the element (stats, the AudioContext, the clock); the probe and
the plan are module functions, not element members: the element plays, the tools advise.

## How it works

### The clock

The video clock is the AudioContext's clock **minus the device's output latency**, so a frame is
drawn when its audio is heard — on Bluetooth headphones that is a hundred milliseconds or more
after it was scheduled. Each segment records the player time of its first frame; the frame to
show at time `t` follows from the clip's own frame times (variable-rate files included). Audio
is decoded in windows of a few seconds and every piece is scheduled with
`AudioBufferSourceNode.start(when, offset, duration)` at an absolute time, which is
sample-accurate; a cut is a stop and a start on the same sample with a 3 ms gain ramp so a
hard cut does not click. A silent or muted clip can play before any gesture: the clock runs on
`performance.now()` until the context is running, then hands over without a jump.

### The bridge

A prepared target holds pictures and no decoder. `prepare(clip, frame)` decodes the target's
first N frames with a *software* decoder, copies the planes out (I420/NV12 as the decoder hands
them over, 1.5 bytes a pixel, one buffer per bridge), and releases the decoder. `cut()` plays the
bridge from the next display frame while the decoder that was playing the previous clip is
**re-targeted** (reset, configured for the new clip, started from the keyframe before frame N)
and takes over at N by the same two-source swap the loops use. Nothing is kept between cuts.

N is a formula per target, from the clip's index (complete at load — every frame's keyframe
flag is in the sample table) and a **hardware floor** profile, the slowest device the bridge is
sized for (a four-year-old midrange phone; `HARDWARE_FLOOR` in `profiles.js`, assumed until one
is measured):

```
handoff      = frame + N                                     // where the decoder behind the bridge starts: the keyframe before THIS
run          = handoff − keyBefore(handoff)
bridgeFrames = the smallest N with  N / fps  ≥  floor.decoderRestartMs/1000 + run / floor.decodeFps + floor.marginMs/1000
```

A keyframe inside the bridge shortens the run, so a target late in a long GOP needs far fewer
frames than its own lead-in suggests. On the floor as assumed (restart 250 ms, 150 fps at 1080p,
margin 150 ms): a target on a keyframe needs 12 frames at 30 fps; the last frame of a GOP-250
file 15; the worst frame of a GOP-12 file 15, of a GOP-30 file 18, of a GOP-250 file 62. No
runtime probe, no cap: memory is the caller's and `plan()` says how much — a 15-frame
bridge is 21 MB at 720p and 47 MB at 1080p. Compression was measured on a Mac and a Pixel 9a
(`probeBridgeCompression`, figures on the profiles) and set aside: every form behaved
differently per device, which would have meant a per-device strategy. The bridge is raw.

### Loops and the GOP

A loop re-decodes its lead-in (from the keyframe before `from`) on every wrap. On a packed clip
that is a dozen frames, hidden by the lookahead, and the one decoder wraps on its own. On an
ordinary file with keyframes every 250 frames the lead-in is longer than the lookahead, so the
loop gets a **wrap bridge**: its first frames are parked once (raw, like a prepared target) and
shown at every wrap while the decoder decodes the lead-in behind them and resumes past the
bridge. One decoder, one bridge, no second decoder — a structural fact of the file, no device
assumption, with `bridge: true|false` to force either way. A loop that is shorter than its own
bridge lives on the bridge alone. The one loop that cannot work is one whose lead-in plus its
own length is more decoding than its period allows on the device, and `canDo({ kind: 'loop' })`
says so, with the re-encode that fixes it.

### Memory

Nothing is held whole. Frames are fetched by byte windows (1 MB, LRU-bounded, the loop range
pinned), audio is decoded in windows, and each decoder keeps `lookahead` (default 6) plus the
file's reorder depth of decoded frames. At 1080p a raw frame is ~3 MB; a 15-frame bridge is
47 MB (21 MB at 720p). What adds up is the bridges you prepare and a looping long-GOP clip's
wrap bridge, and the player keeps the total in `stats.memoryBytes`.

Two boundaries, neither a cap: past **500 MB** of frames the player warns, past **1 GB** it
says a crash is likely — once on the console and as a `memory` event (`bytes`, `level`). A page
may hold more; on a phone the operating system's memory killer decides when it is too much, the
foreground app last of all and not gracefully, so the boundaries are where people should know a
crash could happen. The plan reports the same levels for a plan before anyone builds it.

### Three layers size a bridge, each superseding the one below

1. **The baseline.** A floor profile that should hold on any modern device: a four-year-old
   midrange phone, assumed (`HARDWARE_FLOOR`). It ships.
2. **The measurement.** `v.optimize()` runs the probe on the current clip when nothing is playing
   — decode rate, a fresh decoder's start-up, a re-targeted decoder's first frame, the decoder
   count — and from then on bridges are sized from the measured figures with the baseline's margin.
   One measurement serves the whole site: the profile is stored in the origin's localStorage, the
   widest scope a page can reach, and **every new player on the origin starts from it on its own**.
   It is kept until the browser changes (the stored user agent no longer matches). `optimize()`
   with a stored profile answers from it at once; `optimize({ force: true })` measures again;
   `forgetStoredProfile()` clears it.
3. **The observation.** Every hand-off is watched. While the bridge plays, the decoder behind it
   reports when its first frame is queued, so the number of bridge frames actually needed is
   known; a decoder that arrives late shows as stalls in the slots right after the hand-off (the
   screen holds the bridge's last frame, then skips to catch up — the clock never waits). The rule:
   late by k slots → the next bridge is n + k + 2; ready with less than three quarters of the
   bridge used → the next is what was used plus a tenth, at least two frames; never under
   **5 frames**. The result is a scale on the floor's answer (`tune.scale`), stored for the origin
   with the floor it was learned on, so the next page starts where this one left off; a loop's own
   wrap bridge is rebuilt to the exact new length in the background and swapped in at a wrap.
   A fresh measurement resets what was learned. Events: `handoff` (every observation) and `tuned`
   (a change).

On this Mac: the baseline says 13 frames for a GOP-12 target, the measurement says 5, and the
loop on the ordinary file relearns its 33-frame wrap bridge down to 5 after its first wrap.
`stats.floor` says where the floor came from, `stats.bridgeScale` and `stats.tuned` what playback
learned; `v.floor` reads or sets the floor directly.

## Probes, profiles and the plan: tools, not the player

The player holds no device numbers and sets no limits of its own. Nothing probes or plans unless
the app asks:

- `probeDevice(clip)` measures a device with a real clip when nothing is playing and answers a
  **HardwareProfile** (decode rate, a fresh decoder's start-up, a re-targeted decoder's first
  frame, how many decoders the device grants, refresh, platform). `storedProfile()` reads the last
  one kept on this device. `v.optimize()` is the player's own door to it (above).
- `KNOWN_PROFILES` is the record of devices we have measured; add one by running the probe there
  and pasting its object with a label. `HARDWARE_FLOOR` is the device bridges are sized for.
- `plan(spec, profiles)` is the optimization suite: say what you intend — resolution, GOP, how
  many targets prepared at once, how fast a cold switch must land, the loops, how far ahead a
  cut is known — and it reports, per profile, which limits bite and what would lift them.
  `canDo(action)` is the same for one action against one profile and one real clip.
- `probeBridgeCompression(clip)` is the record of what a compressed bridge would cost on a
  device. Bridges are raw; the figures are there for the day that decision is revisited.

The answers are advice for the designer. The player is fully capable of frame-exact cuts
regardless; the suite only says where a device will fall short of a plan.

```js
plan({ width: 1920, height: 1080, fps: 30, gop: 12, prepared: 40 })
// every profile: "memory: CRITICAL — 1791 MB of raw frames (one decoder + 40 bridges of 15 frames), past the 1024 MB boundary"
//   → "fewer": 10 stay under the warning boundary; "re-encode --gop 3"; "lower-resolution"
plan({ width: 1280, height: 720, fps: 30, gop: 12, prepared: 6, switchWithinFrames: 1 })
// Pixel 9a: six bridges fit; "coldSwitch: start-up alone is 122 ms, so no re-encode can meet 33 ms; only a prepared target can"
```

## Packing a clip (advice applied)

```sh
node tools/pack.js input.mp4 out/clip.mp4                    # an ordinary file: source fps, 2 s keyframes, B-frames
node tools/pack.js input.mp4 out/clip.mp4 --seek-budget 30   # any cold seek ≤ ~30 ms on a phone → GOP 12
node tools/pack.js input.mp4 out/clip.mp4 --gop 24 --height 720
node tools/pack.js input.mp4 out/clip.webm --codec vp9       # VP9 + Opus in WebM
```

What a short GOP costs, measured on 30 s of real 720p30 footage at CRF 18, video only, against
streaming defaults (High profile, GOP 250, 3 B-frames, 5,443 kbps):

| GOP | bitrate | worst-case cold seek on this Mac (2 ms/decode + 5 ms) | bridge at 30 fps, on the floor |
|---|---|---|---|
| 250 | +0% | ~500 ms | 62 frames |
| 48 | +36% (without B-frames) / about +10% with | ~100 ms | 22 frames |
| 24 | +48% / about +20% | ~55 ms | 17 frames |
| 12 | +68% / +38% | 29 ms | 15 frames |
| 1, all-intra | +260% | 5 ms | 12 frames |

The player reads B-frames, so keep them: dropping them costs ~30% and buys nothing. The rule:
**prepare before you cut; buy a seek budget only for cuts you cannot prepare.** A short GOP also
makes every bridge shorter. The packer prints the GOP it chose, the bitrate cost and the expected
worst-case seek, and verifies the output through the player's own demuxer.

## Support

| platform | status |
|---|---|
| Chrome / Edge / WebView2 | verified in headless Chromium 151 (software and hardware decode), 2026-10-22 |
| Android WebView (inside an app) | the engine **verified on a Pixel 9a, 2026-10-20**: a 1080p GOP-30 phone recording over byte ranges, 802 frames in 42 s, zero drops, zero stalls (hardware decode 124 fps at 1080p, 122 ms start-up, output latency 24 ms); the element and the bridged cut: not yet on the phone |
| Safari 16.4+ / WKWebView (macOS, iOS) | **untested** — the avcC description and AVC-format chunks it needs are in place |
| Firefox 130+ desktop | untested; Firefox for Android has no WebCodecs |
| WebKitGTK ≥ 2.44 (Tauri on Linux) | untested; codecs depend on GStreamer plugins (VP9 is always there, H.264 needs `gstreamer1.0-libav` or VA-API) |

A secure context is required (https, localhost, or an app's own scheme); `probeSupport()` reports
`secureContext` first because a LAN IP over http is the usual reason `videoDecoder` is false.
Audio codecs through `AudioDecoder`: AAC, Opus, MP3, FLAC; anything else falls back to decoding
the whole file with `decodeAudioData`.

## Limits that remain, and what they cost

- **DRM** — no. Protected content is readable only by the browser's own pipeline.
- **A codec the device does not decode** — no, until a WebAssembly decoder is added (slow, large).
- **HDR / wide colour** — plays, mapped to SDR by the 2D canvas.
- **Rotation** — a phone's portrait recording (a 90° display matrix) draws upright; `clip.rotation`, and the
  element's `videoWidth`/`videoHeight` are the upright size.
- **Fragmented MP4** (`moof`) — not yet; remux progressive (`-movflags +faststart`).
- **WebM opens with one pass over the file** (Matroska has no central sample table); MP4 opens on its `moov`.
- **Presentation** — a `<video>` can sit on a hardware overlay with the page idle; this draws
  every frame into a canvas and wakes JavaScript each display frame. Expect more battery on
  phones, and no native picture-in-picture or AirPlay.
- **Decoder instances** — one per playing clip, loops included (a long lead-in costs a bridge, not a
  decoder); a bridged cut takes none extra (the playing decoder re-targets). A cold cut while
  nothing plays takes one. Phones grant a handful; the probe measures how many.
- **Memory** — bridges are raw, by ruling; forty prepared 1080p targets are 1.9 GB, past the critical
  boundary. The plan says so, and names the GOP, resolution and count levers.
- **Playback rate** — at 2× a 30 fps clip wants a new media frame every display frame of a 60 Hz
  screen, so a late display frame drops a media frame; `dropped` counts them (the display's doing,
  not the decoder's). The pitch shifter is granular: fine for speech and music at ½–2×, audible
  past that.
- **Unmuting mid-play before a gesture** — a muted clip with audio runs on the wall clock; once
  the context starts, its already-scheduled audio pieces are late and are trimmed until the next segment.

## Verified

`npm run test:playback`, headless Chromium 151 on an Apple-silicon Mac, software and hardware
decode, muted, through the element: for the packed pair, the ordinary GOP-250 file with B-frames,
and VP9/Opus in WebM — loop `[30, 90)` wraps `A 89 → A 30` with no reversal and no skip;
`cutAfter(75, B, 438)` produces the exact pair `A 75 → B 438` with B contiguous after, the picture
boundary within one display frame of the scheduled time and the audio boundary (440 → 880 Hz)
within one analyser window (~20 ms) of it; `prepare(B, 200)` holds a 13-frame bridge and no
decoder, `cut(B, 200)` shows `B 200` on the next display frame and the re-targeted decoder takes
over after the bridge with no stall; the loop `[200, 260)` on the ordinary file runs on one decoder
plus a wrap bridge and wraps `A 259 → A 200` with no stall after its cold start; zero frames dropped. `compat.html`: an attributes-only
`<video-hfp src autoplay loop loop-start="30" loop-end="90" muted>` loops with no script, the
events come in `<video>`'s order, `playbackRate` and friends throw, pause/seek/resume land on the
frame. `gesture-probe.html`: `play()` on audio before a gesture rejects with `NotAllowedError`;
muted, it plays on the wall clock. `npm test`: the demuxers agree with ffprobe on every packet of
every test clip; the bridge formula; the budget model; the plan. GitHub CI (Ubuntu, Playwright's
Linux Chromium, which has no H.264 decoder): `npm test` and the VP9/Opus and Worker pairings
pass; the H.264 pairings are reported as skipped there.

## Contributing

Not yet: the project is in beta and not taking outside changes (see CONTRIBUTING.md). Bug
reports and device results as issues are welcome.

## Where to take it next

- A controls bar of our own (frame stepping, the loop range, the prepared targets).
- Render with WebGL/WebGPU for colour management and HDR.
- Variable rate and reverse playback.
- Measure the hardware floor on a Pixel 6a / iPhone SE 2022 (then the "assumed" note goes).
