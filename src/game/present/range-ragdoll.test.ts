import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DRIVER_CARS } from "../match/types.ts";
import { ejectionVelocity } from "../vehicle/ejection.ts";
import { apexOf, type Carry, type Control, deepest, displayFrames, type DriverCar, inCar, lowest, rangeThrow, type RangeThrow, restOf, travel } from "./range-run.test-util.ts";

/**
 * The ejection range (scenes/range.ts) at its defaults (its own spawn, 100 km/h, the HUD's squash, buckle, mode and
 * default realism: only the car type changes), once per car type of the setup menu (every class on its body, then the
 * other bodies): the thrown dummy goes more forward than up or to a side, and ends up still on the ground. Run through
 * the engine's step and `RagdollSystem.launch` + `update` (range-run.test-util.ts) and read off the Rapier bodies; the
 * real, sliding jersey barrier, the engine's slow-mo; at 60 and 240 Hz steady, and at both with frames 0.5–1.5× as
 * long and one in fifty stalled 4× more (seeds 3 and 4: the slowest to rest of 294 runs was 240 Hz seed 4).
 */
const DISPLAYS: [string, () => () => number][] = [
  ["60 Hz", () => displayFrames(60)],
  ["240 Hz", () => displayFrames(240)],
  ["60 Hz, jittered, stalls", () => displayFrames(60, 3, true)],
  ["240 Hz, jittered, stalls", () => displayFrames(240, 4, true)],
];

/**
 * Sim seconds after the release by which he must lie still (`STILL`, for the rest of his 10 s life, `LIFE`): measured
 * 1.8–3.0 s over 294 runs (7 car types × 14 seeds × 60, 144 and 240 Hz, jittered with stalls), but 3 of the 98 at
 * 240 Hz took 3.1 s (hatchback and wagon alike) and 4.4 s: he lands on his feet, and under the settle damping (10 /s)
 * topples as slowly as in honey. The range runs again 1 s (`LANDED_STILL`) plus 3 wall s (`SHOW_LANDING`) after his
 * torso lies still.
 */
const REST_BY = 6;
/** The most his lowest body may be off the terrain while he lies still (m): he sags up to 1.8 cm into the sand under his weight (measured). */
const GROUND_TOL = 0.03;
/** The deepest any part may be under the terrain at any moment of his life (m): measured up to 2.4 cm, a 30 m/s landing being resolved within one 1/960 s step. */
const SUNK_MAX = 0.05;

/** The crash threw exactly one driver and one dummy came out (a run that threw nobody would pass every check below by having nothing to check). */
function threwOne(run: RangeThrow): string[] {
  const bad: string[] = [];
  if (run.ejections !== 1) bad.push(`thrown: ${run.ejections} ejection events, not 1`);
  if (run.peakLive !== 1) bad.push(`thrown: ${run.peakLive} dummies out at once, not 1`);
  if (run.frames.length === 0 || run.gone === null) bad.push(`thrown: ${run.frames.length} frames of him, ${run.gone === null ? "never gone" : "gone"}`);
  return bad;
}

/**
 * Every observable of the throw that does not go more forward than up and than to a side, as `name: numbers`; empty
 * when all hold. Forward is the car's run-up direction (its pre-impact travel, which the crash may yaw away from), the
 * observables are the Rapier torso's (the dummy's root), and "up" is never the net rise at rest, which falls back to
 * about zero and passes anything:
 *   release     its velocity the instant he is released (m/s): forward against up and against side,
 *   first step  its velocity after Rapier's first step of him (m/s): the same,
 *   apex        its travel from the exit to the highest it gets (m): forward against the rise (the peak rise above
 *               the launch point) and against the drift to a side,
 *   rest        its travel from the exit to where he lies still (m): forward against the same peak rise and against
 *               the drift to a side there.
 */
