import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { PoseBlend } from "../present/pose-blend.ts";
import { assertSameNumbers, paint } from "../vehicle/test-support.ts";
import { newWorld, settleStep, stepWorld } from "./world-step.ts";
import { PACE_BUDGET_MS, SimPacer } from "./sim-pace.ts";

const V = 30;
const SPIN = 1.2;
const FAST = 30;

/** A seeded uniform in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

type Drawn = { worst: number; worstYaw: number; steps: number[] };

/**
 * A car moving straight at `V` m/s and turning at `SPIN` rad/s, stepped by the pacer in `hz` frames (each `jitter`
 * longer or shorter at random), drawn by the blend or not: how far its drawn place and heading are from where its
 * constant motion has them at the frame's time (m, rad), and the steps each frame ran.
 */
function drawn(hz: number, jitter: number, blend: boolean, scale = 1): Drawn {
  const car = new DeformableCar(paint(), new THREE.Scene());
  const pace = new SimPacer();
  const pose = new PoseBlend();
  const cars = [car];
  const next = rng(7);
  let simTime = 0;
  const out: Drawn = { worst: 0, worstYaw: 0, steps: [] };
  for (let f = 0; f < 3 * hz; f++) {
    const dt = (1 / hz) * (1 + jitter * (next() * 2 - 1));
    simTime += dt * scale;
    pace.run(dt * scale, scale, FAST, Infinity, (h) => {
      pose.begin(cars);
      car.group.position.z += V * h;
      car.group.rotation.y += SPIN * h;
      pose.end(cars);
    });
    const was = [car.group.position.z, car.group.rotation.y];
    if (blend) pose.present(cars, pace.alpha);
    if (f > 2) {
      out.worst = Math.max(out.worst, Math.abs(car.group.position.z - V * simTime));
      const d = 2 * Math.atan2(car.group.quaternion.y, car.group.quaternion.w) - SPIN * simTime;
      out.worstYaw = Math.max(out.worstYaw, Math.abs(Math.atan2(Math.sin(d), Math.cos(d))));
    }
    pose.restore();
    assertSameNumbers([car.group.position.z, car.group.rotation.y], was, "restore puts the sim's own pose back");
    out.steps.push(pace.steps);
  }
  car.dispose();
  return out;
}

describe("given a car moving straight at 30 m/s while turning at 1.2 rad/s, drawn between its fixed sim steps by the pose blend", () => {
  for (const hz of [60, 144, 165, 240]) {
    for (const jitter of [0, 0.35]) {
      it(`when frames come at ${hz} Hz, ${jitter * 100}% uneven, then the drawn car is within 1 µm and 1 µrad of where its motion puts it at the frame's time (undrawn it is up to a step's travel off)`, () => {
        const on = drawn(hz, jitter, true);
        const off = drawn(hz, jitter, false);
        assert.ok(on.worst < 1e-6, `blended: ${on.worst} m off`);
        assert.ok(on.worstYaw < 1e-6, `blended: ${on.worstYaw} rad off`);
        // The control: without the blend the frame shows the state the last step left, up to a slice of travel ahead
        // (60 and 240 Hz frames that are whole slices land on a step's end: nothing to blend there).
        const whole = jitter === 0 && (hz === 60 || hz === 240);
        assert.ok(whole || off.worst > 0.01, `undrawn control only ${off.worst} m off: this test could not have failed`);
      });
    }
  }

  it("when frames come 1 ms apart (shorter than a step) or at 240 Hz, then most 1 ms frames run no step yet the car is still drawn on its motion, and every 240 Hz frame runs exactly one step", () => {
    const slow = drawn(1000, 0, true);
    assert.ok(slow.steps.filter((s) => s === 0).length > slow.steps.length / 2, "frames shorter than a step run none");
    assert.ok(slow.worst < 1e-6, `${slow.worst} m off`);
    const same = drawn(240, 0, true).steps.slice(10);
    assert.ok(same.every((s) => s === 1), `steps per frame ${[...new Set(same)]}`);
  });

  it("when the sim runs in slow motion at 60 or 240 Hz, then each step covers less sim time, so a frame still runs a step (after the first few) and the car is still drawn on its motion", () => {
    for (const hz of [60, 240]) {
      const slow = drawn(hz, 0, true, 0.032);
      assert.ok(slow.steps.slice(5).every((s) => s >= 1), `${hz} Hz: frames with no step ${slow.steps.filter((s) => s === 0).length}`);
      assert.ok(slow.worst < 1e-6, `${hz} Hz: ${slow.worst} m off`);
    }
  });
});

