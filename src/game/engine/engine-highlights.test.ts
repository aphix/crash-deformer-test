import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { setGround } from "../world/ground.ts";
import { blankPoint, Track } from "../world/track.ts";
import stunt from "../world/tracks/stunt.json" with { type: "json" };
import city from "../world/tracks/city.json" with { type: "json" };
import { frame, makeWorld, type World } from "../world/race-world.test-util.ts";
import { phaseClock } from "../match/phase.ts";
import { carLayout } from "../net/car-pose.ts";
import { packReel, unpackReel } from "../net/reel-codec.ts";
import { clipTimeline, FLIGHT_S, ReelDirector, simAt, type ReelHost } from "./engine-highlights.ts";
import { ClipSim } from "./engine-replay.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import type { Reel } from "../match/highlights.ts";
import { assertSameNumbers } from "../vehicle/test-support.ts";

/** A ramming field on the city course: its first crash comes early in lap 1. */
const FIELD = { trackId: "city", laps: 1, aiCount: 11, noReset: false, aggression: 1 };
const SEED = 5;
/**
 * The seed of the frames test, which needs the field's first clip to open with its focus car driving (a car moving
 * through the slow-mo). Any change to the car sim moves a seed's whole race, so the leftovers test no longer rides a seed:
 * it scripts its own first crash.
 */
const CLEAN_SEED = 8;

describe("given the highlight reel timeline of a 10 s clip whose first impact is at 4 s", () => {
  it("when the clip plays, then it runs at normal speed up to the hit, holds the slow-motion over the hit, then catches up to the clip's last step", () => {
    const tl = clipTimeline(4, 10, []);
    // Slow-mo starts `PRE_IMPACT_LEAD` (0.07 s) before the recorded impact.
    assert.ok(Math.abs(tl.impact - 3.93) <= 1 / 120 + 1e-9, `slow-mo began at wall ${tl.impact.toFixed(3)} s, not at 3.93`);
    assert.ok(Math.abs(simAt(tl, 2) - 2) < 1e-9, "1× before the hit");
    // Three wall seconds into the slow-mo the clip has moved about 0.1 s (0.032×).
    const into = simAt(tl, tl.impact + 3) - simAt(tl, tl.impact);
    assert.ok(into > 0.05 && into < 0.15, `${into.toFixed(3)} clip s in 3 wall s of slow-mo`);
    assert.equal(simAt(tl, tl.wall), 10, "the timeline ends on the clip's last step");
    assert.ok(tl.wall > 16, `the clip played in ${tl.wall.toFixed(1)} wall s: no slow-mo hold`);
  });
});

/** A reel host on a harness world: its slot cars, its course, no FX. */
function hostOf(w: World): ReelHost {
  return {
    carsOf: (clip) => clip.cars.map((c) => w.cars[c.slot]!),
    live: () => w.live(),
    scene: { dress: w.dress, collide: (car, slot, h) => w.race.courseHit(car, slot, h), restore: (slot, mem, at) => w.race.remember(slot, mem, at), knocks: (bits) => w.race.knockTo(bits), bounce: undefined },
    resetProps: () => w.race.resetProps(),
    clear: () => {},
    sight: () => w.race.courseSight()!,
    still: () => w.race.courseSight()!,
    clock: phaseClock(),
    impact: () => {},
    hit: () => {},
    eject: () => {},
    ride: () => false,
  };
}

function race(w: World, field = FIELD, seed = SEED): void {
  w.race.enter();
  w.race.command({ type: "quit" });
  w.race.command({ type: "options", options: field });
  w.race.reseed(seed);
  w.race.command({ type: "start" });
  w.seat.mode = "follow";
}

/** The reel of the first `clips` clips a field records (the first by default): what a host sends and every peer (the host too) replays. */
async function recordedReel(w: World, clips = 1): Promise<Reel> {
  const state = { acc: 0 };
  for (let n = 0; n * (1 / 60) < 120 && w.race.recorder.ledger.kept.length < clips && w.race.phase !== "finished"; n++) frame(w, state);
  w.race.recorder.end();
  const kept = w.race.recorder.ledger.kept;
  assert.ok(kept.length >= 1, "no clip in 120 s");
  const msg = await packReel({ seed: 77, clips: kept.slice(0, clips) }, 0);
  return (await unpackReel(msg, carLayout(w.cars[0]!))).reel;
}