function astray(run: RangeThrow): string[] {
  const bad = threwOne(run);
  if (bad.length > 0) return bad;
  const rest = restOf(run.frames);
  const at = travel(run.frames[apexOf(run.frames)]!, run.exit, run.runUp);
  const stop = travel(run.frames[rest.at >= 0 ? rest.at : run.frames.length - 1]!, run.exit, run.runUp);
  const seen: [string, Carry][] = [
    ["release", inCar(run.release, run.runUp)],
    ["first step", run.first ? inCar(run.first, run.runUp) : { fwd: 0, up: 0, side: 0 }],
    ["apex", at],
    ["rest", { ...stop, up: at.up }],
  ];
  return seen.filter(([, c]) => !(c.fwd > Math.abs(c.up) && c.fwd > Math.abs(c.side))).map(([name, c]) => `${name}: fwd ${c.fwd.toFixed(2)} up ${c.up.toFixed(2)} side ${c.side.toFixed(2)}`);
}

/**
 * Every way the dummy does not end up still on the terrain, as `name: numbers`; empty when he does. Still: from some
 * frame to the end of his life every body is under `STILL`'s linear and angular speeds and has not drifted past
 * `STILL`'s distances for at least `STILL.window` s (the poses are judged as well as Rapier's velocities, which read zero
 * for a sleeping body), and that frame is within `REST_BY`. On the terrain: from then on his lowest body is within
 * `GROUND_TOL` of the ground height under it (with no rest, at the last moment he was seen), he touches the terrain's
 * colliders and nothing else (not the car, the barrier or a floor nobody built), and no part was ever deeper than
 * `SUNK_MAX` under it.
 */
function unsettled(run: RangeThrow): string[] {
  const bad = threwOne(run);
  if (bad.length > 0) return bad;
  const rest = restOf(run.frames);
  if (rest.at < 0) bad.push(`still: never (fastest ${rest.v.toFixed(3)} m/s ${rest.w.toFixed(3)} rad/s, drift ${rest.x.toFixed(3)} m ${rest.r.toFixed(3)} rad)`);
  else if (run.frames[rest.at]!.age > REST_BY) bad.push(`still: from ${run.frames[rest.at]!.age.toFixed(2)} s, after ${REST_BY} s`);
  const end = lowest(run.frames.at(-1)!);
  const [lo, hi] = rest.at >= 0 ? rest.floor : [end, end];
  if (Math.abs(lo) > GROUND_TOL || Math.abs(hi) > GROUND_TOL) bad.push(`ground: lowest body ${lo.toFixed(3)} … ${hi.toFixed(3)} m off the terrain`);
  const low = deepest(run.frames);
  if (low < -SUNK_MAX) bad.push(`ground: a part ${(-low).toFixed(3)} m under the terrain`);
  if (rest.at >= 0 && rest.foreign > 0) bad.push(`supported: ${rest.foreign} contacts with something that is not the terrain`);
  if (rest.at >= 0 && rest.ground === 0) bad.push("supported: a frame of his rest touches no terrain at all");
  return bad;
}

/** One run per car type and display, shared by the properties (a run is deterministic). */
const runs = new Map<string, Promise<RangeThrow>>();
const runOf = (type: DriverCar, display: string, frames: () => () => number): Promise<RangeThrow> => {
  const key = `${type.id}/${display}`;
  if (!runs.has(key)) runs.set(key, rangeThrow(type, {}, frames()));
  return runs.get(key)!;
};

describe("the range's thrown driver, every car type at the defaults", () => {
  for (const type of DRIVER_CARS) {
    it(`bad: a ${type.label} at the range throws exactly one driver and one dummy`, async () => {
      for (const [display, frames] of DISPLAYS) assert.deepEqual(threwOne(await runOf(type, display, frames)), [], `${type.id} at ${display}`);
    });

    it(`bad: a ${type.label} thrown at the range goes more forward than up or to a side, release, first step, apex and rest`, async () => {
      for (const [display, frames] of DISPLAYS) assert.deepEqual(astray(await runOf(type, display, frames)), [], `${type.id} at ${display}`);
    });

    it(`bad: a ${type.label} thrown at the range ends up still, on the terrain`, async () => {
      for (const [display, frames] of DISPLAYS) assert.deepEqual(unsettled(await runOf(type, display, frames)), [], `${type.id} at ${display}`);
    });
  }
});

