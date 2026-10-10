import * as THREE from "three";
import { applyDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { fit, frame, makeCar, DEG, FRAME } from "../vehicle/ground-probe.test-util.ts";
import { newWorld, type World } from "../engine/world-step.ts";
import { setGround, type Ground } from "../world/ground.ts";
import { type Corkscrew, CORKSCREW } from "./corkscrew.ts";

/**
 * Cars as the road, a ramp or a platform (docs/UNIFIED_CONTACT.md stage 0): a car pressed into a profile and held, the same
 * run driven over the real feature and over the cars that stand for it. Not a test file itself.
 */

/** Car-local mass rest heights (m): the lowest (the hubs) and the highest (the roof). */
const MASS_LO = 0.32;
const MASS_HI = 1.18;
/** The pristine skin's reach (m) under the lowest mass and over the highest, and the share of a mass's travel the skin takes (about 0.7: strain 0.65 and the cages). */
const SKIN_BELOW = 0.175;
const SKIN_ABOVE = 0.186;
const SKIN_FOLLOW = 0.7;
const FIT_PASSES = 5;

/** A car's top and bottom surface (car-local y) at car-local z. */
export type Layer = { top: (z: number) => number; bottom: (z: number) => number };
/** Where a car is held. */
type Pose = { pos: THREE.Vector3; rot: THREE.Euler };
export type Held = { car: DeformableCar; pose: Pose };

/** Put `car` at `pose`, its masses where its own `local` points say, at rest. */
function hold(car: DeformableCar, pose: Pose): void {
  const g = car.group;
  g.position.copy(pose.pos);
  g.rotation.copy(pose.rot);
  g.updateWorldMatrix(false, false);
  for (const m of car.deform.masses) {
    m.world.copy(m.local).applyMatrix4(g.matrixWorld);
    m.vel.set(0, 0, 0);
  }
  car.velocity.set(0, 0, 0);
  car.angular.set(0, 0, 0);
  car.speed = 0;
  car.refreshBasis();
}

/** The drawn skin's highest y (car-local) per 1 / `perM` m of length, keyed by round(z * perM). */
function skinTops(car: DeformableCar, perM: number): Map<number, number> {
  const pos = car.body.geometry.getAttribute("position") as THREE.BufferAttribute;
  const bins = new Map<number, number>();
  for (let i = 0; i < pos.count; i++) {
    const k = Math.round(pos.getZ(i) * perM);
    bins.set(k, Math.max(bins.get(k) ?? -Infinity, pos.getY(i)));
  }
  return bins;
}

/** One re-solve and one write of the skin from the masses as they stand. */
function reskin(car: DeformableCar): void {
  car.deform["loadDirty"][0] = 1;
  car.stepBreakage(FRAME);
  car.updateSkin();
}

/**
 * A sedan pressed into `layer` and held at `pose`: every mass (the wheels' hubs too) is placed at its rest z along the profile,
 * its height in proportion to its rest height between the layer's bottom and top, the pristine skin's reach (`SKIN_BELOW`,
 * `SKIN_ABOVE`) left over at each end; the frame may yield (`deepCrush`), or the roof stays within 0.14 m of rest. The skin
 * follows the masses at only `SKIN_FOLLOW` of their travel and the hood, roof and boot differ, so a few passes then lift or
 * sink every mass by what the drawn top is still off the layer's top at its z.
 */
export function shapeCar(layer: Layer, pose: Pose): Held {
  const car = makeCar("sedan");
  car.spawnFacing(0, 0, 0, 0);
  car.deform.frameCrush = true;
  car.deform.deepCrush = true;
  for (const m of car.deform.masses) {
    const z = m.rest.z;
    const top = layer.top(z);
    const lo = Math.min(layer.bottom(z), top - SKIN_BELOW - SKIN_ABOVE) + SKIN_BELOW;
    const hi = top - SKIN_ABOVE;
    m.local.set(m.rest.x, lo + ((m.rest.y - MASS_LO) / (MASS_HI - MASS_LO)) * (hi - lo), z);
  }
  hold(car, pose);
  reskin(car);
  for (let pass = 0; pass < FIT_PASSES; pass++) {
    const tops = skinTops(car, 10);
    for (const m of car.deform.masses) {
      const k = Math.round(m.local.z * 10);
      const y = tops.get(k) ?? tops.get(k - 1) ?? tops.get(k + 1);
      if (y !== undefined) m.local.y -= (y - layer.top(k / 10)) / SKIN_FOLLOW;
    }
    hold(car, pose);
    reskin(car);
  }
  return { car, pose };
}

/** The drawn skin's top against the layer's top, per 0.2 m along the car up to its bumper masses (|z| ≤ 2.0, past that the nose and tail round off): the largest gap (m). The skin's own tolerance is 0.2 m (`SKIN`), ideally 5 cm. */
export function skinGap(held: Held, layer: Layer): number {
  let gap = 0;
  for (const [k, y] of skinTops(held.car, 5)) if (Math.abs(k) <= 10) gap = Math.max(gap, Math.abs(y - layer.top(k / 5)));
  return gap;
}

/** Hold `bodies` where they are: every slice puts each back (its masses at their `local` points) with no speed, a prop's way. */
function holdStatic(w: World, bodies: readonly Held[]): void {
  const at = new Map(bodies.map((b) => [b.car, b.pose]));
  w.afterCar = (car) => {
    const pose = at.get(car);
    if (pose) hold(car, pose);
  };
}

/**
 * The height of `surface` (world y at world x, z) in car-local terms: `y` of the car-local point (0, y, z) that lies on it
 * when the car is at `pose`, found along the car's own up axis.
 */
export function surfaceInFrame(surface: (x: number, z: number) => number, pose: Pose): (z: number) => number {
  const q = new THREE.Quaternion().setFromEuler(pose.rot);
  const p = new THREE.Vector3();
  return (z) => {
    let lo = -3;
    let hi = 3;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      p.set(0, mid, z).applyQuaternion(q).add(pose.pos);
      if (p.y > surface(p.x, p.z)) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  };
}

/** The pose that lays a car on the corkscrew's floor at floor distance `s` along its centreline, flush with it. */
export function corkPose(cork: Corkscrew, s: number): Pose {
  const hc = (z: number) => cork.heightAt(0, z);
  let z = CORKSCREW.mouthZ;
  for (let acc = 0; acc < s; z += 0.005) acc += Math.hypot(0.005, hc(z + 0.005) - hc(z));
  const t = new THREE.Vector3(0, (hc(z + 0.01) - hc(z - 0.01)) / 0.02, 1).normalize();
  const n = cork.normalAt(0, z, new THREE.Vector3(), hc(z) + 0.01);
  n.addScaledVector(t, -n.dot(t)).normalize();
  const right = new THREE.Vector3().crossVectors(n, t);
  const rot = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, n, t), "YXZ");
  return { pos: new THREE.Vector3(0, hc(z), z), rot };
}

