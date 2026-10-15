import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { applyDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { assignClass, HANDLING } from "../vehicle/vehicle-classes.ts";
import { fleetClass, fleetStyle } from "../scenes/fleet.ts";
import { Reader, Writer } from "../net/codec.ts";
import { carLayout } from "../net/car-pose.ts";
import { clipBytes, encodeSaved, readClip, writeClip } from "../net/reel-codec.ts";
import { makeWorld } from "../world/race-world.test-util.ts";
import type { HighlightClip } from "../match/highlights.ts";
import { newWorld, settleStep, stepWorld } from "./world-step.ts";
import { CrashRecorder } from "./engine-record.ts";
import { ClipSim } from "./engine-replay.ts";
import { PoseBlend } from "../present/pose-blend.ts";

/** The engine's step is a float32 (`Math.fround`), which the recorder stores whole: the replay runs the very step the live sim ran. */
const H = Math.fround(1 / 240);
const STEPS = 8 * 240;
/** A head-on pair (the clip's cars) and a car the clip leaves out that drives by the debris they leave. */
const A = 0;
const B = 1;
const PASSER = 2;
/** The step the passer joins the field: after the first keyframe of the clip is taken, so the clip leaves it out. */
const JOIN_STEP = 300;
const IMPACT_X = 60;
/** How far (m) up the road from the crash the passer is put, its speed (m/s), and how far (m) to the side of the crash line it passes (its roof clear of both wrecks, over no part). */
const PASSER_AHEAD = 65;
const PASSER_SPEED = 20;
const PASSER_SIDE = 5;

/** The clip as a peer decodes it, the cars of the world it was recorded in, the world's trace of every clip car's loose bodies, and where the passer was nearest the crash. */
interface Recorded {
  clip: HighlightClip;
  cars: DeformableCar[];
  /** Per step, per clip car (`A`, `B`): the position (x, y, z) of every torn part and popped wheel it has put in the world (`freeObjects`). */
  trace: Float64Array[][];
  dress: (car: DeformableCar) => void;
  closest: { step: number; gap: number };
}

const looseBodyPositions = (car: DeformableCar): Float64Array => {
  const bodies: THREE.Object3D[] = [];
  const count = car.freeObjects(bodies, 0);
  const positions = new Float64Array(3 * count);
  for (let k = 0; k < count; k++) bodies[k]!.position.toArray(positions, 3 * k);
  return positions;
};

/** A head-on in a flat field recorded as a highlight, its torn parts lying on the road, and (with `passer`) a car the clip leaves out driving by them. */
function record(passer: boolean): Recorded {
  const { dress } = makeWorld();
  const scene = new THREE.Scene();
  const make = (i: number): DeformableCar => {
    const car = new DeformableCar({ body: 0x808080, accent: 0, name: `c${i}` }, scene, null, fleetStyle(i));
    assignClass(car, fleetClass(i));
    dress(car);
    return car;
  };
  const cars = [A, B].map(make);
  cars[A]!.spawnFacing(0, 0, Math.PI / 2, 15);
  cars[B]!.spawnFacing(2 * IMPACT_X, 0, -Math.PI / 2, 15);
  const rec = new CrashRecorder({ recall: (_i, out) => out.set([-1]), knocks: () => new Uint8Array(16) });
  rec.begin("flat", HANDLING.realism, false, 4, (i) => `c${i}`, 1);
  const world = newWorld(cars);
  world.pairHit = (a, b, hit) => rec.pairHit(a, b, hit);
  world.partTouch = (a, b) => rec.touch(a, b);
  const trace: Float64Array[][] = [];
  const input: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
  const closest = { step: -1, gap: Infinity };
  for (let s = 0; s < STEPS; s++) {
    if (passer && s === JOIN_STEP) {
      const car = make(PASSER);
      car.spawnFacing(IMPACT_X + PASSER_AHEAD, PASSER_SIDE, -Math.PI / 2, PASSER_SPEED);
      cars.push(car);
    }
    rec.startStep(cars);
    for (const [i, car] of cars.entries()) {
      input.throttle = i === PASSER ? 0.4 : 1;
      applyDrive(car, input, H);
    }
    stepWorld(world, H);
    rec.endStep(cars, H, world.shape);
    settleStep(cars, H, false);
    if (cars.length > PASSER) {
      const p = cars[PASSER]!.group.position;
      const gap = Math.hypot(p.x - IMPACT_X, p.z);
      if (gap < closest.gap) {
        closest.gap = gap;
        closest.step = s;
      }
    }
    trace.push([looseBodyPositions(cars[A]!), looseBodyPositions(cars[B]!)]);
  }
  rec.end();
  assert.ok(rec.ledger.kept.length >= 1, "the head-on crash did not rank as a highlight");
  const kept = rec.ledger.kept[0]!;
  const w = new Writer(clipBytes(kept));
  writeClip(w, kept);
  return { clip: readClip(new Reader().reset(w.done()), carLayout(cars[0]!)), cars, trace, dress, closest };
}

/**
 * Every step of `clip` replayed as a peer does, against the live sim's trace: the first step (counted from the clip's first) at which a clip car's torn parts and popped wheels
 * are not where the live sim had them (their number or any coordinate), -1 for none, and the worst coordinate difference (m).
 */
function replayLooseBodies(run: Recorded, clip: HighlightClip): { firstOff: number; worst: number } {
  const { cars, trace, dress } = run;
  // The recorder's clock sums `H` as the record loop did, so the clip's first step is the trace step at `t0`.
  const s0 = Math.round(clip.t0 / H);
  const sim = new ClipSim(clip, clip.cars.map((c) => cars[c.slot]!), { dress, collide: () => {}, blend: new PoseBlend() });
  sim.restart();
  let firstOff = -1;
  let worst = 0;
  while (!sim.done) {
    sim.advanceTo(sim.time + 1e-6);
    const row = trace[s0 + sim.step - 1]!;
    for (const { slot } of clip.cars) {
      const live = row[slot]!;
      const replayed = looseBodyPositions(cars[slot]!);
      let gap = live.length === replayed.length ? 0 : Infinity;
      for (let k = 0; k < Math.min(live.length, replayed.length); k++) gap = Math.max(gap, Math.abs(live[k]! - replayed[k]!));
      if (gap > 0 && firstOff < 0) firstOff = sim.step - 1;
      worst = Math.max(worst, gap);
    }
  }
  return { firstOff, worst };
}

describe("given a head-on recorded as a highlight, its torn parts lying asleep on the road, and a car the clip leaves out that drives by them", () => {
  const run = record(true);
  const { clip } = run;
  const s0 = Math.round(clip.t0 / H);

  it("when the clip is filed, then it carries the pair but not the passing car, and lists the parts' wakes as runs of slices that begin before the passer is nearest", async (t) => {
    const bytes = clipBytes(clip) - clipBytes({ ...clip, partStirs: [] });
    const slices = clip.partStirs.reduce((n, x) => n + x.slices, 0);
    // A saved clip is the deflated bytes in base64 (3 bytes to 4 characters).
    const [withRuns, without] = await Promise.all([encodeSaved(clip), encodeSaved({ ...clip, partStirs: [] })]);
    t.diagnostic(`clip cars ${clip.cars.map((c) => c.slot).join(",")}, steps ${s0} to ${s0 + clip.h.length}; passer nearest at step ${run.closest.step} (${run.closest.gap.toFixed(2)} m); ${clip.partStirs.length} part stirs over ${slices} slices cost ${bytes} bytes raw of ${clipBytes(clip)}, ${Math.round(((withRuns.length - without.length) * 3) / 4)} deflated of ${Math.round((withRuns.length * 3) / 4)}`);
    assert.ok(clip.cars.some((c) => c.slot === A) && clip.cars.some((c) => c.slot === B), "the pair is in the clip");
    assert.ok(!clip.cars.some((c) => c.slot === PASSER), "the car that joined the field after the clip began is left out");
    assert.ok(s0 + clip.h.length > run.closest.step, "the passer comes by inside the clip");
    assert.ok(clip.partStirs.length >= 1, "no torn part was recorded woken");
    assert.ok(clip.partStirs.some((x) => s0 + x.step <= run.closest.step), "a part wake begins before the passer is nearest");
  });

  it("when the clip is replayed with its part stirs, then every torn part of its cars is where the live sim had it at every step, to the bit", () => {
    assert.deepEqual(replayLooseBodies(run, clip), { firstOff: -1, worst: 0 });
  });

  it("when the same clip is replayed without its part stirs, then the parts the passer woke lie still while the live ones settled, so the replay strays (the case holds what it is for)", (t) => {
    const strayed = replayLooseBodies(run, { ...clip, partStirs: [] });
    t.diagnostic(`without the part stirs the replay is first off at clip step ${strayed.firstOff} (race step ${s0 + strayed.firstOff}), worst ${strayed.worst.toExponential(2)} m`);
    assert.ok(strayed.firstOff >= 0, `without the part stirs the replay stays exact: ${JSON.stringify(strayed)}`);
  });
});

describe("given the same head-on recorded with no car outside the clip", () => {
  it("when it is replayed without part stirs, then every torn part is where the live sim had it, to the bit (the passer is what the stirs are for)", (t) => {
    const run = record(false);
    t.diagnostic(`its own cars' wrecks alone stir ${run.clip.partStirs.length} part runs over ${run.clip.partStirs.reduce((n, x) => n + x.slices, 0)} slices`);
    assert.deepEqual(replayLooseBodies(run, { ...run.clip, partStirs: [] }), { firstOff: -1, worst: 0 });
  });
});
