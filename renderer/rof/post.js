import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Post-processing chain: scene -> ground-truth ambient occlusion -> bloom -> oven grade -> tone mapping.
// AO is what gives contact depth (muffin wells, the tray floor along its walls, dough meeting the
// tray) that plain lights can't. Bloom slots in here later for the oven glow. Only built for tiers
// that ask for it; the low tier renders straight to the canvas.

export function createPost({ renderer, scene, camera, tier }) {
  const size = renderer.getSize(new THREE.Vector2());
  const pr = renderer.getPixelRatio();
  const target = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, {
    type: THREE.HalfFloatType,
    samples: tier.msaa ? 4 : 0,
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(pr);
  composer.setSize(size.x, size.y);
  composer.addPass(new RenderPass(scene, camera));

  const gtao = new GTAOPass(scene, camera, size.x, size.y);
  gtao.output = GTAOPass.OUTPUT.Default;
  // Scene units are centimetres, so the radius is "how far around a point occluders count".
  gtao.updateGtaoMaterial({ radius: 3.2, distanceExponent: 1.3, thickness: 1.4, scale: 2.0, samples: tier.aoSamples, distanceFallOff: 1.0, screenSpaceRadius: false });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 7, rings: 2, samples: tier.aoSamples });
  gtao.blendIntensity = 1.0;
  // Flat overlays drawn on the tray (selection outlines) must not take part in AO: rendered into the
  // AO depth/normal pass they look like solid sheets a hair above the floor and black out the
  // floor beneath them. Hidden for that pass only -- they still appear in the beauty render.
  const gtaoRender = gtao.render.bind(gtao);
  gtao.render = (...args) => {
    const hidden = [];
    scene.traverse((o) => { if (o.userData.noAO && o.visible) { o.visible = false; hidden.push(o); } });
    gtaoRender(...args);
    hidden.forEach(o => { o.visible = true; });
  };
  composer.addPass(gtao);

  // Bloom + oven grade are only active while baking (strength/heat 0 = pass disabled, so an idle tray
  // pays nothing for them). The grade pass adds heat shimmer near the top of the frame, a vignette
  // and a warm tint; it runs in linear HDR, before tone mapping.
  let bloom = null, oven = null;
  if (tier.bloom) {
    bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0, 0.5, 0.94);
    bloom.enabled = false;
    composer.addPass(bloom);
    oven = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, uHeat: { value: 0 }, uTime: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform float uHeat, uTime; varying vec2 vUv;
        void main() {
          vec2 uv = vUv;
          float band = smoothstep(0.1, 1.0, uv.y);
          uv.x += (sin(uv.y * 38.0 + uTime * 2.6) * 0.0016 + sin(uv.y * 91.0 - uTime * 4.1) * 0.0008) * uHeat * band;
          vec4 c = texture2D(tDiffuse, uv);
          vec2 d = (vUv - 0.5) * vec2(1.0, 1.1);
          float vig = smoothstep(0.92, 0.28, length(d));
          c.rgb *= mix(1.0, mix(0.5, 1.0, vig), uHeat);
          c.rgb *= mix(vec3(1.0), vec3(1.10, 0.97, 0.80), uHeat * 0.55);
          gl_FragColor = c;
        }`,
    });
    oven.enabled = false;
    composer.addPass(oven);
  }

  composer.addPass(new OutputPass());

  return {
    composer, gtao,
    render(dt) { composer.render(dt); },
    // strength 0..~0.7 and heat 0..1; anything at 0 switches its pass off entirely.
    setOvenFx({ bloom: bloomStrength = 0, heat = 0, time = 0 } = {}) {
      if (bloom) { bloom.strength = bloomStrength; bloom.enabled = bloomStrength > 0.002; }
      if (oven) { oven.uniforms.uHeat.value = heat; oven.uniforms.uTime.value = time; oven.enabled = heat > 0.002; }
    },
    setSize(w, h) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); bloom?.setSize(w, h); },
    dispose() { composer.dispose?.(); target.dispose(); gtao.dispose?.(); },
  };
}