describe("given two peers each playing the same recorded highlight reel on their own cars", () => {
  it("when one peer draws at 60 Hz and the other at 45 Hz, then at every shared moment both frame the same shot, the camera and focus car really move, and a solo view's first frame does not play the hit early", async () => {
    const a = makeWorld();
    const b = makeWorld();
    try {
      race(a);
      const reel = await recordedReel(a);
      // The second peer has its own cars and its own history: a few frames of the same race.
      race(b);
      for (let n = 0; n < 30; n++) frame(b, { acc: 0 });
      let hits = 0;
      const da = new ReelDirector({ ...hostOf(a), impact: () => hits++ });
      const db = new ReelDirector(hostOf(b));
      // A loaded test box must not stop one peer's catch-up mid-frame (the browser's budget only defers it).
      da.stepBudgetMs = Infinity;
      db.stepBudgetMs = Infinity;
      da.play(reel, 0);
      db.play(reel, 0);
      const ca = new THREE.PerspectiveCamera(50, 1.6, 0.1, 900);
      const cb = new THREE.PerspectiveCamera(50, 1.6, 0.1, 900);
      // Peer a draws at 60 Hz, peer b at 45 Hz; both draw every 1/15 s, where they are compared.
      const end = FLIGHT_S + da["clips"][0]!.tl.wall;
      let worst = 0;
      let compared = 0;
      // How far the camera and the focus car travel: a reel that never moved would compare equal for nothing.
      let flown = 0;
      const prev = new THREE.Vector3();
      const kinds = new Set<string>();
      for (let k = 1; k / 15 < end; k++) {
        for (let i = 1; i <= 4; i++) da.frame(i === 4 ? k / 15 : (4 * (k - 1) + i) / 60);
        for (let j = 1; j <= 3; j++) db.frame(j === 3 ? k / 15 : (3 * (k - 1) + j) / 45);
        da.camera(ca);
        db.camera(cb);
        if (k > 1) flown += ca.position.distanceTo(prev);
        prev.copy(ca.position);
        kinds.add(da.focus() ? "clip" : "flight");
        worst = Math.max(worst, ca.position.distanceTo(cb.position), ca.quaternion.angleTo(cb.quaternion));
        compared++;
      }
      assert.ok(compared > 200, `${compared} moments compared`);
      assert.ok(flown > 50 && kinds.size === 2, `the camera moved ${flown.toFixed(0)} m over ${[...kinds].join(", ")}`);
      assert.ok(worst < 1e-6, `the peers' cameras differ by ${worst.toExponential(2)} (m or rad) at the same moment`);
      // Watch: the first frame's timestamp precedes the click (rAF time is the frame's start): the clip starts at 0,
      // it does not play its hit (crash cam, flash) before the car reaches it.
      hits = 0;
      da.view(0, 100);
      da.frame(100 - 0.004);
      da.frame(100 + 0.012);
      assert.equal(hits, 0, "a solo view's first frame played the clip's hit");
    } finally {
      a.race.exit();
      b.race.exit();
      setGround(null);
    }
  });
});

describe("given a city race whose first crash is two cars put head-on a second in, and torn parts left on every car", () => {
  it("when a highlight reel plays and ends, then each clip's setup empties the scene (torn parts on hidden cars included), the reel ending empties what the clips left, and stopping with no reel up clears nothing", async () => {
    const a = makeWorld();
    try {
      // A deliberate first crash on intact cars (no seed's natural field guarantees one: slow bumps tear parts that no longer make a clip):
      // cars 2-3 are put head-on at 2 × 20 m/s a second into the race, as the stunt test below does.
      race(a, FIELD, SEED);
      const track = new Track(city);
      const pt = blankPoint();
      const state = { acc: 0 };
      for (let n = 0; a.race.time < 1 && n < 900; n++) frame(a, state);
      track.pointAt(150, pt);
      a.cars[2]!.spawnFacing(pt.x, pt.z, Math.atan2(pt.tx, pt.tz), 20);
      track.pointAt(158, pt);
      a.cars[3]!.spawnFacing(pt.x, pt.z, Math.atan2(pt.tx, pt.tz) + Math.PI, 20);
      const reel = await recordedReel(a);
      const torn = (): number => a.cars.reduce((n, c) => n + c["parts"].filter((p) => p.detached).length, 0);
      // Precondition of the seed, not the rule: the first clip itself restores no torn part, so what a setup leaves is the race's.
      const opening = new ReelDirector({
        ...hostOf(a),
        clear: () => {
          for (const c of a.cars) c.resetVisual();
        },
      });
      opening.stepBudgetMs = Infinity;
      opening.play(reel, 0);
      opening.frame(FLIGHT_S / 2);
      assert.equal(torn(), 0, `the scripted head-on lost its precondition: its first clip opens on ${torn()} torn parts of an earlier pile-up`);
      opening.stop();
      for (const c of a.cars) c["detachPart"](c["parts"].find((p) => p.region)!, 12);
      assert.ok(torn() >= a.cars.length, `${torn()} torn parts over ${a.cars.length} cars`);
      let clears = 0;
      const d = new ReelDirector({
        ...hostOf(a),
        clear: () => {
          clears++;
          for (const c of a.cars) c.resetVisual();
        },
      });
      d.stepBudgetMs = Infinity;
      d.stop();
      assert.equal(clears, 0, "stop with no reel up");
      d.play(reel, 0);
      d.frame(FLIGHT_S / 2);
      assert.equal(clears, 1, "the first clip sets up as the flight to it begins");
      assert.equal(torn(), 0, "no torn part of the race is left, in view or hidden");
      d.frame(FLIGHT_S + 0.1);
      assert.equal(clears, 1, "the clip's own frames clear nothing more");
      d.stop();
      assert.equal(clears, 2, "the reel ends");
    } finally {
      a.race.exit();
      setGround(null);
    }
  });
});

