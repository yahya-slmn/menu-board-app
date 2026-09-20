import { worldPoly, fitInside, satPush } from './constraints.js';

// Direct-manipulation input: click to select, drag to move (raycast onto the tray floor plane, so
// the piece follows the cursor exactly), arrow keys to nudge, Delete to remove. Pieces are kept
// inside the tray and can't overlap each other -- a dragged piece slides along walls and around
// its neighbours instead of stopping dead. There is no camera rotate/pan here by design.

function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function createInteraction({ stage, getItems, getRegion, getFloorY, emit, placement, sfx = {} }) {
  const { THREE, canvas, camera } = stage;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPt = new THREE.Vector3();
  let dragging = null, grab = { x: 0, y: 0 }, hovered = null, selected = null, activePointer = null, enabled = true;
  const hooks = {}; // emptyDown(e): a press on nothing (Sheet & Trim stamps an armed cutter there)

  function aim(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  }
  // Plan-space point where the cursor ray meets the horizontal plane at height y (or null).
  function planePoint(e, y) {
    aim(e);
    plane.constant = -y;
    return ray.ray.intersectPlane(plane, hitPt) ? { x: hitPt.x, y: -hitPt.z } : null;
  }

  // Meshes first (so a tall cutter's raised rim is grabbable where it appears on screen), then
  // footprint containment on the floor for the thin-walled interior. Last-added wins overlaps.
  function pick(e) {
    aim(e);
    const items = getItems();
    const meshes = [];
    items.forEach(it => it.group.traverse(o => { if (o.isMesh) meshes.push(o); }));
    const hit = ray.intersectObjects(meshes, false)[0];
    if (hit) return items.find(i => i.id === hit.object.userData.itemId) || null;
    const p = planePoint(e, getFloorY());
    if (!p) return null;
    for (let i = items.length - 1; i >= 0; i--) {
      if (pointInPoly(p.x, p.y, worldPoly(items[i].poly, items[i].x, items[i].y, items[i].rotT))) return items[i];
    }
    return null;
  }

  const polyAt = (item, x, y) => worldPoly(item.poly, x, y, item.rotT);
  const overlapsOthers = (item, x, y) => {
    const wp = polyAt(item, x, y);
    return getItems().some(o => o !== item && satPush(wp, polyAt(o, o.x, o.y)));
  };
  // Containment only: nearest position inside the tray to (x, y).
  function fitOnly(item, x, y) {
    const region = getRegion();
    if (!region) return [x, y];
    const f = fitInside(region, polyAt(item, x, y));
    return [x + f.x, y + f.y];
  }
  // Solid one-step resolve: inside the tray AND off every neighbour.
  function resolveSolid(item, x, y) {
    const region = getRegion();
    const others = getItems().filter(o => o !== item);
    let px = x, py = y;
    for (let pass = 0; pass < 5; pass++) {
      let moved = false;
      for (const o of others) {
        const push = satPush(polyAt(item, px, py), polyAt(o, o.x, o.y));
        if (push) { px += push.x; py += push.y; moved = true; }
      }
      if (region) {
        const f = fitInside(region, polyAt(item, px, py));
        if (Math.abs(f.x) + Math.abs(f.y) > 1e-6) { px += f.x; py += f.y; moved = true; }
      }
      if (!moved) break;
    }
    return [px, py];
  }
  // Solid movement is swept in sub-centimetre steps from where the piece is now toward the cursor,
  // resolving at each step -- so a fast drag can't jump across a neighbour (tunnel), it slides
  // around or stops against it.
  function sweepSolid(item, x, y) {
    let cx = item.tx, cy = item.ty;
    for (let i = 0; i < 160; i++) {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      if (d < 1e-4) break;
      const step = Math.min(d, 0.6);
      [cx, cy] = resolveSolid(item, cx + (dx / d) * step, cy + (dy / d) * step);
    }
    return [cx, cy];
  }
  // Where the piece may go while held: solid pieces are blocked; lifted pieces only stay inside the
  // tray (and are flagged invalid while hovering over a neighbour).
  function follow(item, x, y) {
    if (item.collision === 'carry') return placement.carry(item, x, y);
    if (item.collision === 'solid') { item.invalid = false; return sweepSolid(item, x, y); }
    const [px, py] = fitOnly(item, x, y);
    item.invalid = overlapsOthers(item, px, py);
    return [px, py];
  }
  // Drop of a lifted piece: if it landed on something, take the nearest free spot (searching
  // outward in rings), or go back to where it was picked up if there's no room.
  function settle(item) {
    if (item.collision === 'carry') return placement.settle(item);
    if (item.collision === 'solid' || !overlapsOthers(item, item.tx, item.ty)) { item.invalid = false; return; }
    for (let r = 0.5; r <= 30; r += 0.5) {
      let best = null, bestD = Infinity;
      const n = Math.max(16, Math.round(r * 6));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const [px, py] = fitOnly(item, item.tx + r * Math.cos(a), item.ty + r * Math.sin(a));
        if (overlapsOthers(item, px, py)) continue;
        const d = Math.hypot(px - item.tx, py - item.ty);
        if (d < bestD) { bestD = d; best = [px, py]; }
      }
      if (best) { item.tx = best[0]; item.ty = best[1]; item.invalid = false; return; }
    }
    item.tx = item.startX; item.ty = item.startY; item.invalid = false;
  }
  // Initial / programmatic placement (no drag involved).
  // Returns false when there is no valid spot for it anywhere (the caller should drop it) instead of
  // leaving it overlapping something.
  function place(item, x, y) {
    if (item.collision === 'solid') [x, y] = resolveSolid(item, x, y); else [x, y] = fitOnly(item, x, y);
    item.x = item.tx = x; item.y = item.ty = y;
    item.startX = x; item.startY = y;
    if (item.collision !== 'carry') settle(item);
    item.x = item.tx; item.y = item.ty;
    return item.collision === 'solid' || item.collision === 'carry' || !overlapsOthers(item, item.tx, item.ty);
  }

  function wake(item) {
    if (item._sim) return;
    item._sim = true;
    stage.animate((dt) => {
      const moving = item.step(dt);
      if (!moving) item._sim = false;
      return moving;
    });
  }

  function setHover(item) {
    if (hovered === item) return;
    if (hovered) { hovered.hover = false; hovered.sync(); }
    hovered = item;
    if (hovered) { hovered.hover = true; hovered.sync(); }
    canvas.style.cursor = item ? 'grab' : '';
    stage.requestRender();
  }
  function select(item) {
    if (selected === item) return;
    if (selected) { selected.selected = false; selected.sync(); }
    selected = item;
    if (selected) { selected.selected = true; selected.sync(); }
    stage.requestRender();
    emit('select', item);
  }

  const onDown = (e) => {
    if (e.button !== 0 || !enabled) return;
    canvas.focus({ preventScroll: true });
    const item = pick(e);
    select(item);
    if (!item) { hooks.emptyDown?.(e); return; }
    const p = planePoint(e, item.baseY);
    if (!p) return;
    dragging = item; activePointer = e.pointerId;
    grab = { x: item.x - p.x, y: item.y - p.y };
    item.startX = item.tx; item.startY = item.ty; item.startRot = item.rotT; item.startHome = item.home;
    item.dragging = true;
    sfx.pickup?.(item);
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    wake(item);
    emit('dragstart', item);
  };
  const onMove = (e) => {
    if (dragging && e.pointerId === activePointer) {
      const p = planePoint(e, dragging.baseY);
      if (!p) return;
      const [x, y] = follow(dragging, p.x + grab.x, p.y + grab.y);
      dragging.tx = x; dragging.ty = y;
      wake(dragging);
      emit('move', dragging);
    } else if (!dragging) {
      setHover(pick(e));
    }
  };
  const end = (e) => {
    if (!dragging || e.pointerId !== activePointer) return;
    const item = dragging;
    dragging = null; activePointer = null;
    item.dragging = false;
    const outcome = settle(item);
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    canvas.style.cursor = hovered ? 'grab' : '';
    wake(item);
    if (outcome === 'reverted') sfx.refuse?.(item); else sfx.place?.(item, outcome);
    emit('drop', item);
  };
  const onLeave = () => { if (!dragging) setHover(null); };
  function rotate(item, delta) {
    const before = item.rotT;
    item.rotT += delta;
    if (item.collision === 'carry') {
      if (item.dragging) {
        const [x, y] = follow(item, item.tx, item.ty);
        item.tx = x; item.ty = y;
      } else {
        // At rest: it only turns if it still fits right where it is.
        const spot = item.home === 'bench' ? placement.benchCandidate(item, item.tx, item.ty) : placement.trayCandidate(item, item.tx, item.ty);
        if (!spot || Math.hypot(spot[0] - item.tx, spot[1] - item.ty) > 0.35) { item.rotT = before; return; }
        item.tx = spot[0]; item.ty = spot[1];
      }
    }
    wake(item);
    stage.requestRender();
  }
  // Mouse wheel turns the piece you're holding (and only then -- otherwise it zooms as usual).
  stage.wheelHook = (e) => {
    if (!dragging) return false;
    e.preventDefault();
    rotate(dragging, Math.sign(e.deltaY) * (e.shiftKey ? 0.087 : 0.26));
    return true;
  };
  const onKey = (e) => {
    if (!selected || !enabled) return;
    const step = e.shiftKey ? 2 : 0.5;
    if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey) { e.preventDefault(); rotate(selected, e.shiftKey ? -0.26 : 0.26); return; }
    const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (nudge) {
      e.preventDefault();
      selected.startX = selected.tx; selected.startY = selected.ty; selected.startRot = selected.rotT; selected.startHome = selected.home;
      const [x, y] = follow(selected, selected.tx + nudge[0], selected.ty + nudge[1]);
      selected.tx = x; selected.ty = y;
      settle(selected);
      wake(selected);
      emit('drop', selected);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      emit('delete', selected);
    } else if (e.key === 'Escape') {
      select(null);
    }
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('keydown', onKey);

  return {
    place, wake, select, rotate, hooks,
    planePoint, pickAt: pick,
    // Where a piece WOULD go at (x, y) -- inside the tray, off its neighbours -- and whether that spot is valid.
    probe(item, x, y) {
      const region = getRegion();
      let px = x, py = y, fits = true;
      if (region) { const f = fitInside(region, polyAt(item, x, y)); px += f.x; py += f.y; fits = f.ok; }
      return { x: px, y: py, valid: fits && !overlapsOthers(item, px, py) };
    },
    setEnabled(on) { enabled = on; if (!on && dragging) { dragging.dragging = false; dragging = null; } },
    get selected() { return selected; },
    forget(item) { if (hovered === item) hovered = null; if (selected === item) selected = null; if (dragging === item) dragging = null; },
    dispose() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', end);
      canvas.removeEventListener('pointercancel', end);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('keydown', onKey);
    },
  };
}
