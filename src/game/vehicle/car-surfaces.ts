import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import { activeGround, NO_FLOOR, type Ground } from "../world/ground.ts";
import { bodyTopY } from "./car-mesh.ts";
import type { BodyStyle } from "./car-variants.ts";
import { FACES, FACE_AXIS, FACE_TOP, faceFollow, faceMax, faceStrength } from "../deform/load-crush.ts";
import { CLASSES, carClass } from "./vehicle-classes.ts";

/**
 * What a body in flight (`stepAir`) rests on: the world's ground and the other cars' tops, through the one `Ground`
 * door, and the load crush of the face it presses (`load-crush.ts`). A hull point sees another car's top (`bodyTopY`
 * sunk by that car's crush depth) as it sees a road, so a car landed on a roof stands on it, and the roof under it
 * yields to its weight by the face's strength law. A car carried this way presses back: `press` hands its reaction to
 * the car under it, so a stack's lowest roof carries every car above it.
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
/** A top point that follows its car's roof crush less than this is rigid (bonnet and boot ends carry, never yield). */
const YIELDS = 0.3;
/** The top within this (m) of the middle across and 0.5 m of the crown along is one flat plate at the crown's height: the roof's crown is 3 cm across and 9 cm along, and a belly on a ridge rolls or pitches off. */
const PLATE = 0.5;
const CROWN_Z = -0.1;
/** The keel's height (m) over a car's origin at the stock ride; the class's body lift (`bellyY`) is on top of it. */
const BELLY_Y = 0.13;

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

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
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

export class CarSurfaces implements Ground {
  /** Whether any other car's top is within reach of the stepping car's plan: the belly meets nothing else. */
  near = false;
  /** The world's cars (replaced per step by `stepWorld`). */
  cars: readonly DeformableCar[] = [];
  /** The car being stepped: its own top is never its ground. */
  private self: DeformableCar | null = null;
  /** Index of the car whose top answered the last `heightAt`, -1 for the world's ground, and how far that point follows its roof's crush. */
  owner = -1;
  follow = 0;
  private left = new Float64Array(FACES);
  private yielded = new Uint8Array(FACES);
  private grew = new Float64Array(FACES);
  private react = new Float64Array(1);

  /** A car's slice starts: nothing of any face is spent, yielded or pressed yet. */
  begin(car: DeformableCar): void {
    this.self = car;
    const n = FACES * (1 + this.cars.length);
    if (this.left.length < n) {
      this.left = new Float64Array(n);
      this.yielded = new Uint8Array(n);
      this.grew = new Float64Array(n);
      this.react = new Float64Array(1 + this.cars.length);
    }
    this.left.fill(NaN);
    this.yielded.fill(0);
    this.grew.fill(0);
    this.react.fill(0);
    this.owner = -1;
    this.near = this.nearTo(car);
  }

  /** Whether another car's plan is within reach of `car`'s: it may meet that car's top (the belly's queries, the contact sub-steps). */
  nearTo(car: DeformableCar): boolean {
    const p = car.group.position;
    for (const o of this.cars) {
      if (o !== car && Math.abs(o.group.position.x - p.x) < 2 * REACH && Math.abs(o.group.position.z - p.z) < 2 * REACH) return true;
    }
    return false;
  }

  /** The face slot a contact presses: car `own`'s top (a point that follows its crush), else the stepping car's face under normal `nrm` (body points only; -1: rigid). */
  slot(own: number, nrm: THREE.Vector3, body: boolean, q: THREE.Quaternion): number {
    if (own >= 0) return this.follow >= YIELDS && !this.cars[own]!.deform.massActive ? FACES * (1 + own) + FACE_TOP : -1;
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
      if (o.airborne) o.velocity.y -= (j * self.deform.totalMass) / o.deform.totalMass;
    }
    self.yielding = any;
    return any;
  }

  /** How far the surface point `top` last answered follows its car's roof crush. */
  private topFollow = 0;

  /** The surface of car `o` at world plan (x, z) seen from height `y`: its world height or NO_FLOOR; sets `_n` and `topFollow`. */
  private top(o: DeformableCar, x: number, z: number, y: number): number {
    const e = o.group.matrixWorld.elements;
    if (e[5]! < UPRIGHT || Math.abs(x - e[12]!) > REACH || Math.abs(z - e[14]!) > REACH) return NO_FLOOR;
    const dx = x - e[12]!;
    const dy = y - e[13]!;
    const dz = z - e[14]!;
    const xl = e[0]! * dx + e[1]! * dy + e[2]! * dz;
    const zl = e[8]! * dx + e[9]! * dy + e[10]! * dz;
    const grid = topGrid(o.style);
    const u = (xl + GRID_X) / GRID_STEP;
    const v = (zl + GRID_Z) / GRID_STEP;
    const i = Math.floor(u);
    const j = Math.floor(v);
    if (i < 0 || j < 0 || i >= GRID_NX - 1 || j >= GRID_NZ - 1) return NO_FLOOR;
    const k = j * GRID_NX + i;
    const h00 = grid[k]!;
    const h10 = grid[k + 1]!;
    const h01 = grid[k + GRID_NX]!;
    const h11 = grid[k + GRID_NX + 1]!;
    if (Number.isNaN(h00 + h10 + h01 + h11)) return NO_FLOOR;
    const fx = u - i;
    const fz = v - j;
    const h0 = (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
    const depth = o.deform.crush[FACE_TOP]!;
    this.topFollow = faceFollow(FACE_TOP, 0, h0, 0);
    _p.set(xl, h0 - depth * this.topFollow + CLASSES[carClass(o)].lift, zl).applyMatrix4(o.group.matrixWorld);
    if (y < _p.y - SKIN) return NO_FLOOR;
    const gx = ((h10 - h00) * (1 - fz) + (h11 - h01) * fz) / GRID_STEP;
    const gz = ((h01 - h00) * (1 - fx) + (h11 - h10) * fx) / GRID_STEP;
    _n.set(-gx, 1, -gz).normalize().transformDirection(o.group.matrixWorld);
    return _p.y;
  }

  heightAt(x: number, z: number, y?: number): number {
    let best = activeGround().heightAt(x, z, y);
    this.owner = -1;
    if (y === undefined) return best;
    for (let i = 0; i < this.cars.length; i++) {
      const o = this.cars[i]!;
      if (o === this.self || o.falling || o.vaporized) continue;
      const h = this.top(o, x, z, y);
      if (h > best) {
        best = h;
        this.owner = i;
        this.follow = this.topFollow;
      }
    }
    return best;
  }

  normalAt<T extends { x: number; y: number; z: number }>(x: number, z: number, out: T, y?: number): T {
    if (this.owner < 0 || y === undefined) return activeGround().normalAt(x, z, out, y);
    this.top(this.cars[this.owner]!, x, z, y);
    out.x = _n.x;
    out.y = _n.y;
    out.z = _n.z;
    return out;
  }

  frictionAt(x: number, z: number, y?: number): number {
    return activeGround().frictionAt(x, z, y);
  }

  surfaceAt(x: number, z: number, y?: number) {
    return activeGround().surfaceAt(x, z, y);
  }
}
