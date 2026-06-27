// ===================================================================
// DeLaClaw Hero — scroll-driven Storm animation
// ===================================================================
import { generateStorm, LOGO_DEFAULTS } from './logo.js';
import * as storm3d from './storm3d.js';

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const easeOut = t => 1 - (1 - t) * (1 - t);
const easeInOut = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
const easeCubicOut = t => 1 - Math.pow(1 - t, 3);

let heroEl, stormSvg, stormBg, stormCanvas, ticking = false;
let destroyed = false;
let storm3dBuilt = false;

// Storm phase boundaries (tuned for 300vh spacer / 2 panels)
const STORM_OPEN_END  = 0.20;   // step 1->2 completes
const STORM_3D_START  = 0.22;   // begin crossfade to 3D
const STORM_3D_END    = 0.40;   // fully 3D
const STORM_SHRINK    = 0.75;   // start shrinking

// Features panel fade-out end — skip link vanishes right after
const FEAT_FADE_END   = 0.66;

function getProgress() {
  if (!heroEl) return 0;
  const maxScroll = heroEl.offsetHeight - window.innerHeight;
  return maxScroll > 0 ? clamp(window.scrollY / maxScroll, 0, 1) : 0;
}

function vmin58() {
  return Math.min(window.innerWidth, window.innerHeight) * 0.58;
}

// ── Render ────────────────────────────────────────────────────────

