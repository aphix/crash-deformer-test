import * as THREE from "three";
import type { VehicleClassId } from "./vehicle-classes.ts";
import { CAR_HALF, WHEEL_POS } from "./car-mesh.ts";
import { activeGround, NO_FLOOR } from "../world/ground.ts";
import { C_H, HIT_SIZE, staticTop } from "../world/surfaces.ts";
import { LoadTransfer } from "./car-load.ts";
import { detSin, detCos } from "../kernel/physics-core.js";

/**
 * The tyre springs and dampers of a body on the road (`stepFree`): a spring and a damper per corner push the physics body up, per
 * unit of the whole car's mass. The drawn body (the class lift group, `assignClass`) rides that body: the springs' own compression
 * is the body's own heave, pitch and roll, and only the load transfer (squat, dive and lean) is drawn on top.
 *
 * Per class: ride frequency f (Hz), one symmetric damping ratio ζ (a little under real bump/rebound, for arcade
 * bounce) and total travel (m), split evenly into bump and droop with a hard stop at each end. Per corner mass m:
 * k = m (2πf)², c = 2ζ √(k m); per unit mass ω² and 2ζω. Ranges: `.extraResearch` 2026-10-02-suspension-*.
 */
export const SPRINGS: Readonly<Record<VehicleClassId, { hz: number; zeta: number; travel: number }>> = {
  sedan: { hz: 1.3, zeta: 0.3, travel: 0.13 },
  muscle: { hz: 1.6, zeta: 0.3, travel: 0.11 },
  police: { hz: 1.5, zeta: 0.35, travel: 0.13 },
  truck: { hz: 1.1, zeta: 0.25, travel: 0.22 },
  // ζ 0.2 (the starting value) still swung 1 cm 2.4 s after a 14 m/s ramp landing (0.3: 2.3 s); 0.35 settles by 2 s.
  monster: { hz: 0.8, zeta: 0.35, travel: 0.45 },
};

/** How far (m) a class's wheels reach below its body's rest ride (half its travel): further off its ground no wheel holds it, it flies. */
export function droop(cls: VehicleClassId): number {
  return SPRINGS[cls].travel / 2;
}

/** Half the wheelbase and half the track (m). */
const AXLE = WHEEL_POS[0]![2];
const TRACK = Math.abs(WHEEL_POS[0]![0]);
/** Off the ground a seated wheel eases back onto its hub at this rate (1/s). */
const UNSEAT = 15;
/** A wreck's body eases onto its empty corners at this rate (1/s): 99 % in 1.2 s. */
const SETTLE = 4;

/**
 * The body's underside (x, z, height m over the ground at the stock ride with no class lift), read off the skinned
 * wreck mesh of every style (sedan, wagon, coupe, hatchback and pickup alike): the keel along the middle, rising to
 * the tail, and the rocker and bumper corners 0.8 m out. The wheel arches are cut out and left out.
 */
export const UNDERSIDE: readonly (readonly [number, number, number])[] = [
  [0, 2, 0.032], [0, 1, 0.072], [0, 0, 0.131], [0, -1, 0.136], [0, -2, 0.161],
  ...([-0.8, 0.8] as const).flatMap((x) => [[x, 2, 0.051], [x, 1, 0.101], [x, 0, 0.134], [x, -0.5, 0.147], [x, -2, 0.169]] as const),
];
/** The drawn underside's height (m) at car-local (`x`, `z`) within the rockers: `UNDERSIDE`'s keel and its rocker line along z, between them across. */
function underY(x: number, z: number): number {
  let keel = 0;
  let rocker = 0;
  for (const [line, side] of [[0, 0], [0.8, 1]] as const) {
    let lo: readonly [number, number, number] | undefined;
    let hi: readonly [number, number, number] | undefined;
    for (const p of UNDERSIDE) {
      if (p[0] !== line) continue;
      if (p[1] <= z && (!lo || p[1] > lo[1])) lo = p;
      if (p[1] >= z && (!hi || p[1] < hi[1])) hi = p;
    }
    const h = !lo || !hi || lo === hi ? (lo ?? hi)![2] : lo[2] + ((hi[2] - lo[2]) * (z - lo[1])) / (hi[1] - lo[1]);
    if (side === 0) keel = h;
    else rocker = h;
  }
  return keel + ((rocker - keel) * Math.abs(x)) / 0.8;
}
/** The pan's half width and half length (m). */
const PAN_HALF = 0.35;
/**
 * The plane the belly's centre patch lies on, along the car: height at z = 0 and rise per metre of z (least squares through the drawn
 * underside under the pan's rows, 22 mm higher at the rear row than at the front; the pan is symmetric across).
 */
