import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { armKill, assignClass, CLASSES, HANDLING, type VehicleClassId } from "../vehicle/vehicle-classes.ts";
import { paint } from "../vehicle/test-support.ts";
import { INITIAL_HUD } from "../hud/hud-store.ts";
import { EjectionWatch } from "../vehicle/ejection.ts";
import { newWorld, settleStep, stepWorld } from "../engine/world-step.ts";
import { physicsSlice, sliceSpeed, BARRIER_HALF } from "../contact/sat.ts";
import { FOOT_HALF_L } from "../vehicle/car-mesh.ts";
import { cageLift } from "../vehicle/car-cage-rig.ts";
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
/** How far out (m) from the face the ground under the car's run is read: the run-in and a car's length. */
const APPROACH = RUN_IN + 2 * FOOT_HALF_L;

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
  /** The car's speed (m/s) when the hit has played out: a solid that stops a car leaves none. */
  speed: number;
  /** How far (rad) the car's heading turned over the hit, positive toward the side the face's aim point was on (its right, for a positive offset). */
  turn: number;
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
  /** The face the car is sent at. */
  face: Face;
  /** Sends the car at the face at `speed` m/s, the face's aim point `offset` m to the car's right of its middle. */
  aim(car: DeformableCar, speed: number, offset: number): void;
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
    face: { x: BARRIER_HALF.x, z: 0, nx: 1, nz: 0 },
    aim: (c, speed, offset) => {
      const x = BARRIER_HALF.x + RUN_IN + strikeReach(c, "front");
      if (c.crashed) relaunchDamaged(c, x, -offset, -Math.PI / 2, -speed, 0);
      else launch(c, x, -offset, -Math.PI / 2, -speed, 0);
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
    face: f,
    aim: (c, speed, offset) => {
      const reach = strikeReach(c, "front");
      // The car starts `offset` m to its left of the face's aim point, so that point is that far to its right.
      const x = f.x + f.nx * (RUN_IN + reach) + f.nz * offset;
      const z = f.z + f.nz * (RUN_IN + reach) - f.nx * offset;
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

/**
 * The prop of `prefab` whose nearest neighbour prop is farthest (a neighbour's own contact would answer for it), its ground piece
 * farthest out from the middle of its ground pieces, and that piece's +x face (a thin box's wide side, a circle's x side: a star's
 * arm is met on its flank at its base). Of equally far pieces (a star's five arms) the one with the most level ground before it: a wreck rolls
 * off a slope by itself, and the slab it is held to stands on a flat range.
 */
function propFace(colliders: readonly PropCollider[], prefab: PrefabId, end = false): Face {
  const gap = (c: PropCollider): number => Math.min(...colliders.filter((o) => o.index !== c.index).map((o) => Math.hypot(o.x - c.x, o.z - c.z) - o.r - c.r));
  const ground = (c: PropCollider): boolean => colliders.every((o) => o.index !== c.index || o.base >= c.base);
  const lead = colliders.filter((o) => o.prefab === prefab && ground(o)).reduce((a, b) => (gap(b) > gap(a) ? b : a));
  const own = colliders.filter((o) => o.index === lead.index && ground(o));
  const mx = own.reduce((s, o) => s + o.x, 0) / own.length;
  const mz = own.reduce((s, o) => s + o.z, 0) / own.length;
  const reach = (c: PropCollider): number => Math.hypot(c.x - mx, c.z - mz);
  const farthest = Math.max(...own.map(reach));
  const faceOf = (c: PropCollider): Face => {
    // A box is met on the face of its thin axis (a block: its local x), a circle on its x side: the car comes along the prop's own axis.
    // `end`: a box is met on the end of its long axis (a star's arm at its tip, the car coming along the arm).
    const thinZ = c.kind === "box" && (end ? c.hz > c.hx : c.hz < c.hx);
    const nx = thinZ ? Math.sin(c.yaw) : Math.cos(c.yaw);
    const nz = thinZ ? Math.cos(c.yaw) : -Math.sin(c.yaw);
    const depth = c.kind === "circle" ? c.r : thinZ ? c.hz : c.hx;
    return { x: c.x + nx * depth, z: c.z + nz * depth, nx, nz };
  };
  // A star arm is stepped down its taper in slices (a sliver at its tip): its flank is met at the slice next to the core, where it is widest (the arm's first piece is the core's).
  const flank = (tip: PropCollider): PropCollider => {
    const arm = own.filter((o) => o.yaw === tip.yaw && o.kind === tip.kind).sort((a, b) => reach(a) - reach(b));
    return arm[Math.min(1, arm.length - 1)]!;
  };
  const rise = (f: Face): number => Math.abs(activeGround().heightAt(f.x + f.nx * APPROACH, f.z + f.nz * APPROACH) - activeGround().heightAt(f.x, f.z));
  return own
    .filter((c) => reach(c) > farthest - 1e-6)
    .map((tip) => (end ? tip : flank(tip)))
    .map(faceOf)
    .reduce((a, b) => (rise(b) < rise(a) ? b : a));
}

export type Target = "barrier" | "oval" | "rally" | "stucco" | "wall" | "monument" | "monument-tip" | "palm";

function rigFor(target: Target, car: DeformableCar): Rig {
  if (target === "barrier") return barrierRig(car);
  if (target === "oval" || target === "rally") return courseRig(car, target, (t) => straightWall(t));
  // The monument's arm met end-on, along its own axis, at its tip (what a car driving at the star does), as the course places it.
  if (target === "monument-tip") return courseRig(car, "havana", (_t, cols) => propFace(cols, "monument", true));
  return courseRig(car, "havana", (_t, cols) => propFace(cols, target));
}

/**
 * `class` at `speed` m/s square into `target`, `hits` times (a wreck sent back at the same speed, its damage kept):
 * what each hit left of it.
 */
export function strike(target: Target, cls: VehicleClassId, speed: number, hits = 1, offset = 0): Outcome[] {
  const car = armedCar(cls);
  const rig = rigFor(target, car);
  const out: Outcome[] = [];
  try {
    for (let k = 0; k < hits; k++) {
      rig.aim(car, speed, offset);
      const heading = car.yaw;
      for (let f = 0; f < SETTLE / FRAME; f++) rig.frame();
      const d = car.deform;
      out.push({ alive: d.drivetrainAlive, health: d.drivetrainHealth, travel: d.engineTravel, wheels: d.wheelsOn, ejected: rig.ejections() > 0, speed: car.velocity.length(), turn: car.yaw - heading });
    }
  } finally {
    rig.done();
  }
  return out;
}

/** How far (m) the car's points are past a face's plane, along the face's inward normal: its rigid body points (the cage's vertices) and its drawn body's vertices. */
export type Sink = { hull: number; mesh: number };
const _p = new THREE.Vector3();

/** Cage vertex `k` in `car`'s own frame (class lift on) into `out`: the body's contact points, as the rigid step reads them. */
function cageVertex(car: DeformableCar, k: number, out: THREE.Vector3): THREE.Vector3 {
  car.refitCage();
  const pos = car.cage.fields.pos;
  return out.set(pos[k * 3]!, pos[k * 3 + 1]! + cageLift(car), pos[k * 3 + 2]!);
}

function sinkPast(car: DeformableCar, f: Face): Sink {
  const into = (): number => -((_p.x - f.x) * f.nx + (_p.z - f.z) * f.nz);
  const q = car.group.quaternion;
  let hull = -Infinity;
  for (let k = 0; k < car.cage.style.vertexCount; k++) {
    cageVertex(car, k, _p).applyQuaternion(q).add(car.group.position);
    hull = Math.max(hull, into());
  }
  car.updateSkin();
  car.group.updateMatrixWorld(true);
  const wheels = new Set<THREE.Object3D>();
  for (const w of car.wheels) w.traverse((o) => wheels.add(o));
  let mesh = -Infinity;
  car.group.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || wheels.has(o) || !o.visible) return;
    const at = o.geometry.attributes.position;
    if (!at || at.count > 30000) return;
    for (let i = 0; i < at.count; i++) {
      _p.fromBufferAttribute(at, i).applyMatrix4(o.matrixWorld);
      mesh = Math.max(mesh, into());
    }
  });
  return { hull, mesh };
}

/**
 * `cls` at `speed` m/s square into `target` after `before` earlier hits of the same speed (a wreck sent back, its damage kept), then the
 * sim's `SETTLE` seconds: the deepest the car's points ever were past the face (`peak`), and how deep they stand when the hit has
 * played out (`rest`), with the speed (m/s) the car has by then.
 */
export function strikeSink(target: Target, cls: VehicleClassId, speed: number, before = 0, watch?: (frame: number, sink: Sink, car: DeformableCar) => void): { peak: Sink; rest: Sink; speed: number } {
  const car = armedCar(cls);
  const rig = rigFor(target, car);
  const peak: Sink = { hull: -Infinity, mesh: -Infinity };
  let rest: Sink = peak;
  try {
    for (let hit = 0; hit <= before; hit++) {
      rig.aim(car, speed, 0);
      for (let f = 0; f < SETTLE / FRAME; f++) {
        rig.frame();
        if (hit < before) continue;
        rest = sinkPast(car, rig.face);
        peak.hull = Math.max(peak.hull, rest.hull);
        peak.mesh = Math.max(peak.mesh, rest.mesh);
        watch?.(f, rest, car);
      }
    }
    return { peak, rest, speed: car.velocity.length() };
  } finally {
    rig.done();
  }
}
