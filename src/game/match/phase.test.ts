import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { beginImpact, easeTimeScale, impactScale, phaseClock, PRE_IMPACT_LEAD, preImpact, stepPhase, type PhaseClock } from "./phase.ts";

/**
 * The automatic slow-mo before a predicted hit (`preImpact`), stepped frame by frame the way the engine does: the prediction
 * is the sim seconds to contact; the sim clock moves at the clock's time scale.
 */

const FRAME = 1 / 60;
const STEP = 1 / 60;
const LEAD = Math.max(PRE_IMPACT_LEAD, FRAME + STEP);

/**
 * A pair predicted to meet at `meetS` (s of sim) until `clearsS`, closing again for a meeting at `againS` from `closesAgainS`
 * (never, by default). The hit lands at `meetS` when `hits`.
 */
type Approach = { meetS: number; clearsS: number; throwing: boolean; hits: boolean; closesAgainS?: number; againS?: number };

/** What `wallS` seconds of frames did: the sim second the slow-mo first came on, went off again, and came back on after that. */
type Seen = { clock: PhaseClock; slowedAt: number; freedAt: number; slowedAgainAt: number };

function approach(a: Approach, wallS: number): Seen {
  const c = phaseClock();
  const seen: Seen = { clock: c, slowedAt: NaN, freedAt: NaN, slowedAgainAt: NaN };
  let simT = 0;
  for (let f = 0; f < wallS / FRAME; f++) {
    const eta =
      simT < a.clearsS ? Math.max(0, a.meetS - simT) : a.closesAgainS !== undefined && simT >= a.closesAgainS ? Math.max(0, a.againS! - simT) : Infinity;
    preImpact(c, eta, simT, LEAD, STEP, () => a.throwing);
    if (a.hits && c.phase === "approach" && simT >= a.meetS) beginImpact(c, true);
    const slowed = c.timeScale < 1 || c.slomoAt > 0;
    if (slowed && Number.isNaN(seen.slowedAt)) seen.slowedAt = simT;
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
