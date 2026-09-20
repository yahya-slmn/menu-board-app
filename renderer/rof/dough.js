import * as THREE from 'three';
import { fbm2, rng, tileableNoiseData } from './noise.js';

// One shared noise texture for every dough material (see tileableNoiseData). Created lazily, never
// disposed -- 64 KB, and a new WebGL context simply re-uploads it.
let _noiseTex = null;
function noiseTexture() {
  if (!_noiseTex) {
    _noiseTex = new THREE.DataTexture(tileableNoiseData(256, 32, 5), 256, 256, THREE.RedFormat, THREE.UnsignedByteType);
    _noiseTex.wrapS = _noiseTex.wrapT = THREE.RepeatWrapping;
    _noiseTex.minFilter = THREE.LinearMipmapLinearFilter; _noiseTex.magFilter = THREE.LinearFilter;
    _noiseTex.generateMipmaps = true;
    _noiseTex.needsUpdate = true;
  }
  return _noiseTex;
}

// Procedural dough pieces. One generator covers every shape: a piece is a plan outline (half-width
// W(s) along its length s in [-1, 1]) plus a dome height profile, roughened with seeded noise so no
// two pieces are identical. Chef-configurable presets (length/width/height/taper/score) just feed
// numbers into it -- no per-shape art.
//
// Rising is a MORPH TARGET (a second, puffed-up copy of the same mesh) rather than a vertex-shader
// trick, so shadows and ambient occlusion -- which render the geometry themselves -- always see the
// risen shape. Browning, scoring, flour and surface relief are done in the fragment shader.

// Bake colour ramp (sRGB). Kept in one place so it can be calibrated against reference photos.
export const BAKE_COLORS = {
  raw: '#E8D6AD',        // pale cream, floury
  gold: '#C4914F',       // golden crust
  deep: '#7E4A24',       // deep-baked
  scoreInterior: '#EDD8A8', // the paler crumb a slash exposes
  flour: '#F3EEE2',
};

// Per-archetype outline/profile and how much it grows when it rises (fractions of raw size).
export const ARCHETYPES = {
  ball: { label: 'Ball',  across: 2.1, mu: 0.95, rise: { h: 0.44, w: 0.10, l: 0.10, center: 0.30 }, flour: 0.9 },
  disc: { label: 'Disc',  across: 2.3, mu: 0.9,  rise: { h: 0.55, w: 0.12, l: 0.12, center: 0.25 }, flour: 0.8 },
  log:  { label: 'Log',   across: 2.2, mu: 0.85, rise: { h: 0.55, w: 0.24, l: 0.05, center: 0.30 }, flour: 0.8 },
  oval: { label: 'Oval',  across: 2.6, mu: 0.8,  rise: { h: 0.50, w: 0.14, l: 0.10, center: 0.20 }, flour: 1.0 },
  sheet: { label: 'Sheet', across: 2, mu: 1, rise: { h: 0.95, w: 0, l: 0, center: 0.1 }, flour: 0.9 },
};

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Half-width envelope of the plan outline, 1 at the middle and 0 at both tips.
function widthFn(archetype, taper) {
  if (archetype === 'log') {
    const tp = 2 - 0.75 * taper, tq = 0.5 + 0.3 * taper; // taper 0 = ellipse, 1 = pointed baguette ends
    return (s) => Math.pow(Math.max(0, 1 - Math.pow(Math.abs(s), tp)), tq);
  }
  if (archetype === 'oval') return (s) => Math.pow(Math.max(0, 1 - Math.pow(Math.abs(s), 3.0)), 1 / 3.0); // soft rectangle
  return (s) => Math.sqrt(Math.max(0, 1 - s * s)); // ball / disc: circle or ellipse
}

