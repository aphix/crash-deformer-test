import * as THREE from "three";
import type { PropTumble } from "../present/prop-tumble.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { G } from "../vehicle/car-air.ts";
import { propContact, type PropHits } from "../contact/prop-contact.ts";
import type { ContactHit } from "../scenes/engine-props.ts";
import { BOARD, heldPose, labColliders, labGround, labPlaced, labSurfaces, LAB_LAYOUTS, type LabItem, type LabLayout, type LabPresetId, type LabSurface } from "../scenes/lab.ts";
import type { CarType } from "../scenes/fleet.ts";
import type { Ground } from "../world/ground.ts";
import type { Placed, PropCollider } from "../world/placements.ts";

/** Sim seconds after the first contact at which the throw's "after" speeds are read: the hit's pulse is over (crash pulses run 60–120 ms). */
const AFTER_S = 0.3;
/** A car moved this far (m) from where it stood when the throw left, or tipped past `UPRIGHT`, has fallen. */
const FELL_M = 0.3;
const UPRIGHT = 0.9;
/** Path samples: one per `PATH_S` sim seconds, `PATH_N` of them (10 s). */
const PATH_S = 1 / 60;
const PATH_N = 600;
/** Throw target `-1`: the wall the pegboard hangs on; `-2`: nothing, a free throw (`flick`). */
export const WALL = -1;
export const FREE = -2;
/** A free throw (`flick` at `FREE`) leaves this far (rad) above level. */
const FREE_LIFT = 0.15;

/** One throw's readback (`Lab.throwAt`): what the physics did, read off the sim. Positions and speeds are m and m/s, times sim s from the launch. */
export type LabShot = {
  thing: number;
  target: number;
  launch: THREE.Vector3;
  spin: number;
  /** The thing's first contact with anything but the ground: when, where, the normal out of what it met, and what (a layout index, `WALL`). Null: none yet. */
  contactS: number | null;
  contactAt: THREE.Vector3;
  normal: THREE.Vector3;
  hit: number | null;
  /** The thing's speed at the last step before the contact and `AFTER_S` after it (null until then). */
  speedBefore: number;
  speedAfter: number | null;
  /** Thing and target: their speeds along `normal` before the contact (the target's is 0 for a fixed solid), and after. */
  closingBefore: number;
  closingAfter: number | null;
  /** −(closing after) / (closing before): 0 a dead stop together, 1 elastic. Null until `AFTER_S`. */
  restitution: number | null;
  /**
   * Momentum (kg m/s) of the thrown car and a target car together along the launch's plan direction (the bench carries the
   * vertical): the step before the contact, and at the pulse's end (`pulseS` after it: the pair stopped closing, at most `AFTER_S`).
   */
  momentumBefore: number;
  momentumAfter: number | null;
  pulseS: number | null;
  /** Peak crush (m) of the thrown car and of a target car since the launch (`crushAmount`, the sensors' compression). */
  crush: number;
  targetCrush: number;
  /** Layout indices of the items knocked off where they stood at the launch: cars moved over `FELL_M` or tipped, props knocked. */
  fell: number[];
  /** Thing and target positions every `PATH_S` (x, y, z); `pathN` samples. */
  path: Float32Array;
  targetPath: Float32Array;
  pathN: number;
};

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();

/** Momentum (kg m/s) of `car` along unit `d`: every mass's own while its rig is loose (a crash), else its body's. */
function carMomentum(car: DeformableCar, d: THREE.Vector3): number {
  if (!car.deform.massActive) return car.deform.totalMass * car.velocity.dot(d);
  let p = 0;
  const ms = car.deform.masses;
  for (let i = 0; i < ms.length; i++) p += ms[i]!.mass * ms[i]!.vel.dot(d);
  return p;
}

