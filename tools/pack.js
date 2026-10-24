#!/usr/bin/env node
// pack.js — re-encode a video for a seek budget, into a standard MP4 (H.264 / HEVC) or WebM (VP9),
// and verify the result reads back through the player's own demuxer.
//
//   node tools/pack.js input.mp4 out.mp4 [options]
//
// The player plays ordinary files. Packing is ADVICE applied: it buys a bounded cold seek (any
// frame costs at most one GOP of decoding) at a bitrate cost. Measured on real 720p30 footage at
// CRF 18 vs streaming defaults: GOP 48 +36%, GOP 24 +48%, GOP 12 +68%, all-intra +260%;
// dropping B-frames costs another ~30% on top and buys nothing the player needs.
//
// Options:
//   --seek-budget N   worst-case cold seek in ms the file should allow; picks the GOP from --decode-fps
//   --gop N           keyframe interval in frames (explicit form; 1 = all-intra). Default: 2 s of frames
//   --decode-fps N    the target device's decode rate used by --seek-budget (default 300: a phone)
//   --fps N|N/D       output frame rate (default: the source's; resampling is reported)
//   --height N        scale to this height, keeping aspect (default: source)
//   --codec h264|hevc|vp9   (default: h264 → MP4; vp9 → WebM)
//   --crf N           quality (default: 18 for h264/hevc, 30 for vp9)
//   --bframes N       B-frames (default: 3 for h264/hevc; the player reads them)
//   --audio aac|opus|flac|copy|none   (default: aac in MP4, opus in WebM)
//   --ffmpeg PATH     ffmpeg binary (ffprobe is derived from it)
//   --json            print the result as JSON

import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { demuxMp4 } from '../src/demux/mp4.js';
import { demuxWebm } from '../src/demux/webm.js';
import { BufferSource } from '../src/loader.js';
import { Clip } from '../src/clip.js';
import { bitrateCostForGop } from '../src/budget.js';

function parseArgs(argv) {
  const opts = { 'seek-budget': 0, gop: 0, 'decode-fps': 300, fps: '', height: 0, codec: 'h264', crf: 0, bframes: -1, audio: '', ffmpeg: 'ffmpeg', json: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { opts.json = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2); const val = argv[++i];
      if (!(key in opts)) throw new Error(`unknown option --${key}`);
      opts[key] = typeof opts[key] === 'number' ? Number(val) : val;
    } else pos.push(a);
  }
  if (pos.length !== 2) { console.error('usage: node tools/pack.js <input> <output.mp4|.webm> [--seek-budget ms | --gop N] [--fps N] [--height N] [--codec h264|hevc|vp9] [--crf N] [--bframes N] [--audio aac|opus|flac|copy|none]'); process.exit(2); }
  return { input: pos[0], output: pos[1], ...opts };
}

