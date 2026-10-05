import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeCar, runWall } from "../contact/crash-scenarios.test-util.ts";
import { DOOR_INERTIA, DOOR_OPEN_MAX, HINGE_TEAR_J, MIRROR_BREAK_J, MIRROR_FOLD_MAX, SLAM_TEAR_J } from "../vehicle/car-core.ts";
import type { DoorScenario, RamShot } from "./door-rig.ts";
import { fireRam } from "./door-rig.test-util.ts";
import { assertSameDigest } from "../vehicle/test-support.ts";

/**
 * Door/mirror knock scenes (docs/DOOR_RIG.md, sketch docs/door-mirror-sketch.png). A ram on a lane
 * beside a parked car: A grazes the shut door's mirror, B drives the open door past its stop,
 * C drives the open door shut. The ram only meets the door and mirror colliders, so the body
 * (control particles and skinned vertices) must not move at all; 1 mm is the tolerance.
 */

const BODY_TOL_MM = 1;
const R2D = 180 / Math.PI;
/** Ram mass (kg) at `kph` carrying `share` × the mirror's break energy. */
const kgFor = (share: number, kph: number): number => (2 * share * MIRROR_BREAK_J) / (kph / 3.6) ** 2;

type Case = {
  scenario: DoorScenario;
  level: string;
  kph: number;
  kg: number;
  /** Parts off the car, as door/mirror without the L/R suffix. */
  off: ("door" | "mirror")[];
  check: (r: RamShot) => void;
};

const CASES: Case[] = [
  {
    scenario: "mirror",
    level: "carrying 0.8× the mirror's break energy, where its fold stop holds",
    kph: 4,
    kg: kgFor(0.8, 4),
    off: [],
    check: (r) => {
      assert.ok(r.mirrorFoldDeg > MIRROR_FOLD_MAX * R2D - 1, `mirror folded only ${r.mirrorFoldDeg}°`);
      assert.ok(r.ramStopped, "the folded mirror's stop should have stopped the ram");
    },
  },
  { scenario: "mirror", level: "carrying 1.25× the mirror's break energy", kph: 4, kg: kgFor(1.25, 4), off: ["mirror"], check: () => {} },
  { scenario: "mirror", level: "as a fast heavy ram", kph: 50, kg: 1500, off: ["mirror"], check: () => {} },
  {
    scenario: "overOpen",
    level: "below the hinge tear threshold",
    kph: 5,
    kg: 120,
    off: [],
    check: (r) => {
      assert.ok(Math.abs(r.doorDeg - DOOR_OPEN_MAX * R2D) < 0.5, `door at ${r.doorDeg}°, not on its stop`);
      assert.ok(r.hingeLoadJ > 0 && r.hingeLoadJ < HINGE_TEAR_J, `hinge load ${r.hingeLoadJ} J`);
      assert.ok(r.ramStopped, "the strap should have stopped the ram");
    },
  },
  { scenario: "overOpen", level: "above the hinge tear threshold", kph: 15, kg: 300, off: ["door", "mirror"], check: () => {} },
  {
    scenario: "shut",
    level: "with low force, which re-closes the door",
    kph: 4,
    kg: 300,
    off: [],
    check: (r) => assert.ok(r.doorDeg < 0.01, `door left ${r.doorDeg}° open`),
  },
  { scenario: "shut", level: "with high force, which slams the door off", kph: 40, kg: 300, off: ["door", "mirror"], check: () => {} },
];

describe("given a ram on a lane beside a parked car (mirror: A grazes the shut door's mirror; overOpen: B drives the open door past its stop; shut: C drives the open door shut)", () => {
  for (const side of [-1, 1] as const) {
    const suffix = side < 0 ? "L" : "R";
    for (const c of CASES) {
      it(`when the ${c.scenario} ram hits the ${suffix} side ${c.level}, then the parts that come off are [${c.off.join(", ")}] and the body does not move more than 1 mm`, () => {
        const r = fireRam(makeCar(), c.scenario, { kph: c.kph, kg: c.kg, side });
        assertSameDigest([...r.detached].sort(), c.off.map((p) => p + suffix).sort(), `detached [${[...r.detached].sort()}]`);
        const doorOn = !c.off.includes("door");
        if (doorOn && c.scenario !== "overOpen") assert.ok(r.latched, "door should be shut and latched");
        assert.ok(r.bodyParticleMm <= BODY_TOL_MM, `control particles moved ${r.bodyParticleMm} mm`);
        assert.ok(r.bodyVertexMm <= BODY_TOL_MM, `skinned vertices moved ${r.bodyVertexMm} mm`);
        c.check(r);
      });
    }
  }
});

describe("given a car's right door swung from half a radian open at a chosen opening rate", () => {
  /** Opening rate (rad/s) whose swing carries `share` × `energy` (J). */
  const omegaFor = (share: number, energy: number): number => Math.sqrt((2 * share * energy) / DOOR_INERTIA);
  const swing = (theta: number, omega: number) => {
    const car = makeCar();
    car.setDoorOpen(1, theta);
    car.doorHinge(1).omega = omega;
    for (let i = 0; i < 120; i++) car.swingDoors(1 / 120);
    return car;
  };

  it("when it is swung shut at 0.9× and then 1.1× the slam limit, then the first latches shut and the second tears the door off", () => {
    const soft = swing(0.5, -omegaFor(0.9, SLAM_TEAR_J));
    assert.ok(!soft.partOff("doorR") && soft.doorHinge(1).latched && soft.doorHinge(1).theta === 0);
    assert.ok(swing(0.5, -omegaFor(1.1, SLAM_TEAR_J)).partOff("doorR"), "1.1× slam energy kept the door on");
  });

  // The old 1.1× fling reached the stop with 220 J (measured), the limit itself, on viscous damping alone; the hinge's dry friction
  // (DOOR_DRY, 2 rad/s²) takes it to 217 J. 1.2× is as far above the limit as the old 1.1× was meant to be.
  it("when it is flung open onto its stop at 0.9× and then 1.2× the hinge limit, then the first stays on at the stop and the second tears the door off together with its mirror", () => {
    const soft = swing(0.5, omegaFor(0.9, HINGE_TEAR_J));
    assert.ok(!soft.partOff("doorR"));
    assert.ok(Math.abs(soft.doorHinge(1).theta - DOOR_OPEN_MAX) < 0.05, `door at ${soft.doorHinge(1).theta * R2D}°`);
    const hard = swing(0.5, omegaFor(1.2, HINGE_TEAR_J));
    assert.ok(hard.partOff("doorR") && hard.partOff("mirrorR"), "door and its mirror should leave together");
  });
});

describe("given a car driven at 64 km/h head-on into a wall", () => {
  it("when the crash settles, then both doors stay on and both hinges are shut, latched and unloaded", () => {
    const car = makeCar();
    const r = runWall(64, 1, "front", { car });
    assert.ok(!r.detached.some((p) => p.startsWith("door")), `detached ${r.detached.join(",")}`);
    for (const side of [-1, 1]) {
      const h = car.doorHinge(side);
      assert.ok(h.latched && h.theta === 0 && h.load === 0, `side ${side} hinge ${JSON.stringify(h)}`);
    }
  });
});