// spec: { archetype, lengthCm, widthCm, heightCm, taper?, score? (slash count) }
// `spread` scales how much room the piece reserves for rising (the rise model's width multiplier: a slack
// dough needs more, a stiff one less).
export function buildDoughGeometry(spec, seed, spread = 1) {
  const arche = ARCHETYPES[spec.archetype] || ARCHETYPES.ball;
  const L = spec.lengthCm, Wd = spec.widthCm, H = spec.heightCm;
  const a = L / 2, b = Wd / 2;
  const W = widthFn(spec.archetype, spec.taper ?? (spec.archetype === 'log' ? 0.8 : 0));
  const Ns = clamp(Math.round(L * 2.2), 40, 132), Nt = 26;
  const R = arche.rise;
  const rand = rng(seed * 7919 + 13);
  const ox = rand() * 100, oz = rand() * 100;

  const nVerts = (Ns + 1) * (Nt + 1);
  const pos = new Float32Array(nVerts * 3), taller = new Float32Array(nVerts * 3), wider = new Float32Array(nVerts * 3), rho = new Float32Array(nVerts);
  let k = 0;
  for (let i = 0; i <= Ns; i++) {
    const s = -Math.cos((Math.PI * i) / Ns); // dense at the tips
    const w = W(s);
    for (let j = 0; j <= Nt; j++) {
      const t = -Math.cos((Math.PI * j) / Nt);
      let x = a * s, z = b * w * t;
      const hs = Math.pow(w, arche.mu);
      const ht = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(t), arche.across)), 1 / arche.across);
      let y = H * hs * ht;
      // organic irregularity: low-frequency lumps in height, slight wobble of the outline
      const n1 = fbm2(x * 0.16 + ox, z * 0.16 + oz, seed, 3);
      const n2 = fbm2(x * 0.27 + oz, z * 0.27 + ox, seed + 5, 2);
      y *= 1 + 0.16 * (n1 - 0.5) * 2;
      x += (n2 - 0.5) * 0.018 * L * (1 - Math.abs(s));
      z += (fbm2(x * 0.3 + 50, z * 0.3, seed + 9, 2) - 0.5) * 0.04 * b * w;
      y = Math.max(0, y) - 0.05; // sink the rim a hair into the tray so there's no light gap
      const r = Math.min(1, Math.hypot(s, t));
      pos.set([x, y, z], k * 3);
      // Two puffed copies, driven separately (a slack dough spreads but doesn't climb; a stiff one climbs
      // but doesn't spread): "taller" grows the height (the centre rises most), "wider" the footprint.
      const gy = 1 + R.h * (1 - R.center * r), gxz = 1 + R.w, gl = 1 + R.l;
      taller.set([x, y * gy, z], k * 3);
      wider.set([x * gl, y, z * gxz], k * 3);
      rho[k] = r;
      k++;
    }
  }
  const idx = [];
  for (let i = 0; i < Ns; i++) for (let j = 0; j < Nt; j++) {
    const p = i * (Nt + 1) + j, q = p + Nt + 1;
    idx.push(p, p + 1, q, p + 1, q + 1, q); // counter-clockwise seen from above, so normals point up
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRho', new THREE.BufferAttribute(rho, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const targets = [taller, wider].map((arr) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  });
  geo.morphAttributes.position = targets.map(g => g.attributes.position);
  geo.morphAttributes.normal = targets.map(g => g.attributes.normal);
  targets.forEach(g => g.dispose());

  // Collision outline (convex): the piece's footprint AFTER it has risen, so pieces placed with this
  // outline never touch once they've proofed and baked. Top side, then back along the bottom side.
  // A little clearance beyond the risen size (4%) so loaves sit apart rather than exactly tangent.
  const outline = [], N = 14, gl = (1 + R.l * spread) * 1.04, gw = (1 + R.w * spread) * 1.04;
  for (let i = 0; i <= N; i++) { const s = -Math.cos((Math.PI * i) / N); outline.push([a * s * gl, b * W(s) * gw]); }
  for (let i = N; i >= 0; i--) { const s = -Math.cos((Math.PI * i) / N); outline.push([a * s * gl, -b * W(s) * gw]); }
  const poly = outline.filter((p, i) => i === 0 || Math.hypot(p[0] - outline[i - 1][0], p[1] - outline[i - 1][1]) > 0.05);
  // The un-risen footprint, for pieces resting on the bench (no rise room needed there).
  const raw = [];
  for (let i = 0; i <= N; i++) { const s = -Math.cos((Math.PI * i) / N); raw.push([a * s * 1.03, b * W(s) * 1.04]); }
  for (let i = N; i >= 0; i--) { const s = -Math.cos((Math.PI * i) / N); raw.push([a * s * 1.03, -b * W(s) * 1.04]); }
  const rawPoly = raw.filter((p, i) => i === 0 || Math.hypot(p[0] - raw[i - 1][0], p[1] - raw[i - 1][1]) > 0.05);
  return { geometry: geo, poly, rawPoly, height: H * (1 + R.h) };
}

