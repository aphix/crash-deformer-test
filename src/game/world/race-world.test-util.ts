import * as THREE from "three";
import { DriverSeat } from "../vehicle/car-drive.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { RaceDirector } from "../engine/engine-race.ts";
import { newWorld, settleStep, stepWorld, type World as StepWorld } from "../engine/world-step.ts";
import { fleetClass, fleetStyle } from "../scenes/fleet.ts";
import { INITIAL_HUD } from "../hud/hud-store.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { EjectionWatch, type Ejection } from "../vehicle/ejection.ts";
import { armKill, assignClass, carClass, HANDLING, killClass } from "../vehicle/vehicle-classes.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { parseTrack } from "./track-schema.ts";
import { Track, blankPoint, blankProjection } from "./track.ts";
import { TRACKS } from "./tracks/index.ts";
import { DEFAULT_RACE_OPTIONS, type CarRecord, type RaceResultRow, type RaceSnapshot } from "../match/types.ts";

/**
 * The whole race stack headless, as the browser runs it minus the renderer: `RaceDirector` (rules
 * session, race AI, traffic and its bubble, walls, props, respawns, the rival aggression roll),
 * real `DeformableCar`s with their classes, `applyDrive`, and `CrashEngine.fixedStep` in race mode
 * (the director drives, `stepWorld` with the director's walls and props, the rules step), one 60 Hz
 * frame at a time. Not a test file itself.
 */

export const FRAME = 1 / 60;
export type World = {
  cars: DeformableCar[];
  live: () => DeformableCar[];
  race: RaceDirector;
  /** The camera the director's view tests read (looking down from far below the world until a test aims it). */
  camera: THREE.PerspectiveCamera;
  /** Times the race asked the engine to leave its scene (`RaceHost.leave`: Quit in Survival). */
  leaves: number;
  seat: DriverSeat;
  /** Called for every car pair in physical contact (the slice's first SAT pass), car indices a < b. */
  onPairContact: ((a: number, b: number) => void) | null;
  step: StepWorld;
  /** The engine's `dressCar` at the sandbox defaults (a respawned car re-dressed). */
  dress: (car: DeformableCar) => void;
  /** How many times the race asked the engine to empty the scene (`RaceHost.clear`: every start, retry, next). */
  clears: number;
  /** Times a Watch race start asked for the Auto spectator camera (`RaceHost.watchCam`). */
  watchCams: number;
  /** Every driver the sim threw out so far, in order (`CrashEngine.ejected` hands each to the recorder). */
  ejections: Ejection[];
};

/** `survivalCourse`: a variant of the Survival course file (props added, say); the real one when omitted. */
export function makeWorld(survivalCourse?: unknown): World {
  const scene = new THREE.Scene();
  const cars: DeformableCar[] = [];
  const liveBuf: DeformableCar[] = [];
  let count = 0;
  // The engine's police range (`setPolice`): those slots are police cruisers.
  let policeFrom = 0;
  let policeCount = 0;
  const isPolice = (i: number) => i > 0 && i >= policeFrom && i < policeFrom + policeCount;
  const build = (i: number): DeformableCar => {
    const police = isPolice(i);
    const car = new DeformableCar({ body: 0x808080, accent: 0x404040, name: `Car${i}` }, scene, null, police ? "police" : fleetStyle(i));
    assignClass(car, police ? "police" : fleetClass(i));
    return car;
  };
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
  const dress = (car: DeformableCar): void => {
    car.deform.squash = INITIAL_HUD.squash;
    car.deform.buckle = INITIAL_HUD.buckle;
    car.deform.setMode(INITIAL_HUD.deformMode);
    const cls = carClass(car);
    assignClass(car, cls);
    armKill(car.deform, killClass(car), HANDLING.realism, "default");
  };
  const race = new RaceDirector({
    scene,
    camera,
    sun: new THREE.DirectionalLight(),
    seat,
    live,
    setCarCount: (n) => {
      while (cars.length < n) cars.push(build(cars.length));
      count = n;
    },
    setPolice: (from, n) => {
      policeFrom = from;
      policeCount = n;
      for (let i = 1; i < Math.min(cars.length, from + n); i++) if ((cars[i]!.style.id === "police") !== isPolice(i)) cars[i] = build(i);
    },
    dress: (car) => dress(car),
    setPaused: () => {},
    leave: () => {
      w.leaves++;
    },
    hitFx: () => {},
    buildArt: () => null,
    markBounds: () => {},
    bleeds: () => false,
    reelReady: () => {},
    clear: () => {
      w.clears++;
      step.ejection?.reset();
    },
    watchCam: () => {
      w.watchCams++;
    },
  }, survivalCourse);
  const step = newWorld(liveBuf);
  step.ejection = new EjectionWatch();
  step.collide = (car, i) => race.collide(car, i);
  const w: World = { cars, live, race, camera, leaves: 0, seat, onPairContact: null, step, dress, clears: 0, watchCams: 0, ejections: [] };
  step.pairHit = (a, b, hit, first) => {
    race.pairHit(a, b, hit, first);
    if (first) w.onPairContact?.(a, b);
  };
  return w;
}

