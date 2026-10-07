import * as THREE from "three";
import { GROUND_REACH, HIT_DV, type RagdollSystem } from "../present/engine-ragdoll.ts";
import { AIR_LINEAR } from "../present/ragdoll-body.ts";
import type { PropTumble } from "../present/prop-tumble.ts";
import { colliderSolids, type Solid } from "../present/ragdoll-solids.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { G, readContact } from "../vehicle/car-air.ts";
import { glassCorners } from "../vehicle/car-glass.ts";
import { propContact, type PropHits } from "../contact/prop-contact.ts";
import type { ContactHit } from "../scenes/engine-props.ts";
import { BENCH, BOARD, BRACKET_T, FLOOR, heldPose, labColliders, labGround, labPlaced, labSurfaces, LAB_LAYOUTS, type LabItem, type LabLayout, type LabPresetId, type LabSurface } from "../scenes/lab.ts";
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
/**
 * A thrown dummy's readback: his torso's velocity is held against its free flight over each `DOLL_READ_S` sim s, and a
 * change past the hit his own skin counts (`HIT_DV`) off the ground is his first contact, with the item whose middle is
 * within `DOLL_REACH` m of his torso.
 */
const DOLL_READ_S = 1 / 60;
const DOLL_REACH = 3;
/** A dummy's torso centre is picked up this high (m) over the ground to be thrown: it stands 1.11 m over his feet, so no limb starts in the ground. */
const DOLL_LIFT = 1.2;
/**
 * A dummy thrown at a car meets its windshield square, at this speed (m/s) or faster: the glass rule's 4 m/s twice over, so
 * his torso cracks it, and once cracked shatters it and goes on into the cabin (`aim`). He is picked up no further round from
 * square to it than `PANE_YAW` (rad, in plan): from further round his limbs catch its pillars and he stops in the opening
 * (headless, a cracked windshield on a stand, dummies 1.5–14 m off at 0–80°: 30° left his torso at the glass's line from
 * 60° round, 10° put it in the cabin from all 25).
 */
const PANE_V = 8;
const PANE_YAW = Math.PI / 18;

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
const _to = new THREE.Vector3();
const _p = new THREE.Vector3();
const _u = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const _from = new THREE.Vector3();
const _n = new THREE.Vector3();

/** How far (m per m/s of launch velocity) a body under `drag` (per s) has carried `t` s into its flight: `t` without drag. */
const reachOf = (drag: number, t: number): number => (drag > 0 ? (1 - Math.exp(-drag * t)) / drag : t);
/** How far (m) gravity has pulled that body below its launch line `t` s in, `reach` its `reachOf`. */
const fallOf = (drag: number, t: number, reach: number): number => (drag > 0 ? (G / drag) * (t - reach) : 0.5 * G * t * t);

/** Momentum (kg m/s) of `car` along unit `d`: every mass's own while its rig is loose (a crash), else its body's. */
function carMomentum(car: DeformableCar, d: THREE.Vector3): number {
  if (!car.deform.massActive) return car.deform.totalMass * car.velocity.dot(d);
  let p = 0;
  const ms = car.deform.masses;
  for (let i = 0; i < ms.length; i++) p += ms[i]!.mass * ms[i]!.vel.dot(d);
  return p;
}

/** A car of the layout at its pose, at rest: on its bracket or shelf, or in the air over it (falling onto it); what it touches is read off that pose. */
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
}

/** The bench as one block from the floor to its top, and the workshop floor (half-size `FLOOR_HALF` m): the dummies' ground in the Lab. */
const BENCH_HZ = (BENCH.front - BOARD.z) / 2;
const FLOOR_HALF = 1000;
const LAB_GROUND: readonly Solid[] = [
  { x: 0, z: BOARD.z + BENCH_HZ, r: Math.hypot(BENCH.halfW, BENCH_HZ), make: (R) => R.ColliderDesc.cuboid(BENCH.halfW, -FLOOR / 2, BENCH_HZ).setTranslation(0, FLOOR / 2, BOARD.z + BENCH_HZ) },
  { x: 0, z: 0, r: FLOOR_HALF * Math.SQRT2, make: (R) => R.ColliderDesc.cuboid(FLOOR_HALF, 0.5, FLOOR_HALF).setTranslation(0, FLOOR - 0.5, 0) },
];

