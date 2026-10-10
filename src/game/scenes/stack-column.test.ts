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
  // The sedan column held on main (bar: no car leaves it by 0.1 m). The fleet column's worst car leaves by 0.10 m, at the bar (11 cars,
  // 8 s after the last drop; one top car creeping at about 2.3 mm/s). Cause: the top muscle car's front tyres rest on the steep
  // sides of the sedan roof under it (normals ±0.85 / 0.52), and the load on its belly rows flips between belly points every other
  // slice, so the tyres' springs and the rigid belly rows trade the weight. A single solve of tyre and hull rows was built and measured
  // (a sedan column then sways to 0.47 m at 20 s: the lagged coupling between stacked cars is open). Re-measured on lane/uc2-solids
  // (Stage 2: walls, props and ramps are prisms of the one store, a car's top is still `CarSurfaces`' plate): 0.10 m against the bar's
  // `< 0.1`, no margin, the same creep: Stage 2 moved no car's top, so the tyre rows and the belly rows still read two answers of one
  // contact. Closes in Stage 3, where the car's top is the cage the hull points and the tyre rows meet alike (Stage 4 if still open). For a
  // player: a stack of eleven cars dropped one a second drifts a hand's breadth at the top over a minute.
  // Stage 3 (integration b94657da), the sedan column: the top car ends 0.10 m off the axis at 19 s (bar 0.05), leaning 0.1°, and no car
  // stands still: the top five wander at 10-35 mm/s in both axes while every car's pitch holds at the stock -0.14°, and the bottom roof
  // is still sinking at about 1 mm/s (366 mm at 19 s). The last good commit (2b1d472f) ended 0.037 m off the axis (bar 0.05) with its
  // five bottom roofs packed at 449 mm, rigid; the break is 0b4839b5 (bisected on first-parent commits: `faceFollow` lowers only the roof
  // band, the hood, boot and cabin stand): 0.074 m at that commit, and restoring its old `faceFollow` there gives 0.037 m again. The
  // roof strength room per slice is cut on 35-45 % of the bottom roof's slices (demand 108, room 115 m/s² at 19 s), but a 30 % stronger
  // roof (measured) still ends 0.10 m off, and restoring the roof cap, measuring each node's own follow of the crush (the rim of a crushed
  // roof stands, it does not follow) and `faceFollow`'s old lowering at the head change no number to the millimetre of the roof row or
  // the creep: the wander is the open lagged coupling between stacked cars (the weight a car bears on the one under it lands at that
  // car's next step), packed roofs were what held the column before. Closes in Stage 4 item 5 (car-car through the kernel) (a car on a car is one pair solved once per
  // slice through the kernel, no lagged borne weight).
  for (const bodies of ["sedans", "fleet without the monster"] as const) {
    const todo = bodies === "sedans" ? "the top car ends 0.10 m off the axis at 19 s (bar 0.05), the top five wander at 10-35 mm/s at the stock pitch, the bottom roof still sinking 1 mm/s at 366 mm; last good 2b1d472f 0.037 m with roofs packed at 449 mm, break 0b4839b5 (faceFollow's roof band: 0.074 m there); roof strength +30 %, the roof cap, per-node follow and old faceFollow at the head change nothing; the lagged weight borne between stacked cars is open; closes in Stage 4 item 5 (car-car through the kernel) (one pair solve per slice, no lagged borne weight)" : "the top car creeps off the column by 0.10 m (bar < 0.1 m, no margin): tyre and belly rows trade the weight every slice, re-measured on Stage 2 (no car top moved); closes in Stage 3 (the car's top is the cage, tyre and hull rows read it alike), Stage 4 if still open";
    it(`when the column is made of ${bodies}, then no car leaves it by 0.1 m or more, it ends within 5 cm of its axis leaning under 3°, every car reads a load, and the roof sink never grows toward the top, from over 300 mm at the bottom to under 5 mm at the top`, { todo }, () => {
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
  // Stage 3 (integration b94657da): the roofs read 159/112/94/0 mm bottom to top (main 158/114/92/0), the 112 -> 94 step 18 mm against the
  // bar's 20 (main's 22: two millimetres of margin on a quantity that is the plastic history of the drops, not the static law, whose
  // depths for one, two and three cars on a roof are 31, 81 and 122 mm). The trace per drop: each car's 2 cm drop sinks the roof under it
  // to 94-100 mm, and the next drop pushes the roof below that by 16 mm and the one below that by 32 mm; every car stands belly on the
  // roof under it with its tyres 0.21-0.32 m clear of the hood and boot. The first bad commit is e7252ffa (the car's top is the cage, not
  // the plate: 18ecaba9 passes); the cage's refit threshold (REFIT_EPSILON to 0.1 mm) and the per-node follow of the crush change no
  // millimetre of it. Closes in Stage 5 (the roof strength law's constants and `SKIN_STRAIN`, recalibrated with their sources).
  it("when the column is made of sedans, then each roof is crushed more than the roof above it by over 20 mm, and the top roof under 2 mm", { todo: "159/112/94/0 mm against the bar's 20 mm step (112 -> 94: 18; main 158/114/92/0: 22, two millimetres of margin) on the plastic history of the 2 cm drops (static law 31/81/122 mm); first bad commit e7252ffa (the cage is the car's top); the cage's refit threshold and per-node follow change nothing; closes in Stage 5 (roof strength law constants and SKIN_STRAIN recalibrated)" }, () => {
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
      for (const [i, c] of cs.entries()) {
        if (!c.deform.massActive) continue;
        const masses = c.deform.masses.reduce((s, m) => s + m.vel.y * m.mass, 0) / c.deform.totalMass;
        const off = Math.abs(c.velocity.y - masses);
        if (off > worst) {
          worst = off;
          at = `car ${i}: ${c.velocity.y.toFixed(1)} m/s, its masses ${masses.toFixed(1)}`;
        }
      }
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
      for (const [i, c] of cars.entries()) {
        assert.equal(c.style.id, type.style, `car ${i} body`);
        assert.equal(carClass(c), type.cls, `car ${i} class`);
      }
    });
  }
});
