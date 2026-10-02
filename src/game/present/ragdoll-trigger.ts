import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import type { GlassName } from "../vehicle/car-core.ts";
import { carClass, killTravel } from "../vehicle/vehicle-classes.ts";
import { MAX_CARS } from "../scenes/fleet.ts";

/** Pane a thrown driver leaves through: the windshield on a head-on, the struck side's front window on a side hit. */
export type ExitPane = Extract<GlassName, "windshield" | "doorL" | "doorR">;

/** Velocity samples per car, one per 1/60 s of sim time (`SAMPLE`): 0.53 s, past `PRE`. */
const RING = 32;
const SAMPLE = 1 / 60;
/** How far back (s) "before the hit" is: the block dies 25–40 ms into a frontal hit, a derby kill up to 0.3 s after its last contact. */
const PRE = 0.35;
/** A car whose centre is within this (m) of the impact point is the one that hit; none: a wall. */
const OTHER_REACH = 3.5;
/**
 * Closing speed (m/s) the disabling hit needs to throw the driver out: the peak, over the `PRE` s before the
 * drivetrain died, of how fast the striker (the nearest car to the impact point, or a wall at rest) came at this
 * car along the hit's inward normal. It tracks the contact code's own `impulse`, which never reaches a client.
 * Lane ragdoll's probe: every single-hit frontal kill closed at ≥ 15.6 (56 km/h wall; 2×56 head-on 31.1, 40 %
 * offset at 64 17.8). The 20 derby kills over five six-car heats were 16 tail, 4 side, 0 front; the side ones
 * peaked at 9.8, 7.9, 6.8 and 1.9 m/s here (`impulse` 7.2–10.6). 6 m/s (22 km/h) throws on every frontal kill
 * and a solid side blow, not on a car shoved into its last bit of wear.
 */
const EJECT_CLOSING = 6;

const _n = new THREE.Vector3();
const _hit = new THREE.Vector3();

/**
 * Watches every car for a disabling hit: the drivetrain dying (`drivetrainAlive`: derby engine-kill and wreck, race
 * DNF by damage) or the block packed as far as kills it at the realistic end of the slider, whatever the slider.
 * It decides, once per car per run, whether that one hit throws the driver out: closing fast enough
 * (`EJECT_CLOSING`), head-on or from the side, never from behind.
 * It reads only replicated state (the drivetrain flag, `engineTravel`, `impactLocal`/`impactInward`, poses,
 * velocities), so a netplay client decides the same from the host's snapshots. The closing speed is rebuilt from
 * the cars' velocities before the hit: the contact's own `impulse` never reaches a client.
 */
export class EjectionWatch {
  private readonly vel = new Float32Array(MAX_CARS * RING * 2);
  private readonly head = new Int32Array(MAX_CARS);
  private readonly count = new Int32Array(MAX_CARS);
  /** -1 unseen, 0 disabled, 1 intact. */
  private readonly alive = new Int8Array(MAX_CARS).fill(-1);
  private readonly thrown = new Uint8Array(MAX_CARS);
  private acc = 0;
  private readonly pre = new THREE.Vector3();

  /** A new run: every car may throw its driver once again. */
  reset(): void {
    this.head.fill(0);
    this.count.fill(0);
    this.alive.fill(-1);
    this.thrown.fill(0);
    this.acc = 0;
  }

  /**
   * One frame of `dt` sim seconds in kill context `ctx` (`armKill`'s: a derby's or anywhere else);
   * `eject(i, exit, pre)` with car i's velocity before the hit (world, m/s).
   */
  update(cars: readonly DeformableCar[], dt: number, ctx: "derby" | "default", eject: (i: number, exit: ExitPane, pre: THREE.Vector3) => void): void {
    this.acc += dt;
    const sample = this.acc >= SAMPLE;
    if (sample) this.acc %= SAMPLE;
    const n = Math.min(cars.length, MAX_CARS);
    for (let i = 0; i < n; i++) {
      const car = cars[i]!;
      // Disabled, or the block packed past the context's kill travel at the realistic end (the sourced 0.15 m ×
      // durability, × the derby scale in one). At the HUD's default realism (0.25) a fleet sedan dies only at 0.45 m
      // and one head-on tops out at 0.36 m from 2×24 m/s up (2×56 km/h: 0.16 m, 2×72: 0.30): without this no
      // sandbox or race car is ever disabled by one hit.
      const now = car.deform.drivetrainAlive && car.deform.engineTravel < killTravel(carClass(car), 1, ctx) ? 1 : 0;
      const was = this.alive[i]!;
      this.alive[i] = now;
      if (was === 1 && now === 0 && !this.thrown[i]) this.judge(cars, i, eject);
    }
    if (!sample) return;
    for (let i = 0; i < n; i++) {
      const o = (i * RING + this.head[i]!) * 2;
      this.vel[o] = cars[i]!.velocity.x;
      this.vel[o + 1] = cars[i]!.velocity.z;
      this.head[i] = (this.head[i]! + 1) % RING;
      this.count[i] = Math.min(RING, this.count[i]! + 1);
    }
  }

  /** Car i was just disabled: was that hit head-on or from the side, and hard enough? */
  private judge(cars: readonly DeformableCar[], i: number, eject: (i: number, exit: ExitPane, pre: THREE.Vector3) => void): void {
    const car = cars[i]!;
    // The struck end, as `struckEnd` reads it: inward points from the contact into the car.
    const ix = car.deform.impactInward.x;
    const iz = car.deform.impactInward.z;
    let exit: ExitPane;
    if (Math.abs(ix) > Math.abs(iz)) exit = ix > 0 ? "doorL" : "doorR";
    else if (iz < 0) exit = "windshield";
    else return;
    _n.copy(car.deform.impactInward).applyQuaternion(car.group.quaternion);
    _hit.copy(car.deform.impactLocal).applyQuaternion(car.group.quaternion).add(car.group.position);
    let other = -1;
    let best = OTHER_REACH;
    for (let j = 0; j < cars.length && j < MAX_CARS; j++) {
      if (j === i) continue;
      const d = cars[j]!.group.position.distanceTo(_hit);
      if (d < best) {
        best = d;
        other = j;
      }
    }
    // Peak over the samples since PRE s back: the cars were still closing (or speeding up into it) until contact.
    const back = Math.min(this.count[i]!, other >= 0 ? this.count[other]! : RING, Math.round(PRE / SAMPLE));
    let closing = -Infinity;
    let sx = car.velocity.x;
    let sz = car.velocity.z;
    for (let k = 1; k <= back; k++) {
      const a = (i * RING + ((this.head[i]! - k + RING) % RING)) * 2;
      let c = -(this.vel[a]! * _n.x + this.vel[a + 1]! * _n.z);
      if (other >= 0) {
        const b = (other * RING + ((this.head[other]! - k + RING) % RING)) * 2;
        c += this.vel[b]! * _n.x + this.vel[b + 1]! * _n.z;
      }
      if (c <= closing) continue;
      closing = c;
      sx = this.vel[a]!;
      sz = this.vel[a + 1]!;
    }
    if (closing < EJECT_CLOSING) return;
    this.thrown[i] = 1;
    eject(i, exit, this.pre.set(sx, 0, sz));
  }
}
