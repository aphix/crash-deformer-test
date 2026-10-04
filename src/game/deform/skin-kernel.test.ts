import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { applyDrive, idleDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { assignClass } from "../vehicle/vehicle-classes.ts";
import { assertSameNumbers } from "../vehicle/test-support.ts";
import { derbyRadius } from "../scenes/derby-arena.ts";
import { fleetClass, fleetStyle, layoutDerby, layoutFleet } from "../scenes/fleet.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { newWorld, settleStep, stepWorld } from "../engine/world-step.ts";
import { SkinKernel, skinKernel, type SkinDynamic } from "./skin-kernel.ts";
import { loadSkinKernelForTest } from "./skin-kernel.test-util.ts";

/**
 * The WASM skin (kernels/skin) is the JS skin's exact bits. The engine's own frame loop (accumulator of fixed steps,
 * `stepWorld`, `settleStep`, then `updateSkin` per car) runs the same seeded scenario twice: with no kernel loaded
 * (every car skins in JS), then with it. Every car's position and normal attribute (and their versions and the skin
 * flag) is hashed each frame, and the final arrays are compared element by element.
 */

type Seen = Record<"skins" | "wrinkled" | "hubs" | "lattice" | "deep", number>;
type Scenario = {
  label: string;
  derby: boolean;
  cars: number;
  frames: number;
  /** Runs before each frame. */
  setup?: (cars: DeformableCar[], frame: number) => void;
  /** What the JS leg must have seen, or the scenario does not exercise the branch it is named for. */
  covers: (keyof Seen)[];
};
type Leg = { digests: number[]; final: Float32Array[]; seen: Seen };

const popHub = (cars: DeformableCar[], frame: number): void => {
  if (frame !== 60) return;
  for (const car of cars.slice(0, 3)) {
    const hub = car.deform.masses.find((m) => m.name === "hubFL");
    if (hub) hub.popped = true;
  }
};

const SCENARIOS: Scenario[] = [
  { label: "a 10-car fleet pile-up (shape skin, wrinkle)", derby: false, cars: 10, frames: 240, covers: ["skins", "wrinkled"] },
  { label: "a 10-car derby", derby: true, cars: 10, frames: 300, covers: ["skins", "wrinkled"] },
  {
    label: "cars in lattice mode",
    derby: false,
    cars: 6,
    frames: 200,
    setup: (cars, frame) => {
      if (frame === 0) for (const i of [0, 3]) cars[i]!.deform.setMode("lattice");
    },
    covers: ["skins", "lattice"],
  },
  {
    label: "a deep-crush bidirectional car (compactor rules)",
    derby: true,
    cars: 6,
    frames: 200,
    setup: (cars, frame) => {
      if (frame === 0) {
        cars[0]!.deform.deepCrush = true;
        cars[0]!.deform.bidirectional = true;
      }
    },
    covers: ["skins", "deep"],
  },
  { label: "popped hubs (wheel-arch paint)", derby: false, cars: 6, frames: 200, setup: popHub, covers: ["skins", "hubs"] },
];

const FNV = 16777619;

function numberField(o: object, key: string): number {
  const v: unknown = Reflect.get(o, key);
  assert.ok(typeof v === "number", key);
  return v;
}

function play(s: Scenario): Leg {
  const scene = new THREE.Scene();
  const cars = Array.from({ length: s.cars }, (_, i) => new DeformableCar({ body: 0xc5c8ce, accent: 0x9aa0a8, name: `c${i}` }, scene, null, fleetStyle(i)));
  cars.forEach((c, i) => assignClass(c, fleetClass(i)));
  let seed = 11;
  const rng = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  if (s.derby) {
    const slots = layoutDerby(s.cars, derbyRadius(s.cars), rng);
    cars.forEach((c, i) => c.spawnFacing(slots[i]!.x, slots[i]!.z, slots[i]!.yaw, 12));
  } else {
    const slots = layoutFleet(s.cars, 18, 28, rng);
    cars.forEach((c, i) => c.spawn(slots[i]!.x, slots[i]!.z, slots[i]!.speed));
  }
  const inputs: DriveInput[] = cars.map(() => ({ ...idleDrive(), throttle: 1 }));
  const world = newWorld(cars);
  const seen: Seen = { skins: 0, wrinkled: 0, hubs: 0, lattice: 0, deep: 0 };
  const digests: number[] = [];
  let acc = 0;
  for (let f = 0; f < s.frames; f++) {
    s.setup?.(cars, f);
    const vmax = sliceSpeed(cars);
    acc = Math.min(0.05, acc + 1 / 60);
    for (let n = 0; acc > 1e-5 && n < 8; n++) {
      const h = physicsSlice(acc, vmax);
      if (s.derby) {
        for (let i = 0; i < cars.length; i++) {
          const c = cars[i]!;
          const p = c.group.position;
          inputs[i]!.steer = c.fwdFlat.x * -p.z - c.fwdFlat.z * -p.x > 0 ? -1 : 1;
          if (c.deform.drivetrainAlive) applyDrive(c, inputs[i]!, h);
        }
      }
      stepWorld(world, h);
      settleStep(cars, h, true);
      acc -= h;
    }
    for (const c of cars) c.updateSkin();
    let hash = 0x811c9dc5;
    for (const c of cars) {
      const d = c.deform;
      if (d.skinnedThisFrame) {
        seen.skins++;
        if (numberField(d, "wrinkleAmp") * Math.min(1, numberField(d, "elapsed") * 6) > 0.02) seen.wrinkled++;
        if (d.mode === "lattice") seen.lattice++;
        if (d.deepCrush) seen.deep++;
        const hubOf: unknown = Reflect.get(d, "skinHub");
        assert.ok(hubOf instanceof Int32Array);
        if (d.masses.some((m, j) => m.popped && hubOf.includes(j))) seen.hubs++;
      }
      hash = Math.imul(hash ^ (d.skinnedThisFrame ? 1 : 0), FNV);
      for (const name of ["position", "normal"]) {
        const a = c.body.geometry.getAttribute(name) as THREE.BufferAttribute;
        const words = new Uint32Array(a.array.buffer, 0, a.array.length);
        for (let i = 0; i < words.length; i++) hash = Math.imul(hash ^ words[i]!, FNV);
        hash = Math.imul(hash ^ a.version, FNV);
      }
    }
    digests.push(hash >>> 0);
  }
  const final = cars.flatMap((c) => ["position", "normal"].map((name) => Float32Array.from(c.body.geometry.getAttribute(name).array)));
  return { digests, final, seen };
}

/** `play` with every `SkinKernel.run` counted, and `mutate` (a deliberately wrong input) applied before it. */
function playOnKernel(s: Scenario, mutate?: (d: SkinDynamic) => void): { leg: Leg; runs: number } {
  const real = SkinKernel.prototype.run;
  let runs = 0;
  SkinKernel.prototype.run = function (this: SkinKernel, ...args: Parameters<SkinKernel["run"]>) {
    runs++;
    mutate?.(args[1]);
    return real.apply(this, args);
  };
  try {
    return { leg: play(s), runs };
  } finally {
    SkinKernel.prototype.run = real;
  }
}

describe("WASM skin and normals", () => {
  const js = new Map<Scenario, Leg>();
  before(async () => {
    assert.equal(skinKernel(), null, "the JS legs run before the kernel loads");
    for (const s of SCENARIOS) js.set(s, play(s));
    await loadSkinKernelForTest();
    assert.ok(skinKernel(), "the kernel loaded");
  });

  for (const s of SCENARIOS) {
    it(`good: ${s.label} leaves the JS skin's bits, frame by frame`, () => {
      const ref = js.get(s)!;
      for (const key of s.covers) assert.ok(ref.seen[key] > 0, `the scenario never skinned with ${key}`);
      const { leg, runs } = playOnKernel(s);
      assert.ok(runs >= ref.seen.skins, `${runs} kernel runs for ${ref.seen.skins} skinned car-frames: some skins stayed in JS`);
      assertSameNumbers(leg.digests, ref.digests, "per-frame digest");
      assert.equal(leg.final.length, ref.final.length);
      leg.final.forEach((a, i) => assertSameNumbers(a, ref.final[i]!, `car ${i >> 1} ${i % 2 ? "normals" : "positions"}`));
    });
  }

  it("bad: dropping one parameter (shape mode) changes the digests, so the comparison can fail", () => {
    const s = SCENARIOS[0]!;
    const { leg } = playOnKernel(s, (d) => {
      d.params[8] = 0;
    });
    assert.ok(
      leg.digests.some((h, f) => h !== js.get(s)!.digests[f]),
      "a kernel reading the lattice branch in shape mode must not match",
    );
  });
});