/** A car of the layout at its pose, at rest: on its bracket or shelf, or in the air over it (falling onto it). */
function placeCar(car: DeformableCar, item: LabItem, ground: Ground): void {
  const p = heldPose(item);
  car.spawnFacing(p.x, p.z, p.yaw, 0);
  car.group.rotation.set(p.pitch, p.yaw, p.roll, "YXZ");
  car.group.position.y = p.y;
  car.pitch = p.pitch;
  car.roll = p.roll;
  car.airborne = p.pitch !== 0 || p.roll !== 0 || p.y - ground.heightAt(p.x, p.z, p.y) > 0.01;
  car.group.updateMatrixWorld(true);
  car.refreshBasis();
  car.deform.bindKinematic(car.group, car.velocity, car.angular);
}

/**
 * The Lab's runtime (`scenes/lab.ts` is its data): a layout loaded onto the world's cars and the Lab's ground, the props and
 * the pegboard's wall met by the race's own prop rule (`propContact`), and the throw API: `throwAt` launches a placed thing at
 * another and `step` reads back what the physics did (`LabShot`). The engine and the headless tests drive the same object.
 */
export class Lab {
  layout: LabLayout = [];
  preset: LabPresetId | null = null;
  ground: Ground = labGround([]);
  surfaces: LabSurface[] = [];
  placed: Placed[] = [];
  colliders: PropCollider[] = [];
  /** Per placed prop (and the wall after them): knocked off its spot. */
  knocked = new Uint8Array(1);
  /** Layout index of each car slot, of each placed prop, and the slot of each layout item (-1: not a car). */
  carItems: number[] = [];
  propItems: number[] = [];
  slotOf = new Int16Array(0);
  /** The car each slot needs (`placeCars` puts them where the layout says). */
  types: CarType[] = [];
  shot: LabShot | null = null;
  /** Sim seconds since the throw left. */
  private t = 0;
  private sampleAt = 0;
  private thingSlot = -1;
  private targetSlot = -1;
  /** Where each car stood when the throw left (x, y, z) and its up axis's y. */
  private rest = new Float64Array(0);
  /** Thrown car's and target car's velocity, and their momentum (`carMomentum`), at the end of the last slice (before this slice's contact). */
  private readonly vThing = new THREE.Vector3();
  private readonly vTarget = new THREE.Vector3();
  private pBefore = 0;
  /** The launch's direction in plan (unit, y = 0). */
  private readonly launchDir = new THREE.Vector3();
  /** Contact FX (`CrashEngine.hitFx`), or nothing headless. */
  fx: ((at: THREE.Vector3, n: THREE.Vector3, closing: number) => void) | null = null;
  /** Where knocked props are drawn flying (`LabArt`), or nothing headless. */
  tumble: PropTumble | null = null;
  /** The middle of the set (m): halfway from the thrower (item 0) to the middle of the other items, at a car's mid height. */
  readonly focus = new THREE.Vector3();

  /** The prop rule's hooks: a knock or a wall hit by the thrown car is its first contact. */
  readonly hits: PropHits = {
    knock: (index, car, vx, vy, vz) => {
      this.tumble?.knock(index, vx, vy, vz);
      const p = this.placed[index]!;
      this.contact(car, this.propItems[index]!, _v.set(p.x, p.y + 0.5, p.z), _d.copy(this.launchDir).negate());
    },
    fx: (at, n, closing) => this.fx?.(at, n, closing),
    wall: (index, i, _closing, x, z, nx, nz) =>
      this.contact(i, index < this.propItems.length ? this.propItems[index]! : WALL, _v.set(x, (this.cars[i]?.group.position.y ?? 0) + 0.68, z), _d.set(nx, 0, nz)),
  };

  /** Car `i` against the props and the wall over a slice of `h` s (`World.collide`). */
  readonly collide = (car: DeformableCar, i: number, h: number): void => propContact(car, i, this.colliders, this.knocked, this.hits, h);

  /** A car pair met (`World.pairHit`): the thrown car's first. `hit.normal` points from `b` to `a`. */
  readonly pairHit = (a: number, b: number, hit: ContactHit): void => {
    if (a === this.thingSlot) this.contact(a, this.carItems[b]!, hit.contact, hit.normal);
    else if (b === this.thingSlot) this.contact(b, this.carItems[a]!, hit.contact, _d.copy(hit.normal).negate());
  };

  private cars: readonly DeformableCar[] = [];