/** `CrashEngine.fixedStep` in race mode. */
function fixedStep(w: World, dt: number): void {
  w.step.cars = w.live();
  w.race.drive(dt);
  stepWorld(w.step, dt);
  for (const e of w.step.ejection?.take() ?? []) {
    w.ejections.push(e);
    w.race.recorder.eject(e);
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
    settleStep(cars, h, false);
    steps++;
  }
  for (const car of cars) car.updateDeform(FRAME);
  w.race.frame(FRAME);
}

export type Outcome = {
  /** Cars home on the full distance. */
  finished: number;
  /** Cars flagged home a lap or more down after the winner. */
  lapped: number;
  out: number;
  dnf: { name: string; cause: string }[];
  /** Slowest completed lap of any car (s). */
  slowestLap: number;
  winner: number;
  closedAt: number;
  respawns: number;
  /** Each AI rival's rolled aggression, in car order. */
  aggression: number[];
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

const RACE_LAPS = 2;

/**
 * One race of 4 AI rivals (plus the AI-driven player slot) with the aggression slider at `slider`;
 * the field rolls its random picks (each rival's aggression in [0, slider]) with `seed`.
 */
export function raceOnce(w: World, track: Track, bound: number, seed: number, slider: number): Outcome {
  const r = w.race;
  r.command({ type: "quit" });
  r.command({ type: "options", options: { trackId: track.id, laps: RACE_LAPS, aiCount: 4, noReset: false, aggression: slider } });
  // The start command's new field rolls with this seed: the same path a player's race takes.
  r.reseed(seed);
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
  const home = snap.cars.filter((c) => c.status === "finished");
  const full = home.filter((c) => c.lap >= RACE_LAPS);
  const laps = snap.cars.flatMap((c) => c.lapTimes);
  return {
    finished: full.length,
    lapped: home.length - full.length,
    out: snap.cars.filter((c) => c.status === "out").length,
    dnf: snap.cars.filter((c) => c.status !== "finished" && c.status !== "out").map((c) => ({ name: c.name, cause: dnfCause(w, track, c) })),
    slowestLap: laps.length ? Math.max(...laps) : NaN,
    winner: full.length ? Math.min(...full.map((c) => c.finishTime!)) : NaN,
    closedAt: snap.phase === "finished" ? snap.time : NaN,
    respawns: snap.cars.reduce((n, c) => n + c.deaths, 0),
    aggression: r.racers.filter((e) => e.kind === "ai").map((e) => e.aggression),
  };
}

/**
 * The real-stack finish sweep for one course: 4 AI rivals and the AI-driven player slot, 2 laps.
 * Run k races with field seed k, the game's own random picks: each rival's aggression rolled under
 * the slider. (Grid order, classes and body styles are fixed by car index in a single race, so the
 * seed is all that varies.) By default 2 seeds at the default slider; `RACE_FINISH_RUNS=n` runs n
 * seeds at the default slider and n more with the slider at 1, a ramming field.
 */
export function finishSweep(course: string): void {
  const full = process.env.RACE_FINISH_RUNS !== undefined;
  const runs = Number(process.env.RACE_FINISH_RUNS ?? 2);
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`RACE_FINISH_RUNS must be a whole number ≥ 1, got "${process.env.RACE_FINISH_RUNS}"`);
  const sliders = full ? [DEFAULT_RACE_OPTIONS.aggression, 1] : [DEFAULT_RACE_OPTIONS.aggression];
  describe("race finish through the real stack", () => {
    for (const slider of sliders) {
      it(`${course}, aggression slider ${slider}: ≥ 4 of 5 AI cars finish ${RACE_LAPS} laps or retire, in each of ${runs} seeded races`, (t) => {
        const track = new Track(TRACKS.find((j) => parseTrack(j).id === course));
        // Reference lap: the course at half the sedan's top speed (9 m/s), the basis of the AI course
        // test too. Bound: the grid and countdown, then the laps at 3 × the reference lap.
        const refLap = track.length / 9;
        const bound = 4.5 + RACE_LAPS * 3 * refLap;
        const w = makeWorld();
        w.race.enter();
        try {
          for (let run = 1; run <= runs; run++) {
            const o = raceOnce(w, track, bound, run, slider);
            const dnf = o.dnf.map((d) => `${d.name}: ${d.cause}`).join("; ");
            t.diagnostic(
              `${course} slider ${slider} seed ${run} (aggression ${o.aggression.map((a) => a.toFixed(2)).join("/")}): finished ${o.finished}/5, lapped ${o.lapped}, out ${o.out}, DNF ${o.dnf.length}${dnf ? ` [${dnf}]` : ""}, respawns ${o.respawns}, winner ${o.winner.toFixed(1)} s, slowest lap ${o.slowestLap.toFixed(1)} s (ref ${refLap.toFixed(1)} s), closed ${o.closedAt.toFixed(1)} s (bound ${bound.toFixed(0)} s)`,
            );
            assert.ok(Number.isFinite(o.closedAt), `${course} slider ${slider} seed ${run}: no results within ${bound.toFixed(0)} s`);
            assert.ok(o.finished + o.out >= 4, `${course} slider ${slider} seed ${run}: ${o.finished} finished, ${o.lapped} lapped, ${o.out} out; DNF ${dnf}`);
          }
        } finally {
          w.race.exit();
          setGround(null);
        }
      });
    }
  });
}

