import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { CAR_HALF, WHEEL_POS } from "../vehicle/car-mesh.ts";

/**
 * The corkscrew scene's channel (owner's Hot Wheels sketch): a floor between two walls that rises along +z from a
 * flat mouth and twists about its own centreline at a constant rate, so a car leaving the lip carries that roll
 * rate into the air: speed decides how far it turns before it comes down.
 *
 * The scene owns its car from the mouth to rest (`step`), because the wreck model can neither fly nor lie on its
 * roof (its group is held 0.12 m over the ground and its roll to ±0.5 rad). On the floor the car is glued to the
 * channel's frame and only gravity acts along it (too slow and it rolls back out); off the lip it is a rigid body
 * spinning at the floor's twist rate; on the pad it settles onto its wheels or its roof, whichever is nearer,
 * slides to a stop and, upright, goes back to the normal sim to be driven.
 */
export const CORKSCREW = {
  /** World z of the mouth (x = 0, the channel heads +z). */
  mouthZ: -34,
  /** Floor length along the centreline (m). */
  len: 12,
  /** Exit climb (rad, ~29°), reached at `rise` and held to the lip (no pitch rate there). */
  climb: 0.5,
  rise: 7,
  /** The bank starts at `twistFrom`, its rate easing up over `twistEase` (a sudden twist sank the nose's high
   *  corner 0.2 m into the floor), then turns at a constant rate to `bank` (rad, ~86°) at the lip. */
  twistFrom: 1,
  twistEase: 3,
  bank: 1.5,
  /** Half the floor's width between the walls, and the walls' height off the floor (m). */
  halfW: 1.7,
  wallH: 0.9,
} as const;

const G = 9.6;
const STEP = 0.05;
const N_SAMPLES = Math.round(CORKSCREW.len / STEP) + 1;
const TWIST_RATE = CORKSCREW.bank / (CORKSCREW.len - CORKSCREW.twistFrom - CORKSCREW.twistEase / 2);
/** The body's centre stops this far (m) from the centreline: its side 0.3 m off a wall, where the twist swings a
 *  rigid body's far corners (a twist of 0.33 rad over 2 m tips the beltline 0.3 m out). */
const D_MAX = CORKSCREW.halfW - CAR_HALF.x - 0.3;
/** The axles' half spread along the run (`WHEEL_POS`): the body lies on the chord between them. */
const AXLE = WHEEL_POS[0]![2];
/** Settle on the pad: rate (1/s) the body eases onto its wheels or roof, and how fast it stops (m/s²). */
const SETTLE = 7;
const ROLL_DECEL = 2.5;
const SCRAPE_DECEL = 6;
/** Car-local body points that meet the ground or the floor: bumper and beltline corners, roof corners. */
const BODY: readonly (readonly [number, number, number])[] = [-1, 1].flatMap((sx) =>
  [-1, 1].flatMap((sz): [number, number, number][] => [
    [sx * CAR_HALF.x, 0.35, sz * CAR_HALF.z],
    [sx * CAR_HALF.x, 0.95, sz * 2.0],
    [sx * 0.7, 1.36, sz * 0.95],
  ]),
);
/** ... and the tyre contacts: every point the pad can touch. */
const HULL: readonly (readonly [number, number, number])[] = [...BODY, ...WHEEL_POS.map(([x, , z]): [number, number, number] => [x, 0, z])];

/** Centreline height and run (local z) at each `STEP` of floor, from the climb's profile. */
const PROFILE_Y = new Float64Array(N_SAMPLES);
const PROFILE_Z = new Float64Array(N_SAMPLES);
for (let i = 1; i < N_SAMPLES; i++) {
  const th = climbAt((i - 0.5) * STEP);
  PROFILE_Y[i] = PROFILE_Y[i - 1]! + Math.sin(th) * STEP;
  PROFILE_Z[i] = PROFILE_Z[i - 1]! + Math.cos(th) * STEP;
}

function climbAt(s: number): number {
  const t = Math.max(0, Math.min(1, s / CORKSCREW.rise));
  return CORKSCREW.climb * t * t * (3 - 2 * t);
}

function bankAt(s: number): number {
  const a = s - CORKSCREW.twistFrom;
  const e = CORKSCREW.twistEase;
  if (a <= 0) return 0;
  return Math.min(CORKSCREW.bank, a < e ? (TWIST_RATE * a * a) / (2 * e) : TWIST_RATE * (a - e / 2));
}