  /** Load `layout` (or a preset's): its ground, props and wall. The caller makes `ground` active and places the cars (`placeCars`). */
  load(layout: LabLayout | LabPresetId): void {
    this.preset = typeof layout === "string" ? layout : null;
    this.layout = typeof layout === "string" ? LAB_LAYOUTS[layout] : layout;
    this.surfaces = labSurfaces(this.layout);
    this.ground = labGround(this.surfaces);
    const { placed, items } = labPlaced(this.layout);
    this.placed = placed;
    this.propItems = items;
    this.colliders = labColliders(placed);
    this.knocked = new Uint8Array(placed.length + 1);
    this.carItems = [...this.layout.keys()].filter((k) => this.layout[k]!.kind === "car");
    this.types = this.layout.flatMap((item) => (item.kind === "car" ? [item.type] : []));
    this.slotOf = new Int16Array(this.layout.length).fill(-1);
    for (const [slot, k] of this.carItems.entries()) this.slotOf[k] = slot;
    this.rest = new Float64Array(this.carItems.length * 4);
    // Halfway from the thrower to the middle of the rest; a lone thrower looks 12 m down its own line.
    const first = heldPose(this.layout[0]!);
    let mx = first.x + Math.sin(first.yaw) * 12;
    let mz = first.z + Math.cos(first.yaw) * 12;
    if (this.layout.length > 1) {
      mx = 0;
      mz = 0;
      for (let k = 1; k < this.layout.length; k++) {
        const p = heldPose(this.layout[k]!);
        mx += p.x / (this.layout.length - 1);
        mz += p.z / (this.layout.length - 1);
      }
    }
    this.focus.set((first.x + mx) / 2, 0.7, (first.z + mz) / 2);
    this.shot = null;
    this.thingSlot = -1;
    this.targetSlot = -1;
  }

  /** Every car of the layout at its pose, at rest; props back on their spots. */
  placeCars(cars: readonly DeformableCar[]): void {
    this.cars = cars;
    for (const [slot, k] of this.carItems.entries()) placeCar(cars[slot]!, this.layout[k]!, this.ground);
    this.knocked.fill(0);
    this.tumble?.reset();
    this.shot = null;
    this.thingSlot = -1;
    this.targetSlot = -1;
  }

  /** Centre (m) of item `k` as it is now: a car's body box middle, a prop's middle. */
  centre(k: number, out: THREE.Vector3): THREE.Vector3 {
    const slot = this.slotOf[k]!;
    if (slot >= 0) {
      const car = this.cars[slot]!;
      return out.set(0, 0.68, 0).applyQuaternion(car.group.quaternion).add(car.group.position);
    }
    const p = heldPose(this.layout[k]!);
    return out.set(p.x, p.y + 0.5, p.z);
  }

  /** Where a throw from item `thing` at `target` arrives (into `out`): the target item's centre, or for `WALL` the board's face straight back from the thing. */
  targetPoint(thing: number, target: number, out: THREE.Vector3): THREE.Vector3 {
    if (target !== WALL) return this.centre(target, out);
    this.centre(thing, out);
    out.z = BOARD.z;
    return out;
  }

  /** Whether item `k` can be thrown at from item `thing`: any other item but a shelf, and a prop only while it stands on its spot. */
  canTarget(thing: number, k: number): boolean {
    if (k === thing || this.layout[k]!.kind === "shelf") return false;
    const p = this.propItems.indexOf(k);
    return p < 0 || this.knocked[p] === 0;
  }

  /**
   * The launch velocity (into `out`) that carries item `thing`'s centre to `target`'s point (`targetPoint`) at `speed` m/s along
   * the line between them, lifted by what gravity takes over the flight; returns the flight (s).
   */
  private aim(thing: number, target: number, speed: number, out: THREE.Vector3): number {
    const from = this.centre(thing, _from);
    const to = this.targetPoint(thing, target, _to);
    const flight = Math.max(1e-3, from.distanceTo(to) / speed);
    out.copy(to).sub(from).divideScalar(flight);
    out.y += 0.5 * G * flight;
    return flight;
  }