describe("given a frame that cannot afford all its steps (its time budget runs out)", () => {
  /** The pre-pacer loop: the frame's time added to `acc` (clamped to 0.05), drained in slices, a `break` on the frame's budget. */
  function oldLoop(frames: readonly { dt: number; over: boolean }[]): number[] {
    let acc = 0;
    return frames.map(({ dt, over }) => {
      acc = Math.min(0.05, acc + dt);
      let adv = 0;
      for (let n = 0; acc > 1e-5 && n < 8; n++) {
        const h = Math.min(acc, 1 / 240);
        adv += h;
        acc -= h;
        if (n >= 1 && over) break;
      }
      return adv;
    });
  }

  /** Sim seconds each frame advanced under the pacer, a late frame's deadline already past. */
  function paced(frames: readonly { dt: number; over: boolean }[]): { adv: number[]; lost: number } {
    const pace = new SimPacer();
    const adv = frames.map(({ dt, over }) => {
      let a = 0;
      pace.run(dt, 1, FAST, over ? -Infinity : Infinity, (h) => (a += h));
      return a;
    });
    return { adv, lost: pace.lost };
  }

  const dt = 1 / 60;
  const frames = Array.from({ length: 30 }, (_, i) => ({ dt, over: i === 10 || i === 20 }));

  it("when one late frame misses its steps, then only that frame's time is lost and the next frames advance their own time, where the old catch-up loop ran a burst of extra steps", () => {
    const old = oldLoop(frames);
    assert.ok(Math.max(...old.slice(11, 15)) > 1.4 * dt, `the old loop's catch-up frame advanced only ${Math.max(...old.slice(11, 15))} s: no lurch to cure`);
    const { adv, lost } = paced(frames);
    for (let i = 0; i < frames.length; i++) {
      if (frames[i]!.over) assert.ok(Math.abs(adv[i]! - 2 / 240) < 1e-6, `late frame ${i} stepped ${adv[i]} s`);
      else assert.ok(Math.abs(adv[i]! - dt) < 1 / 240 + 1e-6, `frame ${i} advanced ${adv[i]} s, a frame is ${dt}`);
    }
    const missed = 2 * (dt - 2 / 240);
    assert.ok(Math.abs(lost - missed) < 2e-3, `lost ${lost} s, the two late frames ran ${missed} s short`);
  });

  it("when the sim is behind in every frame, then it runs slow by the same share in each frame", () => {
    const { adv } = paced(Array.from({ length: 20 }, () => ({ dt, over: true })));
    assert.ok(adv.every((a) => Math.abs(a - adv[0]!) < 1e-9), `advances ${[...new Set(adv)]}`);
  });
});

