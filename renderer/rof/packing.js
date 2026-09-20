import { offsetConvexPolygon } from './trayModels.js';

// Auto-arrange for Sheet & Trim: how many cutters fit in the tray's interior and where. Pure geometry.
//
// Triangles are packed the way a baker cuts them: alternating rows of up / down triangles whose slanted edges
// are parallel, so each pair tiles into a parallelogram with almost no gap (a down triangle is the up triangle
// turned 180 degrees). Every candidate is tested EXACTLY -- all its corners must lie inside the tray interior
// (less a margin) -- rather than by its centre against a region shrunk by its circumradius, which threw away a
// wide band around the whole tray edge. The lattice's phase, its up/down parity and its direction (tray-aligned,
// turned 90 degrees, or along a slanted tray edge) are searched and the best count wins.
//
// Coordinates: cm, plan view, tray-centre origin, +y up the page -- the same as the game. A placement is the
// cutter's centre (a triangle's centroid) plus a rotation in radians, counter-clockwise, with the cutter drawn
// apex-up at rotation 0.
//
// region: { kind: 'circle', r } | { kind: 'rect', hw, hh } | { kind: 'poly', pts }   (the tray interior)
// dims:   round { diameterCm } | rectangular { lengthCm, widthCm } | triangle { baseCm, triHeightCm }

const EPS = 1e-9;
const rotate = (x, y, a) => { const c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c]; };

// The interior shrunk by `margin`, as exact containment tests.
function makeRegion(region, margin) {
  if (region.kind === 'circle') {
    const R = region.r - margin;
    return {
      inside: (x, y) => Math.hypot(x, y) <= R + EPS,
      insideCircle: (x, y, r) => Math.hypot(x, y) <= R - r + EPS,
      corners: null, R, edgeAngles: [],
    };
  }
  if (region.kind === 'rect') {
    const hw = region.hw - margin, hh = region.hh - margin;
    return {
      inside: (x, y) => Math.abs(x) <= hw + EPS && Math.abs(y) <= hh + EPS,
      insideCircle: (x, y, r) => Math.abs(x) <= hw - r + EPS && Math.abs(y) <= hh - r + EPS,
      corners: [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]], edgeAngles: [],
    };
  }
  const pts = offsetConvexPolygon(region.pts, -margin), n = pts.length;
  let a2 = 0;
  for (let i = 0; i < n; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n]; a2 += x1 * y2 - x2 * y1; }
  const ccw = a2 > 0;
  const edges = pts.map((p, i) => {
    const q = pts[(i + 1) % n], ex = q[0] - p[0], ey = q[1] - p[1], len = Math.hypot(ex, ey) || 1;
    return { ax: p[0], ay: p[1], nx: ccw ? -ey / len : ey / len, ny: ccw ? ex / len : -ex / len, angle: Math.atan2(ey, ex) };
  });
  const dist = (x, y) => Math.min(...edges.map(e => (x - e.ax) * e.nx + (y - e.ay) * e.ny)); // > 0 inside
  return {
    inside: (x, y) => dist(x, y) >= -EPS,
    insideCircle: (x, y, r) => dist(x, y) >= r - EPS,
    corners: pts, edgeAngles: edges.map(e => e.angle),
  };
}

