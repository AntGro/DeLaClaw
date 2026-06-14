// ===================================================================
// DeLaClaw Storm Logo — SVG generator + animation engine
// Storm(α, n): nested concentric chord patterns
// ===================================================================

// Default logo configuration
export const LOGO_DEFAULTS = {
  N: 7,             // number of arcs
  step: 2,          // chord step
  degree: 1,        // nesting depth
  rotation: 0,      // % of α per level
  gamma: 1.0,       // gradient power
  invert: true,     // invert gradient
  strokeWidth: 10.0,
  showOuterCircle: true,
  color: null,       // null = currentColor (theme-aware); set [r,g,b] to override
};

// ── Core SVG generation ──

function stormInnerR(outerR, step, N) {
  return outerR * Math.cos(step * Math.PI / N);
}

function gradientColor(dist, maxR, minR, gamma, invert, rgb) {
  if (maxR <= minR) return { color: 'currentColor', opacity: 1 };
  let t = Math.max(0, Math.min(1, (dist - minR) / (maxR - minR)));
  t = Math.pow(t, gamma);
  if (invert) t = 1 - t;
  // Use currentColor with varying opacity for theme independence
  // Fall back to explicit RGB only if rgb is not the default
  if (rgb) {
    return { color: `rgb(${Math.round(t * rgb[0])},${Math.round(t * rgb[1])},${Math.round(t * rgb[2])})`, opacity: 1 };
  }
  return { color: 'currentColor', opacity: Math.max(0.08, t) };
}

/**
 * Generate storm logo SVG elements as a string.
 * @param {object} params — merged with LOGO_DEFAULTS
 * @param {number} [viewSize=400] — viewBox dimension
 * @returns {string} SVG inner markup (no wrapping <svg> tag)
 */
export function generateStorm(params = {}, viewSize = 400) {
  const p = { ...LOGO_DEFAULTS, ...params };
  const cx = viewSize / 2, cy = viewSize / 2, R0 = viewSize * 0.45;
  const N = p.N;
  const alpha = p.step * 2 * Math.PI / N;

  // Precompute radii
  const radii = [];
  let r = R0;
  for (let d = 0; d < p.degree; d++) {
    radii.push(r);
    r = stormInnerR(r, p.step, N);
    if (r < 1) break;
  }
  const innermostR = r;
  const minR = innermostR, maxR = R0;
  const rotPerLevel = (p.rotation / 100) * alpha;

  let svg = '';
  let angle = 0;

  for (let d = 0; d < radii.length; d++) {
    const outerR = radii[d];

    // Outer circle
    if (p.showOuterCircle) {
      const chordMidDist = stormInnerR(outerR, p.step, N);
      const g = gradientColor(chordMidDist, maxR, minR, p.gamma, p.invert, p.color);
      svg += `<circle cx="${cx}" cy="${cy}" r="${outerR.toFixed(2)}" fill="none" stroke="${g.color}" stroke-opacity="${g.opacity}" stroke-width="${p.strokeWidth}"/>`;
    }

    // N chords
    for (let n = 0; n < N; n++) {
      const a1 = angle + n * 2 * Math.PI / N;
      const a2 = angle + (n + p.step) * 2 * Math.PI / N;
      const x1 = cx + outerR * Math.cos(a1);
      const y1 = cy - outerR * Math.sin(a1);
      const x2 = cx + outerR * Math.cos(a2);
      const y2 = cy - outerR * Math.sin(a2);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const dist = Math.sqrt((mx - cx) ** 2 + (my - cy) ** 2);
      const g = gradientColor(dist, maxR, minR, p.gamma, p.invert, p.color);
      svg += `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${g.color}" stroke-opacity="${g.opacity}" stroke-width="${p.strokeWidth}"/>`;
    }

    angle += rotPerLevel;
  }

  // Innermost circle
  if (p.showOuterCircle && innermostR >= 1 && radii.length > 1) {
    const chordMidDist = stormInnerR(innermostR, p.step, N);
    const g = gradientColor(chordMidDist, maxR, minR, p.gamma, p.invert, p.color);
    svg += `<circle cx="${cx}" cy="${cy}" r="${innermostR.toFixed(2)}" fill="none" stroke="${g.color}" stroke-opacity="${g.opacity}" stroke-width="${p.strokeWidth}"/>`;
  }

  return svg;
}

/**
 * Render storm logo into a target SVG element.
 * Creates the SVG element if target is a container div.
 * @param {HTMLElement} target — SVG element or container
 * @param {object} [params] — storm parameters
 * @param {number} [size=400] — viewBox size
 * @returns {SVGElement} the SVG element
 */
export function renderStorm(target, params = {}, size = 400) {
  let svg = target;
  if (target.tagName !== 'svg') {
    svg = target.querySelector('svg.storm-logo');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'storm-logo');
      svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
      target.appendChild(svg);
    }
  }
  svg.innerHTML = generateStorm(params, size);
  return svg;
}

