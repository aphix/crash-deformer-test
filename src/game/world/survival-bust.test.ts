import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CopTamper } from "./survival-players.test-util.ts";
import { CONTROL_SEEDS, SEEDS, arena } from "./survival-pack.test-util.ts";

/**
 * The bust under the real rule (under 20 km/h within 20 m of a chasing cop for `SURVIVAL.bustTime`): the `corner` player runs for the
 * far corner of the closed arena and creeps there at 3 m/s, boxed in with nowhere left to run, and the released pack has to close, hold it
 * and bust it. A run counts when it ends busted. Measured over seeds 1-24 (10-10): 17 runs, 14 busted, the misses (seeds 5, 12, 16)
 * wrecked by the cops' hits before the bust's hold ran out. `BAR` keeps that share (14 of 24) on `SEEDS`, rounded down.
 * Control: cops that never move bust none (they never come within 20 m).
 */
const BAR = Math.floor((SEEDS.length * 14) / 24);
const FROZEN: CopTamper = (input) => Object.assign(input, { throttle: 0, steer: 0, brake: 1, ebrake: false, boost: false });

describe("given the closed arena with a player that runs for the far corner and creeps there at 3 m/s", () => {
  it(`when the pack is released in each of seeds ${SEEDS.join(", ")}, then it busts at least ${BAR} of the ${SEEDS.length} runs`, (t) => {
    const { ran, bad } = arena("corner", SEEDS, BAR, undefined, "busted");
    t.diagnostic(`${ran} runs, ${bad.length} not busted${bad.length ? `\n${bad.join("\n")}` : ""}`);
    assert.ok(bad.length <= SEEDS.length - BAR, `${bad.length} of ${ran} runs were not busted:\n${bad.join("\n")}`);
  });
  it(`when the cops never move, then they bust none of those runs (seeds ${CONTROL_SEEDS.join(", ")})`, (t) => {
    // Bar 1: the pool stops at the first bust, else runs every control seed.
    const { ran, bad } = arena("corner", CONTROL_SEEDS, 1, FROZEN, "busted");
    t.diagnostic(`${ran} runs, ${bad.length} not busted\n${bad.join("\n")}`);
    assert.equal(bad.length, ran, `${ran - bad.length} of ${ran} runs were busted by cops that never move`);
  });
});
