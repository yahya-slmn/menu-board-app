import * as THREE from 'three';
import { fbm2, rng } from './noise.js';
import { createDoughMaterial } from './dough.js';

// Sheet & Trim: the dough as ONE mass filling the tray's interior. The mesh is a fine grid over the
// interior shape with a height that rolls off to zero at the tray wall (so the sheet's edges are soft,
// not a hard extrusion), lumped with seeded noise. It rises like a dough piece (a morph target) and
// browns with the same shader; a mask texture marks where cutters have been placed so the scrap
// outside them can be highlighted. Plan (x, y) -> world (x, height, -y); the sheet lives at the origin.

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function sdfFor(region) {
  if (region.kind === 'circle') return (x, y) => region.r - Math.hypot(x, y);
  if (region.kind === 'rect') return (x, y) => Math.min(region.hw - Math.abs(x), region.hh - Math.abs(y));
  const pts = region.pts, n = pts.length;
  let area2 = 0;
  for (let i = 0; i < n; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n]; area2 += x1 * y2 - x2 * y1; }
  const ccw = area2 > 0;
  return (x, y) => {
    let d = Infinity;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
      const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey) || 1;
      d = Math.min(d, ((x - ax) * (ccw ? -ey : ey) + (y - ay) * (ccw ? ex : -ex)) / len);
    }
    return d;
  };
}

// A grid of (x, y) over the region, densest at its boundary (cosine spacing) where the height rolls off.
function gridFor(region, plan) {
  const cos = (i, n) => -Math.cos((Math.PI * i) / n);
  const verts = [];
  let Ns, Nt;
  if (region.kind === 'circle') {
    const R = region.r; Ns = 72; Nt = 60;
    for (let i = 0; i <= Ns; i++) { const s = cos(i, Ns); for (let j = 0; j <= Nt; j++) { const t = cos(j, Nt); verts.push([R * s, R * Math.sqrt(Math.max(0, 1 - s * s)) * t]); } }
  } else if (region.kind === 'rect') {
    const w = 2 * region.hw, h = 2 * region.hh;
    Ns = clamp(Math.round(w * 1.7), 40, 130); Nt = clamp(Math.round(h * 1.7), 30, 110);
    for (let i = 0; i <= Ns; i++) { const s = cos(i, Ns); for (let j = 0; j <= Nt; j++) verts.push([region.hw * s, region.hh * cos(j, Nt)]); }
  } else {
    // Triangle: rows from the apex down to the base, each as wide as the triangle is at that height.
    const pts = region.pts, apex = pts.reduce((a, p) => (p[1] > a[1] ? p : a), pts[0]);
    const base = pts.filter(p => p !== apex), baseY = base[0][1], halfBase = Math.abs(base[1][0] - base[0][0]) / 2;
    Ns = 70; Nt = 50;
    for (let i = 0; i <= Ns; i++) {
      const s = (cos(i, Ns) + 1) / 2, y = apex[1] + (baseY - apex[1]) * s;
      for (let j = 0; j <= Nt; j++) verts.push([apex[0] + cos(j, Nt) * halfBase * s, y]);
    }
  }
  return { verts, Ns, Nt };
}

// Draws where the cutters are (white on black) into a canvas covering the tray's plan bounds, 8 px/cm.
class CutterMask {
  constructor(plan) {
    this.plan = plan;
    this.k = 8;
    this.w = Math.ceil((plan.maxX - plan.minX) * this.k);
    this.h = Math.ceil((plan.maxY - plan.minY) * this.k);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w; this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.clear();
  }
  clear() { this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, this.w, this.h); this.texture.needsUpdate = true; }
  // cutters: [{ poly (local, plan cm), x, y, rot }]
  redraw(cutters) {
    const { ctx, plan, k } = this;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, this.w, this.h);
    ctx.fillStyle = '#fff';
    for (const c of cutters) {
      const cs = Math.cos(c.rot), sn = Math.sin(c.rot);
      ctx.beginPath();
      c.poly.forEach(([px, py], i) => {
        const X = c.x + px * cs - py * sn, Y = c.y + px * sn + py * cs;
        const cx = (X - plan.minX) * k, cy = (plan.maxY - Y) * k; // canvas y runs down, plan y runs up
        if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
      });
      ctx.closePath(); ctx.fill();
    }
    this.texture.needsUpdate = true;
  }
  dispose() { this.texture.dispose(); }
}

