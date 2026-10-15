import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../world/ground.ts";
import { blankPoint, Track } from "../world/track.ts";
import city from "../world/tracks/city.json" with { type: "json" };
import { FRAME_HZ } from "../kernel/constants.ts";
import { COUNTDOWN, GRID_TIME } from "../match/session.ts";
import { makeWorld, type World } from "../world/race-world.test-util.ts";
import { recordField } from "./replay-fidelity.test-util.ts";

/**
 * The car's cage is a function of the sim's state alone, scheduled by the sim alone (docs/HIGHLIGHTS.md): drawing a car (`updateSkin`,
 * once per rendered frame in the engine, and only for the cars the camera sees) must not change what any car does, however often or
 * rarely it draws. A staged head-on is run twice; the second also draws every car before every step. Every car's pose, velocity and
 * crush, and the fields of its cage, must be the same numbers at every step, to the bit.
 */

/** The city course with the head-on's two cars (2 and 3) and the player's and car 1: no field around them to crash into. */
const FIELD = { trackId: "city", laps: 1, aiCount: 3, noReset: false, aggression: 1 };
const SEED = 5;
/** Cars 2 and 3 meet head-on 8 m apart on the city road at these speeds (m/s): a hard hit, so the cars crush and the cages refit. */
const HEAD_ON_MPS = { a: 30, b: 10 };
/** Race time the hit is staged at: the clock runs from minus the grid and the countdown, where the cars are held. */
const STAGED_AT_S = 1;
const START_S = GRID_TIME + COUNTDOWN;
/** Race time the run goes on for after the hit is staged: the impact, the crush settling and the cage refits. */
const AFTER_STAGED_S = 3;
/** Numbers per car: x, y, z, vx, vy, vz, total crush, wreck flag, the cage's refits and a sum of its top field. */
const STATE = 10;

/** Cars 2 and 3 put head-on 8 m apart on the city road, intact, at `HEAD_ON_MPS`. */
function stageHeadOn(w: World): void {
  const track = new Track(city);
  const pt = blankPoint();
  track.pointAt(150, pt);
  w.cars[2]!.spawnFacing(pt.x, pt.z, Math.atan2(pt.tx, pt.tz), HEAD_ON_MPS.a);
  track.pointAt(158, pt);
  w.cars[3]!.spawnFacing(pt.x, pt.z, Math.atan2(pt.tx, pt.tz) + Math.PI, HEAD_ON_MPS.b);
}

/** Every car's state at the start of every recorder step of a race, with `draw` run on every car ahead of it. */
function run(draw: boolean): Float64Array[] {
  const w = makeWorld();
  w.race.enter();
  try {
    const trace: Float64Array[] = [];
    let staged = -1;
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
        if (staged < 0 && w.race.time >= STAGED_AT_S) {
          stageHeadOn(w);
          staged = w.race.time;
        }
      },
      done: () => staged >= 0 && w.race.time - staged >= AFTER_STAGED_S,
      maxFrames: (START_S + STAGED_AT_S + AFTER_STAGED_S + 1) * FRAME_HZ,
    });
    return trace;
  } finally {
    w.race.exit();
    setGround(null);
  }
}

describe("given a staged head-on between two cars run twice, the second drawing every car before every step", () => {
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
