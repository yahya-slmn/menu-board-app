import * as THREE from 'three';

// Parametric tray and cutter models. Dimension semantics match Materials exactly (a tray's entered
// size is its OUTER footprint, wall thickness/floor thickness use the same clamp formulas as
// trayInteriorFootprint in renderer.js; a cutter's entered size is its INNER cutting size, with a
// thin wall added outward) so what's drawn here always agrees with the capacity/cutter math.
// Plan coordinates: cm, origin at the tray's own centre (triangle: base centre), +y up the page.
// Shapes are built in plan XY then rotated so plan y -> world -z and extrusion -> world up.

export const CUTTER_WALL_CM = 0.15;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export function roundedRectPath(p, w, h, r) {
  const x = -w / 2, y = -h / 2;
  r = Math.min(r, w / 2, h / 2);
  if (r < 0.05) {
    p.moveTo(x, y); p.lineTo(x + w, y); p.lineTo(x + w, y + h); p.lineTo(x, y + h); p.closePath();
    return p;
  }
  p.moveTo(x + r, y);
  p.lineTo(x + w - r, y); p.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  p.lineTo(x + w, y + h - r); p.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  p.lineTo(x + r, y + h); p.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  p.lineTo(x, y + r); p.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  p.closePath();
  return p;
}
function polygonPath(p, pts) {
  p.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
  p.closePath();
  return p;
}

// Offsets a convex polygon outward by d (negative d insets), by shifting every edge along its
// normal and re-intersecting neighbours. Winding-agnostic.
export function offsetConvexPolygon(pts, d) {
  const n = pts.length;
  let area2 = 0;
  for (let i = 0; i < n; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n]; area2 += x1 * y2 - x2 * y1; }
  const ccw = area2 > 0;
  const lines = pts.map((p, i) => {
    const q = pts[(i + 1) % n];
    const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1;
    const nx = ccw ? dy / len : -dy / len, ny = ccw ? -dx / len : dx / len;
    return { px: p[0] + nx * d, py: p[1] + ny * d, dx, dy };
  });
  return pts.map((_, i) => {
    const a = lines[(i + n - 1) % n], b = lines[i];
    const cross = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(cross) < 1e-9) return [b.px, b.py];
    const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / cross;
    return [a.px + a.dx * t, a.py + a.dy * t];
  });
}

// Brushed-metal textures are laid out in plan space (one tile per 30 cm) rather than with each
// geometry's own UVs -- lathe UVs wrap around the axis (giving ripples and a seam), and extrusion
// UVs are 1 unit per cm (a hatch-fine pattern). Vertical walls get the same lookup, which reads as
// brushed streaks running up them.
const TEXTURE_TILE_CM = 30;
export function planarUV(geo, plane, tile = TEXTURE_TILE_CM) {
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  if (!uv) return geo;
  const b = plane === 'xy' ? 1 : 2; // second coordinate: y for extruded shapes (plan xy), z for lathes
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / tile, (plane === 'xy' ? pos.getY(i) : pos.getZ(i)) / tile);
  uv.needsUpdate = true;
  return geo;
}

function mesh(geo, mat, { cast = true, receive = true, uv } = {}) {
  if (uv) planarUV(geo, uv);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}
function arc(cx, cy, r, a0, a1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * (i / n); out.push(new THREE.Vector2(cx + r * Math.cos(a), cy + r * Math.sin(a))); }
  return out;
}
function extrudedRing(outer, inner, y0, depth, bevel, mat) {
  const shape = outer.clone ? outer.clone() : outer;
  shape.holes.push(inner);
  const bt = bevel;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(depth - 2 * bt, 0.01), bevelEnabled: bt > 0, bevelThickness: bt, bevelSize: bt,
    bevelOffset: -bt, bevelSegments: 3, curveSegments: 16,
  });
  const m = mesh(geo, mat, { uv: 'xy' });
  m.rotation.x = -Math.PI / 2;
  m.position.y = y0 + bt;
  return m;
}
function extrudedSlab(shape, depth, mat) {
  const m = mesh(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 16 }), mat, { uv: 'xy' });
  m.rotation.x = -Math.PI / 2;
  return m;
}

// ---- trays -------------------------------------------------------------------------------------

