// ===================================================================
// Storm 2D — vanilla Canvas 2D storm logo for the hero scroll
// Drop-in replacement for storm3d.js: same exports, no WebGL,
// no external library. Deliberately flat 2D: no fake extrusion.
// Style comes from a tilt-driven halo (grows as the storm tilts,
// invisible when flat so it matches the SVG exactly) and a sheen
// sweep from a fixed on-screen light as the storm spins.
// ===================================================================

const R0 = 180;

let canvas, ctx;
let ready = false;
let built = false;
let path = null;
let halfW = 5;

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
 * The depth argument is accepted for interface parity and unused:
 * this renderer stays flat 2D.
 */
export function build(N, step, sw) {
  if (!ready) return;
  halfW = sw / 2;
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
  // Small-angle stand-in for pitch/yaw: squash along each axis.
  // This is a plain 2D scale, like the CSS transforms on the SVG.
  ctx.scale(Math.max(Math.cos(tiltY), 0.01), Math.max(Math.cos(tiltX), 0.01));
  ctx.scale(fit, fit);

  const tiltMag = Math.sqrt(tiltX * tiltX + tiltY * tiltY);

  // Halo — a flat, slightly enlarged copy behind the face, fading
  // in with tilt. Invisible when flat, so the shape matches the
  // SVG exactly during the crossfade.
  if (tiltMag > 0.01) {
    ctx.save();
    ctx.scale(1 + tiltMag * 0.06, 1 + tiltMag * 0.06);
    ctx.fillStyle = `rgba(99,102,241,${Math.min(0.35, tiltMag * 1.2).toFixed(3)})`;
    ctx.fill(path, 'nonzero');
    ctx.restore();
  }

  // Face — vertical gradient for a lit-surface feel.
  const grad = ctx.createLinearGradient(0, -R0, 0, R0);
  grad.addColorStop(0, '#818cf8');
  grad.addColorStop(0.5, '#6366f1');
  grad.addColorStop(1, '#4f46e5');
  ctx.fillStyle = grad;
  ctx.fill(path, 'nonzero');

  // Sheen — a diagonal band from a fixed on-screen light. The
  // gradient endpoints are counter-rotated by spinZ so the light
  // stays put on screen while the storm spins under it, sweeping
  // the highlight across the face.
  const c = Math.cos(spinZ), s = Math.sin(spinZ);
  const ax = c * -R0 + s * -R0, ay = -s * -R0 + c * -R0;
  const bx = c * R0 + s * R0, by = -s * R0 + c * R0;
  const sheen = ctx.createLinearGradient(ax, ay, bx, by);
  sheen.addColorStop(0, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0.16)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fill(path, 'nonzero');
}

export function dispose() {
  if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
  path = null;
  canvas = ctx = null;
  ready = built = false;
}

export function isReady() { return ready; }
