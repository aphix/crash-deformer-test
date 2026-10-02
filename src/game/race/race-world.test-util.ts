import * as THREE from "three";
import { DriverSeat } from "../car-drive.ts";
import { DeformableCar } from "../car.ts";
import { RaceDirector } from "../engine-race.ts";
import { partContactPair } from "../external-contact.ts";
import { fleetClass, fleetStyle } from "../fleet.ts";
import { INITIAL_HUD } from "../hud-store.ts";
import { resolveCarPair } from "../pair-contact.ts";
import { leftoverCrumple } from "../physics-util.ts";
import { physicsSlice, sliceSpeed } from "../sat.ts";
import { assignClass, carClass, HANDLING, killTravel } from "../vehicle-classes.ts";
import { Track, blankProjection } from "./track.ts";
import type { CarRecord, RaceSnapshot } from "./types.ts";

/**
 * The whole race stack headless, as the browser runs it minus the renderer: `RaceDirector` (rules
 * session, race AI, traffic and its bubble, walls, props, respawns, the rival aggression roll),
 * real `DeformableCar`s with their classes, `applyDrive`, and `CrashEngine.fixedStep`'s race-mode
 * physics order (integrate / syncPose, mass pair contact, part contact, SAT pair resolve, structure
 * step, wall and prop clip, rules step, `cutDrive`) at the engine's slice sizes, one 60 Hz frame at
 * a time. The player's slot is driven by the race AI (the seat only follows). Not a test file itself.
 */

export const FRAME = 1 / 60;
export type World = { cars: DeformableCar[]; live: () => DeformableCar[]; race: RaceDirector; seat: DriverSeat };

export function makeWorld(): World {
  const scene = new THREE.Scene();
  const cars: DeformableCar[] = [];
  const liveBuf: DeformableCar[] = [];
  let count = 0;
  const live = (): DeformableCar[] => {
    liveBuf.length = count;
    for (let i = 0; i < count; i++) liveBuf[i] = cars[i]!;
    return liveBuf;
  };
  const seat = new DriverSeat();
  const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 900);
  // Looking straight down from far below the world: no traffic spot is ever "in view".
  camera.position.set(0, -5000, 0);
  camera.lookAt(0, -6000, 0);
  const race = new RaceDirector({
    scene,
    camera,
    sun: new THREE.DirectionalLight(),
    seat,
    live,
    setCarCount: (n) => {
      while (cars.length < n) {
        const i = cars.length;
        const car = new DeformableCar({ body: 0x808080, accent: 0x404040, name: `Car${i}` }, scene, null, fleetStyle(i));
        assignClass(car, fleetClass(i));
        cars.push(car);
      }
      count = n;
    },
    // The engine's `dressCar` at the sandbox defaults.
    dress: (car) => {
      car.deform.squash = INITIAL_HUD.squash;
      car.deform.buckle = INITIAL_HUD.buckle;
      car.deform.setMode(INITIAL_HUD.deformMode);
      const cls = carClass(car);
      assignClass(car, cls);
      car.deform.killTravel = killTravel(cls, HANDLING.realism, "default");
    },
    setPaused: () => {},
    leave: () => {},
    hitFx: () => {},
    buildArt: () => null,
  });
  return { cars, live, race, seat };
}

