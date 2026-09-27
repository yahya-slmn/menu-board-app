import { createStage } from './stage.js';
import { createSurfaces } from './surfaces.js';
import { buildTray, buildCutter } from './trayModels.js';
import { PlacedItem } from './items.js';
import { createInteraction } from './interaction.js';
import { createPlacement } from './placement.js';
import { createBench } from './bench.js';
import { createDoughPiece } from './dough.js';
import { createOven } from './oven.js';
import { prefersReducedMotion } from './quality.js';
import { createSheet, RISE_H } from './sheet.js';
import { packCutters } from './packing.js';
import { analyzeScrap } from './scrap.js';
import { planKnifeGrid, buildKnifeLines } from './knifeGrid.js';
import { createFillingMaterial } from './filling.js';
import { createPortionModel, drawDims, project } from './portion.js';

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
  let knife = null;        // Sheet & Trim, Trim by Knife: { plan, cuts, lines, solid } (see setKnifeGrid)
  let fills = [];          // Layered tray: the layers stacked on the sheet, bottom first (see setFillLayers)
  let armed = null;        // { shapeType, dims, materialId } -- the cutter that follows the pointer
  let ghost = null;        // the see-through cutter shown at the pointer while one is armed
  const items = [];
  let nextId = 1;
  const listeners = {};
  const on = (evt, fn) => { (listeners[evt] ||= []).push(fn); return () => { listeners[evt] = listeners[evt].filter(f => f !== fn); }; };
  const emit = (evt, payload) => (listeners[evt] || []).forEach(fn => fn(payload));
  const sfx = {}; // pickup / place / refuse / arrange, supplied by renderer.js (synthesized sounds)

  // ---- accessibility ---------------------------------------------------------------------------------
  // A visually hidden live region says what happened (placed, refused, selected, ...), so the stage is usable
  // without seeing it; the canvas is a focusable "application" with its keys described.
  const HIDDEN = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;';
  const liveEl = document.createElement('div');
  liveEl.setAttribute('aria-live', 'polite'); liveEl.setAttribute('aria-atomic', 'true'); liveEl.style.cssText = HIDDEN;
  const hintEl = document.createElement('div');
  hintEl.id = `rof-stage-hint-${Math.random().toString(36).slice(2, 8)}`; hintEl.style.cssText = HIDDEN;
  hintEl.textContent = 'Keys: ] and [ choose the next or previous piece. Enter moves the chosen piece between the bench and the tray. Arrow keys nudge it, hold Shift for bigger steps. R turns it. Delete sends it back to the bench. When a cutter is picked: arrow keys move it, Enter stamps it, Escape puts it down.';
  container.append(liveEl, hintEl);
  stage.canvas.setAttribute('role', 'application');
  stage.canvas.setAttribute('aria-label', 'Baking tray. Focus here to move pieces with the keyboard.');
  stage.canvas.setAttribute('aria-describedby', hintEl.id);
  let liveTimer = null;
  function announce(text) {
    // Clearing first makes a repeated identical message be read again.
    liveEl.textContent = '';
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { liveEl.textContent = text; }, 30);
  }

  const placement = createPlacement({ getItems: () => items, getTray: () => tray, getBench: () => bench });
  function describeForSpeech(it, index, total) {
    if (it.kind === 'dough') return `Piece ${index + 1} of ${total}, on the ${it.home}. Enter moves it to the ${it.home === 'tray' ? 'bench' : 'tray'}.`;
    if (it.kind === 'cutter') return `Cutter ${index + 1} of ${total} on the sheet. Arrow keys move it, R turns it, Delete removes it.`;
    return `Item ${index + 1} of ${total}.`;
  }
  // Enter / Space on the chosen piece: a bench piece goes to the first free spot on the tray, a tray piece goes back.
  function activateItem(item) {
    if (item.kind !== 'dough' || !placing) return;
    const it = items.find(i => i.id === item.id);
    if (!it) return;
    if (it.home === 'tray') { sendToBench(it); announce('Moved to the bench.'); return; }
    const n = placement.autoArrange([it]);
    if (n) { it.lift = fall(1.5); interaction.wake(it); sfx.place?.(it, 'tray'); emit('change', items.map(describe)); reportPlacement(); const p = api.getPlacement(); announce(`Moved to the tray. ${p.placed} of ${p.total} on the tray.`); }
    else { sfx.refuse?.(it); announce('No room on the tray for it.'); }
  }
  const describe = (it) => ({ id: it.id, kind: it.kind, x: it.tx, y: it.ty, rot: it.rotT, home: it.home, data: it.data });

  const interaction = createInteraction({
    stage, placement,
    sfx: {
      pickup: (i) => sfx.pickup?.(i),
      place: (i, where) => {
        sfx.place?.(i, where);
        if (i && i.kind === 'dough') { const p = api.getPlacement(); announce(`Placed on the ${where}. ${p.placed} of ${p.total} on the tray.`); }
        else if (i && i.kind === 'cutter') announce(`Cutter moved. ${cutterItems().length} on the sheet.`);
      },
      refuse: (i) => { sfx.refuse?.(i); announce("Can't place it there. It went back where it was."); },
    },
    getItems: () => items,
    getRegion: () => tray?.region,
    getFloorY: () => tray?.floorTopY ?? 0,
    emit: (evt, item) => {
      if (evt === 'validity') { announce(item.valid ? 'Can drop here.' : "Can't drop here."); return; }
      if (evt === 'cycle') { announce(describeForSpeech(item.item, item.index, item.total)); return; }
      if (evt === 'activate') { activateItem(item); return; }
      if (evt === 'delete') {
        if (placing && item.kind === 'dough') {
          if (item.home === 'bench') announce('Already on the bench.');
          else { sendToBench(item); announce('Moved to the bench.'); }
        } else { const wasCutter = item.kind === 'cutter'; removeItem(item.id); if (wasCutter) announce(`Cutter removed. ${cutterItems().length} on the sheet.`); }
        return;
      }
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
  function fitToStage(opts = {}) {
    const t = tray.plan;
    const box = bench
      ? { minX: Math.min(t.minX, bench.cx - bench.hw - 1), maxX: Math.max(t.maxX, bench.cx + bench.hw + 1), minY: Math.min(t.minY, bench.cy - bench.hh - 1), maxY: t.maxY }
      : t;
    const hw = (box.maxX - box.minX) / 2, hh = (box.maxY - box.minY) / 2;
    stageCenter = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
    stage.fit({ cx: stageCenter.x, cy: stageCenter.y, radius: Math.hypot(hw, hh) * 0.85 + 1, ...opts });
  }

  // Starts Shape & Place: lays out `count` pieces of `spec` on a bench in front of the tray. On a
  // muffin tray the count is the number of cups and each piece is sized to fit one. Returns the
  // spec/count actually used, since the tray can change them.
  function beginPlacement({ spec, count, spread = 1 }) {
    closePortion({ quiet: true });
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
    updateInset();

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
    items.forEach((it, i) => { it.x = it.tx; it.y = it.ty; it.baseY = it.baseYT; it.lift = fall(4 + (i % 5) * 0.6); interaction.wake(it); });

    hud = document.createElement('div');
    hud.setAttribute('aria-hidden', 'true'); // the live region already says it
    hud.style.cssText = 'position:absolute;top:10px;left:10px;padding:5px 11px;border-radius:999px;background:rgba(15,28,22,.72);color:#e6eee6;font:600 12px system-ui,sans-serif;pointer-events:none;';
    container.appendChild(hud);
    fitToStage();
    reportPlacement();
    return { spec, count };
  }
  function endPlacement() {
    closePortion({ quiet: true });
    if (bench) { stage.scene.remove(bench.group); bench.dispose(); bench = null; }
    hud?.remove(); hud = null;
    placing = false;
    updateInset();
    if (tray) fitToStage();
  }
  // Lays the pieces still on the bench onto the tray, top-left first.
  function autoArrange() {
    closePortion({ quiet: true });
    const pieces = doughItems().filter(i => i.home === 'bench');
    const n = placement.autoArrange(pieces);
    pieces.forEach(it => { it.lift = fall(2.2); interaction.wake(it); });
    if (n) sfx.arrange?.();
    emit('change', items.map(describe));
    reportPlacement();
    return n;
  }
  function sendToBench(item) {
    item.startX = item.tx; item.startY = item.ty; item.startRot = item.rotT; item.startHome = item.home;
    placement.packOnBench([item]);
    item.lift = fall(1.5);
    interaction.wake(item);
    emit('change', items.map(describe));
    reportPlacement();
  }
  function returnAllToBench() {
    closePortion({ quiet: true });
    const onTray = doughItems().filter(i => i.home === 'tray');
    placement.packOnBench(onTray);
    onTray.forEach(it => { it.lift = fall(1.5); interaction.wake(it); });
    emit('change', items.map(describe));
    reportPlacement();
  }
  function setInteractive(on) { interaction.setEnabled(on); }
  // ---- Sheet & Trim ---------------------------------------------------------------------------------
  const cutterItems = () => items.filter(i => i.kind === 'cutter');
  // Everything cut from the sheet: stamped / arranged cutters, or the pieces of a knife grid (never both).
  // Knife pieces aren't items (nothing to drag); they carry the same fields the mask / scrap / UI read.
  const allCuts = () => (knife ? cutterItems().concat(knife.cuts) : cutterItems());
  const describeCutter = (it) => ({ id: it.id, x: it.tx, y: it.ty, rot: it.rotT, data: it.data });
  // Redraws the mask the sheet uses to tell "inside a cutter" from "scrap", and tells the UI.
  function cuttersChanged() {
    if (!sheet) return;
    const cs = allCuts();
    sheet.mask.redraw(cs.map(c => ({ poly: c.poly, x: c.tx, y: c.ty, rot: c.rotT })));
    sheet.setHasCuts(cs.length);
    fills.forEach(f => f.sheet.setHasCuts(cs.length));
    stage.requestRender();
    emit('cutters', cs.map(describeCutter));
    scheduleScrap();
  }

  // ---- scrap: where it is, how much, and red flags on it -------------------------------------------------
  // Each separate uncut region can carry a flag with its grams and its share of the dough on the tray; a chip
  // shows the total; hovering any scrap shows that spot's numbers. The share is of the DOUGH ON THE TRAY (the
  // sheet is uniform, so area share = weight share).
  let sheetGrams = 0, scrap = null, scrapOn = true, scrapTimer = null, flagLayer = null, chipEl = null, tipEl = null, scrapRow = null, scrapBtn = null;
  const flagEls = [];
  const fmtG = (g) => (g >= 10 ? String(Math.round(g)) : String(Math.round(g * 10) / 10));
  const fmtPct = (f) => { const p = f * 100; return (p >= 10 ? String(Math.round(p)) : String(Math.round(p * 10) / 10)); };
  const scrapSummary = () => scrap && {
    totalGrams: (scrap.totalArea / scrap.interiorArea) * sheetGrams, totalPct: (scrap.totalArea / scrap.interiorArea) * 100,
    regions: scrap.regions.map(r => ({ grams: r.fraction * sheetGrams, pct: r.fraction * 100, x: r.px, y: r.py })),
  };
  function scheduleScrap() { clearTimeout(scrapTimer); scrapTimer = setTimeout(runScrap, 90); }
  function runScrap() {
    if (!sheet || !tray || tray.region.kind === 'cups') { scrap = null; renderFlags(); return; }
    const cs = allCuts();
    // A round cutter's outline is a 32-gon; use its true circle area so the numbers match the panel's exactly.
    const exact = (c) => (c.data.shapeType === 'round' ? Math.PI * (c.data.dims.diameterCm / 2) ** 2 : undefined);
    scrap = cs.length ? analyzeScrap({ region: tray.region, cutters: cs.map(c => ({ poly: c.poly, x: c.tx, y: c.ty, rot: c.rotT, area: exact(c) })) }) : null;
    renderFlags();
    emit('scrap', scrapSummary());
  }
  function ensureScrapDom() {
    if (flagLayer) return;
    flagLayer = document.createElement('div');
    flagLayer.setAttribute('aria-hidden', 'true');
    flagLayer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
    // Top-left of the stage: the Highlight-scrap switch and, beside it, the scrap total. (It used to be a checkbox at
    // the bottom of the panel, below the fold at the default window size.)
    scrapRow = document.createElement('div'); scrapRow.className = 'rof-scrap-row'; scrapRow.hidden = true;
    scrapBtn = document.createElement('button');
    scrapBtn.type = 'button'; scrapBtn.className = 'rof-tool-btn rof-scrap-toggle';
    scrapBtn.setAttribute('aria-pressed', 'true'); scrapBtn.title = 'Show or hide the red scrap marking';
    scrapBtn.innerHTML = '<span class="rof-tool-dot" aria-hidden="true"></span><span>Highlight scrap</span>';
    scrapBtn.addEventListener('click', () => { setScrapHighlight(!scrapOn); announce(scrapOn ? 'Scrap highlighted.' : 'Scrap highlight off.'); });
    chipEl = document.createElement('div'); chipEl.className = 'rof-scrap-chip'; chipEl.hidden = true;
    scrapRow.append(scrapBtn, chipEl);
    tipEl = document.createElement('div'); tipEl.className = 'rof-scrap-tip'; tipEl.hidden = true;
    container.append(flagLayer, scrapRow, tipEl);
    stage.addFrameHook(positionFlags);
  }
  function renderFlags() {
    ensureScrapDom();
    flagEls.splice(0).forEach(f => f.el.remove());
    // The switch is there whenever there are cutters on a sheet; the chip and flags only while highlighting.
    scrapRow.hidden = !(sheet && allCuts().length);
    scrapBtn.setAttribute('aria-pressed', String(scrapOn));
    const show = scrapOn && scrap && scrap.regions.length && sheetGrams > 0;
    chipEl.hidden = !show; if (tipEl && !show) tipEl.hidden = true;
    if (!show) { stage.requestRender(); return; }
    const total = scrapSummary();
    chipEl.textContent = `Scrap ${fmtG(total.totalGrams)} g · ${fmtPct(total.totalPct / 100)}%`;
    chipEl.title = `${fmtG(total.totalGrams)} g of scrap, ${fmtPct(total.totalPct / 100)}% of the dough on this tray`;
    // A flag on each region big enough to read (2% of the dough or more), at most five.
    scrap.regions.filter(r => r.fraction >= 0.02).slice(0, 5).forEach((r) => {
      const el = document.createElement('div'); el.className = 'rof-flag';
      el.innerHTML = `<span class="rof-flag-pole"></span><span class="rof-flag-label">${fmtG(r.fraction * sheetGrams)} g · ${fmtPct(r.fraction)}%</span>`;
      flagLayer.appendChild(el); flagEls.push({ el, x: r.px, y: r.py });
    });
    stage.requestRender();
  }
  const _v = new THREE.Vector3();
  function positionFlags() {
    if (!flagEls.length || !tray) return;
    const w = container.clientWidth, h = container.clientHeight, y = tray.floorTopY + stackTopY();
    for (const f of flagEls) {
      _v.set(f.x, y, -f.y).project(stage.camera);
      const off = _v.z > 1 || Math.abs(_v.x) > 1.05 || Math.abs(_v.y) > 1.05;
      f.el.style.display = off ? 'none' : '';
      if (!off) f.el.style.transform = `translate(${((_v.x + 1) / 2) * w}px, ${((1 - _v.y) / 2) * h}px)`;
    }
  }
  // Hover: which scrap region is under the pointer, and its numbers.
  stage.canvas.addEventListener('pointermove', (e) => {
    if (!tipEl) return;
    if (!scrapOn || !scrap || ghost || interaction.isDragging() || sheetGrams <= 0) { tipEl.hidden = true; return; }
    if (interaction.pickAt(e)) { tipEl.hidden = true; return; }                       // over a cutter
    const p = interaction.planePoint(e, tray.floorTopY + stackTopY());
    const id = p ? scrap.regionAt(p.x, p.y) : -1;
    const r = id >= 0 ? scrap.regions.find(q => q.id === id) : null;
    if (!r) { tipEl.hidden = true; return; }
    const rect = container.getBoundingClientRect();
    tipEl.textContent = `Scrap: ${fmtG(r.fraction * sheetGrams)} g · ${fmtPct(r.fraction)}% of the dough (${fmtPct(r.area / scrap.totalArea)}% of the scrap)`;
    tipEl.hidden = false;
    tipEl.style.left = `${e.clientX - rect.left + 14}px`; tipEl.style.top = `${e.clientY - rect.top + 14}px`;
  });
  stage.canvas.addEventListener('pointerleave', () => { if (tipEl) tipEl.hidden = true; });

  // Puts the dough in the tray as one sheet `thicknessCm` thick (raw). Returns false on a muffin tray.
  function beginSheet({ thicknessCm }) {
    closePortion({ quiet: true });
    if (!tray || tray.region.kind === 'cups') return false;
    endSheet(); endPlacement(); clearItems();
    sheet = createSheet({ region: tray.region, plan: tray.plan, thicknessCm });
    sheet.group.position.y = tray.floorTopY;
    stage.scene.add(sheet.group);
    updateInset();
    fitToStage();
    return true;
  }
  function endSheet() {
    closePortion({ quiet: true });
    disarmCutter();
    dropKnife();
    dropFills();
    clearItems();
    if (sheet) { stage.scene.remove(sheet.group); sheet.dispose(); sheet = null; }
    scrap = null; clearTimeout(scrapTimer);
    if (flagLayer) renderFlags();
    updateInset();
  }

  // Arms a cutter: a see-through copy follows the pointer over the tray (red where it can't go) and a
  // click stamps a real one there. Clicking an existing cutter still picks it up instead.
  function armCutter(spec) {
    closePortion({ quiet: true });
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
    const hover = tray.floorTopY + stackTopY() + 0.9 - tray.floorTopY;
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
    if (!ghost || interaction.selected || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') { disarmCutter(); announce('Cutter put down.'); return; }
    if (e.key === 'r' || e.key === 'R') { rotateGhost(e.shiftKey ? -0.26 : 0.26); return; }
    const step = e.shiftKey ? 2 : 0.5;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (move) {
      e.preventDefault();
      // First arrow key shows the cutter in the middle of the tray; after that it moves.
      const from = ghost.group.visible ? [ghost.tx, ghost.ty] : [tray.center.x, tray.center.y];
      const p = interaction.probe(ghost, from[0] + (ghost.group.visible ? move[0] : 0), from[1] + (ghost.group.visible ? move[1] : 0));
      ghost.x = ghost.tx = p.x; ghost.y = ghost.ty = p.y; ghost.invalid = !p.valid;
      ghost.group.visible = true; ghost.sync(); ghost.outline.visible = true; stage.requestRender();
      announce(p.valid ? 'Clear.' : 'Blocked.');
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!ghost.group.visible) { announce('Move the cutter first with the arrow keys.'); return; }
      const before = cutterItems().length;
      stampAtGhost();
      const after = cutterItems().length;
      announce(after > before ? `Stamped. ${after} on the sheet.` : "Can't stamp there.");
    }
  };
  const onGhostLeave = () => { if (ghost) { ghost.group.visible = false; ghost.outline.visible = false; stage.requestRender(); } };
  stage.canvas.addEventListener('pointermove', moveGhost);
  stage.canvas.addEventListener('pointerleave', onGhostLeave);
  stage.canvas.addEventListener('keydown', onGhostKey);
  interaction.hooks.emptyDown = stampAtGhost;

  // Replaces every cutter with `list` ([{ shapeType, dims, x, y, materialId }]) -- used by auto-arrange.
  function setCutters(list) {
    closePortion({ quiet: true });
    dropKnife();
    cutterItems().forEach(c => removeItem(c.id, { quiet: true }));
    list.forEach((c, i) => { const d = addCutter({ ...c, data: { materialId: c.materialId } }); const it = d && items.find(x => x.id === d.id); if (it) it.lift = fall(4 + (i % 6) * 0.5); });
    cuttersChanged();
    return cutterItems().length;
  }
  // Auto-arrange: pack as many of this cutter as the tray holds (alternating up / down for triangles, see
  // packing.js) and lay them out with the rotation the packer chose -- the orientation is what makes the
  // triangles tessellate, so it must reach the cutter, not just the position.
  function autoArrangeCutters({ shapeType, dims, materialId, marginCm = 0.3, gapCm = 0.2 }) {
    closePortion({ quiet: true });
    if (!tray || tray.region.kind === 'cups') return { count: 0, frameDeg: 0 };
    const res = packCutters({ region: tray.region, shapeType, dims, marginCm, gapCm });
    const n = setCutters(res.placements.map(p => ({ shapeType, dims, x: p.x, y: p.y, rot: p.rot, materialId })));
    return { count: n, frameDeg: res.frameDeg, planned: res.placements.length };
  }
  // How many of a cutter Auto-arrange WOULD place, without placing anything (the Trim panel's preview).
  function planCutters({ shapeType, dims, marginCm = 0.3, gapCm = 0.2 }) {
    if (!tray || tray.region.kind === 'cups') return 0;
    return packCutters({ region: tray.region, shapeType, dims, marginCm, gapCm }).placements.length;
  }
  function clearCutters() { closePortion({ quiet: true }); dropKnife(); cutterItems().forEach(c => removeItem(c.id, { quiet: true })); cuttersChanged(); }

  // ---- Trim by Knife ---------------------------------------------------------------------------------
  // A centred grid of straight cuts (knifeGrid.js). Replaces any cutters. `solid` = cut (solid lines) vs
  // still marking (dotted). Returns the plan: { count, cols, rows, leftover: { across, down }, fits }.
  function dropKnife() {
    if (!knife) return;
    if (knife.lines) { knife.lines.parent?.remove(knife.lines); knife.lines.userData.dispose(); }
    knife = null;
  }
  function drawKnifeLines() {
    if (!knife || !sheet) return;
    if (knife.lines) { knife.lines.parent?.remove(knife.lines); knife.lines.userData.dispose(); }
    // In the sheet's own space (it sits at the tray floor), just over its risen top.
    knife.lines = buildKnifeLines(knife.plan.cuts, { y: stackTopY() + 0.06, solid: knife.solid });
    sheet.group.add(knife.lines);
    stage.requestRender();
  }
  function setKnifeGrid({ acrossCm, downCm, solid = false }) {
    closePortion({ quiet: true });
    disarmCutter();
    if (!sheet || !tray || tray.region.kind === 'cups') return planKnifeGrid({ region: null });
    cutterItems().forEach(c => removeItem(c.id, { quiet: true }));
    dropKnife();
    const plan = planKnifeGrid({ region: tray.region, acrossCm, downCm });
    const hx = acrossCm / 2, hy = downCm / 2;
    const poly = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
    const data = { shapeType: 'rectangular', dims: { lengthCm: acrossCm, widthCm: downCm }, materialId: 'knife' };
    knife = { plan, solid, lines: null, cuts: plan.cells.map((c, i) => ({ id: `knife-${i}`, tx: c.x, ty: c.y, rotT: 0, poly, data })) };
    drawKnifeLines();
    cuttersChanged();
    return plan;
  }
  // ---- Layered tray: layers on top of the sheet --------------------------------------------------------
  // The sheet is the bottom layer; each layer above it is its own sheet mesh (sheet.js with a filling material,
  // filling.js), built once 1 cm thick and scaled to its height, so changing a height is instant and can "pour"
  // (the shown height eases to the target). Each sits on the one below, and the whole stack follows the bottom
  // sheet's top (its rise, or a measured height). `list`: [{ key, heightCm, look }], bottom first; a key already
  // shown keeps its mesh, a missing one is removed.
  function dropFills() {
    fills.forEach(f => { f.group.parent?.remove(f.group); f.sheet.dispose(); });
    fills = [];
    fillTicker?.(); fillTicker = null;
  }
  let fillTicker = null;
  // The top surface in the tray (sheet-local): the sheet's, or -- with layers on it -- the top of the stack. Cut lines,
  // scrap flags, the scrap hover and the cutter ghost all sit on it.
  const stackTopY = () => (sheet ? sheet.topY() + fills.reduce((h, f) => h + f.shownH, 0) : 0);
  function layoutFills() {
    if (!sheet) return;
    let y = sheet.topY();
    for (const f of fills) {
      f.group.position.y = y;
      f.group.scale.y = Math.max(f.shownH, 0.001);
      f.group.visible = f.shownH > 0.002;
      y += f.shownH;
    }
    stage.requestRender();
  }
  // A filling browns on top: its colour eases from as-is towards a baked amber (at most 60% of the way).
  const BROWN = new THREE.Color('#9a6534');
  function setFillBrown(f, b) {
    const mat = f.sheet.material;
    if (!mat.userData.baseColor) mat.userData.baseColor = mat.color.clone();
    mat.color.copy(mat.userData.baseColor).lerp(BROWN, clamp(b, 0, 1) * 0.6);
  }
  function setFillLayers(list, { pour = true } = {}) {
    if (!sheet || !tray || tray.region.kind === 'cups') return false;
    const keep = new Map(fills.map(f => [f.key, f]));
    const next = [];
    (list || []).forEach((l, i) => {
      let f = keep.get(l.key);
      if (f) keep.delete(l.key);
      else {
        const s1 = createSheet({ region: tray.region, plan: tray.plan, thicknessCm: 1, seed: 17 + i * 13,
          makeMaterial: () => createFillingMaterial(l.look || {}, { seed: 5 + i, scrap: { mask: sheet.mask.texture, plan: tray.plan } }) });
        s1.setScrapHighlight(scrapOn);
        s1.mesh.castShadow = true; s1.mesh.receiveShadow = true;
        f = { key: l.key, sheet: s1, group: s1.group, shownH: 0, targetH: 0 };
        sheet.group.add(s1.group);
      }
      f.targetH = Math.max(0, Number(l.heightCm) || 0);
      f.rawH = null;
      setFillBrown(f, 0);
      if (!pour || reducedMotion()) f.shownH = f.targetH;
      next.push(f);
    });
    keep.forEach(f => { f.group.parent?.remove(f.group); f.sheet.dispose(); });
    fills = next;
    layoutFills();
    if (!fillTicker && fills.some(f => Math.abs(f.shownH - f.targetH) > 1e-4)) {
      // Ease towards the target: about a second from empty, a quick glide for a small change.
      fillTicker = stage.animate((dt) => {
        let moving = false;
        for (const f of fills) {
          const d = f.targetH - f.shownH;
          if (Math.abs(d) < 1e-4) { f.shownH = f.targetH; continue; }
          f.shownH += d * Math.min(1, dt * 4.5);
          moving = true;
        }
        layoutFills();
        if (!moving) fillTicker = null;
        return moving;
      });
    }
    return true;
  }
  const getFills = () => fills.map(f => ({ key: f.key, heightCm: f.targetH, shownCm: f.shownH }));

  function setKnifeSolid(solid) {
    if (!knife || knife.solid === solid) return;
    closePortion({ quiet: true });
    knife.solid = solid;
    drawKnifeLines();
  }
  function setScrapHighlight(on) { scrapOn = on; sheet?.setScrapHighlight(on); fills.forEach(f => f.sheet.setScrapHighlight(on)); renderFlags(); stage.requestRender(); }
  function setSheetGrams(g) { sheetGrams = g; renderFlags(); }

  // ---- bake director -------------------------------------------------------------------------------
  // Doneness is how far the browning goes; shapes need different amounts of "bake" to look equally done
  // (a dome catches the heat on top and browns early; a long thin loaf browns later).
  const DONENESS = { light: 0.52, golden: 0.68, dark: 0.88 };
  const SHAPE_K = { ball: 1.0, disc: 0.95, oval: 1.0, log: 1.14, sheet: 1.05 };
  const reducedMotion = prefersReducedMotion;
  const fall = (h) => (reducedMotion() ? 0 : h); // how far a piece drops in from (skipped with reduced motion)

  // Runs proof -> oven -> out. `model` is the deterministic rise model (see riseModel.js): how tall /
  // wide the pieces grow, how much of the rise happens before the oven, how fast they brown. Only
  // pieces on the tray are baked. Returns { promise, skip() }; `onProgress({phase, progress})` fires
  // every frame for the UI.
  // `layered` (a layered tray's final bake): { baseFixed, fills: [{ key, hMul, brownSpeed }] }. A pre-baked base
  // (baseFixed) keeps its height and browns a little more; the sheet otherwise rises by `model` as usual; each layer
  // on top rises by its own hMul (the sheet's formula, raw x (1 + RISE_H x hMul)) and browns at its own speed.
  function playBake({ doneness = 'golden', model = null, onProgress, layered = null } = {}) {
    closePortion({ quiet: true });
    const m = { hMul: 1, wMul: 1, proofShare: 0.4, brownSpeed: 1, ...(model || {}) };
    const baseStart = sheet ? { rise: sheet.rise, bake: sheet.bake } : null;
    const fillBake = layered ? fills.map(f => {
      if (f.rawH == null) f.rawH = f.targetH;            // the assembled height, kept for "Bake again"
      const lm = (layered.fills || []).find(x => x.key === f.key) || {};
      return { f, hMul: Number(lm.hMul) || 0, brown: Number(lm.brownSpeed) || 1 };
    }) : [];
    setInteractive(false);
    interaction.select(null);
    insetForced = true; updateInset();                 // the oven scene has its own framing
    stage.setViewAngles(stage.VIEWS.angled);
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
        const k = SHAPE_K[it.data?.spec?.archetype] ?? 1;
        if (layered && layered.baseFixed && it.dough === sheet) {
          // Already baked: it keeps its height and takes up to a third of the remaining colour.
          it.dough.setBake(baseStart.bake + (1 - baseStart.bake) * 0.34 * bakeCurve);
          return;
        }
        it.dough.setRise(f * m.hMul, f * m.wMul);
        it.dough.setBake(clamp(target * k * m.brownSpeed * bakeCurve * rnd[i].bake, 0, 1));
      });
      if (fillBake.length) {
        const f = phase === 'proof' ? 0 : inOven;
        for (const fb of fillBake) {
          fb.f.targetH = fb.f.shownH = fb.f.rawH * (1 + RISE_H * fb.hMul * f);
          setFillBrown(fb.f, clamp(target * fb.brown * bakeCurve, 0, 1));
        }
        layoutFills();
      }

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
        insetForced = false; updateInset();
        resolveFn();
        return false;
      }
      return true;
    });
    return { promise, skip() { state.skip = true; stage.requestRender(); } };
  }
  function resetBake() {
    closePortion({ quiet: true });
    // Layers go back to their assembled height and colour (the caller puts a pre-baked base back, see renderer).
    for (const f of fills) { if (f.rawH != null) { f.targetH = f.shownH = f.rawH; f.rawH = null; } setFillBrown(f, 0); }
    setDoughState({ rise: 0, bake: 0 });
    if (oven) { oven.setLevel(0); oven.setSteam(0); }
    stage.setOvenLook(0);
    stage.setView({ x: stageCenter.x, y: stageCenter.y, zoom: 1, pitch: 0, lift: 0 });
    setInteractive(true);
    insetForced = false; updateInset();
  }

  function clearItems() {
    items.splice(0).forEach(it => { interaction.forget(it); stage.scene.remove(it.group, it.outline); it.dough?.dispose(); it.dispose(); });
    stage.requestRender();
  }
  function clearTray() {
    closePortion({ quiet: true });
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
    if (reducedMotion()) return true; // no drop-in
    tray.group.position.y = 5;
    stage.animate(() => {
      const t = Math.min(1, (performance.now() - t0) / 520);
      tray.group.position.y = (1 - easeOutCubic(t)) * 5;
      return t < 1;
    });
    return true;
  }

  // Drops a cutter onto the tray (it falls in and lands with a small squash).
  function addCutter({ shapeType, dims, x = 0, y = 0, rot = 0, data = {}, collision = 'lifted' }) {
    if (!tray) return null;
    const built = buildCutter({ shapeType, dims }, surfaces);
    if (!built) return null;
    const item = new PlacedItem({
      id: nextId++, kind: 'cutter', group: built.group, poly: built.poly, baseY: tray.floorTopY,
      height: built.height, data: { shapeType, dims, ...data }, collision, rot,
    });
    items.push(item);
    if (!interaction.place(item, x, y)) {          // nowhere to put it: drop it rather than overlap another
      items.pop(); item.dispose();
      return null;
    }
    item.lift = fall(7);
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
    if (sheet) { if (rise !== undefined) sheet.setRise(rise); if (bake !== undefined) sheet.setBake(bake); if (fills.length) layoutFills(); }
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

  // ---- View: presets, turning the view, and the side-view inset ----------------------------------------------
  // Turning the view never moves a piece: while one is held, the piece keeps its place in the world and the grab
  // offset is re-anchored (interaction.reanchor), so the next mouse move continues from where it is. Q / E turn the
  // view (also mid-drag, since the keys are independent of the mouse); right-drag or Alt+drag orbits when nothing
  // is held; the buttons jump to Top / Angled / Low front / Low side.
  // One choice per method: the strip is on by default in Shape & Place (heights and gaps between pieces) and OFF by
  // default in Sheet & Trim (a baked sheet is about a centimetre thick, so the strip is a thin line), where the button
  // still turns it on.
  const INSET_KEYS = { place: 'rofSideView', sheet: 'rofSideViewSheet' };
  const insetPrefs = { place: true, sheet: false };
  let insetForced = false;                        // "off just now" (during the bake)
  let portion = null;                             // the one-portion view while it is open (below)
  try {
    insetPrefs.place = localStorage.getItem(INSET_KEYS.place) !== '0';
    insetPrefs.sheet = localStorage.getItem(INSET_KEYS.sheet) === '1';
  } catch { /* defaults */ }
  const insetMode = () => (sheet ? 'sheet' : 'place');
  let viewBox = null, viewBtns = {}, insetBtn = null, insetFrame = null;
  const VIEW_ORDER = ['top', 'angled', 'lowFront', 'lowSide'];
  function buildViewTools() {
    viewBox = document.createElement('div'); viewBox.className = 'rof-view-tools';
    const grp = document.createElement('div'); grp.className = 'rof-view-group'; grp.setAttribute('role', 'group'); grp.setAttribute('aria-label', 'View');
    grp.title = 'Right-drag (or Alt+drag) to turn the view; Q / E turn it too, and 1-4 pick a view, when the stage is focused.';
    for (const k of VIEW_ORDER) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'rof-tool-btn rof-view-btn'; b.textContent = stage.VIEWS[k].label; b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => { stage.setViewAngles(stage.VIEWS[k]); announce(`${stage.VIEWS[k].label} view.`); });
      grp.appendChild(b); viewBtns[k] = b;
    }
    insetBtn = document.createElement('button'); insetBtn.type = 'button'; insetBtn.className = 'rof-tool-btn'; insetBtn.textContent = 'Side view';
    insetBtn.setAttribute('aria-pressed', String(insetPrefs[insetMode()])); insetBtn.title = 'A small side elevation in the corner, for judging heights and gaps';
    insetBtn.addEventListener('click', () => {
      const mode = insetMode(); insetPrefs[mode] = !insetPrefs[mode];
      try { localStorage.setItem(INSET_KEYS[mode], insetPrefs[mode] ? '1' : '0'); } catch { /* not persisted */ }
      updateInset(); announce(insetPrefs[mode] ? 'Side view shown.' : 'Side view hidden.');
    });
    viewBox.append(grp, insetBtn);
    insetFrame = document.createElement('div'); insetFrame.className = 'rof-inset-frame'; insetFrame.setAttribute('aria-hidden', 'true'); insetFrame.hidden = true;
    insetFrame.innerHTML = '<span>Side view</span>';
    container.append(viewBox, insetFrame);
    refreshViewButtons();
  }
  function refreshViewButtons() {
    const name = stage.viewName();
    for (const k of VIEW_ORDER) viewBtns[k].setAttribute('aria-pressed', String(k === name));
  }
  // The strip shows while pieces or a sheet are on the stage (not in Setup, not during the bake).
  function updateInset() {
    const pref = insetPrefs[insetMode()];
    if (insetBtn) insetBtn.setAttribute('aria-pressed', String(pref));
    const on = pref && !insetForced && !portion && (placing || !!sheet);
    stage.setInset(on);
    if (insetFrame) {
      insetFrame.hidden = !on;
      if (on) { const r = stage.getInsetRect(); Object.assign(insetFrame.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' }); }
    }
  }
  const insetHit = (e) => {
    if (!stage.insetOn) return false;
    const r = stage.getInsetRect(), b = stage.canvas.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  };
  // Orbit gestures: right-drag, or Alt+left-drag. Only when nothing is held.
  let orbit = null;
  const isOrbitGesture = (e) => e.button === 2 || (e.button === 0 && e.altKey);
  interaction.hooks.blocked = (e) => isOrbitGesture(e) || insetHit(e) || !!orbit;
  stage.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.canvas.addEventListener('pointerdown', (e) => {
    if (!isOrbitGesture(e) || interaction.isDragging()) return;
    e.preventDefault();
    orbit = { x: e.clientX, y: e.clientY, id: e.pointerId };
    stage.canvas.setPointerCapture(e.pointerId); stage.canvas.style.cursor = 'move'; stage.canvas.focus({ preventScroll: true });
  });
  stage.canvas.addEventListener('pointermove', (e) => {
    if (!orbit || e.pointerId !== orbit.id) return;
    stage.orbitBy(-(e.clientX - orbit.x) * 0.008, (e.clientY - orbit.y) * 0.005);
    orbit.x = e.clientX; orbit.y = e.clientY;
  });
  const endOrbit = (e) => { if (orbit && e.pointerId === orbit.id) { try { stage.canvas.releasePointerCapture(e.pointerId); } catch { /* released */ } orbit = null; stage.canvas.style.cursor = ''; announce(viewSpeech()); } };
  stage.canvas.addEventListener('pointerup', endOrbit);
  stage.canvas.addEventListener('pointercancel', endOrbit);
  const viewSpeech = () => { const v = stage.getView(); return v.name ? `${stage.VIEWS[v.name].label} view.` : `View turned to ${Math.round(v.yaw * 180 / Math.PI)} degrees, ${Math.round(v.pitch * 180 / Math.PI)} degrees up.`; };
  stage.canvas.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape' && portion) { e.preventDefault(); closePortion(); return; }
    const k = e.key.toLowerCase();
    if (k === 'q' || k === 'e') { e.preventDefault(); stage.orbitBy((k === 'e' ? 1 : -1) * (e.shiftKey ? 5 : 15) * Math.PI / 180); announce(viewSpeech()); }
    else if (k >= '1' && k <= '4') { e.preventDefault(); const name = VIEW_ORDER[+k - 1]; stage.setViewAngles(stage.VIEWS[name]); announce(`${stage.VIEWS[name].label} view.`); }
  });
  // Any change of the view while a piece is held: re-anchor (see above), and keep the buttons and the inset frame current.
  stage.onCameraChange(() => { interaction.reanchor(); refreshViewButtons(); });
  // The strip's window: the whole tray by default, and -- so heights and gaps can be judged where it matters -- a
  // tighter window that follows the piece being held.
  function focusInset() {
    if (!stage.insetOn || !tray) return;
    const v = stage.getView(), pl = tray.plan, hx = (pl.maxX - pl.minX) / 2, hz = (pl.maxY - pl.minY) / 2;
    // The tray's extent along the strip's horizontal axis (perpendicular to the main view direction).
    const along = hx * Math.abs(Math.sin(v.yaw)) + hz * Math.abs(Math.cos(v.yaw));
    const held = items.find(i => i.dragging);
    if (held) stage.setInsetFocus(held.x, held.y, Math.min(along * 1.15 + 2, 20));
    else stage.setInsetFocus(tray.center.x, tray.center.y, along * 1.15 + 2);
  }
  stage.addFrameHook(() => { if (stage.insetOn) { updateInset(); focusInset(); } });
  buildViewTools();


  // ---- one-portion detail view ---------------------------------------------------------------------------------
  // Takes the tray, bench, sheet and cutters off the stage (they are only hidden, so closing puts everything back
  // exactly as it was) and shows ONE baked portion on a board with its measurements: dimension lines drawn over the
  // piece and a card of numbers. Both methods use it; `desc` is described in portion.js. Anything that changes the tray
  // (arming a cutter, arranging, baking again...) closes it first, so it never shows stale dough.
  const CAPTURE_ASPECT = 2.3;
  const PORTION_VIEW = { yaw: 28 * Math.PI / 180, pitch: 30 * Math.PI / 180 };
  function setStageToolsHidden(hide) {
    const d = hide ? 'none' : '';
    for (const el of [hud, scrapRow, flagLayer, tipEl, insetBtn, qualityBox]) if (el) el.style.display = d;
  }
  function buildPortionCard(desc) {
    const card = document.createElement('div');
    card.className = 'rof-portion-card'; card.setAttribute('role', 'region'); card.setAttribute('aria-label', desc.title || 'One portion');
    card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closePortion(); stage.canvas.focus({ preventScroll: true }); } });
    const head = document.createElement('div'); head.className = 'rof-portion-head';
    const h = document.createElement('div'); h.className = 'rof-portion-title'; h.textContent = desc.title || 'One portion';
    const back = document.createElement('button'); back.type = 'button'; back.className = 'rof-tool-btn'; back.textContent = '← Back to tray';
    back.addEventListener('click', () => closePortion());
    head.append(h, back);
    card.appendChild(head);
    if (desc.subtitle) { const sub = document.createElement('div'); sub.className = 'rof-portion-sub'; sub.textContent = desc.subtitle; card.appendChild(sub); }
    if (desc.choices && desc.choices.length > 1) {
      const grp = document.createElement('div'); grp.className = 'rof-portion-choices'; grp.setAttribute('role', 'group'); grp.setAttribute('aria-label', 'Which portion');
      for (const c of desc.choices) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'rof-tool-btn'; b.textContent = c.label;
        b.setAttribute('aria-pressed', String(c.key === desc.chosen));
        b.addEventListener('click', () => desc.onChoose?.(c.key));
        grp.appendChild(b);
      }
      card.appendChild(grp);
    }
    const list = document.createElement('div'); list.className = 'rof-portion-rows';
    for (const r of desc.rows || []) {
      const row = document.createElement('div'); row.className = 'rof-portion-row';
      const dt = document.createElement('span'); dt.className = 'rof-portion-k'; dt.textContent = r.label;
      const dd = document.createElement('span'); dd.className = 'rof-portion-v'; dd.textContent = r.value;
      if (r.est) { const e = document.createElement('span'); e.className = 'rof-est'; e.textContent = ' est.'; e.title = 'Estimated from the ingredients (the rise model), not measured'; dd.appendChild(e); }
      row.append(dt, dd); list.appendChild(row);
    }
    card.appendChild(list);
    if (desc.tray) {
      const t = document.createElement('div'); t.className = 'rof-portion-tray';
      t.textContent = `Tray: ${desc.tray.name} · ${desc.tray.dims}${desc.tray.note ? ` · ${desc.tray.note}` : ''}`;
      card.appendChild(t);
    }
    if (desc.footnote) { const f = document.createElement('div'); f.className = 'rof-portion-foot'; f.textContent = desc.footnote; card.appendChild(f); }
    return card;
  }
  const bakeFor = (d) => clamp((DONENESS[d.doneness] ?? DONENESS.golden) * (SHAPE_K[d.kind === 'cut' ? 'sheet' : d.spec?.archetype] ?? 1) * (d.brownSpeed ?? 1), 0, 1);
  function openPortion(desc, { capture = false } = {}) {
    if (!tray) return false;
    if (portion) closePortion({ quiet: true });
    disarmCutter();
    interaction.select(null);
    const model = createPortionModel({ surfaces, desc: { ...desc, bake: bakeFor(desc) } });
    // Hide what is on the stage (lights and the floor stay), then add the showcase.
    const saved = [], keep = new Set([floor, stage.key.target]);
    stage.scene.children.forEach(c => { if (c.isLight || keep.has(c)) return; saved.push([c, c.visible]); c.visible = false; });
    stage.scene.add(model.group);
    portion = { desc, model, saved, prev: { view: stage.getView(), interactive: interaction.isEnabled() }, card: null, cv: null };
    interaction.setEnabled(false);
    setStageToolsHidden(true);
    updateInset();
    if (!capture) {
      portion.card = buildPortionCard(desc);
      portion.cv = document.createElement('canvas'); portion.cv.className = 'rof-portion-dims'; portion.cv.setAttribute('aria-hidden', 'true');
      container.append(portion.cv, portion.card);
    }
    stage.fit({ cx: 0, cy: 0, radius: model.radius, instant: true }); // no dolly-in: the framing below is measured at the final pose
    stage.setViewAngles({ yaw: (model.long ? 10 : 28) * Math.PI / 180, pitch: PORTION_VIEW.pitch }, { animate: false }); // a long piece is shown nearly face-on so it can be larger
    frameModel(capture);
    stage.requestRender();
    if (!capture) { announce(desc.speech || `${desc.title || 'One portion'}.`); emit('portion', { open: true }); }
    return true;
  }
  function closePortion({ quiet = false } = {}) {
    if (!portion) return false;
    const p = portion; portion = null;
    stage.scene.remove(p.model.group); p.model.dispose();
    p.saved.forEach(([c, v]) => { c.visible = v; });
    p.card?.remove(); p.cv?.remove();
    stage.setContentShift(0);
    setStageToolsHidden(false);
    interaction.setEnabled(p.prev.interactive);
    if (tray) fitToStage({ instant: true });
    stage.setViewAngles(p.prev.view, { animate: false });
    updateInset();
    stage.requestRender();
    if (!quiet) { announce('Back to the tray.'); }
    emit('portion', { open: false });
    return true;
  }

  // Zoom and slide the camera so everything the model lists (board, piece, dimension lines and their labels) fits in
  // the free part of the stage: between the view buttons and the card, or the whole canvas for a capture. Measured
  // by projecting those points, so any size of portion -- a 3 cm biscuit or a 50 cm baguette -- fits.
  function frameModel(capture) {
    const p = portion, W = container.clientWidth, H = container.clientHeight;
    if (!p || !W || !H) return;
    // A capture is framed into a wide band (CAPTURE_ASPECT) in the middle of the canvas and cropped to it afterwards.
    const band = Math.min(H - 32, W / CAPTURE_ASPECT), bandTop = (H - band) / 2;
    const side = 14, top = capture ? bandTop + 10 : 54, bottom = capture ? bandTop + band - 10 : H - p.card.offsetHeight - 20;
    const pad = (pt) => { const q = project(pt, stage.camera, W, H); return [[q.x, q.y], [q.x - 92, q.y - 15], [q.x + 92, q.y + 15]]; };
    const bbox = () => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      const add = ([x, y]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
      p.model.framePoints.forEach(pt => { const q = project(pt, stage.camera, W, H); add([q.x, q.y]); });
      p.model.dims.forEach(d => { const mid = d.a.clone().add(d.b).multiplyScalar(0.5); pad(mid).forEach(add); });
      return { x0, x1, y0, y1 };
    };
    let zoom = 1;
    for (let i = 0; i < 6; i++) {
      stage.setContentShift(0, 0); stage.setView({ zoom });
      const b = bbox(), s = Math.max((b.x1 - b.x0) / (W - 2 * side), (b.y1 - b.y0) / Math.max(40, bottom - top));
      if (i > 0 && Math.abs(s - 1) < 0.015) break;
      zoom = clamp(zoom * s, 0.05, 3);
    }
    const b = bbox();
    stage.setContentShift((b.y0 + b.y1) / 2 - (top + bottom) / 2, (b.x0 + b.x1) / 2 - W / 2);
    p.framed = { W, H };
  }
  const drawPortionDims = () => {
    if (!portion) return;
    if (portion.cv && (portion.framed?.W !== container.clientWidth || portion.framed?.H !== container.clientHeight)) frameModel(false); // the stage was resized
    const W = container.clientWidth, H = container.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 2), cv = portion.cv;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawDims(ctx, W, H, portion.model.dims, stage.camera, 1);
  };
  stage.addFrameHook(drawPortionDims);
  // A PNG of the portion with its dimension lines drawn on, for the PDF. Works whether or not the view is open.
  function capturePortion(desc, { maxWidth = 1400 } = {}) {
    if (!desc) return null;
    const wasOpen = !!portion, prevDesc = wasOpen ? portion.desc : null;
    const same = wasOpen && portion.desc === desc;
    if (!same && !openPortion(desc, { capture: true })) return null;
    try {
      stage.renderNow();
      const w = stage.canvas.width, h = stage.canvas.height, k = Math.min(1, maxWidth / w);
      const full = document.createElement('canvas'); full.width = Math.round(w * k); full.height = Math.round(h * k);
      const fctx = full.getContext('2d');
      fctx.fillStyle = '#1d2a24'; fctx.fillRect(0, 0, full.width, full.height);
      fctx.drawImage(stage.canvas, 0, 0, full.width, full.height);
      const dims = document.createElement('canvas'); dims.width = full.width; dims.height = full.height;
      drawDims(dims.getContext('2d'), full.width, full.height, portion.model.dims, stage.camera, full.width / Math.max(1, container.clientWidth));
      fctx.drawImage(dims, 0, 0);
      // Crop to the band the model was framed into.
      const bandH = Math.round(Math.min(full.height - 32 * (full.height / h), full.width / CAPTURE_ASPECT)), y0 = Math.round((full.height - bandH) / 2);
      const out = document.createElement('canvas'); out.width = full.width; out.height = bandH;
      out.getContext('2d').drawImage(full, 0, y0, full.width, bandH, 0, 0, full.width, bandH);
      return { dataUrl: out.toDataURL('image/jpeg', 0.9), width: out.width, height: out.height };
    } finally {
      if (!same) { closePortion({ quiet: true }); if (prevDesc) openPortion(prevDesc); }
    }
  }

  // ---- Graphics setting ------------------------------------------------------------------------------
  // Auto (default): start from what the GPU suggests and let the frame-rate governor step down if it can't hold
  // ~38 fps. Or fix High / Medium / Low. The choice is a personal, per-device preference (localStorage).
  const QUALITY_KEY = 'rofGameQuality';
  const QUALITY_LABEL = { auto: 'Auto', high: 'High', medium: 'Medium', low: 'Low' };
  let qualityBox = null, noticeEl = null, noticeTimer = null;
  function readQuality() { try { const q = localStorage.getItem(QUALITY_KEY); return QUALITY_LABEL[q] ? q : 'auto'; } catch { return 'auto'; } }
  function showNotice(text) {
    if (!noticeEl) {
      noticeEl = document.createElement('div');
      noticeEl.setAttribute('role', 'status');
      noticeEl.style.cssText = 'position:absolute;left:50%;bottom:44px;transform:translateX(-50%);padding:6px 14px;border-radius:999px;background:rgba(15,28,22,.82);color:#e6eee6;font:12.5px system-ui,sans-serif;pointer-events:none;transition:opacity .4s;';
      container.appendChild(noticeEl);
    }
    noticeEl.textContent = text; noticeEl.style.opacity = '1';
    clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { if (noticeEl) noticeEl.style.opacity = '0'; }, 4500);
  }
  function buildQualityControl() {
    qualityBox = document.createElement('label');
    qualityBox.style.cssText = 'position:absolute;right:10px;bottom:10px;display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:8px;background:rgba(15,28,22,.72);color:#e6eee6;font:11.5px system-ui,sans-serif;';
    qualityBox.textContent = 'Graphics';
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Graphics quality');
    sel.style.cssText = 'font:inherit;color:#0f1c16;background:#e6eee6;border:0;border-radius:5px;padding:1px 4px;';
    Object.entries(QUALITY_LABEL).forEach(([k, v]) => { const o = document.createElement('option'); o.value = k; o.textContent = v; sel.appendChild(o); });
    sel.value = readQuality();
    sel.addEventListener('change', () => {
      try { localStorage.setItem(QUALITY_KEY, sel.value); } catch { /* not persisted */ }
      stage.setQuality(sel.value);
      showNotice(`Graphics: ${QUALITY_LABEL[sel.value]}${sel.value === 'auto' ? ` (${stage.tier.name})` : ''}`);
    });
    qualityBox.appendChild(sel);
    container.appendChild(qualityBox);
  }
  stage.onTierChange = (name) => { showNotice(`Graphics lowered to ${name} to keep things smooth. You can change this under Graphics.`); emit('quality', { tier: name, auto: true }); };
  stage.setQuality(readQuality());
  buildQualityControl();

  const api = {
    setTray, clearTray, addCutter, addDough, setDoughState, showLookdev, removeItem, clearItems, on,
    beginPlacement, endPlacement, autoArrange, returnAllToBench, playBake, resetBake, setInteractive,
    beginSheet, endSheet, armCutter, disarmCutter, setCutters, autoArrangeCutters, planCutters, clearCutters, setKnifeGrid, setKnifeSolid, setFillLayers, getFills, setScrapHighlight, setSheetGrams,
    getScrap: scrapSummary,
    getCutters: () => allCuts().map(describeCutter),
    getSheet: () => sheet && { topY: sheet.topY(), thicknessCm: sheet.thicknessCm, rise: sheet.rise, bake: sheet.bake },
    setSfx: (fns) => Object.assign(sfx, fns),
    showPortion: openPortion, hidePortion: closePortion, capturePortion, isPortionOpen: () => !!portion, getPortion: () => portion?.desc || null,
    getView: () => stage.getView(),
    setViewPreset: (name) => stage.setViewAngles(stage.VIEWS[name]),
    announce,
    focusStage: () => stage.canvas.focus({ preventScroll: true }),
    getBench: () => bench && { cx: bench.cx, cy: bench.cy, hw: bench.hw, hh: bench.hh },
    getPlacement: () => { const all = doughItems(); return { placed: all.filter(i => i.home === 'tray').length, total: all.length }; },
    setView: (v) => stage.setView(v),
    getItems: () => items.map(describe),
    resize: () => stage.resize(),
    setTier: (name) => stage.setTier(name),
    setQuality: (q) => stage.setQuality(q),
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
  stage.onDispose(() => { portion?.card?.remove(); portion?.cv?.remove(); viewBox?.remove(); insetFrame?.remove(); clearTimeout(scrapTimer); flagLayer?.remove(); scrapRow?.remove(); tipEl?.remove(); clearTimeout(liveTimer); liveEl.remove(); hintEl.remove(); clearTimeout(noticeTimer); qualityBox?.remove(); noticeEl?.remove(); stage.canvas.removeEventListener('pointermove', moveGhost); stage.canvas.removeEventListener('pointerleave', onGhostLeave); stage.canvas.removeEventListener('keydown', onGhostKey); clearInterval(statsTimer); interaction.dispose(); surfaces.dispose(); hud?.remove(); lookdevPanel?.remove(); });
  return api;
}