function render() {
  if (destroyed || !heroEl) { ticking = false; return; }
  const p = getProgress();

  // ── Pre-compute shrink progress (shared by 3D + position sections) ──
  const gateLogoSvg = document.querySelector('#gateLogo > svg.storm-logo');
  const targetRect = gateLogoSvg ? gateLogoSvg.getBoundingClientRect() : null;
  const targetOnScreen = targetRect && targetRect.top < window.innerHeight;
  const HANDOFF = 0.95;  // visibility-swap threshold
  let shrinkT = 0;  // 0 = no shrink, reaches ~0.99 at max scroll
  if (p > STORM_SHRINK && targetOnScreen) {
    const enterT = clamp(1 - targetRect.top / window.innerHeight, 0, 1);
    shrinkT = easeCubicOut(enterT);
  }
  // landT normalizes to 1.0 at HANDOFF so visual interpolations fully converge before the swap
  const landT = clamp(shrinkT / HANDOFF, 0, 1);

  // ── Storm parameters ──
  let step, sw, gamma;
  if (p < STORM_OPEN_END) {
    const t = easeOut(p / STORM_OPEN_END);
    step  = lerp(1, 2, t);
    sw    = lerp(2, 10, t);
    gamma = lerp(0.3, 1.0, t);
  } else if (p < STORM_SHRINK) {
    step = 2;
    sw   = 10;
    const breathT = (p - STORM_OPEN_END) / (STORM_SHRINK - STORM_OPEN_END);
    gamma = 1.0 + 0.25 * Math.sin(breathT * Math.PI * 4);
  } else {
    step  = 2;
    sw    = 10;
    gamma = 1.0;
  }

  stormSvg.innerHTML = generateStorm({
    N: 7, step, strokeWidth: sw, gamma,
    degree: 1, invert: true, showOuterCircle: true, rotation: 0
  }, 400);

  // ── 3D crossfade ──
  if (stormCanvas && p >= STORM_3D_START) {
    // Lazy-init Three.js and build mesh once
    if (!storm3dBuilt) {
      storm3d.init(stormCanvas);
      storm3d.build(7, 2, 10, 18);
      storm3dBuilt = true;
    }

    // Forward crossfade: SVG → canvas
    const fadeT = clamp((p - STORM_3D_START) / (STORM_3D_END - STORM_3D_START), 0, 1);
    let fade = easeInOut(fadeT);

    // Keep 3D fully visible during shrink; only fade back to SVG once landed
    if (landT > 0.92) {
      const landBlend = clamp((landT - 0.92) / 0.08, 0, 1);
      fade = lerp(fade, 0, easeOut(landBlend));
    }

    stormSvg.style.opacity = String(1 - fade);
    stormCanvas.style.opacity = String(fade);

    // Gentle tilt reveals depth; Z-spin matches the SVG's CSS rotation
    // During crossfade (fade<1): stay perfectly flat to match the 2D SVG
    // After crossfade: tilt and yaw vary continuously to show off the 3D
    const moveT = clamp((p - STORM_3D_END) / 0.10, 0, 1);
    const tiltBase = easeOut(moveT) * 0.22;                       // ramp to ~12.5°
    // Continuous oscillation — unclamped so it keeps moving through shrink
    const paradeP = (p - STORM_3D_END) / (STORM_SHRINK - STORM_3D_END);
    let tiltX = tiltBase + (moveT > 0 ? Math.sin(paradeP * Math.PI * 2.5) * 0.10 : 0);
    let spinY = moveT > 0 ? Math.sin(paradeP * Math.PI * 3.2) * 0.18 : 0;

    // Damp tilt toward 0 during shrink so it arrives flat
    if (landT > 0) {
      const damp = 1 - landT;
      tiltX *= damp;
      spinY *= damp;
    }

    // Z-rotation: wind down in sync with SVG rotation during shrink
    let cssRotDeg = Math.min(p, STORM_SHRINK) * 60;
    if (landT > 0) {
      cssRotDeg = lerp(STORM_SHRINK * 60, 0, easeOut(landT));
    }
    const spinZ = -cssRotDeg * Math.PI / 180;             // negate: CSS rotates CW, Three.js Z rotates CCW

    storm3d.frame(tiltX, spinY, spinZ);
  } else if (stormCanvas) {
    stormCanvas.style.opacity = '0';
    stormSvg.style.opacity = '1';
  }

  // ── Size + position ──
  const gateEl = document.getElementById('gate');
  const gateTop = gateEl ? gateEl.getBoundingClientRect().top : Infinity;
  const stormBottom = window.innerHeight / 2 + vmin58() / 2;
  const gateOverlaps = gateTop < stormBottom;

  if (shrinkT <= 0) {
    // Full size, centered — hold rotation at STORM_SHRINK cap if past it
    stormBg.style.setProperty('--hero-storm-size', '58vmin');
    const baseRot = 'rotate(' + (Math.min(p, STORM_SHRINK) * 60) + 'deg)';
    stormSvg.style.transform = baseRot;
    if (stormCanvas) stormCanvas.style.transform = '';
    stormBg.style.opacity = '1';
    stormBg.style.zIndex = gateOverlaps ? '11' : '';
    stormSvg.style.filter = '';
    // Scrolled back up — gate logo hidden, hero storm is visible
    const gateLogoSvg = document.querySelector('#gateLogo > svg');
    if (gateLogoSvg) gateLogoSvg.style.visibility = 'hidden';
  } else {
    const currentSize = lerp(vmin58(), 80, landT);
    stormBg.style.setProperty('--hero-storm-size', currentSize + 'px');

    stormBg.style.opacity = '1';
    stormBg.style.zIndex = '11';

    // Fade drop-shadow proportionally
    const sf = 1 - landT;
    if (sf > 0.01) {
      const a1 = (0.2 * sf).toFixed(3);
      const a2 = (0.07 * sf).toFixed(3);
      stormSvg.style.filter = 'drop-shadow(0 0 ' + Math.round(40 * sf) + 'px oklch(0.6 0.16 264 / ' + a1 + ')) drop-shadow(0 0 ' + Math.round(80 * sf) + 'px oklch(0.6 0.16 264 / ' + a2 + '))';
    } else {
      stormSvg.style.filter = 'none';
    }

    // Rotation winds down to 0
    const rot = lerp(STORM_SHRINK * 60, 0, easeOut(landT));

    // Translate toward #stormTarget center
    const gCx = targetRect.left + targetRect.width / 2;
    const gCy = targetRect.top + targetRect.height / 2;
    const dx = (gCx - window.innerWidth / 2) * landT;
    const dy = (gCy - window.innerHeight / 2) * landT;

    stormSvg.style.transform = 'translate(' + dx + 'px,' + dy + 'px) rotate(' + rot + 'deg)';
    if (stormCanvas) stormCanvas.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';

    // Storm handoff: at landing, hide hero storm and show gate storm
    const gateLogoSvg = document.querySelector('#gateLogo > svg');
    if (shrinkT > HANDOFF) {
      stormBg.style.opacity = '0';
      if (gateLogoSvg) gateLogoSvg.style.visibility = '';
    } else {
      if (gateLogoSvg) gateLogoSvg.style.visibility = 'hidden';
    }
  }

  // ── Ambient glow ──
  const glow = document.getElementById('heroGlow');
  if (glow) {
    if (p > STORM_OPEN_END && p < STORM_SHRINK) {
      glow.style.opacity = '1';
    } else if (p <= STORM_OPEN_END) {
      glow.style.opacity = String(easeOut(p / STORM_OPEN_END));
    } else {
      const t = clamp((p - STORM_SHRINK) / (1 - STORM_SHRINK), 0, 1);
      glow.style.opacity = String(1 - t);
    }
  }

  // ── Hero name (starts above storm, then joins gate card) ──
  const nameEl = document.getElementById('heroName');
  if (nameEl) {
    const vh = window.innerHeight;
    const stormR = vmin58() / 2;
    const moveY = -(0.35 * vh + stormR + 8);

    let nameOp, nameTx;
    if (p < 0.02) {
      nameOp = 0;
    } else if (p < 0.08) {
      nameOp = easeOut((p - 0.02) / 0.06);
    } else {
      nameOp = 1;
    }
    nameTx = 'translateY(' + moveY + 'px)';

    // When stormTarget is visible, translate + scale name toward #gateTitle
    const gateTitle = document.getElementById('gateTitle');
    if (targetOnScreen && gateTitle) {
      const nt = landT;

      // Set base transform to get stable measurement
      nameEl.style.transform = nameTx;
      const nameR = nameEl.getBoundingClientRect();
      const ntR = gateTitle.getBoundingClientRect();

      const ndx = (ntR.left + ntR.width / 2) - (nameR.left + nameR.width / 2);
      const ndy = (ntR.top + ntR.height / 2) - (nameR.top + nameR.height / 2);

      // Scale from hero font size to gate h1 font size
      const heroFS = parseFloat(getComputedStyle(nameEl).fontSize);
      const gateFS = parseFloat(getComputedStyle(gateTitle).fontSize);
      const scale = lerp(1, gateFS / heroFS, nt);

      nameTx += ' translate(' + (ndx * nt) + 'px,' + (ndy * nt) + 'px) scale(' + scale + ')';
      nameEl.parentElement.style.zIndex = '11';

      // Fade text-shadow to match gate title (no shadow)
      const shadowOp = 1 - easeOut(nt);
      nameEl.style.textShadow = '0 0 ' + (40 * shadowOp).toFixed(0) + 'px rgba(0,0,0,' + (shadowOp * 0.3).toFixed(3) + ')';

      // Handoff: at landing, hide hero name and reveal gate title
      if (shrinkT > HANDOFF) {
        nameOp = 0;
        gateTitle.style.visibility = '';
      } else {
        gateTitle.style.visibility = 'hidden';
      }
    } else if (gateTitle) {
      nameEl.parentElement.style.zIndex = '';
      gateTitle.style.visibility = '';
      nameEl.style.textShadow = '';
    }

    nameEl.style.opacity = String(nameOp);
    nameEl.style.transform = nameTx;
  }

  // ── Hero demo button (centered in storm, flies to gate picker) ──
  const demoBtn = document.getElementById('heroDemoBtn');
  if (demoBtn) {
    // Fade in after storm opens
    let demoOp;
    if (p < 0.12) {
      demoOp = 0;
    } else if (p < 0.20) {
      demoOp = easeOut((p - 0.12) / 0.08);
    } else {
      demoOp = 1;
    }

    let demoTx = '';
    let landed = false;
    const gateDemoBtn = document.querySelector('#backendPicker .backend-option[data-mode="demo"]');

    if (targetOnScreen && gateDemoBtn && shrinkT > 0) {
      // Hide real demo button content while hero button is en route
      gateDemoBtn.classList.add('hero-arriving');

      // Measure positions with hero button at its natural size
      demoBtn.style.transform = '';
      demoBtn.style.padding = '';
      demoBtn.style.fontSize = '';
      demoBtn.style.letterSpacing = '';
      demoBtn.style.gap = '';
      const fromR = demoBtn.getBoundingClientRect();
      const toR = gateDemoBtn.getBoundingClientRect();

      const ddx = (toR.left + toR.width / 2) - (fromR.left + fromR.width / 2);
      const ddy = (toR.top + toR.height / 2) - (fromR.top + fromR.height / 2);

      // Position only — size is handled by inline style interpolation below
      demoTx = 'translate(' + (ddx * landT) + 'px,' + (ddy * landT) + 'px)';

      // Smooth style transition: glassmorphic → backend-option.active
      demoBtn.classList.add('landing');
      const st = easeOut(landT);
      demoBtn.style.padding = lerp(12, 9, st) + 'px ' + lerp(28, 12, st) + 'px';
      demoBtn.style.borderRadius = lerp(12, 8, st) + 'px';
      demoBtn.style.fontSize = lerp(0.95, 0.85, st) + 'rem';
      demoBtn.style.letterSpacing = lerp(0.03, 0, st) + 'em';
      demoBtn.style.gap = lerp(8, 6, st) + 'px';
      // Background: gradient glass → solid surface
      const bgAlpha = lerp(0.30, 0, st);
      const blurPx = lerp(16, 0, st);
      demoBtn.style.background = st < 0.95
        ? 'linear-gradient(135deg,rgba(69,77,198,' + bgAlpha.toFixed(3) + ') 0%,rgba(99,102,241,' + (bgAlpha * 0.67).toFixed(3) + ') 100%)'
        : 'var(--surface)';
      demoBtn.style.borderColor = st < 0.95
        ? 'rgba(255,255,255,' + lerp(0.18, 0, st).toFixed(3) + ')'
        : 'var(--border)';
      demoBtn.style.backdropFilter = 'blur(' + blurPx.toFixed(1) + 'px)';
      demoBtn.style.webkitBackdropFilter = 'blur(' + blurPx.toFixed(1) + 'px)';
      demoBtn.style.color = st > 0.5 ? 'var(--text)' : '';
      // Glow → subtle drop shadow
      const glowOp = 1 - st;
      const shadowOp = st > 0.3 ? (st - 0.3) / 0.7 : 0;
      demoBtn.style.boxShadow = '0 0 ' + (20 * glowOp).toFixed(0) + 'px rgba(99,102,241,' + (0.15 * glowOp).toFixed(3) + '),'
        + '0 0 ' + (40 * glowOp).toFixed(0) + 'px rgba(69,77,198,' + (0.08 * glowOp).toFixed(3) + '),'
        + '0 1px 4px rgba(0,0,0,' + (0.12 * shadowOp).toFixed(3) + ')';
      // SVG icon glow fades out
      const iconEl = demoBtn.querySelector('svg');
      if (iconEl) iconEl.style.filter = st > 0.5 ? 'none' : '';

      // Once landed: hide hero button, expose real button underneath
      if (shrinkT > HANDOFF) {
        landed = true;
        gateDemoBtn.classList.remove('hero-arriving');
        demoOp = 0;
      }
    } else if (gateDemoBtn) {
      // Scrolled back up — restore everything
      gateDemoBtn.classList.remove('hero-arriving');
      demoBtn.classList.remove('landing');
      for (const prop of ['padding','borderRadius','fontSize','letterSpacing','gap',
        'background','borderColor','backdropFilter','webkitBackdropFilter',
        'color','boxShadow','pointerEvents']) {
        demoBtn.style[prop] = '';
      }
      const iconEl = demoBtn.querySelector('svg');
      if (iconEl) iconEl.style.filter = '';
    }

    demoBtn.style.opacity = String(clamp(demoOp, 0, 1));
    demoBtn.style.transform = demoTx;
    demoBtn.style.pointerEvents = landed ? 'none' : '';
  }

  // ── Text panels ──
  heroEl.querySelectorAll('[data-fade]').forEach(el => {
    const [a, b, c, d] = el.dataset.fade.split(',').map(Number);
    let op = 0;
    if      (p >= a && p < b) op = easeOut((p - a) / (b - a));
    else if (p >= b && p <= c) op = 1;
    else if (p > c && p <= d) op = 1 - easeOut((p - c) / (d - c));
    el.style.opacity = clamp(op, 0, 1);
    const shift = op < 1 ? (1 - op) * 20 : 0;
    const dir = p < (b + c) / 2 ? 1 : -1;
    const isCentered = el.classList.contains('hero-centered');
    if (isCentered) {
      el.style.transform = 'translateY(calc(-50% + ' + (dir * shift) + 'px))';
    } else {
      el.style.transform = 'translateY(' + (dir * shift) + 'px)';
    }
  });

  // ── Scroll indicator ──
  const ind = document.getElementById('heroScrollInd');
  if (ind) ind.style.opacity = p < 0.04 ? 1 : clamp(1 - (p - 0.04) / 0.03, 0, 1);

  // ── Skip link — vanishes right after features panel fades out ──
  const skip = document.getElementById('heroSkip');
  if (skip) skip.style.opacity = p < FEAT_FADE_END ? 1 : clamp(1 - (p - FEAT_FADE_END) / 0.05, 0, 1);

  ticking = false;
}