// The plan outline of a shape plus where its score slashes fall, in cm -- for the Shapes modal's small
// preview (drawn in 2D, no WebGL context needed). Mirrors the slash layout in the shader below.
export function shapePreview(spec) {
  const built = buildDoughGeometry(spec, 1);
  const outline = built.rawPoly;
  built.geometry.dispose();
  const slashes = [];
  const n = spec.score || 0;
  if (n > 0) {
    const hl = spec.lengthCm / 2, halfL = spec.widthCm * 0.5 * 0.78, dx = 0.62 / Math.hypot(0.62, 1), dy = 1 / Math.hypot(0.62, 1);
    for (let i = 0; i < n; i++) {
      const cx = (((i + 0.5) / n) * 2 - 1) * hl * 0.74;
      slashes.push([cx - dx * halfL, -dy * halfL, cx + dx * halfL, dy * halfL]);
    }
  }
  return { outline, slashes };
}

// ---- material ----------------------------------------------------------------------------------

const GLSL_PARS = /* glsl */`
uniform float uBake, uRise, uSeed, uTint, uH, uFlour, uScore, uLen, uWid;
uniform vec3 uColRaw, uColGold, uColDeep, uColScore, uColFlour;
uniform sampler2D uNoise;
varying float vRho; varying vec2 vPlan; varying float vHt; varying vec3 vWN;
#ifdef SHEET
uniform sampler2D uMask; uniform vec4 uMaskBox; uniform float uScrap, uHasCuts;
// p = the vertex's local (x, z); the sheet's local z is the NEGATIVE of plan y, so plan y = -p.y.
float maskAt(vec2 p) { return texture2D(uMask, (vec2(p.x, -p.y) - uMaskBox.xy) / uMaskBox.zw).r; }
#endif

// Value noise, read from a precomputed tileable texture (1 lattice cell = 1 unit of p.xy; the seed in p.z
// just offsets where in the texture we look). Was ~8 hashed lattice points per call, ~160 per pixel.
float vnoise(vec3 p){ return texture2D(uNoise, p.xy * (1.0 / 32.0) + p.zz * vec2(0.3761, 0.6173)).r; }
float fbm3(vec3 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }

// Score slashes: diagonal cuts across the piece that open up as it rises. groove = the cut itself,
// ridge = the caramelised lip ("ear") beside it.
void slashField(vec2 p, out float groove, out float ridge, out float core){
  groove = 0.0; ridge = 0.0; core = 0.0;
  if (uScore < 0.5) return;
  float hl = uLen * 0.5;
  for (int i = 0; i < 9; i++) {
    if (float(i) >= uScore) break;
    float f = (float(i) + 0.5) / uScore;
    vec2 c = vec2((f * 2.0 - 1.0) * hl * 0.74, 0.0);
    vec2 dir = normalize(vec2(0.62, 1.0));
    float halfL = uWid * 0.5 * 0.78;
    vec2 q = p - c;
    float t = clamp(dot(q, dir), -halfL, halfL);
    vec2 dv = q - dir * t;
    float d = length(dv);
    float side = dot(dv, vec2(-dir.y, dir.x));
    float w = 0.14 + 0.26 * uRise;                       // the cut opens as the loaf springs
    float endFade = 1.0 - smoothstep(halfL * 0.7, halfL, abs(t));
    groove = max(groove, (1.0 - smoothstep(w * 0.35, w * 1.15, d)) * (0.4 + 0.6 * endFade));
    core = max(core, 1.0 - smoothstep(0.0, w * 0.7, d));
    // the "ear": one lip lifts and caramelises
    float lip = smoothstep(w * 0.8, w * 1.4, d) * (1.0 - smoothstep(w * 1.6, w * 3.6, d)); // 0 inside the cut, peaks at its edge
    ridge = max(ridge, lip * (0.35 + 0.65 * step(0.0, side)) * endFade);
  }
}
float doughHeight(vec2 p, float b){
  float pores = fbm3(vec3(p * 2.4, uSeed));
  float blister = smoothstep(0.52, 0.86, fbm3(vec3(p * 0.6, uSeed + 4.0)));
  float g, r, c; slashField(p, g, r, c);
  return pores * 0.30 + blister * 0.70 * b + r * 0.42 * uRise - g * 0.26;
}
vec3 perturbNormalDough(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection){
  vec3 vSigmaX = normalize(dFdx(surf_pos.xyz)), vSigmaY = normalize(dFdy(surf_pos.xyz));
  vec3 R1 = cross(vSigmaY, surf_norm), R2 = cross(surf_norm, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDirection;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
`;