/**
 * Every clip car's pose and motion, flat: what the replay's state is. The Euler angles are what the sim reads of a
 * grounded car and the quaternion of an airborne or falling one, so both count.
 */
function stateOf(cars: readonly DeformableCar[]): number[] {
  return cars.flatMap((c) => {
    const { position: p, quaternion: q, rotation: r } = c.group;
    return [p.x, p.y, p.z, q.x, q.y, q.z, q.w, r.x, r.y, r.z, c.velocity.x, c.velocity.y, c.velocity.z];
  });
}

/** The replay itself runs on whole steps only: stepping it with a drawn frame inside every step ends where stepping it alone does. */
function assertDrawingKeepsReplay(w: World, clip: Reel["clips"][number], hz: number): void {
  const cars = clip.cars.map((c) => w.cars[c.slot]!);
  const sim = new ClipSim(clip, cars, hostOf(w).scene);
  w.race.resetProps();
  sim.restart();
  for (let t = 1 / hz; t < sim.length; t += 1 / hz) {
    sim.advanceTo(t);
    sim.present(t - 0.5 / hz);
  }
  sim.advanceTo(Infinity);
  const drawn = stateOf(cars);
  w.race.resetProps();
  sim.restart();
  sim.advanceTo(Infinity);
  assertSameNumbers(stateOf(cars), drawn, `${hz} Hz: the replay's final state with a drawn frame inside every step`);
}

describe("given a recorded highlight clip from a seeded city race that opens with its focus car driving", () => {
  it("when it plays at 60 and at 240 Hz, then the car moving through the slow-motion is drawn moving on every frame, and drawing frames never changes the replay", async () => {
    const a = makeWorld();
    try {
      race(a, FIELD, CLEAN_SEED);
      const reel = await recordedReel(a);
      const clip = reel.clips[0]!;
      for (const hz of [60, 240]) {
        const d = new ReelDirector(hostOf(a));
        d.stepBudgetMs = Infinity;
        d.play(reel, 0);
        const tl = d["clips"][0]!.tl;
        const prev = new THREE.Vector3();
        let frames = 0;
        let still = 0;
        for (let t = FLIGHT_S; t < FLIGHT_S + tl.wall; t += 1 / hz) {
          if (d.frame(t) === null) continue;
          const car = d.focus();
          if (!car) continue;
          // The slow-mo's first three wall seconds (a step is 4 ms of clip time there: 8 frames at 60 Hz).
          const into = t - FLIGHT_S - tl.impact;
          if (into > 0.3 && into < 3.3 && Math.hypot(car.velocity.x, car.velocity.z) > 1) {
            frames++;
            if (car.group.position.equals(prev)) still++;
          }
          prev.copy(car.group.position);
        }
        assert.ok(frames > 100, `${hz} Hz: ${frames} moving frames in the slow-mo`);
        assert.ok(still <= frames * 0.02, `${hz} Hz: ${still} of ${frames} frames drew the car where the last frame had it, though it moves`);
      }
      assertDrawingKeepsReplay(a, clip, 240);
    } finally {
      a.race.exit();
      setGround(null);
    }
  });
});

describe("given the stunt course with three head-on pairs wrecked on purpose a second into a two-lap race", () => {
  it("when each clip is replayed at 60 and 240 Hz, then drawing frames never changes the replay, even of airborne clips over the jumps", async () => {
    const a = makeWorld();
    try {
      // Two laps: the field no longer wrecks itself at the start, so one lap records fewer than 3 clips. And the race AI steers clear
      // of what it closes on (`guardContact`), so the field's own crashes are too few for 3 clips in two laps: three head-on pairs, far
      // apart on flat road, are wrecked on purpose a second into the race (cars 2-3, 4-5 and 6-7 at 2 x 20 m/s).
      race(a, { ...FIELD, trackId: "stunt", laps: 2 });
      const track = new Track(stunt);
      const pt = blankPoint();
      const state = { acc: 0 };
      for (let n = 0; a.race.time < 1 && n < 900; n++) frame(a, state);
      for (const [k, d] of [150, 530, 725].entries()) {
        track.pointAt(d, pt);
        a.cars[2 + 2 * k]!.spawnFacing(pt.x, pt.z, Math.atan2(pt.tx, pt.tz), 20);
        track.pointAt(d + 8, pt);
        a.cars[3 + 2 * k]!.spawnFacing(pt.x, pt.z, Math.atan2(pt.tx, pt.tz) + Math.PI, 20);
      }
      const reel = await recordedReel(a, Infinity);
      assert.ok(reel.clips.length >= 3, `${reel.clips.length} stunt clips`);
      const firsts = reel.clips.map((c) => [c.cars[c.firstA]?.slot, c.cars[c.firstB]?.slot].sort().join("-"));
      for (const pair of ["2-3", "4-5", "6-7"]) assert.ok(firsts.includes(pair), `no clip opens on the head-on of cars ${pair}: ${firsts.join(", ")}`);
      for (const clip of reel.clips) for (const hz of [60, 240]) assertDrawingKeepsReplay(a, clip, hz);
    } finally {
      a.race.exit();
      setGround(null);
    }
  });
});