export function buildTray({ shapeType, dims, footprint }, mats) {
  const group = new THREE.Group();
  let plan, region, floorTopY, rimTopY;

  if (shapeType === 'round') {
    const { diameterCm: d, heightCm: h } = dims;
    const outerR = d / 2;
    const wallT = clamp(outerR * 0.07, 0.3, Math.min(1.8, outerR * 0.4));
    const innerR = Math.max(outerR - wallT, 0.05);
    const floorT = clamp(h * 0.15, 0.3, Math.min(1.5, h * 0.6));
    const fb = Math.min(0.6, h * 0.25, outerR * 0.1);          // outer bottom fillet
    const fi = Math.min(0.4, (h - floorT) * 0.3, innerR * 0.1); // inner floor fillet
    const rr = wallT / 2;                                       // rolled rim radius
    const prof = [new THREE.Vector2(0, 0), ...arc(outerR - fb, fb, fb, -Math.PI / 2, 0, 6)];
    prof.push(...arc(outerR - rr, h - rr, rr, 0, Math.PI, 10));
    prof.push(...arc(innerR - fi, floorT + fi, fi, 0, -Math.PI / 2, 6), new THREE.Vector2(0, floorT));
    group.add(mesh(new THREE.LatheGeometry(prof, 128), mats.steel, { uv: 'xz' }));
    plan = { minX: -outerR, maxX: outerR, minY: -outerR, maxY: outerR };
    region = { kind: 'circle', r: innerR };
    floorTopY = floorT; rimTopY = h;
  } else if (shapeType === 'rectangular') {
    const { lengthCm: l, widthCm: w, heightCm: h } = dims;
    const wallT = clamp(Math.min(l, w) * 0.045, 0.3, Math.min(2, Math.min(l, w) * 0.4));
    const floorT = clamp(h * 0.15, 0.3, Math.min(1.5, h * 0.6));
    const cr = Math.min(1.6, Math.min(l, w) * 0.05);
    const outer = roundedRectPath(new THREE.Shape(), l, w, cr);
    const inner = roundedRectPath(new THREE.Path(), l - 2 * wallT, w - 2 * wallT, Math.max(cr - wallT, 0.25));
    group.add(extrudedSlab(roundedRectPath(new THREE.Shape(), l, w, cr), floorT, mats.steel));
    group.add(extrudedRing(outer, inner, floorT, h - floorT, Math.min(wallT * 0.42, 0.3), mats.steel));
    plan = { minX: -l / 2, maxX: l / 2, minY: -w / 2, maxY: w / 2 };
    region = { kind: 'rect', hw: footprint.innerL / 2, hh: footprint.innerW / 2 };
    floorTopY = floorT; rimTopY = h;
  } else if (shapeType === 'triangle') {
    const { baseCm: b, triHeightCm: triH, heightCm: h } = dims;
    const floorT = clamp(h * 0.15, 0.3, Math.min(1.5, h * 0.6));
    const wallT = clamp(Math.min(b, triH) * 0.05, 0.3, Math.min(2, Math.min(b, triH) * 0.4));
    const outerPts = [[-b / 2, 0], [0, triH], [b / 2, 0]];
    group.add(extrudedSlab(polygonPath(new THREE.Shape(), outerPts), floorT, mats.steel));
    group.add(extrudedRing(polygonPath(new THREE.Shape(), outerPts), polygonPath(new THREE.Path(), footprint.innerPts),
      floorT, h - floorT, Math.min(wallT * 0.42, 0.3), mats.steel));
    plan = { minX: -b / 2, maxX: b / 2, minY: 0, maxY: triH };
    region = { kind: 'poly', pts: footprint.innerPts };
    floorTopY = floorT; rimTopY = h;
  } else if (shapeType === 'muffin_tray') {
    const { lengthCm: l, widthCm: w, heightCm: h, cupDiameterCm: cd, cupDepthCm: cdepth, cupRows: rows, cupColumns: cols } = dims;
    // Same cup layout as Materials: evenly spaced on a (cols+1) x (rows+1) grid.
    const cupX = (c) => -l / 2 + (l / (cols + 1)) * (c + 1);
    const cupY = (r) => w / 2 - (w / (rows + 1)) * (r + 1); // plan y (Materials' cupZ is world z = -plan y)
    const holeR = cd / 2;
    const rimT = clamp(h * 0.2, 0.15, Math.min(0.8, h * 0.4, cdepth * 0.35));
    const baseH = Math.max(h - rimT, 0.05);
    const cr = Math.min(1.2, Math.min(l, w) * 0.04);
    group.add(extrudedSlab(roundedRectPath(new THREE.Shape(), l, w, cr), baseH, mats.steel));
    const plate = roundedRectPath(new THREE.Shape(), l, w, cr);
    const centers = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const hole = new THREE.Path(); hole.absarc(cupX(c), cupY(r), holeR, 0, Math.PI * 2, true);
      plate.holes.push(hole); centers.push({ x: cupX(c), y: cupY(r) });
    }
    const plateGeo = new THREE.ExtrudeGeometry(plate, { depth: Math.max(rimT - 0.08, 0.02), bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelOffset: -0.04, bevelSegments: 2, curveSegments: 24 });
    const plateMesh = mesh(plateGeo, mats.steel, { uv: 'xy' });
    plateMesh.rotation.x = -Math.PI / 2; plateMesh.position.y = baseH + 0.04;
    group.add(plateMesh);
    // Wells: eased taper then a filleted bottom, matching Materials' cup profile.
    const floorY = Math.max(h - cdepth, 0.05);
    const wellDepth = Math.max(baseH - floorY, 0.05);
    const bottomR = Math.min(holeR * 0.55, wellDepth * 0.9);
    const wallBottomY = floorY + bottomR;
    const prof = [];
    for (let i = 0; i <= 8; i++) { const t = i / 8, e = 0.5 - 0.5 * Math.cos(t * Math.PI); prof.push(new THREE.Vector2(holeR + (bottomR - holeR) * e, baseH + (wallBottomY - baseH) * e)); }
    for (let j = 1; j <= 8; j++) { const a = (j / 8) * Math.PI / 2; prof.push(new THREE.Vector2(bottomR * Math.cos(a), floorY + bottomR * (1 - Math.sin(a)))); }
    const cupGeo = planarUV(new THREE.LatheGeometry(prof, 40), 'xz');
    centers.forEach(({ x, y }) => { const cup = mesh(cupGeo, mats.steelDark); cup.position.set(x, 0, -y); group.add(cup); });
    plan = { minX: -l / 2, maxX: l / 2, minY: -w / 2, maxY: w / 2 };
    region = { kind: 'cups', centers, r: holeR, floorY, hw: l / 2 - 0.4, hh: w / 2 - 0.4 };
    floorTopY = floorY; rimTopY = h;
  } else {
    return null;
  }

  const halfW = (plan.maxX - plan.minX) / 2, halfH = (plan.maxY - plan.minY) / 2;
  return {
    group, plan, region, floorTopY, rimTopY,
    center: { x: (plan.minX + plan.maxX) / 2, y: (plan.minY + plan.maxY) / 2 },
    radius: Math.hypot(halfW, halfH) * 0.85 + 1,
  };
}