const PAN_PLANE: readonly [number, number] = (() => {
  let sum = 0;
  let sz = 0;
  let n = 0;
  for (const z of [-PAN_HALF, PAN_HALF]) {
    for (const x of [-PAN_HALF, 0, PAN_HALF]) {
      const h = underY(x, z);
      sum += h;
      sz += h * z;
      n++;
    }
  }
  return [sum / n, sz / (n * PAN_HALF * PAN_HALF)];
})();
/**
 * The belly's centre patch, the pan under the cabin (car-local x, height, z): six points on `PAN_PLANE`, within 3 mm of the drawn
 * underside. Flat across: on the drawn underside's V (keel 5 mm under its rocker side) it stood on the keel line alone, rolling 1° each
 * way on a flat roof. A flat pan at 0.132 stood 15-22 mm over the drawn underside at its front row.
 */
export const PAN: readonly (readonly [number, number, number])[] = [-PAN_HALF, PAN_HALF].flatMap((z) => [-PAN_HALF, 0, PAN_HALF].map((x): [number, number, number] => [x, PAN_PLANE[0] + PAN_PLANE[1] * z, z]));
/** `HULL_UNDER`'s row: car-local x, z and height above the tyre plane. */
const HU_X = 0;
const HU_Z = 1;
const HU_H = 2;
const HU_SIZE = 3;
/** The underside samples and the bumpers' bottom corners (rows of `HU_SIZE`): what the body bottoms out on. */
const HULL_UNDER = Float64Array.from([
  ...UNDERSIDE.flat(),
  ...[-1, 1].flatMap((sx) => [-1, 1].flatMap((sz) => [sx * CAR_HALF.x, sz * CAR_HALF.z, 0.35])),
]);
/** The underside's height (m) at each hub's plan position (a front hub's is the bumper corner's, a rear hub's the tail's). */
const SILL = [0.084, 0.084, 0.157, 0.157] as const;

/** Body drop at corner `j` per metre of offset at corner `i`: the pose below is the mean heave plus pitch plus roll. */
function reach(j: number, i: number): number {
  const [xj, , zj] = WHEEL_POS[j]!;
  const [xi, , zi] = WHEEL_POS[i]!;
  return (1 + Math.sign(xj * xi) + Math.sign(zj * zi)) / 4;
}

/** The body's up (its up axis's world y) from which it stands on its wheels: below it the springs and the body's lift are off. */
export const UPRIGHT_UP_Y = 0.5;

/** The drawn body's class lift (m along its up) at up `upY`: the whole lift while upright, none once on its side, so a lifted body lying over is not drawn into the ground its stock hull rests on. */
export function bodyLift(lift: number, upY: number): number {
  return lift * Math.max(0, Math.min(1, upY / UPRIGHT_UP_Y));
}

/**
 * The offsets (`Suspension.offset`) a body resting on the corners of `gone` (bit i: wheel i is off) takes. The standing
 * springs are equal, so the least-offset pose that puts each empty hub's corner down at the underside's height there
 * (the pose is linear: Gauss-Seidel on the Gram system of the empty corners' rows), then the whole body up as far as any
 * underside point (it rests on the first to touch) or the standing wheels' arches (`stop` m of room over each tyre) need.
 * All zero on four wheels.
 */
export function sagOffsets(lift: number, stop: number, gone: number, out: Float64Array): void {
  out.fill(0);
  if (gone === 0) return;
  const mu = [0, 0, 0, 0];
  for (let pass = 0; pass < 12; pass++) {
    for (let a = 0; a < 4; a++) {
      if (!((gone >> a) & 1)) continue;
      let r = -(lift + SILL[a]!);
      let g = 0;
      for (let b = 0; b < 4; b++) {
        if (!((gone >> b) & 1)) continue;
        let dot = 0;
        for (let i = 0; i < 4; i++) dot += reach(a, i) * reach(b, i);
        r -= dot * mu[b]!;
        if (a === b) g = dot;
      }
      mu[a]! += r / g;
    }
  }
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if ((gone >> j) & 1) out[i]! += reach(j, i) * mu[j]!;
  const pitch = (out[0]! + out[1]! - out[2]! - out[3]!) / (4 * AXLE);
  const roll = (out[1]! + out[3]! - out[0]! - out[2]!) / (4 * TRACK);
  const heave = (out[0]! + out[1]! + out[2]! + out[3]!) / 4;
  let raise = 0;
  for (const [x, z, h] of UNDERSIDE) raise = Math.max(raise, -(lift + h) - (heave + z * pitch + x * roll));
  for (let j = 0; j < 4; j++) {
    if ((gone >> j) & 1) continue;
    let d = 0;
    for (let i = 0; i < 4; i++) d += reach(j, i) * out[i]!;
    raise = Math.max(raise, -stop - d);
  }
  for (let i = 0; i < 4; i++) out[i]! += raise;
}

