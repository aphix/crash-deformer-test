import * as THREE from "three";
import { launch, makeWorld, tickWorld, type CrashWorld } from "../contact/crash-scenarios.test-util.ts";
import { FACE_TOP } from "../deform/load-crush.ts";
import { armTops, C_H, C_OWNER, HIT_SIZE, pointContact, PQ_SIZE, PQ_X, PQ_Y, PQ_Z } from "../world/surfaces.ts";
import { cageLift } from "./car-cage-rig.ts";
import { CarSurfaces } from "./car-surfaces.ts";
import { DeformableCar } from "./car.ts";
import type { CarStyleId } from "./car-variants.ts";
import { paint } from "./test-support.ts";
import { armKill, assignClass, killClass, type VehicleClassId } from "./vehicle-classes.ts";

/**
 * The drawn body as the player sees it, for the tests that hold a collider against it (docs/UNIFIED_CONTACT.md stage 3: "the
 * cage is the body"). Every visible mesh under the car, after the skin is written, rasterised to a 5 cm height field in the
 * car's own frame, and sampled as a point cloud in the world. Not a test file itself.
 */
const STEP = 0.05;
const X0 = -1.3;
const Z0 = -2.7;
export const NX = Math.round(2.6 / STEP);
export const NZ = Math.round(5.4 / STEP);
export const cellX = (i: number): number => X0 + (i + 0.5) * STEP;
export const cellZ = (j: number): number => Z0 + (j + 0.5) * STEP;
export const cellI = (x: number): number => Math.floor((x - X0) / STEP);
export const cellJ = (z: number): number => Math.floor((z - Z0) / STEP);

/** Car-local height field of the drawn body: highest and lowest drawn y per cell (NaN where nothing is drawn). */
export type DrawnField = { top: Float32Array; bottom: Float32Array };

/** The realism of the owner's clip (REPLAY 41, local://clip-forensics.md) and of the collider audit. */
const CLIP_REALISM = 0.25;

/** A car of body `style` and class `cls` in the calibrated shape-deform mode, its own scene, its kill limits armed as the fleet arms them. */
export function buildCar(style: CarStyleId, cls: VehicleClassId): DeformableCar {
  const car = new DeformableCar(paint(), new THREE.Scene(), null, style);
  assignClass(car, cls);
  car.deform.setMode("shape");
  armKill(car.deform, killClass(car), CLIP_REALISM, "default");
  return car;
}

/** Writes the owed skin and returns every visible mesh triangle of `car` in its own frame (x, y, z per vertex, 9 numbers a triangle). */
export function drawnTriangles(car: DeformableCar): Float32Array {
  car.flushDeferredSkin();
  car.updateSkin();
  car.group.updateMatrixWorld(true);
  const inverse = car.group.matrixWorld.clone().invert();
  const chunks: Float32Array[] = [];
  let total = 0;
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  car.group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.name === "deform-rig" || !p.visible) return;
    const pos = o.geometry.getAttribute("position");
    if (!pos || pos.count === 0) return;
    const index = o.geometry.index;
    const n = index ? index.count : pos.count;
    const out = new Float32Array(n * 3);
    m.multiplyMatrices(inverse, o.matrixWorld);
    for (let k = 0; k < n; k++) {
      v.fromBufferAttribute(pos, index ? index.getX(k) : k).applyMatrix4(m);
      out[k * 3] = v.x;
      out[k * 3 + 1] = v.y;
      out[k * 3 + 2] = v.z;
    }
    chunks.push(out);
    total += out.length;
  });
  const tris = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    tris.set(c, at);
    at += c.length;
  }
  return tris;
}

