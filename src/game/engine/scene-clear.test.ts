import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { launch, makeCar, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { armKill, assignClass, DEFAULT_REALISM } from "../vehicle/vehicle-classes.ts";
import { paint } from "../vehicle/test-support.ts";
import { DebrisSystem, GlassDotSystem, SparkSystem, TireSmokeSystem } from "../present/engine-fx.ts";
import { SkidMarks } from "../present/engine-marks.ts";
import { RagdollSystem } from "../present/engine-ragdoll.ts";
import { RangeRun } from "../scenes/range.ts";
import type { LampPole } from "../scenes/engine-props.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import { clearTransients, type Transients } from "./scene-clear.ts";

// The fx pools paint their dot sprites on a canvas; the headless run lends them one that takes any draw (the cars want none).
const ctx = { createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, fillStyle: "" };
const CANVAS = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };

const V = new THREE.Vector3(0, 1, 0);
const UP = new THREE.Vector3(0, 1, 0);
const HUB = ["hubFL", "hubFR", "hubRL", "hubRR"];

type Rig = {
  scene: THREE.Scene;
  /** Scene root children once everything is built and nothing has been seeded: the scene's baseline. */
  base: number;
  t: Transients;
  marks: SkidMarks;
  cars: DeformableCar[];
  poles: LampPole[];
  debris: DebrisSystem;
  sparks: SparkSystem;
  glassDots: GlassDotSystem;
  smoke: TireSmokeSystem;
  ragdolls: RagdollSystem;
  rangeRun: RangeRun;
  tyreSmoke: TireSmokeSystem;
};

/** Four cars (the engine keeps built cars past the live count hidden), every pooled system, the six lamp poles. */
function rig(): Rig {
  const scene = new THREE.Scene();
  const cars = [0, 1, 2, 3].map((i) => {
    const c = new DeformableCar({ ...paint(), name: `c${i}` }, scene);
    c.group.visible = i < 2;
    scene.add(c.group);
    c.spawn(i * 12, 0, 0);
    return c;
  });
  const poles: LampPole[] = Array.from({ length: 6 }, () => {
    const group = new THREE.Group();
    scene.add(group);
    return { group, intact: true, radius: 0.12, kicked: new Set<string>() };
  });
  Object.defineProperty(globalThis, "document", { value: CANVAS, configurable: true });
  const debris = new DebrisSystem(scene);
  const sparks = new SparkSystem(scene);
  const glassDots = new GlassDotSystem(scene);
  const smoke = new TireSmokeSystem(scene);
  const ragdolls = new RagdollSystem(scene, () => {}, () => {});
  const tyreSmoke = new TireSmokeSystem(scene, 360, true);
  Reflect.deleteProperty(globalThis, "document");
  const rangeRun = new RangeRun();
  const marks = new SkidMarks(MAX_CARS);
  // `Cinematics` needs a WebGL renderer; its reset is these two clears.
  const cine = { reset: () => (marks.clear(), tyreSmoke.reset()) };
  const t: Transients = { cars, poles, debris, sparks, glassDots, smoke, ragdolls, rangeRun, cine };
  return { scene, base: scene.children.length, t, marks, cars, poles, debris, sparks, glassDots, smoke, ragdolls, rangeRun, tyreSmoke };
}

const alive = (life: Float32Array): number => life.filter((l) => l > 0).length;

/** Each system: how to put live objects in it, and how many it still holds. */
type Row = { seed(r: Rig): Promise<void> | void; left(r: Rig): number };

