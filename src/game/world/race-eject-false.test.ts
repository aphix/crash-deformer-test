import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type * as THREE from "three";
import { setGround } from "./ground.ts";
import { COURSE_IDS, FRAME, frame, makeWorld, playerRace, type PlayerLine, type World } from "./race-world.test-util.ts";
import { Track } from "./track.ts";
import { parseTrack } from "./track-schema.ts";
import { TRACKS } from "./tracks/index.ts";
import { DeformableCar } from "../vehicle/car.ts";

/**
 * Owner, 2026-10-03: "drivers are now getting thrown out of their cars when going on that same slope [the stunt
 * course's CRUSH crest] and also on banked turns, far more than would be expected". The whole race stack headless,
 * every contact on every car logged: a driver thrown out, or an engine killed, must follow a real hit on that car.
 */

/** Contacts this recent (s) before a kill or a throw explain it: the watch's lookback is 0.35 s, and a frame is 1/60. */
const RECENT = 0.5;
/** The smallest closing speed (m/s) a contact counts as a hit at: the crush model clamps every hit's impulse to 4..70. */
const MIN_HIT = 4;

type Event = { car: number; t: number; what: string };

/** Every kill or throw in a race with no hit (`MIN_HIT` m/s or more) on that car in the `RECENT` s before it. */
function unexplained(w: World, go: () => void): string[] {
  const hits: { car: number; t: number }[] = [];
  const events: Event[] = [];
  const apply = DeformableCar.prototype.applyImpact;
  DeformableCar.prototype.applyImpact = function (this: DeformableCar, point: THREE.Vector3, inward: THREE.Vector3, impulse: number, ebs: number): void {
    if (impulse >= MIN_HIT) hits.push({ car: w.cars.indexOf(this), t: w.race.time });
    apply.call(this, point, inward, impulse, ebs);
  };
  const watch = w.step.ejection;
  assert.ok(watch, "the race stack runs the ejection watch");
  const take = watch.take.bind(watch);
  watch.take = () => {
    const out = take();
    for (const e of out) events.push({ car: e.car, t: w.race.time, what: `thrown out of the ${e.exit}` });
    return out;
  };
  // The engines, once per rendered frame: a drivetrain alive last frame and dead now.
  const was: boolean[] = [];
  const frameOf = w.race.frame.bind(w.race);
  w.race.frame = (dt: number) => {
    frameOf(dt);
    for (let i = 0; i < w.cars.length; i++) {
      const alive = w.cars[i]!.deform.drivetrainAlive;
      if (was[i] === true && !alive) events.push({ car: i, t: w.race.time, what: "engine killed" });
      was[i] = alive;
    }
  };
  try {
    go();
  } finally {
    DeformableCar.prototype.applyImpact = apply;
    watch.take = take;
    w.race.frame = frameOf;
  }
  return events
    .filter((e) => !hits.some((h) => h.car === e.car && e.t - h.t <= RECENT && e.t >= h.t))
    .map((e) => `car ${e.car} at ${e.t.toFixed(1)} s: ${e.what} with no hit in the last ${RECENT} s`);
}

describe("given a race on the ground of a course (slopes, crests, banked turns), with every contact on every car logged", () => {
  afterEach(() => setGround(null));

  /** Six cars (the AI-driven player slot and five rivals) at the default aggression, 3 laps. */
  function aiRace(course: string, seed: number): string[] {
    const track = new Track(TRACKS.find((t) => parseTrack(t).id === course));
    const w = makeWorld();
    w.race.enter();
    try {
      w.race.command({ type: "quit" });
      w.race.command({ type: "options", options: { trackId: course, laps: 3, aiCount: 5, noReset: false, aggression: 0.35 } });
      w.race.reseed(seed);
      w.race.command({ type: "start" });
      w.seat.mode = "follow";
      const state = { acc: 0 };
      const bound = 4.5 + 3 * 3 * (track.length / 9);
      return unexplained(w, () => {
        for (let n = 0; w.race.phase !== "finished" && n * FRAME < bound; n++) frame(w, state);
        assert.equal(w.race.phase, "finished", `${course} seed ${seed}: the race never finished`);
      });
    } finally {
      w.race.exit();
    }
  }

  for (const course of COURSE_IDS.filter((id) => id !== "city")) {
    for (const seed of course === "stunt" ? [1, 2, 3, 4] : [1, 2]) {
      it(`when 6 AI-driven cars race 3 laps of ${course} with field seed ${seed}, then every engine kill and driver throw follows a hit of at least ${MIN_HIT} m/s on that car in the previous ${RECENT} s`, () => {
        assert.deepEqual(aiRace(course, seed), []);
      });
    }
  }

  /** The scripted player (the real seat, full gas) on a lateral line beside five AI rivals: the lines where it meets a wall and drives on damaged. */
  function playerLap(course: string, line: PlayerLine, laps: number): string[] {
    const track = new Track(TRACKS.find((t) => parseTrack(t).id === course));
    const w = makeWorld();
    w.race.enter();
    try {
      return unexplained(w, () => {
        playerRace(w, track, line, laps, 5, 4.5 + laps * 3 * (track.length / 9));
      });
    } finally {
      w.race.exit();
    }
  }

  const playerLineCases = [
    { it: "when the scripted player drives the stunt course's apron line for 2 laps (a wall hit, then the CRUSH crest), then every engine kill and driver throw follows a hit", course: "stunt", line: { lat: 10.5 }, laps: 2 },
    { it: "when the scripted player drives the rally course's apron line for 1 lap (the climbs and the hairpin's bank), then every engine kill and driver throw follows a hit", course: "rally", line: { lat: 10.5 }, laps: 1 },
    { it: "when the scripted player drives the rally course's inside line for 2 laps, then every engine kill and driver throw follows a hit", course: "rally", line: { lat: -4 }, laps: 2 },
  ] as const;
  for (const testCase of playerLineCases) {
    it(testCase.it, () => {
      assert.deepEqual(playerLap(testCase.course, testCase.line, testCase.laps), []);
    });
  }
});
