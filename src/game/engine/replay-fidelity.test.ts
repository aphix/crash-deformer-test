import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../world/ground.ts";
import { makeWorld, type World } from "../world/race-world.test-util.ts";
import { blankPoint, Track } from "../world/track.ts";
import oval from "../world/tracks/oval.json" with { type: "json" };
import { clipBytes } from "../net/reel-codec.ts";
import { agreement, recordFlat, recordRace, type Agreement, type Recording, type Spawn } from "./replay-fidelity.test-util.ts";

/**
 * The owner wants a replay or a highlight reel to show the crash as it happened. The recorder's clip (keyframes to the
 * first impact, then the recorded pedals) is re-run by `ClipSim`; over the hit window, from the step after the first
 * impact to HIT_S after it, it is held to the sim that recorded it. Before REPLAY_VERSION 7 a head-on at 2 x 20 m/s
 * replayed 8.7 m/s and 0.8 m off the live cars (p95) with 2.4 m of crush too little: the keyframe at the first impact
 * left out the hit's own direction (`impactInward`), so the replayed wreck took its first step against the wrong end.
 * REPLAY_VERSION 8 keyframes carry every solver word the wreck steps on (clusters' rotations, scalars, sensors), the
 * car's pose whole, and the pedals' last digits, so a clip with one impact replays within a hundredth of a millimetre.
 *
 * Each bound below is the measured error (p95 and worst: position in m, velocity in m/s, total crush in m) with a margin
 * of about 2x, per crash. What is left in a derby pile-up is the live sim's own sensitivity: two cars that meet a second
 * and a half after the first impact are pushed on the replay's own state (a keyframe anchors only the first), and a
 * 1e-8 m difference there becomes 0.02 m/s at the contact, so its bounds are decimetres, and the car that crosses the
 * pile two seconds on reaches it one step (17 ms) before the live car did.
 */
const HIT_S = 0.6;
type Bound = { p95: [pose: number, vel: number, crush: number]; max: [pose: number, vel: number, crush: number]; wreck: number };
const BOUND: Record<string, Bound> = {
  "race head-on": { p95: [3e-5, 1e-4, 8e-5], max: [5e-5, 1e-4, 1.2e-4], wreck: 0 },
  "race offset": { p95: [3e-5, 1e-4, 1e-4], max: [5e-5, 1e-4, 1e-4], wreck: 0 },
  "race T-bone": { p95: [0.0015, 0.015, 0.0003], max: [0.003, 0.02, 0.0003], wreck: 0 },
  "race pile-up": { p95: [5e-5, 1e-4, 5e-5], max: [8e-5, 1e-4, 8e-5], wreck: 0 },
  "derby head-on": { p95: [3e-5, 1e-3, 2e-4], max: [3e-5, 1e-3, 2e-4], wreck: 0 },
  "derby offset": { p95: [1e-5, 1e-4, 5e-5], max: [1e-5, 1e-4, 5e-5], wreck: 0 },
  "derby T-bone": { p95: [8e-5, 5e-4, 5e-4], max: [1e-4, 1e-3, 5e-4], wreck: 0 },
  "derby pile-up": { p95: [0.04, 0.6, 0.08], max: [0.18, 9, 0.8], wreck: 1 },
};

const rows: string[] = [];
const mm = (m: number): string => (m * 1000).toFixed(3);
function check(name: string, rec: Recording, a: Agreement): void {
  rows.push(
    `${name}: ${rec.clip.cars.length} cars ${a.steps} steps ${(clipBytes(rec.clip) / 1024).toFixed(0)} KB; impact step ${mm(a.impact.pose)} mm ${a.impact.vel.toFixed(4)} m/s; ` +
      `p95/max pose ${mm(a.pose.p95)}/${mm(a.pose.max)} mm, vel ${a.vel.p95.toFixed(4)}/${a.vel.max.toFixed(4)} m/s, crush ${mm(a.crush.p95)}/${mm(a.crush.max)} mm, wreck flags differ ${a.wreckMismatch}`,
  );
  assert.ok(a.steps >= 30, `${name}: ${a.steps} steps in the hit window`);
  const b = BOUND[name]!;
  assert.ok(a.wreckMismatch <= b.wreck, `${name}: a car is a wreck in one run and not in the other for ${a.wreckMismatch} car-steps (> ${b.wreck})`);
  assert.ok(a.impact.pose <= 0.0005 && a.impact.vel <= 0.003, `${name}: the first impact's own step is ${mm(a.impact.pose)} mm and ${a.impact.vel} m/s off (keyframes carry the exact pose and velocity)`);
  for (const k of ["p95", "max"] as const) {
    const got = [a.pose[k], a.vel[k], a.crush[k]];
    got.forEach((g, i) => assert.ok(g <= b[k][i]!, `${name}: ${k} ${["pose", "vel", "crush"][i]} error ${g} > ${b[k][i]}\n${rows.at(-1)}`));
  }
}

