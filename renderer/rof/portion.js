import * as THREE from 'three';
import { ARCHETYPES, BAKE_COLORS, createDoughPiece } from './dough.js';
import { RISE_H as SHEET_RISE_H } from './sheet.js';
import { roundedRectPath } from './trayModels.js';
import { createBench } from './bench.js';
import { tileableNoiseData } from './noise.js';

// The one-portion detail view: a single baked portion on a board, with its measurements.
//
// A portion is described by plain data (see game.js `openPortion`):
//   { kind: 'piece', spec, hMul, wMul, bake }                  Shape & Place: one shaped piece, after the bake
//   { kind: 'cut',   shapeType, dims, thicknessCm, hMul, bake } Sheet & Trim: one piece cut from the baked sheet
// `spec` / `thicknessCm` are the RAW sizes; hMul / wMul are the rise model's multipliers (already scaled by the
// chef's Rise slider). Every size that comes from those multipliers is an estimate and is flagged `est`.

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
// Centimetres as shown everywhere in this view (card, lines, PDF): estimates to 1 decimal, exact sizes to 2.
export function fmtCm(v, est = false) { const k = est ? 10 : 100; return `${Math.round(v * k) / k} cm`; }

// ---- measurements (pure) -----------------------------------------------------------------------
// Mirrors how the dough shader morphs a piece (dough.js buildDoughGeometry: length grows by R.l * wMul, width by
// R.w * wMul, the middle's height by R.h * hMul) and how the sheet rises (sheet.js: raw thickness * (1 + RISE_H * hMul)).
export function measurePortion(d) {
  if (d.kind === 'cut') {
    const raw = d.thicknessCm, baked = raw * (1 + SHEET_RISE_H * d.hMul);
    const m = { kind: 'cut', shapeType: d.shapeType, heightCm: baked, rawHeightCm: raw, estimated: ['heightCm'] };
    const dm = d.dims;
    if (d.shapeType === 'round') Object.assign(m, { diameterCm: dm.diameterCm, areaCm2: Math.PI * (dm.diameterCm / 2) ** 2 });
    else if (d.shapeType === 'rectangular') Object.assign(m, { lengthCm: dm.lengthCm, widthCm: dm.widthCm, areaCm2: dm.lengthCm * dm.widthCm });
    else if (d.shapeType === 'triangle') Object.assign(m, { baseCm: dm.baseCm, triHeightCm: dm.triHeightCm, areaCm2: (dm.baseCm * dm.triHeightCm) / 2 });
    return m;
  }
  const s = d.spec, R = (ARCHETYPES[s.archetype] || ARCHETYPES.ball).rise;
  const lengthCm = s.lengthCm * (1 + d.wMul * R.l), widthCm = s.widthCm * (1 + d.wMul * R.w), heightCm = s.heightCm * (1 + d.hMul * R.h);
  const round = (s.archetype === 'ball' || s.archetype === 'disc') && Math.abs(lengthCm - widthCm) < 0.03 * lengthCm;
  return {
    kind: 'piece', archetype: s.archetype, lengthCm, widthCm, heightCm, round,
    raw: { lengthCm: s.lengthCm, widthCm: s.widthCm, heightCm: s.heightCm },
    estimated: ['lengthCm', 'widthCm', 'heightCm'],
  };
}

// ---- the model ---------------------------------------------------------------------------------
let noiseTex = null;
function bumpTexture() {
  if (!noiseTex) {
    noiseTex = new THREE.DataTexture(tileableNoiseData(256, 32, 11), 256, 256, THREE.RedFormat, THREE.UnsignedByteType);
    noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
    noiseTex.magFilter = noiseTex.minFilter = THREE.LinearFilter;
    noiseTex.needsUpdate = true;
  }
  return noiseTex;
}
// Crust colour for a bake level 0..1 (raw -> golden -> deep), the same ramp the dough shader uses.
function crustColor(b) {
  const raw = new THREE.Color(BAKE_COLORS.raw), gold = new THREE.Color(BAKE_COLORS.gold), deep = new THREE.Color(BAKE_COLORS.deep);
  return b < 0.55 ? raw.lerp(gold, b / 0.55) : gold.lerp(deep, (b - 0.55) / 0.45);
}