export function createSheet({ region, plan, thicknessCm, seed = 7 }) {
  const H = thicknessCm;
  const sdf = sdfFor(region);
  const { verts, Ns, Nt } = gridFor(region, plan);
  const minDim = Math.min(plan.maxX - plan.minX, plan.maxY - plan.minY);
  const rollW = Math.min(0.9, Math.max(0.35, H * 0.8)); // width of the rounded edge
  const rand = rng(seed * 7919 + 5), ox = rand() * 100, oz = rand() * 100;
  const n = verts.length;
  const pos = new Float32Array(n * 3), taller = new Float32Array(n * 3), rho = new Float32Array(n);
  const RISE_H = 0.95;
  verts.forEach(([x, y], k) => {
    const d = Math.max(0, sdf(x, y));
    const roll = Math.sqrt(Math.max(0, 1 - Math.pow(1 - Math.min(d / rollW, 1), 2)));
    const lump = fbm2(x * 0.11 + ox, y * 0.11 + oz, seed, 3), fine = fbm2(x * 0.5 + oz, y * 0.5 + ox, seed + 3, 2);
    let h = H * roll * (1 + 0.10 * (lump - 0.5) * 2 + 0.03 * (fine - 0.5) * 2);
    h = Math.max(0, h) - (d < 0.05 ? 0.02 : 0.04);
    pos.set([x, Math.max(h, 0), -y], k * 3);
    // The middle of the sheet puffs a little more than its edges.
    const edgeK = clamp(d / (0.22 * minDim), 0, 1);
    taller.set([x, Math.max(h, 0) * (1 + RISE_H * (0.82 + 0.18 * edgeK)), -y], k * 3);
    rho[k] = 1 - edgeK; // 1 at the wall (browns first), 0 well inside
  });
  const idx = [];
  for (let i = 0; i < Ns; i++) for (let j = 0; j < Nt; j++) {
    const p = i * (Nt + 1) + j, q = p + Nt + 1;
    idx.push(p, p + 1, q, p + 1, q + 1, q);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRho', new THREE.BufferAttribute(rho, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Make sure the surface faces up whatever way the grid happened to be wound.
  const ny = geo.attributes.normal.array.reduce((a, v, i) => (i % 3 === 1 ? a + v : a), 0);
  if (ny < 0) { for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } geo.setIndex(idx); geo.computeVertexNormals(); }
  const tGeo = new THREE.BufferGeometry();
  tGeo.setAttribute('position', new THREE.BufferAttribute(taller, 3));
  tGeo.setIndex(Array.from(geo.index.array)); // a plain array: setIndex wants an Array or a BufferAttribute
  tGeo.computeVertexNormals();
  const zero = new THREE.BufferAttribute(new Float32Array(pos), 3); // "wider" target: the sheet can't spread, it's in a tray
  const zeroN = new THREE.BufferAttribute(new Float32Array(geo.attributes.normal.array), 3);
  geo.morphAttributes.position = [tGeo.attributes.position, zero];
  geo.morphAttributes.normal = [tGeo.attributes.normal, zeroN];
  tGeo.dispose();

  const mask = new CutterMask(plan);
  const material = createDoughMaterial({ seed, tint: 0, archetype: 'sheet', lengthCm: 10, widthCm: 10, heightCm: H, sheet: { mask: mask.texture, plan } });
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.morphTargetInfluences = [0, 0];
  const group = new THREE.Group();
  group.add(mesh);
  const u = material.userData.uniforms;
  let rise = 0;
  return {
    group, mesh, material, mask, thicknessCm: H,
    dough: null,
    setRise(h) { rise = h; mesh.morphTargetInfluences[0] = h; u.uRise.value = clamp(h, 0, 1.2); },
    setBake(v) { u.uBake.value = clamp(v, 0, 1); },
    get rise() { return rise; },
    // Height of the top surface at its thickest, for the current rise (cutters and ghosts sit relative to it).
    topY() { return H * (1 + RISE_H * rise); },
    setScrapHighlight(on) { u.uScrap.value = on ? 1 : 0; },
    setHasCuts(n) { u.uHasCuts.value = n > 0 ? 1 : 0; },
    dispose() { geo.dispose(); material.dispose(); mask.dispose(); },
  };
}
