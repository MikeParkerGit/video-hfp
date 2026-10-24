// WebM / Matroska demuxer: one pass over the file's clusters builds the same index the MP4
// demuxer does — blocks in file order with their timestamps and keyframe flags, the codec config
// from the track's CodecPrivate, and the audio track. There is no central sample table in
// Matroska, so this reads the whole file through the ByteSource (Cues only index clusters); a long
// WebM therefore costs a full read to open, where an MP4 costs its moov.

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa, SeekPreRoll: 0x56bb, DefaultDuration: 0x23e383, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f, BitDepth: 0x6264,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b, ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b, SeekHead: 0x114d9b74, Void: 0xec, Tags: 0x1254c367, Attachments: 0x1941a469, Chapters: 0x1043a770,
};
const LEVEL1 = new Set([ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.SeekHead, ID.Tags, ID.Attachments, ID.Chapters]);
const td = new TextDecoder();

class Reader {
  constructor(src) { this.src = src; this.pos = 0; this.buf = new Uint8Array(0); this.bufStart = 0; }
  async ensure(n) {
    if (this.pos + n <= this.bufStart + this.buf.length) return;
    const start = this.pos, len = Math.max(n, Math.min(4 << 20, this.src.size - start));
    this.buf = await this.src.read(start, len); this.bufStart = start;
  }
  get eof() { return this.pos >= this.src.size; }
  async byte() { await this.ensure(1); return this.buf[this.pos++ - this.bufStart]; }
  async bytes(n) { await this.ensure(n); const o = this.pos - this.bufStart; this.pos += n; return this.buf.subarray(o, o + n); }
  async id() { const first = await this.byte(); let len = 1; while (len <= 4 && !(first & (0x80 >> (len - 1)))) len++; let v = first; for (let i = 1; i < len; i++) v = v * 256 + await this.byte(); return v; }
  async size() { const first = await this.byte(); let len = 1; while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++; let v = first & (0xff >> len); let all1 = v === (0xff >> len); for (let i = 1; i < len; i++) { const c = await this.byte(); if (c !== 0xff) all1 = false; v = v * 256 + c; } return all1 ? -1 : v; }
}
const uintOf = (b) => { let v = 0; for (const x of b) v = v * 256 + x; return v; };
const floatOf = (b) => b.length === 4 ? new DataView(b.buffer, b.byteOffset, 4).getFloat32(0) : b.length === 8 ? new DataView(b.buffer, b.byteOffset, 8).getFloat64(0) : 0;

