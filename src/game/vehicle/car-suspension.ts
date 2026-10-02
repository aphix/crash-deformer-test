import * as THREE from "three";
import type { VehicleClassId } from "./vehicle-classes.ts";
import { WHEEL_POS } from "./car-mesh.ts";

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
export const SPRINGS: Readonly<Record<VehicleClassId, { hz: number; zeta: number; travel: number }>> = {
  sedan: { hz: 1.3, zeta: 0.3, travel: 0.13 },
  muscle: { hz: 1.6, zeta: 0.3, travel: 0.11 },
  police: { hz: 1.5, zeta: 0.35, travel: 0.13 },
  truck: { hz: 1.1, zeta: 0.25, travel: 0.22 },
  // ζ 0.2 (the starting value) still swung 1 cm 2.4 s after a 14 m/s ramp landing (0.3: 2.3 s); 0.35 settles by 2 s.
  monster: { hz: 0.8, zeta: 0.35, travel: 0.45 },
};

/** Half the wheelbase and half the track (m). */
const AXLE = WHEEL_POS[0]![2];
const TRACK = Math.abs(WHEEL_POS[0]![0]);

export class Suspension {
  /** Each wheel's body offset from its rest ride (m): − bump (compressed), + droop. `WHEEL_POS` order. */
  readonly offset = new Float64Array(4);
  private readonly rate = new Float64Array(4);
  private readonly lastY = new Float64Array(4);
  private readonly lastV = new Float64Array(4);
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
    this.seen = 0;
    this.body = undefined;
  }

  /**
   * One slice for a car whose ground pose is `group` (its matrixWorld current), class `cls` with body `lift`;
   * `air` while no wheel is on the ground. `free` false (a crash) puts the body back on its stock ride.
   */
  step(group: THREE.Object3D, cls: VehicleClassId, lift: number, free: boolean, air: boolean, dt: number): void {
    if (this.body === undefined) this.body = group.getObjectByName("classLift") ?? null;
    if (!free) {
      if (this.seen > 0) {
        this.offset.fill(0);
        this.rate.fill(0);
        this.seen = 0;
        this.pose(lift);
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
      r -= (k * this.offset[i]! + c * r) * dt;
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
    if (moved) this.pose(lift);
  }

  /** The body's ride from the four offsets: heave, pitch (front over rear) and roll (+x side over −x). */
  private pose(lift: number): void {
    const body = this.body;
    if (!body) return;
    const o = this.offset;
    body.position.y = lift + (o[0]! + o[1]! + o[2]! + o[3]!) / 4;
    body.rotation.x = -Math.atan((o[0]! + o[1]! - o[2]! - o[3]!) / (4 * AXLE));
    body.rotation.z = Math.atan((o[1]! + o[3]! - o[0]! - o[2]!) / (4 * TRACK));
  }
}