describe("the range's checks can fail", () => {
  const sedan = DRIVER_CARS[0]!;
  const names = (bad: string[]) => [...new Set(bad.map((b) => b.split(":")[0]))];
  /** Every throw's launch velocity turned `deg` degrees about `axis` (its car's own speed stays in it). */
  const bent = (axis: (runUp: THREE.Vector3) => THREE.Vector3, deg: number): Control => ({
    event: (e, runUp) => {
      const v = ejectionVelocity(e, new THREE.Vector3()).applyAxisAngle(axis(runUp), (deg * Math.PI) / 180);
      e.rel.copy(v).sub(e.carVel);
    },
  });
  /** Turning about the run-up's side axis lifts the nose of the throw; about the vertical turns it aside. */
  const toSide = (runUp: THREE.Vector3) => new THREE.Vector3(-runUp.z, 0, runUp.x);
  const vertical = () => new THREE.Vector3(0, 1, 0);
  /** The ground collider's friction set to nothing under the dummy's own `Min` rule (`SAND` friction wins over his `SLIDE` otherwise). */
  const slick = (sys: Parameters<NonNullable<Control["released"]>>[0]) => {
    for (const c of sys["statics"]) {
      c.setFriction(0);
      c.setFrictionCombineRule(sys["R"]!.CoefficientCombineRule.Min);
    }
  };

  it("bad: control: a throw bent 60° up fails release, first step and apex, and one bent 80° up fails rest too", async () => {
    assert.deepEqual(names(astray(await rangeThrow(sedan, bent(toSide, 60)))), ["release", "first step", "apex"]);
    assert.deepEqual(names(astray(await rangeThrow(sedan, bent(toSide, 80)))), ["release", "first step", "apex", "rest"]);
  });

  it("bad: control: a throw bent 60° to a side fails release, first step, apex and rest", async () => {
    assert.deepEqual(names(astray(await rangeThrow(sedan, bent(vertical, 60)))), ["release", "first step", "apex", "rest"]);
  });

  it("bad: control: a second dummy launched with the first is not one throw, and nobody thrown is not one either", async () => {
    const run = await rangeThrow(sedan, { released: (sys, car, e) => sys.launch(e, [car]) });
    assert.equal(run.peakLive, 2);
    assert.deepEqual(names(threwOne(run)), ["thrown"]);
    assert.deepEqual(threwOne({ ...run, ejections: 0, peakLive: 0, frames: [], gone: null }).length, 3);
  });

  it("bad: control: with the ground gone he falls through it and is never still", async () => {
    const run = await rangeThrow(sedan, {
      released: (sys) => {
        for (const c of sys["statics"]) sys["world"]!.removeCollider(c, false);
      },
    });
    assert.deepEqual(names(unsettled(run)), ["still", "ground"]);
  });

  it("bad: control: lying on an invisible floor 10 cm up, still, he is floating, on something that is not the terrain", async () => {
    const run = await rangeThrow(sedan, {
      released: (sys) => {
        sys["world"]!.createCollider(sys["R"]!.ColliderDesc.cuboid(200, 0.05, 200).setTranslation(0, 0.05, 0));
      },
    });
    const bad = names(unsettled(run));
    assert.ok(bad.includes("ground") && bad.includes("supported"), unsettled(run).join("; "));
  });

  it("bad: control: on a frictionless floor with no damping he slides on and is never still", async () => {
    const run = await rangeThrow(sedan, {
      released: slick,
      frame: (_sys, bodies) => {
        for (const b of bodies) {
          b.setLinearDamping(0);
          b.setAngularDamping(0);
        }
      },
    });
    assert.deepEqual(names(unsettled(run)), ["still"]);
  });

  it("bad: control: a torso that keeps turning at 1 rad/s is never still", async () => {
    const run = await rangeThrow(sedan, { frame: (_sys, bodies) => bodies[0]!.setAngvel({ x: 0, y: 1, z: 0 }, true) });
    assert.deepEqual(names(unsettled(run)), ["still"]);
  });

  it("bad: control: a sleeping dummy crept along 5 mm a frame reads zero speed to Rapier, yet is never still", async () => {
    const run = await rangeThrow(sedan, {
      frame: (_sys, bodies) => {
        if (!bodies[0]!.isSleeping()) return;
        for (const b of bodies) {
          const t = b.translation();
          b.setTranslation({ x: t.x + 0.005, y: t.y, z: t.z }, false);
        }
      },
    });
    assert.ok(Math.max(...run.frames.at(-1)!.v.map(Math.abs)) < 1e-9, "Rapier reads the creeping dummy at rest");
    assert.deepEqual(names(unsettled(run)), ["still"]);
  });
});