/** @param {{ size: number, read(offset: number, length: number): Promise<Uint8Array> }} src */
export async function demuxWebm(src) {
  const r = new Reader(src);
  if (await r.id() !== ID.EBML) throw new Error('webm: not an EBML file');
  { const headerSize = await r.size(); r.pos += headerSize; }
  if (await r.id() !== ID.Segment) throw new Error('webm: no Segment');
  const segSize = await r.size();
  const segEnd = segSize < 0 ? src.size : r.pos + segSize;
  let timecodeScale = 1_000_000, duration = 0;
  const tracks = new Map();
  const blocks = [];  // { track, offset, size, time (s), key, duration? }
  let clusterTime = 0;
  while (r.pos < segEnd && !r.eof) {
    const id = await r.id();
    const size = await r.size();
    const start = r.pos, end = size < 0 ? segEnd : start + size;
    if (id === ID.Info) {
      await parseChildren(r, end, async (cid, csize) => {
        if (cid === ID.TimecodeScale) timecodeScale = uintOf(await r.bytes(csize));
        else if (cid === ID.Duration) duration = floatOf(await r.bytes(csize));
        else r.pos += csize;
      });
    } else if (id === ID.Tracks) {
      await parseChildren(r, end, async (cid, csize) => {
        if (cid !== ID.TrackEntry) { r.pos += csize; return; }
        const t = { number: 0, type: 0, codecId: '', codecPrivate: null, codecDelay: 0, seekPreRoll: 0, defaultDuration: 0, width: 0, height: 0, sampleRate: 0, channels: 0 };
        await parseChildren(r, r.pos + csize, async (tid, tsize) => {
          const tend = r.pos + tsize;
          switch (tid) {
            case ID.TrackNumber: t.number = uintOf(await r.bytes(tsize)); break;
            case ID.TrackType: t.type = uintOf(await r.bytes(tsize)); break;
            case ID.CodecID: t.codecId = td.decode(await r.bytes(tsize)); break;
            case ID.CodecPrivate: t.codecPrivate = new Uint8Array(await r.bytes(tsize)); break;
            case ID.CodecDelay: t.codecDelay = uintOf(await r.bytes(tsize)); break;
            case ID.SeekPreRoll: t.seekPreRoll = uintOf(await r.bytes(tsize)); break;
            case ID.DefaultDuration: t.defaultDuration = uintOf(await r.bytes(tsize)); break;
            case ID.Video: await parseChildren(r, tend, async (vid, vsize) => { if (vid === ID.PixelWidth) t.width = uintOf(await r.bytes(vsize)); else if (vid === ID.PixelHeight) t.height = uintOf(await r.bytes(vsize)); else r.pos += vsize; }); break;
            case ID.Audio: await parseChildren(r, tend, async (aid, asize) => { if (aid === ID.SamplingFrequency) t.sampleRate = floatOf(await r.bytes(asize)); else if (aid === ID.Channels) t.channels = uintOf(await r.bytes(asize)); else r.pos += asize; }); break;
            default: r.pos = tend;
          }
        });
        tracks.set(t.number, t);
      });
    } else if (id === ID.Cluster) {
      // children until the next level-1 element (unknown-size clusters end where the next cluster begins)
      while (r.pos < end && !r.eof) {
        const save = r.pos;
        const cid = await r.id();
        if (LEVEL1.has(cid)) { r.pos = save; break; }
        const csize = await r.size();
        const cstart = r.pos, cend = csize < 0 ? end : cstart + csize;
        if (cid === ID.Timecode) clusterTime = uintOf(await r.bytes(csize));
        else if (cid === ID.SimpleBlock) { blocks.push(...await parseBlock(r, cstart, cend, clusterTime, timecodeScale, true)); r.pos = cend; }
        else if (cid === ID.BlockGroup) {
          let group = null, ref = false, dur = 0;
          await parseChildren(r, cend, async (gid, gsize) => {
            const gstart = r.pos, gend = gstart + gsize;
            if (gid === ID.Block) group = await parseBlock(r, gstart, gend, clusterTime, timecodeScale, false);
            else if (gid === ID.ReferenceBlock) ref = true;
            else if (gid === ID.BlockDuration) dur = uintOf(await r.bytes(gsize));
            r.pos = gend;
          });
          if (group) for (const blk of group) { blk.key = !ref; if (dur) blk.duration = dur * timecodeScale / 1e9; blocks.push(blk); }
        } else r.pos = cend;
      }
      if (size >= 0) r.pos = end;
    } else r.pos = end;
  }
  // ---- assemble tracks
  const video = [...tracks.values()].find((t) => t.type === 1), audio = [...tracks.values()].find((t) => t.type === 2);
  if (!video) throw new Error('webm: no video track');
  const out = { container: 'webm', duration: duration * timecodeScale / 1e9, video: null, audio: null };
  const vb = blocks.filter((x) => x.track === video.number);
  const vdur = video.defaultDuration / 1e9;
  out.video = { kind: 'video', ...videoCodec(video), codedWidth: video.width, codedHeight: video.height, editOffset: 0, emptyEdit: 0, duration: 0, timescale: 1e9,
    samples: vb.map((x, i) => { const d = x.duration || vdur || (i + 1 < vb.length ? Math.abs(vb[i + 1].time - x.time) : vdur); return { offset: x.offset, size: x.size, dts: x.time, pts: x.time, duration: d, durationUnits: Math.round(d * 1e9), key: x.key }; }) };
  // Matroska blocks are in decode order with presentation timestamps; dts is unknown, so synthesize one that
  // keeps decode order monotonic (the index only needs the order and the pts).
  for (let i = 0; i < out.video.samples.length; i++) out.video.samples[i].dts = i * (vdur || out.video.samples[0]?.duration || 1 / 30);
  out.video.duration = out.duration || (vb.length ? vb[vb.length - 1].time + (vdur || 0) : 0);
  if (audio) {
    const ab = blocks.filter((x) => x.track === audio.number);
    const ac = audioCodec(audio);
    if (ac.codec) out.audio = { kind: 'audio', ...ac, sampleRate: ac.sampleRate || audio.sampleRate, channels: ac.channels || audio.channels, editOffset: audio.codecDelay / 1e9, emptyEdit: 0,
      duration: out.duration, samples: ab.map((x, i) => ({ offset: x.offset, size: x.size, dts: x.time, pts: x.time, duration: x.duration || (i + 1 < ab.length ? ab[i + 1].time - x.time : 0.02), key: true })) };
  }
  if (!out.duration) out.duration = out.video.duration;
  return out;
}

async function parseChildren(r, end, fn) {
  while (r.pos < end && !r.eof) { const id = await r.id(); const size = await r.size(); if (size < 0) throw new Error('webm: unknown-size element inside a parsed container'); const next = r.pos + size; await fn(id, size); r.pos = next; }
}

