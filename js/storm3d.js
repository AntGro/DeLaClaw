// ===================================================================
// Storm 3D — Three.js extruded storm logo for the hero scroll
// ===================================================================
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

const R0 = 180;

function stormInnerR(outerR, step, N) {
  return outerR * Math.cos(step * Math.PI / N);
}

let scene, camera, renderer, mesh, material;
let ready = false;

export function init(canvas) {
  if (ready) return;

  scene = new THREE.Scene();
  scene.background = null;

  camera = new THREE.PerspectiveCamera(35, 1, 1, 3000);
  camera.position.set(0, 0, 634);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;

  // Lighting — brighter for light-background context
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(200, 300, 400);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xaaaadd, 0.7);
  fill.position.set(-200, 100, -100);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.4);
  rim.position.set(0, -200, 300);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xddeeff, 0x444466, 0.5));

  // Environment map for reflections — mid-tone for light background
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(
    new THREE.SphereGeometry(100, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0x667788, side: THREE.BackSide })
  ));
  const topLight = new THREE.Mesh(
    new THREE.SphereGeometry(25, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  topLight.position.set(0, 70, 0);
  envScene.add(topLight);
  const sideLight = new THREE.Mesh(
    new THREE.SphereGeometry(15, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0x8899aa })
  );
  sideLight.position.set(-50, 10, 40);
  envScene.add(sideLight);
  scene.environment = pmrem.fromScene(envScene, 0, 0.1, 1000).texture;
  pmrem.dispose();

  // Material — indigo, semi-metallic so color reads on light backgrounds
  material = new THREE.MeshPhysicalMaterial({
    color: 0x6366f1,
    metalness: 0.7,
    roughness: 0.18,
    clearcoat: 0.4,
    clearcoatRoughness: 0.05,
    envMapIntensity: 1.0,
  });

  ready = true;
}

/**
 * Build (or rebuild) the extruded storm mesh.
 */
export function build(N, step, sw, depth) {
  if (!ready) return;
  if (mesh) {
    mesh.geometry.dispose();
    scene.remove(mesh);
    mesh = null;
  }

  const bevelT = Math.min(sw * 0.15, 1.5);
  const hw = sw / 2 - bevelT;                 // shape + bevel = sw/2 visually
  const extrudeOpts = {
    depth,
    bevelEnabled: true,
    bevelThickness: bevelT,
    bevelSize: bevelT,
    bevelSegments: 2,
  };

  const geometries = [];

  // Single degree, rotation=0
  const outerR = R0;

  // Circle — extruded annulus
  const ring = new THREE.Shape();
  ring.absarc(0, 0, outerR + hw, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, Math.max(outerR - hw, 0.1), 0, Math.PI * 2, true);
  ring.holes.push(hole);
  geometries.push(new THREE.ExtrudeGeometry(ring, { ...extrudeOpts, curveSegments: 64 }));

  // Chords
  for (let n = 0; n < N; n++) {
    const a1 = n * 2 * Math.PI / N;
    const a2 = (n + step) * 2 * Math.PI / N;
    const x1 = outerR * Math.cos(a1), y1 = outerR * Math.sin(a1);
    const x2 = outerR * Math.cos(a2), y2 = outerR * Math.sin(a2);
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.01) continue;
    const nx = -dy / len * hw, ny = dx / len * hw;

    const shape = new THREE.Shape();
    shape.moveTo(x1 + nx, y1 + ny);
    shape.lineTo(x2 + nx, y2 + ny);
    shape.lineTo(x2 - nx, y2 - ny);
    shape.lineTo(x1 - nx, y1 - ny);
    shape.closePath();
    geometries.push(new THREE.ExtrudeGeometry(shape, extrudeOpts));
  }

  const merged = BufferGeometryUtils.mergeGeometries(geometries);
  geometries.forEach(g => g.dispose());
  if (!merged) return;

  merged.computeBoundingBox();
  merged.center();
  merged.computeVertexNormals();

  mesh = new THREE.Mesh(merged, material);
  scene.add(mesh);
}

/**
 * Resize the renderer to match the current canvas display size.
 */
export function resize() {
  if (!ready) return;
  const canvas = renderer.domElement;
  const w = canvas.clientWidth || 400;
  const h = canvas.clientHeight || 400;
  if (canvas.width !== w * renderer.getPixelRatio() ||
      canvas.height !== h * renderer.getPixelRatio()) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

/**
 * Render one frame.
 * @param {number} tiltX — X rotation in radians (pitch)
 * @param {number} tiltY — Y rotation in radians (yaw)
 * @param {number} spinZ — Z rotation in radians (roll / slow spin)
 */
export function frame(tiltX, tiltY, spinZ) {
  if (!ready || !mesh) return;
  resize();
  mesh.rotation.x = tiltX;
  mesh.rotation.y = tiltY;
  mesh.rotation.z = spinZ;
  renderer.render(scene, camera);
}

export function dispose() {
  if (mesh) { mesh.geometry.dispose(); scene.remove(mesh); mesh = null; }
  if (material) { material.dispose(); material = null; }
  if (renderer) { renderer.dispose(); renderer = null; }
  scene = camera = null;
  ready = false;
}

export function isReady() { return ready; }
