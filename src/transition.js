// Transitions between two clips on one canvas: a crossfade, or a swipe (the outgoing frame slides out
// while the incoming one slides in). The player keeps both clips' current frames and composites them
// on every display frame of the transition, so the motion is locked to the same clock as the frames
// and the audio crossfade. Nothing here touches a decoder; this module only describes and draws.

const EASE = {
  linear: (t) => t,
  'ease-in-out': (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  'ease-out': (t) => 1 - Math.pow(1 - t, 3),
  'ease-in': (t) => t * t * t,
};
const DEFAULTS = { fade: { duration: 300, easing: 'ease-in-out' }, swipe: { duration: 350, easing: 'ease-out' } };
const DIRECTIONS = ['left', 'right', 'up', 'down'];

/**
 * A transition from what the caller wrote: 'fade', 'swipe' (left), 'swipe-left' | 'swipe-right' | 'swipe-up' |
 * 'swipe-down', a number (a fade of that many ms), or { type: 'fade' | 'swipe', direction, duration (ms), easing }.
 * easing: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' or a function of 0…1. Null/false/'none' → null (a plain cut).
 * A swipe's direction is the way the picture moves: 'left' brings the incoming clip in from the right.
 */
export function normalizeTransition(t) {
  if (t == null || t === false || t === 'none') return null;
  let spec;
  if (typeof t === 'number') spec = { type: 'fade', duration: t };
  else if (typeof t === 'string') {
    const m = /^(fade|swipe)(?:-(left|right|up|down))?$/.exec(t);
    if (!m || (m[1] === 'fade' && m[2])) throw new TypeError(`transition "${t}": 'fade', 'swipe' or 'swipe-left|right|up|down'`);
    spec = { type: m[1], direction: m[2] };
  } else if (typeof t === 'object') spec = { ...t };
  else throw new TypeError(`transition: ${typeof t}`);
  const d = DEFAULTS[spec.type];
  if (!d) throw new TypeError(`transition type "${spec.type}": 'fade' or 'swipe'`);
  const direction = spec.type === 'swipe' ? (spec.direction ?? 'left') : null;
  if (direction && !DIRECTIONS.includes(direction)) throw new TypeError(`swipe direction "${direction}": ${DIRECTIONS.join(', ')}`);
  const duration = Number(spec.duration ?? d.duration);
  if (!(duration > 0 && duration <= 10000)) throw new RangeError(`transition duration ${spec.duration}: 1 to 10000 ms`);
  const easing = typeof spec.easing === 'function' ? spec.easing : EASE[spec.easing ?? d.easing];
  if (!easing) throw new TypeError(`transition easing "${spec.easing}": ${Object.keys(EASE).join(', ')} or a function`);
  return { type: spec.type, direction, duration, seconds: duration / 1000, easing };
}

/** How many of `clip`'s frames a transition of this spec spans at playback rate `rate`. */
export function transitionFrames(clip, spec, rate = 1) {
  return spec ? Math.ceil(spec.seconds * clip.fps * rate) : 0;
}

/** The canvas's object-fit, read once per transition (the element's canvas inherits the host's). */
export function fitOf(canvas) {
  try { return getComputedStyle(canvas).objectFit || 'fill'; } catch { return 'fill'; }
}

/** Where a frame of upright size fw×fh lands in a W×H box under `fit` (object-fit's rules; 'none' at the device pixel ratio). */
function placeIn(fw, fh, W, H, fit, dpr) {
  let w, h;
  if (fit === 'fill') { w = W; h = H; }
  else {
    const contain = Math.min(W / fw, H / fh), cover = Math.max(W / fw, H / fh);
    const s = fit === 'cover' ? cover : fit === 'none' ? dpr : fit === 'scale-down' ? Math.min(contain, dpr) : contain;
    w = fw * s; h = fh * s;
  }
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

function drawPlaced(ctx, frame, rotation, W, H, fit, dpr, dx, dy, alpha) {
  const fw = rotation % 180 ? frame.displayHeight : frame.displayWidth, fh = rotation % 180 ? frame.displayWidth : frame.displayHeight;
  const r = placeIn(fw, fh, W, H, fit, dpr);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(dx + r.x + r.w / 2, dy + r.y + r.h / 2);
  if (rotation) ctx.rotate(rotation * Math.PI / 180);
  const dw = rotation % 180 ? r.h : r.w, dh = rotation % 180 ? r.w : r.h;   // the frame as stored, before it is turned upright
  ctx.drawImage(frame, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

/**
 * Draw one display frame of a transition: `out` and `inc` are { frame, rotation } (either may be null —
 * nothing yet, or nothing left), `e` the eased progress 0…1. The canvas takes the size of its box (CSS
 * pixels × devicePixelRatio) so both clips are placed the way object-fit places a single one; once the
 * transition is over the player draws frames at their own size again and the box shows them the same way.
 */
export function composeTransition(ctx, canvas, out, inc, spec, e, fit) {
  const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1;
  let W = Math.round((canvas.clientWidth || 0) * dpr), H = Math.round((canvas.clientHeight || 0) * dpr);
  if (!W || !H) {   // not laid out (hidden, or no layout at all): the incoming frame's own upright size
    const f = inc?.frame ?? out?.frame;
    if (!f) return;
    const rot = (inc ?? out).rotation;
    W = rot % 180 ? f.displayHeight : f.displayWidth; H = rot % 180 ? f.displayWidth : f.displayHeight;
  }
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (spec.type === 'fade') {
    if (out) drawPlaced(ctx, out.frame, out.rotation, W, H, fit, dpr, 0, 0, 1);
    if (inc) drawPlaced(ctx, inc.frame, inc.rotation, W, H, fit, dpr, 0, 0, out ? e : 1);
  } else {
    const ax = spec.direction === 'left' ? -W : spec.direction === 'right' ? W : 0;
    const ay = spec.direction === 'up' ? -H : spec.direction === 'down' ? H : 0;
    if (out) drawPlaced(ctx, out.frame, out.rotation, W, H, fit, dpr, ax * e, ay * e, 1);
    if (inc) drawPlaced(ctx, inc.frame, inc.rotation, W, H, fit, dpr, -ax * (1 - e), -ay * (1 - e), 1);
  }
  ctx.restore();
}
