import * as THREE from 'three';
import { rng } from './noise.js';

// Layered tray: what a filling layer looks like -- a base colour with flecks -- guessed from its ingredient
// NAMES (keyword matching, like riseModel.js; no AI), weighted by how much of each there is. fillingLook is pure;
// createFillingMaterial turns a look into a material for a sheet mesh (sheet.js, `makeMaterial`).

// [pattern, role, colour]. A 'base' ingredient colours the mass; a 'fleck' one shows as bits in it. First match wins.
const RULES = [
  [/\b(spinach|chard|kale|parsley|coriander|cilantro|dill|mint|basil|herb|herbs|rocket|arugula|leek|spring onion|scallion|chive|zucchini|courgette|broccoli|pea|peas)\b/, 'fleck', '#3f6b2a'],
  [/\b(feta|halloumi|akkawi|ricotta|labneh|cottage|mozzarella|cream cheese|white cheese)\b/, 'fleck', '#f4efe2'],
  [/\b(cheddar|kashkaval|gouda|emmental|parmesan|cheese)\b/, 'fleck', '#f0c95a'],
  [/\b(tomato|tomatoes|pepper paste|red pepper|capsicum|harissa|paprika)\b/, 'base', '#b8452c'],
  [/\b(mushroom|mushrooms)\b/, 'fleck', '#8a6d52'],
  [/\b(beef|lamb|mince|minced|meat|kafta|sausage|turkey|chicken)\b/, 'fleck', '#7a4a33'],
  [/\b(chocolate|cocoa)\b/, 'base', '#4a2c1d'],
  [/\b(date|dates|dibs|molasses)\b/, 'base', '#6b3f22'],
  [/\b(apple|pear)\b/, 'fleck', '#e9d7a0'],
  [/\b(berry|berries|strawberry|raspberry|cherry|cherries)\b/, 'fleck', '#9c2336'],
  [/\b(onion|onions|garlic)\b/, 'fleck', '#eadfc4'],
  [/\b(egg|eggs|yolk|yolks)\b/, 'base', '#e8c65c'],
  [/\b(cream|milk|custard|bechamel|béchamel|yogh?urt|laban)\b/, 'base', '#f1e6c8'],
];
const DEFAULT_BASE = '#eadcb4'; // a creamy filling when nothing says otherwise

function grams(row) {
  const q = typeof row.quantity === 'number' ? row.quantity : parseFloat(row.quantity);
  if (!(q > 0)) return 0;
  return String(row.unit || 'g').trim().toLowerCase() === 'kg' ? q * 1000 : q;
}