/** How the scripted player drives: a line on the main loop, a detour driven once a lap, a respawn press. */
export type PlayerLine = {
  /** Lateral offset (m, + = left of travel) from the centreline on the main loop. */
  lat: number;
  /** Driven instead of the loop once a lap, from `fromS` (m along the loop) through `pts`. */
  detour?: { fromS: number; pts: readonly (readonly [number, number])[] };
  /** Race time (s) the driver presses respawn, once. */
  respawnAt?: number;
};

export type PlayerOutcome = {
  you: RaceResultRow;
  ai: RaceResultRow[];
  /** Samples where the HUD's lap or place differed from the rules' own count. */
  hudLapMismatch: number;
  hudPlaceMismatch: number;
  samples: number;
};

/** The scripted player's top speed (m/s) on a detour: faster, it missed the grass line's tight bottom and wall-pinned. */
const DETOUR_SPEED = 15;

/**
 * One race with the PLAYER slot driven through the real seat (analog wheel and gas → `shapeDrive`
 * → `applyDrive`), as a pad would, along `line`. Every 30 frames the HUD's lap and place are
 * checked against a rules snapshot.
 */
export function playerRace(w: World, track: Track, line: PlayerLine, laps: number, aiCount: number, bound: number): PlayerOutcome {
  const r = w.race;
  r.command({ type: "quit" });
  r.command({ type: "options", options: { trackId: track.id, laps, aiCount, noReset: false } });
  r.command({ type: "start" });
  const seat = w.seat;
  const car = w.cars[0]!;
  const proj = blankProjection();
  const pt = blankPoint();
  const state = { acc: 0 };
  let detourK = -1;
  let detourLap = -1;
  let pressed = false;
  /** Seconds the player has sat under 0.5 m/s while racing (nose-in on a wall it can't reverse off). */
  let stuckFor = 0;
  const out = { hudLapMismatch: 0, hudPlaceMismatch: 0, samples: 0 };
  for (let n = 0; n * FRAME < bound; n++) {
    const h = r.hud();
    if (h.phase === "finished") break;
    const x = car.group.position.x;
    const z = car.group.position.z;
    let tx: number;
    let tz: number;
    const p = track.project(x, z, -1, proj);
    const d = line.detour;
    if (d && detourK < 0 && h.you && detourLap !== h.you.lap && p.s > d.fromS && p.s < d.fromS + 25) {
      detourK = 0;
      detourLap = h.you.lap;
    }
    if (d && detourK >= 0 && Math.hypot(d.pts[detourK]![0] - x, d.pts[detourK]![1] - z) < 8) detourK = detourK + 1 < d.pts.length ? detourK + 1 : -1;
    if (d && detourK >= 0) {
      tx = d.pts[detourK]![0];
      tz = d.pts[detourK]![1];
    } else {
      track.pointAt(p.s + 14, pt);
      tx = pt.x + pt.tz * line.lat;
      tz = pt.z - pt.tx * line.lat;
    }
    let a = Math.atan2(tx - x, tz - z) - Math.atan2(car.fwdFlat.x, car.fwdFlat.z);
    a -= Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
    const racing = h.phase === "racing";
    seat.mode = "drive";
    seat.carIndex = 0;
    seat.intent.analogWheel = true;
    seat.intent.analogGas = true;
    seat.intent.wheel = racing ? Math.max(-1, Math.min(1, a * 3)) : 0;
    // Flat out on the loop; a detour (off the road, points 8 m apart) at `DETOUR_SPEED`, braking for it
    // from 40 m before as a pad player would: flat out at 200 km/h it overshot the first point by 20 m
    // onto the service road's gates, or wall-pinned and respawned until DNF.
    const slow = !!d && (detourK >= 0 || (detourLap !== h.you?.lap && p.s > d.fromS - 40 && p.s <= d.fromS)) && car.velocity.length() > DETOUR_SPEED;
    seat.intent.gas = racing && !slow ? 1 : 0;
    seat.intent.brake = racing && slow ? 1 : 0;
    if (racing && line.respawnAt !== undefined && !pressed && h.time >= line.respawnAt) {
      r.requestRespawn();
      pressed = true;
    }
    // A player stuck after a racing incident presses respawn, as a real one would (the script never reverses).
    stuckFor = racing && h.you?.status === "racing" && car.velocity.length() < 0.5 ? stuckFor + FRAME : 0;
    if (stuckFor >= 3) {
      r.requestRespawn();
      stuckFor = 0;
    }
    frame(w, state);
    if (n % 30 === 29) {
      const snap = r.snapshot()!;
      const me = snap.cars.find((c) => c.id === 0)!;
      const hud = r.hud().you!;
      out.samples++;
      if (hud.lap !== Math.min(snap.laps, me.lap + 1)) out.hudLapMismatch++;
      if (hud.place !== me.place || snap.order[me.place - 1] !== 0) out.hudPlaceMismatch++;
    }
  }
  // Null when the race never closed within `bound`: the live classification stands in.
  const res = r.hud().results ?? r.snapshot()!.cars.map((c) => ({ id: c.id, name: c.name, kind: c.kind, place: c.place, status: c.status, time: c.finishTime, gap: null, bestLap: c.bestLap, laps: c.lap, busted: c.bustedAt != null }));
  return { you: res.find((x) => x.id === 0)!, ai: res.filter((x) => x.id !== 0), ...out };
}
