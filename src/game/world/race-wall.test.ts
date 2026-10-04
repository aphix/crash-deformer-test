import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { FRAME, frame, makeWorld, type World } from "./race-world.test-util.ts";
import { Track, blankProjection } from "./track.ts";
import { TRACKS } from "./tracks/index.ts";
import { parseTrack } from "./track-schema.ts";

/**
 * Owner-facing symptom (TurnSmooth, 10-04): on the city course a car "jumps along the road". The course wall pushed a car up to
 * 3 m in ONE physics step at the back alley's exit: a car arriving beyond the wall line from another road (the alley, 13 m
 * from the loop's centreline) had its footprint probes read as 2.9 m of penetration, undone in full. A car coming from the road
 * side only ever penetrates by a step of travel, so any bigger pose change is not a wall push, it is a teleport.
 */
const SLACK = 0.15;
/** Most a wall may move a car in one step: what the step's travel explains (twice, for the bounce), never under `SLACK`. */
const bound = (speed: number, h: number): number => Math.max(SLACK, 2 * speed * h);

function raceWorld(course: string, aiCount: number): World {
  const w = makeWorld();
  w.race.enter();
  w.race.command({ type: "quit" });
  w.race.command({ type: "options", options: { trackId: course, laps: 3, aiCount, noReset: false } });
  w.race.reseed(1);
  w.race.command({ type: "start" });
  w.seat.mode = "follow";
  return w;
}

/**
 * The back alley's last 12 m before the loop's wall line, as the measured trace drove it (x 167, z 26 at yaw 2.48): 13 m from
 * the loop's centreline, probes 2.9 m beyond the line where the wall's flag is still set (it opens at node 21, z 26).
 */
const ALLEY = { x: 159.55, z: 35.7, yaw: 2.48 };

type Push = { t: number; car: number; moved: number; allowed: number };

/** Runs `secs` of sim from the `start` command and returns every collide-step pose change beyond what its travel explains. */
function overPushes(w: World, secs: number): Push[] {
  const out: Push[] = [];
  const state = { acc: 0 };
  let t = 0;
  let h = 0;
  const hit = w.step.collide!;
  w.step.collide = (car, i) => {
    const x = car.group.position.x;
    const z = car.group.position.z;
    const speed = Math.hypot(car.velocity.x, car.velocity.z);
    hit(car, i);
    const moved = Math.hypot(car.group.position.x - x, car.group.position.z - z);
    const allowed = bound(speed, h);
    if (moved > allowed) out.push({ t, car: i, moved, allowed });
  };
  for (let n = 0; n < secs / FRAME; n++) {
    frame(w, state, (step) => {
      h = step;
      t += step;
    });
  }
  return out;
}

const fmt = (pushes: Push[]): string =>
  pushes
    .slice(0, 6)
    .map((p) => `t=${p.t.toFixed(1)} car ${p.car} moved ${p.moved.toFixed(3)} m (allowed ${p.allowed.toFixed(3)})`)
    .join("; ");

describe("course wall: a push is a step of travel, never a teleport", () => {
  // The city's wall pushed car 4 by 3.0 m at 23.6 s of this race (5 AI cars, seed 1), 17 more over 120 s.
  it("city, 5 cars through the real stack for 40 s: no car is moved further than its step's travel explains", () => {
    const w = raceWorld("city", 4);
    try {
      const pushes = overPushes(w, 40);
      assert.deepEqual(pushes, [], fmt(pushes));
    } finally {
      w.race.exit();
      setGround(null);
    }
  });

  it("a car driving the back alley to its exit at 29 m/s is not thrown across the loop's wall line", () => {
    const w = raceWorld("city", 0);
    try {
      const car = w.cars[0]!;
      // Racing (the countdown holds the cars), then straight down the alley with the throttle held.
      w.seat.mode = "drive";
      w.seat.carIndex = 0;
      w.seat.intent.analogGas = true;
      w.seat.intent.gas = 1;
      const state = { acc: 0 };
      for (let n = 0; w.race.phase !== "racing" && n < 60 * 30; n++) frame(w, state);
      assert.equal(w.race.phase, "racing");
      car.spawnFacing(ALLEY.x, ALLEY.z, ALLEY.yaw, 29);
      const pushes = overPushes(w, 2.5);
      assert.deepEqual(pushes, [], fmt(pushes));
    } finally {
      w.race.exit();
      setGround(null);
    }
  });

  // Measured: 0.82 m at 28 m/s (city, 54 s) and 0.18 m (rally) where a wall starts under a car whose footprint is already past the line.
  it("a wall that starts under a car drifting past the line in an open mouth moves it no more than its step", () => {
    const w = raceWorld("city", 0);
    try {
      const track = new Track(TRACKS.find((j) => parseTrack(j).id === "city"));
      const p = track.path;
      let k = 1;
      while (!(!p.wallL[k - 1] && p.wallL[k] && p.wallL[k + 12] && p.wallL[k + 2])) k++;
      const limit = p.half[k]! + p.runL[k]!;
      // Seven samples before the wall starts, the footprint 0.7 m past the line (the car's flank is 0.95 m off its middle).
      const j = k - 7;
      const lat = limit - 0.25;
      const car = w.cars[0]!;
      w.seat.mode = "drive";
      w.seat.carIndex = 0;
      w.seat.intent.analogGas = true;
      w.seat.intent.gas = 1;
      const state = { acc: 0 };
      for (let n = 0; w.race.phase !== "racing" && n < 60 * 30; n++) frame(w, state);
      car.spawnFacing(p.x[j]! + p.tz[j]! * lat, p.z[j]! - p.tx[j]! * lat, Math.atan2(p.tx[j]!, p.tz[j]!), 20);
      const pushes = overPushes(w, 1);
      assert.deepEqual(pushes, [], fmt(pushes));
    } finally {
      w.race.exit();
      setGround(null);
    }
  });

  it("a car shoved through the wall from the road side in one step is still returned to the road", () => {
    const w = raceWorld("city", 0);
    try {
      const track = new Track(TRACKS.find((j) => parseTrack(j).id === "city"));
      const p = track.path;
      // A stretch of the loop walled on the left for 10 samples either side.
      let k = 20;
      while (!Array.from({ length: 21 }, (_, d) => p.wallL[(k + d - 10 + p.count) % p.count]).every(Boolean)) k++;
      const limit = p.half[k]! + p.runL[k]!;
      const lat = (at: number) => track.project(w.cars[0]!.group.position.x, w.cars[0]!.group.position.z, k, blankProjection()).lateral - at;
      const car = w.cars[0]!;
      car.spawnFacing(p.x[k]! + p.tz[k]! * (limit - 2), p.z[k]! - p.tx[k]! * (limit - 2), Math.atan2(p.tx[k]!, p.tz[k]!), 0);
      w.race.courseHit(car, 0);
      assert.ok(Math.abs(lat(limit - 2)) < 0.05, "on the road side, the wall leaves the car alone");
      // A car-car shove: 3.5 m toward the wall in one step, the footprint 1.5-2.4 m past the line.
      car.group.position.x += p.tz[k]! * 3.5;
      car.group.position.z -= p.tx[k]! * 3.5;
      w.race.courseHit(car, 0);
      const back = lat(0);
      assert.ok(back < limit - 0.9 && back > limit - 3, `returned to ${back.toFixed(2)} m, the wall line at ${limit.toFixed(2)} m`);
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});
