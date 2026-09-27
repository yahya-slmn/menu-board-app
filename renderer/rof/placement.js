import { worldPoly, fitInside, satPush } from './constraints.js';

// The rules of Shape & Place. Every piece lives either on the bench or on the tray ("home"). While
// a piece is carried it moves freely over everything; where it lands decides what happens:
//   tray zone  -> settles at the nearest valid spot (inside the tray, off its neighbours; on a
//                 muffin tray, into the nearest free cup), or is refused;
//   bench zone -> settles at the nearest free spot on the board;
//   anywhere else -> goes back to where it was picked up.
// While carried, `invalid` tells the outline to turn red: "this won't place here".

// Auto-arrange's scan step over a tray's plan box (cm): finer on a small tray, never below 0.6 or above 1.2. Shared with
// the Shape & Place batch plan (shapeBatch.js) so its count is Auto-arrange's.
export const autoArrangeStep = (plan) => Math.min(1.2, Math.max(0.6, Math.min(plan.maxX - plan.minX, plan.maxY - plan.minY) / 60));

export function createPlacement({ getItems, getTray, getBench }) {
  // On the bench a piece is its raw, un-risen size; on the tray it needs its risen footprint.
  const polyFor = (it, home) => (home === 'bench' && it.benchPoly ? it.benchPoly : it.poly);
  const radiusFor = (it, home) => (home === 'bench' ? it.benchRadius : it.radius);
  const polyAt = (it, x, y, home = 'tray') => worldPoly(polyFor(it, home), x, y, it.rotT);
  const inBox = (b, x, y) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;

  // Cheap circle test first: most pairs are far apart, and SAT on two 30-point outlines is not free.
  function overlaps(it, x, y, home) {
    let wp = null;
    for (const o of getItems()) {
      if (o === it || o.home !== home) continue;
      if (Math.hypot(x - o.tx, y - o.ty) > radiusFor(it, home) + radiusFor(o, home)) continue;
      wp ||= polyAt(it, x, y, home);
      if (satPush(wp, polyAt(o, o.tx, o.ty, home))) return true;
    }
    return false;
  }

  // ---- tray ----
  function cupFor(it, x, y) {
    const t = getTray();
    let best = null, bestD = t.region.r * 2.4;
    for (const c of t.region.centers) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d >= bestD) continue;
      if (getItems().some(o => o !== it && o.home === 'tray' && Math.hypot(o.tx - c.x, o.ty - c.y) < 0.6)) continue;
      best = c; bestD = d;
    }
    return best;
  }
  function trayValid(it, x, y) {
    const t = getTray();
    if (!t) return false;
    if (t.region.kind === 'cups') return false; // cups snap; they are never "free placed"
    const f = fitInside(t.region, polyAt(it, x, y, 'tray'));
    if (!f.ok || Math.abs(f.x) + Math.abs(f.y) > 0.04) return false;
    return !overlaps(it, x, y, 'tray');
  }
  // Where a drop at (x, y) would end up on the tray, or null if it can't.
  function trayCandidate(it, x, y) {
    const t = getTray();
    if (!t) return null;
    if (t.region.kind === 'cups') { const c = cupFor(it, x, y); return c ? [c.x, c.y] : null; }
    return search(it, x, y, trayValid, Math.max(5, it.radius * 2.0), 0.6);
  }

  // ---- bench ----
  function benchValid(it, x, y) {
    const b = getBench();
    const f = fitInside({ kind: 'rect', hw: b.hw, hh: b.hh }, worldPoly(polyFor(it, 'bench'), x - b.cx, y - b.cy, it.rotT));
    if (!f.ok || Math.abs(f.x) + Math.abs(f.y) > 0.04) return false;
    return !overlaps(it, x, y, 'bench');
  }
  // Any drop on the bench succeeds: the nearest free spot, or (if the board is genuinely full) the
  // nearest point inside it, loosely piled -- a piece is never refused its own bench.
  function benchCandidate(it, x, y) {
    const b = getBench();
    if (!b) return null;
    const spot = search(it, x, y, benchValid, Math.max(b.hw, b.hh) * 1.6, 0.9);
    if (spot) return spot;
    return [Math.min(Math.max(x, b.cx - b.hw + it.benchRadius * 0.6), b.cx + b.hw - it.benchRadius * 0.6), Math.min(Math.max(y, b.cy - b.hh + it.benchRadius * 0.6), b.cy + b.hh - it.benchRadius * 0.6)];
  }

  // Nearest valid point to (x, y), searching outward in rings.
  function search(it, x, y, valid, maxR, step) {
    if (valid(it, x, y)) return [x, y];
    for (let r = step; r <= maxR; r += step) {
      const n = Math.max(12, Math.round(r * 6));
      let best = null, bestD = Infinity;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2, px = x + r * Math.cos(a), py = y + r * Math.sin(a);
        if (!valid(it, px, py)) continue;
        const d = Math.hypot(px - x, py - y);
        if (d < bestD) { bestD = d; best = [px, py]; }
      }
      if (best) return best;
    }
    return null;
  }

  function zoneAt(x, y) {
    const t = getTray(), b = getBench();
    if (t && inBox(t.plan, x, y)) return 'tray';
    if (b && Math.abs(x - b.cx) <= b.hw && Math.abs(y - b.cy) <= b.hh) return 'bench';
    return 'air';
  }
  function bounds() {
    const t = getTray(), b = getBench();
    const boxes = [t && t.plan, b && { minX: b.cx - b.hw, maxX: b.cx + b.hw, minY: b.cy - b.hh, maxY: b.cy + b.hh }].filter(Boolean);
    return {
      minX: Math.min(...boxes.map(q => q.minX)) - 8, maxX: Math.max(...boxes.map(q => q.maxX)) + 8,
      minY: Math.min(...boxes.map(q => q.minY)) - 8, maxY: Math.max(...boxes.map(q => q.maxY)) + 8,
    };
  }

  // While carrying: free movement, plus a live verdict on whether dropping here would work.
  function carry(it, x, y) {
    const b = bounds();
    x = Math.min(Math.max(x, b.minX), b.maxX); y = Math.min(Math.max(y, b.minY), b.maxY);
    it.zone = zoneAt(x, y);
    it.invalid = it.zone === 'tray' ? trayCandidate(it, x, y) === null : false;
    return [x, y];
  }

  // On drop. Returns 'tray' | 'bench' | 'reverted'.
  function settle(it) {
    it.invalid = false;
    const zone = zoneAt(it.tx, it.ty);
    let spot = null, home = null;
    if (zone === 'tray') { spot = trayCandidate(it, it.tx, it.ty); home = 'tray'; }
    else if (zone === 'bench') { spot = benchCandidate(it, it.tx, it.ty); home = 'bench'; }
    if (!spot) { revert(it); return 'reverted'; }
    it.tx = spot[0]; it.ty = spot[1]; it.home = home;
    it.baseYT = home === 'tray' ? getTray().floorTopY : getBench().top;
    return home;
  }
  function revert(it) {
    it.tx = it.startX; it.ty = it.startY; it.rotT = it.startRot; it.home = it.startHome;
    it.baseYT = it.home === 'tray' ? getTray().floorTopY : getBench().top;
  }

  // First free spot scanning row by row from the top-left of a box (used by auto-arrange and to lay
  // the pieces out on the bench in the first place).
  function firstFree(it, box, valid, step) {
    for (let y = box.maxY; y >= box.minY; y -= step) {
      for (let x = box.minX; x <= box.maxX; x += step) if (valid(it, x, y)) return [x, y];
    }
    return null;
  }
  // Identical pieces: the same outline (point for point) and the same turn. Every piece of one Shape & Place session is
  // cut from one spec, so this is the usual case; a piece turned by hand makes it false.
  function identicalPieces(pieces) {
    const a = pieces[0];
    return pieces.every(it => it.rotT === a.rotT && it.poly.length === a.poly.length && it.poly.every((p, i) => p[0] === a.poly[i][0] && p[1] === a.poly[i][1]));
  }
  // Lays the pieces onto the tray, each at the FIRST free spot scanning the plan box top row first, left to right. Pieces
  // already on the tray stay where they are (obstacles). With identical pieces this is ONE pass over the scan grid:
  // every spot before a piece's was already refused for it, and one more piece on the tray only adds to what's in the
  // way, so the next identical piece's spot is never earlier in the scan -- the same spots, piece for piece, as scanning
  // from the top for each (proven against that scan and the live game), in milliseconds instead of seconds. Anything
  // else (a muffin tray's cups, pieces of different outlines or turns) takes the piece-by-piece scan below.
  function autoArrange(pieces) {
    const t = getTray();
    let placed = 0;
    const step = autoArrangeStep(t.plan);
    if (t.region.kind !== 'cups' && pieces.length > 1 && identicalPieces(pieces)) {
      for (let y = t.plan.maxY; y >= t.plan.minY && placed < pieces.length; y -= step) {
        for (let x = t.plan.minX; x <= t.plan.maxX && placed < pieces.length; x += step) {
          const it = pieces[placed];
          if (!trayValid(it, x, y)) continue;
          it.tx = x; it.ty = y; it.home = 'tray'; it.baseYT = t.floorTopY; placed++;
        }
      }
      return placed;
    }
    for (const it of pieces) {
      const spot = t.region.kind === 'cups'
        ? (() => { const c = cupFor(it, 1e9, 1e9) || t.region.centers.find(cc => !getItems().some(o => o !== it && o.home === 'tray' && Math.hypot(o.tx - cc.x, o.ty - cc.y) < 0.6)); return c ? [c.x, c.y] : null; })()
        : firstFree(it, t.plan, trayValid, step);
      if (!spot) continue;
      it.tx = spot[0]; it.ty = spot[1]; it.home = 'tray'; it.baseYT = t.floorTopY; placed++;
    }
    return placed;
  }
  function packOnBench(pieces) {
    const b = getBench();
    const box = { minX: b.cx - b.hw, maxX: b.cx + b.hw, minY: b.cy - b.hh, maxY: b.cy + b.hh };
    let jitter = 0;
    for (const it of pieces) {
      it.home = 'bench'; it.baseYT = b.top;
      const spot = firstFree(it, box, benchValid, 1.1);
      // A bench that is genuinely full still holds the piece -- loosely piled rather than lost.
      it.tx = spot ? spot[0] : b.cx + ((jitter++ % 7) - 3) * 1.5;
      it.ty = spot ? spot[1] : b.cy + ((jitter % 5) - 2) * 1.2;
    }
  }

  return { carry, settle, revert, zoneAt, autoArrange, packOnBench, trayCandidate, benchCandidate, bounds };
}