const GLSL_COLOR = /* glsl */`
{
  float top = clamp(vWN.y, 0.0, 1.0);
#ifdef SHEET
  float blotch = fbm3(vec3(vPlan * 0.55, uSeed + 1.0)) * 0.55 + 0.225; // a big sheet: finer, gentler patchiness
#else
  float blotch = fbm3(vec3(vPlan * 0.20, uSeed + 1.0));
#endif
  float grain = fbm3(vec3(vPlan * 1.6, uSeed + 7.0));
  // How exposed this spot is to the oven: tops and rims first, hollows and the base last.
  float exposure = 0.50 * pow(top, 1.3) + 0.26 * vRho * vRho + 0.36 * (blotch - 0.5) + uTint;
  float b = smoothstep(0.0, 1.0, clamp(uBake * 1.38 - (1.0 - exposure) * 0.85, 0.0, 1.0));
  vec3 base = mix(uColRaw, uColGold, smoothstep(0.0, 0.58, b));
  base = mix(base, uColDeep, smoothstep(0.5, 1.0, b));
  base *= 0.90 + 0.20 * grain;

  float groove, ridge, core; slashField(vPlan, groove, ridge, core);
  // The cut exposes paler crumb that browns much more slowly; its lip caramelises darker.
  vec3 crumb = mix(uColScore, uColGold, smoothstep(0.35, 1.0, b) * 0.5);
  crumb *= 1.0 - 0.38 * core; // deep in the cut it's shadowed
  base = mix(base, crumb, groove * (0.5 + 0.5 * uRise));
  base = mix(base, uColDeep, ridge * smoothstep(0.2, 0.9, b) * 0.6);

  // Flour dusting: speckled on the raw dough, mostly gone (baked into the crust) by the end.
  float flour = smoothstep(0.60, 0.90, fbm3(vec3(vPlan * 3.1, uSeed + 3.0))) * (1.0 - smoothstep(0.1, 0.7, b)) * uFlour;
  base = mix(base, uColFlour, flour * 0.6);

#ifdef SHEET
  {
    float m = maskAt(vPlan);
    float e = 0.3;
    float edge = clamp(abs(maskAt(vPlan + vec2(e, 0.0)) - m) + abs(maskAt(vPlan - vec2(e, 0.0)) - m) + abs(maskAt(vPlan + vec2(0.0, e)) - m) + abs(maskAt(vPlan - vec2(0.0, e)) - m), 0.0, 1.0);
    base *= 1.0 - 0.4 * edge; // the cut line
    // Scrap (everything outside the cutters) is dimmed and greyed once there are cuts to compare against.
    float scrap = (1.0 - m) * uScrap * uHasCuts;
    vec3 grey = vec3(dot(base, vec3(0.3, 0.59, 0.11)));
    base = mix(base, mix(grey, vec3(0.30, 0.38, 0.52), 0.35) * 0.8, scrap * 0.62);
  }
#endif

  // Contact darkening where the piece meets the tray (a cheap floor for tiers without SSAO).
  base *= mix(0.55, 1.0, smoothstep(0.0, 0.4, vHt / max(uH, 0.01)));
  diffuseColor.rgb = base;
  dough_b = b; dough_grain = grain;
}
`;

