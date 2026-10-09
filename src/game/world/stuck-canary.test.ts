import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { FRAME, frame, makeWorld } from "./race-world.test-util.ts";
import { chase } from "./survival-players.test-util.ts";
import { runField } from "../ai/derby-field.test-util.ts";
import { DEFAULT_RACE_OPTIONS } from "../match/types.ts";
import { TRACK_ID } from "./constants.ts";
import { parseTrack } from "./track-schema.ts";
import { Track } from "./track.ts";
import { TRACKS } from "./tracks/index.ts";
import type { DeformableCar } from "../vehicle/car.ts";

/**
 * The owner's bar (2026-10-09): a car "goes" (can be driven) rather than sits; being stuck for more than 10–20 s is the un-fun
 * case, whatever it sits against (a wall, a kerb, a prop, another car, its own roof). One pooled canary over the game's own
 * AI-driven fields: no live car whose driver asks for drive moves less than `MOVE` m in any `WINDOW` s, unless it is in a pile
 * (`PILE` or more other cars touching it through the whole window). The pools are the fields a player meets: police races on
 * the campaign's four courses, the Survival pursuit on Havana, and a derby heat. Every pool is read by the same watch, so the
 * three scenarios are judged alike.
 *
 * What the watch reads: the pedals the sim ran (`car.drive.throttle`, which `applyDrive` idles while a car is dead or has no
 * wheel down, plus `car.airThrottle`, the gas winding the wheels of a car in the air or on its roof), the body's position, and
 * the slice's first-pass pair contacts. A placement (`car.placements`: a respawn, a wake, a start) ends the window, so a car the
 * race reset after its stall (`STALL_WINDOW`) is judged from where it was put. A car counts as driven when its mean |throttle|
 * over the window is `DRIVE` or more: a rocking car (forward, reverse, forward) is as stuck as one with its foot down.
 */
const WINDOW = 10;
const MOVE = 0.5;
const DRIVE = 0.5;
const PILE = 2;
/** Samples per window: the window is judged every `SAMPLE` s. */
const SAMPLE = 0.5;
const SAMPLES = WINDOW / SAMPLE;

type Sample = { t: number; x: number; z: number; drive: number; partners: number };

/** One field's cars watched for stuck windows: feed `pair` for every contact and `step` after every physics step. */
class StuckWatch {
  readonly episodes: string[] = [];
  private readonly rings: Sample[][];
  private readonly driveSum: Float64Array;
  private readonly timeSum: Float64Array;
  private readonly partners: Set<number>[];
  private readonly placements: Int32Array;
  private readonly nextSample: Float64Array;
  private readonly label: string;

  constructor(label: string, n: number) {
    this.label = label;
    this.rings = Array.from({ length: n }, () => []);
    this.driveSum = new Float64Array(n);
    this.timeSum = new Float64Array(n);
    this.partners = Array.from({ length: n }, () => new Set<number>());
    this.placements = new Int32Array(n).fill(-1);
    this.nextSample = new Float64Array(n).fill(NaN);
  }

  pair(a: number, b: number): void {
    this.partners[a]?.add(b);
    this.partners[b]?.add(a);
  }

  /** The cars after a step of `dt` s ending at scenario time `t` (s); `alive(i)` says whether car i is a live, driven car of the field. */
  step(cars: readonly DeformableCar[], t: number, dt: number, alive: (i: number) => boolean): void {
    for (let i = 0; i < cars.length && i < this.rings.length; i++) {
      const car = cars[i]!;
      const ring = this.rings[i]!;
      if (!alive(i) || car.placements !== this.placements[i]) {
        this.placements[i] = car.placements;
        this.clear(i, t);
        if (!alive(i)) continue;
      }
      const throttle = Math.max(Math.abs(car.drive.throttle), Math.abs(car.airThrottle));
      this.driveSum[i] += throttle * dt;
      this.timeSum[i] += dt;
      if (t < this.nextSample[i]!) continue;
      ring.push({ t, x: car.group.position.x, z: car.group.position.z, drive: this.driveSum[i]! / this.timeSum[i]!, partners: this.partners[i]!.size });
      this.driveSum[i] = 0;
      this.timeSum[i] = 0;
      this.partners[i]!.clear();
      this.nextSample[i] = t + SAMPLE;
      if (ring.length < SAMPLES) continue;
      const first = ring[0]!;
      let moved = 0;
      let drive = 0;
      let fewest = Infinity;
      for (const s of ring) {
        moved = Math.max(moved, Math.hypot(s.x - first.x, s.z - first.z));
        drive += s.drive / ring.length;
        fewest = Math.min(fewest, s.partners);
      }
      if (drive >= DRIVE && moved < MOVE && fewest < PILE) {
        this.episodes.push(`${this.label}: car ${i} from t=${first.t.toFixed(1)} s at (${first.x.toFixed(1)}, ${first.z.toFixed(1)}) moved ${moved.toFixed(2)} m in ${WINDOW} s with mean throttle ${drive.toFixed(2)}, fewest cars touching ${fewest}`);
        ring.length = 0;
      } else ring.shift();
    }
  }

  private clear(i: number, t: number): void {
    this.rings[i]!.length = 0;
    this.driveSum[i] = 0;
    this.timeSum[i] = 0;
    this.partners[i]!.clear();
    this.nextSample[i] = t + SAMPLE;
  }
}