// ===================================================================
// Animation engine
// ===================================================================

/**
 * Animate storm parameters over time.
 * @param {SVGElement} svg — target SVG element
 * @param {object} options
 * @param {object} options.from — start params (merged with LOGO_DEFAULTS)
 * @param {object} options.to — end params
 * @param {number} [options.duration=1000] — ms
 * @param {string} [options.easing='easeInOut'] — easeIn, easeOut, easeInOut, linear
 * @param {boolean} [options.loop=false] — ping-pong loop
 * @param {function} [options.onComplete] — callback when done (not called if looping)
 * @returns {{ stop: function, promise: Promise }} controller
 */
export function animateStorm(svg, options) {
  const from = { ...LOGO_DEFAULTS, ...options.from };
  const to = { ...LOGO_DEFAULTS, ...options.to };
  const duration = options.duration || 1000;
  const loop = options.loop || false;
  const easingName = options.easing || 'easeInOut';
  const size = parseInt(svg.getAttribute('viewBox')?.split(' ')[2]) || 400;

  const easings = {
    linear: t => t,
    easeIn: t => t * t,
    easeOut: t => t * (2 - t),
    easeInOut: t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
  };
  const ease = easings[easingName] || easings.easeInOut;

  // Animatable numeric keys
  const numKeys = ['N', 'step', 'degree', 'rotation', 'gamma', 'strokeWidth'];
  let stopped = false;
  let rafId = null;
  let direction = 1; // 1 = forward, -1 = reverse (for ping-pong)

  let resolvePromise;
  const promise = new Promise(r => { resolvePromise = r; });

  function lerp(a, b, t) { return a + (b - a) * t; }

  function tick(startTime) {
    if (stopped) { resolvePromise(); return; }
    const elapsed = Date.now() - startTime;
    let rawT = Math.min(1, elapsed / duration);
    const t = ease(direction === 1 ? rawT : 1 - rawT);

    const params = { ...from };
    for (const k of numKeys) {
      if (from[k] !== undefined && to[k] !== undefined) {
        params[k] = lerp(from[k], to[k], t);
      }
    }
    // Boolean keys: snap at midpoint
    params.invert = t < 0.5 ? from.invert : to.invert;
    params.showOuterCircle = t < 0.5 ? from.showOuterCircle : to.showOuterCircle;
    if (from.color && to.color) {
      params.color = from.color.map((c, i) => Math.round(lerp(c, to.color[i], t)));
    }

    // For degree: round to integer for rendering
    const renderParams = { ...params, degree: Math.round(params.degree) };
    svg.innerHTML = generateStorm(renderParams, size);

    if (rawT >= 1) {
      if (loop) {
        direction *= -1;
        rafId = requestAnimationFrame(() => tick(Date.now()));
      } else {
        if (options.onComplete) options.onComplete();
        resolvePromise();
      }
    } else {
      rafId = requestAnimationFrame(() => tick(startTime));
    }
  }

  rafId = requestAnimationFrame(() => tick(Date.now()));

  return {
    stop() { stopped = true; if (rafId) cancelAnimationFrame(rafId); },
    promise,
  };
}

// ===================================================================
// Preset animations
// ===================================================================

/** Loading: pulse degree 1→3→1 with rotation */
export function animLoading(svg, params = {}) {
  return animateStorm(svg, {
    from: { ...LOGO_DEFAULTS, ...params, degree: 1, rotation: 0 },
    to: { ...LOGO_DEFAULTS, ...params, degree: 3, rotation: 60 },
    duration: 1200,
    easing: 'easeInOut',
    loop: true,
  });
}

/** Lock: collapse from current to tight single degree */
export function animLock(svg, params = {}) {
  return animateStorm(svg, {
    from: { ...LOGO_DEFAULTS, ...params, degree: 3, rotation: 40, gamma: 0.6 },
    to: { ...LOGO_DEFAULTS, ...params, degree: 1, rotation: 0, gamma: 1.4 },
    duration: 600,
    easing: 'easeIn',
  });
}

/** Unlock: expand from tight to open */
export function animUnlock(svg, params = {}) {
  return animateStorm(svg, {
    from: { ...LOGO_DEFAULTS, ...params, degree: 1, rotation: 0, gamma: 1.4 },
    to: { ...LOGO_DEFAULTS, ...params, degree: 3, rotation: 40, gamma: 0.6 },
    duration: 350,
    easing: 'easeOut',
  });
}

/** Breathe: gentle gamma oscillation */
export function animBreathe(svg, params = {}) {
  return animateStorm(svg, {
    from: { ...LOGO_DEFAULTS, ...params, gamma: 0.7 },
    to: { ...LOGO_DEFAULTS, ...params, gamma: 1.6 },
    duration: 2000,
    easing: 'easeInOut',
    loop: true,
  });
}