/** World centreline point at floor distance `s`; before the mouth the flat pad, past the lip the lip's line. */
function centre(s: number, out: THREE.Vector3): THREE.Vector3 {
  const last = N_SAMPLES - 1;
  const f = Math.max(0, Math.min(last, s / STEP));
  const i = Math.min(last - 1, Math.floor(f));
  const t = f - i;
  out.set(0, PROFILE_Y[i]! + (PROFILE_Y[i + 1]! - PROFILE_Y[i]!) * t, CORKSCREW.mouthZ + PROFILE_Z[i]! + (PROFILE_Z[i + 1]! - PROFILE_Z[i]!) * t);
  if (s < 0) out.z += s;
  else if (s > CORKSCREW.len) {
    const k = s - CORKSCREW.len;
    out.y += Math.sin(CORKSCREW.climb) * k;
    out.z += Math.cos(CORKSCREW.climb) * k;
  }
  return out;
}

/** The floor's frame at `s`: tangent `t` (up the run), across `b` (the car's left), up `n` (the floor normal). */
function frame(s: number, b: THREE.Vector3, n: THREE.Vector3, t: THREE.Vector3): void {
  const th = climbAt(s);
  const ph = bankAt(s);
  const ct = Math.cos(th);
  const st = Math.sin(th);
  const cp = Math.cos(ph);
  const sp = Math.sin(ph);
  t.set(0, st, ct);
  // Unbanked across (1, 0, 0) and up (0, cos, −sin), turned by the bank about t: the left side rises.
  b.set(cp, sp * ct, -sp * st);
  n.set(-sp, cp * ct, -cp * st);
}

type Phase = "free" | "ramp" | "air" | "ground" | "rest";

const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _c = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _rot = new THREE.Quaternion();
const _goal = new THREE.Quaternion();

export class Corkscrew {
  readonly group = new THREE.Group();
  phase: Phase = "free";
  /** Floor distance and speed along it; offset across it (+ = left wall) and its rate. */
  private s = 0;
  private v = 0;
  private d = 0;
  private vd = 0;
  /** Spin carried off the lip (rad/s, world). */
  readonly omega = new THREE.Vector3();
  /** This run: seconds in the air, angle turned in the air (rad), deepest body point under the floor and farthest
   *  past a wall while on it (m; ≤ 0 is clean), launch speed into the mouth (m/s). */
  airTime = 0;
  airTurn = 0;
  floorDip = -Infinity;
  wallOver = -Infinity;
  entrySpeed = 0;
  /** Set on the slice the car leaves the lip / first meets the pad after flying (the engine's slow-mo and impact). */
  tookOff = false;
  landed: { at: THREE.Vector3; speed: number } | null = null;
  /** The run is over: the car rests on its roof, or upright it went back to the normal sim. */
  finished = false;

  constructor(scene: THREE.Scene) {
    this.build();
    this.group.visible = false;
    scene.add(this.group);
  }

  reset(): void {
    this.phase = "free";
    this.airTime = 0;
    this.airTurn = 0;
    this.floorDip = -Infinity;
    this.wallOver = -Infinity;
    this.entrySpeed = 0;
    this.tookOff = false;
    this.landed = null;
    this.finished = false;
    this.omega.set(0, 0, 0);
  }

  /** One physics slice of `car`: true while the corkscrew moves it (the world step leaves it alone). */
  step(car: DeformableCar, dt: number): boolean {
    if (this.phase === "free" && !this.capture(car)) return false;
    if (this.phase === "ramp") this.ride(car, dt);
    else if (this.phase === "air") this.fly(car, dt);
    else if (this.phase === "ground") this.settle(car, dt);
    return this.phase !== "free";
  }

  /** A driven car rolling into the mouth goes onto the floor. */
  private capture(car: DeformableCar): boolean {
    const p = car.group.position;
    const lz = p.z - CORKSCREW.mouthZ;
    if (car.crashed || car.deform.massActive || lz < 0 || lz > 0.6 || Math.abs(p.x) > D_MAX || p.y > 0.3 || car.velocity.z < 0.5) return false;
    this.s = lz;
    this.v = car.velocity.z;
    this.d = p.x;
    this.vd = car.velocity.x;
    this.entrySpeed = this.v;
    this.phase = "ramp";
    return true;
  }

