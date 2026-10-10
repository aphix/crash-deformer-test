import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../world/ground.ts";
import { makeWorld } from "../world/race-world.test-util.ts";
import { recordField } from "./replay-fidelity.test-util.ts";

/**
 * The car's cage is a function of the sim's state alone, scheduled by the sim alone (docs/HIGHLIGHTS.md): drawing a car (`updateSkin`,
 * once per rendered frame in the engine, and only for the cars the camera sees) must not change what any car does, however often or
 * rarely it draws. A seeded ramming race is run twice; the second also draws every car before every step. Every car's pose, velocity and
 * crush, and the fields of its cage, must be the same numbers at every step, to the bit.
 */

const FIELD = { trackId: "city", laps: 1, aiCount: 11, noReset: false, aggression: 1 };
const SEED = 1;
/** The first lap's crashes; the player's car drives flat out into the first wall it meets if no clip was kept by then (as `sweepSeeds` scripts it). */
const RACE_S = 75;
const SCRIPTED_AT = 12;
/** Numbers per car: x, y, z, vx, vy, vz, total crush, wreck flag, the cage's refits and a sum of its top field. */
const STATE = 10;

/** Every car's state at the start of every recorder step of a race, with `draw` run on every car ahead of it. */
function run(draw: boolean): Float64Array[] {
  const w = makeWorld();
  w.race.enter();
  try {
    const trace: Float64Array[] = [];
    recordField(w, {
      options: FIELD,
      seed: SEED,
      before: (n) => {
        if (n === 0) {
          const rec = w.race.recorder;
          const inner = rec.startStep.bind(rec);
          rec.startStep = (cars) => {
            if (draw) for (const car of cars) car.updateSkin();
            const out = new Float64Array(cars.length * STATE);
            for (let i = 0; i < cars.length; i++) {
              const c = cars[i]!;
              const o = i * STATE;
              out[o] = c.group.position.x;
              out[o + 1] = c.group.position.y;
              out[o + 2] = c.group.position.z;
              out[o + 3] = c.velocity.x;
              out[o + 4] = c.velocity.y;
              out[o + 5] = c.velocity.z;
              for (const m of c.deform.masses) out[o + 6] += m.local.distanceTo(m.rest);
              out[o + 7] = c.deform.massActive ? 1 : 0;
              const cage = c["cageRig"]?.cage;
              if (cage !== undefined) {
                out[o + 8] = cage.refits;
                for (const h of cage.fields.top) if (h === h) out[o + 9] += h;
              }
            }
            trace.push(out);
            inner(cars);
          };
        }
        if (w.race.recorder.now >= SCRIPTED_AT && w.race.recorder.ledger.kept.length === 0 && w.seat.mode !== "drive") {
          w.seat.mode = "drive";
          w.seat.carIndex = 0;
          w.seat.intent.gas = 1;
        }
      },
      done: () => w.race.recorder.ledger.kept.length >= 3,
      maxFrames: RACE_S * 60,
    });
    return trace;
  } finally {
    w.race.exit();
    setGround(null);
  }
}

describe("given a seeded ramming race run twice, the second drawing every car before every step", () => {
  it("when both are done, then every car's pose, velocity, crush and cage fields are the same numbers at every step", () => {
    const plain = run(false);
    const drawn = run(true);
    assert.equal(drawn.length, plain.length, "the two races ran a different number of steps");
    let wrecked = 0;
    let refits = 0;
    let first = -1;
    let at = -1;
    for (let s = 0; s < plain.length && first < 0; s++) {
      const a = plain[s]!;
      const b = drawn[s]!;
      for (let k = 0; k < a.length; k++) {
        if (a[k] !== b[k]) {
          first = s;
          at = k;
          break;
        }
      }
    }
    for (const row of plain) for (let o = 0; o < row.length; o += STATE) {
      wrecked = Math.max(wrecked, row[o + 7]!);
      refits = Math.max(refits, row[o + 8]!);
    }
    assert.ok(wrecked === 1 && refits >= 2, `the race crushed no car (${wrecked}) or fitted no cage twice (${refits}): the comparison proves nothing`);
    assert.equal(first, -1, `a car differs at step ${first}, car ${Math.floor(at / STATE)}, number ${at % STATE}: ${plain[first]?.[at]} against ${drawn[first]?.[at]}`);
  });
});
