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

describe("a car is drawn where its motion has it at the frame's time", () => {
  for (const hz of [60, 144, 165, 240]) {
    for (const jitter of [0, 0.35]) {
      it(`good: ${hz} Hz, frames ${jitter * 100}% uneven: within 1 µm and 1 µrad of the motion at the frame's time (undrawn: up to a step's travel off)`, () => {
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

  it("good: a frame that falls inside one step ran no step, and every frame at 240 Hz ran one", () => {
    const slow = drawn(1000, 0, true);
    assert.ok(slow.steps.filter((s) => s === 0).length > slow.steps.length / 2, "frames shorter than a step run none");
    assert.ok(slow.worst < 1e-6, `${slow.worst} m off`);
    const same = drawn(240, 0, true).steps.slice(10);
    assert.ok(same.every((s) => s === 1), `steps per frame ${[...new Set(same)]}`);
  });

  it("good: in slow motion each step covers less sim time, so a frame still runs a step and the car still follows the frame's time", () => {
    for (const hz of [60, 240]) {
      const slow = drawn(hz, 0, true, 0.032);
      assert.ok(slow.steps.slice(5).every((s) => s >= 1), `${hz} Hz: frames with no step ${slow.steps.filter((s) => s === 0).length}`);
      assert.ok(slow.worst < 1e-6, `${hz} Hz: ${slow.worst} m off`);
    }
  });
});

describe("a frame that cannot afford its steps never leaves a debt behind", () => {
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

  it("bad: one late frame costs that frame's time alone: the next ones advance their own, where the old loop caught up in a burst", () => {
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

  it("good: a sim that is behind in every frame runs slow by the same share each frame", () => {
    const { adv } = paced(Array.from({ length: 20 }, () => ({ dt, over: true })));
    assert.ok(adv.every((a) => Math.abs(a - adv[0]!) < 1e-9), `advances ${[...new Set(adv)]}`);
  });
});

describe("the blend leaves the sim exactly as it was", () => {
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

  it("bad: a crash that tears parts off, run drawn between its steps every frame, ends every frame in the bits of the same crash never drawn", () => {
    const off = crash(false);
    const on = crash(true);
    assert.ok(on.blended > 100, `the blend moved a car in only ${on.blended} frame-cars: nothing was drawn between steps`);
    assert.ok(on.freed > 0, "no part or wheel flew free: the free bodies were never blended");
    for (let f = 0; f < off.states.length; f++) assertSameNumbers(on.states[f]!, off.states[f]!, `frame ${f}`);
  });
});

describe("a body is drawn as it stands when the blend would smear it", () => {
  function two() {
    const car = new DeformableCar(paint(), new THREE.Scene());
    const pose = new PoseBlend();
    const cars = [car];
    return { car, pose, cars };
  }

  it("good: a car placed more than 5 m in one step is drawn where it landed", () => {
    const { car, pose, cars } = two();
    pose.begin(cars);
    car.group.position.x += 100;
    pose.end(cars);
    pose.present(cars, 0.3);
    assert.equal(car.group.position.x, 100);
  });

  it("good: a car moved after the step (a respawn between frames) is drawn where it was put, and kept there", () => {
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

  it("good: halfway is halfway, the heading the short way round", () => {
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
 */
function device(adaptive: boolean, stepMs: (t: number, n: number) => number, drawMs: number, hz: number, seconds: number, scale = 1) {
  let t = 0;
  let n = 0;
  const pace = new SimPacer(adaptive, () => t);
  const period = 1000 / hz;
  let dt = period;
  let stepped = 0;
  const log: { at: number; sim: number; h: number }[] = [];
  while (t < seconds * 1000) {
    const t0 = t;
    pace.run((dt / 1000) * scale, scale, FAST, t + PACE_BUDGET_MS, (h) => {
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

describe("the adaptive slice", () => {
  const fine = Math.fround(1 / 240);
  const coarse = Math.fround(1 / 120);

  it("good: a device that keeps up steps at 1/240 s throughout, the very steps the fixed pacer takes", () => {
    const on = device(true, () => 0.8, 4, 90, 8);
    const off = device(false, () => 0.8, 4, 90, 8);
    assert.equal(on.pace.coarseSteps, 0);
    assert.ok(on.log.every((e) => e.h === fine));
    assert.equal(on.log.length, off.log.length);
    assert.ok(on.log.every((e, i) => e.h === off.log[i]!.h && e.at === off.log[i]!.at), "the same steps at the same times");
  });

  it("bad: a device that can't afford 1/240 s steps (4.7 ms each, 9.4 ms of draw, a 90 Hz screen) gets its sim speed back at 1/120 s", () => {
    const off = device(false, () => 4.7, 9.4, 90, 20);
    const on = device(true, () => 4.7, 9.4, 90, 20);
    assert.ok(off.speed < 0.45, `the fixed pacer runs at ${off.speed}`);
    assert.ok(on.speed > 0.7 && on.speed > 1.8 * off.speed, `adaptive ${on.speed} vs fixed ${off.speed}`);
    assert.ok(on.log.slice(-200).every((e) => e.h === coarse), "settled at 1/120 s");
    assert.ok(on.pace.coarseSteps > 0.8 * on.pace.total);
  });

  it("good: the mode is chosen before a frame's first step and held for a second, and it comes back when the load goes", () => {
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

  it("good: one hitch (a 40 ms step, then a 100 ms frame) on a fast device changes nothing", () => {
    const d = device(true, (_t, n) => (n === 700 ? 40 : 0.8), 4, 90, 10);
    assert.equal(d.pace.coarseSteps, 0);
  });

  it("good: in slow motion the coarse step is the scaled one, and the dwell counts wall seconds", () => {
    const d = device(true, () => 6, 4, 90, 12, 0.25);
    assert.ok(d.log.slice(-100).every((e) => e.h === Math.fround(coarse * 0.25)));
    const first = d.log.findIndex((e) => e.h !== d.log[0]!.h);
    assert.ok(d.log[first]!.at >= 950, `first change ${d.log[first]!.at} ms in`);
  });
});