/** A (Simple)Block header: track vint, int16 timecode, flags; then lacing. Returns the frames it holds. */
async function parseBlock(r, start, end, clusterTime, scale, simple) {
  r.pos = start;
  const track = await r.size();
  const t2 = await r.bytes(2);
  const tc = (((t2[0] << 8) | t2[1]) << 16) >> 16;   // int16, big-endian, relative to the cluster
  const flags = await r.byte();
  const time = (clusterTime + tc) * scale / 1e9;
  const key = simple ? !!(flags & 0x80) : true;
  const lacing = (flags >> 1) & 3;
  if (lacing === 0) return [{ track, offset: r.pos, size: end - r.pos, time, key }];
  const count = (await r.byte()) + 1;
  const sizes = [];
  const payloadAfterHeader = () => r.pos;
  if (lacing === 2) { const each = Math.floor((end - r.pos) / count); for (let i = 0; i < count; i++) sizes.push(each); }
  else if (lacing === 1) { let total = 0; for (let i = 0; i < count - 1; i++) { let s = 0, c; do { c = await r.byte(); s += c; } while (c === 255); sizes.push(s); total += s; } sizes.push(end - r.pos - total); }
  else { let total = 0; let s = await r.size(); sizes.push(s); total += s;
    for (let i = 1; i < count - 1; i++) { const first = await r.byte(); let len = 1; while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++; let v = first & (0xff >> len); for (let k = 1; k < len; k++) v = v * 256 + await r.byte(); const bias = Math.pow(2, 7 * len - 1) - 1; s += v - bias; sizes.push(s); total += s; }
    sizes.push(end - r.pos - total); }
  const out = []; let off = payloadAfterHeader();
  for (let i = 0; i < count; i++) { out.push({ track, offset: off, size: sizes[i], time: time + i * 0.02, key: key && i === 0 }); off += sizes[i]; }
  return out;
}

function videoCodec(t) {
  const p = t.codecPrivate;
  switch (t.codecId) {
    case 'V_VP9': {
      let profile = 0, level = 10, depth = 8;
      if (p) { let i = 0; while (i + 2 <= p.length) { const id = p[i], len = p[i + 1], v = p[i + 2]; if (id === 1) profile = v; else if (id === 2) level = v; else if (id === 3) depth = v; i += 2 + len; } }
      return { format: 'V_VP9', codec: `vp09.${String(profile).padStart(2, '0')}.${String(level).padStart(2, '0')}.${String(depth).padStart(2, '0')}`, description: undefined }; }
    case 'V_VP8': return { format: 'V_VP8', codec: 'vp8', description: undefined };
    case 'V_AV1': { if (!p) return { format: 'V_AV1', codec: 'av01.0.08M.08', description: undefined }; const profile = p[1] >> 5, level = p[1] & 31, tier = p[2] >> 7, high = (p[2] >> 6) & 1, twelve = (p[2] >> 5) & 1;
      return { format: 'V_AV1', codec: `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(twelve ? 12 : high ? 10 : 8).padStart(2, '0')}`, description: undefined }; }
    case 'V_MPEG4/ISO/AVC': return { format: 'avc1', codec: p ? `avc1.${hx(p[1])}${hx(p[2])}${hx(p[3])}` : null, description: p };
    case 'V_MPEGH/ISO/HEVC': return { format: 'hvc1', codec: p ? `hvc1.${p[1] & 31}.1.L${p[12]}.B0` : null, description: p };
    default: return { format: t.codecId, codec: null, description: undefined };
  }
}
const hx = (n) => n.toString(16).padStart(2, '0');

function audioCodec(t) {
  const p = t.codecPrivate;
  switch (t.codecId) {
    case 'A_OPUS': return { format: 'A_OPUS', codec: 'opus', description: p, sampleRate: 48000, channels: p ? p[9] : 0, preSkip: p ? p[10] | (p[11] << 8) : 0 };
    case 'A_AAC': { const aot = p ? p[0] >> 3 : 2; return { format: 'A_AAC', codec: `mp4a.40.${aot}`, description: p, preSkip: 0 }; }
    case 'A_FLAC': return { format: 'A_FLAC', codec: 'flac', description: p, preSkip: 0 };
    case 'A_VORBIS': return { format: 'A_VORBIS', codec: 'vorbis', description: p, preSkip: 0 };
    case 'A_MPEG/L3': return { format: 'A_MPEG/L3', codec: 'mp3', description: undefined, preSkip: 0 };
    default: return { format: t.codecId, codec: null, preSkip: 0 };
  }
}