/** The car-local triangles rasterised to the 5 cm field: each cell's highest and lowest drawn height. */
export function rasterise(tris: Float32Array): DrawnField {
  const top = new Float32Array(NX * NZ).fill(NaN);
  const bottom = new Float32Array(NX * NZ).fill(NaN);
  for (let t = 0; t + 8 < tris.length; t += 9) {
    const ax = tris[t]!;
    const ay = tris[t + 1]!;
    const az = tris[t + 2]!;
    const bx = tris[t + 3]!;
    const by = tris[t + 4]!;
    const bz = tris[t + 5]!;
    const qx = tris[t + 6]!;
    const qy = tris[t + 7]!;
    const qz = tris[t + 8]!;
    const den = (bz - qz) * (ax - qx) + (qx - bx) * (az - qz);
    if (Math.abs(den) < 1e-12) continue;
    const i0 = Math.max(0, cellI(Math.min(ax, bx, qx)));
    const i1 = Math.min(NX - 1, cellI(Math.max(ax, bx, qx)));
    const j0 = Math.max(0, cellJ(Math.min(az, bz, qz)));
    const j1 = Math.min(NZ - 1, cellJ(Math.max(az, bz, qz)));
    for (let j = j0; j <= j1; j++) {
      const z = cellZ(j);
      for (let i = i0; i <= i1; i++) {
        const x = cellX(i);
        const l1 = ((bz - qz) * (x - qx) + (qx - bx) * (z - qz)) / den;
        const l2 = ((qz - az) * (x - qx) + (ax - qx) * (z - qz)) / den;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
        const y = l1 * ay + l2 * by + l3 * qy;
        const k = j * NX + i;
        if (!(top[k]! >= y)) top[k] = y;
        if (!(bottom[k]! <= y)) bottom[k] = y;
      }
    }
  }
  return { top, bottom };
}

/** Where `car`'s drawn body is, as the 5 cm field. */
export function drawnField(car: DeformableCar): DrawnField {
  return rasterise(drawnTriangles(car));
}

/** A car-local box [x0, x1] × [z0, z1] of the body (m): the part of it a gap is read over. */
export type Region = { x0: number; x1: number; z0: number; z1: number };

/** The top-down parts of a car whose tops other cars stand on (z forward). */
export const TOP_PARTS = {
  hood: { x0: -0.6, x1: 0.6, z0: 1.0, z1: 1.9 },
  cabin: { x0: -0.4, x1: 0.4, z0: -0.5, z1: 0.45 },
  deck: { x0: -0.6, x1: 0.6, z0: -2.0, z1: -1.0 },
} as const satisfies Record<string, Region>;

/** The underside between the wheels (the belly a car rests on another's roof by). */
export const BELLY: Region = { x0: -0.5, x1: 0.5, z0: -1, z1: 1 };

/** The highest drawn top and the lowest drawn underside (car-local y, m) over `region`. */
export function drawnRange(field: DrawnField, region: Region): { top: number; bottom: number } {
  let top = -Infinity;
  let bottom = Infinity;
  for (let j = cellJ(region.z0); j <= cellJ(region.z1); j++) {
    for (let i = cellI(region.x0); i <= cellI(region.x1); i++) {
      const k = j * NX + i;
      if (field.top[k]! > top) top = field.top[k]!;
      if (field.bottom[k]! < bottom) bottom = field.bottom[k]!;
    }
  }
  return { top, bottom };
}

/** The signed gaps (m) of a collider's top over the drawn top in `region`: collider minus drawn, + is a collider above the drawn body. */
export type TopGaps = { cells: number; p95: number; worstUp: number; worstDown: number; missing: number };

/** The stated tolerance of a collider's top against the drawn top (docs/UNIFIED_CONTACT.md section 8: the cage within `SKIN` 0.2 m, ideally 5 cm): 95 % of cells within 5 cm, every cell within 10 cm, at most 2 % of drawn cells unanswered. */
export const TOP_P95_M = 0.05;
export const TOP_WORST_M = 0.1;
const TOP_MISSING_SHARE = 0.02;

/** What is outside the tolerance in `gaps` over `part` (empty: all within). */
export function topGapsOff(part: string, gaps: TopGaps): string[] {
  const off: string[] = [];
  if (gaps.p95 > TOP_P95_M) off.push(`${part} p95 ${gaps.p95.toFixed(2)} m`);
  if (Math.max(gaps.worstUp, -gaps.worstDown) > TOP_WORST_M) off.push(`${part} worst ${gaps.worstUp > -gaps.worstDown ? `+${gaps.worstUp.toFixed(2)} m over` : `${gaps.worstDown.toFixed(2)} m under`} the drawn top`);
  if (gaps.missing > TOP_MISSING_SHARE * gaps.cells) off.push(`${part} no surface over ${gaps.missing} of ${gaps.cells} cells`);
  return off;
}

const _hit = new Float64Array(HIT_SIZE);
const _q = new Float64Array(PQ_SIZE);

/** `pointContact` at plan (x, z) asking from height y, as a body in slot 1 does. */
function askFrom(x: number, y: number, z: number): void {
  _q[PQ_X] = x;
  _q[PQ_Z] = z;
  _q[PQ_Y] = y;
  pointContact(_q, 1, _hit);
}
const _w = new THREE.Vector3();