const ROWS: Record<keyof Transients, Row> = {
  // Loose wheels, torn panel shells and parts live in the scene root, not under the car: every car, hidden ones too.
  cars: {
    seed: (r) => {
      for (const c of r.cars) {
        c["detachPart"](c["parts"].find((p) => p.region)!, 12);
        c["detachPart"](c["parts"].find((p) => !p.region)!, 12);
        c["dropWheel"](0, HUB[0]!);
        c["dropWheel"](3, HUB[3]!);
      }
    },
    left: (r) => r.cars.reduce((n, c) => n + c["parts"].filter((p) => p.detached).length + c["looseWheels"].filter((w) => w.loose).length, 0),
  },
  poles: {
    seed: (r) =>
      r.poles.forEach((p) => {
        p.intact = false;
        p.kicked.add("c0");
        p.group.rotation.x = 1.4;
        p.group.position.set(3, 0.2, 3);
      }),
    left: (r) => r.poles.filter((p) => !p.intact || p.kicked.size > 0 || p.group.rotation.x !== 0).length,
  },
  debris: { seed: (r) => r.debris.burst(V, UP, 40), left: (r) => alive(r.debris["life"]) },
  sparks: { seed: (r) => r.sparks.poof(V, UP, 40), left: (r) => alive(r.sparks["life"]) },
  glassDots: { seed: (r) => r.glassDots.burst(V, UP, 40), left: (r) => alive(r.glassDots["life"]) },
  smoke: { seed: (r) => r.smoke.plume(V, UP, 40), left: (r) => alive(r.smoke["life"]) },
  // A head-on's two thrown drivers: the dummies out, and their Rapier bodies enabled.
  ragdolls: {
    seed: async (r) => {
      const a = makeCar();
      const b = makeCar();
      for (const c of [a, b]) {
        assignClass(c, "sedan");
        armKill(c.deform, "sedan", DEFAULT_REALISM, "default");
      }
      launch(a, -5, 0, Math.PI / 2, 20, 0);
      launch(b, 5, 0, -Math.PI / 2, -20, 0);
      const w = makeWorld([a, b], false, false);
      w.onEject = (e) => r.ragdolls.launch(e, [a, b]);
      await r.ragdolls.preload();
      for (let f = 0; f < 60; f++) {
        tickWorld(w);
        r.ragdolls.update(1 / 60, [a, b], true, true, 0, null);
      }
    },
    left: (r) => {
      const dolls: { live: boolean; bodies: { isEnabled(): boolean }[] }[] = r.ragdolls["dolls"];
      return dolls.filter((d) => d.live).length + dolls.flatMap((d) => d.bodies).filter((b) => b.isEnabled()).length;
    },
  },
  rangeRun: {
    seed: (r) => {
      r.rangeRun.distance = 31;
      r.rangeRun.landed = true;
    },
    left: (r) => (r.rangeRun.distance === null ? 0 : 1) + (r.rangeRun.landed ? 1 : 0),
  },
  // Tyre marks and the thin tyre smoke; the skid map is flagged for wiping by `clear`.
  cine: {
    seed: (r) => {
      r.marks["needsClear"] = false;
      r.tyreSmoke.plume(V, UP, 20);
    },
    left: (r) => (r.marks["needsClear"] ? 0 : 1) + alive(r.tyreSmoke["life"]),
  },
};

describe("a scene reset leaves nothing of the last scene behind", () => {
  for (const [name, row] of Object.entries(ROWS)) {
    it(`bad: seeded ${name} is empty after the reset`, async () => {
      const r = rig();
      await row.seed(r);
      assert.ok(row.left(r) > 0, `${name} was seeded`);
      clearTransients(r.t);
      assert.equal(row.left(r), 0, `${name} left over`);
      r.ragdolls.dispose();
    });
  }

  it("bad: every system seeded at once: nothing left in any, and the scene root is back at its baseline child count", async () => {
    const r = rig();
    for (const row of Object.values(ROWS)) await row.seed(r);
    assert.ok(r.scene.children.length > r.base, "loose parts hang in the scene root");
    clearTransients(r.t);
    const left = Object.entries(ROWS).map(([name, row]) => [name, row.left(r)] as const).filter(([, n]) => n > 0);
    assert.deepEqual(left, [], "systems with leftovers");
    assert.equal(r.scene.children.length, r.base, "scene root children");
    r.ragdolls.dispose();
  });
});
