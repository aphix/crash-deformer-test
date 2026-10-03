import * as THREE from "three";
import { applyGroundFriction, round4, snapshotPoints } from "../deform/physics-util.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { activeGround } from "../world/ground.ts";

const _ha = new THREE.Vector3();
const _hb = new THREE.Vector3();
const _pv = new THREE.Vector3();
const STILL = new THREE.Vector3();
/** Pale blue-white: powdered glass. */
const GLASS_DUST = new THREE.Color(0.86, 0.93, 1);

/** Sliding friction of metal and glass bits on asphalt. */
const FX_GROUND_MU = 0.6;

/** Bounce for FX particles off the active ground (none past the fleet disc's rim: they fall on and fade). Friction is per second, in each system's update (`groundSlide`). */
export function bounceGround(pos: THREE.Vector3, vel: THREE.Vector3, r: number): void {
  const floor = activeGround().heightAt(pos.x, pos.z, pos.y);
  if (pos.y < floor + r) {
    pos.y = floor + r;
    if (vel.y < 0) vel.y *= -0.28;
  }
}

/** FX particles rest no lower than this (m) above the ground: each update clamps y to it after the bounce. */
const FX_FLOOR = 0.04;

/** Coulomb slide for a particle on (or within a 5 mm hop of) its resting height above `floor` after the bounce. */
function groundSlide(pos: THREE.Vector3, vel: THREE.Vector3, r: number, dt: number, floor: number): void {
  if (pos.y <= floor + Math.max(r, FX_FLOOR) + 0.005) applyGroundFriction(vel, dt, FX_GROUND_MU, true);
}

/** Push an FX particle out of the car's hull boxes and reflect it off the side it entered. */
export function bounceOffCar(car: DeformableCar, pos: THREE.Vector3, vel: THREE.Vector3, r: number): void {
  // Runs per FX particle per car: reject by distance before any matrix work.
  const ex = pos.x - car.group.position.x;
  const ez = pos.z - car.group.position.z;
  const reach = 3.2 + r;
  if (ex * ex + ez * ez > reach * reach) return;
  car.group.updateWorldMatrix(false, false);
  _ha.copy(pos);
  car.group.worldToLocal(_ha);
  if (_ha.y < 0.02 - r || _ha.y > 1.45 + r) return;
  for (const h of car.hulls()) {
    const dx = _ha.x - h.cx;
    const dz = _ha.z - h.cz;
    const ox = h.hx + r - Math.abs(dx);
    const oz = h.hz + r - Math.abs(dz);
    if (ox <= 0 || oz <= 0) continue;
    if (ox < oz) {
      const s = dx >= 0 ? 1 : -1;
      _ha.x += s * ox;
      bounceRelative(car, pos, vel, car.rightFlat.x * s, car.rightFlat.z * s);
    } else {
      const s = dz >= 0 ? 1 : -1;
      _ha.z += s * oz;
      bounceRelative(car, pos, vel, car.fwdFlat.x * s, car.fwdFlat.z * s);
    }
    _hb.copy(_ha);
    car.group.localToWorld(_hb);
    pos.copy(_hb);
    return;
  }
}

/** Reflect off a moving car panel: restitution acts on the velocity relative to that point of the car. */
function bounceRelative(car: DeformableCar, pos: THREE.Vector3, vel: THREE.Vector3, nx: number, nz: number): void {
  car.pointVelocity(pos, _pv);
  const vn = (vel.x - _pv.x) * nx + (vel.z - _pv.z) * nz;
  if (vn >= 0) return;
  vel.x -= vn * nx * 1.55;
  vel.z -= vn * nz * 1.55;
  vel.y += Math.abs(vn) * 0.15;
}

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/** Instanced metal bits. Slots come from a ring; each piece owns its position, spin and size; a spent slot draws at scale 0. */
export class DebrisSystem {
  private mesh: THREE.InstancedMesh;
  private life: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  /** xyz per piece. */
  private pos: Float32Array;
  /** Euler xyz per piece. */
  private rot: Float32Array;
  private size: Float32Array;
  private dummy = new THREE.Object3D();
  private vel = new THREE.Vector3();
  private n: number;
  private cursor = 0;

