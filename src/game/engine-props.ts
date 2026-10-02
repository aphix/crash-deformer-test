import * as THREE from "three";
import { CAR_HALF, type DeformableCar } from "./car.ts";
import type { Hull } from "./car-mesh.ts";
import { applyGroundFriction, leftoverCrumple, round4, satPushCap, vec3 } from "./physics-util.ts";
import { BARRIER_HALF, BARRIER_MASS, clipCarToBarrier, satCarBarrier } from "./sat.ts";
import { impulseCar, pushCar } from "./pair-contact.ts";
import { makeJerseyBarrier, restoreBarrierRest } from "./engine-world.ts";
import type { DebrisSystem, SparkSystem } from "./engine-fx.ts";

/** Fraction of a ramp ball's diameter left above the asphalt. */
export const BALL_EXPOSE = 0.25;

type ContactHit = { impulse: number; contact: THREE.Vector3; normal: THREE.Vector3 };

export type LampPole = {
  group: THREE.Group;
  intact: boolean;
  radius: number;
  kicked: Set<string>;
};

export type RampBall = {
  mesh: THREE.Mesh;
  radius: number;
  intact: boolean;
  kicked: Set<string>;
};

const _v = new THREE.Vector3();
const _r = new THREE.Vector3();
const _bn = new THREE.Vector3();
const _bp = new THREE.Vector3();
const _cn = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _bRight = new THREE.Vector3();
const _bFwd = new THREE.Vector3();
const _hb = new THREE.Vector3();
const _mtv = new THREE.Vector3();

/** Strongest contact seen during one fixed step; it frames the impact cinematic. `contact` and `normal`
 *  are copies (null until a hit is offered): `resolveCarPair` rewrites its one result record every call. */
export class StrongestContact {
  impulse = 0;
  contact: THREE.Vector3 | null = null;
  normal: THREE.Vector3 | null = null;
  private readonly contactAt = new THREE.Vector3();
  private readonly normalAt = new THREE.Vector3();

  clear(): void {
    this.impulse = 0;
    this.contact = null;
    this.normal = null;
  }

  offer(hit: ContactHit): void {
    if (hit.impulse < this.impulse) return;
    this.impulse = hit.impulse;
    this.contact = this.contactAt.copy(hit.contact);
    this.normal = this.normalAt.copy(hit.normal);
  }
}

/** Movable, dentable jersey slab: SAT contact, momentum exchange, mesh indent, FX bounce. */
export class JerseyBarrier {
  readonly group: THREE.Group;
  readonly vel = new THREE.Vector3();
  yaw = 0;
  crush = 0;
  /** Car-side face normal from the last `hold`. */
  private readonly faceN = new THREE.Vector3();