// ---- cutters -----------------------------------------------------------------------------------
// Origin at the cutter's centre (triangle: centroid, matching how the 2D canvas placed it). The
// returned poly is the INNER cutting outline -- what it actually stamps out, and what collision and
// containment test against.

export function buildCutter({ shapeType, dims }, mats) {
  const group = new THREE.Group();
  const h = dims.heightCm || 3;
  const w = CUTTER_WALL_CM, lip = 0.28, lipT = 0.16;
  let poly;

  if (shapeType === 'round') {
    const r = dims.diameterCm / 2;
    const prof = [
      new THREE.Vector2(r, 0), new THREE.Vector2(r + w, 0), new THREE.Vector2(r + w, h - lipT),
      new THREE.Vector2(r + w + lip, h - lipT), new THREE.Vector2(r + w + lip, h), new THREE.Vector2(r - 0.02, h),
      new THREE.Vector2(r, 0),
    ];
    group.add(mesh(new THREE.LatheGeometry(prof, 96), mats.cutterSteel, { uv: 'xz' }));
    poly = Array.from({ length: 32 }, (_, i) => [r * Math.cos((i / 32) * Math.PI * 2), r * Math.sin((i / 32) * Math.PI * 2)]);
  } else if (shapeType === 'rectangular') {
    const l = dims.lengthCm, wd = dims.widthCm;
    const cr = Math.min(0.35, Math.min(l, wd) * 0.05);
    group.add(extrudedRing(roundedRectPath(new THREE.Shape(), l + 2 * w, wd + 2 * w, cr + w), roundedRectPath(new THREE.Path(), l, wd, cr), 0, h - lipT, 0, mats.cutterSteel));
    group.add(extrudedRing(roundedRectPath(new THREE.Shape(), l + 2 * (w + lip), wd + 2 * (w + lip), cr + w + lip), roundedRectPath(new THREE.Path(), l - 0.04, wd - 0.04, cr), h - lipT, lipT, 0, mats.cutterSteel));
    poly = [[-l / 2, -wd / 2], [l / 2, -wd / 2], [l / 2, wd / 2], [-l / 2, wd / 2]];
  } else if (shapeType === 'triangle') {
    const b = dims.baseCm, t = dims.triHeightCm;
    poly = [[-b / 2, -t / 3], [b / 2, -t / 3], [0, (2 * t) / 3]]; // centroid at origin
    const wallPts = offsetConvexPolygon(poly, w), lipPts = offsetConvexPolygon(poly, w + lip);
    group.add(extrudedRing(polygonPath(new THREE.Shape(), wallPts), polygonPath(new THREE.Path(), poly), 0, h - lipT, 0, mats.cutterSteel));
    group.add(extrudedRing(polygonPath(new THREE.Shape(), lipPts), polygonPath(new THREE.Path(), offsetConvexPolygon(poly, -0.02)), h - lipT, lipT, 0, mats.cutterSteel));
  } else {
    return null;
  }
  return { group, poly, height: h + 0.02 };
}
