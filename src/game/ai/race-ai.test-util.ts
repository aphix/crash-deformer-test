import * as THREE from "three";
import { DRIVE, applyDrive, idleDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { blankAiCar, type AiCar } from "./derby-ai.ts";
import { snapshotAiCar } from "../match/derby.ts";
import { fleetStyle } from "../scenes/fleet.ts";
import { RaceBrain, copyDrive } from "./race-ai.ts";
import { AI_EVERY_SLICE, type AiDifficulty } from "./constants.ts";
import { RaceSession } from "../match/session.ts";
import { Track, blankProjection, projectPath } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { setGround } from "../world/ground.ts";
import type { CarPose, Entrant } from "../match/types.ts";
import { DT } from "../vehicle/test-support.ts";
import { carClass, classStats } from "../vehicle/vehicle-classes.ts";

export type Run = { session: RaceSession; onRoad: number; samples: number; mistakes: number };

/**
 * Real cars on the real drive model (kinematic, as every car is until it crashes) on the course's
 * ground, no car-to-car contact: the AI alone has to keep them on the road and round the laps. Each car's brain plans with its own class's
 * figures (`setClass`), as the game's race field does: a muscle car plans as a muscle car.
 */
export function race(track: Track, n: number, aggression: number, laps: number, limit: number, difficulty: AiDifficulty = AI_EVERY_SLICE, tap?: (id: number, out: DriveInput) => void): Run {
  const scene = new THREE.Scene();
  const ground = track.ground();
  setGround(ground);
  const cars = Array.from({ length: n }, (_, i) => new DeformableCar({ body: 0x808080, accent: 0x404040, name: `ai${i}` }, scene, null, fleetStyle(i)));
  const entrants: Entrant[] = cars.map((_, i) => ({ id: i, name: `ai${i}`, kind: "ai", aggression }));
  const session = new RaceSession(track, entrants, { laps, noReset: false });
  const brain = new RaceBrain(track, n);
  for (const [i, c] of cars.entries()) {
    const g = track.gridSlot(i);
    c.spawnFacing(g.x, g.z, g.yaw, 0);
    brain.setAggression(i, aggression);
    brain.setDifficulty(i, difficulty);
    brain.setClass(i, classStats(carClass(c)));
  }
  const snaps: AiCar[] = cars.map((_, i) => blankAiCar(i));
  const poses: CarPose[] = cars.map(() => ({ x: 0, z: 0, yaw: 0, vx: 0, vz: 0, alive: true }));
  const hold = { ...idleDrive(), brake: 1 };
  const held = cars.map(() => idleDrive());
  const p = blankProjection();
  let onRoad = 0;
  let samples = 0;
  let step = 0;
  while (session.phase !== "finished" && session.time < limit) {
    for (const [i, c] of cars.entries()) snapshotAiCar(snaps[i]!, i, c, true);
    for (const [i, c] of cars.entries()) {
      const rec = session.cars[i]!;
      let input = hold;
      if (session.phase === "racing" && rec.status === "racing") {
        if (brain.due(i, DT)) {
          const out = brain.think(snaps[i]!, snaps, rec, brain.elapsed(i));
          tap?.(i, out);
          copyDrive(out, held[i]!);
        }
        input = brain.guard(snaps[i]!, snaps, held[i]!);
      }
      applyDrive(c, input, DT);
      c.integrate(DT);
    }
    for (const [i, c] of cars.entries()) {
      const pose = poses[i]!;
      pose.x = c.group.position.x;
      pose.z = c.group.position.z;
      pose.yaw = c.yaw;
      pose.vx = c.velocity.x;
      pose.vz = c.velocity.z;
    }
    session.step(DT, poses);
    session.events();
    if (session.phase === "racing" && ++step % 6 === 0) {
      for (const [i, c] of cars.entries()) {
        if (session.cars[i]!.status !== "racing") continue;
        samples++;
        const x = c.group.position.x;
        const z = c.group.position.z;
        projectPath(track.path, x, z, -1, p);
        if (Math.abs(p.lateral) <= track.path.half[p.k]! + 0.3) {
          onRoad++;
          continue;
        }
        for (const sc of track.shortcuts) {
          projectPath(sc.path, x, z, -1, p);
          if (Math.abs(p.lateral) <= sc.path.half[p.k]! + 0.3) {
            onRoad++;
            break;
          }
        }
      }
    }
  }
  setGround(null);
  return { session, onRoad, samples, mistakes: brain.mistakes.reduce((a, b) => a + b, 0) };
}

/** How much looser each tier's finish bound is than hard's: the owner asked for slower lower tiers, and a stuck or lost car still misses it by minutes. */
const BOUND_SCALE: Record<AiDifficulty, number> = { easy: 1.2, medium: 1.1, hard: 1 };
export const COURSES = TRACKS.map((json) => new Track(json));
export type Summary = { winner: number; share: number; samples: number; finished: number; mistakes: number; lapTimes: number[]; time: number; limit: number; laps: string };

/** 8 clean cars racing 3 laps of `track` at `difficulty`, in numbers. */
export function summarize(track: Track, difficulty: AiDifficulty): Summary {
  // Half the drive model's top speed on average, plus the countdown and grid.
  const limit = ((3 * track.length) / (DRIVE.maxFwd / 2) + 10) * BOUND_SCALE[difficulty];
  const { session, onRoad, samples, mistakes } = race(track, 8, 0, 3, limit, difficulty);
  return { winner: session.cars.find((c) => c.id === session.winnerId)?.finishTime ?? Infinity, share: onRoad / samples, samples, finished: session.cars.filter((c) => c.status === "finished").length, mistakes, lapTimes: session.cars.flatMap((c) => c.lapTimes), time: session.time, limit, laps: session.cars.map((c) => c.lap).join(",") };
}

const memo = new Map<string, Summary>();
/** `summarize`, remembered: the per-course tests and the tier comparisons share each race. */
export function raced(track: Track, difficulty: AiDifficulty): Summary {
  const key = `${track.id}/${difficulty}`;
  if (!memo.has(key)) memo.set(key, summarize(track, difficulty));
  return memo.get(key)!;
}