describe("a clip replays the crash as the sim that recorded it ran it", () => {
  describe("in a race (oval, 3 AI)", () => {
    const track = new Track(oval);
    const pt = blankPoint();
    const w: World = makeWorld();
    before(() => {
      w.race.enter();
    });
    after(() => {
      w.race.exit();
      setGround(null);
    });

    /** Car `slot` at track distance `d`, `side` m off the centre line (right positive), heading along the road plus `turn`, at `speed`. */
    function put(slot: number, d: number, side: number, turn: number, speed: number): void {
      track.pointAt(d, pt);
      const yaw = Math.atan2(pt.tx, pt.tz);
      w.cars[slot]!.spawnFacing(pt.x + side * pt.tz, pt.z - side * pt.tx, yaw + turn, speed);
    }
    const run = (name: string, place: () => void): void => {
      const rec = recordRace(w, place, 9);
      check(name, rec, agreement(rec, HIT_S, () => w.race.resetProps()));
    };

    it("bad: a head-on at 2 x 20 m/s", () => run("race head-on", () => (put(0, 40, 0, 0, 20), put(1, 48, 0, Math.PI, 20))));
    it("bad: an offset head-on, a metre off centre", () => run("race offset", () => (put(0, 40, 0.5, 0, 20), put(1, 48, -0.5, Math.PI, 20))));
    it("bad: a T-bone, a car driven into another's side", () => run("race T-bone", () => (put(0, 40, 0, 0, 20), put(1, 54, 0, Math.PI / 2, 0))));
    it("bad: a pile-up, two head-on and two more running into the wreck", () =>
      run("race pile-up", () => (put(0, 40, 0, 0, 20), put(1, 48, 0, Math.PI, 20), put(2, 30, 0, 0, 20), put(3, 20, 0, 0, 20))));
  });

  describe("in a derby (flat field, wear kill armed)", () => {
    const HEAD = Math.PI / 2;
    const run = (name: string, spawns: Spawn[]): void => {
      const rec = recordFlat(spawns, 8, true);
      check(name, rec, agreement(rec, HIT_S));
    };

    it("bad: a head-on at 2 x 20 m/s", () =>
      run("derby head-on", [
        { x: 0, z: 0, yaw: HEAD, speed: 20, throttle: 1 },
        { x: 80, z: 0, yaw: -HEAD, speed: 20, throttle: 1 },
      ]));
    it("bad: an offset head-on, a metre off centre", () =>
      run("derby offset", [
        { x: 0, z: 0, yaw: HEAD, speed: 20, throttle: 1 },
        { x: 80, z: 1, yaw: -HEAD, speed: 20, throttle: 1 },
      ]));
    it("bad: a T-bone", () =>
      run("derby T-bone", [
        { x: 0, z: 0, yaw: HEAD, speed: 20, throttle: 1 },
        { x: 40, z: 40, yaw: Math.PI, speed: 20, throttle: 1 },
      ]));
    it("bad: a pile-up, two head-on, one behind, one across", () =>
      run("derby pile-up", [
        { x: 0, z: 0, yaw: HEAD, speed: 20, throttle: 1 },
        { x: 80, z: 0, yaw: -HEAD, speed: 20, throttle: 1 },
        { x: -12, z: 0.5, yaw: HEAD, speed: 20, throttle: 1 },
        { x: 40, z: 60, yaw: Math.PI, speed: 20, throttle: 1 },
      ]));
  });

  it("report", (t) => t.diagnostic(rows.join("\n")));
});
