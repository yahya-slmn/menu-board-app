// Quality tiers for the Recipe on Fire game view. The tier is picked from the GPU the browser
// reports (Apple Silicon / discrete GPUs get the full treatment, Intel integrated graphics start
// one notch lower), and FrameGovernor steps it down further at runtime if the measured frame rate
// can't hold -- so a slow machine degrades gracefully instead of stuttering.

export const TIERS = {
  high:   { name: 'high',   dprCap: 2,   shadowMap: 2048, msaa: true,  ao: true,  aoSamples: 16, bloom: true,  particles: 1.0 },
  medium: { name: 'medium', dprCap: 1.5, shadowMap: 1024, msaa: true,  ao: true,  aoSamples: 8,  bloom: true,  particles: 0.6 },
  low:    { name: 'low',    dprCap: 1,   shadowMap: 512,  msaa: false, ao: false, aoSamples: 0,  bloom: false, particles: 0.3 },
};
const TIER_ORDER = ['high', 'medium', 'low'];

// Reads the unmasked GPU string from a throwaway WebGL context, since the real renderer's
// antialiasing choice has to be made before its context exists.
export function probeGpu() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  let raw = '';
  if (gl) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    raw = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  let family = 'unknown';
  if (/Apple (M\d|GPU)/i.test(raw)) family = 'apple-silicon';
  else if (/Intel/i.test(raw)) family = 'intel';
  else if (/AMD|Radeon|NVIDIA|GeForce/i.test(raw)) family = 'discrete';
  const tierName = family === 'apple-silicon' || family === 'discrete' ? 'high' : 'medium';
  return { raw, family, webgl: gl ? (canvas.getContext('webgl2') ? 2 : 1) : 0, tierName };
}

export function lowerTier(name) {
  const i = TIER_ORDER.indexOf(name);
  return i >= 0 && i < TIER_ORDER.length - 1 ? TIER_ORDER[i + 1] : null;
}

// Watches frame times during active rendering (idle frames aren't sampled -- the loop stops when
// nothing is animating) and asks for a lower tier when a full window of samples averages below
// ~38 fps. One step at a time, with a cooldown, so a single hitch (a texture upload, a GC pause)
// never triggers a downgrade by itself.
export class FrameGovernor {
  constructor(onDegrade, { window = 90, minFps = 38, cooldownFrames = 120 } = {}) {
    this.onDegrade = onDegrade;
    this.window = window;
    this.minDt = 1 / minFps;
    this.cooldown = cooldownFrames;
    this.samples = [];
    this.sinceChange = cooldownFrames;
    this.fps = 0;
  }
  sample(dt) {
    if (dt <= 0 || dt > 0.25) return; // tab was hidden / first frame -- not a real frame time
    this.samples.push(dt);
    this.sinceChange++;
    if (this.samples.length > this.window) this.samples.shift();
    const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    this.fps = 1 / avg;
    if (this.samples.length === this.window && this.sinceChange >= this.cooldown && avg > this.minDt) {
      this.sinceChange = 0;
      this.samples.length = 0;
      this.onDegrade();
    }
  }
  reset() { this.samples.length = 0; }
}