  /** On the floor: gravity along the run and across it, the walls hold the body. */
  private ride(car: DeformableCar, dt: number): void {
    frame(this.s, _b, _n, _t);
    this.v -= G * _t.y * dt;
    this.vd -= G * _b.y * dt;
    this.s += this.v * dt;
    this.d += this.vd * dt;
    if (this.d > D_MAX || this.d < -D_MAX) {
      this.d = Math.sign(this.d) * D_MAX;
      if (this.vd * this.d > 0) this.vd = 0;
    }
    if (this.s < 0) {
      // Too slow: rolled back out of the mouth onto the pad.
      this.place(car, 0);
      car.velocity.set(this.vd, 0, this.v);
      this.phase = "ground";
      return;
    }
    if (this.s >= CORKSCREW.len) {
      this.place(car, CORKSCREW.len);
      frame(CORKSCREW.len, _b, _n, _t);
      car.velocity.copy(_t).multiplyScalar(this.v).addScaledVector(_b, this.vd);
      this.omega.copy(_t).multiplyScalar(this.v * TWIST_RATE);
      car.angular.copy(this.omega);
      this.phase = "air";
      this.tookOff = true;
      this.resetWheels(car);
      return;
    }
    this.place(car, this.s);
    car.velocity.copy(_t).multiplyScalar(this.v).addScaledVector(_b, this.vd);
    car.angular.copy(_t).multiplyScalar(this.s > CORKSCREW.twistFrom ? this.v * TWIST_RATE : 0);
    car.speed = Math.abs(this.v);
    this.suspend(car);
    this.sync(car);
  }

  /**
   * The car on the floor at `s` (offset `d`): its axles on the floor, the body on their chord (a tangent at the
   * centre sank the bumpers 0.3 m into the curving rise), rolled to the floor's bank at `s`. Leaves `frame(s)`.
   */
  private place(car: DeformableCar, s: number): void {
    frame(s + AXLE, _b, _n, _t);
    centre(s + AXLE, _x).addScaledVector(_b, this.d);
    frame(s - AXLE, _b, _n, _t);
    centre(s - AXLE, _y).addScaledVector(_b, this.d);
    car.group.position.addVectors(_x, _y).multiplyScalar(0.5);
    _z.subVectors(_x, _y).normalize();
    frame(s, _b, _n, _t);
    _y.copy(_n).addScaledVector(_z, -_n.dot(_z)).normalize();
    _x.crossVectors(_y, _z);
    car.group.quaternion.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
  }

  /**
   * Each wheel down (or up) to the twisted floor under it along the body's up, as a suspension would; and the
   * run's containment: the deepest body point under the floor and the farthest past a wall.
   */
  private suspend(car: DeformableCar): void {
    const pos = car.group.position;
    const q = car.group.quaternion;
    for (let i = 0; i < car.wheels.length; i++) {
      const [wx, , wz] = WHEEL_POS[i]!;
      const gap = this.floorGap(_p.set(wx, 0, wz).applyQuaternion(q).add(pos), this.s + wz);
      car.wheels[i]!.position.y = WHEEL_POS[i]![1] - Math.max(-0.3, Math.min(0.3, gap));
    }
    for (const [hx, hy, hz] of BODY) {
      // Over the floor only: past the mouth or the lip there is no floor or wall to cross.
      const s = this.s + hz;
      if (s < 0 || s > CORKSCREW.len) continue;
      _p.set(hx, hy, hz).applyQuaternion(q).add(pos);
      frame(s, _b, _n, _t);
      centre(s, _c);
      _q.subVectors(_p, _c);
      this.floorDip = Math.max(this.floorDip, -_q.dot(_n));
      this.wallOver = Math.max(this.wallOver, Math.abs(_q.dot(_b)) - CORKSCREW.halfW);
    }
  }

  /** Height of world point `p` over the floor (or the pad before it, the lip's plane past it) at `s`, along its normal. */
  private floorGap(p: THREE.Vector3, s: number): number {
    frame(s, _b, _n, _t);
    return _q.subVectors(p, centre(s, _c)).dot(_n);
  }

  /** Off the lip: a rigid body under gravity, spinning at the twist rate it left with, until it meets the pad. */
  private fly(car: DeformableCar, dt: number): void {
    const pos = car.group.position;
    car.velocity.y -= G * dt;
    pos.addScaledVector(car.velocity, dt);
    const w = this.omega.length();
    if (w > 1e-9) car.group.quaternion.premultiply(_rot.setFromAxisAngle(_p.copy(this.omega).multiplyScalar(1 / w), w * dt));
    this.airTime += dt;
    this.airTurn += w * dt;
    const low = this.lowest(car);
    if (low <= 0) {
      pos.y -= low;
      this.landed = { at: _c.clone(), speed: Math.hypot(car.velocity.y, Math.hypot(car.velocity.x, car.velocity.z) * 0.25) };
      car.velocity.y = 0;
      this.phase = "ground";
    }
    car.speed = car.velocity.length();
    this.sync(car);
  }

