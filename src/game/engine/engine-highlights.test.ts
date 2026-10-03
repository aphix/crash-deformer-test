import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { setGround } from "../world/ground.ts";
import { frame, makeWorld, type World } from "../world/race-world.test-util.ts";
import { phaseClock } from "../match/phase.ts";
import { carLayout } from "../net/car-pose.ts";
import { packReel, unpackReel } from "../net/reel-codec.ts";
import { clipTimeline, FLIGHT_S, ReelDirector, simAt, type ReelHost } from "./engine-highlights.ts";

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
    sight: () => w.race.courseSight()!,
    clock: phaseClock(),
    impact: () => {},
    hit: () => {},
  };
}

function race(w: World): void {
  w.race.enter();
  w.race.command({ type: "quit" });
  w.race.command({ type: "options", options: FIELD });
  w.race.reseed(SEED);
  w.race.command({ type: "start" });
  w.seat.mode = "follow";
}

describe("highlight reel on two peers", () => {
  it("bad: two peers playing one reel at different frame rates must frame the same shot at the same moment", async () => {
    const a = makeWorld();
    const b = makeWorld();
    try {
      race(a);
      const state = { acc: 0 };
      for (let n = 0; n * (1 / 60) < 60 && a.race.recorder.ledger.kept.length === 0 && a.race.phase !== "finished"; n++) frame(a, state);
      a.race.recorder.end();
      const kept = a.race.recorder.ledger.kept;
      assert.ok(kept.length >= 1, "no clip in 60 s of a ramming field");
      // What a host sends and every peer (the host too) replays.
      const { msg } = await packReel({ seed: 77, clips: kept.slice(0, 1) }, 0);
      const { reel } = await unpackReel(msg, carLayout(a.cars[0]!));
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