function cutShape(shapeType, dims) {
  const sh = new THREE.Shape();
  if (shapeType === 'round') { sh.absarc(0, 0, dims.diameterCm / 2, 0, Math.PI * 2, false); return { shape: sh, bounds: { hx: dims.diameterCm / 2, minY: -dims.diameterCm / 2, maxY: dims.diameterCm / 2 } }; }
  if (shapeType === 'rectangular') {
    const l = dims.lengthCm, w = dims.widthCm;
    roundedRectPath(sh, l, w, Math.min(0.35, Math.min(l, w) * 0.05));
    return { shape: sh, bounds: { hx: l / 2, minY: -w / 2, maxY: w / 2 } };
  }
  const b = dims.baseCm, t = dims.triHeightCm; // centroid at the origin, apex up the page
  sh.moveTo(-b / 2, -t / 3); sh.lineTo(b / 2, -t / 3); sh.lineTo(0, (2 * t) / 3); sh.closePath();
  return { shape: sh, bounds: { hx: b / 2, minY: -t / 3, maxY: (2 * t) / 3 } };
}

// Builds the showcase: a board, the portion on it, and the dimension lines to draw over it. Everything sits at the
// plan origin. `dims` are world-space segments { a, b, text, est }: world z = -plan y, and the camera looks from +z.
export function createPortionModel({ surfaces, desc }) {
  const m = measurePortion(desc);
  const group = new THREE.Group();
  const disposables = [];
  let hx, minZ, maxZ, top;

  if (desc.kind === 'piece') {
    hx = m.lengthCm / 2; maxZ = m.widthCm / 2; minZ = -maxZ;
  } else {
    const { bounds } = cutShape(desc.shapeType, desc.dims);
    hx = bounds.hx; minZ = -bounds.maxY; maxZ = -bounds.minY;
  }
  const spanX = hx * 2, spanZ = maxZ - minZ;
  const board = createBench({ surfaces, cx: 0, cy: 0, width: Math.max(spanX + 7, 17), depth: Math.max(spanZ + 7, 14) });
  group.add(board.group);
  disposables.push(board);
  const baseY = board.top;

  if (desc.kind === 'piece') {
    const piece = createDoughPiece(desc.spec, { seed: 11 });
    piece.setRise(desc.hMul, desc.wMul);
    piece.setBake(desc.bake);
    piece.group.position.y = baseY;
    group.add(piece.group);
    disposables.push(piece);
    top = baseY + m.heightCm;
  } else {
    const { shape } = cutShape(desc.shapeType, desc.dims);
    const t = Math.max(m.heightCm, 0.3), bev = Math.min(0.14, t * 0.16);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(t - 2 * bev, 0.05), bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelOffset: -bev, bevelSegments: 3, curveSegments: 48 });
    const bump = bumpTexture().clone();
    bump.repeat.set(0.16, 0.16); bump.needsUpdate = true;
    const top_ = new THREE.MeshStandardMaterial({ color: crustColor(desc.bake), roughness: 0.9, metalness: 0, bumpMap: bump, bumpScale: 1.4 });
    const side = new THREE.MeshStandardMaterial({ color: new THREE.Color(BAKE_COLORS.scoreInterior).lerp(crustColor(desc.bake), 0.18), roughness: 1, metalness: 0, bumpMap: bump, bumpScale: 0.9 });
    const mesh = new THREE.Mesh(geo, [top_, side]);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = baseY + bev;
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push({ dispose() { geo.dispose(); top_.dispose(); side.dispose(); bump.dispose(); } });
    top = baseY + t + 2 * bev;
  }

  // ---- dimension lines ----
  const off = clamp(0.12 * Math.max(spanX, spanZ), 1.3, 3);
  const est = new Set(m.estimated || []);
  const dims = [];
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const across = (label, key, value) => dims.push({ a: V(-hx, baseY, maxZ + off), b: V(hx, baseY, maxZ + off), text: `${label} ${fmtCm(value, est.has(key))}`, est: est.has(key) });
  const deep = (label, key, value) => dims.push({ a: V(hx + off, baseY, minZ), b: V(hx + off, baseY, maxZ), text: `${label} ${fmtCm(value, est.has(key))}`, est: est.has(key) });
  const tall = (label, key, value) => dims.push({ a: V(-hx - off, baseY, (minZ + maxZ) / 2), b: V(-hx - off, top, (minZ + maxZ) / 2), text: `${label} ${fmtCm(value, est.has(key))}`, est: est.has(key) });
  if (desc.kind === 'piece') {
    if (m.round) { across('Diameter', 'lengthCm', m.lengthCm); } else { across('Length', 'lengthCm', m.lengthCm); deep('Width', 'widthCm', m.widthCm); }
    tall('Height', 'heightCm', m.heightCm);
  } else if (desc.shapeType === 'round') {
    across('Diameter', 'diameterCm', m.diameterCm); tall('Thickness', 'heightCm', m.heightCm);
  } else if (desc.shapeType === 'rectangular') {
    across('Length', 'lengthCm', m.lengthCm); deep('Width', 'widthCm', m.widthCm); tall('Thickness', 'heightCm', m.heightCm);
  } else {
    across('Base', 'baseCm', m.baseCm); deep('Height', 'triHeightCm', m.triHeightCm); tall('Thickness', 'heightCm', m.heightCm);
  }
  // What the camera must keep in frame: the board's corners, the top of the piece and every dimension line's ends.
  const bw = Math.max(spanX + 7, 17) / 2, bd = Math.max(spanZ + 7, 14) / 2;
  const framePoints = [V(-bw, baseY, -bd), V(bw, baseY, -bd), V(bw, baseY, bd), V(-bw, baseY, bd), V(0, top, 0), ...dims.flatMap(d => [d.a, d.b])];
  return {
    group, dims, framePoints, measures: m, long: spanX > 3 * Math.max(spanZ, 1),
    radius: Math.hypot(bw, bd) + 1,
    dispose() { disposables.forEach(d => d.dispose?.()); },
  };
}

