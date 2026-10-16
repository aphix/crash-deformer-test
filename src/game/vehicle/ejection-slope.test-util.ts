import * as THREE from "three";
import { FRAME_HZ } from "../kernel/constants.ts";
import { setGround } from "../world/ground.ts";
import { blankPoint, blankProjection, pointOn, Track } from "../world/track.ts";
import { parseTrack } from "../world/track-schema.ts";
import { TRACKS } from "../world/tracks/index.ts";
import type { DriveInput } from "./car-drive.ts";
import { layOnGround } from "./car-air-points.ts";
import type { ExitPane } from "./car-core.ts";
import { EjectionWatch } from "./ejection.ts";
import { armKill, classStats, cornerSpeed, DEFAULT_REALISM, killClass, type ClassStats, type VehicleClassId } from "./vehicle-classes.ts";
import { frame, makeCar, worldOf } from "./ground-probe.test-util.ts";

/**
 * Owner, 2026-10-03: "drivers are now getting thrown out of their cars when going on that same slope [the stunt course's
 * CRUSH crest] and also on banked turns, far more than would be expected". A car that has been hit once (any contact, even
 * a 2 km/h scrape) is a live lattice of masses (`massActive`); since WheelGround its frame lies on the ground's plane
 * under the hubs while the masses stay, and across a crest (pitch -5 -> +6 deg in 0.4 s) the cabin 0.55 m up read 0.1 m
 * "back" in it: `engineTravel` latched that as crush and the engine died with nothing touching the car, and the
 * ejection watch read the kill as a hit and threw the driver along the normal of a hit 1-60 s old.
 * Here a car takes one light hit (closing 7 m/s, nothing near the block), settles, and is driven over the ground.
 */
export const track = (id: string): Track => new Track(TRACKS.find((t) => parseTrack(t).id === id));

export type Hit = "side" | "rear" | "front";
/** Where a hit lands (car-local) and the way it pushes in; +z is the car's nose. */
const HITS: Record<Hit, [THREE.Vector3, THREE.Vector3]> = {
  side: [new THREE.Vector3(-0.9, 0.5, -0.5), new THREE.Vector3(0.84, 0, -0.52)],
  rear: [new THREE.Vector3(0, 0.5, -2.2), new THREE.Vector3(0, 0, 1)],
  front: [new THREE.Vector3(0, 0.5, 2.2), new THREE.Vector3(0, 0, -1)],
};

export type Run = {
  /** The block's travel (m) the moment the car reached `s0`, 1+ s after its hit. */
  settled: number;
  /** ... and at the end. */
  end: number;
  alive: boolean;
  thrown: ExitPane[];
  /** Where along the course the run ended. */
  endS: number;
  /** The car got from `s0` to `s1` along the loop before the frame cap (`SLOWEST_MEAN_PACE`) stopped it. */
  reached: boolean;
};

/** Metres behind `s0` a run's car spawns, to settle at pace and take its hit before the stretch under test. */
const LEAD = 60;
/** The most a frame may move the car's projection along the course (m): more is the car off the road and snapped to another stretch of it, not driving the loop. */
const DERAIL_STEP = 5;
/** The least a run's mean speed may be, as a fraction of its pace (the hit's closing speed, a hairpin, a climb): the margin on the frame cap. */
const SLOWEST_MEAN_PACE = 0.5;
/** `x` brought into [0, lap). */
const wrapArc = (x: number, lap: number): number => ((x % lap) + lap) % lap;
/** Metres between the samples of the bends ahead the driver reads, and the reach it reads beyond its braking distance. */
const BEND_STEP = 3;
const BEND_REACH = 12;
/** The share of a class's corner speed (`cornerSpeed`) the driver takes a bend at: the damaged car, on this driver's line, runs wide of the road in a bend taken at the whole of it. */
const BEND_SPEED_SHARE = 0.9;
/** Metres short of a lap's end a whole-loop run stops (the start/finish's corner: the line past it belongs to the next lap's lead). */
const LOOP_TAIL = 30;

/** The fastest the car may go at `s` m along `trk` doing `v` m/s and still brake (at the class's `brake`) down to the corner speed of every bend within reach. */
function bendLimit(trk: Track, stats: ClassStats, s: number, v: number): number {
  const p = trk.path;
  let allowed = Infinity;
  for (let d = 0; d <= (v * v) / (2 * stats.brake) + BEND_REACH; d += BEND_STEP) {
    const k = Math.floor((wrapArc(s + d, p.length) / p.length) * p.count) % p.count;
    const curv = Math.abs(p.curv[k]!);
    if (curv > 0) allowed = Math.min(allowed, Math.sqrt((BEND_SPEED_SHARE * cornerSpeed(stats, 1 / curv)) ** 2 + 2 * stats.brake * d));
  }
  return allowed;
}