function onScroll() {
  if (!ticking && !destroyed) {
    requestAnimationFrame(render);
    ticking = true;
  }
}

export function initHero() {
  heroEl  = document.getElementById('hero');
  if (!heroEl || heroEl.style.display === 'none') return;
  stormSvg = document.getElementById('heroStorm');
  stormBg  = document.getElementById('heroStormBg');
  stormCanvas = document.getElementById('heroStorm3d');
  if (!stormSvg || !stormBg) return;
  // Ensure gate logo SVG exists in the DOM (hidden while hero flies)
  injectGateLogo();
  // Cancel CSS entry animation so JS has full transform control
  stormSvg.style.animation = 'none';
  destroyed = false;
  render();
  window.addEventListener('scroll',  onScroll, { passive: true });
  window.addEventListener('resize',  onScroll, { passive: true });

  // ── Scroll indicator click → auto-scroll to gate ──
  const ind = document.getElementById('heroScrollInd');
  if (ind) {
    ind.onclick = () => {
      const spacer = document.querySelector('.hero-spacer');
      if (!spacer) return;
      const target = spacer.offsetTop + spacer.offsetHeight;
      let autoScrolling = true;
      const stop = () => { autoScrolling = false; };
      // User touch/wheel/key cancels auto-scroll
      window.addEventListener('wheel', stop, { once: true, passive: true });
      window.addEventListener('touchstart', stop, { once: true, passive: true });
      window.addEventListener('keydown', stop, { once: true });
      const start = window.scrollY;
      const dist = target - start;
      const duration = 2400;
      let t0 = null;
      function step(ts) {
        if (!autoScrolling) return;
        if (!t0) t0 = ts;
        const elapsed = ts - t0;
        const p = Math.min(elapsed / duration, 1);
        // Ease in-out cubic
        const ease = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        window.scrollTo(0, start + dist * ease);
        if (p < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    };
  }
}

export function destroyHero() {
  destroyed = true;
  window.removeEventListener('scroll', onScroll);
  window.removeEventListener('resize', onScroll);
  heroEl = stormSvg = stormBg = stormCanvas = null;
  if (storm3dBuilt) { storm3d.dispose(); }
  storm3dBuilt = false;
  // Restore gate title visibility
  const nt = document.getElementById('gateTitle');
  if (nt) nt.style.visibility = '';
}

export function showHero() {
  const h = document.getElementById('hero');
  if (h) {
    h.style.display = '';
    window.scrollTo(0, 0);
    initHero();
  }
}

export function hideHero() {
  destroyHero();
  const h = document.getElementById('hero');
  if (h) h.style.display = 'none';
  injectGateLogo();
}

// Static gate logo — only used when the hero is skipped (saved credentials).
// When the hero runs, #heroStorm (position:fixed) visually covers #stormTarget.
export function injectGateLogo() {
  const container = document.getElementById('gateLogo');
  if (!container) return;
  if (container.querySelector('svg')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'storm-logo login-logo');
  svg.setAttribute('viewBox', '0 0 400 400');
  container.appendChild(svg);
  svg.innerHTML = generateStorm(LOGO_DEFAULTS, 400);
}
