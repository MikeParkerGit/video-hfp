// A clip's colour space, from its container: the codes ISO/IEC 23091-2 (H.273) defines — what an MP4 `colr`
// (nclx/nclc) box, a `vpcC` box and a WebM Colour element carry — as the VideoColorSpaceInit WebCodecs takes.
// Given to every decoder (VideoDecoderConfig.colorSpace) and stamped on every frame rebuilt from a bridge, so a
// hardware decoder, a software one and a bridge all show the same picture. Phones record FULL-range video
// (yuvj420p, `colr nclx … full_range 1`); read as limited range it shows with more contrast — brighter whites,
// darker blacks — which is how a bridge frame without it gave itself away at every hand-off.

const PRIMARIES = { 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020', 12: 'smpte432' };
const TRANSFER = { 1: 'bt709', 6: 'smpte170m', 8: 'linear', 13: 'iec61966-2-1', 14: 'bt709', 15: 'bt709', 16: 'pq', 18: 'hlg' };   // 14/15: BT.2020 10/12-bit, the BT.709 curve
const MATRIX = { 0: 'rgb', 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020-ncl' };

/**
 * { primaries, transfer, matrix } as H.273 code points and fullRange as true/false/null (unknown) → a VideoColorSpaceInit
 * with only what is known and has a WebCodecs name, or null when nothing is.
 */
export function colorSpaceFromCodes({ primaries, transfer, matrix, fullRange } = {}) {
  const out = {};
  if (PRIMARIES[primaries]) out.primaries = PRIMARIES[primaries];
  if (TRANSFER[transfer]) out.transfer = TRANSFER[transfer];
  if (MATRIX[matrix]) out.matrix = MATRIX[matrix];
  if (fullRange === true || fullRange === false) out.fullRange = fullRange;
  return Object.keys(out).length ? out : null;
}
