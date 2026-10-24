// MP4 / MOV demuxer: reads the `moov` box and turns the sample tables into the index the
// player wants — video samples in decode order with presentation times and keyframe flags, the
// decoder config (codec string + description), and the audio track's samples and config.
// Progressive files only (a `moov`, no `moof` fragments). Reads through a ByteSource, so a
// faststart file costs two small range requests; a file with its moov at the end costs one more.
//
// Boxes read: ftyp moov mvhd trak tkhd (the display matrix → rotation) edts/elst mdia mdhd hdlr minf stbl stsd (avc1 avc3 hvc1
// hev1 vp09 av01 | mp4a Opus fLaC) stts ctts stss stsz stz2 stsc stco co64. Everything else is skipped.

const td = new TextDecoder();
const fourcc = (b, o) => td.decode(b.subarray(o, o + 4));
const u8 = (b, o) => b[o];
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const i32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const hex2 = (n) => n.toString(16).padStart(2, '0');

/** Iterate the child boxes of a byte range: yields { type, start (payload), end, headerSize }. */
function* boxes(b, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    const type = fourcc(b, p + 4);
    let hdr = 8;
    if (size === 1) { size = u64(b, p + 8); hdr = 16; } else if (size === 0) size = end - p;
    if (size < hdr) throw new Error(`mp4: bad box size for ${type}`);
    yield { type, start: p + hdr, end: Math.min(p + size, end), hdr };
    p += size;
  }
}
const child = (b, start, end, type) => { for (const x of boxes(b, start, end)) if (x.type === type) return x; return null; };
const fullBox = (b, s) => ({ version: u8(b, s), flags: u24(b, s + 1), p: s + 4 });

/**
 * Find the moov box through a ByteSource and parse it.
 * @param {{ size: number, read(offset: number, length: number): Promise<Uint8Array> }} src
 */
export async function demuxMp4(src) {
  let p = 0;
  let moov = null;
  while (p + 8 <= src.size) {
    const head = await src.read(p, Math.min(16, src.size - p));
    let size = u32(head, 0);
    const type = fourcc(head, 4);
    let hdr = 8;
    if (size === 1) { size = u64(head, 8); hdr = 16; } else if (size === 0) size = src.size - p;
    if (type === 'moof') throw new Error('mp4: fragmented MP4 (moof) is not supported — remux progressive: ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4');
    if (type === 'moov') { moov = { payload: await src.read(p + hdr, size - hdr) }; break; }
    p += size;
  }
  if (!moov) throw new Error('mp4: no moov box found');
  return parseMoov(moov.payload);
}

/** Parse a moov payload (synchronous, for callers that already hold it). */
export function parseMoov(b) {
  const end = b.length;
  if (child(b, 0, end, 'mvex')) throw new Error('mp4: fragmented MP4 (mvex) is not supported');
  const mvhd = child(b, 0, end, 'mvhd');
  let movieTimescale = 1000, movieDuration = 0;
  if (mvhd) {
    const { version, p } = fullBox(b, mvhd.start);
    if (version === 1) { movieTimescale = u32(b, p + 16); movieDuration = u64(b, p + 20); } else { movieTimescale = u32(b, p + 8); movieDuration = u32(b, p + 12); }
  }
  const out = { container: 'mp4', duration: movieDuration / movieTimescale, video: null, audio: null };
  for (const trak of boxes(b, 0, end)) {
    if (trak.type !== 'trak') continue;
    const t = parseTrak(b, trak.start, trak.end);
    if (!t) continue;
    if (t.kind === 'video' && !out.video) out.video = t;
    else if (t.kind === 'audio' && !out.audio) out.audio = t;
  }
  if (!out.video) throw new Error('mp4: no video track');
  if (!out.duration) out.duration = out.video.duration;
  return out;
}