describe("given a head-on crash at 165 Hz frames, with or without the pose drawn between the steps", () => {
  /** A head-on crash at 165 Hz frames, drawn between the steps (or not): every car's state after every frame. */
  function crash(blend: boolean): { states: Float64Array[]; blended: number; freed: number } {
    const scene = new THREE.Scene();
    const cars = [0, 1].map((i) => {
      const car = new DeformableCar(paint(), scene);
      car.spawnFacing(i * 11, 0, i === 0 ? Math.PI / 2 : -Math.PI / 2, 22);
      return car;
    });
    const w = newWorld(cars);
    const pace = new SimPacer();
    const pose = new PoseBlend();
    const states: Float64Array[] = [];
    let blended = 0;
    let freed = 0;
    for (let f = 0; f < 165; f++) {
      pace.run(1 / 165, 1, 22, Infinity, (h) => {
        pose.begin(cars);
        stepWorld(w, h);
        settleStep(cars, h, false);
        pose.end(cars);
      });
      const before = cars.map((c) => c.group.position.clone());
      if (blend) {
        pose.present(cars, pace.alpha);
        scene.updateMatrixWorld(true);
        blended += cars.filter((c, i) => c.group.position.distanceTo(before[i]!) > 1e-9).length;
        const loose: THREE.Object3D[] = [];
        for (const c of cars) c.freeObjects(loose);
        freed += loose.length;
        pose.restore();
      }
      const s: number[] = [];
      for (const c of cars) {
        s.push(...c.group.position.toArray(), ...c.group.quaternion.toArray(), c.group.rotation.x, c.group.rotation.y, c.group.rotation.z, ...c.velocity.toArray(), ...c.angular.toArray(), c.yaw, c.pitch, c.roll);
        for (const m of c.deform.masses) s.push(m.world.x, m.world.y, m.world.z);
        s.push(...c.group.matrixWorld.elements);
        const loose: THREE.Object3D[] = [];
        c.freeObjects(loose);
        for (const o of loose) s.push(...o.position.toArray(), ...o.quaternion.toArray(), o.rotation.x, o.rotation.y, o.rotation.z);
      }
      states.push(Float64Array.from(s));
    }
    for (const c of cars) c.dispose();
    return { states, blended, freed };
  }

  it("when the crash that tears parts off is run with the pose drawn between its steps every frame, then every frame ends in exactly the same bits as the same crash never drawn", () => {
    const off = crash(false);
    const on = crash(true);
    assert.ok(on.blended > 100, `the blend moved a car in only ${on.blended} frame-cars: nothing was drawn between steps`);
    assert.ok(on.freed > 0, "no part or wheel flew free: the free bodies were never blended");
    for (let f = 0; f < off.states.length; f++) assertSameNumbers(on.states[f]!, off.states[f]!, `frame ${f}`);
  });
});

describe("given a car drawn between steps by the pose blend, where blending would smear it", () => {
  function two() {
    const car = new DeformableCar(paint(), new THREE.Scene());
    const pose = new PoseBlend();
    const cars = [car];
    return { car, pose, cars };
  }

  it("when the car was placed more than 5 m in one step, then it is drawn where it landed", () => {
    const { car, pose, cars } = two();
    pose.begin(cars);
    car.group.position.x += 100;
    pose.end(cars);
    pose.present(cars, 0.3);
    assert.equal(car.group.position.x, 100);
  });

  it("when the car is moved after the step (a respawn between frames), then it is drawn where it was put and kept there once the blend is undone", () => {
    const { car, pose, cars } = two();
    pose.begin(cars);
    car.group.position.x += 1;
    pose.end(cars);
    car.group.position.x = 3;
    pose.present(cars, 0.3);
    assert.equal(car.group.position.x, 3);
    pose.restore();
    assert.equal(car.group.position.x, 3);
  });

  it("when the car is drawn halfway between a heading of 3 rad and one of -3 rad, then it is halfway along its path and its heading is π, the short way round", () => {
    const { car, pose, cars } = two();
    car.group.rotation.set(0, 3, 0, "YXZ");
    pose.begin(cars);
    car.group.position.x = 2;
    car.group.rotation.set(0, -3, 0, "YXZ");
    pose.end(cars);
    pose.present(cars, 0.5);
    assert.ok(Math.abs(car.group.position.x - 1) < 1e-12);
    // 3 and -3 rad are 2π − 6 ≈ 0.283 rad apart through π.
    assert.ok(Math.abs(Math.abs(car.group.rotation.y) - Math.PI) < 0.01, `heading ${car.group.rotation.y}`);
  });
});

/**
 * A device on a virtual clock: each step costs `stepMs(t)` ms, each frame's draw `drawMs`, and a frame lands on the next vblank of an `hz`
 * display (what `.bench/phone-model.ts` runs on the real sim). The pacer's deadline is the engine's: `PACE_BUDGET_MS` from the frame's start.
 * `tickMs` > 0 rounds every clock reading down to whole ticks of that size, as a privacy-hardened browser's `performance.now()` does.
 */