/** `gaps` sorted ascending in |value|, its 95th percentile (0 when empty). */
function p95(gaps: number[]): number {
  if (gaps.length === 0) return 0;
  const a = gaps.map(Math.abs).sort((p, q) => p - q);
  return a[Math.min(a.length - 1, Math.floor(a.length * 0.95))]!;
}

/** The lowest (`low`) or highest drawn height of `heights` over the 3 x 3 cells about cell (`i`, `j`), the cells with no drawn height skipped. */
function relief(heights: Float32Array, i: number, j: number, low: boolean): number {
  let best = low ? Infinity : -Infinity;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const x = i + di;
      const z = j + dj;
      if (x < 0 || z < 0 || x >= NX || z >= NZ) continue;
      const h = heights[z * NX + x]!;
      if (Number.isFinite(h)) best = low ? Math.min(best, h) : Math.max(best, h);
    }
  }
  return best;
}

/**
 * The part of `gap` (collider minus drawn at cell (`i`, `j`), whose drawn height is `heights[j * NX + i]`) outside the range the
 * drawn heights cover over the 3 x 3 cells about it: at a lip the drawn height jumps within one cell, and no lattice of that
 * spacing can be nearer than the jump's half.
 */
export function reliefGap(heights: Float32Array, i: number, j: number, gap: number): number {
  const y = heights[j * NX + i]!;
  return gap - Math.min(relief(heights, i, j, false) - y, Math.max(relief(heights, i, j, true) - y, gap));
}

/**
 * A collider's top over each drawn top cell of `region`, against the drawn top. `heightAt(x, y, z)` is the collider's answer at
 * the world point of a cell's drawn top (x, y, z; NaN where it has none). Reads the car's pose as it is (a tilted or lifted car
 * too). `missing` counts cells where `heightAt` answered NaN. The collider is a lattice of one drawn cell's spacing, so the worst
 * gap is read to within one cell horizontally: an answer inside the range the drawn top covers over the 3 x 3 cells about the cell
 * counts as no gap (at a lip the drawn top jumps within one cell, and no lattice of that spacing can be nearer than the jump's half);
 * the 95th percentile is read the same way, over those relief gaps.
 */
export function gapsOver(car: DeformableCar, field: DrawnField, region: Region, heightAt: (x: number, y: number, z: number) => number): TopGaps {
  car.group.updateMatrixWorld(true);
  const gaps: number[] = [];
  let missing = 0;
  let worstUp = 0;
  let worstDown = 0;
  for (let j = cellJ(region.z0); j <= cellJ(region.z1); j++) {
    for (let i = cellI(region.x0); i <= cellI(region.x1); i++) {
      const drawn = field.top[j * NX + i]!;
      if (!Number.isFinite(drawn)) continue;
      _w.set(cellX(i), drawn, cellZ(j)).applyMatrix4(car.group.matrixWorld);
      const h = heightAt(_w.x, _w.y, _w.z);
      if (!Number.isFinite(h)) {
        missing++;
        continue;
      }
      const off = reliefGap(field.top, i, j, h - _w.y);
      gaps.push(off);
      worstUp = Math.max(worstUp, off);
      worstDown = Math.min(worstDown, off);
    }
  }
  return { cells: gaps.length + missing, p95: p95(gaps), worstUp, worstDown, missing };
}

const _roofs = new CarSurfaces();
/** The car asking, high above the one read, in slot 1 (a query lists the roofs near the asking car's slot and skips those of cars higher than it). */
let asker: DeformableCar | null = null;

/** Heights (m) over a drawn cell the top is asked from, lowest first. */
const ASK_FROM = [0.05, 0.3, 0.75] as const;

/**
 * The surface other cars stand on, over each drawn top cell of `region`, against the drawn top: the world point of the cell's
 * drawn top is asked from just over it, then higher (`ASK_FROM`) by a car 50 m up (`pointContact`, the one query wheels and
 * hull points use, the roofs armed as `stepWorld` arms them); the answer is the height of the highest surface under that
 * point and must be `car`'s own top (slot 0).
 */
