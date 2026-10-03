import * as THREE from "three";
import type { VehicleClassId } from "./vehicle-classes.ts";
import { WHEEL_POS } from "./car-mesh.ts";
import { activeGround, NO_FLOOR } from "../world/ground.ts";
import { TYRE_R } from "../deform/deform-state.ts";
import { LoadTransfer } from "./car-load.ts";

/**
 * A spring and a damper between each wheel and the body, drawn only: the physics frame (hulls, masses, contacts,
 * the wheels) stays on the ground pose and nothing here feeds grip, tyre or drive forces. The body (the class lift
 * group, `assignClass`) rides the four springs' mean heave, pitch and roll. While its wheels are on the ground a
 * spring's input is the change in its wheel's vertical speed on the ground pose (a landing, a ramp's foot, a
 * crest): the body keeps going and the spring takes up the difference. In the air body and wheels fall together.
 *
 * Per class: ride frequency f (Hz), one symmetric damping ratio ζ (a little under real bump/rebound, for arcade
 * bounce) and total travel (m), split evenly into bump and droop with a hard stop at each end. Per corner mass m:
 * k = m (2πf)², c = 2ζ √(k m); per unit mass ω² and 2ζω. Ranges: `.extraResearch` 2026-10-02-suspension-*.
 */
const SPRINGS: Readonly<Record<VehicleClassId, { hz: number; zeta: number; travel: number }>> = {
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
/**
 * Tread points (m from the hub, wheel frame, × wheel scale) a seated wheel keeps on the ground: the crown's bottom arc
 * ±29° about the body's down (a slope under it, a lip ahead or behind) and its shoulders (a bank's edge, a twist),
 * after `TYRE_PROFILE` in car-materials.ts.
 */
const TREAD: readonly (readonly [number, number, number])[] = [
  ...[-0.5, -0.25, 0, 0.25, 0.5].map((a) => [0, -TYRE_R * Math.cos(a), TYRE_R * Math.sin(a)] as const),
  [0.104, -0.298, 0],
  [-0.104, -0.298, 0],
];
/** Off the ground a seated wheel eases back onto its hub at this rate (1/s). */
const UNSEAT = 15;

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
  /** Slices seen since the spawn (2: both last height and last speed are real). */
  private seen = 0;
  /** The body group the springs carry (found once per spawn; null without a class lift). */
  private body: THREE.Object3D | null | undefined = undefined;

  /** At rest on a new spawn: the body back on its stock ride. */
  reset(): void {
    const o = this.offset;
    if (this.body) {
      this.body.position.y -= (o[0]! + o[1]! + o[2]! + o[3]!) / 4;
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
   * `air` while no wheel is on the ground. `free` false (a crash) puts the body back on its stock ride; the
   * wheels are then the wreck's (`nudgeWheels` puts them on their hubs).
   */
  step(group: THREE.Object3D, wheels: readonly THREE.Object3D[], cls: VehicleClassId, lift: number, free: boolean, air: boolean, dt: number): void {
    if (this.body === undefined) this.body = group.getObjectByName("classLift") ?? null;
    if (!free) {
      if (this.seen > 0) {
        this.offset.fill(0);
        this.rate.fill(0);
        this.load.reset();
        this.seen = 0;
        this.pose(lift);
        this.seat.fill(0);
      }
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
    if (this.seatWheels(e, wheels, stop, air, dt) || moved) this.pose(lift);
  }

  /**
   * Each drawn wheel onto the ground under its tread's crown and shoulders (`seat`); off the ground back onto its hub.
   * A wheel hangs up to the full travel below the body; up into its arch it stops `stop` above the body's ride there
   * (a sedan's tyre top is 6 cm under its arch at rest) and lifts that corner of the body beyond. True when it lifted one.
   */
  private seatWheels(e: readonly number[], wheels: readonly THREE.Object3D[], stop: number, air: boolean, dt: number): boolean {
    const ground = activeGround();
    const uy = e[5]!;
    let lifted = false;
    for (let i = 0; i < 4; i++) {
      const w = wheels[i]!;
      let s = this.seat[i]! * Math.exp(-UNSEAT * dt);
      if (!air && uy > 0.5) {
        const [x, , z] = WHEEL_POS[i]!;
        const sc = w.scale.x;
        // The hub on its rest ride (the tyre's bottom is the body's y = 0 for every class).
        const r = TYRE_R * sc;
        const cx = e[0]! * x + e[4]! * r + e[8]! * z + e[12]!;
        const cy = e[1]! * x + uy * r + e[9]! * z + e[13]!;
        const cz = e[2]! * x + e[6]! * r + e[10]! * z + e[14]!;
        // The lift (along the body's up) that puts the tread on the ground: its lowest point over the ground under it.
        // The hub's height picks the ground's layer.
        let need = -Infinity;
        for (const [tx, ty, tz] of TREAD) {
          const px = cx + sc * (e[0]! * tx + e[4]! * ty + e[8]! * tz);
          const py = cy + sc * (e[1]! * tx + uy * ty + e[9]! * tz);
          const pz = cz + sc * (e[2]! * tx + e[6]! * ty + e[10]! * tz);
          const g = ground.heightAt(px, pz, cy);
          if (g !== NO_FLOOR) need = Math.max(need, (g - py) / uy);
        }
        const o = this.offset[i]!;
        s = Math.max(o - 2 * stop, need);
        if (s > o + stop) {
          this.offset[i] = s - stop;
          this.rate[i] = Math.max(this.rate[i]!, 0);
          lifted = true;
        }
      }
      w.position.y = WHEEL_POS[i]![1] + s;
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

  /** The body's ride from the four offsets: heave, pitch (front over rear) and roll (+x side over −x). */
  private pose(lift: number): void {
    const body = this.body;
    if (!body) return;
    const o = this.offset;
    body.position.y = lift + this.heave;
    body.rotation.x = -this.pitch;
    body.rotation.z = Math.atan((o[1]! + o[3]! - o[0]! - o[2]!) / (4 * TRACK));
  }
}