function device(adaptive: boolean, stepMs: (t: number, n: number) => number, drawMs: number, hz: number, seconds: number, scale = 1, pin: boolean | null = null, tickMs = 0) {
  let t = 0;
  let n = 0;
  const clock = () => (tickMs > 0 ? Math.floor(t / tickMs) * tickMs : t);
  const pace = new SimPacer(adaptive, clock);
  pace.pin = pin;
  const period = 1000 / hz;
  let dt = period;
  let stepped = 0;
  const log: { at: number; sim: number; h: number }[] = [];
  while (t < seconds * 1000) {
    const t0 = t;
    pace.run((dt / 1000) * scale, scale, FAST, clock() + PACE_BUDGET_MS, (h) => {
      t += stepMs(t, n++);
      stepped += h;
      log.push({ at: t, sim: stepped, h });
    });
    t += drawMs;
    dt = Math.min(100, Math.max(period, Math.ceil((t - t0) / period - 1e-9) * period));
    t = t0 + dt; // the next frame starts at the vblank
  }
  return { pace, log, speed: stepped / scale / (t / 1000) };
}

describe("given the adaptive pacer, which steps the sim at 1/120 s on a device that cannot keep up with 1/240 s steps", () => {
  const fine = Math.fround(1 / 240);
  const coarse = Math.fround(1 / 120);

  it("when the device keeps up (0.8 ms a step, 4 ms of draw, a 90 Hz screen), then it steps at 1/240 s throughout, at the very times the fixed pacer steps", () => {
    const on = device(true, () => 0.8, 4, 90, 8);
    const off = device(false, () => 0.8, 4, 90, 8);
    assert.equal(on.pace.coarseSteps, 0);
    assert.ok(on.log.every((e) => e.h === fine));
    assert.equal(on.log.length, off.log.length);
    assert.ok(on.log.every((e, i) => e.h === off.log[i]!.h && e.at === off.log[i]!.at), "the same steps at the same times");
  });

  it("when the device cannot afford 1/240 s steps (4.7 ms each, 9.4 ms of draw, a 90 Hz screen), then the fixed pacer runs under 0.45 of real time while the adaptive one settles at 1/120 s and gets its sim speed back", () => {
    const off = device(false, () => 4.7, 9.4, 90, 20);
    const on = device(true, () => 4.7, 9.4, 90, 20);
    assert.ok(off.speed < 0.45, `the fixed pacer runs at ${off.speed}`);
    assert.ok(on.speed > 0.7 && on.speed > 1.8 * off.speed, `adaptive ${on.speed} vs fixed ${off.speed}`);
    assert.ok(on.log.slice(-200).every((e) => e.h === coarse), "settled at 1/120 s");
    assert.ok(on.pace.coarseSteps > 0.8 * on.pace.total);
  });

  it("when the load is heavy for 6 s and then light, then the step size is chosen before a frame's first step, each size is held for about a second, and it returns to 1/240 s once the load goes", () => {
    // Heavy for 6 s, then light: 4.7 ms a step, then 0.6.
    const d = device(true, (t) => (t < 6000 ? 4.7 : 0.6), 5, 90, 14);
    let flips = 0;
    let last = d.log[0]!;
    let since = 0;
    for (const e of d.log) {
      if (e.h !== last.h) {
        flips++;
        assert.ok(e.at - since >= 950, `a mode lasted ${e.at - since} ms`);
        since = e.at;
      }
      last = e;
    }
    assert.ok(flips >= 2, `${flips} mode changes`);
    assert.equal(d.log[0]!.h, fine);
    assert.ok(d.log.slice(-200).every((e) => e.h === fine), "back at 1/240 s once the load is gone");
    assert.ok(d.log.some((e) => e.h === coarse));
  });

  it("when one hitch (a 40 ms step, then a 100 ms frame) hits a fast device, then it never leaves 1/240 s steps", () => {
    const d = device(true, (_t, n) => (n === 700 ? 40 : 0.8), 4, 90, 10);
    assert.equal(d.pace.coarseSteps, 0);
  });

  it("when the load is heavy in slow motion at a quarter of real time, then the coarse step is the scaled 1/120 s step and the wait before the first change counts wall seconds", () => {
    const d = device(true, () => 6, 4, 90, 12, 0.25);
    assert.ok(d.log.slice(-100).every((e) => e.h === Math.fround(coarse * 0.25)));
    const first = d.log.findIndex((e) => e.h !== d.log[0]!.h);
    assert.ok(d.log[first]!.at >= 950, `first change ${d.log[first]!.at} ms in`);
  });

  it("good: a pinned floor holds against the cost either way, and unpinned the pacer adapts again", () => {
    // Heavy steps would drive the adaptive pacer coarse; pinned fine it stays fine (and loses sim time), and a cheap device pinned coarse stays coarse.
    const heavyFine = device(true, () => 4.7, 9.4, 90, 8, 1, false);
    assert.equal(heavyFine.pace.coarseSteps, 0);
    assert.ok(heavyFine.log.every((e) => e.h === fine));
    assert.ok(heavyFine.speed < 0.5, `pinned fine, ${heavyFine.speed}`);
    const cheapCoarse = device(true, () => 0.5, 4, 90, 8, 1, true);
    assert.ok(cheapCoarse.log.every((e) => e.h === coarse));
    assert.ok(cheapCoarse.speed > 0.99, `pinned coarse, ${cheapCoarse.speed}`);
    const free = device(true, () => 4.7, 9.4, 90, 8);
    assert.ok(free.pace.coarseSteps > 0 && free.speed > heavyFine.speed + 0.2, "unpinned: the adaptive pacer is back");
  });
});