function parseTrak(b, s, e) {
  const mdia = child(b, s, e, 'mdia');
  if (!mdia) return null;
  const hdlr = child(b, mdia.start, mdia.end, 'hdlr');
  const handler = hdlr ? fourcc(b, hdlr.start + 8) : '';
  if (handler !== 'vide' && handler !== 'soun') return null;
  const mdhd = child(b, mdia.start, mdia.end, 'mdhd');
  const { version: mv, p: mp } = fullBox(b, mdhd.start);
  const timescale = mv === 1 ? u32(b, mp + 16) : u32(b, mp + 8);
  const mediaDuration = mv === 1 ? u64(b, mp + 20) : u32(b, mp + 12);
  const minf = child(b, mdia.start, mdia.end, 'minf');
  const stbl = child(b, minf.start, minf.end, 'stbl');
  const tables = {};
  for (const x of boxes(b, stbl.start, stbl.end)) tables[x.type] = x;

  // ---- the track header's display matrix: a phone's portrait recording is stored sideways with a 90°
  // matrix, and <video> applies it. Points map as x' = a·x + c·y, y' = b·x + d·y (16.16 fixed), so the
  // clockwise angle the frame must be turned for display is atan2(b, a); only the four right angles count.
  let rotation = 0;
  const tkhd = child(b, s, e, 'tkhd');
  if (tkhd) {
    const { version, p } = fullBox(b, tkhd.start);
    const m = p + (version === 1 ? 32 : 20) + 16;   // past the ids and times, then reserved/layer/group/volume/reserved
    const ma = i32(b, m) / 65536, mb = i32(b, m + 4) / 65536;
    const deg = ((Math.round(Math.atan2(mb, ma) * 180 / Math.PI) % 360) + 360) % 360;
    if (deg === 90 || deg === 180 || deg === 270) rotation = deg;
  }

  // ---- edit list: how much of the media's start is not presented (AAC priming, B-frame delay)
  let editOffset = 0;   // media seconds to skip at the start
  let emptyEdit = 0;    // seconds of silence/blank before the media starts (rare)
  const edts = child(b, s, e, 'edts');
  if (edts) {
    const elst = child(b, edts.start, edts.end, 'elst');
    if (elst) {
      const { version, p } = fullBox(b, elst.start);
      const n = u32(b, p);
      let q = p + 4;
      for (let i = 0; i < n; i++) {
        const segDur = version === 1 ? u64(b, q) : u32(b, q);
        const mediaTime = version === 1 ? Number(BigInt.asIntN(64, (BigInt(u32(b, q + 8)) << 32n) | BigInt(u32(b, q + 12)))) : i32(b, q + 4);
        q += version === 1 ? 20 : 12;
        if (i === 0 && mediaTime === -1) emptyEdit = segDur / 1000; // movie timescale is usually 1000; close enough for a warning-level value
        else if (mediaTime > 0 && editOffset === 0) editOffset = mediaTime / timescale;
      }
    }
  }

  // ---- sample entry
  const stsd = tables.stsd;
  const { p: sp } = fullBox(b, stsd.start);
  const entry = [...boxes(b, sp + 4, stsd.end)][0];
  if (!entry) return null;
  const common = { kind: handler === 'vide' ? 'video' : 'audio', timescale, duration: mediaDuration / timescale, editOffset, emptyEdit };
  const track = handler === 'vide' ? { ...common, rotation, ...videoEntry(b, entry) } : { ...common, ...audioEntry(b, entry) };
  if (!track.codec) return null;

  // ---- sample tables → per-sample offset/size/dts/pts/key
  const sizes = sampleSizes(b, tables);
  const n = sizes.length;
  const offsets = sampleOffsets(b, tables, n);
  const dts = new Float64Array(n), dur = new Float64Array(n);
  { const { p } = fullBox(b, tables.stts.start); const cnt = u32(b, p); let q = p + 4, i = 0, t = 0;
    for (let k = 0; k < cnt && i < n; k++) { const c = u32(b, q), d = u32(b, q + 4); q += 8; for (let j = 0; j < c && i < n; j++, i++) { dts[i] = t; dur[i] = d; t += d; } }
    for (; i < n; i++) { dts[i] = t; dur[i] = dur[i - 1] || 0; t += dur[i]; } }
  const pts = new Float64Array(n);
  if (tables.ctts) {
    const { version, p } = fullBox(b, tables.ctts.start); const cnt = u32(b, p); let q = p + 4, i = 0;
    for (let k = 0; k < cnt && i < n; k++) { const c = u32(b, q), o = version === 1 ? i32(b, q + 4) : u32(b, q + 4); q += 8; for (let j = 0; j < c && i < n; j++, i++) pts[i] = dts[i] + o; }
    for (; i < n; i++) pts[i] = dts[i];
  } else for (let i = 0; i < n; i++) pts[i] = dts[i];
  const key = new Uint8Array(n);
  if (tables.stss) { const { p } = fullBox(b, tables.stss.start); const cnt = u32(b, p); for (let k = 0; k < cnt; k++) { const idx = u32(b, p + 4 + k * 4) - 1; if (idx >= 0 && idx < n) key[idx] = 1; } }
  else key.fill(1);
  const scale = 1 / timescale;
  const samples = new Array(n);
  // Presentation times have the edit list applied (what a player shows at t = 0), so a track with an
  // initial edit (B-frame delay, AAC priming) starts at 0 and its trimmed lead-in sits below 0.
  for (let i = 0; i < n; i++) samples[i] = { offset: offsets[i], size: sizes[i], dts: dts[i] * scale - editOffset, pts: pts[i] * scale - editOffset, duration: dur[i] * scale, durationUnits: dur[i], key: key[i] === 1 };
  track.samples = samples;
  track.timescale = timescale;
  return track;
}