export class Suspension {
  /** Each wheel's body offset from its rest ride (m): − bump (compressed), + droop. `WHEEL_POS` order. */
  readonly offset = new Float64Array(4);
  /**
   * Each drawn wheel's lift off its rest hub (m, + up): on the ground it follows the ground under its tread (a bank's
   * edge, a crest, a twist the frame's one plane can't take), within its spring's stops of the body.
   */
  readonly seat = new Float64Array(4);
  /** The ground pose's load transfer (squat, dive, roll): the springs' resting offsets while it lasts. */
  private readonly load = new LoadTransfer();
  private readonly target = new Float64Array(4);
  /** The `lift`, `stop` and `gone` that `target` was solved for (a wreck's wheel set is fixed until the next spawn). */
  private sagLift = NaN;
  private sagStop = NaN;
  private sagGone = -1;
  /** The body has ridden the load transfer since the spawn (a crash puts it back on its stock ride once). */
  private riding = false;
  /** The body group the springs carry (found once per spawn; null without a class lift). */
  private body: THREE.Object3D | null | undefined = undefined;
  /** The drawn body's extra rise (m) over the springs' ride while its underside rests on the ground (`bottomOut`). */
  private rise = 0;

  /** At rest on a new spawn: the body back on its stock ride. */
  reset(): void {
    const o = this.offset;
    if (this.body) {
      this.body.position.y -= (o[0]! + o[1]! + o[2]! + o[3]!) / 4 + this.rise;
      this.body.rotation.x = 0;
      this.body.rotation.z = 0;
    }
    o.fill(0);
    this.seat.fill(0);
    this.load.reset();
    this.riding = false;
    this.body = undefined;
  }

  /**
   * One slice for a car whose body pose is `group` (its matrixWorld current), class `cls` with body `lift`; `air` while no wheel
   * is on the ground. The group is the physics body, already sprung on its tyres (`stepFree`): the drawn body rides it with the
   * load transfer alone (squat, dive, roll: drawn only), each drawn wheel seated by what the physics tyre reads (`seatWheels`).
   * `free` false (a crash) puts the body back on its stock ride, then eases it down onto the corners of the wheels it has lost
   * (`gone`, bit i: `WHEEL_POS` i; `sagOffsets`; snapped at dt 0); the wheels are then the wreck's (`nudgeWheels` puts them on their
   * hubs).
   */
  step(group: THREE.Object3D, wheels: readonly THREE.Object3D[], cls: VehicleClassId, lift: number, free: boolean, air: boolean, gone: number, hit: Float64Array, dt: number): void {
    if (this.body === undefined) this.body = group.getObjectByName("classLift") ?? null;
    if (!free) {
      if (this.riding) {
        this.offset.fill(0);
        this.load.reset();
        this.riding = false;
        this.rise = 0;
        this.pose(lift);
        this.seat.fill(0);
      }
      this.sag(lift, SPRINGS[cls].travel / 2, air || group.matrixWorld.elements[5]! < UPRIGHT_UP_Y ? 0 : gone, dt);
      return;
    }
    if (dt <= 0) return;
    const s = SPRINGS[cls];
    const w = 2 * Math.PI * s.hz;
    const stop = s.travel / 2;
    const e = group.matrixWorld.elements;
    this.load.step(e, dt, air, cls, w * w);
    let moved = !this.riding;
    this.riding = true;
    for (let i = 0; i < 4; i++) {
      const o = Math.max(-stop, Math.min(stop, this.load.target[i]!));
      if (o !== this.offset[i]) moved = true;
      this.offset[i] = o;
    }
    // Still held up (`rise`) or sprung down on a compressed spring, the drawn body keeps bottoming out through a slice the hull is clear
    // in: a nose bouncing off a landing lifts it out for one slice (nothing touched: `airborne`), and dropping `rise` then sank the underside 4.7 cm.
    const off = this.offset;
    const sunk = this.rise > 0 || off[0]! < 0 || off[1]! < 0 || off[2]! < 0 || off[3]! < 0;
    const bottom = air && !sunk ? 0 : this.bottomOut(e, lift);
    if (this.seatWheels(e, hit, wheels, stop, air, dt) || moved || bottom !== this.rise) {
      this.rise = bottom;
      this.pose(lift);
    }
  }

  /** A wreck's offsets one slice nearer the corners it rests on (`sagOffsets`); `dt` 0 takes them at once. */
  private sag(lift: number, stop: number, gone: number, dt: number): void {
    if (lift !== this.sagLift || stop !== this.sagStop || gone !== this.sagGone) {
      sagOffsets(lift, stop, gone, this.target);
      this.sagLift = lift;
      this.sagStop = stop;
      this.sagGone = gone;
    }
    const k = dt > 0 ? 1 - Math.exp(-SETTLE * dt) : 1;
    let moved = false;
    for (let i = 0; i < 4; i++) {
      const d = this.target[i]! - this.offset[i]!;
      if (d === 0) continue;
      this.offset[i] = Math.abs(d) < 1e-5 ? this.target[i]! : this.offset[i]! + d * k;
      moved = true;
    }
    if (moved) this.pose(lift);
  }

