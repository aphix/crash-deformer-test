import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPair } from "./crash-scenarios.test-util.ts";
import { Ground, setGround } from "../world/ground.ts";

/** A side slope across the cars' travel (+X): the ground rises 0.12 m per metre of +Z (6.8°), 0 on the line they drive. */
const SLOPE = 0.12;
class SideSlope extends Ground {
  constructor() {
    super();
    const e = 1e4;
    this.addGrid({ nu: 2, nv: 2, step: 2 * e, stepV: 2 * e, u0: -e, v0: -e, heights: new Float32Array([-e * SLOPE, -e * SLOPE, e * SLOPE, e * SLOPE]), ox: 0, oy: 0, oz: 0, reach: Infinity });
  }
}
const SIDE_SLOPE = new SideSlope();

const DENTS = ["noseShortL", "noseShortR", "tailShort", "doorMaxL", "doorMaxR"] as const;
/** The dents away from the nose: what the sweep compares on the T-bone's bullet (car 1). */
const BODY_DENTS = ["tailShort", "doorMaxL", "doorMaxR"] as const;

/** The most the engine block may differ between the slope and the flat pad (m): the lattice's settling noise (ejection-slope.test.ts `DRIFT`). */
const BLOCK_NOISE = 0.005;

/**
 * Both cars on the slope against the same crash on the flat pad: no mass pops past 3·v·h + 5 cm in a slice, the block's
 * travel within `BLOCK_NOISE`, and each final dent car 0 reads in `DENTS` and car 1 in `carOneDents` within 0.03 m or 15 %
 * of the flat pad's.
 */
function assertSlopeKeepsCrash(kind: "head-on" | "t-bone", kph: number, carOneDents: typeof DENTS | typeof BODY_DENTS): void {
  setGround(null);
  const flat = runPair(kph, kph, kind, { after: 2.5 });
  setGround(SIDE_SLOPE);
  const slope = runPair(kph, kph, kind, { after: 2.5 });
  for (let i = 0; i < 2; i++) {
    const r = slope[i]!;
    assert.ok(r.massStepExcess <= 0, `${kind} car ${i}: ${r.massStepName} stepped ${r.massStepExcess.toFixed(3)} m past 3·v·h + 5 cm in a slice`);
    assert.ok(Math.abs(r.engineTravel - flat[i]!.engineTravel) <= BLOCK_NOISE, `${kind} car ${i} engine block: slope ${r.engineTravel.toFixed(4)} vs flat ${flat[i]!.engineTravel.toFixed(4)}`);
    for (const k of i === 0 ? DENTS : carOneDents) {
      const s = r[k];
      const f = flat[i]![k];
      assert.ok(Math.abs(s - f) <= Math.max(0.03, 0.15 * Math.abs(f)), `${kind} car ${i} ${k}: slope ${s.toFixed(3)} vs flat ${f.toFixed(3)}`);
    }
  }
}

const slopeCrashCases = [
  { it: "when a 48 km/h head-on crashes on it, then each car keeps the flat pad's dents and no mass pops past 3·v·h + 5 cm in a slice", kind: "head-on", kph: 48, carOneDents: DENTS },
  // The struck car (facing uphill) used to level out at quiet 0.35 s to world level, not to the slope: the frame
  // turned 0.2 rad against masses resting on the ground, the cell shifted 0.058 m and the tail read 0.083 m of crush
  // (0.023 on the flat pad). It levels to the plane under its hubs now.
  { it: "when a 50 km/h T-bone crashes on it, then each car keeps the flat pad's dents and no mass pops past 3·v·h + 5 cm in a slice", kind: "t-bone", kph: 50, carOneDents: DENTS },
  // The sweep leaves out the bullet's final nose: on the flat pad itself it settles after the hit either even (0.20 m
  // both corners) or one corner 4-8 cm deeper, and which one turns on the run-up alone (the bullet launched 5.5 / 6 /
  // 6.5 / 7 / 8 m out flips it at 50 and 51 km/h, on main as well), so a bar on it pinned the mode, not the slope.
  { it: "when the T-bone speed sweep reaches 46 km/h, then the struck car keeps the flat pad's dents, the bullet its tail and doors, each block travels as on the flat pad and no mass pops past 3·v·h + 5 cm in a slice", kind: "t-bone", kph: 46, carOneDents: BODY_DENTS },
  { it: "when the T-bone speed sweep reaches 47 km/h, then the struck car keeps the flat pad's dents, the bullet its tail and doors, each block travels as on the flat pad and no mass pops past 3·v·h + 5 cm in a slice", kind: "t-bone", kph: 47, carOneDents: BODY_DENTS },
  { it: "when the T-bone speed sweep reaches 48 km/h, then the struck car keeps the flat pad's dents, the bullet its tail and doors, each block travels as on the flat pad and no mass pops past 3·v·h + 5 cm in a slice", kind: "t-bone", kph: 48, carOneDents: BODY_DENTS },
  { it: "when the T-bone speed sweep reaches 49 km/h, then the struck car keeps the flat pad's dents, the bullet its tail and doors, each block travels as on the flat pad and no mass pops past 3·v·h + 5 cm in a slice", kind: "t-bone", kph: 49, carOneDents: BODY_DENTS },
  { it: "when the T-bone speed sweep reaches 51 km/h, then the struck car keeps the flat pad's dents, the bullet its tail and doors, each block travels as on the flat pad and no mass pops past 3·v·h + 5 cm in a slice", kind: "t-bone", kph: 51, carOneDents: BODY_DENTS },
  { it: "when the T-bone speed sweep reaches 52 km/h, then the struck car keeps the flat pad's dents, the bullet its tail and doors, each block travels as on the flat pad and no mass pops past 3·v·h + 5 cm in a slice", kind: "t-bone", kph: 52, carOneDents: BODY_DENTS },
  { it: "when the T-bone speed sweep reaches 53 km/h, then the struck car keeps the flat pad's dents, the bullet its tail and doors, each block travels as on the flat pad and no mass pops past 3·v·h + 5 cm in a slice", kind: "t-bone", kph: 53, carOneDents: BODY_DENTS },
  { it: "when the T-bone speed sweep reaches 54 km/h, then the struck car keeps the flat pad's dents, the bullet its tail and doors, each block travels as on the flat pad and no mass pops past 3·v·h + 5 cm in a slice", kind: "t-bone", kph: 54, carOneDents: BODY_DENTS },
  { it: "when the T-bone speed sweep reaches 55 km/h, then the struck car keeps the flat pad's dents, the bullet its tail and doors, each block travels as on the flat pad and no mass pops past 3·v·h + 5 cm in a slice", kind: "t-bone", kph: 55, carOneDents: BODY_DENTS },
  { it: "when the T-bone speed sweep reaches 56 km/h, then the struck car keeps the flat pad's dents, the bullet its tail and doors, each block travels as on the flat pad and no mass pops past 3·v·h + 5 cm in a slice", kind: "t-bone", kph: 56, carOneDents: BODY_DENTS },
] as const;

describe("given two cars crashing on a 6.8° side slope, and the same crash on the flat pad", () => {
  afterEach(() => setGround(null));

  for (const testCase of slopeCrashCases) {
    it(testCase.it, () => {
      assertSlopeKeepsCrash(testCase.kind, testCase.kph, testCase.carOneDents);
    });
  }
});