/** `CrashEngine.fixedStep` in race mode (no barrier, balls, poles, derby). */
function fixedStep(w: World, dt: number): void {
  const cars = w.live();
  w.race.drive(dt);
  const slices = dt > 0.012 ? 2 : 1;
  const h = dt / slices;
  for (let i = 0; i < slices; i++) {
    for (const car of cars) {
      if (!car.deform.massActive) car.integrate(h);
      if (car.deform.massActive) car.syncPose(h);
      else car.refreshBasis();
    }
    for (let a = 0; a < cars.length; a++) {
      for (let b = a + 1; b < cars.length; b++) {
        const ca = cars[a]!;
        const cb = cars[b]!;
        const dx = ca.group.position.x - cb.group.position.x;
        const dz = ca.group.position.z - cb.group.position.z;
        if (dx * dx + dz * dz > 28 || Math.abs(ca.group.position.y - cb.group.position.y) > 2.5) continue;
        if (ca.deform.massActive || cb.deform.massActive) ca.deform.collideWith(cb.deform, h);
        partContactPair(ca, cb);
      }
    }
    let satBusy = false;
    let wrecked = true;
    for (const car of cars) {
      if (car.velocity.lengthSq() > 1.4) satBusy = true;
      if (!car.crashed || leftoverCrumple(car.deform.crumpleTravelCorner()) >= 0.2) wrecked = false;
    }
    for (let k = 0; k < (satBusy && !wrecked ? 3 : 1); k++) {
      for (const car of cars) {
        if (car.deform.massActive) car.syncPose(0);
        else car.refreshBasis();
      }
      let moved = false;
      for (let a = 0; a < cars.length; a++) {
        for (let b = a + 1; b < cars.length; b++) {
          if (Math.abs(cars[a]!.group.position.y - cars[b]!.group.position.y) > 2.5) continue;
          if (resolveCarPair(cars[a]!, cars[b]!, k === 0, h)) moved = true;
        }
      }
      if (!moved) break;
    }
    for (const car of cars) {
      if (car.deform.massActive) car.deform.stepStructure(h);
      if (car.deform.massActive) car.syncPose(h);
      car.afterContacts(h);
    }
    for (let ci = 0; ci < cars.length; ci++) w.race.collide(cars[ci]!, ci);
  }
  w.race.step(dt);
}

/** One rendered frame of `CrashEngine.tickInner` (physics part) at 1× time. */
export function frame(w: World, state: { acc: number }): void {
  const cars = w.live();
  const vmax = sliceSpeed(cars);
  state.acc = Math.min(0.05, state.acc + FRAME);
  let steps = 0;
  while (state.acc > 1e-5 && steps < 8) {
    const h = physicsSlice(state.acc, vmax);
    fixedStep(w, h);
    state.acc -= h;
    for (const car of cars) if (car.deform.massActive && !car.deform.drivetrainAlive) car.deform.cutDrive(h);
    steps++;
  }
  for (const car of cars) car.updateDeform(FRAME);
  w.race.frame(FRAME);
}

export type Outcome = {
  finished: number;
  out: number;
  dnf: { name: string; cause: string }[];
  slowestLap: number;
  winner: number;
  closedAt: number;
  respawns: number;
};

/** Why a car was still running when the race closed. */
function dnfCause(w: World, track: Track, c: CarRecord): string {
  const car = w.cars[c.id]!;
  const p = track.project(car.group.position.x, car.group.position.z, -1, blankProjection());
  const edge = track.path.half[p.k]! + Math.max(track.path.runL[p.k]!, track.path.runR[p.k]!);
  if (c.deaths >= 3) return `respawn loop (${c.deaths} deaths)`;
  if (c.wrongWay) return "wrong way";
  if (Math.abs(p.lateral) > edge + 1) return `off track (lateral ${p.lateral.toFixed(1)} m)`;
  if (car.velocity.length() < 0.5) return Math.abs(p.lateral) > track.path.half[p.k]! - 1.5 ? "wall-pinned" : "stuck";
  return `slow (lap ${c.lap + 1}, ${(car.velocity.length() * 3.6).toFixed(0)} km/h)`;
}

export function raceOnce(w: World, track: Track, bound: number): Outcome {
  const r = w.race;
  r.command({ type: "quit" });
  r.command({ type: "options", options: { trackId: track.id, laps: 2, aiCount: 4, noReset: false } });
  r.command({ type: "start" });
  // The seat only follows: the player's car is driven by the race AI like the others.
  w.seat.mode = "follow";
  const state = { acc: 0 };
  let snap: RaceSnapshot = r.snapshot()!;
  for (let n = 0; snap.phase !== "finished" && n * FRAME < bound; n++) {
    frame(w, state);
    if (n % 30 === 29) snap = r.snapshot()!;
  }
  snap = r.snapshot()!;
  const finished = snap.cars.filter((c) => c.status === "finished");
  const laps = finished.flatMap((c) => c.lapTimes);
  return {
    finished: finished.length,
    out: snap.cars.filter((c) => c.status === "out").length,
    dnf: snap.cars.filter((c) => c.status !== "finished" && c.status !== "out").map((c) => ({ name: c.name, cause: dnfCause(w, track, c) })),
    slowestLap: laps.length ? Math.max(...laps) : NaN,
    winner: finished.length ? Math.min(...finished.map((c) => c.finishTime!)) : NaN,
    closedAt: snap.phase === "finished" ? snap.time : NaN,
    respawns: snap.cars.reduce((n, c) => n + c.deaths, 0),
  };
}