export function topGaps(car: DeformableCar, field: DrawnField, region: Region): TopGaps {
  asker ??= buildCar("sedan", "sedan");
  asker.slot = 1;
  car.group.updateMatrixWorld(true);
  asker.group.position.set(car.group.position.x, car.group.position.y + 50, car.group.position.z);
  asker.group.rotation.set(0, 0, 0, "YXZ");
  asker.group.updateMatrixWorld(true);
  _roofs.cars = [car, asker];
  _roofs.sync(0, car);
  _roofs.sync(1, asker);
  armTops(_roofs);
  const gaps = gapsOver(car, field, region, (x, y, z) => {
    // From just over the cell first, then higher where the collider stands over it (a surface counts from at most its reach above the asker).
    _hit[C_OWNER] = -1;
    for (let k = 0; k < ASK_FROM.length && _hit[C_OWNER] !== 0; k++) askFrom(x, y + ASK_FROM[k]!, z);
    // A tilted car's frame reads the asking height too: ask again from just over the surface found, as a wheel on it would, until the answer holds still.
    for (let n = 0; n < 6 && _hit[C_OWNER] === 0 && Number.isFinite(_hit[C_H]!); n++) {
      const was = _hit[C_H]!;
      askFrom(x, was + 0.01, z);
      if (Math.abs(_hit[C_H]! - was) < 1e-4) break;
    }
    return _hit[C_OWNER] === 0 ? _hit[C_H]! : NaN;
  });
  armTops(null);
  return gaps;
}

/** Steps `world` in 1/60 s frames for `seconds`. */
export function stepFrames(world: CrashWorld, seconds: number): void {
  for (let f = 0; f < seconds * 60; f++) tickWorld(world, 1 / 60);
}

/** A uniform grid over a point cloud: the distance from a point to the nearest one. */
class Cloud {
  private readonly cells = new Map<number, number[]>();
  private readonly pts: Float32Array;
  private readonly cell: number;

  constructor(pts: Float32Array, cell: number) {
    this.pts = pts;
    this.cell = cell;
    for (let i = 0; i < pts.length; i += 3) {
      const k = this.key(Math.floor(pts[i]! / cell), Math.floor(pts[i + 1]! / cell), Math.floor(pts[i + 2]! / cell));
      const list = this.cells.get(k);
      if (list) list.push(i);
      else this.cells.set(k, [i]);
    }
  }

  private key(i: number, j: number, k: number): number {
    return ((i + 512) * 1024 + (j + 512)) * 1024 + (k + 512);
  }

  /** Distance from (x, y, z) to the nearest point, looked for out to `max` (`max` when none is nearer). */
  nearest(x: number, y: number, z: number, max: number): number {
    const ci = Math.floor(x / this.cell);
    const cj = Math.floor(y / this.cell);
    const ck = Math.floor(z / this.cell);
    const rings = Math.ceil(max / this.cell);
    let best = Infinity;
    for (let r = 0; r <= rings; r++) {
      if (best <= (r - 1) * this.cell) break;
      for (let i = -r; i <= r; i++)
        for (let j = -r; j <= r; j++)
          for (let k = -r; k <= r; k++) {
            if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== r) continue;
            const list = this.cells.get(this.key(ci + i, cj + j, ck + k));
            if (!list) continue;
            for (const p of list) best = Math.min(best, Math.hypot(this.pts[p]! - x, this.pts[p + 1]! - y, this.pts[p + 2]! - z));
          }
    }
    return Math.min(best, max);
  }
}

/** Points 5 cm apart over the drawn triangles (car-local), carried to the world by `car`'s pose. */
function skinPoints(car: DeformableCar, tris: Float32Array): Float32Array {
  const out: number[] = [];
  const a = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let t = 0; t + 8 < tris.length; t += 9) {
    a.set(tris[t]!, tris[t + 1]!, tris[t + 2]!);
    e1.set(tris[t + 3]! - a.x, tris[t + 4]! - a.y, tris[t + 5]! - a.z);
    e2.set(tris[t + 6]! - a.x, tris[t + 7]! - a.y, tris[t + 8]! - a.z);
    const n = Math.max(1, Math.ceil(Math.max(e1.length(), e2.length()) / STEP));
    for (let i = 0; i <= n; i++)
      for (let j = 0; i + j <= n; j++) {
        p.copy(a).addScaledVector(e1, i / n).addScaledVector(e2, j / n).applyMatrix4(car.group.matrixWorld);
        out.push(p.x, p.y, p.z);
      }
  }
  return Float32Array.from(out);
}

/** The deepest an `a` skin point is inside the volume of `b` (its drawn field), measured to `b`'s skin: 0 when none is. */
function depthInside(a: Float32Array, b: DeformableCar, bField: DrawnField, bCloud: Cloud): number {
  const inverse = b.group.matrixWorld.clone().invert();
  const p = new THREE.Vector3();
  let depth = 0;
  for (let i = 0; i < a.length; i += 3) {
    p.set(a[i]!, a[i + 1]!, a[i + 2]!);
    const world = p.clone();
    p.applyMatrix4(inverse);
    const k = cellJ(p.z) * NX + cellI(p.x);
    if (cellI(p.x) < 0 || cellI(p.x) >= NX || cellJ(p.z) < 0 || cellJ(p.z) >= NZ) continue;
    if (p.y <= bField.top[k]! && p.y >= bField.bottom[k]!) depth = Math.max(depth, bCloud.nearest(world.x, world.y, world.z, 1));
  }
  return depth;
}

