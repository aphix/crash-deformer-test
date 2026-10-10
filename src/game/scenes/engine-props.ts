import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { keelY } from "../vehicle/car-cage-rig.ts";
import { applyGroundFriction, leftoverCrumple } from "../deform/physics-util.ts";
import { C_PY, HIT_SIZE } from "../world/surfaces.ts";
import { BARRIER_HALF, BARRIER_MASS, BARRIER_TOP, clipCarToBarrier } from "../contact/sat.ts";
import { strikeCar, bodyHit, makeBox, type ContactBox } from "../contact/external-contact.ts";
import { detSin, detCos, hypot2, hypot3 } from "../kernel/physics-core.js";

/** Fraction of a ramp ball's diameter left above the asphalt. */
export const BALL_EXPOSE = 0.25;
/** A body with no wheel contact to read (in flight, a wreck on its masses) clears the slab with its origin this high (m). */
const FLIGHT_CLEAR = BARRIER_TOP - 0.3;

const _sp = new THREE.Vector3();
const _qi = new THREE.Quaternion();
const _cn = new THREE.Vector3();
const _cp = new THREE.Vector3();
/** The slab's top clipped to a car's plan box, as car-local corners (x, y, z; at most 8). */
const _poly = new Float64Array(24);
const _clip = new Float64Array(24);

/** The part of polygon `src` (`n` corners) where `sign` × its coordinate `axis` is at most `limit`, into `dst`; returns its corner count. */
function clipAxis(src: Float64Array, n: number, axis: number, sign: number, limit: number, dst: Float64Array): number {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const a = i * 3;
    const b = ((i + 1) % n) * 3;
    const da = sign * src[a + axis]! - limit;
    const db = sign * src[b + axis]! - limit;
    if (da <= 0) {
      dst[m * 3] = src[a]!;
      dst[m * 3 + 1] = src[a + 1]!;
      dst[m * 3 + 2] = src[a + 2]!;
      m++;
    }
    if (da <= 0 !== db <= 0) {
      const t = da / (da - db);
      dst[m * 3] = src[a]! + (src[b]! - src[a]!) * t;
      dst[m * 3 + 1] = src[a + 1]! + (src[b + 1]! - src[a + 1]!) * t;
      dst[m * 3 + 2] = src[a + 2]! + (src[b + 2]! - src[a + 2]!) * t;
      m++;
    }
  }
  return m;
}

export type ContactHit = { impulse: number; contact: THREE.Vector3; normal: THREE.Vector3 };

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
const _bRight = new THREE.Vector3();
const _bFwd = new THREE.Vector3();

/** Where a predicted hit lands: the point (a bumper's height above the ground) and the flat unit line the two meet along (`pairEta`: car a → car b; `contactEta`: car → slab). */
export type PredictedHit = { x: number; y: number; z: number; nx: number; nz: number };