  /** `group` defaults to the textured slab; headless scenarios pass a bare group. */
  constructor(scene: THREE.Scene, group: THREE.Group = makeJerseyBarrier()) {
    this.group = group;
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Face the slab broadside to the lead car's approach line. */
  orient(a: THREE.Vector3): void {
    const len = Math.hypot(a.x, a.z);
    if (len < 0.01) {
      this.yaw = 0;
    } else {
      const nx = a.x / len;
      const nz = a.z / len;
      this.yaw = Math.atan2(-nz, nx);
    }
    this.group.rotation.y = this.yaw;
  }

  reset(): void {
    this.vel.set(0, 0, 0);
    this.crush = 0;
    this.group.position.set(0, 0, 0);
    restoreBarrierRest(this.group);
  }

  /** Half-thickness shrinks as the slab is dented. */
  hx(): number {
    return Math.max(0.18, BARRIER_HALF.x * (1 - this.crush * 0.45));
  }

  step(dt: number): void {
    if (dt <= 0) return;
    this.group.position.x += this.vel.x * dt;
    this.group.position.z += this.vel.z * dt;
    applyGroundFriction(this.vel, dt, 1.8, true);
  }

  /** Mass-level slab contact, then the cabin tunnelling floor. */
  clip(car: DeformableCar): void {
    this.hold(car);
    clipCarToBarrier(car, this.yaw, this.group.position, this.hx(), leftoverCrumple(car.deform.crumpleTravelCorner()));
  }

  /**
   * Put every mass that crossed the slab back on its face (the slab takes that
   * momentum) and leave the car-side face normal in `faceN`. True while a
   * mass of a crashed car rests on the face.
   */
  private hold(car: DeformableCar): boolean {
    const o = this.group.position;
    const held = car.deform.projectOutOfBox(o.x, o.z, this.hx(), BARRIER_HALF.z, this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    const side = (car.group.position.x - o.x) * rx + (car.group.position.z - o.z) * rz >= 0 ? 1 : -1;
    this.faceN.set(rx * side, 0, rz * side);
    if (held > 0) this.vel.addScaledVector(this.faceN, -held / BARRIER_MASS);
    return car.crashed && car.deform.faceContacts > 0;
  }

  /**
   * Crush force: the constant deceleration that spends this hit's stroke on
   * the car pressing into `faceN`. It reaches the cabin through the
   * structure, so masses already held on the face do not count against it.
   */
  private brake(car: DeformableCar, dt: number): void {
    const n = this.faceN;
    if (car.velocity.x * n.x + car.velocity.z * n.z >= 0) return;
    const v0 = car.deform.hitSpeedValue;
    const j = car.deform.totalMass * ((v0 * v0) / (2 * car.deform.hitStroke())) * dt;
    const taken = car.deform.brakeInbound(n.x, n.z, j);
    this.vel.addScaledVector(n, -taken / BARRIER_MASS);
  }

  /** World position of the car's mass nearest the slab face (`faceN` from the last `hold`). */
  private nearestMass(car: DeformableCar): THREE.Vector3 {
    let best = car.deform.masses[0]!.world;
    let bestD = Infinity;
    for (const m of car.deform.masses) {
      const d = m.world.x * this.faceN.x + m.world.z * this.faceN.z;
      if (d < bestD) {
        bestD = d;
        best = m.world;
      }
    }
    return best;
  }

  resolve(car: DeformableCar, deform: boolean, feed: boolean, dt: number): ContactHit | null {
    const crushHit = satCarBarrier(car, this.yaw, this.group.position, this.hx(), _cn, _cp, car.crushHulls());
    const overlap = satCarBarrier(car, this.yaw, this.group.position, this.hx(), _bn, _bp, car.hulls());
    this.hold(car);
    clipCarToBarrier(car, this.yaw, this.group.position, this.hx(), leftoverCrumple(car.deform.crumpleTravelCorner()));
    if (!crushHit && !overlap) {
      // The crushed nose can sit on the face with the shrunken hulls clear of it — and a wreck coming
      // back for another hit touches here first, so this is where its fresh hit arms.
      if (!this.hold(car)) return null;
      const closing = -(car.velocity.x * this.faceN.x + car.velocity.z * this.faceN.z);
      if (deform && closing > 0.2) car.applyImpact(this.nearestMass(car), this.faceN, closing, closing);
      car.deform.notifyContact();
      if (feed) this.brake(car, dt);
      return null;
    }

    const n = crushHit ? _cn : overlap ? _bn : _cn;
    n.y = 0;
    if (n.lengthSq() > 1e-8) n.normalize();
    _bn.y = 0;
    if (_bn.lengthSq() > 1e-8) _bn.normalize();
    _cn.y = 0;
    if (_cn.lengthSq() > 1e-8) _cn.normalize();
    const p = crushHit ? _cp : _bp;
    const closing = -car.velocity.dot(n);

    // A wreck takes a fresh hit too (applyImpact → rearmHit gates it on quiet time and EBS): the slab
    // re-armed only the first, so repeated wall hits reused its stroke and never crushed deeper.
    if (deform && closing > 0.2 && (crushHit ?? overlap ?? 0) > 0.004) {
      car.applyImpact(p, n.clone(), closing, closing);
    }
    car.deform.notifyContact();

    if (feed && crushHit && crushHit > 0) {
      car.deform.feedOverlap(_cp, _cn, crushHit, Math.max(0, closing), dt);
    }
    if (this.hold(car) && feed) this.brake(car, dt);

    if (overlap) {
      const leftover = leftoverCrumple(car.deform.crumpleTravelCorner());
      const maxPen = car.deform.massActive ? leftover * 0.4 : 0.015;
      const extra = Math.max(0, overlap - maxPen);
      const push = Math.min(extra + 0.004, satPushCap(dt));
      pushCar(car, _bn.x, 0, _bn.z, push);
      if (feed && crushHit) {
        this.indent(_cp, _cn, Math.min(0.012, crushHit * 0.12));
      }
    }
    this.clip(car);

    const shown = crushHit ?? overlap ?? 0;
    return shown > 0.001
      ? { impulse: Math.max(closing, 0.5), contact: p.clone(), normal: n.clone() }
      : null;
  }

  /** True when the slab sits between this pair so they must not SAT through it. */
  blocksPair(a: DeformableCar, b: DeformableCar): boolean {
    _bRight.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const ax = a.group.position.x * _bRight.x + a.group.position.z * _bRight.z;
    const bx = b.group.position.x * _bRight.x + b.group.position.z * _bRight.z;
    const pad = BARRIER_HALF.x + 0.2;
    return ax * bx < 0 && Math.abs(ax) > pad && Math.abs(bx) > pad;
  }

  /** Earliest time-to-contact of any car closing on the slab faces, folded into `eta`. */
  contactEta(cars: readonly DeformableCar[], eta: number): number {
    _bRight.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    _bFwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    for (const car of cars) {
      const px = car.group.position.x;
      const pz = car.group.position.z;
      const lx = px * _bRight.x + pz * _bRight.z;
      const lz = px * _bFwd.x + pz * _bFwd.z;
      const rX =
        Math.abs(car.right.x * _bRight.x + car.right.z * _bRight.z) * CAR_HALF.x +
        Math.abs(car.forward.x * _bRight.x + car.forward.z * _bRight.z) * CAR_HALF.z;
      const rZ =
        Math.abs(car.right.x * _bFwd.x + car.right.z * _bFwd.z) * CAR_HALF.x +
        Math.abs(car.forward.x * _bFwd.x + car.forward.z * _bFwd.z) * CAR_HALF.z;
      const vLx = car.velocity.x * _bRight.x + car.velocity.z * _bRight.z;
      const vLz = car.velocity.x * _bFwd.x + car.velocity.z * _bFwd.z;
      const gapX = Math.abs(lx) - BARRIER_HALF.x - rX;
      const gapZ = Math.abs(lz) - BARRIER_HALF.z - rZ;
      const towardX = -(lx >= 0 ? 1 : -1) * vLx;
      const towardZ = -(lz >= 0 ? 1 : -1) * vLz;
      if (towardX > 0.4 && gapZ < 0.55) {
        eta = Math.min(eta, Math.max(0, gapX) / towardX);
      }
      if (towardZ > 0.4 && gapX < 0.55) {
        eta = Math.min(eta, Math.max(0, gapZ) / towardZ);
      }
    }
    return eta;
  }

  /** Push an FX particle out of the slab box. */
  bounce(pos: THREE.Vector3, vel: THREE.Vector3, r: number): void {
    _bRight.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    _bFwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const oxp = pos.x - this.group.position.x;
    const ozp = pos.z - this.group.position.z;
    const lx = oxp * _bRight.x + ozp * _bRight.z;
    const lz = oxp * _bFwd.x + ozp * _bFwd.z;
    const ox = this.hx() + r - Math.abs(lx);
    const oz = BARRIER_HALF.z + r - Math.abs(lz);
    if (ox <= 0 || oz <= 0 || pos.y > 1.45) return;
    if (ox < oz) {
      const s = lx >= 0 ? 1 : -1;
      pos.addScaledVector(_bRight, s * ox);
      const vn = vel.x * _bRight.x * s + vel.z * _bRight.z * s;
      if (vn < 0) {
        vel.x -= _bRight.x * s * vn * 1.5;
        vel.z -= _bRight.z * s * vn * 1.5;
      }
    } else {
      const s = lz >= 0 ? 1 : -1;
      pos.addScaledVector(_bFwd, s * oz);
      const vn = vel.x * _bFwd.x * s + vel.z * _bFwd.z * s;
      if (vn < 0) {
        vel.x -= _bFwd.x * s * vn * 1.5;
        vel.z -= _bFwd.z * s * vn * 1.5;
      }
    }
  }

  private indent(contact: THREE.Vector3, normal: THREE.Vector3, amount: number): void {
    this.crush = Math.min(0.55, this.crush + amount * 0.7);
    this.group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const rest = obj.userData.rest as Float32Array | undefined;
      if (!rest) return;
      const geo = obj.geometry as THREE.BufferGeometry;
      const attr = geo.getAttribute("position") as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      obj.updateMatrixWorld();
      for (let i = 0; i < arr.length; i += 3) {
        _v.set(arr[i]!, arr[i + 1]!, arr[i + 2]!);
        obj.localToWorld(_v);
        const dx = _v.x - contact.x;
        const dy = _v.y - contact.y;
        const dz = _v.z - contact.z;
        const dist = Math.hypot(dx, dy, dz);
        const fall = Math.exp(-dist * 2.2);
        _v.x -= normal.x * amount * fall;
        _v.z -= normal.z * amount * fall;
        obj.worldToLocal(_v);
        arr[i] = _v.x;
        arr[i + 1] = _v.y;
        arr[i + 2] = _v.z;
      }
      attr.needsUpdate = true;
      geo.computeVertexNormals();
    });
  }
}

