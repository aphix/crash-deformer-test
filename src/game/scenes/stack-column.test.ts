import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { paint } from "../vehicle/test-support.ts";
import { DRIVER_CARS } from "../match/types.ts";
import { makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { fleetClass, fleetStyle, slotType, type CarType } from "./fleet.ts";
import { armKill, assignClass, carClass, HANDLING, killClass, type VehicleClassId } from "../vehicle/vehicle-classes.ts";
import type { CarStyleId } from "../vehicle/car-variants.ts";
import { placeDrop, StackRig, stackLoads, type StackConfig } from "./stack-rig.ts";

/** Which cars the column is made of: one sedan body, the fleet's slot order (police base) with or without its monster truck. */
type Bodies = "sedans" | "fleet" | "fleet without the monster" | { selected: CarType };

/**
 * The Stack scene's column, headless: the cars `buildCar` + `dressCar` make, dropped one at a time through `StackRig` and
 * `placeDrop` in the engine's own world step, `seconds` of sim time; `each` after every frame.
 */
function column(config: StackConfig, bodies: Bodies, seconds: number, each?: (cars: DeformableCar[]) => void): { cars: DeformableCar[]; rig: StackRig } {
  HANDLING.realism = 0.25;
  const scene = new THREE.Scene();
  const cars = Array.from({ length: config.cars }, (_, i) => {
    const picked = typeof bodies === "object" ? slotType(i, bodies.selected, true) : undefined;
    const sedan = bodies === "sedans" || (bodies === "fleet without the monster" && i > 0 && fleetClass(i) === "monster");
    const cls: VehicleClassId = picked ? picked.cls : sedan ? "sedan" : i === 0 ? "police" : fleetClass(i);
    const style: CarStyleId | undefined = picked ? picked.style : bodies === "sedans" ? undefined : sedan ? "sedan" : i === 0 ? "police" : fleetStyle(i);
    const car = new DeformableCar(paint(), scene, undefined, style);
    assignClass(car, cls);
    car.deform.squash = 0.32;
    car.deform.buckle = 0.45;
    car.deform.setMode("shape");
    armKill(car.deform, killClass(car), HANDLING.realism, "default");
    car.spawnFacing(i === 0 ? 0 : 48 + i * 4, i === 0 ? 0 : 48, 0, 0);
    car.deform.bindKinematic(car.group, car.velocity, car.angular);
    return car;
  });
  const rig = new StackRig();
  rig.config = { ...config };
  const w = makeWorld(cars, false, false);
  for (let f = 0; f < seconds * 60; f++) {
    if (rig.step(f / 60) === "drop") placeDrop(cars, rig.dropped - 1, rig.config.drop);
    tickWorld(w, 1 / 60);
    each?.(cars);
  }
  return { cars, rig };
}

/** Farthest a car stands from the base car's axis (m, plan; a car not yet dropped waits far off and is skipped) and the most any leans off vertical (deg). */
function spread(cars: readonly DeformableCar[]): { off: number; lean: number } {
  let off = 0;
  let lean = 0;
  for (const c of cars) {
    if (c.group.position.x > 40) continue;
    off = Math.max(off, Math.hypot(c.group.position.x, c.group.position.z));
    lean = Math.max(lean, (Math.acos(Math.min(1, c.group.matrixWorld.elements[5]!)) * 180) / Math.PI);
  }
  return { off, lean };
}

/** The owner's drops (10-04 trace): 11 cars, 0.15 m, one a second; 8 s after the last. */
const OWNER: StackConfig = { cars: 11, drop: 0.15, gap: 1 };
const OWNER_S = 1 + (OWNER.cars - 1) * OWNER.gap + 8;
/** The scene's defaults (`STACK_DEFAULTS`), 4 s after the last drop. */
const DEFAULTS: StackConfig = { cars: 4, drop: 0.02, gap: 8 };
const DEFAULTS_S = 1 + 3 * 8 + 4;

describe("given the owner's drops (11 cars, 0.15 m, one a second), run for 8 s after the last", () => {
  for (const bodies of ["sedans", "fleet without the monster"] as const) {
    it(`when the column is made of ${bodies}, then no car leaves it by 0.1 m or more, it ends within 5 cm of its axis leaning under 3°, every car reads a load, and the roof sink never grows toward the top, from over 300 mm at the bottom to under 5 mm at the top`, () => {
      let worst = 0;
      const { cars, rig } = column(OWNER, bodies, OWNER_S, (cs) => {
        worst = Math.max(worst, spread(cs).off);
      });
      assert.ok(worst < 0.1, `a car left the column by ${worst.toFixed(2)} m on the way`);
      const { off, lean } = spread(cars);
      assert.ok(off < 0.05 && lean < 3, `the column ends ${off.toFixed(2)} m off its axis, leaning ${lean.toFixed(1)}°`);
      // Read the way the Stack panel reads it: every car still carries its load, the roof sink grows toward the bottom.
      const { crushMm, loadKn } = stackLoads(cars, rig.dropped);
      assert.ok(loadKn.every((l) => l !== null), `a car reads off the column: ${loadKn.map((l) => l?.toFixed(0)).join("/")} kN`);
      const sink = crushMm.map((m) => m.toFixed(0)).join("/");
      assert.ok(crushMm[crushMm.length - 1]! < 5, `the top car's roof sank ${crushMm[crushMm.length - 1]!.toFixed(0)} mm with nothing on it (${sink} mm)`);
      for (let i = 1; i < crushMm.length; i++) assert.ok(crushMm[i - 1]! >= crushMm[i]! - 5, `roof sink bottom to top ${sink} mm: not decreasing at car ${i}`);
      assert.ok(crushMm[0]! > 300, `the bottom roof sank only ${crushMm[0]!.toFixed(0)} mm under ten cars (${sink} mm)`);
    });
  }
});

describe("given the stack scene's defaults (4 cars, 0.02 m, one every 8 s), run for 4 s after the last drop", () => {
  it("when the column is made of sedans, then each roof is crushed more than the roof above it by over 20 mm, and the top roof under 2 mm", () => {
    const { cars, rig } = column(DEFAULTS, "sedans", DEFAULTS_S);
    const { crushMm } = stackLoads(cars, rig.dropped);
    assert.ok(crushMm[3]! < 2, `top ${crushMm[3]!.toFixed(1)} mm`);
    for (let i = 0; i < 3; i++) assert.ok(crushMm[i]! > crushMm[i + 1]! + 20, `bottom to top ${crushMm.map((m) => m.toFixed(0)).join("/")} mm`);
  });

  it("when the column is made of the fleet and left alone for 5 s after it settles, then no car moves 5 mm", () => {
    const { cars } = column(DEFAULTS, "fleet", DEFAULTS_S);
    const at = cars.map((c) => c.group.position.clone());
    const w = makeWorld(cars, false, false);
    for (let f = 0; f < 5 * 60; f++) tickWorld(w, 1 / 60);
    const moved = Math.max(...cars.map((c, i) => c.group.position.distanceTo(at[i]!)));
    assert.ok(moved < 0.005, `a car moved ${(moved * 1000).toFixed(1)} mm in 5 s at rest`);
  });
});

describe("given the owner's drops (11 cars, 0.15 m, one a second) of the mixed fleet", () => {
  // The owner's drops of the mixed fleet: after pair pushes a tilted wreck's frame moved 0.35 m in one re-measure and the next
  // timed read wrote −55 m/s into car.velocity.y (c9 −25 m/s against its masses' −4 on this run), which applyImpulse and
  // brakeInbound then used as real (the Stack HUD read CLOSING 125 mph).
  it("when the column runs for 12 s, then no car reports a vertical speed 4 m/s or more off the one its own masses have", () => {
    let worst = 0;
    let at = "";
    column(OWNER, "fleet", 12, (cs) => {
      cs.forEach((c, i) => {
        if (!c.deform.massActive) return;
        const masses = c.deform.masses.reduce((s, m) => s + m.vel.y * m.mass, 0) / c.deform.totalMass;
        const off = Math.abs(c.velocity.y - masses);
        if (off > worst) {
          worst = off;
          at = `car ${i}: ${c.velocity.y.toFixed(1)} m/s, its masses ${masses.toFixed(1)}`;
        }
      });
    });
    assert.ok(worst < 4, `a car reported ${worst.toFixed(1)} m/s off its masses (${at})`);
  });

  it.todo("when the fleet's monster truck (slot 5; tyres on 0.9 m of spring, body 0.48 m up) carries four cars or more, then it rolls 5-30° on the support of its tyres, which has no spring to bring it level, and the column above it falls: 11 fleet cars, 0.15 m, 1 s");
});

describe("given the player picked a car type in the settings", () => {
  for (const type of DRIVER_CARS) {
    it(`when the 4-car stack has dropped every car and the pick is ${type.label}, then every car in the stack is a ${type.label}`, () => {
      const { cars, rig } = column({ cars: 4, drop: 0.02, gap: 1 }, { selected: type }, 1 + 3 + 1);
      assert.equal(rig.dropped, 4, "every car has dropped");
      assert.deepEqual(
        cars.map((c) => [c.style.id, carClass(c)]),
        cars.map(() => [type.style, type.cls]),
      );
    });
  }
});