/** What a dummy meets in the Lab besides the cars: the bench and floor, the props and the wall as the cars meet them (`colliderSolids`), and every bracket and shelf plate. */
function labSolids(colliders: readonly PropCollider[], placed: readonly Placed[], surfaces: readonly LabSurface[]): Solid[] {
  const plates = surfaces.map((s): Solid => {
    const hx = (s.x1 - s.x0) / 2;
    const hz = (s.z1 - s.z0) / 2;
    const x = (s.x0 + s.x1) / 2;
    const z = (s.z0 + s.z1) / 2;
    return { x, z, r: Math.hypot(hx, hz), make: (R) => R.ColliderDesc.cuboid(hx, BRACKET_T / 2, hz).setTranslation(x, s.top - BRACKET_T / 2, z) };
  });
  return [...LAB_GROUND, ...colliderSolids(colliders, placed, FLOOR, []), ...plates];
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
  /** Layout index of each dummy, and the dummy slot (`RagdollSystem`) of each layout item (-1: not a dummy): the n-th dummy is slot n. */
  dummyItems: number[] = [];
  dollOf = new Int16Array(0);
  /** The items a flick may pick (`LabFlick`): every car, and each dummy once he is out; `thingN` of them. */
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
  private targetSlot = -1;
  /** The thrown dummy's slot (-1: a car is thrown), whether a dummy waits for Rapier, and his torso's velocity at sim second `tRef`. */
  private thingDoll = -1;
  private dollsDue = false;
  private tRef = 0;
  private readonly vRef = new THREE.Vector3();
  /** Whether solid prop `i` (or the wall after the props) is off its spot: what the dummies' world leaves out. */
  readonly isKnocked = (i: number): boolean => this.knocked[i] === 1;
  /** Where each car stood when the throw left (x, y, z) and its up axis's y. */
  private rest = new Float64Array(0);
  /** Thrown car's and target car's velocity, and their momentum (`carMomentum`), at the end of the last slice (before this slice's contact). */
  private readonly vThing = new THREE.Vector3();
  private readonly vTarget = new THREE.Vector3();
  private pBefore = 0;
  /** The launch's direction in plan (unit, y = 0). */
  private readonly launchDir = new THREE.Vector3();
  /** The last aimed throw (`flickAim`): its launch point, launch velocity and drag (per s: a dummy's air drag, none for a car). */
  private readonly from = new THREE.Vector3();
  private readonly aimV = new THREE.Vector3();
  private aimDrag = 0;
  /** Each car slot's windshield normal, car-local, out of the cabin (x, y, z per slot). */
  private screens = new Float32Array(0);
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
    this.dummyItems = [...this.layout.keys()].filter((k) => this.layout[k]!.kind === "dummy");
    this.dollOf = new Int16Array(this.layout.length).fill(-1);
    for (const [n, k] of this.dummyItems.entries()) this.dollOf[k] = n;
    this.things = new Int16Array(this.carItems.length + this.dummyItems.length);
    this.solids = labSolids(this.colliders, placed, this.surfaces);
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
    this.thingDoll = -1;
  }

  /** Every car and dummy of the layout at its pose, at rest; props back on their spots. */
  placeCars(cars: readonly DeformableCar[]): void {
    this.cars = cars;
    this.screens = new Float32Array(this.carItems.length * 3);
    for (const [slot, k] of this.carItems.entries()) {
      placeCar(cars[slot]!, this.layout[k]!);
      // Its windshield's corners (`glassCorners`, pane 0): its bottom edge across, then up the pane; across × up is out of the cabin.
      const c = glassCorners(cars[slot]!.style);
      _u.set(c[3]! - c[0]!, c[4]! - c[1]!, c[5]! - c[2]!);
      _d.set(c[6]! - c[0]!, c[7]! - c[1]!, c[8]! - c[2]!);
      _u.cross(_d).normalize().toArray(this.screens, slot * 3);
    }
    this.knocked.fill(0);
    this.tumble?.reset();
    this.dolls?.setSolids(this.ground, this.solids, this.isKnocked);
    this.placeDummies();
    this.shot = null;
    this.thingSlot = -1;
    this.targetSlot = -1;
    this.thingDoll = -1;
  }

  /** Every dummy standing at his pose (he falls where he stands), and the items a flick may pick; while Rapier loads they wait (`slice` tries again). */
  private placeDummies(): void {
    let n = 0;
    for (const k of this.carItems) this.things[n++] = k;
    this.dollsDue = false;
    for (const [d, k] of this.dummyItems.entries()) {
      const p = heldPose(this.layout[k]!);
      if (this.dolls && this.dolls.place(_p.set(p.x, p.y, p.z), _q.setFromAxisAngle(UP, p.yaw), _v.set(0, 0, 0), _u.set(0, 0, 0), Infinity, d) >= 0) this.things[n++] = k;
      else if (this.dolls) this.dollsDue = true;
    }
    this.thingN = n;
  }

  /** Centre (m) of item `k` as it is now: a car's body box middle, a dummy's torso, a prop's middle. */
  centre(k: number, out: THREE.Vector3): THREE.Vector3 {
    const slot = this.slotOf[k]!;
    if (slot >= 0) {
      const car = this.cars[slot]!;
      return out.set(0, 0.68, 0).applyQuaternion(car.group.quaternion).add(car.group.position);
    }
    const doll = this.dollOf[k]!;
    if (doll >= 0 && this.dolls?.torso(doll, out, null)) return out;
    // A dummy's pose is his torso's centre (`LabPose`); a prop's is its base.
    const p = heldPose(this.layout[k]!);
    return out.set(p.x, p.y + (doll >= 0 ? 0 : 0.5), p.z);
  }

  /**
   * Where a throw from item `thing` at `target` arrives (into `out`): the target item's centre (a dummy thrown at a car: its
   * windshield's middle), or for `WALL` the board's face straight back from where the thing leaves (`launchPoint`: a dummy lying
   * on the bench is picked up, so he meets the board at that height, not at its foot).
   */
  targetPoint(thing: number, target: number, out: THREE.Vector3): THREE.Vector3 {
    if (target !== WALL) {
      const slot = this.slotOf[target]!;
      return this.dollOf[thing]! >= 0 && slot >= 0 ? this.cars[slot]!.glassWorld("windshield", out) : this.centre(target, out);
    }
    this.launchPoint(thing, out);
    out.z = BOARD.z;
    return out;
  }

  /** Whether item `k` can be thrown at from item `thing`: any other item but a shelf, and a prop only while it stands on its spot. */
  canTarget(thing: number, k: number): boolean {
    if (k === thing || this.layout[k]!.kind === "shelf") return false;
    const p = this.propItems.indexOf(k);
    return p < 0 || this.knocked[p] === 0;
  }

  /** Where item `thing` leaves from (into `out`): its centre; a dummy's torso picked up to `DOLL_LIFT` m over the ground under it, so his diving body clears it. */
  private launchPoint(thing: number, out: THREE.Vector3): THREE.Vector3 {
    this.centre(thing, out);
    if (this.dollOf[thing]! >= 0) out.y = Math.max(out.y, this.ground.heightAt(out.x, out.z, out.y) + DOLL_LIFT);
    return out;
  }

  /**
   * The launch velocity (into `out`) that carries item `thing` from its launch point (`launchPoint`, into `from`) to `target`'s
   * point (`targetPoint`) under gravity, and a dummy under the air's drag (`AIR_LINEAR`); returns the flight (s). It flies the line
   * between them at `speed` m/s on average, but a dummy thrown at a car lands square on its windshield whatever the `speed`: on
   * its middle along its inward normal at `PANE_V` m/s or faster, picked up as high and as near square as that needs (`PANE_YAW`).
   * (A flatter arc meets the car's nose, a steeper one its roof or bonnet with an arm before his torso reaches the glass.)
   */
  private aim(thing: number, target: number, speed: number, out: THREE.Vector3): number {
    const from = this.launchPoint(thing, this.from);
    const to = this.targetPoint(thing, target, _to);
    const doll = this.dollOf[thing]! >= 0;
    const slot = target >= 0 ? this.slotOf[target]! : -1;
    let flight = from.distanceTo(to) / speed;
    if (doll && slot >= 0) {
      // `tan`: how steeply the pane's inward normal comes down (rise over run); `off`: his bearing round from it in plan. Under
      // gravity alone, the arc that ends along it at `PANE_V` passes `run` m out at the height `from` is lifted to, and the one
      // from `from` that ends along it takes `lob`.
      const n = _n.fromArray(this.screens, slot * 3).applyQuaternion(this.cars[slot]!.group.quaternion);
      const flat = Math.max(1e-3, Math.hypot(n.x, n.z));
      const tan = Math.max(0, n.y) / flat;
      const run = Math.hypot(to.x - from.x, to.z - from.z);
      const off = Math.atan2(n.x * (from.z - to.z) - n.z * (from.x - to.x), n.x * (from.x - to.x) + n.z * (from.z - to.z));
      if (Math.abs(off) > PANE_YAW) {
        const bearing = Math.atan2(n.z, n.x) + Math.sign(off) * PANE_YAW;
        from.x = to.x + run * Math.cos(bearing);
        from.z = to.z + run * Math.sin(bearing);
        from.y = Math.max(from.y, this.ground.heightAt(from.x, from.z, from.y) + DOLL_LIFT);
      }
      from.y = Math.max(from.y, to.y + run * tan - (G * run * run * (1 + tan * tan)) / (2 * PANE_V * PANE_V));
      const lob = (2 * (to.y - from.y + run * tan)) / G;
      if (lob > 0) flight = Math.sqrt(lob);
    }
    flight = Math.max(1e-3, flight);
    this.aimDrag = doll ? AIR_LINEAR : 0;
    const reach = reachOf(this.aimDrag, flight);
    out.copy(to).sub(from);
    out.y += fallOf(this.aimDrag, flight, reach);
    this.aimV.copy(out.divideScalar(reach));
    return flight;
  }

  /**
   * A flick of item `thing` at `speed` m/s: at `target` (an item or `WALL`), arriving at its point as `throwAt` does, or for `FREE`
   * along plan direction (dx, dz) lifted `FREE_LIFT` above level. Its launch velocity goes into `out` (x, y, z) with its flight in
   * `out.w` (s: to the target's point, or back down to its own height); `flightAt` follows it.
   */
  flickAim(thing: number, target: number, dx: number, dz: number, speed: number, out: THREE.Vector4): void {
    if (target !== FREE) {
      const flight = this.aim(thing, target, speed, _v);
      out.set(_v.x, _v.y, _v.z, flight);
      return;
    }
    this.launchPoint(thing, this.from);
    this.aimDrag = this.dollOf[thing]! >= 0 ? AIR_LINEAR : 0;
    const d = Math.hypot(dx, dz) || 1;
    const flat = speed * Math.cos(FREE_LIFT);
    const up = speed * Math.sin(FREE_LIFT);
    this.aimV.set((dx / d) * flat, up, (dz / d) * flat);
    out.set(this.aimV.x, up, this.aimV.z, (2 * up) / G);
  }

  /** Where the last aimed throw (`flickAim`) is `t` s into its flight (into `out`), and its velocity there into `v` unless null. */
  flightAt(t: number, out: THREE.Vector3, v: THREE.Vector3 | null): THREE.Vector3 {
    const reach = reachOf(this.aimDrag, t);
    out.copy(this.from).addScaledVector(this.aimV, reach);
    out.y -= fallOf(this.aimDrag, t, reach);
    if (v) {
      // The air takes the share of the launch velocity it has damped away, and gravity pulls what it has not.
      const kept = this.aimDrag > 0 ? Math.exp(-this.aimDrag * t) : 1;
      v.copy(this.aimV).multiplyScalar(kept);
      v.y -= this.aimDrag > 0 ? (G / this.aimDrag) * (1 - kept) : G * t;
    }
    return out;
  }

  /** Flick item `thing` (a car or a dummy) at `target` (or `FREE` along (dx, dz)) at `speed` m/s (`flickAim`). */
  flick(thing: number, target: number, dx: number, dz: number, speed: number): LabShot {
    const out = new THREE.Vector4();
    this.flickAim(thing, target, dx, dz, speed, out);
    return this.launch(thing, target, new THREE.Vector3(out.x, out.y, out.z), 0, out.w);
  }

  /**
   * Launch item `thing` (a car or a dummy) at item `target` (or `WALL`) at `speed` m/s along the line between their centres,
   * arriving at the target's point (`aim`), spinning `spin` rad/s about the vertical.
   */
  throwAt(thing: number, target: number, speed: number, spin = 0): LabShot {
    const v = new THREE.Vector3();
    return this.launch(thing, target, v, spin, this.aim(thing, target, speed, v));
  }

  /**
   * Item `thing` (a car, or a dummy flat to the throw, chest first) leaves at velocity `v` toward `target` (a layout index, `WALL`
   * or `FREE`), spinning `spin` rad/s about the vertical, `flight` s from where it arrives (`flickAim`). Starts a fresh readback
   * (`shot`). Every other car's stand is remembered, so `fell` counts only what the throw moved.
   */
  private launch(thing: number, target: number, v: THREE.Vector3, spin: number, flight: number): LabShot {
    const slot = this.slotOf[thing]!;
    const doll = this.dollOf[thing]!;
    if (slot < 0 && doll < 0) throw new Error(`lab item ${thing} is not a car or a dummy`);
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
      car.angular.set(0, spin, 0);
      car.speed = Math.hypot(v.x, v.z);
      if (car.deform.massActive) {
        for (const m of car.deform.masses) m.vel.copy(v);
      } else {
        // Thrown: the rigid step flies it (`stepFree`) from its centre of mass, and hands it back to its wheels where it lands on them.
        car.rigid = true;
        car.deform.bindKinematic(car.group, car.velocity, car.angular);
      }
    } else {
      // Chest first where he arrives, his spine level across the throw (his head on its left): his torso is what meets what he is
      // thrown at (the glass rule's). At a car, flat to its windshield with his spine across it, so an arc that slants in still
      // meets it with his torso.
      this.flightAt(flight, _p, _d);
      _d.normalize();
      _u.crossVectors(UP, _d);
      if (_u.lengthSq() < 1e-6) _u.set(1, 0, 0);
      const at = target >= 0 ? this.slotOf[target]! : -1;
      if (at >= 0) {
        const car = this.cars[at]!;
        _d.fromArray(this.screens, at * 3).applyQuaternion(car.group.quaternion).negate();
        _v.setFromMatrixColumn(car.group.matrixWorld, 0);
        _u.copy(_v.addScaledVector(_d, -_v.dot(_d)).multiplyScalar(Math.sign(_v.dot(_u)) || 1));
      }
      _u.normalize();
      _q.setFromRotationMatrix(_m.makeBasis(_from.crossVectors(_u, _d), _u, _d));
      this.dolls?.place(this.from, _q, v, _u.set(0, spin, 0), Infinity, doll);
      this.vRef.copy(v);
      this.tRef = 0;
    }
    this.thingDoll = doll;
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
    if (this.dollsDue) this.placeDummies();
    const s = this.shot;
    if (!s) return false;
    if (this.thingDoll >= 0) {
      if (this.t >= this.sampleAt) this.sample();
      this.dollRead(s);
      this.fell(s);
      this.t += h;
      return false;
    }
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
    const p = this.thingSlot >= 0 ? this.cars[this.thingSlot]!.group.position : this.centre(s.thing, _p);
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

  /**
   * A thrown dummy, before each slice: his first contact (`DOLL_READ_S`, `HIT_DV`; the normal is his torso's change of
   * velocity, out of what he met), then the after read at `AFTER_S`. A dummy's throw reads no momentum or crush.
   */
  private dollRead(s: LabShot): void {
    if (!this.dolls?.torso(this.thingDoll, _p, _u)) return;
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
    if (_d.length() > HIT_DV && _p.y - this.ground.heightAt(_p.x, _p.z, _p.y) > GROUND_REACH) {
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

  /** What a dummy's torso at `p` met: the nearest other item whose middle is within `DOLL_REACH`, else the wall when he is at the board, else nothing known. */
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
