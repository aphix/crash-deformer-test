import type { DeformableCar } from "../vehicle/car.ts";
import type { CarCage, CageFields, CageStyle } from "../vehicle/car-cage.ts";
import { CAGE_STEP } from "../vehicle/car-cage.ts";
import { CLASSES, carClass } from "../vehicle/vehicle-classes.ts";

/**
 * How far (m) a covered node stands inside the outline's true edge: `planFieldOf` lays the outline midway between a covered node
 * and its uncovered neighbour, half a lattice step out.
 */
export const OUTLINE_REACH = CAGE_STEP / 2;
/**
 * Two cages whose vertical extents overlap by less than this (m) are one over the other, not side by side: the lattice cannot
 * resolve less (`CAGE_STEP`, the fit's bar), so a car standing on another's roof (the store carries it) is not a plan contact.
 */
export const VERTICAL_CLEAR = CAGE_STEP;
/** How many nodes around a node `bandAround` reads: 15 cm, a few times the lattice's own resolution of the body's edge. */
const VERTICAL_WINDOW = 3;
const _window = new Float64Array(2);

/** One cage's outline as of a fit: the covered nodes that touch an uncovered one (or the lattice's edge), and the cage's height range. */
class CageOutline {
  /** Per outline node: its lattice index and its frame x and z (m). */
  nodes: Int32Array = new Int32Array(0);
  xs: Float64Array = new Float64Array(0);
  zs: Float64Array = new Float64Array(0);
  /** Per outline node: the body's lowest and highest height around it (`bandAround`). */
  lows: Float32Array = new Float32Array(0);
  highs: Float32Array = new Float32Array(0);
  count = 0;
  /** The lowest and the highest height (m) of the cage, in the car's frame without the class lift. */
  low = 0;
  high = 0;
  private serial = -1;
  private fields: object | null = null;

  /** Rebuilds the node list when `cage` has been refitted since (or on the first ask). */
  refresh(cage: CarCage): this {
    if (this.fields === cage.fields && this.serial === cage.serial) return this;
    this.fields = cage.fields;
    this.serial = cage.serial;
    const { nu, nv, step, u0, v0 } = cage.style;
    const { covered, top, bottom } = cage.fields;
    if (this.nodes.length < nu * nv) {
      this.nodes = new Int32Array(nu * nv);
      this.xs = new Float64Array(nu * nv);
      this.zs = new Float64Array(nu * nv);
      this.lows = new Float32Array(nu * nv);
      this.highs = new Float32Array(nu * nv);
    }
    let count = 0;
    let low = Infinity;
    let high = -Infinity;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const k = j * nu + i;
        if (covered[k] === 0) continue;
        if (bottom[k]! < low) low = bottom[k]!;
        if (top[k]! > high) high = top[k]!;
        const edge = i === 0 || j === 0 || i === nu - 1 || j === nv - 1 || covered[k - 1] === 0 || covered[k + 1] === 0 || covered[k - nu] === 0 || covered[k + nu] === 0;
        if (!edge) continue;
        this.nodes[count] = k;
        this.xs[count] = u0 + i * step;
        this.zs[count] = v0 + j * step;
        bandAround(cage.fields, cage.style, i, j, _window);
        this.lows[count] = _window[0]!;
        this.highs[count] = _window[1]!;
        count++;
      }
    }
    this.count = count;
    this.low = low;
    this.high = high;
    return this;
  }
}

const OUTLINES = new WeakMap<CarCage, CageOutline>();

/** `car`'s cage outline as of its last fit (built once per fit, the first time a pair asks). */
export function outlineOf(car: DeformableCar): CageOutline {
  const cage = car.cage;
  let outline = OUTLINES.get(cage);
  if (outline === undefined) {
    outline = new CageOutline();
    OUTLINES.set(cage, outline);
  }
  return outline.refresh(cage);
}

/**
 * `sampleAt`'s query and answer: frame x and z in `SAMPLE[0]`, `SAMPLE[1]`, the value out in `SAMPLE[2]`. A call V8 does not inline
 * boxes every double it takes or returns, and the per-node loops of `satCars` make thousands of them a frame.
 */
export const SAMPLE = new Float64Array(3);

