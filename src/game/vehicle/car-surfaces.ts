import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import { Surface } from "../world/surfaces.ts";
import type { CageFields, CageStyle } from "./car-cage.ts";
import { cageLift } from "./car-cage-rig.ts";
import { FACES, FACE_AXIS, FACE_TOP, faceFollow, faceMax, faceStrength, IMPRINT_NONE, SKIN_STRAIN } from "../deform/load-crush.ts";
import { PAN } from "./car-suspension.ts";

/**
 * What a body in flight (`stepAir`) rests on besides the world's ground: the other cars' tops, as the dynamic part of the
 * one surface store (`world/surfaces.ts`), and the load crush of the face it presses (`load-crush.ts`). Car `i`'s roof is
 * patch `i` of this surface (the body's drawn top, `sync`ed from its pose each slice), seen by a hull point or a wheel as it
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
const UPRIGHT = 0.5;
/** Plan radius (m) past which a car's top is out of reach: its half-diagonal. */
const REACH = 2.5;
/**
 * Plan slack (m) of a roof list (`reach`) over 2·REACH: a list stands for the rest of its slice, through which two cars closing at
 * 60 m/s each move 2 m in a 1/60 s slice, and a query must find every roof the patch boxes (`sync`) hold under its point.
 */
const NEAR_SLACK = 2;
/** A top point that follows its car's roof crush less than this is rigid (bonnet and boot ends carry, never yield). */
const YIELDS = 0.3;
const ROOFS = new WeakMap<CageStyle, { crown: number; follow: Float32Array }>();

/** A style's pristine roof: its crown (the highest node, m over the car's origin at the stock ride) and per node how far the drawn top follows the roof's crush (`faceFollow` at the node's height, times the share of a mass's travel the skin takes: `SKIN_STRAIN`; NaN where there is no top). */
function roofOf(style: CageStyle): { crown: number; follow: Float32Array } {
  let roof = ROOFS.get(style);
  if (roof === undefined) {
    const top = style.pristine.top;
    const follow = new Float32Array(top.length);
    let crown = 0;
    for (let k = 0; k < top.length; k++) {
      follow[k] = faceFollow(FACE_TOP, 0, top[k]!, 0) * SKIN_STRAIN;
      if (top[k]! > crown) crown = top[k]!;
    }
    ROOFS.set(style, (roof = { crown, follow }));
  }
  return roof;
}

const _t = new THREE.Vector3();
const _qi = new THREE.Quaternion();


/** A pan plane that stands this far (m) over the roof's crown is not pressing it (a tyre, a bumper corner is). */
const IMPRINT_REACH = 0.05;
const _mi = new THREE.Matrix4();
const _pt = new THREE.Vector3();
/** The pan's six points in the pressed roof's frame (x, y, z each), scratch of `imprint`. */
const _pl = new Float64Array(3 * PAN.length);

/** The pan's rise per metre along its own z axis (the drawn underside's slant: the front 23 mm under the rear) and its length (m). */
const PAN_SLOPE = (PAN[3]![1] - PAN[0]![1]) / (PAN[3]![2] - PAN[0]![2]);
const PAN_LENGTH = PAN[3]![2] - PAN[0]![2];

/** `presser`'s `PAN` point `k` (class lift on) in the roof frame `_mi` of a car whose class lift is `lift`, into `_pl` at `3k`. */
function inRoofFrame(presser: DeformableCar, k: number, lift: number): void {
  const p = PAN[k]!;
  _pt.set(p[0], p[1] + cageLift(presser), p[2]).applyQuaternion(presser.group.quaternion).add(presser.group.position).applyMatrix4(_mi);
  _pl[3 * k] = _pt.x;
  _pl[3 * k + 1] = _pt.y - lift;
  _pl[3 * k + 2] = _pt.z;
}

/** Node field `g` (the style's lattice) read bilinear at plan (`x`, `z`) of its car's frame; NaN past the lattice or the body. */
function gridAt(style: CageStyle, g: Float32Array, x: number, z: number): number {
  const u = (x - style.u0) / style.step;
  const v = (z - style.v0) / style.step;
  const i = Math.floor(u);
  const j = Math.floor(v);
  if (!(i >= 0 && j >= 0 && i < style.nu - 1 && j < style.nv - 1)) return NaN;
  const k = j * style.nu + i;
  const tu = u - i;
  return (g[k]! * (1 - tu) + g[k + 1]! * tu) * (1 - (v - j)) + (g[k + style.nu]! * (1 - tu) + g[k + style.nu + 1]! * tu) * (v - j);
}