export type DriveSetup = {
  /** The driven sedan's start: (x, z), speed (m/s). */
  x: number;
  z: number;
  v: number;
  /** The world's ground and its contact hook (walls). The cars' version of a feature runs on the flat ground. */
  ground: Ground;
  collide?: (c: DeformableCar, h: number) => unknown;
  /** Where wheel gaps are read: the real feature, for both versions of it. */
  ref: Ground;
  held: readonly Held[];
  seconds: number;
  /** No driver input at all (a driverless coast) instead of throttle holding `v`. */
  coast?: boolean;
  /** End the run when the car passes this z, or has been under 0.3 m/s this many frames. */
  stopZ?: number;
  stopStill?: number;
};

export type Run = {
  /** Speed (m/s) at the end and the highest the car's origin rose (m). */
  speedEnd: number;
  yMax: number;
  /** Largest turn of the car's heading from its start (deg). */
  headingMax: number;
  crashed: boolean;
  /** The longest flight (s) and the z it came down at (NaN with none). */
  airSeconds: number;
  landZ: number;
  /** Wheels within 10 cm of the real feature, frame by frame, as a sequence of changes (runs under 3 frames dropped). */
  wheels: number[];
};

const MIN_RUN = 3;
const GROUNDED = 0.1;

function sequence(counts: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < counts.length; ) {
    let j = i;
    while (j < counts.length && counts[j] === counts[i]) j++;
    if (j - i >= MIN_RUN && out[out.length - 1] !== counts[i]) out.push(counts[i]!);
    i = j;
  }
  return out;
}

/** One sedan driven through `o`'s world (held cars and all) at 60 Hz frames, the ground restored after. */
export function driveOver(o: DriveSetup): Run {
  setGround(o.ground);
  const car = makeCar("sedan");
  car.spawnFacing(o.x, o.z, 0, o.v);
  car.speed = o.v;
  const w = newWorld([car, ...o.held.map((b) => b.car)], null);
  holdStatic(w, o.held);
  if (o.collide) w.collide = (c, _i, h) => void o.collide!(c, h);
  const input: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
  if (!o.coast) {
    w.beforeSlice = (h) => {
      input.throttle = Math.max(0, Math.min(1, (o.v - car.speed) / 1.5));
      applyDrive(car, input, h);
      return false;
    };
  }
  const fwd = new THREE.Vector3();
  const heading = () => Math.atan2(fwd.set(0, 0, 1).applyQuaternion(car.group.quaternion).x, fwd.z);
  const heading0 = heading();
  const st = { acc: 0 };
  const counts: number[] = [];
  const run: Run = { speedEnd: 0, yMax: 0, headingMax: 0, crashed: false, airSeconds: 0, landZ: NaN, wheels: [] };
  let flight = 0;
  let still = 0;
  for (let f = 0; f < o.seconds * 60; f++) {
    frame(w, null, st);
    const p = car.group.position;
    const speed = Math.hypot(car.velocity.x, car.velocity.z);
    run.yMax = Math.max(run.yMax, p.y);
    run.headingMax = Math.max(run.headingMax, Math.abs(Math.atan2(Math.sin(heading() - heading0), Math.cos(heading() - heading0))) * DEG);
    run.crashed ||= car.crashed;
    counts.push(fit(car, o.ref).gaps.filter((g) => g < GROUNDED).length);
    if (car.airborne) flight++;
    else {
      if (flight * FRAME > run.airSeconds) {
        run.airSeconds = flight * FRAME;
        run.landZ = p.z;
      }
      flight = 0;
    }
    still = speed < 0.3 ? still + 1 : 0;
    run.speedEnd = speed;
    if ((o.stopZ !== undefined && p.z > o.stopZ) || (o.stopStill !== undefined && still >= o.stopStill)) break;
  }
  run.wheels = sequence(counts);
  setGround(null);
  return run;
}