  constructor(scene: THREE.Scene, n = 180) {
    this.n = n;
    const geo = new THREE.BoxGeometry(0.038, 0.016, 0.026);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x6a6e74,
      metalness: 0.72,
      roughness: 0.4,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    // three caches an InstancedMesh's bounding sphere the first time it culls (here: count 0, radius −1), so
    // camera culling hid every piece; the pieces move every frame, a sphere would need recomputing each one.
    this.mesh.frustumCulled = false;
    // Its own shadow depth material: on three's shared one, every instanced ↔ plain caster switch reselects the program.
    this.mesh.customDepthMaterial = new THREE.MeshDepthMaterial();
    this.mesh.count = 0;
    this.life = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.pos = new Float32Array(n * 3);
    this.rot = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    scene.add(this.mesh);
  }

  reset(): void {
    this.mesh.count = 0;
    this.cursor = 0;
    this.life.fill(0);
  }

  snapshot() {
    const items: { x: number; y: number; z: number; life: number }[] = [];
    for (let i = 0; i < this.mesh.count && items.length < 16; i++) {
      if (this.life[i]! <= 0) continue;
      items.push({
        x: round4(this.pos[i * 3]!),
        y: round4(this.pos[i * 3 + 1]!),
        z: round4(this.pos[i * 3 + 2]!),
        life: round4(this.life[i]!),
      });
    }
    return { count: items.length, items };
  }

