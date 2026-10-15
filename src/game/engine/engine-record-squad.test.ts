import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCar, makeWorld } from "../contact/crash-scenarios.test-util.ts";
import { CLIP_OUT_CAR, type HighlightClip } from "../match/highlights.ts";
import { GuardSquad, People } from "../present/people.ts";
import { PoseBlend } from "../present/pose-blend.ts";
import { GUARD_DOWN, GUARD_RUNNING_OUT, LawnGuard, SHOT_RING, SQUAD_DOWN, SQUAD_SHOT, SQUAD_TARGET } from "../scenes/lawn-guard.ts";
import { TRACK_ID } from "../world/constants.ts";
import { setGround } from "../world/ground.ts";
import { Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { parseTrack } from "../world/track-schema.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { CrashRecorder } from "./engine-record.ts";
import { ClipSim } from "./engine-replay.ts";
import { settleStep, stepWorld } from "./world-step.ts";
import { FINE_HZ } from "../kernel/constants.ts";

/**
 * The White House squad through the recorder and a clip's replay (owner, 2026-10-15: "in a replay the guards are invisible until after the hit"). The squad is the
 * real one on the real North Lawn: a car parked there raises the alarm at step 0 and the guards run out over 2.5 s; guard `DOWN_GUARD` was run down before the clip. Two
 * cars meet head-on at 5 s (their first contact is some 4.7 s in, so the clip starts 3 s before it at the keyframe at 1 s): guards running out, one already down. The runner (slot 1, or slot 3 in the second race) drives
 * through guard 0's post at 10 m/s on its way.
 */
const track = new Track(TRACKS.find((j) => parseTrack(j).id === TRACK_ID.nationalMall)!);
const spec = track.json.guards!;
const ground = track.ground();
setGround(ground);
const H = 1 / FINE_HZ;
const STEPS = 6 / H;
const NORTH_LAWN = { x: -990, z: -1104 };
const DOWN_GUARD = 5;
const FAR = 2000;
/** Draw every this many steps (about 30 Hz): the figures' poses are costly. */
const DRAW_EVERY = 8;
/** Metres a replayed guard may stand from where the live run had him. */
const NEAR = 1e-3;

/** The squad as it stood after one step, and the mask of figures drawn (`People`'s shown bits) as of the last draw. */
type Frame = { mode: number[]; x: number[]; z: number[]; mask: number };
/** One replayed step of a clip: the global step it was, the squad as it stood after it (`Frame`), and the guards the clip threw in it. */
type ReplayFrame = Frame & { step: number; thrown: number[] };
type Run = {
  clip: HighlightClip;
  cars: DeformableCar[];
  trace: Frame[];
  start: number;
  /** The live race's strikes (step, guard, striking car's race slot) and the shots it fired (step, the car shot at). */
  struck: { step: number; guard: number; car: number }[];
  shotAt: { step: number; car: number }[];
};

/** The mask of figures `people` shows. */
const shown = (people: People): number => people["mesh"]["shown"] as number;

/** Guard 0's post once the squad is out (a probe run: one parked car on the lawn, three seconds). */
function guardPost(): { x: number; z: number } {
  const probe = new LawnGuard(spec, 1);
  probe.reset(7);
  const parked = makeCar();
  launch(parked, NORTH_LAWN.x, NORTH_LAWN.z, 0, 0, 0);
  for (let t = 0; t < 3; t += H) probe.step([parked], H);
  return { x: probe.guardX[0]!, z: probe.guardZ[0]! };
}

/**
 * A race of four cars: slot 0 parked on the lawn (the squad's target); slots 1 and 2 meet head-on at `crashAt` at 5 s; `runner`: the slot that drives through guard 0's
 * post (slot 1 itself, which then meets slot 2 beyond him, or a fourth car that never meets anyone).
 */
function race(crashAt: { x: number; z: number }, runner: number): Run {
  const post = guardPost();
  const cars = [makeCar(), makeCar(), makeCar(), makeCar()];
  launch(cars[0]!, NORTH_LAWN.x, NORTH_LAWN.z, 0, 0, 0);
  launch(cars[1]!, crashAt.x, crashAt.z - 50, 0, 0, 10);
  launch(cars[2]!, crashAt.x, crashAt.z + 50, Math.PI, 0, -10);
  if (runner === 3) launch(cars[3]!, post.x, post.z - 42, 0, 0, 10);
  else launch(cars[3]!, FAR, FAR, 0, 0, 0);
  const guard = new LawnGuard(spec, cars.length);
  guard.reset(7);
  guard.mode[DOWN_GUARD] = GUARD_DOWN;
  const w = makeWorld(cars, false, false, null);
  const rec = new CrashRecorder();
  rec.begin("flat", 0.35, false, cars.length, (i) => `c${i}`, 1);
  rec.watchSquad(guard);
  w.world.pairHit = (a, b, hit) => rec.pairHit(a, b, hit);
  const people = new People(spec.count + 1);
  const squad = new GuardSquad(spec, ground, people);
  const trace: Frame[] = [];
  const struck: Run["struck"] = [];
  const shotAt: Run["shotAt"] = [];
  let mask = 0;
  for (let s = 0; s < STEPS; s++) {
    rec.startStep(cars);
    stepWorld(w.world, H);
    const before = guard.shots;
    guard.step(cars, H);
    for (let k = before; k < guard.shots; k++) shotAt.push({ step: s, car: guard.shotCar[k % SHOT_RING]! });
    for (const x of guard.takeStrikes()) {
      struck.push({ step: s, guard: x.guard, car: x.car });
      rec.strike(x);
    }
    for (const e of guard.takeEvents()) rec.squadEvent(e);
    if (s % DRAW_EVERY === 0) {
      squad.frame(guard, cars, () => {});
      mask = shown(people);
    }
    trace.push({ mode: Array.from(guard.mode), x: Array.from(guard.guardX), z: Array.from(guard.guardZ), mask });
    rec.endStep(cars, H, w.world.shape);
    settleStep(cars, H, false);
    for (const car of cars) car.updateSkin();
  }
  rec.end();
  const clip = rec.ledger.kept[0]!;
  assert.ok(clip, "the head-on made no clip");
  return { clip, cars, trace, start: Math.round(clip.t0 / H), struck, shotAt };
}

/** The replay of `run`'s clip, stepped one recorded step at a time, with what each step showed. */
function replay(run: Run): { sim: ClipSim; frames: ReplayFrame[] } {
  const { clip, cars } = run;
  const sim = new ClipSim(clip, clip.cars.map((c) => cars[c.slot]!), { dress: () => {}, collide: () => {}, guards: () => spec, blend: new PoseBlend() });
  const people = new People(spec.count + 1);
  const squad = new GuardSquad(spec, ground, people);
  const frames: ReplayFrame[] = [];
  sim.restart();
  let mask = 0;
  while (!sim.done) {
    sim.advanceTo(sim.time + 1e-6);
    const step = run.start + sim.step - 1;
    const guard = sim.squad!;
    if (step % DRAW_EVERY === 0) {
      squad.frame(guard, cars, () => {});
      mask = shown(people);
    }
    frames.push({ step, mode: Array.from(guard.mode), x: Array.from(guard.guardX), z: Array.from(guard.guardZ), mask, thrown: sim.takeStrikes().map((s) => s.guard) });
  }
  return { sim, frames };
}

describe("given the squad running out of the White House when the clip starts, one guard already run down, and the runner that meets guard 0 on the way into the clip's crash", () => {
  let run: Run;
  let frames: ReplayFrame[];
  let sim: ClipSim;
  before(() => {
    const post = guardPost();
    run = race({ x: post.x, z: post.z + 8 }, 1);
    ({ sim, frames } = replay(run));
  });

  it("when the clip is filed, then it starts with the alarm up, guards on their way out and guard 5 down, and its decisions are the live squad's", () => {
    const squad = run.clip.squad!;
    assert.ok(squad, "the clip carries the squad");
    assert.ok(squad.state[0]! > 0 && squad.state[0]! < 2.5, `the alarm ${squad.state[0]} s old: guards mid-deploy`);
    const modes = Array.from({ length: spec.count }, (_, i) => squad.state[2 + 5 * i]);
    assert.ok(modes.includes(GUARD_RUNNING_OUT), "a guard is running out");
    assert.equal(modes[DOWN_GUARD], GUARD_DOWN, "guard 5 is down before the clip");
    assert.ok(squad.events.some((e) => e.kind === SQUAD_DOWN), "the run-down of a guard is listed");
    const live = run.shotAt.filter((x) => x.step >= run.start && x.car === 0).length;
    assert.ok(live > 0, "the squad fired in the clip");
    assert.equal(squad.events.filter((e) => e.kind === SQUAD_SHOT).length, live, "every shot at a car the clip carries is listed");
  });

  it("when the clip is replayed step by step, then every guard is in the live run's mode and within a millimetre of its place, and drawn as the live run drew him", () => {
    assert.equal(frames.length, run.trace.length - run.start, "the clip's steps");
    let moving = 0;
    for (const f of frames) {
      const want = run.trace[f.step]!;
      assert.equal(f.mode.join(), want.mode.join(), `modes at step ${f.step}`);
      for (let i = 0; i < spec.count; i++) {
        if (f.mode[i] === GUARD_DOWN || want.mode[i] === 0) continue;
        assert.ok(Math.abs(f.x[i]! - want.x[i]!) < NEAR && Math.abs(f.z[i]! - want.z[i]!) < NEAR, `guard ${i} at step ${f.step}: (${f.x[i]}, ${f.z[i]}) against (${want.x[i]}, ${want.z[i]})`);
      }
      if (f.mode.includes(GUARD_RUNNING_OUT)) moving++;
      if (f.step % DRAW_EVERY === 0) assert.equal(f.mask, want.mask, `figures drawn at step ${f.step}`);
    }
    assert.ok(moving > 0.5 / H, `${moving} steps with a guard running out`);
  });

  it("when the guard run down before the clip is checked in every step, then he is never standing", () => {
    for (const f of frames) {
      assert.equal(f.mode[DOWN_GUARD], GUARD_DOWN, `step ${f.step}`);
      assert.equal((f.mask >> (1 + DOWN_GUARD)) & 1, 0, `drawn at step ${f.step}`);
    }
  });

  it("when a car of the clip runs a guard down, then the clip throws him once, as a ragdoll, and he is on the ground in the squad from that step on", () => {
    const thrown = frames.flatMap((f) => f.thrown.map((guard) => ({ step: f.step, guard })));
    const live = run.struck.filter((x) => x.step >= run.start && run.clip.cars.some((c) => c.slot === x.car));
    assert.ok(live.length > 0, "the runner ran a guard down");
    assert.equal(thrown.map((x) => `${x.step}:${x.guard}`).join(), live.map((x) => `${x.step}:${x.guard}`).join(), "thrown once each, at the live strikes' steps");
    assert.equal(new Set(thrown.map((x) => x.guard)).size, thrown.length, "no guard twice");
    for (const x of thrown) for (const f of frames) if (f.step >= x.step) assert.equal(f.mode[x.guard], GUARD_DOWN, `guard ${x.guard} at step ${f.step}`);
  });

  it("when the clip is restarted, then the squad starts again from the clip's start and plays the same", () => {
    const again = replay(run).frames;
    assert.equal(again.map((f) => f.mode.join()).join("|"), frames.map((f) => f.mode.join()).join("|"), "modes");
    assert.equal(again.map((f) => f.thrown.join()).join("|"), frames.map((f) => f.thrown.join()).join("|"), "figures thrown");
    assert.equal(sim.squad!.shots, run.clip.squad!.events.filter((e) => e.kind === SQUAD_SHOT).length, "shots handed to the squad");
  });
});

describe("given the squad firing on a parked car and a car run down a guard that the clip leaves out, the clip's own pair crashing 300 m away", () => {
  let run: Run;
  let frames: ReplayFrame[];
  before(() => {
    const post = guardPost();
    run = race({ x: post.x + 300, z: post.z + 8 }, 3);
    ({ frames } = replay(run));
  });

  it("when the clip is filed, then it lists the run-down guard and the target as a car the clip leaves out, and no shot at it", () => {
    const squad = run.clip.squad!;
    assert.ok(!run.clip.cars.some((c) => c.slot === 0 || c.slot === 3), "neither the parked car nor the runner is in the clip");
    assert.equal(squad.state[1], CLIP_OUT_CAR, "the target is a car the clip leaves out");
    assert.ok(squad.events.filter((e) => e.kind === SQUAD_DOWN).length > 0, "the run-down is listed");
    assert.equal(squad.events.filter((e) => e.kind === SQUAD_SHOT).length, 0, "no shot is listed");
    assert.ok(squad.events.every((e) => e.kind !== SQUAD_TARGET || e.a !== 0), "no target is a clip car");
    assert.equal(run.clip.strikes.length, 0, "no strike: its car is not in the clip");
  });

  it("when the clip is replayed, then every guard is where the live run had him, the run-down one is on the ground, and nobody is thrown", () => {
    for (const f of frames) {
      assert.equal(f.mode.join(), run.trace[f.step]!.mode.join(), `modes at step ${f.step}`);
      assert.equal(f.thrown.length, 0, `thrown at step ${f.step}`);
    }
    const live = run.struck.filter((x) => x.step >= run.start);
    assert.ok(live.length > 0, "the fourth car ran a guard down");
    for (const x of live) assert.equal(frames[frames.length - 1]!.mode[x.guard], GUARD_DOWN, `guard ${x.guard}`);
  });
});