// { base: '#rrggbb', flecks: [{ color, share }] (share of the fleck area, largest first, at most 3), density (0..1:
// how much of the surface is flecks) }.
export function fillingLook(rows) {
  const baseW = new Map(), fleckW = new Map();
  let total = 0, fleckTotal = 0;
  for (const row of rows || []) {
    const name = String(row.name || '').toLowerCase(), g = grams(row);
    if (!g || !name) continue;
    total += g;
    const rule = RULES.find(([rx]) => rx.test(name));
    if (!rule) continue;
    const [, role, color] = rule;
    const m = role === 'base' ? baseW : fleckW;
    m.set(color, (m.get(color) || 0) + g);
    if (role === 'fleck') fleckTotal += g;
  }
  // The base: the heaviest base colour, else the default cream.
  const base = [...baseW.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || DEFAULT_BASE;
  const flecks = [...fleckW.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const fSum = flecks.reduce((s, [, w]) => s + w, 0);
  return {
    base,
    flecks: flecks.map(([color, w]) => ({ color, share: fSum > 0 ? w / fSum : 0 })),
    density: total > 0 ? Math.min(0.55, 0.12 + 0.6 * (fleckTotal / total)) : 0,
  };
}

// A tileable canvas texture: the base colour, soft mottling, and flecks of each colour in proportion.
function fillingTexture(look, seed) {
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const rand = rng(seed * 104729 + 11);
  ctx.fillStyle = look.base; ctx.fillRect(0, 0, S, S);
  // Mottling: a few hundred faint lighter / darker blotches.
  for (let i = 0; i < 260; i++) {
    const x = rand() * S, y = rand() * S, r = 4 + rand() * 14;
    ctx.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    for (const [dx, dy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) { ctx.beginPath(); ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2); ctx.fill(); }
  }
  const count = Math.round(look.density * 900);
  for (const f of look.flecks) {
    ctx.fillStyle = f.color;
    const n = Math.round(count * f.share);
    for (let i = 0; i < n; i++) {
      const x = rand() * S, y = rand() * S, w = 2 + rand() * 6, h = 1.5 + rand() * 4, a = rand() * Math.PI;
      for (const [dx, dy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) {
        ctx.save(); ctx.translate(x + dx, y + dy); ctx.rotate(a);
        ctx.beginPath(); ctx.ellipse(0, 0, w, h, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// A material for a filling sheet. The sheet's geometry carries a `uv` in cm / 10 (sheet.js), so one texture
// tile covers 10 cm. `scrap` ({ mask, plan }: the bottom sheet's cutter mask texture and the tray's plan bounds) lets
// the top of a layered stack show the Trim step's cut lines and red, hatched scrap exactly as the dough shader does
// (dough.js, the SHEET block) -- same mask, same plan coordinates. Its uniforms sit in userData.uniforms, where
// sheet.js's setHasCuts / setScrapHighlight reach them (uRise / uBake are there only so its setters have a target).
export function createFillingMaterial(look, { seed = 3, scrap = null } = {}) {
  const map = fillingTexture(look, seed);
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.82, metalness: 0 });
  const uniforms = { uRise: { value: 0 }, uBake: { value: 0 }, uScrap: { value: 1 }, uHasCuts: { value: 0 } };
  if (scrap) {
    const p = scrap.plan;
    uniforms.uMask = { value: scrap.mask };
    uniforms.uMaskBox = { value: new THREE.Vector4(p.minX, p.minY, p.maxX - p.minX, p.maxY - p.minY) };
    mat.customProgramCacheKey = () => 'rof-filling-v1-scrap';
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vPlanF;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPlanF = position.xz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec2 vPlanF;
          uniform sampler2D uMask; uniform vec4 uMaskBox; uniform float uScrap, uHasCuts;
          float fMaskAt(vec2 q) { return texture2D(uMask, (vec2(q.x, -q.y) - uMaskBox.xy) / uMaskBox.zw).r; }`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          {
            float m = fMaskAt(vPlanF), e = 0.3;
            float edge = clamp(abs(fMaskAt(vPlanF + vec2(e, 0.0)) - m) + abs(fMaskAt(vPlanF - vec2(e, 0.0)) - m) + abs(fMaskAt(vPlanF + vec2(0.0, e)) - m) + abs(fMaskAt(vPlanF - vec2(0.0, e)) - m), 0.0, 1.0);
            diffuseColor.rgb *= 1.0 - 0.4 * edge * uHasCuts;
            float scrapK = (1.0 - m) * uScrap * uHasCuts;
            float tri = abs(fract((vPlanF.x + vPlanF.y) * 0.45) - 0.5) * 2.0;
            float hatch = smoothstep(0.42, 0.58, tri);
            vec3 red = vec3(0.80, 0.16, 0.13);
            vec3 tinted = mix(diffuseColor.rgb * 0.9, red, 0.6);
            tinted = mix(tinted, red * 0.55, hatch * 0.5);
            diffuseColor.rgb = mix(diffuseColor.rgb, tinted, scrapK);
          }`);
    };
  }
  mat.userData.uniforms = uniforms;
  const dispose = mat.dispose.bind(mat);
  mat.dispose = () => { map.dispose(); dispose(); };
  return mat;
}
