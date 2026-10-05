import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collide, type Hit, type Outcome } from "./ejection.test-util.ts";
import { VEHICLE_CLASS_IDS, type VehicleClassId } from "./vehicle-classes.ts";

/**
 * Who is thrown, and what the engine is left with, for every striker × struck class pair of the three hits, through the
 * sandbox engine step at the HUD's defaults (squash 0.32, buckle 0.45, realism 0.25, a fleet's kill limits). Expected
 * outcomes are the calibration's (docs/CRUSH_CALIBRATION.md): the crush grows with the speed that reaches the
 * struck end (a car's share of the closing is M/(m+M), so a T-bone or rear-end striker feels half the closing a
 * head-on car does), a lethal head-on kills and throws both drivers, and a door or tail hit spares the struck car's
 * engine by design (the block moves along the car, not across it).
 */
const CLASSES = VEHICLE_CLASS_IDS.filter((id) => id !== "police" && id !== "muscle");
const PAIRS = CLASSES.flatMap((a) => CLASSES.map((b) => [a, b] as const));
const HITS: readonly Hit[] = ["head-on", "t-bone", "rear-end"];

/** Closing speed (m/s): a head-on is this per car, a T-bone or rear-end this on the striker alone. */
const SURVIVABLE: Record<Hit, number> = { "head-on": 12, "t-bone": 20, "rear-end": 20 };
const LETHAL: Record<Hit, number> = { "head-on": 40, "t-bone": 55, "rear-end": 55 };

const label = (hit: Hit, a: VehicleClassId, b: VehicleClassId, mps: number): string => `${hit} ${a} into ${b} at ${mps} m/s`;

/** Health may only fall as the speed rises: a faster hit leaves at most this much more (a tolerance for the sim's own jitter). */
const HEALTH_JITTER = 0.02;

describe("given every striker and struck class pair (police and muscle left out) in a head-on, a T-bone and a rear-end hit, at the HUD's default crush settings", () => {
  for (const hit of HITS) {
    it(`when a ${hit} hits at the survivable ${SURVIVABLE[hit]} m/s, then nobody is thrown and both engines stay near whole, for every class pair`, () => {
      for (const [a, b] of PAIRS) {
        const [striker, struck] = collide(hit, a, b, SURVIVABLE[hit]);
        for (const [who, o] of [["striker", striker], ["struck", struck]] as const) {
          const where = `${label(hit, a, b, SURVIVABLE[hit])}, ${who}`;
          assert.equal(o.thrown, false, `${where}: thrown`);
          assert.ok(o.alive && o.health >= 0.6, `${where}: health ${o.health.toFixed(2)}`);
        }
      }
    });

    it(`when a ${hit} hits at the lethal ${LETHAL[hit]} m/s, then it kills ${hit === "head-on" ? "and throws both drivers" : "and throws the striker's driver, and spares the struck car's engine and driver"}, for every class pair`, () => {
      for (const [a, b] of PAIRS) {
        const [striker, struck] = collide(hit, a, b, LETHAL[hit]);
        const where = label(hit, a, b, LETHAL[hit]);
        assert.equal(striker.thrown, true, `${where}: striker not thrown (health ${striker.health.toFixed(2)}, block ${striker.travel.toFixed(3)} m)`);
        assert.ok(striker.health <= 0.2, `${where}: striker health ${striker.health.toFixed(2)}`);
        if (hit === "head-on") {
          assert.equal(struck.thrown, true, `${where}: struck not thrown (health ${struck.health.toFixed(2)}, block ${struck.travel.toFixed(3)} m)`);
          assert.ok(struck.health <= 0.2, `${where}: struck health ${struck.health.toFixed(2)}`);
        } else {
          assert.equal(struck.thrown, false, `${where}: struck thrown`);
          assert.ok(struck.alive && struck.health >= 0.8, `${where}: struck health ${struck.health.toFixed(2)}`);
        }
      }
    });

    it(`when a ${hit} is made faster, then it never leaves a striker or a head-on car healthier, nor un-throws a driver, for every class pair`, () => {
      const speeds = hit === "head-on" ? [15, 20, 25, 30, 40, 55] : [30, 35, 40, 45, 55];
      for (const [a, b] of PAIRS) {
        let prev: [Outcome, Outcome] | null = null;
        let prevMps = 0;
        for (const mps of speeds) {
          const now = collide(hit, a, b, mps);
          if (prev) {
            const cars = hit === "head-on" ? [0, 1] : [0];
            for (const k of cars) {
              const where = `${hit} ${a} into ${b}, ${k === 0 ? "striker" : "struck"}: ${prevMps} → ${mps} m/s`;
              assert.ok(now[k]!.health <= prev[k]!.health + HEALTH_JITTER, `${where}: health ${prev[k]!.health.toFixed(2)} → ${now[k]!.health.toFixed(2)}`);
              assert.ok(now[k]!.thrown || !prev[k]!.thrown, `${where}: thrown at ${prevMps} m/s, not at ${mps}`);
            }
          }
          prev = now;
          prevMps = mps;
        }
      }
    });
  }
});