  /**
   * A flick of item `thing` at `speed` m/s: at `target` (an item or `WALL`), arriving at its point as `throwAt` does, or for `FREE`
   * along plan direction (dx, dz) lifted `FREE_LIFT` above level. Its launch velocity goes into `out` (x, y, z) with its flight in
   * `out.w` (s: to the target's point, or back down to its own height).
   */
  flickAim(thing: number, target: number, dx: number, dz: number, speed: number, out: THREE.Vector4): void {
    if (target !== FREE) {
      const flight = this.aim(thing, target, speed, _v);
      out.set(_v.x, _v.y, _v.z, flight);
      return;
    }
    const d = Math.hypot(dx, dz) || 1;
    const flat = speed * Math.cos(FREE_LIFT);
    const up = speed * Math.sin(FREE_LIFT);
    out.set((dx / d) * flat, up, (dz / d) * flat, (2 * up) / G);
  }

  /** Flick item `thing` (a car) at `target` (or `FREE` along (dx, dz)) at `speed` m/s (`flickAim`). */
  flick(thing: number, target: number, dx: number, dz: number, speed: number): LabShot {
    const out = new THREE.Vector4();
    this.flickAim(thing, target, dx, dz, speed, out);
    return this.launch(thing, target, new THREE.Vector3(out.x, out.y, out.z), 0);
  }

  /**
   * Launch item `thing` (a car) at item `target` (or `WALL`) at `speed` m/s along the line between their centres, arriving at the
   * target's centre (`aim`), spinning `spin` rad/s about the vertical.
   */
  throwAt(thing: number, target: number, speed: number, spin = 0): LabShot {
    const v = new THREE.Vector3();
    this.aim(thing, target, speed, v);
    return this.launch(thing, target, v, spin);
  }

  /**
   * Item `thing` (a car) leaves at velocity `v` toward `target` (a layout index, `WALL` or `FREE`), spinning `spin` rad/s about
   * the vertical. Starts a fresh readback (`shot`). Every other car's stand is remembered, so `fell` counts only what the throw moved.
   */
  private launch(thing: number, target: number, v: THREE.Vector3, spin: number): LabShot {
    const slot = this.slotOf[thing]!;
    if (slot < 0) throw new Error(`lab item ${thing} is not a car`);
    const car = this.cars[slot]!;
    this.launchDir.set(v.x, 0, v.z).normalize();
    for (let s = 0; s < this.cars.length && s < this.carItems.length; s++) {
      const c = this.cars[s]!;
      this.rest[s * 4] = c.group.position.x;
      this.rest[s * 4 + 1] = c.group.position.y;
      this.rest[s * 4 + 2] = c.group.position.z;
      this.rest[s * 4 + 3] = c.group.matrixWorld.elements[5]!;
    }
    car.velocity.copy(v);
    car.angular.set(0, spin, 0);
    car.speed = Math.hypot(v.x, v.z);
    car.airborne = v.y > 0.05;
    if (car.deform.massActive) {
      for (const m of car.deform.masses) m.vel.copy(v);
    } else car.deform.bindKinematic(car.group, car.velocity, car.angular);
    this.thingSlot = slot;
    this.targetSlot = target >= 0 ? this.slotOf[target]! : -1;
    this.vThing.copy(v);
    this.vTarget.set(0, 0, 0);
    this.t = 0;
    this.sampleAt = 0;
    this.shot = {
      thing,
      target,
      launch: v.clone(),
      spin,
      contactS: null,
      contactAt: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      hit: null,
      speedBefore: 0,
      speedAfter: null,
      closingBefore: 0,
      closingAfter: null,
      restitution: null,
      momentumBefore: 0,
      momentumAfter: null,
      pulseS: null,
      crush: 0,
      targetCrush: 0,
      fell: [],
      path: new Float32Array(PATH_N * 3),
      targetPath: new Float32Array(PATH_N * 3),
      pathN: 0,
    };
    this.sample();
    return this.shot;
  }

