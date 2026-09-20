import * as THREE from 'three';

// The oven around the tray while baking: a slanted grill of glowing heating rods behind it, a warm
// glow on the back wall, two flickering heat lights above the tray, and steam rising off the dough.
// Everything is driven by two numbers from the bake director -- level (0..1: how "on" the oven is)
// and steam (0..1) -- and is invisible / costs nothing at 0. Plan (x, y) -> world (x, height, -y).

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 150, 6, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,150,60,0.95)');
  grad.addColorStop(0.45, 'rgba(255,100,30,0.45)');
  grad.addColorStop(1, 'rgba(255,80,20,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createOven({ scene, tier, plan, baseY = 0 }) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  const cx = (plan.minX + plan.maxX) / 2, width = plan.maxX - plan.minX;

  // Heating rods, receding behind the tray and rising -- reads as the oven's glowing roof from the
  // tilted camera without ever standing between the camera and the dough.
  const rodMat = new THREE.MeshStandardMaterial({ color: 0x241611, emissive: 0xff5418, emissiveIntensity: 0, roughness: 0.6 });
  const rodLen = Math.max(width * 1.7, 80);
  const rods = [];
  for (let i = 0; i < 6; i++) {
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, rodLen, 14), rodMat);
    rod.rotation.z = Math.PI / 2;
    rod.position.set(cx, 9 + i * 3.0, -(plan.maxY + 5 + i * 5.2));
    group.add(rod); rods.push(rod);
  }

  // Warm glow on the back wall.
  const glowMap = glowTexture();
  const wallMat = new THREE.MeshBasicMaterial({ map: glowMap, transparent: true, opacity: 0, depthWrite: false, fog: false });
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(width * 3.2, 130), wallMat);
  wall.position.set(cx, 38, -(plan.maxY + 62));
  group.add(wall);

  // Heat lights above the tray (intensity is in candela; the tray is ~25 cm below them). They live in
  // the scene permanently, at intensity 0 -- the number of lights is part of every lit material's
  // shader, so adding them mid-bake would recompile all of them (a visible ~1 s freeze).
  const lights = [-0.28, 0.28].map((k) => {
    const l = new THREE.PointLight(0xff8a3a, 0, 0, 2);
    l.position.set(cx + width * k, 27 + baseY, -((plan.minY + plan.maxY) / 2));
    scene.add(l);
    return l;
  });

  // Steam: soft sprites drifting up from the dough.
  const N = Math.max(30, Math.round(150 * tier.particles));
  const pos = new Float32Array(N * 3), size = new Float32Array(N), alpha = new Float32Array(N);
  const life = new Float32Array(N), speed = new Float32Array(N), sway = new Float32Array(N), home = new Float32Array(N * 2);
  const spawn = (i, phase) => {
    home[i * 2] = plan.minX + Math.random() * width;
    home[i * 2 + 1] = plan.minY + Math.random() * (plan.maxY - plan.minY);
    life[i] = phase; speed[i] = 3.5 + Math.random() * 4.5; sway[i] = Math.random() * 6.28;
  };
  for (let i = 0; i < N; i++) spawn(i, Math.random());
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  const steamMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uScale: { value: 400 } },
    vertexShader: `
      attribute float aSize, aAlpha; uniform float uScale; varying float vA;
      void main() {
        vA = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uScale / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.0, d); a *= a;
        gl_FragColor = vec4(vec3(0.97, 0.94, 0.9), a * vA);
      }`,
  });
  const steam = new THREE.Points(geo, steamMat);
  steam.frustumCulled = false;
  steam.renderOrder = 4;
  scene.add(steam);
  steam.visible = false;

  let level = 0, steamK = 0;
  return {
    setLevel(l) {
      level = l;
      group.visible = l > 0.003;
      rodMat.emissiveIntensity = 2.6 * l;
      wallMat.opacity = 0.8 * l;
      lights.forEach((li, i) => { li.intensity = l * 1250 * (i ? 0.92 : 1); });
    },
    setSteam(k) { steamK = k; steam.visible = k > 0.01; },
    // Called every frame: flicker the heat lights and move the steam. `viewH` = drawing-buffer height,
    // `fov` = the camera's vertical field of view in radians (steam sprites are sized in world units).
    update(dt, time, viewH, fov) {
      const flick = 1 + 0.07 * Math.sin(time * 17.0) + 0.05 * Math.sin(time * 29.0 + 1.3);
      lights.forEach((l, i) => { l.intensity = level * 1250 * flick * (i ? 0.92 : 1); });
      if (!steam.visible) return;
      steamMat.uniforms.uScale.value = viewH / (2 * Math.tan(fov / 2));
      for (let i = 0; i < N; i++) {
        life[i] += dt / 2.6;
        if (life[i] >= 1) spawn(i, 0);
        const u = life[i];
        pos[i * 3] = home[i * 2] + Math.sin(u * 5 + sway[i]) * 1.6;
        pos[i * 3 + 1] = baseY + 2.5 + u * speed[i] * 2.6;
        pos[i * 3 + 2] = -(home[i * 2 + 1]) + Math.cos(u * 4 + sway[i]) * 1.2;
        size[i] = 2.4 + u * 5.5;
        alpha[i] = Math.sin(Math.PI * u) * 0.11 * steamK;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aSize.needsUpdate = true;
      geo.attributes.aAlpha.needsUpdate = true;
    },
    dispose() {
      scene.remove(group, steam, ...lights);
      rods.forEach(r => r.geometry.dispose());
      rodMat.dispose(); wall.geometry.dispose(); wallMat.dispose(); glowMap.dispose(); geo.dispose(); steamMat.dispose();
    },
  };
}