  /** World height of the car's lowest hull point (its position left in `_c`). */
  private lowest(car: DeformableCar): number {
    let low = Infinity;
    for (const [hx, hy, hz] of HULL) {
      _p.set(hx, hy, hz).applyQuaternion(car.group.quaternion).add(car.group.position);
      if (_p.y < low) {
        low = _p.y;
        _c.copy(_p);
      }
    }
    return low;
  }

  /** On the pad: ease onto the wheels or the roof (whichever is nearer), slide to a stop, then hand back or rest. */
  private settle(car: DeformableCar, dt: number): void {
    const q = car.group.quaternion;
    const upright = _y.set(0, 1, 0).applyQuaternion(q).y >= 0;
    const v = car.velocity;
    _z.set(0, 0, 1).applyQuaternion(q);
    _z.y = 0;
    if (_z.lengthSq() < 0.04) _z.set(v.x, 0, v.z);
    if (_z.lengthSq() < 1e-6) _z.set(0, 0, 1);
    _z.normalize();
    _y.set(0, upright ? 1 : -1, 0);
    _x.crossVectors(_y, _z);
    _goal.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
    q.slerp(_goal, 1 - Math.exp(-SETTLE * dt));
    const h = Math.hypot(v.x, v.z);
    const k = h > 1e-9 ? Math.max(0, h - (upright ? ROLL_DECEL : SCRAPE_DECEL) * dt) / h : 0;
    v.set(v.x * k, 0, v.z * k);
    car.group.position.addScaledVector(v, dt);
    car.group.position.y -= this.lowest(car);
    this.omega.set(0, 0, 0);
    car.angular.set(0, 0, 0);
    car.speed = h * k;
    if (h * k < 0.05 && q.angleTo(_goal) < 0.02) {
      q.copy(_goal);
      if (upright) this.release(car);
      else this.phase = "rest";
      this.finished = true;
    }
    this.sync(car);
  }

  /** Upright and stopped: back to the normal sim, a driven car at rest where it stands. */
  private release(car: DeformableCar): void {
    const yaw = Math.atan2(_z.x, _z.z);
    car.yaw = yaw;
    car.pitch = 0;
    car.roll = 0;
    car.group.position.y = 0;
    car.group.rotation.set(0, yaw, 0, "YXZ");
    car.velocity.set(0, 0, 0);
    car.speed = 0;
    this.resetWheels(car);
    this.phase = "free";
  }

  private resetWheels(car: DeformableCar): void {
    for (let i = 0; i < car.wheels.length; i++) car.wheels[i]!.position.y = WHEEL_POS[i]![1];
  }

  private sync(car: DeformableCar): void {
    car.refreshBasis();
    car.deform.bindKinematic(car.group, car.velocity, car.angular);
  }

  /** Floor, walls and the timber support under them, one strip each along the run. */
  private build(): void {
    const n = N_SAMPLES;
    const floor: number[] = [];
    const walls: number[] = [];
    const support: number[] = [];
    const w = CORKSCREW.halfW;
    for (let i = 0; i < n; i++) {
      const s = i * STEP;
      frame(s, _b, _n, _t);
      centre(s, _c);
      for (const side of [-1, 1]) {
        _p.copy(_c).addScaledVector(_b, side * w);
        floor.push(_p.x, _p.y, _p.z);
        walls.push(_p.x, _p.y, _p.z, _p.x + _n.x * CORKSCREW.wallH, _p.y + _n.y * CORKSCREW.wallH, _p.z + _n.z * CORKSCREW.wallH);
        support.push(_p.x, _p.y, _p.z, _p.x, 0, _p.z);
      }
    }
    const red = new THREE.MeshStandardMaterial({ color: 0xb8402e, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
    const wood = new THREE.MeshStandardMaterial({ color: 0xc9a46a, roughness: 0.9, side: THREE.DoubleSide });
    // Floor: one quad per step across (left, right); walls and support: one quad per step per side (edge, far edge).
    this.strip(floor, n, 2, [[0, 1]], red);
    this.strip(walls, n, 4, [[0, 1], [2, 3]], red);
    this.strip(support, n, 4, [[0, 1], [2, 3]], wood);
  }

  /** Quads between consecutive samples: `per` vertices per sample, `pairs` the vertex pairs that span each quad. */
  private strip(verts: number[], n: number, per: number, pairs: readonly (readonly [number, number])[], mat: THREE.Material): void {
    const index: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      for (const [a, b] of pairs) {
        const a0 = i * per + a;
        const b0 = i * per + b;
        index.push(a0, b0, a0 + per, b0, b0 + per, a0 + per);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }
}