/** `field` (a per-node lattice field of `style`) bilinear at frame (`SAMPLE[0]`, `SAMPLE[1]`) → `SAMPLE[2]`; NaN outside the lattice. */
export function sampleAt(field: Float32Array, style: CageStyle): void {
  const fu = (SAMPLE[0]! - style.u0) / style.step;
  const fv = (SAMPLE[1]! - style.v0) / style.step;
  const i = Math.floor(fu);
  const j = Math.floor(fv);
  if (i < 0 || j < 0 || i + 1 >= style.nu || j + 1 >= style.nv) {
    SAMPLE[2] = NaN;
    return;
  }
  const a = fu - i;
  const b = fv - j;
  const k = j * style.nu + i;
  SAMPLE[2] = (field[k]! * (1 - a) + field[k + 1]! * a) * (1 - b) + (field[k + style.nu]! * (1 - a) + field[k + style.nu + 1]! * a) * b;
}

/** `field` bilinear at frame (x, z); NaN outside the lattice. Off the hot path: `sampleAt` is the one that boxes nothing. */
export function sampleField(field: Float32Array, style: CageStyle, x: number, z: number): number {
  SAMPLE[0] = x;
  SAMPLE[1] = z;
  sampleAt(field, style);
  return SAMPLE[2]!;
}

/**
 * The lowest and highest height (`out[0]`, `out[1]`, m; frame, no class lift) of the covered nodes within `VERTICAL_WINDOW` nodes of
 * node (i, j): an outline node's own top and bottom are a sliver of the body's edge (a hood's lip, 5 mm thick), the body's height at
 * that place is what the window around it holds. Infinity, -Infinity when none is covered.
 */
export function bandAround(fields: CageFields, style: CageStyle, i: number, j: number, out: Float64Array): void {
  const { nu, nv } = style;
  const i1 = Math.min(nu - 1, i + VERTICAL_WINDOW);
  const j1 = Math.min(nv - 1, j + VERTICAL_WINDOW);
  let low = Infinity;
  let high = -Infinity;
  for (let jj = Math.max(0, j - VERTICAL_WINDOW); jj <= j1; jj++) {
    for (let ii = Math.max(0, i - VERTICAL_WINDOW); ii <= i1; ii++) {
      const k = jj * nu + ii;
      if (fields.covered[k] === 0) continue;
      if (fields.bottom[k]! < low) low = fields.bottom[k]!;
      if (fields.top[k]! > high) high = fields.top[k]!;
    }
  }
  out[0] = low;
  out[1] = high;
}

const _band = new Float64Array(2);

/**
 * The world heights (`_band[0]` lowest, `_band[1]` highest, m) the box over `car`'s cage (its plan box, its height range, the class
 * lift on) spans as the car's group tilts it. Reads the group's world matrix (fresh after `refreshBasis`/`syncPose`).
 */
function worldBand(car: DeformableCar): void {
  const e = car.group.matrixWorld.elements;
  const o = outlineOf(car);
  const box = car.cage.fields.planBox;
  const lift = CLASSES[carClass(car)].lift;
  let lo = e[13]!;
  let hi = e[13]!;
  for (let axis = 0; axis < 3; axis++) {
    const c = e[1 + axis * 4]!;
    const p = axis === 0 ? box[0]! : axis === 1 ? o.low + lift : box[2]!;
    const q = axis === 0 ? box[1]! : axis === 1 ? o.high + lift : box[3]!;
    lo += c >= 0 ? c * p : c * q;
    hi += c >= 0 ? c * q : c * p;
  }
  _band[0] = lo;
  _band[1] = hi;
}

/**
 * Whether the two cars' bodies span heights that overlap by more than `VERTICAL_CLEAR`: a car flying over another, on a bridge over
 * it, or standing on its roof does not meet it in the plan (a cage's own top carries the car on it, in the store).
 */
export function bandsMeet(a: DeformableCar, b: DeformableCar): boolean {
  worldBand(a);
  const aLo = _band[0]!;
  const aHi = _band[1]!;
  worldBand(b);
  return Math.min(aHi, _band[1]!) - Math.max(aLo, _band[0]!) > VERTICAL_CLEAR;
}
