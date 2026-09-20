import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { TIERS, probeGpu, lowerTier, FrameGovernor } from './quality.js';
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

  // ---- camera rig: fixed pitch, distance fitted to the tray, wheel zoom only (no orbit) --------
  const rig = { target: new THREE.Vector3(), radius: 30, zoom: 1, zoomTarget: 1, intro: 1, introStart: 0, introDur: 0.7, pitchOff: 0, lift: 0 };
  function cameraDistance() {
    const vHalf = THREE.MathUtils.degToRad(FOV) / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
    // Tilted view compresses the bench's depth, so the horizontal extent is what limits fit.
    return (rig.radius * 1.12) / Math.tan(Math.min(vHalf * 1.15, hHalf));
  }
  function placeCamera() {
    const dist = cameraDistance() * rig.zoom * (1 + 0.22 * (1 - easeOutCubic(rig.intro)));
    const pitch = PITCH + rig.pitchOff + 0.16 * (1 - easeOutCubic(rig.intro));
    camera.position.set(
      rig.target.x,
      rig.target.y + rig.lift + Math.sin(pitch) * dist,
      rig.target.z + Math.cos(pitch) * dist,
    );
    camera.lookAt(rig.target);
    camera.updateMatrixWorld();
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
    rig.intro = 0; rig.introStart = performance.now();
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
    if (Math.abs(rig.zoom - rig.zoomTarget) > 0.0005) {
      rig.zoom += (rig.zoomTarget - rig.zoom) * (1 - Math.exp(-14 * dt));
      active = true;
    }
    if (active || dirty) placeCamera();
    if (post) post.render(dt); else renderer.render(scene, camera);
    dirty = false;

    // A ticker may itself have called requestRender() this frame (which already scheduled the next
    // one) -- only schedule if nothing is pending, or callbacks double every frame.
    if (active) { governor.sample(rawDt); if (!raf) raf = requestAnimationFrame(frame); }
    else { last = 0; governor.reset(); }
  }
  function requestRender() {
    dirty = true;
    if (!raf && !disposed) raf = requestAnimationFrame(frame);
  }
  // A ticker runs every frame until it returns false; keeps the loop alive while it does.
  function animate(fn) { tickers.add(fn); requestRender(); return () => tickers.delete(fn); }

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
