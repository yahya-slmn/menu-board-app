import { createStage } from './stage.js';
import { createSurfaces } from './surfaces.js';
import { buildTray, buildCutter } from './trayModels.js';
import { PlacedItem } from './items.js';
import { createInteraction } from './interaction.js';
import { createPlacement } from './placement.js';
import { createBench } from './bench.js';
import { createDoughPiece } from './dough.js';
import { createOven } from './oven.js';
import { createSheet } from './sheet.js';

// Public entry point for the Recipe on Fire game view. renderer.js (a classic script) reaches this
// through window.RofGame (see boot.js) and only ever passes plain data in: the tray/cutter shape
// type + dims from Materials, and the interior footprint it already computed with
// trayInteriorFootprint. Everything here works in plan-space cm, tray-centre origin, +y up the page.

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}

export function createRofGame(container, opts = {}) {
  const stage = createStage(container, opts);
  const { THREE } = stage;
  const surfaces = createSurfaces();

  const floor = new THREE.Mesh(new THREE.CircleGeometry(400, 64), surfaces.bench);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.02;
  floor.receiveShadow = true;
  stage.scene.add(floor);

  let tray = null;
  let bench = null;            // { group, top, cx, cy, hw, hh } while a placement session is active
  let placing = false;
  let stageCenter = { x: 0, y: 0 };
  let oven = null;
  let sheet = null;        // Sheet & Trim: the dough as one mass in the tray
  let armed = null;        // { shapeType, dims, materialId } -- the cutter that follows the pointer
  let ghost = null;        // the see-through cutter shown at the pointer while one is armed
  const items = [];
  let nextId = 1;
  const listeners = {};
  const on = (evt, fn) => { (listeners[evt] ||= []).push(fn); return () => { listeners[evt] = listeners[evt].filter(f => f !== fn); }; };
  const emit = (evt, payload) => (listeners[evt] || []).forEach(fn => fn(payload));
  const sfx = {}; // pickup / place / refuse / arrange, supplied by renderer.js (synthesized sounds)

  const placement = createPlacement({ getItems: () => items, getTray: () => tray, getBench: () => bench });
  const describe = (it) => ({ id: it.id, kind: it.kind, x: it.tx, y: it.ty, rot: it.rotT, home: it.home, data: it.data });

  const interaction = createInteraction({
    stage, placement,
    sfx: { pickup: (i) => sfx.pickup?.(i), place: (i, where) => sfx.place?.(i, where), refuse: (i) => sfx.refuse?.(i) },
    getItems: () => items,
    getRegion: () => tray?.region,
    getFloorY: () => tray?.floorTopY ?? 0,
    emit: (evt, item) => {
      if (evt === 'delete') { if (placing && item.kind === 'dough') sendToBench(item); else removeItem(item.id); return; }
      emit(evt, item && describe(item));
      if (evt === 'drop' || evt === 'dragstart') { emit('change', items.map(describe)); reportPlacement(); }
      if (evt === 'drop' || evt === 'move') cuttersChanged();
    },
  });

  // ---- placement session ----------------------------------------------------------------------
  let hud = null;
  const doughItems = () => items.filter(i => i.kind === 'dough');
  function reportPlacement() {
    const all = doughItems(), placed = all.filter(i => i.home === 'tray').length;
    if (hud) hud.textContent = `${placed} / ${all.length} placed`;
    emit('placement', { placed, total: all.length });
  }
  function fitToStage() {
    const t = tray.plan;
    const box = bench
      ? { minX: Math.min(t.minX, bench.cx - bench.hw - 1), maxX: Math.max(t.maxX, bench.cx + bench.hw + 1), minY: Math.min(t.minY, bench.cy - bench.hh - 1), maxY: t.maxY }
      : t;
    const hw = (box.maxX - box.minX) / 2, hh = (box.maxY - box.minY) / 2;
    stageCenter = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
    stage.fit({ cx: stageCenter.x, cy: stageCenter.y, radius: Math.hypot(hw, hh) * 0.85 + 1 });
  }

  // Starts Shape & Place: lays out `count` pieces of `spec` on a bench in front of the tray. On a
  // muffin tray the count is the number of cups and each piece is sized to fit one. Returns the
  // spec/count actually used, since the tray can change them.
  function beginPlacement({ spec, count, spread = 1 }) {
    if (!tray) return null;
    endPlacement();
    clearItems();
    if (tray.region.kind === 'cups') {
      const d = tray.region.r * 2 * 0.8;
      spec = { archetype: 'ball', lengthCm: d, widthCm: d, heightCm: d * 0.56 };
      count = tray.region.centers.length;
    }
    count = clamp(Math.round(count), 1, 60);
    const probe = createDoughPiece(spec, { seed: 1, spread });
    const xs = probe.rawPoly.map(p => p[0]), ys = probe.rawPoly.map(p => p[1]);
    const pw = Math.max(...xs) - Math.min(...xs), pd = Math.max(...ys) - Math.min(...ys);
    probe.dispose();
    // Board sized from how many rows the pieces need, side by side, plus a little slack for the
    // first-fit layout (it stacks rows squarely, not in a perfect hex).
    const width = Math.max(tray.plan.maxX - tray.plan.minX, 34);
    const perRow = Math.max(1, Math.floor((width - 3) / (pw * 1.06)));
    const rows = Math.ceil(count / perRow);
    const depth = clamp(rows * pd * 1.3 + 7, 11, 46);
    const board = createBench({ surfaces, cx: tray.center.x, cy: tray.plan.minY - 4 - depth / 2, width, depth });
    bench = { ...board.rect, top: board.top, group: board.group, dispose: board.dispose };
    stage.scene.add(bench.group);
    placing = true;

    for (let i = 0; i < count; i++) {
      const piece = createDoughPiece(spec, { seed: 1000 + i * 13, spread });
      const item = new PlacedItem({
        id: nextId++, kind: 'dough', group: piece.group, poly: piece.poly, benchPoly: piece.rawPoly, baseY: bench.top, height: piece.height,
        data: { spec, index: i }, collision: 'carry', home: 'bench', heldLift: 3.0,
      });
      item.dough = piece;
      items.push(item);
      stage.scene.add(item.group, item.outline);
    }
    placement.packOnBench(items);
    items.forEach((it, i) => { it.x = it.tx; it.y = it.ty; it.baseY = it.baseYT; it.lift = 4 + (i % 5) * 0.6; interaction.wake(it); });

    hud = document.createElement('div');
    hud.style.cssText = 'position:absolute;top:10px;left:10px;padding:5px 11px;border-radius:999px;background:rgba(15,28,22,.72);color:#e6eee6;font:600 12px system-ui,sans-serif;pointer-events:none;';
    container.appendChild(hud);
    fitToStage();
    reportPlacement();
    return { spec, count };
  }
  function endPlacement() {
    if (bench) { stage.scene.remove(bench.group); bench.dispose(); bench = null; }
    hud?.remove(); hud = null;
    placing = false;
    if (tray) fitToStage();
  }
  // Lays the pieces still on the bench onto the tray, top-left first.
  function autoArrange() {
    const pieces = doughItems().filter(i => i.home === 'bench');
    const n = placement.autoArrange(pieces);
    pieces.forEach(it => { it.lift = 2.2; interaction.wake(it); });
    if (n) sfx.arrange?.();
    emit('change', items.map(describe));
    reportPlacement();
    return n;
  }
  function sendToBench(item) {
    item.startX = item.tx; item.startY = item.ty; item.startRot = item.rotT; item.startHome = item.home;
    placement.packOnBench([item]);
    item.lift = 1.5;
    interaction.wake(item);
    emit('change', items.map(describe));
    reportPlacement();
  }
  function returnAllToBench() {
    const onTray = doughItems().filter(i => i.home === 'tray');
    placement.packOnBench(onTray);
    onTray.forEach(it => { it.lift = 1.5; interaction.wake(it); });
    emit('change', items.map(describe));
    reportPlacement();
  }
  function setInteractive(on) { interaction.setEnabled(on); }
  // ---- Sheet & Trim ---------------------------------------------------------------------------------
  const cutterItems = () => items.filter(i => i.kind === 'cutter');
  const describeCutter = (it) => ({ id: it.id, x: it.tx, y: it.ty, rot: it.rotT, data: it.data });
  // Redraws the mask the sheet uses to tell "inside a cutter" from "scrap", and tells the UI.
  function cuttersChanged() {
    if (!sheet) return;
    const cs = cutterItems();
    sheet.mask.redraw(cs.map(c => ({ poly: c.poly, x: c.tx, y: c.ty, rot: c.rotT })));
    sheet.setHasCuts(cs.length);
    stage.requestRender();
    emit('cutters', cs.map(describeCutter));
  }

  // Puts the dough in the tray as one sheet `thicknessCm` thick (raw). Returns false on a muffin tray.
  function beginSheet({ thicknessCm }) {
    if (!tray || tray.region.kind === 'cups') return false;
    endSheet(); endPlacement(); clearItems();
    sheet = createSheet({ region: tray.region, plan: tray.plan, thicknessCm });
    sheet.group.position.y = tray.floorTopY;
    stage.scene.add(sheet.group);
    fitToStage();
    return true;
  }
  function endSheet() {
    disarmCutter();
    clearItems();
    if (sheet) { stage.scene.remove(sheet.group); sheet.dispose(); sheet = null; }
  }

  // Arms a cutter: a see-through copy follows the pointer over the tray (red where it can't go) and a
  // click stamps a real one there. Clicking an existing cutter still picks it up instead.
  function armCutter(spec) {
    disarmCutter();
    if (!tray || !spec) return false;
    const built = buildCutter(spec, surfaces);
    if (!built) return false;
    built.group.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      Object.assign(o.material, { transparent: true, opacity: 0.55, depthWrite: false });
      o.castShadow = false;
    });
    const hover = tray.floorTopY + (sheet ? sheet.topY() : 0) + 0.9 - tray.floorTopY;
    ghost = new PlacedItem({ id: -1, kind: 'ghost', group: built.group, poly: built.poly, baseY: tray.floorTopY + hover, height: built.height, collision: 'lifted' });
    ghost.selected = true;
    ghost.group.visible = false; ghost.outline.visible = false;
    stage.scene.add(ghost.group, ghost.outline);
    armed = spec;
    emit('armed', spec);
    return true;
  }
  function disarmCutter() {
    if (!ghost) return;
    stage.scene.remove(ghost.group, ghost.outline);
    ghost.group.traverse(o => { if (o.isMesh) o.material.dispose(); });
    ghost.dispose();
    ghost = null; armed = null;
    stage.requestRender();
    emit('armed', null);
  }
  function moveGhost(e) {
    if (!ghost || !tray) return;
    const over = interaction.pickAt(e);                    // over a real cutter: leave the ghost out of the way
    const p = interaction.planePoint(e, tray.floorTopY);
    const pl = tray.plan, m = 1.5;
    const outside = p && (p.x < pl.minX - m || p.x > pl.maxX + m || p.y < pl.minY - m || p.y > pl.maxY + m);
    if (over || !p || outside) { ghost.group.visible = false; ghost.outline.visible = false; stage.requestRender(); return; }
    const probe = interaction.probe(ghost, p.x, p.y);
    ghost.x = ghost.tx = probe.x; ghost.y = ghost.ty = probe.y;
    ghost.invalid = !probe.valid;
    ghost.group.visible = true;
    ghost.sync();
    ghost.outline.visible = true;
    stage.requestRender();
  }
  function stampAtGhost() {
    if (!ghost || !ghost.group.visible) return;
    if (ghost.invalid) { sfx.refuse?.(ghost); return; }
    const c = addCutter({ ...armed, x: ghost.tx, y: ghost.ty, data: { materialId: armed.materialId } });
    if (c) { const it = items.find(i => i.id === c.id); if (it) { it.rotT = it.rot = ghost.rotT; it.sync(); } sfx.place?.(null, 'tray'); }
  }
  function rotateGhost(delta) {
    if (!ghost) return;
    ghost.rotT += delta; ghost.rot = ghost.rotT;
    const p = interaction.probe(ghost, ghost.tx, ghost.ty);
    ghost.tx = ghost.x = p.x; ghost.ty = ghost.y = p.y; ghost.invalid = !p.valid;
    ghost.sync(); stage.requestRender();
  }
  const prevWheel = stage.wheelHook;
  stage.wheelHook = (e) => {
    if (ghost && ghost.group.visible) { e.preventDefault(); rotateGhost(Math.sign(e.deltaY) * (e.shiftKey ? 0.087 : 0.26)); return true; }
    return prevWheel ? prevWheel(e) : false;
  };
  const onGhostKey = (e) => {
    if (!ghost) return;
    if (e.key === 'Escape') { disarmCutter(); }
    else if ((e.key === 'r' || e.key === 'R') && !interaction.selected) rotateGhost(e.shiftKey ? -0.26 : 0.26);
  };
  const onGhostLeave = () => { if (ghost) { ghost.group.visible = false; ghost.outline.visible = false; stage.requestRender(); } };
  stage.canvas.addEventListener('pointermove', moveGhost);
  stage.canvas.addEventListener('pointerleave', onGhostLeave);
  stage.canvas.addEventListener('keydown', onGhostKey);
  interaction.hooks.emptyDown = stampAtGhost;

  // Replaces every cutter with `list` ([{ shapeType, dims, x, y, materialId }]) -- used by auto-arrange.
  function setCutters(list) {
    cutterItems().forEach(c => removeItem(c.id, { quiet: true }));
    list.forEach((c, i) => { const d = addCutter({ ...c, data: { materialId: c.materialId } }); const it = d && items.find(x => x.id === d.id); if (it) it.lift = 4 + (i % 6) * 0.5; });
    cuttersChanged();
    return cutterItems().length;
  }
  function clearCutters() { cutterItems().forEach(c => removeItem(c.id, { quiet: true })); cuttersChanged(); }
  function setScrapHighlight(on) { sheet?.setScrapHighlight(on); stage.requestRender(); }

  // ---- bake director -------------------------------------------------------------------------------
  // Doneness is how far the browning goes; shapes need different amounts of "bake" to look equally done
  // (a dome catches the heat on top and browns early; a long thin loaf browns later).
  const DONENESS = { light: 0.52, golden: 0.68, dark: 0.88 };
  const SHAPE_K = { ball: 1.0, disc: 0.95, oval: 1.0, log: 1.14, sheet: 1.05 };
  const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

  // Runs proof -> oven -> out. `model` is the deterministic rise model (see riseModel.js): how tall /
  // wide the pieces grow, how much of the rise happens before the oven, how fast they brown. Only
  // pieces on the tray are baked. Returns { promise, skip() }; `onProgress({phase, progress})` fires
  // every frame for the UI.
  function playBake({ doneness = 'golden', model = null, onProgress } = {}) {
    const m = { hMul: 1, wMul: 1, proofShare: 0.4, brownSpeed: 1, ...(model || {}) };
    setInteractive(false);
    interaction.select(null);
    const target = DONENESS[doneness] ?? DONENESS.golden;
    // What bakes: the sheet (Sheet & Trim) or the pieces on the tray (Shape & Place).
    const pieces = sheet ? [{ dough: sheet, data: { spec: { archetype: 'sheet' } } }] : doughItems().filter(i => i.home === 'tray');
    const rnd = pieces.map(() => ({ over: 0.03 + Math.random() * 0.05, bake: 0.94 + Math.random() * 0.12 }));
    const sp = reducedMotion() ? 0.3 : 1;
    const proofMs = (m.proofShare > 0.15 ? 2400 : 900) * sp, ovenMs = 7600 * sp, outMs = 1500 * sp, total = proofMs + ovenMs + outMs;
    const state = { t: 0, skip: false, ambience: null, ended: false };
    const trayC = tray.center;
    let resolveFn;
    const promise = new Promise((res) => { resolveFn = res; });

    stage.animate((dt, now) => {
      state.t = state.skip ? total : Math.min(total, state.t + dt * 1000);
      const t = state.t;
      const phase = t < proofMs ? 'proof' : t < proofMs + ovenMs ? 'oven' : 'out';
      const q = clamp((t - proofMs) / ovenMs, 0, 1);            // oven progress
      const outP = clamp((t - proofMs - ovenMs) / outMs, 0, 1); // wind-down progress

      // Rise: part of it before the oven (yeast proofs), the rest as a fast oven spring with a little
      // overshoot that settles.
      const proofFrac = m.proofShare * 0.92 * easeInOut(clamp(t / proofMs, 0, 1));
      const spring = 1 - Math.pow(1 - clamp(q / 0.5, 0, 1), 3);
      const inOven = m.proofShare * 0.92 + (1 - m.proofShare * 0.92) * spring;
      const bakeCurve = Math.pow(smooth(0.06, 0.98, q), 0.85);
      pieces.forEach((it, i) => {
        const base = phase === 'proof' ? proofFrac : inOven;
        const bump = phase === 'proof' ? 0 : rnd[i].over * Math.sin(Math.PI * clamp((q - 0.2) / 0.5, 0, 1));
        const f = base + bump;
        it.dough.setRise(f * m.hMul, f * m.wMul);
        const k = SHAPE_K[it.data?.spec?.archetype] ?? 1;
        it.dough.setBake(clamp(target * k * m.brownSpeed * bakeCurve * rnd[i].bake, 0, 1));
      });

      // The oven "turns on" as the oven phase begins and off again in the last beat.
      const level = phase === 'proof' ? 0 : phase === 'oven' ? smooth(0, 0.14, q) : 1 - easeInOut(outP);
      const cam = phase === 'proof' ? 0 : phase === 'oven' ? smooth(0, 0.18, q) : 1 - easeInOut(outP);
      const steamK = phase === 'oven' ? Math.pow(Math.sin(Math.PI * clamp(q * 0.98 + 0.01, 0, 1)), 0.7) * smooth(0, 0.1, q) : phase === 'out' ? (1 - outP) * 0.35 : 0;
      stage.setOvenLook(level, dt);
      stage.setView({
        x: stageCenter.x + (trayC.x - stageCenter.x) * cam, y: stageCenter.y + (trayC.y - stageCenter.y) * cam,
        zoom: 1 - 0.3 * cam, pitch: -0.11 * cam, lift: 0,
      });
      oven.setLevel(level); oven.setSteam(steamK);
      const size = stage.renderer.getDrawingBufferSize(new THREE.Vector2());
      oven.update(dt, now, size.y, THREE.MathUtils.degToRad(stage.camera.fov));

      if (phase !== 'proof' && !state.ambience && !state.skip) state.ambience = sfx.bakeAmbience?.() || { stop() {} };
      onProgress?.({ phase, progress: t / total });
      if (t >= total) {
        state.ended = true;
        state.ambience?.stop();
        oven.setLevel(0); oven.setSteam(0); stage.setOvenLook(0);
        stage.setView({ x: stageCenter.x, y: stageCenter.y, zoom: 1, pitch: 0, lift: 0 });
        sfx.ding?.();
        resolveFn();
        return false;
      }
      return true;
    });
    return { promise, skip() { state.skip = true; stage.requestRender(); } };
  }
  function resetBake() {
    setDoughState({ rise: 0, bake: 0 });
    if (oven) { oven.setLevel(0); oven.setSteam(0); }
    stage.setOvenLook(0);
    stage.setView({ x: stageCenter.x, y: stageCenter.y, zoom: 1, pitch: 0, lift: 0 });
    setInteractive(true);
  }

  function clearItems() {
    items.splice(0).forEach(it => { interaction.forget(it); stage.scene.remove(it.group, it.outline); it.dough?.dispose(); it.dispose(); });
    stage.requestRender();
  }
  function clearTray() {
    endPlacement();
    endSheet();
    clearItems();
    if (oven) { oven.dispose(); oven = null; }
    if (tray) {
      stage.scene.remove(tray.group);
      tray.group.traverse(o => o.geometry?.dispose?.());
      tray = null;
    }
    stage.requestRender();
  }

  // Replaces the current tray (and any items on it) and frames it with a short drop-in.
  function setTray(spec) {
    clearTray();
    const built = buildTray(spec, surfaces);
    if (!built) return false;
    tray = built;
    stage.scene.add(tray.group);
    oven = createOven({ scene: stage.scene, tier: stage.tier, plan: tray.plan, baseY: tray.floorTopY });
    fitToStage();
    const t0 = performance.now();
    tray.group.position.y = 5;
    stage.animate(() => {
      const t = Math.min(1, (performance.now() - t0) / 520);
      tray.group.position.y = (1 - easeOutCubic(t)) * 5;
      return t < 1;
    });
    return true;
  }

  // Drops a cutter onto the tray (it falls in and lands with a small squash).
  function addCutter({ shapeType, dims, x = 0, y = 0, data = {}, collision = 'lifted' }) {
    if (!tray) return null;
    const built = buildCutter({ shapeType, dims }, surfaces);
    if (!built) return null;
    const item = new PlacedItem({
      id: nextId++, kind: 'cutter', group: built.group, poly: built.poly, baseY: tray.floorTopY,
      height: built.height, data: { shapeType, dims, ...data }, collision,
    });
    items.push(item);
    if (!interaction.place(item, x, y)) {          // nowhere to put it: drop it rather than overlap another
      items.pop(); item.dispose();
      return null;
    }
    item.lift = 7;
    stage.scene.add(item.group, item.outline);
    interaction.wake(item);
    emit('change', items.map(describe));
    cuttersChanged();
    return describe(item);
  }

  // Drops one dough piece straight onto the tray (look-dev / tests). `spec` = { archetype, lengthCm,
  // widthCm, heightCm, taper?, score? }.
  function addDough(spec, { x = 0, y = 0, rot = 0, seed, baseY, lift = 0 } = {}) {
    if (!tray) return null;
    const piece = createDoughPiece(spec, { seed: seed ?? nextId * 7 + 3 });
    const item = new PlacedItem({
      id: nextId++, kind: 'dough', group: piece.group, poly: piece.poly, rot, baseY: baseY ?? tray.floorTopY,
      height: piece.height, data: { spec }, collision: 'solid',
    });
    item.dough = piece;
    items.push(item);
    interaction.place(item, x, y);
    item.lift = lift;
    stage.scene.add(item.group, item.outline);
    interaction.wake(item);
    emit('change', items.map(describe));
    return describe(item);
  }
  // How risen / baked every dough piece is (0..1).
  function setDoughState({ rise, bake } = {}, { onlyPlaced = false } = {}) {
    if (sheet) { if (rise !== undefined) sheet.setRise(rise); if (bake !== undefined) sheet.setBake(bake); }
    items.forEach(it => {
      if (!it.dough || (onlyPlaced && it.home !== 'tray')) return;
      if (rise !== undefined) it.dough.setRise(rise);
      if (bake !== undefined) it.dough.setBake(bake);
    });
    stage.requestRender();
  }

  // Look-dev sliders (localStorage.rofGameLookdev = '1'): scrub rise / bake on whatever is on the tray.
  let lookdevPanel = null;
  function showLookdev() {
    lookdevPanel?.remove();
    lookdevPanel = document.createElement('div');
    lookdevPanel.style.cssText = 'position:absolute;left:10px;bottom:10px;display:grid;grid-template-columns:auto 130px;gap:4px 10px;align-items:center;padding:8px 12px;border-radius:8px;background:rgba(15,28,22,.72);color:#e6eee6;font:12px system-ui,sans-serif;';
    const state = { rise: 0, bake: 0 };
    for (const [label, key] of [['Rise', 'rise'], ['Bake', 'bake']]) {
      const l = document.createElement('label'); l.textContent = label;
      const r = document.createElement('input'); r.type = 'range'; r.min = 0; r.max = 100; r.value = 0;
      r.addEventListener('input', () => { state[key] = r.value / 100; setDoughState({ rise: state.rise, bake: state.bake }); });
      lookdevPanel.append(l, r);
    }
    container.appendChild(lookdevPanel);
  }

  function removeItem(id, { quiet = false } = {}) {
    const i = items.findIndex(it => it.id === id);
    if (i < 0) return;
    const [it] = items.splice(i, 1);
    interaction.forget(it);
    stage.scene.remove(it.group, it.outline);
    it.dough?.dispose();
    it.dispose();
    stage.requestRender();
    emit('change', items.map(describe));
    if (!quiet && it.kind === 'cutter') cuttersChanged();
  }

  // Optional frame-rate readout for reporting how it runs on a given machine.
  let statsTimer = null, badge = null;
  try {
    if (localStorage.getItem('rofGameStats') === '1') {
      badge = document.createElement('div');
      badge.style.cssText = 'position:absolute;top:8px;right:8px;padding:3px 8px;border-radius:6px;background:rgba(0,0,0,.55);color:#dfe8df;font:11px/1.4 ui-monospace,monospace;pointer-events:none;';
      container.appendChild(badge);
      statsTimer = setInterval(() => {
        const s = api.getStats();
        badge.textContent = `${s.tier} · ${s.family} · ${s.fps ? Math.round(s.fps) + ' fps' : 'idle'} · ${s.drawCalls} draws`;
      }, 500);
    }
  } catch { /* no storage -- no badge */ }

  const api = {
    setTray, clearTray, addCutter, addDough, setDoughState, showLookdev, removeItem, clearItems, on,
    beginPlacement, endPlacement, autoArrange, returnAllToBench, playBake, resetBake, setInteractive,
    beginSheet, endSheet, armCutter, disarmCutter, setCutters, clearCutters, setScrapHighlight,
    getCutters: () => cutterItems().map(describeCutter),
    getSheet: () => sheet && { topY: sheet.topY(), thicknessCm: sheet.thicknessCm },
    setSfx: (fns) => Object.assign(sfx, fns),
    getBench: () => bench && { cx: bench.cx, cy: bench.cy, hw: bench.hw, hh: bench.hh },
    getPlacement: () => { const all = doughItems(); return { placed: all.filter(i => i.home === 'tray').length, total: all.length }; },
    setView: (v) => stage.setView(v),
    getItems: () => items.map(describe),
    resize: () => stage.resize(),
    setTier: (name) => stage.setTier(name),
    getStats: () => ({
      tier: stage.tier.name, family: stage.gpu.family, gpu: stage.gpu.raw, fps: stage.fps,
      drawCalls: stage.renderer.info.render.calls, triangles: stage.renderer.info.render.triangles,
    }),
    dispose() {
      clearTray();
      stage.dispose(); // runs the onDispose hook below (listeners, surfaces, stats timer)
    },
    _stage: stage, // exposed for the test harness
  };
  stage.onDispose(() => { stage.canvas.removeEventListener('pointermove', moveGhost); stage.canvas.removeEventListener('pointerleave', onGhostLeave); stage.canvas.removeEventListener('keydown', onGhostKey); clearInterval(statsTimer); interaction.dispose(); surfaces.dispose(); hud?.remove(); lookdevPanel?.remove(); });
  return api;
}