/**
 * How far apart the drawn bodies of `a` and `b` are right now (m): the smallest distance between their skins, searched out to
 * 1 m (so 1 is "at least 1"), or minus the deepest a point of one skin is inside the other body when they overlap.
 */
export function skinGap(a: DeformableCar, b: DeformableCar): number {
  const aTris = drawnTriangles(a);
  const bTris = drawnTriangles(b);
  const aPts = skinPoints(a, aTris);
  const bPts = skinPoints(b, bTris);
  const aCloud = new Cloud(aPts, 0.1);
  const bCloud = new Cloud(bPts, 0.1);
  const overlap = Math.max(depthInside(aPts, b, rasterise(bTris), bCloud), depthInside(bPts, a, rasterise(aTris), aCloud));
  if (overlap > 0) return -overlap;
  let gap = 1;
  for (let i = 0; i < aPts.length; i += 3) gap = Math.min(gap, bCloud.nearest(aPts[i]!, aPts[i + 1]!, aPts[i + 2]!, gap));
  return gap;
}

const RAD = Math.PI / 180;

/** The four bodies the collider audit measured worst (local://collider-audit.md rows 16 and 31): body name, style, class. */
export const BODIES = [
  { body: "sedan", style: "sedan", cls: "sedan" },
  { body: "wagon", style: "wagon", cls: "sedan" },
  { body: "pickup truck", style: "pickup", cls: "truck" },
  { body: "monster pickup", style: "pickup", cls: "monster" },
] as const satisfies readonly { body: string; style: CarStyleId; cls: VehicleClassId }[];

/** The states a body is held in: pristine, roof crushed by a load, after a head-on crash, after landing on its roof, in flight. */
export const STATES = [
  { id: "untouched", text: "untouched" },
  { id: "loaded", text: "with its roof crushed 0.40 m by a load" },
  { id: "headon", text: "after a 50 km/h head-on crash" },
  { id: "rolled", text: "after dropping onto its roof from 2 m" },
  { id: "airborne", text: "airborne, pitched 25 degrees and rolled 15 degrees" },
] as const;

/** A `style` body of class `cls` in the state `id`, posed upright at the origin (the airborne one tilted 3 m up). */
export function carInState(id: (typeof STATES)[number]["id"], style: CarStyleId, cls: VehicleClassId): DeformableCar {
  const car = buildCar(style, cls);
  if (id === "headon") {
    const other = buildCar(style, "sedan");
    launch(car, -5, 0, Math.PI / 2, 50 / 3.6, 0);
    launch(other, 5, 0, -Math.PI / 2, -50 / 3.6, 0);
    stepFrames(makeWorld([car, other], false, false), 5);
  } else if (id === "rolled") {
    car.spawnFacing(0, 0, 0, 0);
    car.group.rotation.set(Math.PI, 0, 0, "YXZ");
    car.group.updateMatrixWorld(true);
    car.group.position.y += -new THREE.Box3().setFromObject(car.group).min.y + 2;
    car.airborne = true;
    stepFrames(makeWorld([car], false, false), 6);
  } else {
    car.spawnFacing(0, 0, 0, 0);
    car.deform.bindKinematic(car.group, car.velocity, car.angular);
    if (id === "loaded") {
      car.deform.crush[FACE_TOP] = 0.4;
      car.deform.bakeLoadCrush();
    }
    stepFrames(makeWorld([car], false, false), 0.5);
  }
  car.airborne = id === "airborne";
  car.group.position.set(0, id === "airborne" ? 3 : 0, 0);
  car.group.rotation.set(id === "airborne" ? 25 * RAD : 0, 0, id === "airborne" ? 15 * RAD : 0, "YXZ");
  car.group.updateMatrixWorld(true);
  // The ride put the drawn body's lift for the pose the car rested in (a rolled wreck: none); it is re-posed here, so its lift is the new pose's.
  const classBody = car.group.getObjectByName("classLift");
  if (classBody) classBody.position.y = cageLift(car);
  car.group.updateMatrixWorld(true);
  return car;
}