  burst(origin: THREE.Vector3, normal: THREE.Vector3, count: number): void {
    const n = Math.min(this.n, Math.floor(count));
    for (let k = 0; k < n; k++) {
      // Oldest slot first: a new burst never cuts or moves pieces still in the air unless the ring is full.
      const i = this.cursor;
      this.cursor = (i + 1) % this.n;
      this.mesh.count = Math.max(this.mesh.count, i + 1);
      this.life[i] = 0.9 + Math.random() * 1.5;
      const side = Math.random() - 0.5;
      this.vx[i] = -normal.x * (2 + Math.random() * 6) + (Math.random() - 0.5) * 5 + normal.z * side * 4;
      this.vy[i] = 1.4 + Math.random() * 4.2;
      this.vz[i] = -normal.z * (2 + Math.random() * 6) + (Math.random() - 0.5) * 5 - normal.x * side * 4;
      this.pos[i * 3] = origin.x;
      this.pos[i * 3 + 1] = origin.y + 0.08;
      this.pos[i * 3 + 2] = origin.z;
      this.rot[i * 3] = Math.random() * 3;
      this.rot[i * 3 + 1] = Math.random() * 3;
      this.rot[i * 3 + 2] = Math.random() * 3;
      this.size[i] = 0.45 + Math.random() * 0.7;
      this.place(i);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private place(i: number): void {
    const d = this.dummy;
    d.position.fromArray(this.pos, i * 3);
    d.rotation.set(this.rot[i * 3]!, this.rot[i * 3 + 1]!, this.rot[i * 3 + 2]!);
    d.scale.setScalar(this.size[i]!);
    d.updateMatrix();
    this.mesh.setMatrixAt(i, d.matrix);
  }

  update(dt: number, bounce: (pos: THREE.Vector3, vel: THREE.Vector3, r: number) => void): void {
    if (this.mesh.count === 0) return;
    let any = false;
    const p = this.dummy.position;
    for (let i = 0; i < this.mesh.count; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i]! -= dt;
      if (this.life[i]! <= 0) {
        this.mesh.setMatrixAt(i, HIDDEN);
        continue;
      }
      any = true;
      this.vy[i]! -= 9.6 * dt;
      p.fromArray(this.pos, i * 3);
      p.x += this.vx[i]! * dt;
      p.y += this.vy[i]! * dt;
      p.z += this.vz[i]! * dt;
      this.vel.set(this.vx[i]!, this.vy[i]!, this.vz[i]!);
      bounce(p, this.vel, 0.03);
      const floor = activeGround().heightAt(p.x, p.z, p.y);
      groundSlide(p, this.vel, 0.03, dt, floor);
      p.y = Math.max(floor + FX_FLOOR, p.y);
      p.toArray(this.pos, i * 3);
      this.vx[i] = this.vel.x;
      this.vy[i] = this.vel.y;
      this.vz[i] = this.vel.z;
      this.rot[i * 3]! += dt * 5;
      this.rot[i * 3 + 1]! += dt * 3.2;
      this.place(i);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (!any) this.reset();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.customDepthMaterial?.dispose();
    this.mesh.dispose();
  }
}

function makeDotTexture(color: string, glow: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, color);
  g.addColorStop(0.35, glow);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

type DotLook = {
  core: string;
  glow: string;
  size: number;
  opacity: number;
  /** Downward accel (m/s²). */
  gravity: number;
  /** Collision radius passed to the world bounce. */
  radius: number;
};

/** Ring buffer of additive billboard dots that fall, bounce off the world, and park at y=250 when dead. */
class DotPoints {
  protected readonly pos: Float32Array;
  protected readonly vx: Float32Array;
  protected readonly vy: Float32Array;
  protected readonly vz: Float32Array;
  protected readonly life: Float32Array;
  protected readonly n: number;
  private points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private tmp = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private cursor = 0;
  private anyAlive = false;
  private gravity: number;
  private radius: number;

  constructor(scene: THREE.Scene, n: number, look: DotLook) {
    this.n = n;
    this.gravity = look.gravity;
    this.radius = look.radius;
    this.pos = new Float32Array(n * 3);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.life = new Float32Array(n);
    for (let i = 0; i < n; i++) this.pos[i * 3 + 1] = 250;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setDrawRange(0, n);
    const mat = new THREE.PointsMaterial({
      map: makeDotTexture(look.core, look.glow),
      color: 0xffffff,
      size: look.size,
      transparent: true,
      opacity: look.opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  reset(): void {
    this.life.fill(0);
    this.cursor = 0;
    this.anyAlive = false;
    for (let i = 0; i < this.n; i++) this.pos[i * 3 + 1] = 250;
    this.geo.setDrawRange(0, this.n);
    (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Oldest ring slot; the caller fills pos/vel/life for it. */
  protected claim(): number {
    const k = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    return k;
  }

  /** Publish `spawned` freshly claimed slots to the GPU. */
  protected commit(spawned: number): void {
    if (spawned > 0) this.anyAlive = true;
    this.geo.setDrawRange(0, this.n);
    (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  update(dt: number, bounce: (pos: THREE.Vector3, vel: THREE.Vector3, r: number) => void): void {
    if (!this.anyAlive) return;
    let any = false;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i]! <= 0) continue;
      any = true;
      this.life[i]! -= dt;
      if (this.life[i]! <= 0) {
        this.pos[i * 3 + 1] = 250;
        continue;
      }
      this.tmp.set(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!);
      this.vel.set(this.vx[i]!, this.vy[i]!, this.vz[i]!);
      this.tmp.addScaledVector(this.vel, dt);
      this.vel.y -= this.gravity * dt;
      bounce(this.tmp, this.vel, this.radius);
      const floor = activeGround().heightAt(this.tmp.x, this.tmp.z, this.tmp.y);
      groundSlide(this.tmp, this.vel, this.radius, dt, floor);
      this.tmp.y = Math.max(floor + FX_FLOOR, this.tmp.y);
      this.pos[i * 3] = this.tmp.x;
      this.pos[i * 3 + 1] = this.tmp.y;
      this.pos[i * 3 + 2] = this.tmp.z;
      this.vx[i] = this.vel.x;
      this.vy[i] = this.vel.y;
      this.vz[i] = this.vel.z;
    }
    this.anyAlive = any;
    if (any) (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  /** HDR colour multiplier: above 1 the dots feed the bloom pass (cinematic tiers); 1 is the plain look. */
  glow(k: number): void {
    (this.points.material as THREE.PointsMaterial).color.setScalar(k);
  }

  dispose(): void {
    this.geo.dispose();
    const mat = this.points.material as THREE.PointsMaterial;
    mat.map?.dispose();
    mat.dispose();
  }
}

/** Spark streak length: this many seconds of travel behind each spark. */
const STREAK_S = 0.045;

export class SparkSystem extends DotPoints {
  private readonly streakPos: Float32Array;
  private readonly streakCol: Float32Array;
  private readonly streakGeo = new THREE.BufferGeometry();
  private readonly streaks: THREE.LineSegments;

  constructor(scene: THREE.Scene, n = 480) {
    super(scene, n, {
      core: "rgba(255,248,220,1)",
      glow: "rgba(255,170,70,0.7)",
      size: 0.12,
      opacity: 0.95,
      gravity: 6.5,
      radius: 0.025,
    });
    this.streakPos = new Float32Array(n * 6);
    this.streakCol = new Float32Array(n * 6);
    this.streakGeo.setAttribute("position", new THREE.BufferAttribute(this.streakPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.streakGeo.setAttribute("color", new THREE.BufferAttribute(this.streakCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.streaks = new THREE.LineSegments(
      this.streakGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
    );
    this.streaks.frustumCulled = false;
    this.streaks.visible = false;
    scene.add(this.streaks);
  }

  /** Motion streaks: a hot line from each spark back along its velocity, fading to nothing (cinematic tiers). */
  set streaked(on: boolean) {
    this.streaks.visible = on;
  }

  override update(dt: number, bounce: (pos: THREE.Vector3, vel: THREE.Vector3, r: number) => void): void {
    super.update(dt, bounce);
    if (!this.streaks.visible) return;
    const p = this.streakPos;
    const c = this.streakCol;
    let live = 0;
    for (let i = 0; i < this.n; i++) {
      const life = this.life[i]!;
      if (life <= 0) continue;
      const o = live * 6;
      const x = this.pos[i * 3]!;
      const y = this.pos[i * 3 + 1]!;
      const z = this.pos[i * 3 + 2]!;
      p[o] = x;
      p[o + 1] = y;
      p[o + 2] = z;
      p[o + 3] = x - this.vx[i]! * STREAK_S;
      p[o + 4] = Math.max(0.02, y - this.vy[i]! * STREAK_S);
      p[o + 5] = z - this.vz[i]! * STREAK_S;
      const hot = Math.min(1, life * 4) * 3.2;
      c[o] = hot;
      c[o + 1] = hot * 0.62;
      c[o + 2] = hot * 0.24;
      c[o + 3] = 0;
      c[o + 4] = 0;
      c[o + 5] = 0;
      live++;
    }
    this.streakGeo.setDrawRange(0, live * 2);
    if (live === 0) return;
    const pa = this.streakGeo.attributes.position as THREE.BufferAttribute;
    const ca = this.streakGeo.attributes.color as THREE.BufferAttribute;
    pa.clearUpdateRanges();
    ca.clearUpdateRanges();
    pa.addUpdateRange(0, live * 6);
    ca.addUpdateRange(0, live * 6);
    pa.needsUpdate = true;
    ca.needsUpdate = true;
  }

  override reset(): void {
    super.reset();
    this.streakGeo.setDrawRange(0, 0);
  }

  override dispose(): void {
    super.dispose();
    this.streakGeo.dispose();
    (this.streaks.material as THREE.Material).dispose();
  }

  poof(origin: THREE.Vector3, normal: THREE.Vector3, count: number): void {
    const n = Math.min(this.n, Math.max(0, Math.floor(count)));
    for (let i = 0; i < n; i++) {
      const k = this.claim();
      const ox = (Math.random() - 0.5) * 2;
      const oy = Math.random();
      const oz = (Math.random() - 0.5) * 2;
      const mag = Math.hypot(ox, oy, oz) || 1;
      this.pos[k * 3] = origin.x + (Math.random() - 0.5) * 0.22;
      this.pos[k * 3 + 1] = Math.max(0.08, origin.y) + Math.random() * 0.12;
      this.pos[k * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.22;
      const speed = 1.4 + Math.random() * 3.2;
      this.vx[k] = (ox / mag) * speed - normal.x * 0.6;
      this.vy[k] = (oy / mag) * speed * 0.85 + 1.1;
      this.vz[k] = (oz / mag) * speed - normal.z * 0.6;
      this.life[k] = 0.28 + Math.random() * 0.35;
    }
    this.commit(n);
  }

  snapshot() {
    return snapshotPoints(this.pos, null, null, this.life, true);
  }
}

export class GlassDotSystem extends DotPoints {
  /** 640: a head-on's two `shatter`s (2 × 260 at full density) on top of its panes' bursts. */
  constructor(scene: THREE.Scene, n = 640) {
    super(scene, n, {
      core: "rgba(255,255,255,1)",
      glow: "rgba(210,230,245,0.55)",
      size: 0.042,
      opacity: 0.9,
      gravity: 9.6,
      radius: 0.02,
    });
  }

  burst(origin: THREE.Vector3, inherit: THREE.Vector3, count: number): void {
    const n = Math.min(this.n, Math.floor(count));
    for (let i = 0; i < n; i++) {
      const k = this.claim();
      this.pos[k * 3] = origin.x + (Math.random() - 0.5) * 0.55;
      this.pos[k * 3 + 1] = Math.max(0.12, origin.y) + (Math.random() - 0.2) * 0.28;
      this.pos[k * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.4;
      this.vx[k] = inherit.x * 0.85 + (Math.random() - 0.5) * 5.5;
      this.vy[k] = inherit.y * 0.55 + 1.4 + Math.random() * 3.6;
      this.vz[k] = inherit.z * 0.85 + (Math.random() - 0.5) * 5.5;
      this.life[k] = 1.1 + Math.random() * 1.1;
    }
    this.commit(n);
  }

  /**
   * A thrown driver's cover (owner: heavy and very short): `count` shards packed through the box `half` (m, in frame
   * `q`) round `origin`, flung out of it on top of `inherit`, gone in 0.15–0.3 s of FX time. FX time runs at least at
   * 0.6 × wall, so the slow-mo holds them half a second at most.
   */
  shatter(origin: THREE.Vector3, q: THREE.Quaternion, half: THREE.Vector3, inherit: THREE.Vector3, count: number): void {
    const n = Math.min(this.n, Math.floor(count));
    for (let i = 0; i < n; i++) {
      const k = this.claim();
      _pv.set((Math.random() * 2 - 1) * half.x, (Math.random() * 2 - 1) * half.y, (Math.random() * 2 - 1) * half.z).applyQuaternion(q);
      this.pos[k * 3] = origin.x + _pv.x;
      this.pos[k * 3 + 1] = Math.max(0.12, origin.y + _pv.y);
      this.pos[k * 3 + 2] = origin.z + _pv.z;
      this.vx[k] = inherit.x + _pv.x * 3;
      this.vy[k] = inherit.y + _pv.y * 3 + 1.5;
      this.vz[k] = inherit.z + _pv.z * 3;
      this.life[k] = 0.15 + Math.random() * 0.15;
    }
    this.commit(n);
  }
}

export class TireSmokeSystem {
  private mesh: THREE.InstancedMesh;
  private px: Float32Array;
  private py: Float32Array;
  private pz: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size: Float32Array;
  private dummy = new THREE.Object3D();
  private n: number;
  private cursor = 0;
  private anyAlive = false;
  private readonly tint: Float32Array;
  /** Scene light on the (unlit) smoke: 1 by day, low at night. */
  shade = 1;

  /** `soft`: a thin, wide puff for tyre smoke (cinematic tiers) instead of the dense crash plume. */
  constructor(scene: THREE.Scene, n = 420, soft = false) {
    this.n = n;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.size = new Float32Array(n);
    this.tint = new Float32Array(n * 3).fill(1);
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: soft
        ? makeDotTexture("rgba(232,232,228,0.42)", "rgba(160,160,156,0.14)")
        : makeDotTexture("rgba(210,210,206,0.95)", "rgba(70,70,68,0.25)"),
      transparent: true,
      opacity: soft ? 0.38 : 0.85,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.count = n;
    scene.add(this.mesh);
    this.hideAll();
  }

  private hideAll(): void {
    this.mesh.visible = false;
    this.dummy.scale.setScalar(0.001);
    this.dummy.position.set(0, 250, 0);
    this.dummy.updateMatrix();
    for (let i = 0; i < this.n; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  reset(): void {
    this.life.fill(0);
    this.cursor = 0;
    this.anyAlive = false;
    this.hideAll();
  }

  /** Tyre smoke: wide, slow-rising, long-lived; `tint` colours it (dust on dirt, turf on grass), white when omitted. */
  emitAt(origin: THREE.Vector3, inherit: THREE.Vector3, count: number, tint?: THREE.Color): void {
    this.spawn(origin, inherit, count, 0.9, 1.7, 0.3, tint);
  }

  plume(origin: THREE.Vector3, inherit: THREE.Vector3, count: number): void {
    this.spawn(origin, inherit, count, 0.55, 2.2, 1.4);
  }

  /** Light, steady thread after the block is dead. Not a crash burst. */
  wisp(origin: THREE.Vector3, inherit: THREE.Vector3): void {
    this.spawn(origin, inherit, 1, 0.22, 1.5, 0.65);
  }

  /** A car vaporizing below the fleet disc: a big, slow, long puff wherever it is (no ground clamp). */
  vapour(origin: THREE.Vector3, inherit: THREE.Vector3, count: number): void {
    this.spawn(origin, inherit, count, 2, 2.6, 0.8, undefined, -Infinity);
  }

  /**
   * A thrown driver's glass dust over his way out, round `GlassDotSystem.shatter`'s shards: `count` big pale puffs
   * through the box `half` (m, in frame `q`) round `origin`, gone in 0.2–0.35 s of FX time.
   */
  glassDust(origin: THREE.Vector3, q: THREE.Quaternion, half: THREE.Vector3, count: number): void {
    for (let i = 0; i < count; i++) {
      _pv.set((Math.random() * 2 - 1) * half.x, (Math.random() * 2 - 1) * half.y, (Math.random() * 2 - 1) * half.z).applyQuaternion(q).add(origin);
      this.spawn(_pv, STILL, 1, 0.5, 0.2, 0.3, GLASS_DUST, 0.08, 0.15);
    }
  }

  private spawn(
    origin: THREE.Vector3,
    inherit: THREE.Vector3,
    count: number,
    size: number,
    life: number,
    rise: number,
    tint?: THREE.Color,
    floor = 0.08,
    lifeSpread = 1.1,
  ): void {
    const n = Math.min(this.n, Math.max(0, Math.floor(count)));
    for (let i = 0; i < n; i++) {
      const k = this.cursor;
      this.cursor = (this.cursor + 1) % this.n;
      this.px[k] = origin.x + (Math.random() - 0.5) * 0.35;
      this.py[k] = Math.max(floor, origin.y);
      this.pz[k] = origin.z + (Math.random() - 0.5) * 0.35;
      this.vx[k] = inherit.x * 0.04 + (Math.random() - 0.5) * 0.22;
      this.vy[k] = rise + Math.random() * 0.7;
      this.vz[k] = inherit.z * 0.04 + (Math.random() - 0.5) * 0.22;
      const L = life + Math.random() * lifeSpread;
      this.life[k] = L;
      this.maxLife[k] = L;
      this.size[k] = size + Math.random() * 0.4;
      this.tint[k * 3] = tint ? tint.r : 1;
      this.tint[k * 3 + 1] = tint ? tint.g : 1;
      this.tint[k * 3 + 2] = tint ? tint.b : 1;
    }
    if (n > 0) this.anyAlive = this.mesh.visible = true;
  }

  snapshot() {
    return snapshotPoints(this.px, this.py, this.pz, this.life, false);
  }

  update(
    dt: number,
    _bounce: (pos: THREE.Vector3, vel: THREE.Vector3, r: number) => void,
    camera: THREE.Camera,
  ): void {
    void _bounce;
    if (!this.anyAlive) return;
    const damp = Math.exp(-0.7 * dt);
    let any = false;
    let wrote = false;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i]! -= dt;
      const fade = Math.max(0, this.life[i]! / Math.max(this.maxLife[i]!, 1e-4));
      if (fade <= 0) {
        this.life[i] = 0;
        this.dummy.position.set(0, 250, 0);
        this.dummy.scale.setScalar(0.001);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        wrote = true;
        continue;
      }
      any = true;
      this.px[i]! += this.vx[i]! * dt;
      this.py[i]! += this.vy[i]! * dt;
      this.pz[i]! += this.vz[i]! * dt;
      this.vy[i]! += 0.55 * dt;
      this.vx[i]! *= damp;
      this.vz[i]! *= damp;
      this.dummy.position.set(this.px[i]!, this.py[i]!, this.pz[i]!);
      this.dummy.scale.setScalar(this.size[i]! * (0.7 + (1 - fade) * 1.8));
      this.dummy.quaternion.copy(camera.quaternion);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      const g = (0.55 + fade * 0.4) * this.shade;
      this.mesh.setColorAt(i, _smokeColor.setRGB(g * this.tint[i * 3]!, g * this.tint[i * 3 + 1]!, g * 0.96 * this.tint[i * 3 + 2]!));
      wrote = true;
    }
    this.anyAlive = this.mesh.visible = any;
    if (wrote) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    const mat = this.mesh.material as THREE.MeshBasicMaterial;
    mat.map?.dispose();
    mat.dispose();
  }
}

const _smokeColor = new THREE.Color();

export class CrashAudio {
  private ctx: AudioContext | null = null;
  unlocked = false;

  unlock(): void {
    if (this.unlocked) {
      void this.ctx?.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.unlocked = true;
    void this.ctx.resume();
  }

  impact(impulse: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 0.35 + Math.min(0.4, impulse * 0.01);

    const thump = ctx.createOscillator();
    const thumpG = ctx.createGain();
    thump.type = "sine";
    thump.frequency.setValueAtTime(48, t);
    thump.frequency.exponentialRampToValueAtTime(22, t + dur);
    thumpG.gain.setValueAtTime(Math.min(0.7, 0.22 + impulse * 0.012), t);
    thumpG.gain.exponentialRampToValueAtTime(0.001, t + dur);
    thump.connect(thumpG).connect(ctx.destination);
    thump.start(t);
    thump.stop(t + dur);

    const noise = ctx.createBufferSource();
    const nbuf = ctx.createBuffer(1, ctx.sampleRate * 0.25, ctx.sampleRate);
    const data = nbuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    noise.buffer = nbuf;
    const ng = ctx.createGain();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900;
    bp.Q.value = 0.7;
    ng.gain.setValueAtTime(Math.min(0.45, 0.12 + impulse * 0.008), t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    noise.connect(bp).connect(ng).connect(ctx.destination);
    noise.start(t);
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}