export function createDoughMaterial({ seed = 1, tint = 0, archetype = 'ball', score = 0, lengthCm = 10, widthCm = 10, heightCm = 4, sheet = null } = {}) {
  const uniforms = {
    uBake: { value: 0 }, uRise: { value: 0 }, uSeed: { value: seed * 1.37 }, uTint: { value: tint },
    uH: { value: heightCm }, uFlour: { value: (ARCHETYPES[archetype] || ARCHETYPES.ball).flour },
    uScore: { value: score }, uLen: { value: lengthCm }, uWid: { value: widthCm },
    uColRaw: { value: new THREE.Color(BAKE_COLORS.raw) }, uColGold: { value: new THREE.Color(BAKE_COLORS.gold) },
    uColDeep: { value: new THREE.Color(BAKE_COLORS.deep) }, uColScore: { value: new THREE.Color(BAKE_COLORS.scoreInterior) },
    uColFlour: { value: new THREE.Color(BAKE_COLORS.flour) },
    uNoise: { value: noiseTexture() },
  };
  if (sheet) {
    // Sheet & Trim: the cutter mask, which covers the tray's plan bounds (minX, minY, width, height in cm).
    const p = sheet.plan;
    uniforms.uMask = { value: sheet.mask };
    uniforms.uMaskBox = { value: new THREE.Vector4(p.minX, p.minY, p.maxX - p.minX, p.maxY - p.minY) };
    uniforms.uScrap = { value: 1 };
    uniforms.uHasCuts = { value: 0 };
  }
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.62, metalness: 0, sheen: 0.5, sheenColor: new THREE.Color(0xfff0d2), sheenRoughness: 0.55,
    envMapIntensity: 0.4,
  });
  mat.userData.uniforms = uniforms;
  if (sheet) mat.defines = { SHEET: '' };
  mat.customProgramCacheKey = () => (sheet ? 'rof-dough-v1-sheet' : 'rof-dough-v1');
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aRho;\nvarying float vRho; varying vec2 vPlan; varying float vHt; varying vec3 vWN;')
      .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\nvWN = normalize(mat3(modelMatrix) * objectNormal);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPlan = position.xz; vRho = aRho; vHt = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_PARS + '\nfloat dough_b = 0.0; float dough_grain = 0.5;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + GLSL_COLOR)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.50, 0.80, dough_b) + 0.10 * (dough_grain - 0.5);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float hh = doughHeight(vPlan, dough_b);
          float ndv = abs(dot(normal, normalize(vViewPosition)));
          vec2 dH = vec2(dFdx(hh), dFdy(hh)) * mix(2.2, 4.4, dough_b) * smoothstep(0.08, 0.5, ndv);
          normal = perturbNormalDough(-vViewPosition, normal, dH, faceDirection);
        }`);
  };
  return mat;
}

// One placed piece: a mesh with its own material (own bake/seed uniforms). setRise/setBake are
// 0..1 (rise can overshoot a little for an oven-spring feel).
export function createDoughPiece(spec, { seed = 1, spread = 1 } = {}) {
  const built = buildDoughGeometry(spec, seed, spread);
  const rand = rng(seed * 104729 + 3);
  const material = createDoughMaterial({
    seed, tint: (rand() - 0.5) * 0.16, archetype: spec.archetype, score: spec.score || 0,
    lengthCm: spec.lengthCm, widthCm: spec.widthCm, heightCm: spec.heightCm,
  });
  const mesh = new THREE.Mesh(built.geometry, material);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.morphTargetInfluences = [0, 0];
  const group = new THREE.Group();
  group.add(mesh);
  const u = material.userData.uniforms;
  return {
    group, poly: built.poly, rawPoly: built.rawPoly, height: built.height, mesh, material,
    // 1 = the shape's standard rise. `h` drives height, `w` (default = h) the footprint.
    setRise(h, w = h) { mesh.morphTargetInfluences[0] = h; mesh.morphTargetInfluences[1] = w; u.uRise.value = clamp((h + w) / 2, 0, 1.2); },
    setBake(v) { u.uBake.value = clamp(v, 0, 1); },
    get rise() { return mesh.morphTargetInfluences[0]; },
    get bake() { return u.uBake.value; },
    dispose() { built.geometry.dispose(); material.dispose(); },
  };
}

// The four seed shapes (real-world sizes at raw, before proofing).
export const SEED_SHAPES = {
  burgerBall:   { key: 'burgerBall',   label: 'Burger Ball',   archetype: 'ball', lengthCm: 9.5,  widthCm: 9.5, heightCm: 4.6, weight: 90 },
  longBaguette: { key: 'longBaguette', label: 'Long Baguette', archetype: 'log',  lengthCm: 48,   widthCm: 5.4, heightCm: 3.4, taper: 0.85, score: 5, weight: 250 },
  miniBaguette: { key: 'miniBaguette', label: 'Mini Baguette', archetype: 'log',  lengthCm: 18,   widthCm: 4.0, heightCm: 2.9, taper: 0.8,  score: 3, weight: 60 },
  ciabatta:     { key: 'ciabatta',     label: 'Ciabatta',      archetype: 'oval', lengthCm: 24,   widthCm: 10,  heightCm: 3.4, taper: 0,    score: 0, weight: 220 },
};
