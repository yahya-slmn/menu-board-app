import * as THREE from 'three';
import { offsetConvexPolygon } from './trayModels.js';
import { prefersReducedMotion } from './quality.js';

// A draggable object on the tray (a cutter now; dough pieces later). Holds its plan-space pose
// plus the little bit of physical state that makes dragging feel good: a target it springs toward,
// a lift while held, a lean into its own motion, and a squash spring that plays when it lands.

function ribbonGeometry(poly, width) {
  const outer = offsetConvexPolygon(poly, width / 2), inner = offsetConvexPolygon(poly, -width / 2);
  const n = poly.length, pos = new Float32Array(n * 2 * 3), idx = [];
  for (let i = 0; i < n; i++) {
    pos.set([outer[i][0], 0, -outer[i][1]], i * 6);
    pos.set([inner[i][0], 0, -inner[i][1]], i * 6 + 3);
    const a = i * 2, b = i * 2 + 1, c = ((i + 1) % n) * 2, d = ((i + 1) % n) * 2 + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

const OUTLINE_COLOR = 0x2d7dd2, INVALID_COLOR = 0xe0523f;

export class PlacedItem {
  constructor({ id, kind, group, poly, benchPoly = null, x = 0, y = 0, rot = 0, baseY = 0, height = 1, data = {}, collision = 'solid', home = 'tray', heldLift = 1.6 }) {
    this.home = home; this.heldLift = heldLift; this.zone = null;
    this.rotT = rot; this.baseYT = baseY; this.startRot = rot; this.startHome = home;
    this.radius = Math.max(...poly.map(([px, py]) => Math.hypot(px, py)));
    this.benchPoly = benchPoly; // smaller, un-risen footprint used while resting on the bench
    this.benchRadius = benchPoly ? Math.max(...benchPoly.map(([px, py]) => Math.hypot(px, py))) : this.radius;
    this.collision = collision; // 'solid' blocks/slides around neighbours; 'lifted' passes over them and settles on drop
    this.invalid = false; this.startX = x; this.startY = y;
    this.id = id; this.kind = kind; this.group = group; this.poly = poly; this.data = data;
    this.x = x; this.y = y; this.rot = rot; this.tx = x; this.ty = y;
    this.vx = 0; this.vy = 0; this.baseY = baseY; this.height = height;
    this.lift = 0; this.squash = 0; this.squashV = 0;
    this.dragging = false; this.hover = false; this.selected = false;
    group.traverse((o) => { if (o.isMesh) o.userData.itemId = id; });

    // Sits just outside the piece's steel wall (a thin ring drawn on the tray floor would otherwise
    // be half-hidden under it from the tilted camera).
    const ringPoly = offsetConvexPolygon(poly, 0.6);
    const mk = (w, opacity) => new THREE.Mesh(
      ribbonGeometry(ringPoly, w),
      new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, transparent: true, opacity, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
    );
    this.outline = new THREE.Group();
    this.outline.userData.noAO = true; // see post.js: kept out of the AO pass
    this.glow = mk(0.9, 0);
    this.core = mk(0.22, 0);
    this.outline.add(this.glow, this.core);
    this.outline.renderOrder = 5;
    this.sync();
  }

  // Extent in world y (for lifting above neighbours); also where the outline sits on the floor.
  sync() {
    this.group.position.set(this.x, this.baseY + this.lift, -this.y);
    const lean = 0.0035;
    const leanX = THREE.MathUtils.clamp(-this.vy * lean, -0.12, 0.12);
    const leanZ = THREE.MathUtils.clamp(-this.vx * lean, -0.12, 0.12);
    this.group.rotation.set(leanX, this.rot, leanZ, 'YXZ');
    this.group.scale.set(1 + 0.5 * this.squash, 1 - this.squash, 1 + 0.5 * this.squash);
    this.outline.position.set(this.x, this.baseY + 0.04, -this.y);
    this.outline.rotation.y = this.rot;
    const o = this.selected || this.dragging || this.invalid ? 1 : this.hover ? 0.55 : 0;
    const color = this.invalid ? INVALID_COLOR : OUTLINE_COLOR;
    this.core.material.color.setHex(color); this.glow.material.color.setHex(color);
    this.core.material.opacity = 0.9 * o;
    this.glow.material.opacity = 0.28 * o;
    this.outline.visible = o > 0;
  }

  // Advances the spring/lift/squash state. Returns true while still moving.
  step(dt) {
    const k = 1 - Math.exp(-(this.dragging ? 32 : 22) * dt);
    const px = this.x, py = this.y;
    this.x += (this.tx - this.x) * k;
    this.y += (this.ty - this.y) * k;
    this.vx = (this.x - px) / dt; this.vy = (this.y - py) / dt;
    const liftTarget = this.dragging ? this.heldLift : 0;
    // Rotation and resting height ease toward their targets (a piece turns and steps up/down
    // between bench and tray instead of snapping).
    const kr = 1 - Math.exp(-16 * dt);
    this.rot += (this.rotT - this.rot) * kr;
    this.baseY += (this.baseYT - this.baseY) * kr;
    const prevLift = this.lift;
    this.lift += (liftTarget - this.lift) * (1 - Math.exp(-16 * dt));
    if (prevLift > 0.4 && this.lift < prevLift && !this.dragging && this.lift < 0.35 && this._landed !== true) {
      this._landed = true; if (!prefersReducedMotion()) this.squashV = 0.9; // touchdown: one small squash-and-recover
    }
    if (this.dragging) this._landed = false;
    this.squashV += (-170 * this.squash - 15 * this.squashV) * dt;
    this.squash += this.squashV * dt;
    this.sync();
    const moving = Math.hypot(this.tx - this.x, this.ty - this.y) > 0.002 || Math.abs(this.lift - liftTarget) > 0.003
      || Math.abs(this.rotT - this.rot) > 0.001 || Math.abs(this.baseYT - this.baseY) > 0.004
      || Math.abs(this.squash) > 0.002 || Math.abs(this.squashV) > 0.02 || this.dragging;
    if (!moving) { this.vx = this.vy = 0; this.squash = this.squashV = 0; this.lift = liftTarget; this.rot = this.rotT; this.baseY = this.baseYT; this.sync(); }
    return moving;
  }

  dispose() {
    this.group.traverse((o) => { o.geometry?.dispose?.(); });
    this.glow.geometry.dispose(); this.core.geometry.dispose();
    this.glow.material.dispose(); this.core.material.dispose();
  }
}