const RACE_LAPS = 2;
const RACE_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const COURSES = [TRACK_ID.oval, TRACK_ID.rally, TRACK_ID.city, TRACK_ID.stunt];

/** A police race on `course` (the default field with the police on, every slot AI-driven, `RACE_LAPS` laps) watched to the flag. */
function policeRace(course: string, seed: number): string[] {
  const track = new Track(TRACKS.find((j) => parseTrack(j).id === course));
  // The grid and countdown, then the laps at 3 × the reference lap (the course at half the sedan's top speed), as the finish sweep bounds a race.
  const bound = 4.5 + RACE_LAPS * 3 * (track.length / 9);
  const w = makeWorld();
  w.race.enter();
  try {
    w.race.command({ type: "quit" });
    w.race.command({ type: "options", options: { ...DEFAULT_RACE_OPTIONS, trackId: course, laps: RACE_LAPS, police: true } });
    w.race.reseed(seed);
    w.race.command({ type: "start" });
    w.seat.mode = "follow";
    const watch = new StuckWatch(`${course} police race, seed ${seed}`, w.live().length);
    const hit = w.step.pairHit!;
    w.step.pairHit = (a, b, contact, first) => {
      hit(a, b, contact, first);
      watch.pair(a, b);
    };
    const state = { acc: 0 };
    let raced = 0;
    for (let n = 0; n * FRAME < bound && w.race.phase !== "finished"; n++) {
      frame(w, state);
      if (w.race.phase !== "racing") continue;
      raced += FRAME;
      const cars = w.live();
      watch.step(cars, raced, FRAME, (i) => cars[i]!.group.visible && cars[i]!.deform.drivetrainAlive);
    }
    return watch.episodes;
  } finally {
    w.race.exit();
    setGround(null);
  }
}

const SURVIVAL_T = 120;
const SURVIVAL_SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);

/** The Survival pursuit on Havana with the evading player, the real pack and rules, for `SURVIVAL_T` s or until the run ends. */
function pursuit(seed: number): string[] {
  const watch = new StuckWatch(`Survival pursuit, seed ${seed}`, 32);
  chase("flee", seed, SURVIVAL_T, undefined, {
    pair: (a, b) => watch.pair(a, b),
    each: (w, time) => {
      if (time <= 0) return;
      const cars = w.live();
      watch.step(cars, time, FRAME, (i) => cars[i]!.group.visible && cars[i]!.deform.drivetrainAlive);
    },
  });
  return watch.episodes;
}

const DERBY_CARS = 9;
const DERBY_SEEDS = [1];

/** A derby heat of `DERBY_CARS` AI cars to its end. */
function derby(seed: number): string[] {
  const watch = new StuckWatch(`${DERBY_CARS}-car derby, seed ${seed}`, DERBY_CARS);
  runField(DERBY_CARS, seed, undefined, {
    pair: (a, b) => watch.pair(a, b),
    step: (cars, t, h, running) => {
      if (t >= 0) watch.step(cars, t, h, running);
    },
  });
  return watch.episodes;
}

describe(`given the game's own AI-driven fields (police races on the campaign's courses, the Survival pursuit, a derby heat), watched for a live car that asks for drive (mean |throttle| ≥ ${DRIVE}) yet moves under ${MOVE} m in ${WINDOW} s while fewer than ${PILE} other cars touch it`, () => {
  /**
   * Measured on main 9b188a4d (Stage 1 landed): city seed 3, car 11 from race second 57.4 at (178.5, −52.0) moved 0.20 m in 10 s at mean
   * throttle 0.79 with one car touching. Measured on lane/uc2-solids (Stage 2, walls and props on the one top/side query): city seeds 1-8
   * 0 stuck windows, and every other course, the pursuit and the derby 0 as well.
   */
  for (const course of COURSES) {
    const title = `when the default field races ${course} with the police on, ${RACE_LAPS} laps, field seeds ${RACE_SEEDS[0]}-${RACE_SEEDS[RACE_SEEDS.length - 1]}, then no car is stuck`;
    it(title, (t) => {
      const stuck = RACE_SEEDS.flatMap((seed) => policeRace(course, seed));
      t.diagnostic(`${course}: ${stuck.length} stuck windows${stuck.length ? `\n${stuck.join("\n")}` : ""}`);
      assert.deepEqual(stuck, []);
    });
  }
  it(`when the pack hunts a fleeing player on Havana for ${SURVIVAL_T} s in each of seeds ${SURVIVAL_SEEDS[0]}-${SURVIVAL_SEEDS[SURVIVAL_SEEDS.length - 1]}, then no car is stuck`, (t) => {
    const stuck = SURVIVAL_SEEDS.flatMap((seed) => pursuit(seed));
    t.diagnostic(`Survival: ${stuck.length} stuck windows${stuck.length ? `\n${stuck.join("\n")}` : ""}`);
    assert.deepEqual(stuck, []);
  });
  it(`when ${DERBY_CARS} AI cars run a derby heat to its end with seed ${DERBY_SEEDS[0]}, then no car is stuck`, (t) => {
    const stuck = DERBY_SEEDS.flatMap((seed) => derby(seed));
    t.diagnostic(`derby: ${stuck.length} stuck windows${stuck.length ? `\n${stuck.join("\n")}` : ""}`);
    assert.deepEqual(stuck, []);
  });
});