/** `hit`: where `car` (moving on) meets the slab face along `axis`, `toward` (±1) the face's side: its footprint's edge `reach` ahead of its centre, `t` s on. */
function predictFace(hit: PredictedHit, car: DeformableCar, t: number, axis: THREE.Vector3, toward: number, reach: number): void {
  hit.x = car.group.position.x + car.velocity.x * t + axis.x * toward * reach;
  hit.y = car.group.position.y + 0.4;
  hit.z = car.group.position.z + car.velocity.z * t + axis.z * toward * reach;
  hit.nx = axis.x * toward;
  hit.nz = axis.z * toward;
}

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
  /** The slab's mass (kg): a held slab (a scenario's rigid wall) is `Infinity`, a kinematic striker like every fixed solid. */
  kg = BARRIER_MASS;
  /** Car-side face normal from the last `striker`. */
  private readonly faceN = new THREE.Vector3();
  /** The slab as a striker, rewritten for each car (`striker`). */
  private readonly box = makeBox();

  /** `group` is the slab's mesh from the scene that owns it; headless scenarios pass a bare group. */
  constructor(scene: THREE.Scene, group: THREE.Group) {
    this.group = group;
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Face the slab broadside to the lead car's approach line, or (`endOn`, the fleet ramps on its ends) along it. */
  orient(a: THREE.Vector3, endOn = false): void {
    const len = hypot2(a.x, a.z);
    if (len < 0.01) {
      this.yaw = 0;
    } else {
      const nx = a.x / len;
      const nz = a.z / len;
      this.yaw = Math.atan2(-nz, nx);
    }
    if (endOn) this.yaw += Math.PI / 2;
    this.group.rotation.y = this.yaw;
  }

  reset(): void {
    this.vel.set(0, 0, 0);
    this.crush = 0;
    this.group.position.set(0, 0, 0);
    // Undo the dents (`indent`): every mesh back to its rest positions.
    this.group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const rest = obj.userData.rest as Float32Array | undefined;
      if (!rest) return;
      const geo = obj.geometry as THREE.BufferGeometry;
      const attr = geo.getAttribute("position") as THREE.BufferAttribute;
      (attr.array as Float32Array).set(rest);
      attr.needsUpdate = true;
      geo.computeVertexNormals();
    });
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

  /** Mass-level slab contact (no crush), then the cabin tunnelling floor. */
  clip(car: DeformableCar): void {
    if (this.over(car)) return;
    strikeCar(car, this.striker(car), 0, false);
    clipCarToBarrier(car, this.yaw, this.group.position, this.hx(), leftoverCrumple(car.deform.slabTravel()));
  }

  /**
   * The slab meets a car until the car is over it: a driven car clears while a wheel that is down stands higher than the slab's top
   * (up a fleet ramp beside the slab's end, on its top: that wheel's contact point, `wheelHit`) or while the slab's top, where it is
   * under the car's plan, is under the car's underside (a car straddling a ramp's edge crosses the slab's end with its high side, its
   * low wheels still on the floor beside it); a body with no wheel contact to read clears by its origin's height. A car on the ground
   * never clears.
   */
  private over(car: DeformableCar): boolean {
    if (car.airborne || car.deform.massActive) return car.group.position.y > FLIGHT_CLEAR;
    for (let i = 0; i < 4; i++) if (((car.wheelsDown >> i) & 1) !== 0 && car.wheelHit[i * HIT_SIZE + C_PY]! > BARRIER_TOP) return true;
    const o = this.group.position;
    const p = car.group.position;
    _qi.copy(car.group.quaternion).invert();
    const ax = detCos(this.yaw);
    const az = -detSin(this.yaw);
    const hx = this.hx();
    for (let k = 0; k < 4; k++) {
      const u = k === 1 || k === 2 ? hx : -hx;
      const v = k < 2 ? -BARRIER_HALF.z : BARRIER_HALF.z;
      _sp.set(o.x + u * ax - v * az - p.x, BARRIER_TOP - p.y, o.z + u * az + v * ax - p.z).applyQuaternion(_qi);
      _poly[k * 3] = _sp.x;
      _poly[k * 3 + 1] = _sp.y;
      _poly[k * 3 + 2] = _sp.z;
    }
    const plan = car.cage.fields.planBox;
    let n = clipAxis(_poly, 4, 0, 1, plan[1]!, _clip);
    n = clipAxis(_clip, n, 0, -1, -plan[0]!, _poly);
    n = clipAxis(_poly, n, 2, 1, plan[3]!, _clip);
    n = clipAxis(_clip, n, 2, -1, -plan[2]!, _poly);
    const low = keelY(car);
    // The slab's top is under none of the car's box: the car is beside the slab and clears it only with its box's bottom corner nearest the
    // slab over the slab's top. The plan footprint overstates a pitched box's reach (a monster nose-up 17° at a ramp's high end read 0.1 m
    // into the end of a slab its nose was 0.4 m above, and crashed); a level body beside the slab is under its top and meets it (a monster
    // sliding sideways past the slab's end, read clear, met it only once its box was over the face, where the cabin floor took its speed).
    if (n === 0) {
      let nearest = Infinity;
      let clear = false;
      for (let k = 0; k < 4; k++) {
        _sp.set(k < 2 ? plan[0]! : plan[1]!, low, k % 2 === 0 ? plan[2]! : plan[3]!).applyQuaternion(car.group.quaternion).add(p);
        const dx = _sp.x - o.x;
        const dz = _sp.z - o.z;
        const across = Math.max(0, Math.abs(dx * ax + dz * az) - hx);
        const along = Math.max(0, Math.abs(dz * ax - dx * az) - BARRIER_HALF.z);
        const gap = across * across + along * along;
        if (gap < nearest) {
          nearest = gap;
          clear = _sp.y >= BARRIER_TOP;
        }
      }
      return clear;
    }
    for (let k = 0; k < n; k++) if (_poly[k * 3 + 1]! > low) return false;
    return true;
  }

  /**
   * The slab as a striker facing `car`: its car-side face is the way it pushes (`faceN`), its thickness the dented one, its speed and its
   * mass its own (14 t: the car's crush takes nearly all of the hit's energy, and the slab slides a little), its face rigid. The one
   * contact every striker goes through (`strikeCar`), as the press plates, the pistons and every fixed prop do.
   */
  private striker(car: DeformableCar): ContactBox {
    const o = this.group.position;
    const rx = detCos(this.yaw);
    const rz = -detSin(this.yaw);
    const side = (car.group.position.x - o.x) * rx + (car.group.position.z - o.z) * rz >= 0 ? 1 : -1;
    this.faceN.set(rx * side, 0, rz * side);
    const box = this.box;
    box.x = o.x;
    box.y = 0.48;
    box.z = o.z;
    box.hx = BARRIER_HALF.z;
    box.hy = BARRIER_TOP / 2;
    box.hz = this.hx();
    box.yaw = Math.atan2(this.faceN.x, this.faceN.z);
    box.vx = this.vel.x;
    box.vz = this.vel.z;
    box.kg = this.kg;
    box.hardness = 1;
    box.fixed = true;
    return box;
  }

  /**
   * The car meets the slab: `arm` starts or re-arms its crash at the face's closing speed, `feed` spends the hit's stroke (the slab's
   * reaction slides it). Returns the hit for the cinematic and the FX while the car's hulls are in the slab.
   */
  resolve(car: DeformableCar, arm: boolean, feed: boolean, dt: number): ContactHit | null {
    if (this.over(car)) return null;
    const taken = strikeCar(car, this.striker(car), dt, feed, arm);
    this.vel.addScaledVector(this.faceN, -taken / this.kg);
    if (!bodyHit.touching) return null;
    _cp.set(bodyHit.x, 0.48, bodyHit.z);
    _cn.set(bodyHit.nx, 0, bodyHit.nz);
    if (feed && bodyHit.depth > 0) this.indent(_cp, _cn, Math.min(0.012, bodyHit.depth * 0.12));
    this.clip(car);
    return bodyHit.depth > 0.001 ? { impulse: Math.max(bodyHit.closing, 0.5), contact: _cp, normal: _cn } : null;
  }

  /** True when the slab sits between this pair so they must not SAT through it. */
  blocksPair(a: DeformableCar, b: DeformableCar): boolean {
    _bRight.set(detCos(this.yaw), 0, -detSin(this.yaw));
    const ax = a.group.position.x * _bRight.x + a.group.position.z * _bRight.z;
    const bx = b.group.position.x * _bRight.x + b.group.position.z * _bRight.z;
    const pad = BARRIER_HALF.x + 0.2;
    return ax * bx < 0 && Math.abs(ax) > pad && Math.abs(bx) > pad;
  }

  /** Earliest time-to-contact of any car closing on the slab faces, folded into `eta`; `hit` gets the point and the face line (car → slab) of the one that lowers it. */
  contactEta(cars: readonly DeformableCar[], eta: number, hit?: PredictedHit): number {
    _bRight.set(detCos(this.yaw), 0, -detSin(this.yaw));
    _bFwd.set(detSin(this.yaw), 0, detCos(this.yaw));
    for (const car of cars) {
      const px = car.group.position.x;
      const pz = car.group.position.z;
      const lx = px * _bRight.x + pz * _bRight.z;
      const lz = px * _bFwd.x + pz * _bFwd.z;
      const plan = car.cage.fields.planBox;
      const halfX = (plan[1]! - plan[0]!) / 2;
      const halfZ = (plan[3]! - plan[2]!) / 2;
      const rX =
        Math.abs(car.right.x * _bRight.x + car.right.z * _bRight.z) * halfX +
        Math.abs(car.forward.x * _bRight.x + car.forward.z * _bRight.z) * halfZ;
      const rZ =
        Math.abs(car.right.x * _bFwd.x + car.right.z * _bFwd.z) * halfX +
        Math.abs(car.forward.x * _bFwd.x + car.forward.z * _bFwd.z) * halfZ;
      const vLx = car.velocity.x * _bRight.x + car.velocity.z * _bRight.z;
      const vLz = car.velocity.x * _bFwd.x + car.velocity.z * _bFwd.z;
      const gapX = Math.abs(lx) - BARRIER_HALF.x - rX;
      const gapZ = Math.abs(lz) - BARRIER_HALF.z - rZ;
      const towardX = -(lx >= 0 ? 1 : -1) * vLx;
      const towardZ = -(lz >= 0 ? 1 : -1) * vLz;
      if (towardX > 0.4 && gapZ < 0.55) {
        const t = Math.max(0, gapX) / towardX;
        if (t < eta && hit) predictFace(hit, car, t, _bRight, lx >= 0 ? -1 : 1, rX);
        eta = Math.min(eta, t);
      }
      if (towardZ > 0.4 && gapX < 0.55) {
        const t = Math.max(0, gapZ) / towardZ;
        if (t < eta && hit) predictFace(hit, car, t, _bFwd, lz >= 0 ? -1 : 1, rZ);
        eta = Math.min(eta, t);
      }
    }
    return eta;
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
        const dist = hypot3(dx, dy, dz);
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

/** Put the three balls on their ring; every pick comes from `rng`, so a seed lays them out the same way each time. */
export function scatterRampBalls(balls: readonly RampBall[], visible: boolean, rng: () => number): void {
  const ringOuter = 2.32;
  const base = rng() * Math.PI * 2;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i]!;
    b.radius = 0.68 + rng() * 0.24;
    b.mesh.scale.setScalar(b.radius);
    const a = base + (i / 3) * Math.PI * 2 + (rng() - 0.5) * 0.55;
    const r = ringOuter + 3 + rng();
    b.mesh.position.set(detSin(a) * r, -(1 - BALL_EXPOSE) * b.radius, detCos(a) * r);
    b.intact = true;
    b.kicked.clear();
    b.mesh.visible = visible;
  }
}


/** Stand the six lamp posts back up on the 16 m ring (shown or hidden as they were). */
export function resetLampPoles(poles: readonly LampPole[]): void {
  for (let i = 0; i < poles.length; i++) {
    const pole = poles[i]!;
    const a = (i / 6) * Math.PI * 2;
    pole.intact = true;
    pole.kicked.clear();
    pole.group.position.set(detSin(a) * 16, 0, detCos(a) * 16);
    pole.group.rotation.set(0, 0, 0);
  }
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