/**
 * `presser`'s pan, as the belly's imprint in `pressed`'s roof frame (`DeformRig.imprint`, uncrushed): the roof takes the shape of the belly
 * that pressed it, for good. The plane has the pan's own slant, turned by the two cars' relative heading, and runs through the pan's
 * lowest point, then lower to the roof wherever it stands under the plane (a domed roof's shoulders are 10-20 mm under its crown: the
 * dome snaps flat under the belly, which stands on its full width and not on the crown line, on which it rolled 3° each way). The tilt
 * is the belly's, not the pose the car pressed with: a car rocking on a roof it is still crushing walked the imprint's tilt with it, and
 * the stack with it. The plane never rises, and one well over the roof is a tyre's or a corner's press and leaves it. ponytail: one
 * plane per roof, unbounded in plan.
 */
function imprint(presser: DeformableCar, pressed: DeformableCar): void {
  _mi.copy(pressed.group.matrixWorld).invert();
  const lift = cageLift(pressed);
  for (let k = 0; k < PAN.length; k++) inRoofFrame(presser, k, lift);
  const a = (PAN_SLOPE * (_pl[9]! - _pl[0]!)) / PAN_LENGTH;
  const b = (PAN_SLOPE * (_pl[11]! - _pl[2]!)) / PAN_LENGTH;
  let c = Infinity;
  for (let k = 0; k < PAN.length; k++) c = Math.min(c, _pl[3 * k + 1]! - a * _pl[3 * k]! - b * _pl[3 * k + 2]!);
  const d = pressed.deform;
  const im = d.imprint;
  const drop = d.crush[FACE_TOP]!;
  if (!(c <= roofOf(pressed.cage.style).crown - drop + IMPRINT_REACH)) return;
  const old = im[0] !== IMPRINT_NONE;
  const style = pressed.cage.style;
  const top = style.pristine.top;
  const follow = roofOf(style).follow;
  let relief = 0;
  let overRoof = false;
  for (let k = 0; k < PAN.length; k++) {
    const x = _pl[3 * k]!;
    const z = _pl[3 * k + 2]!;
    let surface = gridAt(style, top, x, z) - drop * gridAt(style, follow, x, z);
    if (old) surface = Math.min(surface, im[0]! - drop + im[1]! * x + im[2]! * z);
    const gap = c + a * x + b * z - surface;
    if (!(gap <= IMPRINT_REACH)) continue;
    overRoof = true;
    if (gap > relief) relief = gap;
  }
  if (!overRoof) return;
  im[0] = old ? Math.min(im[0]!, c - relief + drop) : c - relief + drop;
  im[1] = a;
  im[2] = b;
}

/** A slot's top before its first sync: no body. */
const NO_TOP = new Float32Array(4).fill(NaN);
/** A slot's frame axes (the car's matrixWorld columns), scratch of `sync`. */
const _axes = new Float64Array(9);