// ---- drawing the dimension lines (a 2D canvas laid over the stage, and the same drawing baked into captures) ----
const _v = new THREE.Vector3();
export function project(p, camera, W, H) {
  _v.copy(p).project(camera);
  return { x: (_v.x + 1) / 2 * W, y: (1 - _v.y) / 2 * H, behind: _v.z > 1 };
}
export function drawDims(ctx, W, H, dims, camera, scale = 1) {
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.lineCap = 'round';
  for (const d of dims) {
    const a = project(d.a, camera, W, H), b = project(d.b, camera, W, H);
    if (a.behind || b.behind) continue;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len, tick = 6 * scale;
    for (const [w, c] of [[4.2 * scale, 'rgba(10,20,15,.75)'], [2 * scale, '#f4f1e6']]) {
      ctx.strokeStyle = c; ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.moveTo(a.x + nx * tick, a.y + ny * tick); ctx.lineTo(a.x - nx * tick, a.y - ny * tick);
      ctx.moveTo(b.x + nx * tick, b.y + ny * tick); ctx.lineTo(b.x - nx * tick, b.y - ny * tick);
      ctx.stroke();
    }
    // The label sits on the middle of the line.
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, fs = 12.5 * scale;
    ctx.font = `600 ${fs}px system-ui, -apple-system, sans-serif`;
    const estW = d.est ? ctx.measureText(' est.').width * 0.85 : 0;
    const tw = ctx.measureText(d.text).width + estW, padX = 8 * scale, hgt = fs + 9 * scale;
    ctx.fillStyle = 'rgba(15,28,22,.88)';
    ctx.beginPath(); ctx.roundRect(mx - tw / 2 - padX, my - hgt / 2, tw + padX * 2, hgt, hgt / 2); ctx.fill();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillStyle = '#f4f1e6'; ctx.fillText(d.text, mx - tw / 2, my + 0.5 * scale);
    if (d.est) { ctx.fillStyle = 'rgba(244,241,230,.62)'; ctx.font = `500 ${fs * 0.85}px system-ui, -apple-system, sans-serif`; ctx.fillText(' est.', mx - tw / 2 + tw - estW, my + 0.5 * scale); }
  }
  ctx.restore();
}
