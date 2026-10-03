import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { setGround } from "../world/ground.ts";
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

describe("highlight reel timeline", () => {
  it("bad: the reel must play a clip at 1× up to the hit, hold the phase.ts slow-mo over it, then catch up to the end", () => {
    const tl = clipTimeline(4, 10);
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
    scene: { dress: w.dress, collide: (car, slot) => w.race.courseHit(car, slot), bounce: undefined },
    resetProps: () => w.race.resetProps(),
    clear: () => {},
    sight: () => w.race.courseSight()!,
    clock: phaseClock(),
    impact: () => {},
    hit: () => {},
    eject: () => {},
  };
}

function race(w: World, field = FIELD): void {
  w.race.enter();
  w.race.command({ type: "quit" });
  w.race.command({ type: "options", options: field });
  w.race.reseed(SEED);
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
  const { msg } = await packReel({ seed: 77, clips: kept.slice(0, clips) }, 0);
  return (await unpackReel(msg, carLayout(w.cars[0]!))).reel;
}

describe("highlight reel on two peers", () => {
  it("bad: two peers playing one reel at different frame rates must frame the same shot at the same moment", async () => {
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
      const end = FLIGHT_S + clipTimeline(reel.clips[0]!.firstImpact, reel.clips[0]!.h.reduce((s, h) => s + h, 0)).wall;
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

describe("highlight reel and the race's leftovers", () => {
  it("bad: a clip's setup empties the scene (the race's torn parts on the cars it hides included) and the reel ending empties what the clips left; no reel up clears nothing", async () => {
    const a = makeWorld();
    try {
      race(a);
      const reel = await recordedReel(a);
      const torn = (): number => a.cars.reduce((n, c) => n + c["parts"].filter((p) => p.detached).length, 0);
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

describe("highlight reel frames", () => {
  it("bad: a car moving through the slow-mo is drawn moving on every frame at 60 and 240 Hz, and drawing never changes the replay", async () => {
    const a = makeWorld();
    try {
      race(a);
      const reel = await recordedReel(a);
      const clip = reel.clips[0]!;
      const tl = clipTimeline(clip.firstImpact, clip.h.reduce((s, h) => s + h, 0));
      for (const hz of [60, 240]) {
        const d = new ReelDirector(hostOf(a));
        d.stepBudgetMs = Infinity;
        d.play(reel, 0);
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

  it("bad: drawing never changes the replay of an airborne clip (the stunt course's jumps) at 60 and 240 Hz", async () => {
    const a = makeWorld();
    try {
      race(a, { ...FIELD, trackId: "stunt" });
      const reel = await recordedReel(a, Infinity);
      assert.ok(reel.clips.length >= 3, `${reel.clips.length} stunt clips`);
      for (const clip of reel.clips) for (const hz of [60, 240]) assertDrawingKeepsReplay(a, clip, hz);
    } finally {
      a.race.exit();
      setGround(null);
    }
  });
});