/**
 * A fleet car hit once at 0.5 s (a pair of AI cars gave each other 7 m/s closing), driven down `trk`'s main loop from
 * `LEAD` m before `s0` at `pace` m/s to `s1`, however the loop's arc length wraps between them, the edge-triggered ejection watch running as in a race. `touch` = [from, to]:
 * something brushes the car every frame while it is between those two distances along the course (`notifyContact`,
 * the call the contact pass makes for every touching slice), with no force on it. `bends`: the driver slows for the bends ahead (`bendLimit`), else it holds `pace`.
 */
export function crashedRun(trk: Track, cls: VehicleClassId, pace: number, hit: Hit, s0: number, s1: number, touch?: readonly [number, number], bends = false): Run {
  const ground = trk.ground();
  setGround(ground);
  const car = makeCar(cls);
  const stats = classStats(cls);
  armKill(car.deform, killClass(car), DEFAULT_REALISM, "default");
  const pt = blankPoint();
  const at = (s: number) => {
    pointOn(trk.path, s, pt);
    return [pt.x, pt.z] as const;
  };
  const [x0, z0] = at(s0 - LEAD);
  car.spawnFacing(x0, z0, Math.atan2(pt.tx, pt.tz), pace);
  car.group.position.y = ground.heightAt(x0, z0, pt.y + 0.5);
  layOnGround(car);
  const w = worldOf(car);
  const watch = new EjectionWatch();
  w.ejection = watch;
  const st = { acc: 0 };
  const proj = blankProjection();
  const input: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
  const thrown: ExitPane[] = [];
  const wp = new THREE.Vector3();
  const wi = new THREE.Vector3();
  let settled = NaN;
  const lap = trk.length;
  let s = wrapArc(s0 - LEAD, lap);
  // `u` is the car's unwrapped position along the course: `s` jumps by `lap` where the arc length wraps, `u` does not.
  let u = s0 - LEAD;
  const end = s0 + wrapArc(s1 - s0, lap);
  const cap = Math.ceil(((LEAD + end - s0) / (pace * SLOWEST_MEAN_PACE)) * FRAME_HZ);
  let reached = false;
  for (let n = 0; n < cap; n++) {
    const p = car.group.position;
    const now = trk.project(p.x, p.z, proj.k, proj).s;
    const step = wrapArc(now - s + lap / 2, lap) - lap / 2;
    if (Math.abs(step) > DERAIL_STEP) break;
    s = now;
    u += step;
    if (u > end) {
      reached = true;
      break;
    }
    if (n === 30) {
      car.group.updateWorldMatrix(true, false);
      wp.copy(HITS[hit][0]).applyMatrix4(car.group.matrixWorld);
      wi.copy(HITS[hit][1]).applyQuaternion(car.group.quaternion);
      car.applyImpact(wp, wi, 7, 3.5);
    }
    if (Number.isNaN(settled) && u >= s0) settled = car.deform.engineTravel;
    const [tx, tz] = at(s + 8 + car.speed * 0.4);
    const err = Math.atan2(tx - p.x, tz - p.z) - car.yaw;
    input.steer = Math.max(-1, Math.min(1, 2.5 * Math.atan2(Math.sin(err), Math.cos(err))));
    const want = bends ? Math.min(pace, bendLimit(trk, stats, s, car.speed)) : pace;
    input.throttle = car.speed < want ? 1 : 0;
    input.brake = car.speed > want + 2 ? 1 : 0;
    if (touch && s >= touch[0] && s <= touch[1]) car.deform.notifyContact();
    frame(w, input, st);
    for (const e of watch.take()) thrown.push(e.exit);
  }
  const run = { settled, end: car.deform.engineTravel, alive: car.deform.drivetrainAlive, thrown, endS: s, reached };
  car.dispose();
  return run;
}

/**
 * `crashedRun` over the whole main loop of `trk` (the damaged sedan, a flank hit, from 60 m to 30 m short of the lap's end), the driver
 * braking for the bends ahead: a lap's tight hairpins are taken at the speed the car can turn at, as a driver would, not driven through.
 */
export function loopRun(trk: Track, pace: number): Run {
  return crashedRun(trk, "sedan", pace, "side", LEAD, trk.length - LOOP_TAIL, undefined, true);
}

/** The most the block may move over ground with nothing touching the car (m): the noise of the lattice settling. */
export const DRIFT = 0.005;

/** The courses whose whole loop the per-commit suite drives (the ones the owner's report named); every other course's is in ejection-slope.ai-long-run.ts. */
export const NAMED_LOOPS = ["oval", "rally", "stunt"] as const;
