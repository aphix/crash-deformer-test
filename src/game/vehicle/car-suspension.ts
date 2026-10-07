import * as THREE from "three";
import type { VehicleClassId } from "./vehicle-classes.ts";
import { CAR_HALF, WHEEL_POS } from "./car-mesh.ts";
import { activeGround, NO_FLOOR } from "../world/ground.ts";
import { C_H, HIT_SIZE } from "../world/surfaces.ts";
import { LoadTransfer } from "./car-load.ts";

/**
 * A spring and a damper between each wheel and the body, drawn: the physics frame (hulls, masses, contacts, the
 * wheels) stays on the ground pose and nothing here feeds grip, tyre or drive forces. The body (the class lift
 * group, `assignClass`) rides the four springs' mean heave, pitch and roll. While its wheels are on the ground a
 * spring's input is the change in its wheel's vertical speed on the ground pose (a landing, a ramp's foot, a
 * crest): the body keeps going and the spring takes up the difference. In the air body and wheels fall together.
 *
 * Per class: ride frequency f (Hz), one symmetric damping ratio ζ (a little under real bump/rebound, for arcade
 * bounce) and total travel (m), split evenly into bump and droop with a hard stop at each end. Per corner mass m:
 * k = m (2πf)², c = 2ζ √(k m); per unit mass ω² and 2ζω. Ranges: `.extraResearch` 2026-10-02-suspension-*. The same springs
 * push a rigid body's tyres in their travel (`stepFree`), there per unit of the whole car's mass.
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
/** The underside samples and the bumpers' bottom corners (car-local x, z, height above the tyre plane): what the body bottoms out on. */
export const HULL_UNDER: readonly (readonly [number, number, number])[] = [
  ...UNDERSIDE,
  ...[-1, 1].flatMap((sx) => [-1, 1].map((sz): [number, number, number] => [sx * CAR_HALF.x, sz * CAR_HALF.z, 0.35])),
];
/** The underside's height (m) at each hub's plan position (a front hub's is the bumper corner's, a rear hub's the tail's). */
const SILL = [0.084, 0.084, 0.157, 0.157] as const;

/** Body drop at corner `j` per metre of offset at corner `i`: the pose below is the mean heave plus pitch plus roll. */
function reach(j: number, i: number): number {
  const [xj, , zj] = WHEEL_POS[j]!;
  const [xi, , zi] = WHEEL_POS[i]!;
  return (1 + Math.sign(xj * xi) + Math.sign(zj * zi)) / 4;
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
  private readonly rate = new Float64Array(4);
  private readonly lastY = new Float64Array(4);
  private readonly lastV = new Float64Array(4);
  /** The ground pose's load transfer (squat, dive, roll): the springs' resting offsets while it lasts. */
  private readonly load = new LoadTransfer();
  private readonly target = new Float64Array(4);
  /** The `lift`, `stop` and `gone` that `target` was solved for (a wreck's wheel set is fixed until the next spawn). */
  private sagLift = NaN;
  private sagStop = NaN;
  private sagGone = -1;
  /** Slices seen since the spawn (2: both last height and last speed are real). */
  private seen = 0;
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
    this.rate.fill(0);
    this.seat.fill(0);
    this.load.reset();
    this.seen = 0;
    this.body = undefined;
  }

  /**
   * One slice for a car whose ground pose is `group` (its matrixWorld current), class `cls` with body `lift`;
   * `air` while no wheel is on the ground. `free` false (a crash) puts the body back on its stock ride, then eases it
   * down onto the corners of the wheels it has lost (`gone`, bit i: `WHEEL_POS` i; `sagOffsets`; snapped at dt 0); the
   * wheels are then the wreck's (`nudgeWheels` puts them on their hubs).
   */
  step(group: THREE.Object3D, wheels: readonly THREE.Object3D[], cls: VehicleClassId, lift: number, free: boolean, air: boolean, gone: number, hit: Float64Array, dt: number): void {
    if (this.body === undefined) this.body = group.getObjectByName("classLift") ?? null;
    if (!free) {
      if (this.seen > 0) {
        this.offset.fill(0);
        this.rate.fill(0);
        this.load.reset();
        this.seen = 0;
        this.rise = 0;
        this.pose(lift);
        this.seat.fill(0);
      }
      this.sag(lift, SPRINGS[cls].travel / 2, air || group.matrixWorld.elements[5]! < 0.5 ? 0 : gone, dt);
      return;
    }
    if (dt <= 0) return;
    const s = SPRINGS[cls];
    const w = 2 * Math.PI * s.hz;
    const k = w * w;
    const c = 2 * s.zeta * w;
    const stop = s.travel / 2;
    const e = group.matrixWorld.elements;
    this.load.step(e, dt, air, cls, k);
    const rest = this.load.target;
    let moved = false;
    for (let i = 0; i < 4; i++) {
      const [x, , z] = WHEEL_POS[i]!;
      // The wheel's tyre contact on the ground pose: its height and vertical speed.
      const y = e[1]! * x + e[9]! * z + e[13]!;
      const vy = this.seen > 0 ? (y - this.lastY[i]!) / dt : 0;
      let r = this.rate[i]!;
      if (this.seen > 1 && !air) r -= vy - this.lastV[i]!;
      this.lastY[i] = y;
      this.lastV[i] = vy;
      r -= (k * (this.offset[i]! - rest[i]!) + c * r) * dt;
      let o = this.offset[i]! + r * dt;
      if (o < -stop) {
        o = -stop;
        r = Math.max(r, 0);
      } else if (o > stop) {
        o = stop;
        r = Math.min(r, 0);
      }
      if (o !== 0 || r !== 0) moved = true;
      this.offset[i] = o;
      this.rate[i] = r;
    }
    if (this.seen < 2) this.seen++;
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
      if (!air && uy > 0.5) {
        // The lift that puts the tread on the surface: the wheel's footprint rise (`wheelContact`, the hub on its rest ride on the
        // physics pose). The hub's height picks the surface's layer.
        const need = hit[i * HIT_SIZE + C_H]!;
        const o = this.offset[i]!;
        s = Math.max(-stop, need);
        if (s > o + stop) {
          this.offset[i] = s - stop;
          this.rate[i] = Math.max(this.rate[i]!, 0);
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
    if (uy < 0.5) return 0;
    // The body group's turn (x then z, `pose`) and its place over the ground pose.
    const rx = -this.pitch;
    const rz = Math.atan((o[1]! + o[3]! - o[0]! - o[2]!) / (4 * TRACK));
    const sx = Math.sin(rx);
    const cx = Math.cos(rx);
    const sz = Math.sin(rz);
    const cz = Math.cos(rz);
    const dy = lift + this.heave;
    let pen = 0;
    for (const [x, z, h] of HULL_UNDER) {
      const x1 = x * cz - h * sz;
      const y1 = x * sz + h * cz;
      const y = y1 * cx - z * sx + dy;
      const z2 = y1 * sx + z * cx;
      const px = e[0]! * x1 + e[4]! * y + e[8]! * z2 + e[12]!;
      const py = e[1]! * x1 + uy * y + e[9]! * z2 + e[13]!;
      const pz = e[2]! * x1 + e[6]! * y + e[10]! * z2 + e[14]!;
      const g = ground.heightAt(px, pz, py);
      if (g !== NO_FLOOR) pen = Math.max(pen, g - py);
    }
    return pen / uy;
  }
}
