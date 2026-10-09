import * as THREE from "three";
import { GROUND_REACH, HIT_DV, type RagdollSystem } from "../present/engine-ragdoll.ts";
import type { PropTumble } from "../present/prop-tumble.ts";
import { colliderSolids, type Solid } from "../present/ragdoll-solids.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { G, readContact } from "../vehicle/car-air.ts";
import { propContact, type PropHits } from "../contact/prop-contact.ts";
import type { ContactHit } from "../scenes/engine-props.ts";
import { BENCH, BOARD, BRACKET_T, FLOOR, heldPose, labColliders, labGround, labPlaced, labSurfaces, LAB_LAYOUTS, type LabItem, type LabLayout, type LabPresetId, type LabSurface } from "../scenes/lab.ts";
import type { CarType } from "../scenes/fleet.ts";
import type { Ground } from "../world/ground.ts";
import type { Placed, PropCollider } from "../world/placements.ts";
import { PREFABS } from "../world/catalog.ts";
import { detSin, detCos, hypot2, hypot3 } from "../kernel/physics-core.js";

/** Sim seconds after the first contact at which the throw's "after" speeds are read: the hit's pulse is over (crash pulses run 60–120 ms). */
const AFTER_S = 0.3;
/** A car moved this far (m) from where it stood when the throw left, or tipped past `UPRIGHT`, has fallen. */
const FELL_M = 0.3;
const UPRIGHT = 0.9;
/** Path samples: one per `PATH_S` sim seconds, `PATH_N` of them (10 s). */
const PATH_S = 1 / 60;
const PATH_N = 600;
/** What a throw met: `-1`, the wall the pegboard hangs on (`LabShot.hit`). */
export const WALL = -1;
/**
 * A thrown dummy's readback: his torso's velocity is held against its free flight over each `DOLL_READ_S` sim s, and a
 * change past the hit his own skin counts (`HIT_DV`) off the ground is his first contact, with the item whose middle is
 * within `DOLL_REACH` m of his torso.
 */
const DOLL_READ_S = 1 / 60;
const DOLL_REACH = 3;
/**
 * A thrown prop's change of velocity rising steeper than this sine (45° over level) is the ground pushing it up, its landing;
 * less steep, a hit. Friction (0.85 at most) adds at most 0.85 of a push across it: the bench's push with its friction never
 * rises less than 50°, and a wall's or a car's side's, its friction slowing the fall, never more than 40°.
 */
const PROP_LAND = Math.SQRT1_2;

/** One throw's readback (`Lab.launch`): what the physics did, read off the sim. Positions and speeds are m and m/s, times sim s from the launch. */
export type LabShot = {
  thing: number;
  launch: THREE.Vector3;
  /** The thing's first contact with anything but the ground: when, where, the normal out of what it met, and what (a layout index, `WALL`). Null: none yet. */
  contactS: number | null;
  contactAt: THREE.Vector3;
  normal: THREE.Vector3;
  hit: number | null;
  /** The thing's speed at the last step before the contact and `AFTER_S` after it (null until then). */
  speedBefore: number;
  speedAfter: number | null;
  /** Thing and the car or wall it met: their speeds along `normal` before the contact (a fixed solid's is 0), and after. */
  closingBefore: number;
  closingAfter: number | null;
  /** −(closing after) / (closing before): 0 a dead stop together, 1 elastic. Null until `AFTER_S`. */
  restitution: number | null;
  /**
   * Momentum (kg m/s) of the thrown car and a car it met together along the launch's plan direction (the bench carries the
   * vertical): the step before the contact, and at the pulse's end (`pulseS` after it: the pair stopped closing, at most `AFTER_S`).
   */
  momentumBefore: number;
  momentumAfter: number | null;
  pulseS: number | null;
  /** Peak crush (m) of the thrown car and of a car it met since the launch (`crushAmount`, the sensors' compression). */
  crush: number;
  targetCrush: number;
  /** Layout indices of the items knocked off where they stood at the launch: cars moved over `FELL_M` or tipped, props knocked. */
  fell: number[];
  /** Thing and the car it met: positions every `PATH_S` (x, y, z; NaN before the contact); `pathN` samples. */
  path: Float32Array;
  targetPath: Float32Array;
  pathN: number;
};

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _u = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const _from = new THREE.Vector3();
const _w = new THREE.Vector3();

