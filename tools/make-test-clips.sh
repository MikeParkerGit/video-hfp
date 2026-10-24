#!/usr/bin/env bash
# Generates two 20 s test clips with the frame number burned in and a beep every second, and
# packs them several ways:
#   A.mp4 / B.mp4            H.264 + AAC, GOP 12, B-frames kept — the "strict" shape (instant cold seeks)
#   A-vp9.webm / B-vp9.webm  VP9 + Opus, GOP 12 — the fallback for Linux without an H.264 plugin
#   A-normal.mp4             H.264 + AAC, GOP 250, 3 B-frames — an ORDINARY streaming-style file
# Clip A: testsrc2 / 440 Hz.  Clip B: hue-shifted / 880 Hz.  ~3 minutes on a laptop.
# The label is rendered by tools/frame-labels.mjs and overlaid, so ffmpeg needs libx264, libvpx,
# aac and libopus but NOT libfreetype.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p demo/clips
FPS=30; DUR=20; LABEL_SIZE=640x160
gen() { # name hue-shift freq
  node tools/frame-labels.mjs "$1" $((FPS * DUR)) ${LABEL_SIZE/x/ } | ffmpeg -nostdin -y -hide_banner -loglevel error \
    -f lavfi -i "testsrc2=size=1280x720:rate=$FPS:duration=$DUR" \
    -f lavfi -i "sine=frequency=$3:beep_factor=4:duration=$DUR" \
    -f rawvideo -pix_fmt rgba -video_size $LABEL_SIZE -framerate $FPS -i pipe:0 \
    -filter_complex "[0:v]hue=h=$2[bg];[bg][2:v]overlay=(W-w)/2:(H-h)/2:shortest=1[v]" -map "[v]" -map 1:a \
    -c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "demo/clips/$1-src.mp4"
}
gen A 0 440
gen B 180 880
for n in A B; do
  node tools/pack.js demo/clips/$n-src.mp4 demo/clips/$n.mp4      --gop 12 --json &
  node tools/pack.js demo/clips/$n-src.mp4 demo/clips/$n-vp9.webm --gop 12 --codec vp9 --json &
done
node tools/pack.js demo/clips/A-src.mp4 demo/clips/A-normal.mp4 --gop 250 --json &
wait
ls -la demo/clips
