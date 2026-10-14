import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { beginImpact, easeTimeScale, holdForThrow, impactScale, pairEta, phaseClock, PRE_IMPACT_LEAD, preImpact, stepPhase, type PhaseClock } from "./phase.ts";
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
/** Sim seconds (at most the wall's) a given-up slow-mo takes to climb back to exactly 1×: the scale starts to rise one step after the predicted hit (`RAMP_RATE`, settled within a thousandth by 0.45 s). */
const RAMP_BACK = 0.45;

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
      assert.ok(seen.freedAt > testCase.meetS + STEP && seen.freedAt <= testCase.meetS + STEP + RAMP_BACK, `back to 1x at sim ${seen.freedAt.toFixed(4)} s`);
      assert.ok(Number.isNaN(seen.slowedAgainAt), `the slow-mo came back on at sim ${seen.slowedAgainAt.toFixed(3)} s`);
      assert.equal(seen.clock.timeScale, 1);
      assert.equal(seen.clock.slomoAt, 0);
      assert.equal(seen.clock.phase, "approach");
    });
  }

  it("when they miss, part, and later close again for a meeting at 3 s, then the slow-mo comes on again just before that one", () => {
    const seen = approach({ meetS: 1, clearsS: 1.6, throwing: false, hits: false, closesAgainS: 2.5, againS: 3 }, 15);
    assert.ok(seen.freedAt > 1 + STEP && seen.freedAt <= 1 + STEP + RAMP_BACK, `back to 1x at sim ${seen.freedAt.toFixed(4)} s`);
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

/** The biggest one-frame move of the time scale (60 Hz) while `frames` of the clock run, `act` called on the first. */
function biggestStep(c: PhaseClock, frames: number, act: () => void): number {
  let big = 0;
  act();
  for (let f = 0; f < frames; f++) {
    const before = c.timeScale;
    easeTimeScale(c, FRAME);
    stepPhase(c, FRAME);
    big = Math.max(big, Math.abs(c.timeScale - before));
  }
  return big;
}

describe("given the time scale's changes (masterclass 23:34: fade, never switch)", () => {
  /** One frame at 60 Hz may move the scale at most this far (a ramp of ≥ 0.19 s to 95 %: 23 % of a gap of at most 1). */
  const BOUND = 0.25;

  it("when a hit nobody saw coming starts the slow-mo from 1×, then no frame moves the scale more than the bound and it settles on the slow scale", () => {
    const c = phaseClock();
    assert.ok(biggestStep(c, 60, () => beginImpact(c, true)) <= BOUND);
    assert.equal(c.timeScale, impactScale(c));
  });
  it("when a throw holds the slow-mo up to 1× and then drops it again, then no frame moves the scale more than the bound", () => {
    const c = phaseClock();
    c.hold = Infinity;
    beginImpact(c, true);
    for (let f = 0; f < 60; f++) {
      easeTimeScale(c, FRAME);
      stepPhase(c, FRAME);
    }
    assert.ok(biggestStep(c, 60, () => holdForThrow(c)) <= BOUND);
    assert.equal(c.timeScale, impactScale(c), "the slow-mo came back");
  });
  it("when the hit goes by with no slow-mo after an ease had begun, then the scale climbs back to 1× in bounded steps", () => {
    const c = phaseClock();
    c.targetScale = impactScale(c);
    for (let f = 0; f < 6; f++) easeTimeScale(c, FRAME);
    assert.ok(c.timeScale < 1);
    assert.ok(biggestStep(c, 60, () => beginImpact(c, false)) <= BOUND);
    assert.equal(c.timeScale, 1);
  });
  it("when a missed hit's pre-impact slow-mo is given up, then the scale climbs back to 1× in bounded steps", () => {
    const c = phaseClock();
    preImpact(c, 0.1, 0, LEAD, STEP, () => false);
    for (let f = 0; f < 6; f++) easeTimeScale(c, FRAME);
    const slow = c.timeScale;
    assert.ok(slow < 1);
    assert.ok(biggestStep(c, 60, () => preImpact(c, Infinity, 1, LEAD, STEP, () => false)) <= BOUND);
    assert.equal(c.timeScale, 1);
  });
});