/** Momentum (kg m/s) of `car` along unit `d`: every mass's own while its rig is loose (a crash), else its body's. */
function carMomentum(car: DeformableCar, d: THREE.Vector3): number {
  if (!car.deform.massActive) return car.deform.totalMass * car.velocity.dot(d);
  let p = 0;
  const ms = car.deform.masses;
  for (let i = 0; i < ms.length; i++) p += ms[i]!.mass * ms[i]!.vel.dot(d);
  return p;
}

/** A car of the layout at its pose, at rest: on its bracket or shelf, or in the air over it (falling onto it). */
function placeCar(car: DeformableCar, item: LabItem): void {
  const p = heldPose(item);
  car.spawnFacing(p.x, p.z, p.yaw, 0);
  car.group.rotation.set(p.pitch, p.yaw, p.roll, "YXZ");
  car.group.position.y = p.y;
  car.pitch = p.pitch;
  car.roll = p.roll;
  car.group.updateMatrixWorld(true);
  car.refreshBasis();
  car.deform.bindKinematic(car.group, car.velocity, car.angular);
  readContact(car);
  car.parked = true;
}

/** The bench as one block from the floor to its top, and the workshop floor (half-size `FLOOR_HALF` m): the dummies' ground in the Lab. */
const BENCH_HZ = (BENCH.front - BOARD.z) / 2;
const FLOOR_HALF = 1000;
const LAB_GROUND: readonly Solid[] = [
  { x: 0, z: BOARD.z + BENCH_HZ, r: hypot2(BENCH.halfW, BENCH_HZ), make: (R) => R.ColliderDesc.cuboid(BENCH.halfW, -FLOOR / 2, BENCH_HZ).setTranslation(0, FLOOR / 2, BOARD.z + BENCH_HZ) },
  { x: 0, z: 0, r: FLOOR_HALF * Math.SQRT2, make: (R) => R.ColliderDesc.cuboid(FLOOR_HALF, 0.5, FLOOR_HALF).setTranslation(0, FLOOR - 0.5, 0) },
];

/** What a dummy meets in the Lab besides the cars: the bench and floor, the props and the wall as the cars meet them (`colliderSolids`), and every bracket and shelf plate. */
function labSolids(colliders: readonly PropCollider[], surfaces: readonly LabSurface[]): Solid[] {
  const plates = surfaces.map((s): Solid => {
    const hx = (s.x1 - s.x0) / 2;
    const hz = (s.z1 - s.z0) / 2;
    const x = (s.x0 + s.x1) / 2;
    const z = (s.z0 + s.z1) / 2;
    return { x, z, r: hypot2(hx, hz), make: (R) => R.ColliderDesc.cuboid(hx, BRACKET_T / 2, hz).setTranslation(x, s.top - BRACKET_T / 2, z) };
  });
  return [...LAB_GROUND, ...colliderSolids(colliders, []), ...plates];
}

