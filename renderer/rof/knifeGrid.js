import * as THREE from 'three';

// Trim by Knife (Sheet & Trim): a uniform grid of straight cuts across the whole sheet, like slicing a tray
// with a knife. Two numbers set it -- the piece size across (plan x) and down (plan y) -- and the grid is
// CENTRED on the tray, so whatever doesn't divide evenly is split into two equal strips on opposite edges
// (a deliberate, symmetric-looking tray). No gap between pieces and no margin at the wall: a knife cut takes
// no dough. On a round or triangular tray only cells lying wholly inside count; the rest is scrap.
//
// planKnifeGrid is pure (plan coordinates in cm, tray-centre origin, +y up the page) and the grid's cells go
// through the SAME mask / scrap / portion code as cutter pieces (each is a rectangle "cut" in game.js).

const EPS = 1e-6;

function regionBounds(region) {
  if (region.kind === 'rect') return { x0: -region.hw, x1: region.hw, y0: -region.hh, y1: region.hh };
  if (region.kind === 'circle') return { x0: -region.r, x1: region.r, y0: -region.r, y1: region.r };
  if (region.kind === 'poly') {
    const xs = region.pts.map(p => p[0]), ys = region.pts.map(p => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }
  return null;
}

function insideRegion(region, x, y) {
  if (region.kind === 'rect') return Math.abs(x) <= region.hw + EPS && Math.abs(y) <= region.hh + EPS;
  if (region.kind === 'circle') return x * x + y * y <= region.r * region.r + EPS;
  if (region.kind === 'poly') { // convex (the triangle tray): on the inner side of every edge
    const P = region.pts, n = P.length;
    let a2 = 0; for (let k = 0; k < n; k++) { const [x1, y1] = P[k], [x2, y2] = P[(k + 1) % n]; a2 += x1 * y2 - x2 * y1; }
    const s = a2 > 0 ? 1 : -1;
    for (let k = 0; k < n; k++) {
      const [ax, ay] = P[k], [bx, by] = P[(k + 1) % n];
      if (s * ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) < -EPS) return false;
    }
    return true;
  }
  return false;
}

// The part of the line x = c (axis 'x') or y = c (axis 'y') that lies inside the region, as [from, to] along
// the other axis, or null.
function chord(region, axis, c) {
  if (region.kind === 'rect') {
    const half = axis === 'x' ? region.hh : region.hw;
    return [-half, half];
  }
  if (region.kind === 'circle') {
    const d2 = region.r * region.r - c * c;
    return d2 > 0 ? [-Math.sqrt(d2), Math.sqrt(d2)] : null;
  }
  if (region.kind === 'poly') {
    const hits = [], P = region.pts, n = P.length;
    for (let k = 0; k < n; k++) {
      const a = P[k], b = P[(k + 1) % n];
      const [ac, ao] = axis === 'x' ? [a[0], a[1]] : [a[1], a[0]];
      const [bc, bo] = axis === 'x' ? [b[0], b[1]] : [b[1], b[0]];
      if ((ac - c) * (bc - c) > 0 || Math.abs(bc - ac) < EPS) continue;
      hits.push(ao + ((c - ac) / (bc - ac)) * (bo - ao));
    }
    return hits.length >= 2 ? [Math.min(...hits), Math.max(...hits)] : null;
  }
  return null;
}

// { cols, rows, count, cells: [{ x, y }] (centres), across, down, cuts: [{ x0, y0, x1, y1 }] (every knife line,
//   clipped to the tray), leftover: { across, down } (each of the two equal edge strips, cm), fits }
export function planKnifeGrid({ region, acrossCm, downCm }) {
  const b = region && regionBounds(region);
  const empty = { cols: 0, rows: 0, count: 0, cells: [], across: acrossCm, down: downCm, cuts: [], leftover: { across: 0, down: 0 }, fits: false };
  if (!b || !(acrossCm > 0) || !(downCm > 0)) return empty;
  const W = b.x1 - b.x0, H = b.y1 - b.y0;
  const cols = Math.floor(W / acrossCm + EPS), rows = Math.floor(H / downCm + EPS);
  if (cols < 1 || rows < 1) return empty;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const gx0 = cx - (cols * acrossCm) / 2, gy0 = cy - (rows * downCm) / 2;
  const cells = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x0 = gx0 + i * acrossCm, y0 = gy0 + j * downCm, x1 = x0 + acrossCm, y1 = y0 + downCm;
      if ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]].every(([x, y]) => insideRegion(region, x, y))) {
        cells.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
      }
    }
  }
  // Knife lines run wall to wall (a knife slices the whole tray, trim strips included); the outer lines are
  // only there when there IS a strip to cut off.
  const cuts = [];
  for (let i = 0; i <= cols; i++) {
    const x = gx0 + i * acrossCm;
    if ((i === 0 || i === cols) && Math.abs(Math.abs(x - cx) - W / 2) < 0.05) continue;
    const s = chord(region, 'x', x);
    if (s) cuts.push({ x0: x, y0: s[0], x1: x, y1: s[1] });
  }
  for (let j = 0; j <= rows; j++) {
    const y = gy0 + j * downCm;
    if ((j === 0 || j === rows) && Math.abs(Math.abs(y - cy) - H / 2) < 0.05) continue;
    const s = chord(region, 'y', y);
    if (s) cuts.push({ x0: s[0], y0: y, x1: s[1], y1: y });
  }
  return {
    cols, rows, count: cells.length, cells, across: acrossCm, down: downCm, cuts,
    leftover: { across: (W - cols * acrossCm) / 2, down: (H - rows * downCm) / 2 },
    fits: cells.length > 0,
  };
}

// The knife lines as flat strips lying just over the sheet: dashed while she is still marking, solid once cut.
// One InstancedMesh (a unit square scaled per dash), so a busy grid is still one draw call.
export function buildKnifeLines(cuts, { y, solid }) {
  const DASH = 0.9, GAP = 0.6, WIDTH = solid ? 0.22 : 0.18;
  const segs = [];
  for (const c of cuts) {
    const len = Math.hypot(c.x1 - c.x0, c.y1 - c.y0);
    if (len < EPS) continue;
    const ux = (c.x1 - c.x0) / len, uy = (c.y1 - c.y0) / len;
    if (solid) { segs.push({ x: (c.x0 + c.x1) / 2, y: (c.y0 + c.y1) / 2, len, ux, uy }); continue; }
    for (let t = 0; t < len; t += DASH + GAP) {
      const l = Math.min(DASH, len - t), m = t + l / 2;
      segs.push({ x: c.x0 + ux * m, y: c.y0 + uy * m, len: l, ux, uy });
    }
  }
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2); // lie flat (plan x -> world x, plan y -> world -z)
  const mat = new THREE.MeshBasicMaterial({
    color: solid ? 0x2a1d12 : 0x3b2a1a, transparent: true, opacity: solid ? 0.92 : 0.8,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, segs.length));
  mesh.count = segs.length;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  segs.forEach((s, i) => {
    q.setFromAxisAngle(up, Math.atan2(s.uy, s.ux)); // plan angle -> rotation about world y (plan y is world -z)
    m4.compose(new THREE.Vector3(s.x, y, -s.y), q, new THREE.Vector3(s.len, 1, WIDTH));
    mesh.setMatrixAt(i, m4);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.renderOrder = 3;
  mesh.userData.dispose = () => { geo.dispose(); mat.dispose(); };
  return mesh;
}