function sampleSizes(b, t) {
  if (t.stsz) { const { p } = fullBox(b, t.stsz.start); const fixed = u32(b, p), n = u32(b, p + 4); const out = new Array(n); for (let i = 0; i < n; i++) out[i] = fixed || u32(b, p + 8 + i * 4); return out; }
  if (t.stz2) { const { p } = fullBox(b, t.stz2.start); const fs = u8(b, p + 3), n = u32(b, p + 4); const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = fs === 16 ? u16(b, p + 8 + i * 2) : fs === 8 ? u8(b, p + 8 + i) : (u8(b, p + 8 + (i >> 1)) >> (i & 1 ? 0 : 4)) & 15; return out; }
  throw new Error('mp4: no stsz/stz2');
}

function sampleOffsets(b, t, n) {
  const co = t.stco || t.co64;
  if (!co || !t.stsc) throw new Error('mp4: no stco/co64 or stsc');
  const { p: cp } = fullBox(b, co.start); const chunkCount = u32(b, cp);
  const chunkOff = (i) => (t.co64 ? u64(b, cp + 4 + i * 8) : u32(b, cp + 4 + i * 4));
  const { p: sp } = fullBox(b, t.stsc.start); const runs = u32(b, sp);
  const sizes = sampleSizes(b, t);
  const out = new Array(n);
  let sample = 0;
  for (let r = 0; r < runs; r++) {
    const first = u32(b, sp + 4 + r * 12), per = u32(b, sp + 8 + r * 12);
    const next = r + 1 < runs ? u32(b, sp + 4 + (r + 1) * 12) : chunkCount + 1;
    for (let c = first; c < next && sample < n; c++) {
      let off = chunkOff(c - 1);
      for (let k = 0; k < per && sample < n; k++, sample++) { out[sample] = off; off += sizes[sample]; }
    }
  }
  return out;
}

// ---- sample entries -----------------------------------------------------------------------

function videoEntry(b, entry) {
  const s = entry.start;
  const width = u16(b, s + 24), height = u16(b, s + 26);
  const kids = [...boxes(b, s + 78, entry.end)];
  const find = (type) => kids.find((k) => k.type === type);
  const out = { format: entry.type, codedWidth: width, codedHeight: height, codec: null, description: undefined };
  const pasp = find('pasp');
  if (pasp) { const h = u32(b, pasp.start), v = u32(b, pasp.start + 4); if (h && v && h !== v) out.pixelAspect = h / v; }
  switch (entry.type) {
    case 'avc1': case 'avc3': { const c = find('avcC'); if (!c) return out; const d = b.subarray(c.start, c.end);
      out.codec = `avc1.${hex2(d[1])}${hex2(d[2])}${hex2(d[3])}`; out.description = d; break; }
    case 'hvc1': case 'hev1': { const c = find('hvcC'); if (!c) return out; const d = b.subarray(c.start, c.end);
      out.codec = hevcCodecString(d, entry.type); out.description = d; break; }
    case 'vp09': case 'vp08': { const c = find('vpcC'); const d = c ? b.subarray(c.start, c.end) : null;
      // vpcC is a full box: version(1) flags(3) profile(1) level(1) bitDepth:4 chroma:3 range:1 ...
      const profile = d ? d[4] : 0, level = d ? d[5] : 10, bitDepth = d ? d[6] >> 4 : 8;
      out.codec = entry.type === 'vp08' ? 'vp8' : `vp09.${String(profile).padStart(2, '0')}.${String(level).padStart(2, '0')}.${String(bitDepth).padStart(2, '0')}`; break; }
    case 'av01': { const c = find('av1C'); if (!c) return out; const d = b.subarray(c.start, c.end);
      const profile = d[1] >> 5, level = d[1] & 31, tier = d[2] >> 7, high = (d[2] >> 6) & 1, twelve = (d[2] >> 5) & 1;
      const depth = twelve ? 12 : high ? 10 : 8;
      out.codec = `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`; break; }
    default: out.codec = null;
  }
  return out;
}

