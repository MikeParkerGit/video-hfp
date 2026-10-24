#!/usr/bin/env node
// frame-labels.mjs — the burned-in "A  123" label of every test frame as a raw RGBA stream,
// one picture per frame number, for ffmpeg to overlay on the test pattern. It replaces
// drawtext, so generating the test clips no longer needs an ffmpeg built with libfreetype
// (Homebrew's on macOS is not).
//
//   node tools/frame-labels.mjs <label> <frames> <width> <height> \
//     | ffmpeg -f rawvideo -pix_fmt rgba -video_size <width>x<height> -framerate 30 -i pipe:0 ...
//
// Frame n carries the text "<label>  n" in a chunky 5x7 bitmap font, white with a black
// border, centred; everything else is transparent.
import { once } from 'node:events';
import { stdout } from 'node:process';

const [label = 'A', framesArg = '600', wArg = '640', hArg = '160'] = process.argv.slice(2);
const frames = Number(framesArg), W = Number(wArg), H = Number(hArg);
if (!(frames > 0 && W > 0 && H > 0)) { console.error('usage: frame-labels.mjs <label> <frames> <width> <height>'); process.exit(2); }

// 5x7 glyphs, rows top to bottom; '1' = lit cell
const FONT = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
};
const glyph = (ch) => FONT[ch] ?? FONT['?'];

const BORDER = 5;                                   // px of black around every lit cell
const longest = `${label}  ${frames - 1}`.length;
const cellsWide = longest * 6 - 1;                  // 5 cells + 1 gap per glyph, no trailing gap
const S = Math.max(2, Math.min(16, Math.floor((W - 2 * BORDER) / cellsWide), Math.floor((H - 2 * BORDER) / 7)));

function rect(buf, x0, y0, w, h, r, g, b) {
  const x1 = Math.min(W, x0 + w), y1 = Math.min(H, y0 + h);
  for (let y = Math.max(0, y0); y < y1; y++) {
    let i = (y * W + Math.max(0, x0)) * 4;
    for (let x = Math.max(0, x0); x < x1; x++, i += 4) { buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255; }
  }
}

function render(text) {
  const buf = new Uint8Array(W * H * 4);            // transparent black
  const textW = (text.length * 6 - 1) * S;
  const x0 = Math.floor((W - textW) / 2), y0 = Math.floor((H - 7 * S) / 2);
  const cells = [];
  for (let c = 0; c < text.length; c++) {
    const rows = glyph(text[c]);
    for (let r = 0; r < 7; r++) for (let k = 0; k < 5; k++) if (rows[r][k] === '1') cells.push([x0 + (c * 6 + k) * S, y0 + r * S]);
  }
  for (const [x, y] of cells) rect(buf, x - BORDER, y - BORDER, S + 2 * BORDER, S + 2 * BORDER, 0, 0, 0);
  for (const [x, y] of cells) rect(buf, x, y, S, S, 255, 255, 255);
  return buf;
}

for (let n = 0; n < frames; n++) {
  if (!stdout.write(render(`${label}  ${n}`))) await once(stdout, 'drain');
}
stdout.end();
