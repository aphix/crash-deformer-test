import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import { Surface } from "../world/surfaces.ts";
import { bodyTopY } from "./car-mesh.ts";
import type { BodyStyle } from "./car-variants.ts";
import { FACES, FACE_AXIS, FACE_TOP, faceFollow, faceMax, faceStrength } from "../deform/load-crush.ts";
import { CLASSES, carClass } from "./vehicle-classes.ts";

/**
 * What a body in flight (`stepAir`) rests on besides the world's ground: the other cars' tops, as the dynamic part of the
 * one surface store (`world/surfaces.ts`), and the load crush of the face it presses (`load-crush.ts`). Car `i`'s roof is
 * patch `i` of this surface (a plate over its body, `sync`ed from its pose each slice), seen by a hull point or a wheel as it
 * sees a road, so a car landed on a roof stands on it, and the roof under it yields to its weight by the face's strength law.
 * A car carried this way presses back: `press` hands its reaction to the car under it, so a stack's lowest roof carries every
 * car above it.
 *
 * A face is a budget slot: a car's own faces (the ground it hits, by contact normal: roof, nose, tail, flanks) are
 * slots `0..FACES-1`, and car `i`'s top is slot `FACES·(1+i)`. Per slice a slot may pass `strength × weight × g × dt`
 * of impulse; a contact asking for more yields, and its penetration becomes crush depth (`commit`).
 */

/** A point this far (m) under another car's top counts as standing on it; deeper is inside the car (the plan SAT's, `shareHeight`). */
export const SKIN = 0.25;
/** A car more than ~60° off vertical is not a surface to stand on. */
export const UPRIGHT = 0.5;
/** Plan radius (m) past which a car's top is out of reach: its half-diagonal. */
const REACH = 2.5;
/**
 * Plan slack (m) of a roof list (`reach`) over 2·REACH: a list stands for the rest of its slice, through which two cars closing at
 * 60 m/s each move 2 m in a 1/60 s slice, and a query must find every roof the patch boxes (`sync`) hold under its point.
 */
const NEAR_SLACK = 2;
/** A top point that follows its car's roof crush less than this is rigid (bonnet and boot ends carry, never yield). */
const YIELDS = 0.3;
/** The top within this (m) of the middle across and 0.5 m of the crown along is one flat plate at the crown's height: the roof's crown is 3 cm across and 9 cm along, and a belly on a ridge rolls or pitches off. */
const PLATE = 0.5;
const CROWN_Z = -0.1;
/** The keel's height (m) over a car's origin at the stock ride; the class's body lift (`bellyY`) is on top of it. */
export const BELLY_Y = 0.13;

/** How high (m) over `car`'s origin its belly rides: a car on another's roof sits its roof's crown less this over that car's origin. */
export function bellyY(car: DeformableCar): number {
  return BELLY_Y + CLASSES[carClass(car)].lift;
}

const CROWNS = new WeakMap<BodyStyle, number>();

/** Highest point of a body style's roof along its centreline (m over the car's origin at the stock ride). */
function roofCrown(style: BodyStyle): number {
  let top = CROWNS.get(style);
  if (top === undefined) {
    top = 0;
    for (let z = -2.2; z <= 2.2; z += 0.1) top = Math.max(top, bodyTopY(0, z, style) || 0);
    CROWNS.set(style, top);
  }
  return top;
}

/** How high (m) over `car`'s origin its roof's crown stands now (class lift on, load crush off): the surface a car above stands on. */
export function roofHeight(car: DeformableCar): number {
  return roofCrown(car.style) + CLASSES[carClass(car)].lift - car.deform.crush[FACE_TOP]!;
}

const _t = new THREE.Vector3();
const _qi = new THREE.Quaternion();

/** `bodyTopY` with the roof's crown flattened into a plate (NaN past the body's plan). */
function plate(x: number, z: number, style: BodyStyle): number {
  return bodyTopY(x < 0 ? Math.min(x, -PLATE) : Math.max(x, PLATE), Math.abs(z - CROWN_Z) < PLATE ? CROWN_Z : z, style);
}

/** Each style's `plate` on a `GRID_STEP` grid over the body's plan (x ±`GRID_X`, z ±`GRID_Z`; NaN off the body), built once. */
const GRID_STEP = 0.1;
const GRID_X = 0.9;
const GRID_Z = 2.25;
const GRID_NX = Math.round((2 * GRID_X) / GRID_STEP) + 1;
const GRID_NZ = Math.round((2 * GRID_Z) / GRID_STEP) + 1;
const GRIDS = new WeakMap<BodyStyle, Float32Array>();

function topGrid(style: BodyStyle): Float32Array {
  let g = GRIDS.get(style);
  if (!g) {
    g = new Float32Array(GRID_NX * GRID_NZ);
    for (let j = 0; j < GRID_NZ; j++) for (let i = 0; i < GRID_NX; i++) g[j * GRID_NX + i] = plate(i * GRID_STEP - GRID_X, j * GRID_STEP - GRID_Z, style);
    GRIDS.set(style, g);
  }
  return g;
}