  /**
   * Before each physics slice of `h` sim s (`World.beforeSlice`; it never steps the slice itself): the throw's readback of the
   * world as the last slice left it (peaks, path, the pulse's end, the after-contact read, what fell), then its clock.
   */
  readonly slice = (h: number): boolean => {
    const s = this.shot;
    if (!s) return false;
    const car = this.cars[this.thingSlot]!;
    const tgt = this.targetSlot >= 0 ? this.cars[this.targetSlot]! : null;
    s.crush = Math.max(s.crush, car.deform.crushAmount);
    if (tgt) s.targetCrush = Math.max(s.targetCrush, tgt.deform.crushAmount);
    if (this.t >= this.sampleAt) this.sample();
    if (s.contactS !== null) {
      const closing = -(car.velocity.dot(s.normal) - (tgt ? tgt.velocity.dot(s.normal) : 0));
      // The pulse is over once 95 % of the closing is gone (the crash scenarios' `pulseMs`), or `AFTER_S` on: momentum is read
      // there, before the tyres' grip on the bench takes its share.
      if (s.momentumAfter === null && (closing <= 0.05 * s.closingBefore || this.t >= s.contactS + AFTER_S)) {
        s.pulseS = this.t - s.contactS;
        s.momentumAfter = carMomentum(car, this.launchDir) + (tgt ? carMomentum(tgt, this.launchDir) : 0);
      }
      if (s.speedAfter === null && this.t >= s.contactS + AFTER_S) {
        s.speedAfter = car.velocity.length();
        s.closingAfter = closing;
        s.restitution = s.closingBefore !== 0 ? -closing / s.closingBefore : null;
      }
    }
    this.fell(s);
    if (s.contactS === null) {
      this.vThing.copy(car.velocity);
      if (tgt) this.vTarget.copy(tgt.velocity);
      this.pBefore = carMomentum(car, this.launchDir) + (tgt ? carMomentum(tgt, this.launchDir) : 0);
    }
    this.t += h;
    return false;
  };

  private sample(): void {
    const s = this.shot!;
    if (s.pathN >= PATH_N) return;
    const o = s.pathN * 3;
    const p = this.cars[this.thingSlot]!.group.position;
    s.path[o] = p.x;
    s.path[o + 1] = p.y;
    s.path[o + 2] = p.z;
    const q = this.targetSlot >= 0 ? this.cars[this.targetSlot]!.group.position : _v.set(NaN, NaN, NaN);
    s.targetPath[o] = q.x;
    s.targetPath[o + 1] = q.y;
    s.targetPath[o + 2] = q.z;
    s.pathN++;
    this.sampleAt += PATH_S;
  }

  /** The thrown car met `hit` (a layout index or `WALL`) at `at`, `n` out of it: the first one only. */
  private contact(slot: number, hit: number, at: THREE.Vector3, n: THREE.Vector3): void {
    const s = this.shot;
    if (!s || slot !== this.thingSlot || s.contactS !== null) return;
    s.contactS = this.t;
    s.contactAt.copy(at);
    s.normal.copy(n).normalize();
    s.hit = hit;
    s.speedBefore = this.vThing.length();
    const tgt = this.targetSlot >= 0 ? this.cars[this.targetSlot]! : null;
    // The normal out of what it met, toward the thrown car: closing is the thrown car's speed into it less the target's.
    s.closingBefore = -(this.vThing.dot(s.normal) - (tgt ? this.vTarget.dot(s.normal) : 0));
    s.momentumBefore = this.pBefore;
  }

  /** Rebuilds `fell`: every car but the thrown one off its stand, every knocked prop. */
  private fell(s: LabShot): void {
    let n = 0;
    for (let slot = 0; slot < this.carItems.length; slot++) {
      if (slot === this.thingSlot) continue;
      const c = this.cars[slot]!;
      const o = slot * 4;
      const p = c.group.position;
      const moved = Math.hypot(p.x - this.rest[o]!, p.y - this.rest[o + 1]!, p.z - this.rest[o + 2]!);
      if (moved > FELL_M || c.group.matrixWorld.elements[5]! < UPRIGHT) s.fell[n++] = this.carItems[slot]!;
    }
    for (let k = 0; k < this.propItems.length; k++) if (this.knocked[k]) s.fell[n++] = this.propItems[k]!;
    s.fell.length = n;
  }
}