/**
 * The Lab's runtime (`scenes/lab.ts` is its data): a layout loaded onto the world's cars and the Lab's ground, the props and
 * the pegboard's wall met by the race's own prop rule (`propContact`), and the throw API: `launch` lets a placed thing go at a
 * velocity and `slice` reads back what the physics did (`LabShot`). The engine and the headless tests drive the same object.
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
  /** Layout index of each dummy, and the dummy slot (`RagdollSystem`) of each layout item (-1: not a dummy): the n-th dummy is slot n. */
  dummyItems: number[] = [];
  dollOf = new Int16Array(0);
  /** The placed prop (index into `placed`) of each layout item (-1: not a prop). */
  propOf = new Int16Array(0);
  /** The items a flick may pick (`LabFlick`): every car, each dummy once he is out, and with the dummies' world every knockable prop; `thingN` of them. */
  things = new Int16Array(0);
  thingN = 0;
  /** What a dummy meets besides the bench and the cars (`RagdollSystem.setSolids`). */
  solids: Solid[] = [];
  /** The dummies' world, or nothing headless without Rapier. */
  dolls: RagdollSystem | null = null;
  /** The car each slot needs (`placeCars` puts them where the layout says). */
  types: CarType[] = [];
  shot: LabShot | null = null;
  /** Sim seconds since the throw left. */
  private t = 0;
  private sampleAt = 0;
  private thingSlot = -1;
  /** The car the thrown car met (`contact`; -1: none yet, or it met no car). */
  private metSlot = -1;
  /** The thrown dummy's slot and the thrown prop (-1: a car is thrown), whether a dummy waits for Rapier, and the thrown body's velocity at sim second `tRef`. */
  private thingDoll = -1;
  private thingProp = -1;
  private dollsDue = false;
  private tRef = 0;
  private readonly vRef = new THREE.Vector3();
  /** Where each car stood when the throw left (x, y, z) and its up axis's y. */
  private rest = new Float64Array(0);
  /** Thrown car's velocity and momentum (`carMomentum`) at the end of the last slice (before this slice's contact), and every car's, for the one it meets. */
  private readonly vThing = new THREE.Vector3();
  private readonly vTarget = new THREE.Vector3();
  private pBefore = 0;
  private vCars = new Float64Array(0);
  private pCars = new Float64Array(0);
  /** The launch's direction in plan (unit, y = 0). */
  private readonly launchDir = new THREE.Vector3();
  /** Contact FX (`CrashEngine.hitFx`), or nothing headless. */
  fx: ((at: THREE.Vector3, n: THREE.Vector3, closing: number) => void) | null = null;
  /** Where the props are drawn (`LabArt`), or nothing headless. */
  tumble: PropTumble | null = null;
  /** The middle of the set (m): halfway from the thrower (item 0) to the middle of the other items, at a car's mid height. */
  readonly focus = new THREE.Vector3();

  /** The prop rule's hooks: a knocked prop tumbles in the dummies' world; a knock or a wall hit by the thrown car is its first contact. */
  readonly hits: PropHits = {
    knock: (index, car, vx, vy, vz) => {
      this.dolls?.knockProp(index, car, vx, vy, vz);
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
    this.dummyItems = [...this.layout.keys()].filter((k) => this.layout[k]!.kind === "dummy");
    this.dollOf = new Int16Array(this.layout.length).fill(-1);
    for (const [n, k] of this.dummyItems.entries()) this.dollOf[k] = n;
    this.propOf = new Int16Array(this.layout.length).fill(-1);
    for (const [n, k] of items.entries()) this.propOf[k] = n;
    this.things = new Int16Array(this.carItems.length + this.dummyItems.length + items.length);
    this.solids = labSolids(this.colliders, this.surfaces);
    this.rest = new Float64Array(this.carItems.length * 4);
    // Halfway from the thrower to the middle of the rest; a lone thrower looks 12 m down its own line.
    const first = heldPose(this.layout[0]!);
    let mx = first.x + detSin(first.yaw) * 12;
    let mz = first.z + detCos(first.yaw) * 12;
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
    this.metSlot = -1;
    this.thingDoll = -1;
    this.thingProp = -1;
  }

  /** Every car and dummy of the layout at its pose, at rest; props back on their spots. */
  placeCars(cars: readonly DeformableCar[]): void {
    this.cars = cars;
    this.vCars = new Float64Array(this.carItems.length * 3);
    this.pCars = new Float64Array(this.carItems.length);
    for (const [slot, k] of this.carItems.entries()) placeCar(cars[slot]!, this.layout[k]!);
    this.knocked.fill(0);
    this.dolls?.setSolids(this.ground, this.solids, this.placed, this.tumble);
    this.placeDummies();
    this.shot = null;
    this.thingSlot = -1;
    this.metSlot = -1;
    this.thingDoll = -1;
    this.thingProp = -1;
  }

  /** Every dummy standing at his pose (he falls where he stands), and the items a flick may pick; while Rapier loads the dummies wait (`slice` tries again). */
  private placeDummies(): void {
    let n = 0;
    for (const k of this.carItems) this.things[n++] = k;
    this.dollsDue = false;
    for (const [d, k] of this.dummyItems.entries()) {
      const p = heldPose(this.layout[k]!);
      if (this.dolls && this.dolls.place(_p.set(p.x, p.y, p.z), _q.setFromAxisAngle(UP, p.yaw), _v.set(0, 0, 0), _u.set(0, 0, 0), Infinity, d) >= 0) this.things[n++] = k;
      else if (this.dolls) this.dollsDue = true;
    }
    // A prop flicked before Rapier is in flies once it is (`RagdollSystem.knockProp`).
    if (this.dolls) for (const [i, k] of this.propItems.entries()) if (PREFABS[this.placed[i]!.prefab].body === "knock") this.things[n++] = k;
    this.thingN = n;
  }

  /** Centre (m) of item `k` as it is now: a car's body box middle, a dummy's torso, a prop's middle (a knocked one's where it is). */
  centre(k: number, out: THREE.Vector3): THREE.Vector3 {
    const slot = this.slotOf[k]!;
    if (slot >= 0) {
      const car = this.cars[slot]!;
      return out.set(0, 0.68, 0).applyQuaternion(car.group.quaternion).add(car.group.position);
    }
    const doll = this.dollOf[k]!;
    if (doll >= 0 && this.dolls?.torso(doll, out, null)) return out;
    const prop = this.propOf[k]!;
    if (prop >= 0 && this.dolls?.propAt(prop, out, _w)) return out;
    // A dummy's pose is his torso's centre (`LabPose`); a prop's is its base.
    const p = heldPose(this.layout[k]!);
    return out.set(p.x, p.y + (doll >= 0 ? 0 : 0.5), p.z);
  }

  /**
   * Item `thing` (a car, a dummy or a knockable prop) leaves from where it is at velocity `v`, turned as it is and spinning at
   * none. Starts a fresh readback (`shot`). Every other car's stand is remembered, so `fell` counts only what the throw moved.
   */
  launch(thing: number, v: THREE.Vector3): LabShot {
    const slot = this.slotOf[thing]!;
    const doll = this.dollOf[thing]!;
    const prop = slot < 0 && doll < 0 ? this.propOf[thing]! : -1;
    if (slot < 0 && doll < 0 && (prop < 0 || PREFABS[this.placed[prop]!.prefab].body !== "knock")) throw new Error(`lab item ${thing} is not a car, a dummy or a knockable prop`);
    this.launchDir.set(v.x, 0, v.z).normalize();
    for (let s = 0; s < this.cars.length && s < this.carItems.length; s++) {
      const c = this.cars[s]!;
      this.rest[s * 4] = c.group.position.x;
      this.rest[s * 4 + 1] = c.group.position.y;
      this.rest[s * 4 + 2] = c.group.position.z;
      this.rest[s * 4 + 3] = c.group.matrixWorld.elements[5]!;
    }
    if (slot >= 0) {
      const car = this.cars[slot]!;
      car.velocity.copy(v);
      car.angular.set(0, 0, 0);
      car.speed = hypot2(v.x, v.z);
      car.parked = false;
      if (car.deform.massActive) {
        for (const m of car.deform.masses) m.vel.copy(v);
      } else car.deform.bindKinematic(car.group, car.velocity, car.angular);
      readContact(car);
    } else if (doll >= 0) this.dolls?.leave(doll, v);
    else {
      this.knocked[prop] = 1;
      this.dolls?.knockProp(prop, -1, v.x, v.y, v.z);
    }
    this.vRef.copy(v);
    this.tRef = 0;
    this.thingDoll = doll;
    this.thingProp = prop;
    this.thingSlot = slot;
    this.metSlot = -1;
    this.vThing.copy(v);
    this.vTarget.set(0, 0, 0);
    this.t = 0;
    this.sampleAt = 0;
    this.shot = {
      thing,
      launch: v.clone(),
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
    if (this.dollsDue) this.placeDummies();
    const s = this.shot;
    if (!s) return false;
    if (this.thingDoll >= 0 || this.thingProp >= 0) {
      if (this.t >= this.sampleAt) this.sample();
      this.bodyRead(s);
      this.fell(s);
      this.t += h;
      return false;
    }
    const car = this.cars[this.thingSlot]!;
    const tgt = this.metSlot >= 0 ? this.cars[this.metSlot]! : null;
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
      this.pBefore = carMomentum(car, this.launchDir);
      for (let other = 0; other < this.cars.length && other < this.carItems.length; other++) {
        this.vCars[other * 3] = this.cars[other]!.velocity.x;
        this.vCars[other * 3 + 1] = this.cars[other]!.velocity.y;
        this.vCars[other * 3 + 2] = this.cars[other]!.velocity.z;
        this.pCars[other] = carMomentum(this.cars[other]!, this.launchDir);
      }
    }
    this.t += h;
    return false;
  };

  private sample(): void {
    const s = this.shot!;
    if (s.pathN >= PATH_N) return;
    const o = s.pathN * 3;
    const p = this.thingSlot >= 0 ? this.cars[this.thingSlot]!.group.position : this.centre(s.thing, _p);
    s.path[o] = p.x;
    s.path[o + 1] = p.y;
    s.path[o + 2] = p.z;
    const q = this.metSlot >= 0 ? this.cars[this.metSlot]!.group.position : _v.set(NaN, NaN, NaN);
    s.targetPath[o] = q.x;
    s.targetPath[o + 1] = q.y;
    s.targetPath[o + 2] = q.z;
    s.pathN++;
    this.sampleAt += PATH_S;
  }

  /**
   * A thrown dummy or prop, before each slice: its first contact (`DOLL_READ_S`, `HIT_DV`; the normal is its change of
   * velocity, out of what it met) off the ground, then the after read at `AFTER_S`. A dummy's is off the ground while his
   * torso is over `GROUND_REACH`; a prop's while its change of velocity points less steeply up than `PROP_LAND` (steeper, it
   * met the ground under it). Neither reads momentum or crush.
   */
  private bodyRead(s: LabShot): void {
    if (!(this.thingDoll >= 0 ? this.dolls?.torso(this.thingDoll, _p, _u) : this.dolls?.propAt(this.thingProp, _p, _u))) return;
    if (s.contactS !== null) {
      if (s.speedAfter === null && this.t >= s.contactS + AFTER_S) {
        s.speedAfter = _u.length();
        s.closingAfter = -_u.dot(s.normal);
        s.restitution = s.closingBefore !== 0 ? -s.closingAfter / s.closingBefore : null;
      }
      return;
    }
    const dt = this.t - this.tRef;
    if (dt < DOLL_READ_S) return;
    _d.copy(_u).sub(this.vRef);
    _d.y += G * dt;
    const off = this.thingDoll >= 0 ? _p.y - this.ground.heightAt(_p.x, _p.z, _p.y) > GROUND_REACH : _d.y < PROP_LAND * _d.length();
    if (_d.length() > HIT_DV && off) {
      s.contactS = this.t;
      s.contactAt.copy(_p);
      s.normal.copy(_d).normalize();
      s.hit = this.met(s.thing, _p);
      s.speedBefore = this.vRef.length();
      s.closingBefore = -this.vRef.dot(s.normal);
    }
    this.vRef.copy(_u);
    this.tRef = this.t;
  }

  /** What a thrown dummy's torso or prop at `p` met: the nearest other item whose middle is within `DOLL_REACH`, else the wall when it is at the board, else nothing known. */
  private met(thing: number, p: THREE.Vector3): number | null {
    let best: number | null = null;
    let bestD = DOLL_REACH;
    for (let k = 0; k < this.layout.length; k++) {
      if (k === thing) continue;
      const d = this.centre(k, _from).distanceTo(p);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best ?? (p.z - BOARD.z < 1.5 ? WALL : null);
  }

  /** The thrown car met `hit` (a layout index or `WALL`) at `at`, `n` out of it: the first one only. A car it met is read back too (`metSlot`). */
  private contact(slot: number, hit: number, at: THREE.Vector3, n: THREE.Vector3): void {
    const s = this.shot;
    if (!s || slot !== this.thingSlot || s.contactS !== null) return;
    s.contactS = this.t;
    s.contactAt.copy(at);
    s.normal.copy(n).normalize();
    s.hit = hit;
    s.speedBefore = this.vThing.length();
    this.metSlot = hit >= 0 ? this.slotOf[hit]! : -1;
    if (this.metSlot >= 0) this.vTarget.fromArray(this.vCars, this.metSlot * 3);
    // The normal out of what it met, toward the thrown car: closing is the thrown car's speed into it less the met car's.
    s.closingBefore = -(this.vThing.dot(s.normal) - (this.metSlot >= 0 ? this.vTarget.dot(s.normal) : 0));
    s.momentumBefore = this.pBefore + (this.metSlot >= 0 ? this.pCars[this.metSlot]! : 0);
  }

  /** Rebuilds `fell`: every car but the thrown one off its stand, every knocked prop but the thrown one. */
  private fell(s: LabShot): void {
    let n = 0;
    for (let slot = 0; slot < this.carItems.length; slot++) {
      if (slot === this.thingSlot) continue;
      const c = this.cars[slot]!;
      const o = slot * 4;
      const p = c.group.position;
      const moved = hypot3(p.x - this.rest[o]!, p.y - this.rest[o + 1]!, p.z - this.rest[o + 2]!);
      if (moved > FELL_M || c.group.matrixWorld.elements[5]! < UPRIGHT) s.fell[n++] = this.carItems[slot]!;
    }
    for (let k = 0; k < this.propItems.length; k++) if (this.knocked[k] && k !== this.thingProp) s.fell[n++] = this.propItems[k]!;
    s.fell.length = n;
  }
}