function hevcCodecString(d, type) {
  // hvcC: version(1) [profile_space:2 tier:1 profile_idc:5] compat(4) constraints(6) level(1) ...
  const space = d[1] >> 6, tier = (d[1] >> 5) & 1, profile = d[1] & 31;
  let compat = u32(d, 2) >>> 0, rev = 0;
  for (let i = 0; i < 32; i++) rev |= ((compat >>> i) & 1) << (31 - i);
  const constraints = [...d.subarray(6, 12)];
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
  const level = d[12];
  return `${type}.${['', 'A', 'B', 'C'][space]}${profile}.${(rev >>> 0).toString(16).toUpperCase()}.${tier ? 'H' : 'L'}${level}${constraints.map((c) => '.' + c.toString(16).toUpperCase()).join('')}`;
}

function audioEntry(b, entry) {
  const s = entry.start;
  const version = u16(b, s + 8);
  let channels = u16(b, s + 16), sampleRate = u32(b, s + 24) / 65536;
  let kidsStart = s + 28;
  if (version === 1) kidsStart += 16;
  else if (version === 2) { kidsStart = s + 64; sampleRate = new DataView(b.buffer, b.byteOffset + s + 32, 8).getFloat64(0); channels = u32(b, s + 40); }
  const kids = [...boxes(b, kidsStart, entry.end)];
  const find = (type) => kids.find((k) => k.type === type);
  const out = { format: entry.type, codec: null, sampleRate, channels, description: undefined, preSkip: 0 };
  switch (entry.type) {
    case 'mp4a': {
      let esds = find('esds');
      if (!esds) { const wave = find('wave'); if (wave) esds = child(b, wave.start, wave.end, 'esds'); }
      if (!esds) return out;
      const asc = parseEsds(b, esds.start + 4, esds.end);
      if (!asc) return out;
      if (asc.objectType === 0x6b || asc.objectType === 0x69) { out.codec = 'mp3'; break; }
      const aot = asc.dsi ? (asc.dsi[0] >> 3) : 2;
      out.codec = `mp4a.40.${aot === 31 && asc.dsi.length > 1 ? 32 + (((asc.dsi[0] & 7) << 3) | (asc.dsi[1] >> 5)) : aot}`;
      out.description = asc.dsi;
      if (asc.dsi) { const sr = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][((asc.dsi[0] & 7) << 1) | (asc.dsi[1] >> 7)]; if (sr) out.sampleRate = sr; const ch = (asc.dsi[1] >> 3) & 15; if (ch) out.channels = ch === 7 ? 8 : ch; }
      break; }
    case 'Opus': { const c = find('dOps'); if (!c) return out; const d = b.subarray(c.start, c.end);
      // dOps (big-endian) → OpusHead (little-endian), the description WebCodecs wants
      const head = new Uint8Array(19 + (d[8] ? 2 + d[1] : 0));
      head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); head[8] = 1; head[9] = d[1];
      head[10] = d[3]; head[11] = d[2];                                   // pre-skip LE
      head[12] = d[7]; head[13] = d[6]; head[14] = d[5]; head[15] = d[4]; // input sample rate LE
      head[16] = d[9]; head[17] = d[8];                                   // output gain LE
      head[18] = d[10]; if (d[10]) head.set(d.subarray(11, 11 + 2 + d[1]), 19);
      out.codec = 'opus'; out.description = head; out.preSkip = u16(d, 2); out.sampleRate = 48000; out.channels = d[1]; break; }
    case 'fLaC': { const c = find('dfLa'); if (!c) return out; const blocks = b.subarray(c.start + 4, c.end);
      const desc = new Uint8Array(4 + blocks.length); desc.set([0x66, 0x4c, 0x61, 0x43], 0); desc.set(blocks, 4);
      out.codec = 'flac'; out.description = desc; break; }
    case 'lpcm': case 'sowt': case 'twos': case 'ipcm': out.codec = null; break;
    default: out.codec = null;
  }
  return out;
}

/** ES_Descriptor → { objectType, dsi } (the DecoderSpecificInfo = AudioSpecificConfig for AAC). */
function parseEsds(b, p, end) {
  const len = () => { let n = 0; for (let i = 0; i < 4; i++) { const c = b[p++]; n = (n << 7) | (c & 127); if (!(c & 128)) break; } return n; };
  if (b[p++] !== 0x03) return null; len(); p += 2; const flags = b[p++];
  if (flags & 0x80) p += 2; if (flags & 0x40) p += 1 + b[p]; if (flags & 0x20) p += 2;
  if (b[p++] !== 0x04) return null; const dcdLen = len(); const dcdEnd = p + dcdLen;
  const objectType = b[p]; p += 13;
  let dsi = null;
  if (p < dcdEnd && b[p] === 0x05) { p++; const n = len(); dsi = b.subarray(p, p + n); }
  return { objectType, dsi };
}
