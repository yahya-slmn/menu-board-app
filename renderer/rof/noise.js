// Small deterministic value noise for building organic-looking geometry (not tileable -- see
// surfaces.js for the tileable texture version). Seeded so a given piece always comes out the same.

function hash(x, y, seed) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
export function noise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed), c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
// 0..1, `octaves` layers each twice the frequency and half the weight.
export function fbm2(x, y, seed = 0, octaves = 3) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < octaves; i++) { sum += noise2(x, y, seed + i * 31) * amp; norm += amp; x *= 2.03; y *= 2.03; amp *= 0.5; }
  return sum / norm;
}
// Cheap seeded PRNG (mulberry32) for per-piece random choices.
export function rng(seed) {
  let a = seed | 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// A size x size tileable value-noise field as 8-bit data (0..255), with `cells` lattice cells across and a
// smooth (smoothstep) interpolation between them -- so bilinear sampling of the texture reproduces the
// look of per-pixel value noise at 1 lattice cell = size/cells texels, for a fraction of the cost. Used by
// the dough shader, which used to evaluate ~160 hashed noise lattices per pixel.
export function tileableNoiseData(size = 256, cells = 32, seed = 5) {
  const data = new Uint8Array(size * size);
  const wrap = (i) => ((i % cells) + cells) % cells;
  for (let y = 0; y < size; y++) {
    const v = (y / size) * cells, yi = Math.floor(v), yf = v - yi, sy = yf * yf * (3 - 2 * yf);
    for (let x = 0; x < size; x++) {
      const u = (x / size) * cells, xi = Math.floor(u), xf = u - xi, sx = xf * xf * (3 - 2 * xf);
      const a = hash(wrap(xi), wrap(yi), seed), b = hash(wrap(xi + 1), wrap(yi), seed);
      const c = hash(wrap(xi), wrap(yi + 1), seed), d = hash(wrap(xi + 1), wrap(yi + 1), seed);
      data[y * size + x] = Math.round((a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * 255);
    }
  }
  return data;
}
