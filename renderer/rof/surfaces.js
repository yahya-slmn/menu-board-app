import * as THREE from 'three';

// Procedural surface textures -- generated once on canvases at startup, so the game needs no image
// files at all (same "nothing to license or bundle" approach as the app's synthesized sound).

function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const wrap = (i, p) => ((i % p) + p) % p;
// Value noise whose lattice wraps every px x py cells, so a texture built from it tiles seamlessly.
function valueNoise(x, y, seed, px, py) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
  const x0 = wrap(xi, px), x1 = wrap(xi + 1, px), y0 = wrap(yi, py), y1 = wrap(yi + 1, py);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed), c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
// u, v in 0..1 across the texture; `cells` lattice cells across at the first octave.
function fbm(u, v, seed, cells, octaves = 4) {
  let sum = 0, amp = 0.5, f = cells;
  for (let i = 0; i < octaves; i++) { sum += valueNoise(u * f, v * f, seed + i * 17, f, f) * amp; f *= 2; amp *= 0.5; }
  return sum;
}

function canvasTexture(size, paint, { srgb = false, repeat = 1 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  paint(img.data, size);
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// Brushed metal: roughness varies in fine streaks along one axis (the G channel is what
// MeshStandardMaterial reads for roughness), with a little large-scale mottling so big flat
// surfaces don't read as a uniform CG grey.
function brushedRoughness(base, streak) {
  return canvasTexture(512, (d, s) => {
    for (let y = 0; y < s; y++) {
      const v = y / s;
      const row = valueNoise(0, v * 256, 3, 1, 256);
      for (let x = 0; x < s; x++) {
        const u = x / s;
        const fine = valueNoise(u * 12, v * 220, 11, 12, 220);
        const blotch = fbm(u, v, 5, 6, 3);
        const val = base + (row - 0.5) * streak + (fine - 0.5) * streak * 0.8 + (blotch - 0.5) * 0.04;
        const c = Math.max(0, Math.min(1, val)) * 255;
        const i = (y * s + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = c; d[i + 3] = 255;
      }
    }
  }, { repeat: 1 });
}

export function createSurfaces() {
  const steel = new THREE.MeshStandardMaterial({
    color: 0xd6dadd, metalness: 1, roughness: 1, roughnessMap: brushedRoughness(0.36, 0.028),
    envMapIntensity: 1.1, side: THREE.DoubleSide,
  });
  // Muffin wells / non-stick pans read darker than the polished rim.
  const steelDark = new THREE.MeshStandardMaterial({
    color: 0x4b5157, metalness: 0.9, roughness: 1, roughnessMap: brushedRoughness(0.5, 0.03),
    envMapIntensity: 0.9, side: THREE.DoubleSide,
  });
  // Cutters are polished stainless -- brighter and glossier than the trays.
  const cutterSteel = new THREE.MeshStandardMaterial({
    color: 0xe4e8eb, metalness: 1, roughness: 1, roughnessMap: brushedRoughness(0.24, 0.025),
    envMapIntensity: 1.25, side: THREE.DoubleSide,
  });
  const benchColor = canvasTexture(512, (d, s) => {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const u = x / s, v = y / s;
      const n = fbm(u, v, 21, 8, 4);
      const fine = valueNoise(u * 96, v * 96, 9, 96, 96) * 0.5;
      const val = 0.78 + (n - 0.5) * 0.32 + (fine - 0.25) * 0.06;
      const i = (y * s + x) * 4;
      d[i] = 62 * val; d[i + 1] = 86 * val; d[i + 2] = 76 * val; d[i + 3] = 255;
    }
  }, { srgb: true, repeat: 6 });
  const bench = new THREE.MeshStandardMaterial({ color: 0xffffff, map: benchColor, roughness: 0.82, metalness: 0.02 });

  // Maple board: fine grain lines running along x, faint growth rings, very little large-scale
  // blotching (too much reads as marble, not wood).
  const woodColor = canvasTexture(512, (d, s) => {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const u = x / s, v = y / s;
      const warp = fbm(u, v, 33, 2, 2) * 0.10;
      const fine = valueNoise(u * 3, (v + warp) * 160, 41, 3, 160);
      const coarse = valueNoise(u * 2, (v + warp) * 34, 47, 2, 34);
      const blotch = fbm(u, v, 45, 3, 2);
      const val = 0.9 + (fine - 0.5) * 0.20 + (coarse - 0.5) * 0.14 + (blotch - 0.5) * 0.07;
      const i = (y * s + x) * 4;
      d[i] = 212 * val; d[i + 1] = 172 * val; d[i + 2] = 120 * val; d[i + 3] = 255;
    }
  }, { srgb: true, repeat: 1 });
  const wood = new THREE.MeshStandardMaterial({ color: 0xffffff, map: woodColor, roughness: 0.66, metalness: 0 });

  return {
    steel, steelDark, cutterSteel, bench, wood,
    dispose() { [steel, steelDark, cutterSteel, bench, wood].forEach(m => { m.roughnessMap?.dispose(); m.map?.dispose(); m.dispose(); }); },
  };
}