export function buildRampBalls(scene: THREE.Scene, balls: RampBall[]): void {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xb7bcc6,
    roughness: 0.52,
    metalness: 0.1,
  });
  for (let i = 0; i < 3; i++) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 22, 16), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.visible = false;
    scene.add(mesh);
    balls.push({ mesh, radius: 0.78, intact: true, kicked: new Set() });
  }
}

export function scatterRampBalls(balls: readonly RampBall[], visible: boolean): void {
  const ringOuter = 2.32;
  const base = Math.random() * Math.PI * 2;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i]!;
    b.radius = 0.68 + Math.random() * 0.24;
    b.mesh.scale.setScalar(b.radius);
    const a = base + (i / 3) * Math.PI * 2 + (Math.random() - 0.5) * 0.55;
    const r = ringOuter + 3 + Math.random();
    b.mesh.position.set(Math.sin(a) * r, -(1 - BALL_EXPOSE) * b.radius, Math.cos(a) * r);
    b.intact = true;
    b.kicked.clear();
    b.mesh.visible = visible;
  }
}

/** Into `_hb`: the point of hull `h` nearest a round prop centred at `c` (plan view, car at px, pz), at height `y`. */
function nearestHullPoint(car: DeformableCar, h: Hull, c: THREE.Vector3, px: number, pz: number, y: number): void {
  const relx = (c.x - px) * car.rightFlat.x + (c.z - pz) * car.rightFlat.z;
  const relz = (c.x - px) * car.fwdFlat.x + (c.z - pz) * car.fwdFlat.z;
  const qx = THREE.MathUtils.clamp(relx, h.cx - h.hx, h.cx + h.hx);
  const qz = THREE.MathUtils.clamp(relz, h.cz - h.hz, h.cz + h.hz);
  _hb.set(px + car.rightFlat.x * qx + car.fwdFlat.x * qz, y, pz + car.rightFlat.z * qx + car.fwdFlat.z * qz);
}

