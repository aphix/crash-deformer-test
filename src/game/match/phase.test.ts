import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { beginImpact, easeTimeScale, impactScale, pairEta, phaseClock, PRE_IMPACT_LEAD, preImpact, stepPhase, type PhaseClock } from "./phase.ts";
import { CAR_HALF, type DeformableCar } from "../vehicle/car.ts";

/**
 * The automatic slow-mo before a predicted hit (`preImpact`), stepped frame by frame the way the engine does: the prediction
 * is the sim seconds to contact; the sim clock moves at the clock's time scale.
 */

const FRAME = 1 / 60;
const STEP = 1 / 60;
const LEAD = Math.max(PRE_IMPACT_LEAD, FRAME + STEP);
/** Canary: the time scale as the cars meet, in multiples of the slow-mo's scale (the ease is meant to have arrived: the exact rate lands within 1.2× at a whole lead; the first frame's share of it is lost to the frame). */
const REACHED_CANARY = 2.5;
/** Canary: wall seconds from the slow-mo's start to the hit (the lead at the slow scale alone would crawl for 6 s). */
const EASE_WALL_CANARY = 2;

/**
 * A pair predicted to meet at `meetS` (s of sim) until `clearsS`, closing again for a meeting at `againS` from `closesAgainS`
 * (never, by default). The hit lands at `meetS` when `hits`.
 */
type Approach = { meetS: number; clearsS: number; throwing: boolean; hits: boolean; closesAgainS?: number; againS?: number };

/** What `wallS` seconds of frames did: the sim second the slow-mo first came on, went off again, and came back on after that. */
type Seen = { clock: PhaseClock; slowedAt: number; slowedWall: number; freedAt: number; slowedAgainAt: number; scaleAtHit: number; hitWall: number };

function approach(a: Approach, wallS: number): Seen {
  const c = phaseClock();
  const seen: Seen = { clock: c, slowedAt: NaN, slowedWall: NaN, freedAt: NaN, slowedAgainAt: NaN, scaleAtHit: NaN, hitWall: NaN };
  let simT = 0;
  for (let f = 0; f < wallS / FRAME; f++) {
    const eta =
      simT < a.clearsS ? Math.max(0, a.meetS - simT) : a.closesAgainS !== undefined && simT >= a.closesAgainS ? Math.max(0, a.againS! - simT) : Infinity;
    preImpact(c, eta, simT, LEAD, STEP, () => a.throwing);
    if (a.hits && c.phase === "approach" && simT >= a.meetS) {
      seen.scaleAtHit = c.timeScale;
      seen.hitWall = f * FRAME;
      beginImpact(c, true);
    }
    const slowed = c.timeScale < 1 || c.slomoAt > 0;
    if (slowed && Number.isNaN(seen.slowedAt)) {
      seen.slowedAt = simT;
      seen.slowedWall = f * FRAME;
    }
    else if (!slowed && !Number.isNaN(seen.slowedAt) && Number.isNaN(seen.freedAt)) seen.freedAt = simT;
    else if (slowed && !Number.isNaN(seen.freedAt) && Number.isNaN(seen.slowedAgainAt)) seen.slowedAgainAt = simT;
    stepPhase(c, FRAME);
    easeTimeScale(c, FRAME);
    simT += FRAME * c.timeScale;
  }
  return seen;
}