/** Each style's per-node follow of the roof's crush (`faceFollow` at the plate's height; NaN where the plate is), built once. */
const FOLLOWS = new WeakMap<BodyStyle, Float32Array>();

function topFollow(style: BodyStyle): Float32Array {
  let a = FOLLOWS.get(style);
  if (!a) {
    const g = topGrid(style);
    a = new Float32Array(g.length);
    for (let k = 0; k < g.length; k++) a[k] = faceFollow(FACE_TOP, 0, g[k]!, 0);
    FOLLOWS.set(style, a);
  }
  return a;
}

/** The plate's highest node (m): what a tilted slot's box grows by. */
function plateMax(g: Float32Array): number {
  let m = 0;
  for (let k = 0; k < g.length; k++) if (Math.abs(g[k]!) > m) m = Math.abs(g[k]!);
  return m;
}

/** A slot's plate before its first sync: no body. */
const NO_PLATE = new Float32Array(4).fill(NaN);
/** A slot's frame axes (the car's matrixWorld columns), scratch of `sync`. */
const _axes = new Float64Array(9);

export class CarSurfaces extends Surface {
  /** The world's cars (replaced per step by `stepWorld`); car `i`'s roof is patch `i`. */
  cars: readonly DeformableCar[] = [];
  /** The car being stepped: its own top is never its ground. */
  private self: DeformableCar | null = null;
  /** The style each slot's plate data is for. */
  private styles: (BodyStyle | undefined)[] = [];
  private left = new Float64Array(FACES);
  private yielded = new Uint8Array(FACES);
  private grew = new Float64Array(FACES);
  private react = new Float64Array(1);
  private touched = new Uint8Array(1);
  /** The slot whose roofs within reach `always` lists (`reach`). */
  private nearOf = -1;

  /** A car's slice starts: nothing of any face is spent, yielded or pressed yet, and a query is asked of the roofs within reach of its plan. */
  begin(car: DeformableCar): void {
    this.self = car;
    const m = this.cars.length;
    const n = FACES * (1 + m);
    if (this.left.length < n) {
      this.left = new Float64Array(n);
      this.yielded = new Uint8Array(n);
      this.grew = new Float64Array(n);
      this.react = new Float64Array(1 + m);
      this.touched = new Uint8Array(1 + m);
    }
    this.left.fill(NaN);
    this.yielded.fill(0);
    this.grew.fill(0);
    this.react.fill(0);
    this.touched.fill(0);
    this.reach(car);
  }

  /** A query asked by car `skip` tests the roofs within reach of that car's plan, whoever's slice is under way: a wreck's masses read the ground under their hubs at the end of the slice. */
  override near(skip: number): void {
    if (skip !== this.nearOf && skip >= 0 && skip < this.cars.length) this.reach(this.cars[skip]!);
  }

  /** `always`: the roofs that may meet `car`'s points, while the two plans are within 2·REACH (a hull point sits up to REACH from its car's origin). */
  private reach(car: DeformableCar): void {
    const m = this.cars.length;
    if (this.always.length < m) this.always = new Int32Array(m);
    const p = car.group.position;
    const r = 2 * REACH + NEAR_SLACK;
    let k = 0;
    for (let i = 0; i < m && i < this.count; i++) {
      const o = this.cars[i]!;
      if (i === car.slot || o.falling || o.vaporized) continue;
      if (Math.abs(o.group.position.x - p.x) < r && Math.abs(o.group.position.z - p.z) < r) this.always[k++] = i;
    }
    this.nAlways = k;
    this.nearOf = car.slot;
  }

  /** The face slot a contact presses: car `own`'s top where the point (hit factor `follow`) follows its crush, else the stepping car's face under normal `nrm` (body points only; -1: rigid). */
  slot(own: number, nrm: THREE.Vector3, body: boolean, q: THREE.Quaternion, follow: number): number {
    if (own >= 0) return follow >= YIELDS && !this.cars[own]!.deform.massActive ? FACES * (1 + own) + FACE_TOP : -1;
    if (!body) return -1;
    _t.copy(nrm).applyQuaternion(_qi.copy(q).invert());
    let best = -1;
    let score = 0.5;
    for (let f = 0; f < FACES; f++) {
      const s = -(FACE_AXIS[f * 3]! * _t.x + FACE_AXIS[f * 3 + 1]! * _t.y + FACE_AXIS[f * 3 + 2]! * _t.z);
      if (s > score) {
        score = s;
        best = f;
      }
    }
    return best;
  }

  private carOf(slot: number): DeformableCar {
    return slot < FACES ? this.self! : this.cars[(slot / FACES | 0) - 1]!;
  }

