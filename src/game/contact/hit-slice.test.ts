import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SimPacer } from "../engine/sim-pace.ts";
import { stepWorld } from "../engine/world-step.ts";
import { FREEWHEEL, launch, makeWorld, tickWorld } from "./crash-scenarios.test-util.ts";
import { classCar } from "../vehicle/ejection.test-util.ts";

/**
 * Owner, 2026-10-05: a cop T-boning a sedan at speed reads as a pass-through of about 1 m. A device whose 1/240 s steps do not
 * fit the frame steps at the coarse floor (1/80 s, `SimPacer`, adaptive): at 110 m/s closing a 1/80 s step carries a car 1.4 m, so the two cars'
 * first touch fell inside one step and the crush of each depended on where the step grid fell. The sandbox engine step
 * (`crash-scenarios.test-util.ts`) with the engine's own pacer holding each floor: a sedan drives its nose into a parked sedan's
 * right door.
 */
type Hit = { strikerNose: number; struckDoor: number; strikerThrown: boolean; struckThrown: boolean };

/** A sedan at `speed` driving its nose into the parked sedan's right door, from a start `phase` of one 1/80 s step of travel closer, stepped by a pacer on the 1/80 s floor or the 1/240 s one. */
function tbone(speed: number, coarse: boolean, phase: number): Hit {
  const striker = classCar("sedan");
  const struck = classCar("sedan");
  launch(struck, 0, 0, 0, 0, 0);
  launch(striker, 6 - (phase * speed) / 80, 0, -Math.PI / 2, -speed, 0);
  const w = makeWorld([striker, struck], false, false);
  const pace = new SimPacer();
  pace.pin = coarse;
  for (let f = 0; f < 60 * 2.5; f++) tickWorld(w, 1 / 60, pace);
  const hit: Hit = {
    strikerNose: striker.deform.crushAmount,
    struckDoor: struck.deform.crushAmount,
    strikerThrown: w.ejections.some((e) => e.car === 0),
    struckThrown: w.ejections.some((e) => e.car === 1),
  };
  striker.dispose();
  struck.dispose();
  return hit;
}

const SPEEDS = [20, 30, 40];
const PHASES = [0, 0.25, 0.5, 0.75];
/** Calibration tolerance (m of crush) between the two floors: 7 % of a door's 0.67 m at 40 m/s, the residual of the 1/80 s step's own grid outside the hit steps (measured worst 0.027 m over these twelve hits; the 1/120 s step stayed within the 0.045 m it had). Unmarked, the floors were up to 0.19 m apart. */
const SAME = 0.045;
describe("given a sedan driving its nose into a parked sedan's right door at 20 to 40 m/s, from four approach phases against the step grid", () => {
  it("when the pacer steps at 1/80 s instead of 1/240 s, then each car is crushed as far and the same driver is thrown, hit for hit", () => {
    const apart: string[] = [];
    for (const speed of SPEEDS) {
      for (const phase of PHASES) {
        const fine = tbone(speed, false, phase);
        const coarse = tbone(speed, true, phase);
        const d = (a: number, b: number): number => Math.abs(a - b);
        if (d(fine.strikerNose, coarse.strikerNose) > SAME || d(fine.struckDoor, coarse.struckDoor) > SAME || fine.strikerThrown !== coarse.strikerThrown || fine.struckThrown !== coarse.struckThrown) {
          apart.push(`${speed} m/s phase ${phase}: nose ${fine.strikerNose.toFixed(3)} / ${coarse.strikerNose.toFixed(3)} m, door ${fine.struckDoor.toFixed(3)} / ${coarse.struckDoor.toFixed(3)} m (1/240 s / 1/80 s)`);
        }
      }
    }
    assert.deepEqual(apart, []);
  });
});

/** A sedan at 56 km/h into the rigid wall, stepped at 1/80 s with the contact cut to slices of `fine` s (the pacer's floor): how far its nose crumples (m). */
function wallNose(fine: number): number {
  const car = classCar("sedan");
  launch(car, 6.2, 0, -Math.PI / 2, -56 / 3.6, 0);
  const w = makeWorld([car], true, false, FREEWHEEL);
  const d = car.deform;
  const length = (): number => (d.massLocal("bumperFL").z + d.massLocal("bumperFR").z) / 2 - d.massLocal("cell").z;
  const before = length();
  w.world.fine = fine;
  for (let i = 0; i < 120; i++) {
    stepWorld(w.world, 1 / 80);
    car.stepBreakage(1 / 80);
  }
  const nose = before - length();
  car.dispose();
  return nose;
}

describe("given a sedan driving into the rigid wall at 56 km/h in 1/80 s steps", () => {
  it("when the hit is cut into 3 slices of 1/240 s or 4 of 1/320 s, then the nose crumples the same to within 1 cm", () => {
    const coarse = wallNose(1 / 240);
    const fine = wallNose(1 / 320);
    assert.ok(Math.abs(coarse - fine) <= 0.01, `nose ${coarse.toFixed(3)} m in 3 slices, ${fine.toFixed(3)} m in 4`);
  });
});
