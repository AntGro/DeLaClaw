// ===================================================================
// Storm 2D — vanilla Canvas 2D storm logo for the hero scroll
// Drop-in replacement for storm3d.js: same exports, no WebGL,
// no external library. The 3D extrusion is faked with stacked,
// dark-to-light layers offset along the tilt direction, so the
// shape reads flat (identical to the SVG) when untilted and gains
// depth as it tilts — exactly the motion hero.js drives.
// ===================================================================

const R0 = 180;

let canvas, ctx;
let ready = false;
let built = false;
let path = null;
let halfW = 5;
let depth = 18;

export function init(c) {
  if (ready) return;
  canvas = c;
  ctx = canvas.getContext('2d');
  ready = true;
}

/**
 * Build (or rebuild) the storm path.
 * Same geometry as the old extruded mesh: an outer ring plus N
 * chord quads, all of half-width sw/2 around the R0 circle.
 */
export function build(N, step, sw, d) {
  if (!ready) return;
  halfW = sw / 2;
  depth = d;
  path = new Path2D();

  // Ring — annulus, outer clockwise, inner counter-clockwise (hole).
  path.arc(0, 0, R0 + halfW, 0, Math.PI * 2, false);
  path.arc(0, 0, Math.max(R0 - halfW, 0.1), 0, Math.PI * 2, true);

  // Chords — quads between points step apart on the circle.
  for (let n = 0; n < N; n++) {
    const a1 = n * 2 * Math.PI / N;
    const a2 = (n + step) * 2 * Math.PI / N;
    const x1 = R0 * Math.cos(a1), y1 = R0 * Math.sin(a1);
    const x2 = R0 * Math.cos(a2), y2 = R0 * Math.sin(a2);
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.01) continue;
    const nx = -dy / len * halfW, ny = dx / len * halfW;
    path.moveTo(x1 + nx, y1 + ny);
    path.lineTo(x2 + nx, y2 + ny);
    path.lineTo(x2 - nx, y2 - ny);
    path.lineTo(x1 - nx, y1 - ny);
    path.closePath();
  }
  built = true;
}

/**
 * Resize the backing store to match the current canvas display size.
 */
export function resize() {
  if (!ready) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 400;
  const h = canvas.clientHeight || 400;
  if (canvas.width !== Math.round(w * dpr) ||
      canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
}

function lerpColor(c1, c2, t) {
  const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
  const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
  const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
  return `rgb(${r},${g},${b})`;
}

/**
 * Render one frame.
 * @param {number} tiltX — X rotation in radians (pitch)
 * @param {number} tiltY — Y rotation in radians (yaw)
 * @param {number} spinZ — Z rotation in radians (roll / slow spin)
 */
export function frame(tiltX, tiltY, spinZ) {
  if (!ready || !built) return;
  resize();
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Same framing as the old perspective camera: the 400-unit
  // storm spans the canvas height.
  const fit = Math.min(w, h) / 400;
  ctx.translate(w / 2, h / 2);
  ctx.rotate(spinZ);
  // Small-angle stand-in for 3D pitch/yaw: squash along each axis.
  ctx.scale(Math.max(Math.cos(tiltY), 0.01), Math.max(Math.cos(tiltX), 0.01));
  ctx.scale(fit, fit);

  // Faked extrusion: stacked layers from the tilt offset back to
  // the top face. Untilted, the offset is zero and the shape is
  // a single flat face, matching the SVG exactly.
  const layers = Math.max(2, Math.round(depth / 3));
  const ex = tiltY * depth * 0.6;
  const ey = -tiltX * depth * 0.6;
  const dark = [49, 46, 129];   // indigo-900
  const flat = [99, 102, 241];  // indigo-500, the old material color
  for (let i = 0; i < layers - 1; i++) {
    const t = i / (layers - 1);
    ctx.save();
    ctx.translate(ex * (1 - t), ey * (1 - t));
    ctx.fillStyle = lerpColor(dark, flat, t);
    ctx.fill(path, 'nonzero');
    ctx.restore();
  }

  // Top face — vertical gradient for a lit-surface feel.
  const grad = ctx.createLinearGradient(0, -R0, 0, R0);
  grad.addColorStop(0, '#818cf8');
  grad.addColorStop(0.5, '#6366f1');
  grad.addColorStop(1, '#4f46e5');
  ctx.fillStyle = grad;
  ctx.fill(path, 'nonzero');
}

export function dispose() {
  if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
  path = null;
  canvas = ctx = null;
  ready = built = false;
}

export function isReady() { return ready; }