  /** `jn` (per unit mass of the stepping car) cut to what slot `slot` still carries this slice at `g`, `dt`; a cut marks the slot yielding. */
  take(slot: number, jn: number, g: number, dt: number): number {
    if (Number.isNaN(this.left[slot]!)) {
      const o = this.carOf(slot);
      this.left[slot] = faceStrength(slot % FACES, o.deform.crush[slot % FACES]!) * g * dt * (o.deform.totalMass / this.self!.deform.totalMass);
    }
    const j = Math.min(jn, this.left[slot]!);
    this.left[slot]! -= j;
    if (j < jn) this.yielded[slot] = 1;
    return j;
  }

  /** The impulse `jn·ny` (per unit mass) the stepping car pressed on car `own` through the contact. */
  press(own: number, j: number): void {
    this.react[own]! += j;
  }

  /** The stepping car has a point in car `own`'s top this slice, pressing or not: a body at rest has slices with no impulse. */
  touch(own: number): void {
    this.touched[own] = 1;
  }

  /** Contact penetration `pen` (m) at a point of slot `slot`, which `follow` of the face's depth reaches. */
  note(slot: number, pen: number, follow: number): void {
    this.grew[slot] = Math.max(this.grew[slot]!, pen / follow);
  }

  isYielding(slot: number): boolean {
    return this.yielded[slot] !== 0;
  }

  /** The slice ends: yielding slots sink by their deepest contact, and the cars carried take the weight pressed on them. Returns whether any slot yielded. */
  commit(): boolean {
    const self = this.self!;
    let any = false;
    for (let s = 0; s < this.grew.length; s++) {
      if (this.yielded[s] === 0) continue;
      any = true;
      if (this.grew[s] === 0) continue;
      const car = this.carOf(s);
      // A car with a load-crushed face is a wreck: it rides the replay's and netplay's wreck sections.
      car.crashed = true;
      const d = car.deform;
      const f = s % FACES;
      d.crush[f] = Math.min(faceMax(f), d.crush[f]! + this.grew[s]!);
      d.bakeLoadCrush();
    }
    let top = 0;
    self.restsOn = null;
    for (let i = 0; i < this.cars.length; i++) {
      const o = this.cars[i]!;
      const j = this.react[i]!;
      if (j === 0) continue;
      if (j > top) {
        top = j;
        self.restsOn = o;
      }
      // The car under takes the push where its own contacts move it (the rigid step): one on another's roof is on its wheels, not in
      // the air, and skipping it there dropped every load but its rider's from a stack's bottom roof (0.024 m under 1, 2 or 3 cars).
      if (o.rigid) o.velocity.y -= (j * self.deform.totalMass) / o.deform.totalMass;
    }
    if (self.restsOn === null) {
      for (let i = 0; i < this.cars.length; i++) {
        if (this.touched[i] !== 0) {
          self.restsOn = this.cars[i]!;
          break;
        }
      }
    }
    self.yielding = any;
    return any;
  }

  /** Car `i`'s roof slot from its pose (call after the car's integrate/pose each slice): a plate at the roof's crown, lifted by the class, sinking by the crush along its follow. The roofs a query lists (`reach`) are listed again after it. */
  sync(i: number, car: DeformableCar): void {
    this.nearOf = -1;
    for (let k = this.count; k <= i; k++) {
      this.addGrid({ nu: 2, nv: 2, step: 1, stepV: 1, u0: 0, v0: 0, heights: NO_PLATE, ox: 0, oy: 0, oz: 0, reach: SKIN, hmax: 0 });
      this.own(k, k);
      this.disable(k);
    }
    if (this.styles[i] !== car.style) {
      const heights = topGrid(car.style);
      this.setGridData(i, GRID_NX, GRID_NZ, GRID_STEP, GRID_STEP, -GRID_X, -GRID_Z, heights, topFollow(car.style), plateMax(heights));
      this.styles[i] = car.style;
    }
    const e = car.group.matrixWorld.elements;
    const lift = CLASSES[carClass(car)].lift;
    _axes[0] = e[0]!;
    _axes[1] = e[1]!;
    _axes[2] = e[2]!;
    _axes[3] = e[4]!;
    _axes[4] = e[5]!;
    _axes[5] = e[6]!;
    _axes[6] = e[8]!;
    _axes[7] = e[9]!;
    _axes[8] = e[10]!;
    this.setDrop(i, car.deform.crush[FACE_TOP]!);
    // The frame is current even for a car that is no surface: the owner rule compares frame heights.
    this.setFrame(i, e[12]! + lift * e[4]!, e[13]! + lift * e[5]!, e[14]! + lift * e[6]!, _axes);
    if (car.falling || car.vaporized || e[5]! < UPRIGHT) this.disable(i);
    else this.clipBox(i, e[12]!, e[14]!, REACH);
  }
}