  /**
   * Each drawn wheel onto the surface under its tread (`seat`: its footprint's rise, `wheelContact`); off the ground back onto its hub.
   * A wheel hangs down to its droop (`stop`, half the travel) below its rest ride on the physics frame, as far as the physics tyre
   * reaches; up into its arch it stops `stop` above the body's ride there (a sedan's tyre top is 6 cm under its arch at rest) and lifts
   * that corner of the body beyond. True when it lifted one.
   */
  private seatWheels(e: readonly number[], hit: Float64Array, wheels: readonly THREE.Object3D[], stop: number, air: boolean, dt: number): boolean {
    const uy = e[5]!;
    let lifted = false;
    for (let i = 0; i < 4; i++) {
      const w = wheels[i]!;
      let s = this.seat[i]! * Math.exp(-UNSEAT * dt);
      if (!air && uy > UPRIGHT_UP_Y) {
        // The lift that puts the tread on the surface: the wheel's footprint rise (`wheelContact`, the hub on its rest ride on the
        // physics pose). The hub's height picks the surface's layer.
        const need = hit[i * HIT_SIZE + C_H]!;
        const o = this.offset[i]!;
        s = Math.max(-stop, need);
        if (s > o + stop) {
          this.offset[i] = s - stop;
          lifted = true;
        }
      }
      // Along the world's vertical (the body's up leans a rolled wheel's hub sideways: over a ramp's edge it stood on the wrong side of it).
      w.position.set(WHEEL_POS[i]![0] + s * e[1]!, WHEEL_POS[i]![1] + s * uy, WHEEL_POS[i]![2] + s * e[9]!);
      this.seat[i] = s;
    }
    return lifted;
  }

  /** The body's heave over its stock ride (m, + up): what a chase camera rides (`DriveCam`). */
  get heave(): number {
    const o = this.offset;
    return (o[0]! + o[1]! + o[2]! + o[3]!) / 4;
  }

  /** The body's pitch (rad, + nose up: front over rear). */
  get pitch(): number {
    const o = this.offset;
    return Math.atan((o[0]! + o[1]! - o[2]! - o[3]!) / (4 * AXLE));
  }

  /** The body's ride from the four offsets: heave, pitch (front over rear) and roll (+x side over −x), and `rise`. */
  private pose(lift: number): void {
    const body = this.body;
    if (!body) return;
    const o = this.offset;
    body.position.y = lift + this.heave + this.rise;
    body.rotation.x = -this.pitch;
    body.rotation.z = Math.atan((o[1]! + o[3]! - o[0]! - o[2]!) / (4 * TRACK));
  }

  /**
   * How far (m, along the body's up) the drawn body, on the springs' ride, has to rise to bring its underside and bumper
   * corners out of the ground: it bottoms out on what is under it (a landing's nose, a dip's far wall, a ramp's edge)
   * instead of letting the springs press it through. 0 with the hull clear.
   */
  private bottomOut(e: readonly number[], lift: number): number {
    const ground = activeGround();
    const o = this.offset;
    const uy = e[5]!;
    if (uy < UPRIGHT_UP_Y) return 0;
    // The body group's turn (x then z, `pose`) and its place over the ground pose.
    const rx = -this.pitch;
    const rz = Math.atan((o[1]! + o[3]! - o[0]! - o[2]!) / (4 * TRACK));
    const sx = detSin(rx);
    const cx = detCos(rx);
    const sz = detSin(rz);
    const cz = detCos(rz);
    const dy = lift + this.heave;
    let pen = 0;
    for (let i = 0; i < HULL_UNDER.length; i += HU_SIZE) {
      const x = HULL_UNDER[i + HU_X]!;
      const z = HULL_UNDER[i + HU_Z]!;
      const h = HULL_UNDER[i + HU_H]!;
      const x1 = x * cz - h * sz;
      const y1 = x * sz + h * cz;
      const y = y1 * cx - z * sx + dy;
      const z2 = y1 * sx + z * cx;
      const px = e[0]! * x1 + e[4]! * y + e[8]! * z2 + e[12]!;
      const py = e[1]! * x1 + uy * y + e[9]! * z2 + e[13]!;
      const pz = e[2]! * x1 + e[6]! * y + e[10]! * z2 + e[14]!;
      // The ground nowhere higher here than this point less the depth found so far: it cannot bottom out deeper on it.
      if (staticTop(ground, px, px, pz, pz) - py <= pen) continue;
      const g = ground.heightAt(px, pz, py);
      if (g !== NO_FLOOR) pen = Math.max(pen, g - py);
    }
    return pen / uy;
  }
}