function run(bin, args) {
  const r = spawnSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')}\nexited ${r.status}:\n${r.stderr.toString().slice(-4000)}`);
  return r.stdout.toString();
}
function probe(ffprobe, file) {
  const json = JSON.parse(run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
  return { video: json.streams.find((s) => s.codec_type === 'video'), audio: json.streams.find((s) => s.codec_type === 'audio'), format: json.format };
}
const ratio = (s) => { const m = /^(\d+)(?:\/(\d+))?$/.exec(String(s)); return m ? [Number(m[1]), Number(m[2] || 1)] : null; };

/** Seek budget (ms) → GOP, for a decode rate: budget covers start-up (~5 ms) plus GOP decodes. */
export function gopForBudget(budgetMs, decodeFps) { return Math.max(1, Math.floor((budgetMs - 5) / 1000 * decodeFps)); }

export function pack(o) {
  const ffprobe = o.ffmpeg.replace(/ffmpeg([^/\\]*)$/, 'ffprobe$1');
  const src = probe(ffprobe, o.input);
  if (!src.video) throw new Error('input has no video stream');
  const ext = path.extname(o.output).toLowerCase();
  const container = ext === '.webm' ? 'webm' : 'mp4';
  if (o.codec === 'vp9' && container !== 'webm') throw new Error('vp9 output must be a .webm');
  if (o.codec !== 'vp9' && container !== 'mp4') throw new Error(`${o.codec} output must be a .mp4`);
  mkdirSync(path.dirname(path.resolve(o.output)), { recursive: true });

  // frame rate: the source's unless asked
  const srcRate = ratio(src.video.avg_frame_rate && src.video.avg_frame_rate !== '0/0' ? src.video.avg_frame_rate : src.video.r_frame_rate) || [30, 1];
  const outRate = o.fps ? ratio(o.fps) : srcRate;
  if (!outRate) throw new Error(`bad --fps ${o.fps}`);
  const fps = outRate[0] / outRate[1];
  const resampled = o.fps && Math.abs(outRate[0] / outRate[1] - srcRate[0] / srcRate[1]) > 1e-6;
  const vfr = src.video.avg_frame_rate && src.video.r_frame_rate && src.video.avg_frame_rate !== src.video.r_frame_rate;
  if (vfr && !o.fps) console.error(`note: the source looks variable-rate (${src.video.r_frame_rate} vs ${src.video.avg_frame_rate}); output is constant ${outRate.join('/')} fps — pass --fps to choose`);
  if (resampled) console.error(`note: resampling ${srcRate.join('/')} → ${outRate.join('/')} fps (frames duplicated or dropped)`);

  // GOP: explicit, from a seek budget, or a plain 2-second streaming interval
  let gop = o.gop || (o['seek-budget'] ? gopForBudget(o['seek-budget'], o['decode-fps']) : Math.round(fps * 2));
  const bframes = o.bframes >= 0 ? o.bframes : (o.codec === 'vp9' ? 0 : 3);
  const crf = o.crf || (o.codec === 'vp9' ? 30 : 18);
  const vf = o.height ? ['-vf', `scale=-2:${o.height}`] : [];
  const audio = o.audio || (container === 'webm' ? 'opus' : 'aac');
  const audioArgs = !src.audio || audio === 'none' ? ['-an']
    : audio === 'copy' ? ['-c:a', 'copy']
    : audio === 'aac' ? ['-c:a', 'aac', '-b:a', '160k']
    : audio === 'opus' ? ['-c:a', 'libopus', '-b:a', '128k']
    : audio === 'flac' ? ['-c:a', 'flac']
    : (() => { throw new Error(`unknown audio ${audio}`); })();
  const common = ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-i', o.input, '-sn', '-dn', ...vf,
    '-r', `${outRate[0]}/${outRate[1]}`, '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p',
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0'];
  let video;
  if (o.codec === 'h264') video = ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-bf', String(bframes), '-flags', '+cgop', '-x264-params', `open-gop=0:scenecut=0:keyint=${gop}:min-keyint=${gop}`];
  else if (o.codec === 'hevc') video = ['-c:v', 'libx265', '-preset', 'medium', '-crf', String(crf), '-tag:v', 'hvc1', '-x265-params', `open-gop=0:scenecut=0:keyint=${gop}:min-keyint=${gop}:bframes=${bframes}`];
  else if (o.codec === 'vp9') video = ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(crf), '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-auto-alt-ref', '0', '-lag-in-frames', '0'];
  else throw new Error(`unknown codec ${o.codec}`);
  const mux = container === 'mp4' ? ['-movflags', '+faststart'] : [];
  run(o.ffmpeg, [...common, ...video, ...audioArgs, ...mux, o.output]);

  // verify through the player's own demuxer
  return verify(o.output).then((v) => ({ output: o.output, container, codec: v.codec, width: v.width, height: v.height, fps: v.fps, frames: v.frameCount, keyframes: v.keyframes, gop: v.gop, reorderDepth: v.reorderDepth,
    audio: v.audio, bytes: v.bytes, durationSec: v.duration, askedGop: gop, bitrateCost: bitrateCostForGop(gop), seekWorstCaseMs: o['seek-budget'] ? Math.round(5 + gop / o['decode-fps'] * 1000) : null }));
}

export async function verify(file) {
  const bytes = new Uint8Array(readFileSync(file));
  const src = new BufferSource(bytes);
  const index = file.toLowerCase().endsWith('.webm') || file.toLowerCase().endsWith('.mkv') ? await demuxWebm(src) : await demuxMp4(src);
  const clip = new Clip(index, src, { name: path.basename(file) });
  if (!clip.isKeyframe(0)) throw new Error('first frame is not a keyframe');
  return { ...clip.describe(), reorderDepth: clip.reorderDepth, bytes: bytes.length, keyframes: clip.keyframes.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const o = parseArgs(process.argv.slice(2));
  pack(o).then((r) => { console.log(o.json ? JSON.stringify(r) : JSON.stringify(r, null, 2)); }, (e) => { console.error(e.message); process.exit(1); });
}
