// Where the scrap is on a cut sheet: the parts of the tray interior no cutter covers, split into separate regions
// (each gets its own flag), with the size of each and the best spot to hang its flag. Rasterised at CELL cm
// (fast, and accurate to well under 1%), then normalised so the areas add up to the EXACT total
// (interior area minus the cutters' own areas) -- the number the panel shows -- rather than a raster estimate.
//
// Plan coordinates, cm, tray-centre origin, +y up. region: { kind: 'circle', r } | { kind: 'rect', hw, hh } |
// { kind: 'poly', pts }.   cutters: [{ poly: [[x,y]...] (convex, local), x, y, rot, area? }]

export const CELL = 0.25;

export function regionArea(region) {
  if (region.kind === 'circle') return Math.PI * region.r * region.r;
  if (region.kind === 'rect') return 4 * region.hw * region.hh;
  return polyArea(region.pts);
}
export function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}
function makeInside(region) {
  if (region.kind === 'circle') return (x, y) => x * x + y * y <= region.r * region.r;
  if (region.kind === 'rect') return (x, y) => Math.abs(x) <= region.hw && Math.abs(y) <= region.hh;
  const pts = region.pts, n = pts.length;
  let a2 = 0; for (let i = 0; i < n; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n]; a2 += x1 * y2 - x2 * y1; }
  const ccw = a2 > 0;
  return (x, y) => {
    for (let i = 0; i < n; i++) { const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n]; const cr = (bx - ax) * (y - ay) - (by - ay) * (x - ax); if (ccw ? cr < 0 : cr > 0) return false; }
    return true;
  };
}
function bounds(region) {
  if (region.kind === 'circle') return { x0: -region.r, x1: region.r, y0: -region.r, y1: region.r };
  if (region.kind === 'rect') return { x0: -region.hw, x1: region.hw, y0: -region.hh, y1: region.hh };
  const xs = region.pts.map(p => p[0]), ys = region.pts.map(p => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}
function worldPoly(c) { const cs = Math.cos(c.rot || 0), sn = Math.sin(c.rot || 0); return c.poly.map(([px, py]) => [c.x + px * cs - py * sn, c.y + px * sn + py * cs]); }

// Returns { totalArea, interiorArea, regions: [{ id, area, fraction, cx, cy, px, py }], regionAt(x, y) -> id | -1 }.
// `fraction` is the region's share of the interior area (= its share of the dough on the tray, the sheet being uniform).
export function analyzeScrap({ region, cutters, cell = CELL }) {
  const interiorArea = regionArea(region), inside = makeInside(region), b = bounds(region);
  const W = Math.ceil((b.x1 - b.x0) / cell), H = Math.ceil((b.y1 - b.y0) / cell);
  const state = new Uint8Array(W * H);                 // 0 outside the tray, 1 scrap, 2 covered by a cutter
  const cx = (i) => b.x0 + (i + 0.5) * cell, cy = (j) => b.y0 + (j + 0.5) * cell;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (inside(cx(i), cy(j))) state[j * W + i] = 1;
  let cutArea = 0;
  for (const c of cutters) {
    const P = worldPoly(c), n = P.length;
    cutArea += c.area != null ? c.area : polyArea(P);   // `area`: the exact area when the outline is only an approximation (a round cutter)
    let a2 = 0; for (let k = 0; k < n; k++) { const [x1, y1] = P[k], [x2, y2] = P[(k + 1) % n]; a2 += x1 * y2 - x2 * y1; }
    const ccw = a2 > 0;
    const xs = P.map(p => p[0]), ys = P.map(p => p[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - b.x0) / cell)), i1 = Math.min(W - 1, Math.ceil((Math.max(...xs) - b.x0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(...ys) - b.y0) / cell)), j1 = Math.min(H - 1, Math.ceil((Math.max(...ys) - b.y0) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = cx(i), y = cy(j); let ok = true;
      for (let k = 0; k < n; k++) { const [ax, ay] = P[k], [bx, by] = P[(k + 1) % n]; const cr = (bx - ax) * (y - ay) - (by - ay) * (x - ax); if (ccw ? cr < 0 : cr > 0) { ok = false; break; } }
      if (ok && state[j * W + i] === 1) state[j * W + i] = 2;
    }
  }
  // Distance from every scrap cell to the nearest cell that is NOT scrap (a cutter, or outside the tray) -- a
  // two-pass chamfer sweep over the whole grid. Regions never touch each other, so this is each cell's distance to
  // its own region's edge; a flag goes on the cell furthest from it (the middle of the region's widest part).
  const D = new Float32Array(W * H), R2 = Math.SQRT2;
  for (let k = 0; k < W * H; k++) D[k] = state[k] === 1 ? 1e9 : 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i; if (D[k] === 0) continue; let d = D[k];
    if (i > 0) d = Math.min(d, D[k - 1] + 1); if (j > 0) d = Math.min(d, D[k - W] + 1);
    if (i > 0 && j > 0) d = Math.min(d, D[k - W - 1] + R2); if (i < W - 1 && j > 0) d = Math.min(d, D[k - W + 1] + R2);
    D[k] = d;
  }
  for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
    const k = j * W + i; if (D[k] === 0) continue; let d = D[k];
    if (i < W - 1) d = Math.min(d, D[k + 1] + 1); if (j < H - 1) d = Math.min(d, D[k + W] + 1);
    if (i < W - 1 && j < H - 1) d = Math.min(d, D[k + W + 1] + R2); if (i > 0 && j < H - 1) d = Math.min(d, D[k + W - 1] + R2);
    D[k] = d;
  }

  // Regions: connected patches of scrap (4-neighbour flood fill). Note the thin gaps between neighbouring cutters
  // are scrap too, so the offcuts around a layout usually join up into one frame -- that is how it really is.
  const label = new Int32Array(W * H).fill(-1);
  let nRegions = 0;
  const stack = [];
  for (let k = 0; k < W * H; k++) {
    if (state[k] !== 1 || label[k] !== -1) continue;
    const id = nRegions++; label[k] = id; stack.push(k);
    while (stack.length) {
      const c = stack.pop(), i = c % W, j = (c - i) / W;
      if (i < W - 1 && state[c + 1] === 1 && label[c + 1] === -1) { label[c + 1] = id; stack.push(c + 1); }
      if (i > 0 && state[c - 1] === 1 && label[c - 1] === -1) { label[c - 1] = id; stack.push(c - 1); }
      if (j < H - 1 && state[c + W] === 1 && label[c + W] === -1) { label[c + W] = id; stack.push(c + W); }
      if (j > 0 && state[c - W] === 1 && label[c - W] === -1) { label[c - W] = id; stack.push(c - W); }
    }
  }
  const raw = Array.from({ length: nRegions }, () => []);
  for (let k = 0; k < W * H; k++) if (label[k] !== -1) raw[label[k]].push(k);

  const rasterTotal = raw.reduce((sum, c) => sum + c.length, 0) * cell * cell;
  const exactTotal = Math.max(0, interiorArea - cutArea);
  const scale = rasterTotal > 0 ? exactTotal / rasterTotal : 0;      // areas add up to the exact total
  const regions = raw.map((cells, id) => {
    let sx = 0, sy = 0, best = cells[0], bestD = -1;
    for (const c of cells) {
      const i = c % W, j = (c - i) / W; sx += cx(i); sy += cy(j);
      if (D[c] > bestD) { bestD = D[c]; best = c; }
    }
    const bi = best % W, bj = (best - bi) / W, area = cells.length * cell * cell * scale;
    return { id, area, fraction: area / interiorArea, cx: sx / cells.length, cy: sy / cells.length, px: cx(bi), py: cy(bj), halfWidth: bestD * cell };
  }).sort((p, q) => q.area - p.area);
  const order = new Map(regions.map((r, k) => [r.id, k]));
  regions.forEach((r) => { r.rank = order.get(r.id); });
  return {
    totalArea: exactTotal, interiorArea, regions,
    regionAt(x, y) {
      const i = Math.floor((x - b.x0) / cell), j = Math.floor((y - b.y0) / cell);
      if (i < 0 || j < 0 || i >= W || j >= H) return -1;
      return label[j * W + i];
    },
  };
}
