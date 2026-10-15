import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { applyDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { assignClass, HANDLING } from "../vehicle/vehicle-classes.ts";
import { fleetClass, fleetStyle } from "../scenes/fleet.ts";
import { Reader, Writer } from "../net/codec.ts";
import { carLayout } from "../net/car-pose.ts";
import { clipBytes, readClip, writeClip } from "../net/reel-codec.ts";
import { makeWorld } from "../world/race-world.test-util.ts";
import type { HighlightClip } from "../match/highlights.ts";
import { newWorld, settleStep, stepWorld } from "./world-step.ts";
import { CrashRecorder } from "./engine-record.ts";
import { ClipSim } from "./engine-replay.ts";
import { PoseBlend } from "../present/pose-blend.ts";
import { FINE_HZ } from "../kernel/constants.ts";

/** The engine's step is a float32 (`Math.fround`), which the recorder stores whole: the replay runs the very step the live sim ran. */
const H = Math.fround(1 / FINE_HZ);
const STEPS = 8 * FINE_HZ;
/** The slots of the scene (a flat field, y = 0): a head-on pair, a wreck 40 m off it that is at rest (asleep) from about 2 s, and a car that joins the field late. */
const A = 0;
const B = 1;
const SLEEPER = 2;
/**
 * The car that drives past the sleeping wreck about 4 s in. It does not exist when the clip's first keyframe is taken (and a clip takes only the cars that
 * did), and it never touches a car, so the clip leaves it out: the live world has its roof, the replay world does not.
 */
const PASSER = 3;
const JOIN_STEP = 300;
const IMPACT_X = 60;

/** The clip as a peer decodes it, the cars of the world it was recorded in, the world's trace of every car (position, velocity), and what the passer did. */
interface Recorded {
  clip: HighlightClip;
  cars: DeformableCar[];
  trace: Float64Array[];
  dress: (car: DeformableCar) => void;
  /** The step the wreck fell asleep in, and the step the passer was nearest it (its distance, m). */
  asleepAt: number;
  closest: { step: number; gap: number };
}

/** A head-on in a flat field recorded as a highlight, a wreck lying 40 m off it that a car outside the clip drives past. */
function record(): Recorded {
  const { dress } = makeWorld();
  const scene = new THREE.Scene();
  const make = (i: number): DeformableCar => {
    const car = new DeformableCar({ body: 0x808080, accent: 0, name: `c${i}` }, scene, null, fleetStyle(i));
    assignClass(car, fleetClass(i));
    dress(car);
    return car;
  };
  const cars = [A, B, SLEEPER].map(make);
  cars[A]!.spawnFacing(0, 0, Math.PI / 2, 15);
  cars[B]!.spawnFacing(2 * IMPACT_X, 0, -Math.PI / 2, 15);
  const sleeper = cars[SLEEPER]!;
  sleeper.spawnFacing(IMPACT_X, 40, Math.PI / 2, 12);
  sleeper.applyImpact(new THREE.Vector3(sleeper.group.position.x + 2.2, 0.5, sleeper.group.position.z), new THREE.Vector3(-1, 0, 0), 16, 12);
  assert.ok(sleeper.crashed, "the sleeper is a wreck");
  const rec = new CrashRecorder({ recall: (_i, out) => out.set([-1]), knocks: () => new Uint8Array(16) });
  rec.begin("flat", HANDLING.realism, false, 4, (i) => `c${i}`, 1);
  const world = newWorld(cars);
  world.pairHit = (a, b, hit) => rec.pairHit(a, b, hit);
  world.partTouch = (a, b) => rec.touch(a, b);
  const trace: Float64Array[] = [];
  const input: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
  let asleepAt = -1;
  const closest = { step: -1, gap: Infinity };
  for (let s = 0; s < STEPS; s++) {
    if (s === JOIN_STEP) {
      // 65 m up the road along the wreck's length (it lies facing +x) and 3.3 m to its side: its roof comes within the wreck's reach (2.5 m of its middle) yet
      // clear of the wreck itself (a car is 1.9 m wide). At 20 m/s it passes at about 4 s, after the wreck sleeps and before the clip ends.
      const passer = make(PASSER);
      passer.spawnFacing(sleeper.group.position.x + 65, sleeper.group.position.z + 3.3, -Math.PI / 2, 20);
      cars.push(passer);
    }
    rec.startStep(cars);
    for (const [i, car] of cars.entries()) {
      input.throttle = i === A || i === B ? 1 : i === PASSER ? 0.4 : 0;
      applyDrive(car, input, H);
    }
    stepWorld(world, H);
    rec.endStep(cars, H, world.shape);
    settleStep(cars, H, false);
    if (sleeper.asleep && asleepAt < 0) asleepAt = s;
    if (cars.length > PASSER) {
      const p = cars[PASSER]!.group.position;
      const w = sleeper.group.position;
      const gap = Math.hypot(p.x - w.x, p.z - w.z);
      if (gap < closest.gap) {
        closest.gap = gap;
        closest.step = s;
      }
    }
    trace.push(Float64Array.from(cars.flatMap((c) => [...c.group.position.toArray(), ...c.velocity.toArray()])));
  }
  rec.end();
  assert.ok(rec.ledger.kept.length >= 1, "the head-on crash did not rank as a highlight");
  const kept = rec.ledger.kept[0]!;
  const w = new Writer(clipBytes(kept));
  writeClip(w, kept);
  return { clip: readClip(new Reader().reset(w.done()), carLayout(cars[0]!)), cars, trace, dress, asleepAt, closest };
}

/** The worst distance (m) and speed difference (m/s) of any clip car from the live trace, over every step of `clip` replayed as a peer does. */
function replayWorst(run: Recorded, clip: HighlightClip): { pose: number; vel: number } {
  const { cars, trace, dress } = run;
  // The recorder's clock sums `H` as the record loop did, so the clip's first step is the trace step at `t0`.
  const s0 = Math.round(clip.t0 / H);
  const sim = new ClipSim(clip, clip.cars.map((c) => cars[c.slot]!), { dress, collide: () => {}, blend: new PoseBlend() });
  sim.restart();
  let pose = 0;
  let vel = 0;
  while (!sim.done) {
    sim.advanceTo(sim.time + 1e-6);
    const row = trace[s0 + sim.step - 1]!;
    for (const { slot } of clip.cars) {
      const c = cars[slot]!;
      const p = c.group.position;
      pose = Math.max(pose, Math.hypot(p.x - row[slot * 6]!, p.y - row[slot * 6 + 1]!, p.z - row[slot * 6 + 2]!));
      vel = Math.max(vel, Math.hypot(c.velocity.x - row[slot * 6 + 3]!, c.velocity.y - row[slot * 6 + 4]!, c.velocity.z - row[slot * 6 + 5]!));
    }
  }
  return { pose, vel };
}

describe("given a head-on recorded as a highlight, a wreck lying asleep 40 m off it, and a car the clip leaves out that drives past the wreck", () => {
  const run = record();
  const { clip } = run;
  const sleeperAt = clip.cars.findIndex((c) => c.slot === SLEEPER);
  const s0 = Math.round(clip.t0 / H);

  it("when the clip is filed, then it carries the wreck but not the passing car, and lists the wreck's wake after it fell asleep: its step, its car and the slice", (t) => {
    t.diagnostic(`clip cars ${clip.cars.map((c) => c.slot).join(",")}, steps ${s0} to ${s0 + clip.h.length}; wreck asleep from step ${run.asleepAt}; passer nearest at step ${run.closest.step} (${run.closest.gap.toFixed(2)} m); stirs ${JSON.stringify(clip.stirs)}`);
    assert.ok(clip.cars.some((c) => c.slot === A) && clip.cars.some((c) => c.slot === B) && sleeperAt >= 0, "the pair and the wreck are in the clip");
    assert.ok(!clip.cars.some((c) => c.slot === PASSER), "the car that joined the field after the clip began is left out");
    assert.ok(run.asleepAt > 0 && run.asleepAt < JOIN_STEP + 400, `the wreck fell asleep (step ${run.asleepAt}) before the passer came by`);
    assert.ok(s0 + clip.h.length > run.closest.step, "the passer comes by inside the clip");
    const mine = clip.stirs.filter((x) => x.car === sleeperAt);
    assert.ok(mine.length >= 1, "the wreck was stirred by the car that drove past");
    const first = mine[0]!;
    assert.ok(s0 + first.step > run.asleepAt && s0 + first.step <= run.closest.step, `the wake (step ${s0 + first.step}) is after the wreck slept (${run.asleepAt}) and as the passer comes by (${run.closest.step})`);
    assert.ok(first.slice >= 0 && first.slice < 8, "the slice is one of the step's");
  });

  it("when the clip is replayed with its stirs, then every car of it matches the live sim at every step, to the bit", () => {
    assert.deepEqual(replayWorst(run, clip), { pose: 0, vel: 0 });
  });

  it("when the same clip is replayed without its stirs, then the wreck sleeps on while the live one woke, so the replay strays (the case holds what it is for)", () => {
    const worst = replayWorst(run, { ...clip, stirs: [] });
    assert.ok(worst.pose > 0 || worst.vel > 0, `without the stirs the replay stays exact: ${JSON.stringify(worst)}`);
  });
});