/**
 * Half-buried ramp balls: ramp the car up a little, pop the nearest hub on a hard kick,
 * and log each first kick per car into `log` stamped with wall time `t`.
 */
export function resolveRampBalls(
  balls: readonly RampBall[],
  car: DeformableCar,
  debris: DebrisSystem,
  sparks: SparkSystem,
  fxDensity: number,
  t: number,
  log: Record<string, unknown>[],
): ContactHit | null {
  let hit: ContactHit | null = null;
  const px = car.group.position.x;
  const pz = car.group.position.z;
  const id = car.paint.name;
  for (const ball of balls) {
    if (!ball.intact) continue;
    const c = ball.mesh.position;
    for (const h of car.hulls()) {
      nearestHullPoint(car, h, c, px, pz, 0.28);
      const dx = _hb.x - c.x;
      const dz = _hb.z - c.z;
      const distXz = Math.hypot(dx, dz);
      const ringR = Math.sqrt(Math.max(1e-6, ball.radius * ball.radius * (1 - (1 - BALL_EXPOSE) * (1 - BALL_EXPOSE))));
      if (distXz > ringR + Math.hypot(h.hx, h.hz)) continue;
      const overlap = ringR + 0.22 - distXz;
      if (overlap <= 0) continue;
      if (distXz < 1e-4) continue;
      // Ramp: mostly planar, a little up — not a vertical rocket off the buried center.
      _mtv.set(dx / distXz, 0.18, dz / distXz).normalize();
      const push = Math.min(overlap * 0.35, 0.018);
      pushCar(car, _mtv.x, 0, _mtv.z, push);
      car.deform.notifyContact();

      const vn = car.velocity.x * _mtv.x + car.velocity.z * _mtv.z;
      const closing = -vn;
      if (!ball.kicked.has(id) && closing > 0.4) {
        ball.kicked.add(id);
        if (!car.deform.massActive) {
          car.deform.armMasses(car.group, car.velocity, car.angular);
        }
        // Ramp: bleed a little closing into up/side, keep most of the heading.
        const dv = Math.min(closing * 0.08, 3.2);
        car.velocity.x += _mtv.x * dv;
        car.velocity.z += _mtv.z * dv;
        car.velocity.y += Math.min(1.6, closing * 0.035);
        const jUp = THREE.MathUtils.clamp(closing * 1.6, 3, 14);
        const hub = car.deform.kickNearestHub(_hb, jUp);
        const broken = closing > 7.5 || overlap > 0.22;
        if (broken) {
          ball.intact = false;
          ball.mesh.visible = false;
          debris.burst(_hb, _mtv, Math.min(48, 14 + closing * 1.2) * fxDensity);
          sparks.poof(_hb, _mtv, Math.min(28, 8 + closing * 0.6) * fxDensity);
          if (hub) {
            const node = car.deform.masses.find((m) => m.name === hub);
            if (node) car.deform.popHub(node);
          }
        }
        log.push({
          t: round4(t),
          car: id,
          hub,
          closing: round4(closing),
          lift: round4(jUp / 26),
          overlap: round4(overlap),
          broken,
          pos: vec3(_hb),
          n: { x: round4(_mtv.x), y: round4(_mtv.y), z: round4(_mtv.z) },
        });
      }
      hit = { impulse: Math.max(closing, 2), contact: _hb.clone(), normal: _mtv.clone() };
    }
  }
  return hit;
}

