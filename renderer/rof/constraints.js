// Plan-space geometry for keeping pieces inside the tray and off each other. All polygons are
// convex arrays of [x, y] in cm; regions come from trayModels.buildTray.

export function worldPoly(localPoly, x, y, rot) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return localPoly.map(([px, py]) => [x + px * c - py * s, y + px * s + py * c]);
}

// Smallest translation that brings `poly` fully inside `region`. A few relaxation passes handle
// corners (fixing one wall can push a vertex through the next). A piece bigger than the region on
// an axis is centred on it rather than jittering between walls.
export function fitInside(region, poly) {
  let sx = 0, sy = 0;
  for (let pass = 0; pass < 4; pass++) {
    let dx = 0, dy = 0;
    if (region.kind === 'circle') {
      let worst = 0, wx = 0, wy = 0;
      for (const [px, py] of poly) {
        const x = px + sx, y = py + sy, d = Math.hypot(x, y);
        if (d - region.r > worst) { worst = d - region.r; wx = x / d; wy = y / d; }
      }
      dx = -wx * worst; dy = -wy * worst;
    } else if (region.kind === 'rect' || region.kind === 'cups') {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [px, py] of poly) { minX = Math.min(minX, px + sx); maxX = Math.max(maxX, px + sx); minY = Math.min(minY, py + sy); maxY = Math.max(maxY, py + sy); }
      if (maxX - minX > 2 * region.hw) dx = -(maxX + minX) / 2; else if (maxX > region.hw) dx = region.hw - maxX; else if (minX < -region.hw) dx = -region.hw - minX;
      if (maxY - minY > 2 * region.hh) dy = -(maxY + minY) / 2; else if (maxY > region.hh) dy = region.hh - maxY; else if (minY < -region.hh) dy = -region.hh - minY;
    } else if (region.kind === 'poly') {
      const pts = region.pts, n = pts.length;
      let area2 = 0;
      for (let i = 0; i < n; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n]; area2 += x1 * y2 - x2 * y1; }
      const ccw = area2 > 0;
      for (let i = 0; i < n; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
        const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey) || 1;
        const nx = ccw ? -ey / len : ey / len, ny = ccw ? ex / len : -ex / len; // inward normal
        let worst = 0;
        for (const [px, py] of poly) worst = Math.max(worst, (ax - (px + sx + dx)) * nx + (ay - (py + sy + dy)) * ny);
        if (worst > 0) { dx += nx * worst; dy += ny * worst; }
      }
    }
    if (Math.abs(dx) + Math.abs(dy) < 1e-6) break;
    sx += dx; sy += dy;
  }
  // `ok` is false when the piece simply doesn't fit (bigger than the region on some axis): the
  // centring above then reports a tiny shift, which must not be mistaken for "already inside".
  return { x: sx, y: sy, ok: poly.every(([px, py]) => insideRegion(region, px + sx, py + sy)) };
}

function insideRegion(region, x, y, eps = 0.05) {
  if (region.kind === 'circle') return Math.hypot(x, y) <= region.r + eps;
  if (region.kind === 'rect' || region.kind === 'cups') return Math.abs(x) <= region.hw + eps && Math.abs(y) <= region.hh + eps;
  if (region.kind === 'poly') {
    const pts = region.pts, n = pts.length;
    let area2 = 0;
    for (let i = 0; i < n; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n]; area2 += x1 * y2 - x2 * y1; }
    const ccw = area2 > 0;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
      const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey) || 1;
      const nx = ccw ? -ey / len : ey / len, ny = ccw ? ex / len : -ex / len;
      if ((x - ax) * nx + (y - ay) * ny < -eps) return false;
    }
  }
  return true;
}

function centroid(poly) {
  let x = 0, y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
}

// Separating-axis test for two convex polygons. Returns the translation to apply to `a` to just
// clear `b`, or null if they don't overlap.
export function satPush(a, b) {
  let best = Infinity, bx = 0, by = 0;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      let nx = y2 - y1, ny = x1 - x2;
      const len = Math.hypot(nx, ny);
      if (len < 1e-9) continue;
      nx /= len; ny /= len;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const [px, py] of a) { const d = px * nx + py * ny; aMin = Math.min(aMin, d); aMax = Math.max(aMax, d); }
      for (const [px, py] of b) { const d = px * nx + py * ny; bMin = Math.min(bMin, d); bMax = Math.max(bMax, d); }
      const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin);
      if (overlap <= 1e-6) return null;
      if (overlap < best) { best = overlap; bx = nx; by = ny; }
    }
  }
  const [cax, cay] = centroid(a), [cbx, cby] = centroid(b);
  if ((cax - cbx) * bx + (cay - cby) * by < 0) { bx = -bx; by = -by; }
  return { x: bx * (best + 0.01), y: by * (best + 0.01) };
}
