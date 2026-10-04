import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPair } from "./crash-scenarios.test-util.ts";
import { setGround, type Ground } from "../world/ground.ts";

/** A side slope across the cars' travel (+X): the ground rises 0.12 m per metre of +Z (6.8°), 0 on the line they drive. */
const SLOPE = 0.12;
const SIDE_SLOPE: Ground = {
  heightAt: (_x, z) => z * SLOPE,
  normalAt: (_x, _z, out) => {
    const len = Math.hypot(SLOPE, 1);
    out.x = 0;
    out.y = 1 / len;
    out.z = -SLOPE / len;
    return out;
  },
  frictionAt: () => 1,
  surfaceAt: () => "asphalt",
};

const DENTS = ["noseShortL", "noseShortR", "tailShort", "doorMaxL", "doorMaxR"] as const;

/** Both cars on the slope against the same crash on the flat pad: no mass pops, final dents within 0.03 m or 15 %. */
function assertSlopeKeepsDents(kind: "head-on" | "t-bone", kph: number): void {
  setGround(null);
  const flat = runPair(kph, kph, kind, { after: 2.5 });
  setGround(SIDE_SLOPE);
  const slope = runPair(kph, kph, kind, { after: 2.5 });
  for (let i = 0; i < 2; i++) {
    const r = slope[i]!;
    assert.ok(r.massStepExcess <= 0, `${kind} car ${i}: ${r.massStepName} stepped ${r.massStepExcess.toFixed(3)} m past 3·v·h + 5 cm in a slice`);
    for (const k of DENTS) {
      const s = r[k];
      const f = flat[i]![k];
      assert.ok(Math.abs(s - f) <= Math.max(0.03, 0.15 * Math.abs(f)), `${kind} car ${i} ${k}: slope ${s.toFixed(3)} vs flat ${f.toFixed(3)}`);
    }
  }
}

describe("crashes on a side slope", () => {
  afterEach(() => setGround(null));

  it("bad: a 48 km/h head-on on a 6.8° side slope keeps the flat pad's dents, and no mass pops (3·v·h + 5 cm per slice)", () => {
    assertSlopeKeepsDents("head-on", 48);
  });

  // The struck car (facing uphill) used to level out at quiet 0.35 s to world level, not to the slope: the frame
  // turned 0.2 rad against masses resting on the ground, the cell shifted 0.058 m and the tail read 0.083 m of crush
  // (0.023 on the flat pad). It levels to the plane under its hubs now (RIG_ANALYSIS §6.14).
  it("bad: a 50 km/h t-bone on a 6.8° side slope keeps the flat pad's dents, and no mass pops", () => {
    assertSlopeKeepsDents("t-bone", 50);
  });

  // ReplayFidelity2: the 50 km/h pass sat on a cliff. The slope's tightest dent margin against max(0.03 m, 15 %) at
  // 46 / 48 / 49 / 50 / 51 / 52 / 54 km/h was +0.0091 / +0.0064 / +0.0016 / +0.0006 / -0.0024 / -0.0387 / -0.0497 m
  // (the bullet's nose, 0.172 -> 0.202 m). Peak dents were the same on both grounds; the live car's suspension hung
  // world-vertical on the slope (the high-side hubs 0.16 m over the road, the low side on it) until it levelled out, so
  // at 52 km/h its cell sank 0.014 m (flat pad 0.106) and its nose sprang back 0.012 m (0.052). It hangs from the plane now.
  for (let kph = 46; kph <= 56; kph++) {
    it(`bad: sweep, a ${kph} km/h t-bone on a 6.8° side slope keeps the flat pad's dents, and no mass pops`, () => {
      assertSlopeKeepsDents("t-bone", kph);
    });
  }
});