// Bounding box of the region in a lattice frame turned by theta.
function frameBox(reg, theta) {
  if (reg.R !== undefined) return { u0: -reg.R, u1: reg.R, v0: -reg.R, v1: reg.R };
  let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
  for (const [x, y] of reg.corners) { const [u, v] = rotate(x, y, -theta); u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  return { u0, u1, v0, v1 };
}

// Directions to try for the lattice: tray-aligned, turned 90, and along each slanted tray edge (and its normal).
function frameAngles(reg) {
  const set = [0, Math.PI / 2];
  for (const a of reg.edgeAngles) { set.push(a, a + Math.PI / 2); }
  const uniq = [];
  for (const a of set) { const n = ((a % Math.PI) + Math.PI) % Math.PI; if (!uniq.some(u => Math.abs(u - n) < 1e-3)) uniq.push(n); }
  return uniq;
}

// ---- triangles ----------------------------------------------------------------------------------------------
function packTriangles(reg, b, h, gap) {
  const s = Math.hypot(h, b / 2), pitchU = b / 2 + gap / (h / s), pitchV = h + gap; // parallel slanted edges `gap` apart; flat edges `gap` apart
  let best = { n: -1 };
  const PH = 24, RP = 8;
  for (const theta of frameAngles(reg)) {
    const box = frameBox(reg, theta);
    for (let ph = 0; ph < PH * 2; ph++) for (let rp = 0; rp < RP; rp++) {
      const u0 = box.u0 - b + (ph / PH) * pitchU, v0 = box.v0 - h + (rp / RP) * pitchV;
      let n = 0;
      for (let r = 0; v0 + r * pitchV <= box.v1; r++) {
        const vb = v0 + r * pitchV;
        for (let i = 0; u0 + i * pitchU <= box.u1 + b; i++) {
          const cu = u0 + i * pitchU, up = i % 2 === 0;
          const corners = up ? [[cu - b / 2, vb], [cu + b / 2, vb], [cu, vb + h]] : [[cu - b / 2, vb + h], [cu + b / 2, vb + h], [cu, vb]];
          if (corners.every(([u, v]) => { const [x, y] = rotate(u, v, theta); return reg.inside(x, y); })) n++;
        }
      }
      if (n > best.n) best = { n, theta, u0, v0, pitchU, pitchV };
    }
  }
  // Rebuild the winner as placements.
  const out = [], { theta, u0, v0 } = best, box = frameBox(reg, theta);
  for (let r = 0; v0 + r * pitchV <= box.v1; r++) {
    const vb = v0 + r * pitchV;
    for (let i = 0; u0 + i * pitchU <= box.u1 + b; i++) {
      const cu = u0 + i * pitchU, up = i % 2 === 0;
      const corners = up ? [[cu - b / 2, vb], [cu + b / 2, vb], [cu, vb + h]] : [[cu - b / 2, vb + h], [cu + b / 2, vb + h], [cu, vb]];
      if (!corners.every(([u, v]) => { const [x, y] = rotate(u, v, theta); return reg.inside(x, y); })) continue;
      const [x, y] = rotate(cu, up ? vb + h / 3 : vb + (2 * h) / 3, theta); // centroid
      out.push({ x, y, rot: up ? theta : theta + Math.PI, up });
    }
  }
  return { placements: out, frameDeg: Math.round(theta * 180 / Math.PI) };
}

// ---- rectangles ----------------------------------------------------------------------------------------------
function packRects(reg, L, W, gap) {
  let best = { n: -1 };
  const PH = 12;
  for (const theta of frameAngles(reg)) for (const turned of [false, true]) {
    const a = turned ? W : L, c = turned ? L : W;              // cutter extent along u, along v
    const pu = a + gap, pv = c + gap, box = frameBox(reg, theta);
    for (let px = 0; px < PH; px++) for (let py = 0; py < PH; py++) {
      const u0 = box.u0 - a + (px / PH) * pu, v0 = box.v0 - c + (py / PH) * pv;
      const list = [];
      for (let v = v0; v <= box.v1; v += pv) for (let u = u0; u <= box.u1; u += pu) {
        const cu = u + a / 2, cv = v + c / 2;
        const ok = [[cu - a / 2, cv - c / 2], [cu + a / 2, cv - c / 2], [cu + a / 2, cv + c / 2], [cu - a / 2, cv + c / 2]].every(([uu, vv]) => { const [x, y] = rotate(uu, vv, theta); return reg.inside(x, y); });
        if (ok) { const [x, y] = rotate(cu, cv, theta); list.push({ x, y, rot: theta + (turned ? Math.PI / 2 : 0) }); }
      }
      if (list.length > best.n) best = { n: list.length, list, theta };
    }
  }
  return { placements: best.list, frameDeg: Math.round(best.theta * 180 / Math.PI) };
}

// ---- circles: a hexagonal lattice ---------------------------------------------------------------------------
function packCircles(reg, D, gap) {
  const r = D / 2, p = D + gap, rowPitch = p * Math.sqrt(3) / 2;
  let best = { n: -1 };
  const PH = 12;
  for (const theta of frameAngles(reg)) {
    const box = frameBox(reg, theta);
    for (let px = 0; px < PH; px++) for (let py = 0; py < PH * 2; py++) {
      const u0 = box.u0 - p + (px / PH) * p, v0 = box.v0 - rowPitch + (py / (PH * 2)) * rowPitch * 2;
      const list = [];
      for (let row = 0; v0 + row * rowPitch <= box.v1 + rowPitch; row++) {
        const v = v0 + row * rowPitch, off = row % 2 ? p / 2 : 0;
        for (let u = u0 + off; u <= box.u1 + p; u += p) {
          const [x, y] = rotate(u, v, theta);
          if (reg.insideCircle(x, y, r)) list.push({ x, y, rot: 0 });
        }
      }
      if (list.length > best.n) best = { n: list.length, list, theta };
    }
  }
  return { placements: best.list, frameDeg: Math.round(best.theta * 180 / Math.PI) };
}

// margin: clear space kept from the tray wall; gap: clear space kept between cutters.
export function packCutters({ region, shapeType, dims, marginCm = 0.3, gapCm = 0.2 }) {
  const reg = makeRegion(region, Math.max(0, marginCm)), gap = Math.max(0, gapCm);
  let res;
  if (shapeType === 'triangle') res = packTriangles(reg, dims.baseCm, dims.triHeightCm, gap);
  else if (shapeType === 'rectangular') res = packRects(reg, dims.lengthCm, dims.widthCm, gap);
  else if (shapeType === 'round') res = packCircles(reg, dims.diameterCm, gap);
  else res = { placements: [], frameDeg: 0 };
  return res;
}
