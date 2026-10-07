import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutoFx } from "../auto-fx.ts";
import { describePost, FX_TIERS, type FxTier } from "../engine-post.ts";
import { benchPlan } from "../../engine/engine-bench-plan.ts";

/** A nearly idle main thread (ms per frame) and no GPU timer, as in `auto-fx.test.ts`: only the wall rate varies. */
const LIGHT_WORK_MS = 3;
const NO_GPU = -1;

/** 60 Hz frames with the jitter the auto-tier tests use, fed until `seconds` have passed; every tier the policy asked for. */
function feed(fx: AutoFx, seconds: number, matchTime: (t: number) => number | null): FxTier[] {
  const out: FxTier[] = [];
  let t = 0;
  for (let i = 0; t < seconds * 1000; i++) {
    const ms = 16.8 + ((i * 7) % 8) * 0.1;
    t += ms;
    const tier = fx.frame(ms, LIGHT_WORK_MS, NO_GPU, matchTime(t / 1000));
    if (tier !== null) out.push(tier);
  }
  return out;
}

describe("given the effects tiers a player can pick", () => {
  it("when the list is read, then Ultra is the top tier, above high", () => {
    assert.deepEqual([...FX_TIERS], ["off", "minimal", "low", "high", "ultra"]);
  });

  it("when the post chain is described for Ultra, then the line names the high chain and what Ultra adds", () => {
    const line = describePost("ultra");
    assert.ok(line.includes(describePost("high")), line);
    assert.match(line, /ultra/i);
  });
});

describe("given the automatic tier on a hardware desktop that holds 60 fps", () => {
  it("when it runs ten minutes idle, then through three races (clock -4.5 s to 90 s) with idle between, then it never asks for Ultra", () => {
    const fx = new AutoFx(true, true);
    const idle = feed(fx, 600, () => null);
    const raced: FxTier[] = [];
    for (let m = 0; m < 3; m++) {
      raced.push(...feed(fx, 94.5, (t) => -4.5 + t));
      raced.push(...feed(fx, 20, () => null));
    }
    assert.ok(idle.length > 0 && raced.length > 0, "the policy never switched: the test measured nothing");
    assert.ok(![...idle, ...raced].includes("ultra"), `asked for ${[...idle, ...raced].join(", ")}`);
    assert.ok(idle.includes("high"), "the check never lifted the desktop to high");
  });

  it("when the player picks Ultra by hand and then turns Auto back on, then the next frame leaves Ultra for the tier that held", () => {
    const fx = new AutoFx(true, true);
    assert.deepEqual(feed(fx, 4, () => null), ["high"]);
    fx.auto = false;
    assert.deepEqual(feed(fx, 30, () => null), [], "Ultra is a manual pick: the policy leaves it alone");
    fx.resume("ultra");
    assert.deepEqual(feed(fx, 0.05, () => null), ["high"]);
  });
});

describe("given the bench page's query", () => {
  it("when it asks for a bench with ultra=1, then the plan has the Ultra arm, for the city, the strip and the Lab", () => {
    for (const bench of ["city", "strip", "lab"]) {
      assert.equal(benchPlan(`?bench=${bench}&ultra=1`)!.ultra, true, bench);
    }
  });

  it("when ultra is absent, 0 or not 1, then the plan has no Ultra arm", () => {
    for (const q of ["?bench=city", "?bench=city&ultra=0", "?bench=city&ultra=yes", "?bench=strip&ultra="]) {
      assert.equal(benchPlan(q)!.ultra, false, q);
    }
  });
});