describe("given a pair on course to meet 1 s of sim from now, with the automatic slow-mo on", () => {
  it("when they meet on time, then the slow-mo comes on just before the hit and is still on 3 s of wall later", () => {
    const seen = approach({ meetS: 1, clearsS: Infinity, throwing: false, hits: true }, 3);
    assert.ok(seen.slowedAt >= 1 - LEAD - FRAME && seen.slowedAt < 1, `slow-mo came on at sim ${seen.slowedAt.toFixed(3)} s`);
    assert.ok(Number.isNaN(seen.freedAt), `time went back to 1x at sim ${seen.freedAt.toFixed(3)} s`);
    assert.ok(seen.clock.timeScale <= impactScale(seen.clock) * 1.2, `time scale ${seen.clock.timeScale}`);
  });

  it("when they meet on time, then the slow-mo starts a driver's reaction time of game time before the hit, has eased down to the slow scale as they meet, and does not crawl through the lead", () => {
    const seen = approach({ meetS: 1, clearsS: Infinity, throwing: false, hits: true }, 4);
    assert.ok(1 - seen.slowedAt >= PRE_IMPACT_LEAD - 2 * FRAME && 1 - seen.slowedAt <= PRE_IMPACT_LEAD, `${(1 - seen.slowedAt).toFixed(3)} game s of slow-mo before the hit, not ${PRE_IMPACT_LEAD}`);
    assert.ok(seen.scaleAtHit <= impactScale(seen.clock) * REACHED_CANARY, `time scale ${seen.scaleAtHit.toFixed(4)} as the cars met, slow scale ${impactScale(seen.clock)}`);
    assert.ok(seen.hitWall - seen.slowedWall < EASE_WALL_CANARY, `${(seen.hitWall - seen.slowedWall).toFixed(2)} wall s from the slow-mo's start to the hit`);
  });

  const missCases = [
    { it: "when the thrown car passes over the other (their footprints overlap until 1.6 s) and never touches it, then time is back at 1x one step after the predicted hit and stays there", meetS: 1, clearsS: 1.6, throwing: false },
    { it: "when the pair turns apart at the predicted moment, then time is back at 1x one step after the predicted hit and stays there", meetS: 1, clearsS: 1, throwing: false },
    { it: "when the predicted hit would have thrown a driver out and never comes, then the held slow-mo is dropped one step after the predicted hit and stays off", meetS: 1, clearsS: 1.6, throwing: true },
  ] as const;
  for (const testCase of missCases) {
    it(testCase.it, () => {
      const seen = approach({ ...testCase, hits: false }, 15);
      assert.ok(seen.slowedAt < testCase.meetS, `the slow-mo never came on (${seen.slowedAt})`);
      assert.ok(seen.freedAt > testCase.meetS + STEP && seen.freedAt <= testCase.meetS + STEP + FRAME, `back to 1x at sim ${seen.freedAt.toFixed(4)} s`);
      assert.ok(Number.isNaN(seen.slowedAgainAt), `the slow-mo came back on at sim ${seen.slowedAgainAt.toFixed(3)} s`);
      assert.equal(seen.clock.timeScale, 1);
      assert.equal(seen.clock.slomoAt, 0);
      assert.equal(seen.clock.phase, "approach");
    });
  }

  it("when they miss, part, and later close again for a meeting at 3 s, then the slow-mo comes on again just before that one", () => {
    const seen = approach({ meetS: 1, clearsS: 1.6, throwing: false, hits: false, closesAgainS: 2.5, againS: 3 }, 15);
    assert.ok(seen.freedAt > 1 + STEP && seen.freedAt <= 1 + STEP + FRAME, `back to 1x at sim ${seen.freedAt.toFixed(4)} s`);
    assert.ok(seen.slowedAgainAt >= 3 - LEAD - FRAME && seen.slowedAgainAt < 3, `the slow-mo came back on at sim ${seen.slowedAgainAt.toFixed(3)} s`);
  });
});

/** A car for `pairEta`: where it is (flat), how fast it goes along x, and its heading along x (right is across, z). */
function carAt(x: number, vx: number): DeformableCar {
  return { group: { position: { x, y: 0, z: 0 } }, velocity: { x: vx, z: 0 }, right: { x: 0, z: 1 }, forward: { x: 1, z: 0 } } as unknown as DeformableCar;
}

describe("given two cars on the same line closing on each other", () => {
  it("when one drives at a parked one, then the predicted hit lies on the parked car's near face, on the line between them", () => {
    const hit = { x: NaN, y: NaN, z: NaN, nx: NaN, nz: NaN };
    const eta = pairEta([carAt(-10, 20), carAt(10, 0)], hit);
    assert.ok(Math.abs(hit.x - (10 - CAR_HALF.z)) < 1e-9, `hit at x ${hit.x}, the parked car's near face is ${10 - CAR_HALF.z}`);
    assert.ok(Math.abs(hit.z) < 1e-9 && hit.nx === 1 && hit.nz === 0, `hit at z ${hit.z}, line ${hit.nx},${hit.nz}`);
    assert.ok(Math.abs(eta - (20 - 2 * CAR_HALF.z) / 20) < 1e-9, `eta ${eta}`);
  });

  it("when both drive at 10 m/s from either side of x = 0, then the predicted hit lies where they meet, x = 0", () => {
    const hit = { x: NaN, y: NaN, z: NaN, nx: NaN, nz: NaN };
    pairEta([carAt(-10, 10), carAt(10, -10)], hit);
    assert.ok(Math.abs(hit.x) < 1e-9, `hit at x ${hit.x}`);
  });
});