/** Stand the six lamp posts back up on the 16 m ring. */
export function resetLampPoles(poles: readonly LampPole[], visible: boolean): void {
  for (let i = 0; i < poles.length; i++) {
    const pole = poles[i]!;
    const a = (i / 6) * Math.PI * 2;
    pole.intact = true;
    pole.kicked.clear();
    pole.group.visible = visible;
    pole.group.position.set(Math.sin(a) * 16, 0, Math.cos(a) * 16);
    pole.group.rotation.set(0, 0, 0);
  }
}

/** Thin lamp posts: shove the car, dent it on a hard hit, and fold over above 3.5 m/s. */
export function resolveLampPoles(
  poles: readonly LampPole[],
  car: DeformableCar,
  debris: DebrisSystem,
  sparks: SparkSystem,
  fxDensity: number,
): ContactHit | null {
  let hit: ContactHit | null = null;
  const px = car.group.position.x;
  const pz = car.group.position.z;
  const id = car.paint.name;
  for (const pole of poles) {
    if (!pole.intact) continue;
    const c = pole.group.position;
    for (const h of car.hulls()) {
      nearestHullPoint(car, h, c, px, pz, 0.4);
      _mtv.set(_hb.x - c.x, 0, _hb.z - c.z);
      const dist = Math.hypot(_mtv.x, _mtv.z);
      if (dist >= pole.radius + 0.04 || dist < 1e-5) continue;
      _mtv.multiplyScalar(1 / dist);
      const overlap = pole.radius + 0.04 - dist;
      pushCar(car, _mtv.x, 0, _mtv.z, Math.min(overlap, 0.04));
      car.deform.notifyContact();
      const vn = car.velocity.x * _mtv.x + car.velocity.z * _mtv.z;
      const closing = -vn;
      if (!pole.kicked.has(id) && closing > 0.8) {
        pole.kicked.add(id);
        const j = THREE.MathUtils.clamp(closing * 40, 80, 400);
        impulseCar(car, _mtv.x, 0, _mtv.z, j);
        if (!car.deform.massActive && closing > 4) {
          car.applyImpact(_hb, _mtv, closing, closing);
        } else if (car.deform.massActive) {
          car.deform.kickNearest(_hb, _mtv.x, 0.15, _mtv.z, closing * 8);
        }
        if (closing > 3.5) {
          pole.intact = false;
          pole.group.rotation.z = Math.atan2(_mtv.x, _mtv.z) ? 1.15 * Math.sign(_mtv.x || 1) : 1.15;
          pole.group.rotation.x = _mtv.z > 0 ? -1.05 : 1.05;
          debris.burst(_hb, _mtv, Math.min(40, 10 + closing) * fxDensity);
          sparks.poof(_hb, _mtv, Math.min(22, 6 + closing * 0.5) * fxDensity);
        }
      }
      hit = { impulse: Math.max(closing, 2), contact: _hb.clone(), normal: _mtv.clone() };
    }
  }
  return hit;
}

/** Two steel plates closing on the parked car along ±Z. */
export class CompactorPress {
  readonly group = new THREE.Group();
  private front: THREE.Mesh;
  private rear: THREE.Mesh;

  constructor(scene: THREE.Scene, face: number) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x6a6e76,
      roughness: 0.48,
      metalness: 0.72,
    });
    const geo = new THREE.BoxGeometry(3.6, 2.05, 0.48);
    this.front = new THREE.Mesh(geo, mat);
    this.rear = new THREE.Mesh(geo, mat);
    this.front.castShadow = true;
    this.rear.castShadow = true;
    this.front.receiveShadow = true;
    this.rear.receiveShadow = true;
    this.group.add(this.front, this.rear);
    this.group.visible = false;
    scene.add(this.group);
    this.sync(face);
  }

  /** Place the plate faces at ±`face` (plate inner surface). */
  sync(face: number): void {
    const z = face + 0.24;
    this.front.position.set(0, 1.02, z);
    this.rear.position.set(0, 1.02, -z);
  }
}