describe("given the engine's pacer in a browser whose clock reads only in coarse ticks (privacy-hardened Firefox, Tor), so a step cannot be timed", () => {
  const coarse = Math.fround(1 / 120);
  const coarseClockCases = [
    { it: "when the clock ticks every 16.7 ms and a step costs 1 ms, then the sim keeps real time in 1/120 s steps and no frame is cut short", tickMs: 1000 / 60, stepMs: 1 },
    { it: "when the clock ticks every 16.7 ms and a step costs 3 ms, then the sim keeps real time in 1/120 s steps and no frame is cut short", tickMs: 1000 / 60, stepMs: 3 },
    { it: "when the clock ticks every 4 ms and a step costs 1 ms, then the sim keeps real time in 1/120 s steps and no frame is cut short", tickMs: 4, stepMs: 1 },
    { it: "when the clock ticks every 4 ms and a step costs 3 ms, then the sim keeps real time in 1/120 s steps and no frame is cut short", tickMs: 4, stepMs: 3 },
  ] as const;
  for (const testCase of coarseClockCases) {
    it(`${testCase.it} (4 ms of draw, a 90 Hz screen)`, () => {
      const d = device(true, () => testCase.stepMs, 4, 90, 8, 1, null, testCase.tickMs);
      assert.ok(d.speed > 0.99, `sim speed ${d.speed}`);
      assert.equal(d.pace.cut, 0, `${d.pace.cut} frames cut short`);
      assert.ok(d.log.slice(-200).every((e) => e.h === coarse), "settled at 1/120 s");
    });
  }

  const fineClockCases = [
    { it: "when the clock ticks every 0.1 ms and a step costs 0.05 ms, then it steps exactly as on an exact clock", stepMs: 0.05, drawMs: 4 },
    { it: "when the clock ticks every 0.1 ms and a step costs 0.8 ms, then it steps exactly as on an exact clock", stepMs: 0.8, drawMs: 4 },
    { it: "when the clock ticks every 0.1 ms and a step costs 4.7 ms with 9.4 ms of draw, then it steps exactly as on an exact clock", stepMs: 4.7, drawMs: 9.4 },
  ] as const;
  for (const testCase of fineClockCases) {
    it(`${testCase.it} (a 90 Hz screen)`, () => {
      const exact = device(true, () => testCase.stepMs, testCase.drawMs, 90, 8);
      const ticked = device(true, () => testCase.stepMs, testCase.drawMs, 90, 8, 1, null, 0.1);
      assert.equal(ticked.log.length, exact.log.length);
      assert.ok(ticked.log.every((e, i) => e.h === exact.log[i]!.h && e.at === exact.log[i]!.at), "the same steps at the same times");
      assert.equal(ticked.pace.cut, exact.pace.cut);
    });
  }
});
