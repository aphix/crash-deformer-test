import * as THREE from "three";
import { DEG, frame, fit, FRAME, makeCar, worldOf } from "./ground-probe.test-util.ts";
import { EjectionWatch } from "./ejection.ts";
import { armKill, HANDLING, killClass, type VehicleClassId } from "./vehicle-classes.ts";
import type { DriveInput } from "./car-drive.ts";
import { SURFACES } from "../world/catalog.ts";
import type { Ground } from "../world/ground.ts";
import { setGround } from "../world/ground.ts";

/**
 * A car driven down a straight line over any `Ground` (not a Track's main loop: `drive` in ground-probe.test-util.ts follows that),
 * one `fit` per rendered frame, with the sim's ejection watch on, the kill threshold armed and the throttle scaled by the surface as the race does. The numbers a
 * course's drive matrix reports: the flight off a crest, the landing, the deepest underside and tyre in the ground, throws and kills.
 */

export type Line = {
  /** A point on the line and its heading (yaw 0 faces +Z). */
  x: number;
  z: number;
  yaw: number;
};

export type LineRun = {
  /** The longest unbroken flight that began at or past the crest (s), its apex above the ground under the car (m), and how far the car rose above where it took off (m). */
  air: number;
  apex: number;
  rise: number;
  takeoff: { x: number; z: number; y: number } | null;
  landing: { x: number; z: number; surface: string; speed: number; vy: number } | null;
  /**
   * Deepest underside point in the ground (m) over every frame, and deepest tread in `grass` (m) over the frames the car was not airborne:
   * each as the drop matrix's judge counts it, less what the model allows (a face's `crush` for the hull, a tilted tyre's tread shoulder for the tread).
   */
  pen: number;
  grass: number;
  /** The car's speed (m/s) as it passed `at` (z, heading −z); null if it never did. */
  speedAt: number | null;
  /** Drivers thrown out, and the frame time (s) the engine died (null: it did not). */
  ejections: number;
  killedAt: number | null;
  /** Largest step between two frames (m) beyond what the car's own speed explains: a teleport. */
  jump: number;
  end: { x: number; z: number; speed: number; seconds: number };
};

const _hub = new THREE.Vector3();
const SETTLE = 60;

/**
 * `cls` driven along `line` from `lead` m before its point, at `speed` m/s held (it starts at that speed), or from rest with the
 * throttle full when `speed` is "top". Ends after `seconds`, or when it passes `stopZ` (heading −z) or stands still for 2 s.
 * A flight counts as the crest's when it begins past `crestZ` (z, heading −z); `at` asks for the speed at that z. The caller restores the ground.
 */
export function runLine(
  ground: Ground,
  cls: VehicleClassId,
  line: Line,
  o: { lead: number; speed: number | "top"; seconds: number; crestZ: number; stopZ: number; at?: number },
): LineRun {
  setGround(ground);
  const car = makeCar(cls);
  const fx = Math.sin(line.yaw);
  const fz = Math.cos(line.yaw);
  const x0 = line.x - fx * o.lead;
  const z0 = line.z - fz * o.lead;
  car.spawnFacing(x0, z0, line.yaw, o.speed === "top" ? 0 : o.speed);
  car.group.position.y = ground.heightAt(x0, z0) + 0.5;
  const w = worldOf(car);
  w.ejection = new EjectionWatch();
  armKill(car.deform, killClass(car), HANDLING.realism, "default");
  const st = { acc: 0 };
  const input: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
  const out: LineRun = { air: 0, apex: 0, rise: 0, takeoff: null, landing: null, pen: 0, grass: 0, speedAt: null, ejections: 0, killedAt: null, jump: 0, end: { x: 0, z: 0, speed: 0, seconds: 0 } };
  let was = false;
  let begun = 0;
  let episode = 0;
  let epApex = 0;
  let epTop = 0;
  let epTake: { x: number; z: number; y: number } | null = null;
  let still = 0;
  const p = car.group.position;
  const prev = p.clone();
  for (let n = 0; n < o.seconds / FRAME; n++) {
    // Pursuit of a point ahead on the line.
    const along = (p.x - line.x) * fx + (p.z - line.z) * fz;
    const tx = line.x + fx * (along + 10 + car.speed * 0.4);
    const tz = line.z + fz * (along + 10 + car.speed * 0.4);
    const err = Math.atan2(tx - p.x, tz - p.z) - car.yaw;
    input.steer = Math.max(-1, Math.min(1, 2.5 * Math.atan2(Math.sin(err), Math.cos(err))));
    // The race's own rule (`onSurface`): the throttle is the surface's share of top speed.
    input.throttle = o.speed === "top" || car.speed < o.speed ? SURFACES[ground.surfaceAt(p.x, p.z, p.y)].speed : 0;
    frame(w, input, st);
    const f = fit(car, ground);
    // The first second is the spawn's 0.5 m drop settling, not the line.
    if (n >= SETTLE) out.pen = Math.max(out.pen, f.pen - f.crush);
    out.ejections += w.ejection.take().length;
    if (out.killedAt === null && !car.deform.drivetrainAlive) out.killedAt = n * FRAME;
    out.jump = Math.max(out.jump, Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z) - car.velocity.length() * FRAME * 1.5 - 0.1);
    prev.copy(p);
    if (o.at !== undefined && out.speedAt === null && p.z <= o.at) out.speedAt = car.speed;
    if (n >= SETTLE && !car.airborne) {
      car.wheels.forEach((wh, i) => {
        wh.getWorldPosition(_hub);
        if (ground.surfaceAt(_hub.x, _hub.z) === "grass") out.grass = Math.max(out.grass, -f.gaps[i]! - f.shoulder * Math.sin(f.tilt / DEG));
      });
    }
    const below = p.y - ground.heightAt(p.x, p.z);
    if (car.airborne) {
      if (!was) {
        begun = n;
        epApex = 0;
        epTop = p.y;
        epTake = { x: p.x, z: p.z, y: p.y };
      }
      epApex = Math.max(epApex, below);
      epTop = Math.max(epTop, p.y);
      episode = (n - begun + 1) * FRAME;
      if (epTake && epTake.z <= o.crestZ && episode > out.air) {
        out.air = episode;
        out.apex = epApex;
        out.rise = epTop - epTake.y;
        out.takeoff = epTake;
      }
    } else if (was && epTake && epTake === out.takeoff) {
      out.landing = { x: p.x, z: p.z, surface: ground.surfaceAt(p.x, p.z), speed: car.speed, vy: car.velocity.y };
    }
    was = car.airborne;
    still = car.speed < 0.3 && !car.airborne ? still + 1 : 0;
    out.end = { x: p.x, z: p.z, speed: car.speed, seconds: (n + 1) * FRAME };
    if (p.z < o.stopZ || (still > 120 && o.speed !== "top") || out.ejections > 0) break;
  }
  car.dispose();
  return out;
}