export class CarSurfaces extends Surface {
  /** The world's cars (replaced per step by `stepWorld`); car `i`'s roof is patch `i`. */
  cars: readonly DeformableCar[] = [];
  /** Called at each slice's end with the stepping car's slot and each car whose top it pressed or touched (`stepWorld` sets `World.partTouch`). */
  met: ((a: number, b: number) => void) | null = null;
  /** The car being stepped: its own top is never its ground. */
  private self: DeformableCar | null = null;
  /** The cage fields each slot's surface shows (the style's shared ones while the car is pristine, else the car's own). */
  private shown: (CageFields | undefined)[] = [];
  private left = new Float64Array(FACES);
  private yielded = new Uint8Array(FACES);
  private grew = new Float64Array(FACES);
  private react = new Float64Array(1);
  private touched = new Uint8Array(1);
  /**
   * Per car, 6 numbers (velocity, spin): the weight the cars resting on its top bore on it at their contacts (`bear`), which its next
   * rigid step takes after its move and before its own contacts, so they hold it and bear it on in turn (`takeBorne`). Pushed into its
   * velocity at once, after its own step, a stack's bottom car moved down at the weight of the nine above (0.19 m/s) every slice and its
   * contacts lifted it back 0.4 mm a slice (1.9 mm a slice at the top): 28-34 kJ of lift every 0.5 s, and the column fell at 13-17 s.
   */
  private borne = new Float64Array(0);
  /** The slot whose roofs within reach `carList` lists (`reach`), `carCount` of them. */
  private nearOf = -1;
  private carList = new Int32Array(0);
  private carCount = 0;
  /** The roofs within reach of a free body's point (a loose part, an FX bit: `near`). */
  private freeList = new Int32Array(0);

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
    this.nearOf = -1;
    this.near(car.slot, car.group.position.x, car.group.position.z);
  }

  /**
   * A query at plan (`x`, `z`) and up to `span` (m) about it, asked by car `skip`, tests the roofs within reach of that car's plan, whoever's slice
   * is under way: a wreck's masses read the ground under their hubs at the end of the slice. A point farther than REACH from car `skip` (a part
   * off it, an FX bit: -1) is a free body's: the roofs within reach of the point, car `skip`'s left out, in a list of their own.
   */
  override near(skip: number, x: number, z: number, span = 0): void {
    const m = this.cars.length;
    if (this.carList.length < m) {
      this.carList = new Int32Array(m);
      this.freeList = new Int32Array(m);
      this.nearOf = -1;
    }
    const p = skip >= 0 && skip < m ? this.cars[skip]!.group.position : null;
    if (p !== null && Math.abs(p.x - x) < REACH - span && Math.abs(p.z - z) < REACH - span) {
      if (skip !== this.nearOf) {
        this.carCount = this.reach(p.x, p.z, skip, this.carList);
        this.nearOf = skip;
      }
      this.always = this.carList;
      this.nAlways = this.carCount;
      return;
    }
    this.always = this.freeList;
    this.nAlways = this.reach(x, z, skip, this.freeList, span);
  }

  /** Into `list`: the roofs but car `skip`'s that may meet a point within REACH + `span` of plan (`x`, `z`), while their plans are within 2·REACH (a hull point sits up to REACH from its car's origin); returns their count. */
  private reach(x: number, z: number, skip: number, list: Int32Array, span = 0): number {
    const m = this.cars.length;
    const r = 2 * REACH + NEAR_SLACK + span;
    let k = 0;
    for (let i = 0; i < m && i < this.count; i++) {
      const o = this.cars[i]!;
      if (i === skip || o.falling || o.vaporized) continue;
      if (Math.abs(o.group.position.x - x) < r && Math.abs(o.group.position.z - z) < r) list[k++] = i;
    }
    return k;
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

  /** What slot `slot` still carries this slice (impulse per unit mass of the stepping car) at `g`, `dt`. */
  room(slot: number, g: number, dt: number): number {
    if (Number.isNaN(this.left[slot]!)) {
      const o = this.carOf(slot);
      this.left[slot] = faceStrength(slot % FACES, o.deform.crush[slot % FACES]!) * g * dt * (o.deform.totalMass / this.self!.deform.totalMass);
    }
    return this.left[slot]!;
  }

  /** `jn` (per unit mass of the stepping car) cut to what slot `slot` still carries this slice at `g`, `dt`; a cut marks the slot yielding. */
  take(slot: number, jn: number, g: number, dt: number): number {
    const j = Math.min(jn, this.room(slot, g, dt));
    this.left[slot]! -= j;
    if (j < jn) this.yielded[slot] = 1;
    return j;
  }

  /** The impulse `jn·ny` (per unit mass) the stepping car pressed on car `own` through the contact: the car pressed hardest carries it (`restsOn`). */
  press(own: number, j: number): void {
    this.react[own]! += j;
  }

  /** Car `own`, under the stepping car, takes `k` of velocity change `dv` and spin change `dw` (the weight borne on it) at its next rigid step. */
  bear(own: number, dv: THREE.Vector3, dw: THREE.Vector3, k: number): void {
    const o = 6 * own;
    const b = this.borne;
    b[o] = b[o]! + dv.x * k;
    b[o + 1] = b[o + 1]! + dv.y * k;
    b[o + 2] = b[o + 2]! + dv.z * k;
    b[o + 3] = b[o + 3]! + dw.x * k;
    b[o + 4] = b[o + 4]! + dw.y * k;
    b[o + 5] = b[o + 5]! + dw.z * k;
  }

  /** The weight borne on car `i` since its last rigid step, into `dv`, `dw` (zero when none), and spent. */
  takeBorne(i: number, dv: THREE.Vector3, dw: THREE.Vector3): void {
    const o = 6 * i;
    const b = this.borne;
    if (i < 0 || o >= b.length) {
      dv.set(0, 0, 0);
      dw.set(0, 0, 0);
      return;
    }
    dv.set(b[o]!, b[o + 1]!, b[o + 2]!);
    dw.set(b[o + 3]!, b[o + 4]!, b[o + 5]!);
    b.fill(0, o, o + 6);
  }

  /**
   * Car `i`'s borne weight (6 doubles) into `buf` at `o`, or with `write` restored from it: the carry of a rider that stepped after its
   * carrier crosses the step boundary, so a highlight keyframe holds it (`DeformableCar.flight`).
   */
  borneState(i: number, buf: Float64Array, o: number, write: boolean): void {
    if (i < 0) return;
    if (write) {
      this.growBorne(i + 1);
      this.borne.set(buf.subarray(o, o + 6), 6 * i);
    } else if (6 * i < this.borne.length) buf.set(this.borne.subarray(6 * i, 6 * i + 6), o);
    else buf.fill(0, o, o + 6);
  }

  private growBorne(cars: number): void {
    if (this.borne.length >= 6 * cars) return;
    const grown = new Float64Array(6 * cars);
    grown.set(this.borne);
    this.borne = grown;
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

  /** The slice ends: yielding slots sink by their deepest contact, and the car pressed hardest (else any touched) carries the stepping car. Returns whether any slot yielded. */
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
      const before = d.crush[f]!;
      d.crush[f] = Math.min(faceMax(f), before + this.grew[s]!);
      // A roof another car's belly sank takes the shape of that belly; the ground's or a wall's press (the stepping car's own faces) has no pan.
      if (f === FACE_TOP && car !== self && d.crush[f]! > before) imprint(self, car);
      d.bakeLoadCrush();
      d.skinLoaded();
    }
    // Every car the stepping car presses or touches this slice met it: a highlight clip that keeps one keeps the other (`World.partTouch`).
    if (this.met) for (let i = 0; i < this.cars.length; i++) if (this.react[i] !== 0 || this.touched[i] !== 0) this.met(self.slot, i);
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

  /** Car `i`'s roof slot from its pose (call after the car's integrate/pose each slice): the cage's top (the drawn body, crush and roof imprint in it), lifted by the class. The roofs a query lists (`reach`) are listed again after it. */
  sync(i: number, car: DeformableCar): void {
    this.nearOf = -1;
    this.growBorne(this.cars.length);
    // Only the rigid step takes the weight borne on it: a car its wheels or its masses carry drops it.
    if (!car.rigid) this.borne.fill(0, 6 * i, 6 * i + 6);
    for (let k = this.count; k <= i; k++) {
      this.addGrid({ nu: 2, nv: 2, step: 1, stepV: 1, u0: 0, v0: 0, heights: NO_TOP, ox: 0, oy: 0, oz: 0, reach: SKIN, hmax: 0 });
      this.own(k, k);
      this.disable(k);
    }
    // The cage is the drawn body (crush, imprint, torn lids and lift in it): its top is the roof, fitted again only past `REFIT_EPSILON`.
    const cage = car.cage;
    const refitted = car.refitCage();
    if (refitted || this.shown[i] !== cage.fields) {
      const { nu, nv, step, u0, v0 } = cage.style;
      this.setGridData(i, nu, nv, step, step, u0, v0, cage.fields.top, roofOf(cage.style).follow, cage.fields.heightMax);
      this.shown[i] = cage.fields;
    }
    const e = car.group.matrixWorld.elements;
    const lift = cageLift(car);
    _axes[0] = e[0]!;
    _axes[1] = e[1]!;
    _axes[2] = e[2]!;
    _axes[3] = e[4]!;
    _axes[4] = e[5]!;
    _axes[5] = e[6]!;
    _axes[6] = e[8]!;
    _axes[7] = e[9]!;
    _axes[8] = e[10]!;
    // The frame is current even for a car that is no surface: the owner rule compares frame heights.
    this.setFrame(i, e[12]! + lift * e[4]!, e[13]! + lift * e[5]!, e[14]! + lift * e[6]!, _axes);
    if (car.falling || car.vaporized || e[5]! < UPRIGHT) this.disable(i);
    else this.clipBox(i, e[12]!, e[14]!, REACH);
  }
}
