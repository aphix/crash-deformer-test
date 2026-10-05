import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { armKill, assignClass, CLASSES, HANDLING, type VehicleClassId } from "../vehicle/vehicle-classes.ts";
import { paint } from "../vehicle/test-support.ts";
import { INITIAL_HUD } from "../hud/hud-store.ts";
import { EjectionWatch } from "../vehicle/ejection.ts";
import { newWorld, settleStep, stepWorld } from "../engine/world-step.ts";
import { physicsSlice, sliceSpeed, BARRIER_HALF } from "../contact/sat.ts";
import { launch, makeWorld as barrierWorld, relaunchDamaged, strikeReach, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { makeWorld as raceWorld } from "./race-world.test-util.ts";
import { activeGround, setGround } from "./ground.ts";
import type { PrefabId } from "./catalog.ts";
import { placeProps, propColliders, type PropCollider } from "./placements.ts";
import { Track, blankPoint, blankProjection } from "./track.ts";
import { parseTrack } from "./track-schema.ts";
import { OFF_MENU, TRACKS } from "./tracks/index.ts";

/**
 * One car meeting a fixed solid, so every kind of solid can be held to the jersey barrier (the range's slab, the
 * reference the crush is calibrated on): the same car class, armed as a race car is, at the same closing speed.
 * A rig is the target, its world stepping and its two ways to send the car at it; `strike` runs the hits.
 * Not a test file itself.
 */

const FRAME = 1 / 60;
/** Sim seconds a hit plays out, the throw and the block's last travel included. */
const SETTLE = 2.5;
/** Nose-to-face gap (m) a car is sent from. */
const RUN_IN = 3;

/** What one hit left of the car. */
export type Outcome = {
  alive: boolean;
  /** 0 dead … 1 untouched (`drivetrainHealth`). */
  health: number;
  /** Block travel (m) toward the cabin. */
  travel: number;
  wheels: number;
  /** Whether the sim threw the driver out (this hit, or an earlier one's: a driver stays out). */
  ejected: boolean;
};

/** A car class as a race car has it: its body, durability and the kill travel the default realism gives. */
export function armedCar(cls: VehicleClassId): DeformableCar {
  const car = new DeformableCar(paint(), new THREE.Scene(), null, CLASSES[cls].style);
  assignClass(car, cls);
  car.deform.squash = INITIAL_HUD.squash;
  car.deform.buckle = INITIAL_HUD.buckle;
  car.deform.setMode(INITIAL_HUD.deformMode);
  armKill(car.deform, cls, HANDLING.realism, "default");
  return car;
}

type Rig = {
  car: DeformableCar;
  /** Car-local reach (m) of the nose from the group origin: how far from the face the origin starts. */
  aim(car: DeformableCar, speed: number): void;
  /** One 1/60 s frame of the world. */
  frame(): void;
  ejections(): number;
  done(): void;
};

/** The range's slab, held fixed (`HeldBarrier`): the car comes from +x at -x. */
function barrierRig(car: DeformableCar): Rig {
  const w = barrierWorld([car], true, false);
  return {
    car,
    aim: (c, speed) => {
      const x = BARRIER_HALF.x + RUN_IN + strikeReach(c, "front");
      if (c.crashed) relaunchDamaged(c, x, 0, -Math.PI / 2, -speed, 0);
      else launch(c, x, 0, -Math.PI / 2, -speed, 0);
    },
    frame: () => tickWorld(w),
    ejections: () => w.ejections.length,
    done: () => {},
  };
}

const COURSE_JSON = [...TRACKS, ...OFF_MENU];

/** A face: the point on it the car aims at, and its unit normal out of the solid (toward the car). */
type Face = { x: number; z: number; nx: number; nz: number };

/** The race stack's walls and props, headless: the car is stepped by the engine's `stepWorld` with the director's `courseHit` as its end-of-slice hook. */
function courseRig(car: DeformableCar, id: string, face: (track: Track, colliders: readonly PropCollider[]) => Face): Rig {
  const w = raceWorld();
  w.race.showLobby(id);
  const track = new Track(COURSE_JSON.find((j) => parseTrack(j).id === id));
  const f = face(track, propColliders(placeProps(track)));
  const world = newWorld([car]);
  world.ejection = new EjectionWatch();
  world.collide = (c, i, h) => w.race.courseHit(c, i, h);
  let ejected = 0;
  let acc = 0;
  return {
    car,
    aim: (c, speed) => {
      const reach = strikeReach(c, "front");
      const x = f.x + f.nx * (RUN_IN + reach);
      const z = f.z + f.nz * (RUN_IN + reach);
      const yaw = Math.atan2(-f.nx, -f.nz);
      if (c.crashed) relaunchDamaged(c, x, z, yaw, -f.nx * speed, -f.nz * speed);
      else launch(c, x, z, yaw, -f.nx * speed, -f.nz * speed);
      // Both put the car at y = 0; the monument stands on an embankment 2-4 m up, and a car started under the ground is lifted onto it,
      // tilted and shifted, by the wreck's first frame.
      const y = activeGround().heightAt(x, z);
      if (Number.isFinite(y)) {
        c.group.position.y = y;
        for (const m of c.deform.masses) m.world.y += y;
      }
    },
    frame: () => {
      const vmax = sliceSpeed(world.cars);
      acc = Math.min(0.05, acc + FRAME);
      for (let steps = 0; acc > 1e-5 && steps < 8; steps++) {
        const h = Math.fround(physicsSlice(acc, vmax));
        stepWorld(world, h);
        ejected += world.ejection!.take().length;
        settleStep(world.cars, h, false);
        acc -= h;
      }
    },
    ejections: () => ejected,
    done: () => setGround(null),
  };
}

/** A straight stretch of `track` with a wall on the left, 12 m of road either side of its middle: its face, 1 m from the middle's line. */
function straightWall(track: Track): Face {
  const p = track.path;
  const pt = blankPoint();
  const pt2 = blankPoint();
  const proj = blankProjection();
  for (let s = 20; s < track.length - 20; s += 4) {
    track.pointAt(s, pt);
    let ok = true;
    for (let d = -12; d <= 12 && ok; d += 4) {
      track.pointAt(s + d, pt2);
      const k = track.project(pt2.x, pt2.z, -1, proj).k;
      ok = !!p.wallL[k] && Math.abs(pt2.tx * pt.tz - pt2.tz * pt.tx) < 0.02;
    }
    if (!ok) continue;
    const k = track.project(pt.x, pt.z, -1, proj).k;
    const limit = p.half[k]! + p.runL[k]!;
    // Left of travel = (tz, -tx); the wall's normal points back to the road.
    return { x: pt.x + pt.tz * limit, z: pt.z - pt.tx * limit, nx: -pt.tz, nz: pt.tx };
  }
  throw new Error(`${track.id}: no straight wall`);
}

/** The collider of `prefab` whose nearest neighbour is farthest (a neighbour's own contact would answer for it), and its +x face (a thin box's wide side, a circle's x side). */
function propFace(colliders: readonly PropCollider[], prefab: PrefabId): Face {
  const gap = (c: PropCollider): number => Math.min(...colliders.filter((o) => o !== c).map((o) => Math.hypot(o.x - c.x, o.z - c.z) - o.r - c.r));
  const c = colliders.filter((o) => o.prefab === prefab).reduce((a, b) => (gap(b) > gap(a) ? b : a));
  // A box is met on the face of its thin axis (a block: its local x), a circle on its x side: the car comes along the prop's own axis.
  const thinZ = c.kind === "box" && c.hz < c.hx;
  const nx = thinZ ? Math.sin(c.yaw) : Math.cos(c.yaw);
  const nz = thinZ ? Math.cos(c.yaw) : -Math.sin(c.yaw);
  const depth = c.kind === "circle" ? c.r : thinZ ? c.hz : c.hx;
  return { x: c.x + nx * depth, z: c.z + nz * depth, nx, nz };
}

export type Target = "barrier" | "oval" | "rally" | "stucco" | "wall" | "monument" | "palm";

function rigFor(target: Target, car: DeformableCar): Rig {
  if (target === "barrier") return barrierRig(car);
  if (target === "oval" || target === "rally") return courseRig(car, target, (t) => straightWall(t));
  return courseRig(car, "havana", (_t, cols) => propFace(cols, target));
}

/**
 * `class` at `speed` m/s square into `target`, `hits` times (a wreck sent back at the same speed, its damage kept):
 * what each hit left of it.
 */
export function strike(target: Target, cls: VehicleClassId, speed: number, hits = 1): Outcome[] {
  const car = armedCar(cls);
  const rig = rigFor(target, car);
  const out: Outcome[] = [];
  try {
    for (let k = 0; k < hits; k++) {
      rig.aim(car, speed);
      for (let f = 0; f < SETTLE / FRAME; f++) rig.frame();
      const d = car.deform;
      out.push({ alive: d.drivetrainAlive, health: d.drivetrainHealth, travel: d.engineTravel, wheels: d.wheelsOn, ejected: rig.ejections() > 0 });
    }
  } finally {
    rig.done();
  }
  return out;
}
