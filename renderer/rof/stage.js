import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { TIERS, probeGpu, lowerTier, FrameGovernor, prefersReducedMotion } from './quality.js';
import { createPost } from './post.js';

// The stage owns the renderer, the fixed "game" camera, the lights and the bench the tray sits on,
// plus a render loop that only runs while something is animating or was just changed -- an idle
// tray costs no GPU. World units are centimetres; plan (x, y) maps to world (x, height, -y), so
// "up the page" in plan view is away from the camera, matching the rest of Recipe on Fire.

const PITCH = THREE.MathUtils.degToRad(58);   // camera elevation above the bench
const FOV = 30;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

export function createStage(container, { tier: forcedTier } = {}) {
  const gpu = probeGpu();
  let tier = TIERS[forcedTier] || TIERS[gpu.tierName];

  // Context-level antialiasing only matters when rendering straight to the canvas; skip it on a dense display
  // (and the post-processing path renders offscreen anyway -- see post.js).
  const renderer = new THREE.WebGLRenderer({ antialias: tier.msaa && (window.devicePixelRatio || 1) < 1.75, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.style.touchAction = 'none';
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const BG = 0x15221d;
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 90, 260);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // Near/far kept tight: the AO pass linearises depth between them, so a wide range costs precision.
  const camera = new THREE.PerspectiveCamera(FOV, 1, 8, 420);

  // Warm key with soft shadows, a cool back rim so metal edges pop, and a dim hemisphere fill.
  const hemi = new THREE.HemisphereLight(0xfff2e2, 0x22332c, 0.55);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffefd6, 2.6);
  key.castShadow = true;
  key.shadow.bias = -0.0003;
  key.shadow.normalBias = 0.13;
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0xbfd9ff, 0.7);
  const base = { key: key.color.clone(), keyI: 2.6, hemiSky: hemi.color.clone(), hemiGround: hemi.groundColor.clone(), hemiI: 0.55, rim: rim.color.clone(), rimI: 0.7, bg: new THREE.Color(BG), exposure: 1.05 };
  const oven = { key: new THREE.Color(0xffa552), hemiSky: new THREE.Color(0xff9a58), hemiGround: new THREE.Color(0x3a1c0a), rim: new THREE.Color(0xff7a2a), bg: new THREE.Color(0x2b1408) };
  rim.position.set(-30, 26, -40);
  scene.add(rim);

  // ---- camera rig: distance fitted to the tray, wheel zoom, and a turnable view ---------------------------
  // yaw (0 = looking from the front, + swings the camera to the right) and pitch (elevation) are changed only on
  // purpose -- a preset, Q / E, or right-drag -- never as a side effect of dragging a piece. See game.js: a piece
  // stays where it is in the world when the view turns, and the grab offset is re-anchored so nothing jumps.
  const DEG = Math.PI / 180;
  const PITCH_MIN = 14 * DEG, PITCH_MAX = 89 * DEG;
  const VIEWS = {
    top:      { label: 'Top',       yaw: 0,        pitch: 89 * DEG },
    angled:   { label: 'Angled',    yaw: 0,        pitch: PITCH },
    lowFront: { label: 'Low front', yaw: 0,        pitch: 26 * DEG },
    lowSide:  { label: 'Low side',  yaw: 90 * DEG, pitch: 26 * DEG },
  };
  const rig = { target: new THREE.Vector3(), radius: 30, zoom: 1, zoomTarget: 1, intro: 1, introStart: 0, introDur: 0.7, pitchOff: 0, lift: 0, yaw: 0, pitch: PITCH };
  const camListeners = new Set();
  let lastPose = '';
  function cameraDistance() {
    const vHalf = THREE.MathUtils.degToRad(FOV) / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
    // Tilted view compresses the bench's depth, so the horizontal extent is what limits fit.
    return (rig.radius * 1.12) / Math.tan(Math.min(vHalf * 1.15, hHalf));
  }
  function placeCamera() {
    const dist = cameraDistance() * rig.zoom * (1 + 0.22 * (1 - easeOutCubic(rig.intro)));
    const pitch = rig.pitch + rig.pitchOff + 0.16 * (1 - easeOutCubic(rig.intro));
    camera.position.set(
      rig.target.x + Math.sin(rig.yaw) * Math.cos(pitch) * dist,
      rig.target.y + rig.lift + Math.sin(pitch) * dist,
      rig.target.z + Math.cos(rig.yaw) * Math.cos(pitch) * dist,
    );
    camera.lookAt(rig.target);
    camera.updateMatrixWorld();
    const pose = `${rig.yaw.toFixed(4)}|${rig.pitch.toFixed(4)}|${rig.zoom.toFixed(4)}`;
    if (pose !== lastPose) { lastPose = pose; camListeners.forEach(fn => fn()); }
  }
  const wrapAngle = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
  function viewName() {
    for (const [k, v] of Object.entries(VIEWS)) if (Math.abs(wrapAngle(rig.yaw - v.yaw)) < 0.02 && Math.abs(rig.pitch - v.pitch) < 0.02) return k;
    return null;
  }
  // Turn the view. `animate` glides there (a preset); an instant change is a drag or a key press.
  let viewTween = null;
  function setViewAngles({ yaw, pitch }, { animate = true } = {}) {
    if (viewTween) { viewTween(); viewTween = null; }
    const y1 = yaw ?? rig.yaw, p1 = THREE.MathUtils.clamp(pitch ?? rig.pitch, PITCH_MIN, PITCH_MAX);
    if (!animate || prefersReducedMotion()) { rig.yaw = wrapAngle(y1); rig.pitch = p1; placeCamera(); requestRender(); return; }
    const y0 = rig.yaw, dy = wrapAngle(y1 - y0), p0 = rig.pitch, t0 = performance.now(), dur = 480;
    viewTween = animate_((dt, now) => {
      const t = Math.min(1, (performance.now() - t0) / dur), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      rig.yaw = wrapAngle(y0 + dy * e); rig.pitch = p0 + (p1 - p0) * e;
      return t < 1;
    });
  }
  function orbitBy(dYaw, dPitch = 0) {
    if (viewTween) { viewTween(); viewTween = null; }
    rig.yaw = wrapAngle(rig.yaw + dYaw);
    rig.pitch = THREE.MathUtils.clamp(rig.pitch + dPitch, PITCH_MIN, PITCH_MAX);
    placeCamera(); requestRender();
  }
  function fit({ cx, cy, radius }) {
    rig.target.set(cx, 0, -cy);
    rig.radius = Math.max(radius, 4);
    // Key light follows the tray so its shadow map covers exactly the tray -- sharper shadows.
    key.position.set(cx - 0.45 * rig.radius * 3, rig.radius * 3.2, -cy + 0.55 * rig.radius * 3);
    key.target.position.set(cx, 0, -cy);
    const s = rig.radius * 1.5;
    Object.assign(key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: rig.radius * 12 });
    key.shadow.camera.updateProjectionMatrix();
    rig.zoom = rig.zoomTarget = 1;
    rig.intro = prefersReducedMotion() ? 1 : 0; rig.introStart = performance.now();
    placeCamera();
    requestRender();
  }

  let post = null;
  // Shift where the camera looks (plan cm) and how far it stands back (1 = fitted to the tray).
  function setView({ x, y, zoom, pitch, lift } = {}) {
    if (pitch !== undefined) rig.pitchOff = pitch;
    if (lift !== undefined) rig.lift = lift;
    if (x !== undefined) rig.target.x = x;
    if (y !== undefined) rig.target.z = -y;
    if (zoom !== undefined) rig.zoom = rig.zoomTarget = zoom;
    placeCamera();
    requestRender();
  }

  // The oven look: 0 = the normal bench, 1 = fully lit by the oven (warm light, dark amber surroundings,
  // bloom and heat shimmer). Driven by the bake director each frame.
  let ovenTime = 0, ovenT = 0;
  function setOvenLook(t, dt = 0) {
    t = ovenT = THREE.MathUtils.clamp(t, 0, 1);
    ovenTime += dt;
    key.color.copy(base.key).lerp(oven.key, t); key.intensity = THREE.MathUtils.lerp(base.keyI, 1.7, t);
    hemi.color.copy(base.hemiSky).lerp(oven.hemiSky, t); hemi.groundColor.copy(base.hemiGround).lerp(oven.hemiGround, t);
    hemi.intensity = THREE.MathUtils.lerp(base.hemiI, 0.6, t);
    rim.color.copy(base.rim).lerp(oven.rim, t); rim.intensity = THREE.MathUtils.lerp(base.rimI, 1.1, t);
    scene.background.copy(base.bg).lerp(oven.bg, t); scene.fog.color.copy(scene.background);
    renderer.toneMappingExposure = THREE.MathUtils.lerp(base.exposure, 1.05, t);
    post?.setOvenFx({ bloom: 0.36 * t, heat: t, time: ovenTime });
    requestRender();
  }

  // The ratio to render at: the display's, capped by the tier, then scaled down further if the drawing buffer
  // would exceed the tier's pixel budget (a maximized window on a big display).
  function effectivePixelRatio() {
    let pr = Math.min(window.devicePixelRatio || 1, tier.dprCap);
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    const px = w * h * pr * pr;
    if (px > tier.maxPixels) pr *= Math.sqrt(tier.maxPixels / px);
    return Math.max(0.75, pr);
  }

  function applyTier() {
    renderer.setPixelRatio(effectivePixelRatio());
    if (post) { post.dispose(); post = null; }
    if (tier.ao) post = createPost({ renderer, scene, camera, tier });
    if (post && ovenT > 0) post.setOvenFx({ bloom: 0.36 * ovenT, heat: ovenT, time: ovenTime });
    const size = tier.shadowMap;
    if (key.shadow.mapSize.x !== size) {
      key.shadow.mapSize.set(size, size);
      key.shadow.map?.dispose();
      key.shadow.map = null;
    }
    resize(true);
  }

  // ---- render loop (on demand) -----------------------------------------------------------------
  const tickers = new Set();
  let animate_ = null; // set once animate() exists (setViewAngles is defined above it)
  const frameHooks = new Set(); // called after every rendered frame
  let raf = 0, dirty = true, last = 0, disposed = false, hooks = [];
  let locked = false; // a fixed quality was chosen: the governor must not change it
  const governor = new FrameGovernor(() => {
    if (locked) return;
    const next = lowerTier(tier.name);
    if (!next) return;
    tier = TIERS[next];
    applyTier();
    api.onTierChange?.(next);
  });

  // ---- side-view inset ----------------------------------------------------------------------------------------
  // A second, ORTHOGRAPHIC render of the same scene into a corner of the same canvas, looking horizontally from the
  // side (perpendicular to the main view). Orthographic so heights and gaps read true -- you can see whether a lifted
  // piece clears its neighbours and how tall the dough stands -- without touching the main camera. Drawn straight to
  // the canvas after the main image (no AO / bloom), with the shadow map left alone and the fog off.
  let insetOn = false;
  // Where the strip looks and how wide it is (cm): the game points it at the tray, or at the piece being held.
  // Eased, so it glides rather than jumps.
  const iF = { x: 0, z: 0, half: 30, set: false }, iT = { x: 0, z: 0, half: 30 };
  function setInsetFocus(x, y, half) {                 // plan cm
    iT.x = x; iT.z = -y; iT.half = half;
    if (!iF.set) { Object.assign(iF, iT, { set: true }); }
    requestRender();
  }
  const insetCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 600);
  function insetRect() {
    const W = container.clientWidth, H = container.clientHeight;
    const w = THREE.MathUtils.clamp(W * 0.42, 200, 380), h = Math.round(w * 0.3);
    return { x: 10, y: H - h - 10, w: Math.round(w), h };      // css px, top-left origin (matches the DOM overlay)
  }
  function renderInset() {
    const r = insetRect(), W = container.clientWidth, H = container.clientHeight;
    const halfW = iF.half, halfH = halfW * (r.h / r.w);
    insetCam.left = -halfW; insetCam.right = halfW; insetCam.top = halfH; insetCam.bottom = -halfH;
    insetCam.updateProjectionMatrix();
    const yaw = rig.yaw + Math.PI / 2, cy = halfH * 0.72;           // the bench top sits near the bottom of the strip
    insetCam.position.set(iF.x + Math.sin(yaw) * 220, cy, iF.z + Math.cos(yaw) * 220);
    insetCam.lookAt(iF.x, cy, iF.z);
    insetCam.updateMatrixWorld();
    const fog = scene.fog, shadowAuto = renderer.shadowMap.autoUpdate, autoClear = renderer.autoClear;
    scene.fog = null; renderer.shadowMap.autoUpdate = false; renderer.autoClear = true;
    renderer.setScissorTest(true);
    renderer.setViewport(r.x, H - r.y - r.h, r.w, r.h);
    renderer.setScissor(r.x, H - r.y - r.h, r.w, r.h);
    renderer.render(scene, insetCam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
    scene.fog = fog; renderer.shadowMap.autoUpdate = shadowAuto; renderer.autoClear = autoClear;
  }

  function frame(now) {
    raf = 0;
    if (disposed) return;
    if (!container.isConnected) { api.dispose(); return; }
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    const rawDt = last ? (now - last) / 1000 : 0;
    last = now;

    let active = false;
    for (const fn of [...tickers]) {
      if (fn(dt, now / 1000) === false) tickers.delete(fn); else active = true;
    }
    if (rig.intro < 1) {
      rig.intro = Math.min(1, (now - rig.introStart) / 1000 / rig.introDur);
      active = true;
    }
    if (insetOn) {                                       // ease the side strip toward where it should look
      const k = 1 - Math.exp(-12 * dt);
      iF.x += (iT.x - iF.x) * k; iF.z += (iT.z - iF.z) * k; iF.half += (iT.half - iF.half) * k;
      if (Math.abs(iT.x - iF.x) + Math.abs(iT.z - iF.z) + Math.abs(iT.half - iF.half) > 0.05) active = true;
    }
    if (Math.abs(rig.zoom - rig.zoomTarget) > 0.0005) {
      rig.zoom += (rig.zoomTarget - rig.zoom) * (1 - Math.exp(-14 * dt));
      active = true;
    }
    if (active || dirty) placeCamera();
    if (post) post.render(dt); else renderer.render(scene, camera);
    if (insetOn) renderInset();
    dirty = false;

    // A ticker may itself have called requestRender() this frame (which already scheduled the next
    // one) -- only schedule if nothing is pending, or callbacks double every frame.
    for (const fn of frameHooks) fn(); // DOM overlays that follow the 3D scene (scrap flags)
    if (active) { governor.sample(rawDt); if (!raf) raf = requestAnimationFrame(frame); }
    else { last = 0; governor.reset(); }
  }
  function requestRender() {
    dirty = true;
    if (!raf && !disposed) raf = requestAnimationFrame(frame);
  }
  // A ticker runs every frame until it returns false; keeps the loop alive while it does.
  function animate(fn) { tickers.add(fn); requestRender(); return () => tickers.delete(fn); }
  animate_ = animate;

  function resize(force) {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    const pr = effectivePixelRatio();
    if (Math.abs(pr - renderer.getPixelRatio()) > 0.01) renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    post?.setSize(w, h);
    canvas.style.width = '100%'; canvas.style.height = '100%';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    placeCamera();
    requestRender();
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe(container);

  canvas.addEventListener('wheel', (e) => {
    if (api.wheelHook && api.wheelHook(e)) return; // e.g. rotating a held piece
    e.preventDefault();
    rig.zoomTarget = THREE.MathUtils.clamp(rig.zoomTarget * Math.exp(e.deltaY * 0.0012), 0.3, 1.5);
    requestRender();
  }, { passive: false });

  const api = {
    THREE, renderer, scene, camera, canvas, key, gpu,
    get tier() { return tier; },
    get fps() { return governor.fps; },
    fit, animate, requestRender, resize, setView, setOvenLook,
    VIEWS, viewName, setViewAngles, orbitBy, getView: () => ({ yaw: rig.yaw, pitch: rig.pitch, name: viewName() }),
    onCameraChange(fn) { camListeners.add(fn); return () => camListeners.delete(fn); },
    setInset(on) { insetOn = !!on; requestRender(); }, setInsetFocus, get insetOn() { return insetOn; }, getInsetRect: insetRect,
    addFrameHook(fn) { frameHooks.add(fn); return () => frameHooks.delete(fn); },
    get post() { return post; }, // exposed for tuning/tests
    setTier(name) { if (TIERS[name]) { tier = TIERS[name]; applyTier(); } },
    // 'auto' starts from what the GPU probe suggests and lets the governor step down; a tier name fixes it.
    setQuality(q) {
      locked = q !== 'auto';
      const name = q === 'auto' ? gpu.tierName : q;
      if (TIERS[name] && tier.name !== name) { tier = TIERS[name]; applyTier(); }
      governor.reset();
    },
    get locked() { return locked; },
    onTierChange: null,
    wheelHook: null,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      tickers.clear();
      post?.dispose();
      scene.traverse((o) => { o.geometry?.dispose?.(); });
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      hooks.forEach(fn => fn());
    },
    onDispose(fn) { hooks.push(fn); },
  };
  applyTier();
  return api;
}
