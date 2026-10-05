import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCar, makeWorld, type CrashWorld } from "./crash-scenarios.test-util.ts";
import { stepWorld } from "../engine/world-step.ts";
import { PUSH_SPEED, PushBudget } from "../deform/push-budget.ts";
import { satPushCap } from "../deform/physics-util.ts";
import type { DeformableCar } from "../vehicle/car.ts";

/** The slice a slow field steps at (`physicsSlice(1/60, 4)`): the longest, so the loosest per-slice cap. */
const H = 1 / 60;

function centroid(c: DeformableCar): [number, number] {
  let x = 0;
  let z = 0;
  let m = 0;
  for (const q of c.deform.masses) {
    x += q.world.x * q.mass;
    z += q.world.z * q.mass;
    m += q.mass;
  }
  return [x / m, z / m];
}

/**
 * A wreck (a bullet's slow head-on, settled 2.5 s) with two plain cars across its flank, `depth` m into it. The pair
 * solver pushes the wreck out along the flank's normal in every SAT pass of every slice.
 */
function wedged(depth: number): { wreck: DeformableCar; world: CrashWorld } {
  const wreck = makeCar("shape");
  const bullet = makeCar("shape");
  launch(wreck, 0, 0, 0, 0, 0);
  launch(bullet, 0, 9, Math.PI, 0, -9);
  const settle = makeWorld([wreck, bullet], false, false);
  for (let t = 0; t < 2.5; t += 1 / 120) stepWorld(settle.world, 1 / 120);
  assert.ok(wreck.deform.massActive && wreck.deform.quietTime() > 1, "no settled wreck to wedge");
  const [wx, wz] = centroid(wreck);
  const yaw = wreck.yaw;
  const flank = 0.95 + 2.3 - depth;
  const across = (zl: number): DeformableCar => {
    const c = makeCar("shape");
    launch(c, wx + Math.cos(yaw) * flank + Math.sin(yaw) * zl, wz - Math.sin(yaw) * flank + Math.cos(yaw) * zl, yaw + Math.PI / 2, 0, 0);
    return c;
  };
  return { wreck, world: makeWorld([wreck, across(-1.2), across(1.2)], false, false) };
}

describe("a wedged wreck's net translation (PushBudget)", () => {
  // Zip: a live mass centroid moving more than 3·v·h + 5 cm in a step (the derby bar, derby-ai.test.ts). The pair
  // solver's pushes shared one satPushCap a slice, 0.09 m at this slice, and the wreck went 0.079 m in a step and
  // 0.062 the next, against the 0.05 m the bound gives a wreck at rest.
  it("bad: two cars 1.4 m into a settled wreck's flank move it no more than the zip bound in any step", () => {
    const { wreck, world } = wedged(1.4);
    for (let s = 0; s < 4; s++) {
      const before = centroid(wreck);
      const v0 = Math.hypot(wreck.velocity.x, wreck.velocity.z);
      stepWorld(world.world, H);
      const after = centroid(wreck);
      const moved = Math.hypot(after[0] - before[0], after[1] - before[1]);
      const bound = 3 * Math.max(v0, Math.hypot(wreck.velocity.x, wreck.velocity.z)) * H + 0.05;
      assert.ok(moved <= bound, `step ${s}: moved ${moved.toFixed(4)} m, bound ${bound.toFixed(4)} m`);
    }
  });
});

describe("PushBudget: one net translation a slice", () => {
  const cap = PUSH_SPEED * H;

  it("good: pushes the same way share one cap, whoever pushes", () => {
    const b = new PushBudget();
    const got = [0.03, 0.03, 0.03].map((a) => b.take(1, 1, 0, a, H, 0));
    assert.ok(Math.abs(got[0]! - 0.03) < 1e-12 && Math.abs(got[1]! - (cap - 0.03)) < 1e-12 && got[2] === 0, JSON.stringify(got));
  });

  it("good: the two sides of a squeeze each get their room, and the net stays inside the cap", () => {
    const b = new PushBudget();
    assert.ok(Math.abs(b.take(1, 1, 0, 0.03, H, 0) - 0.03) < 1e-12);
    assert.ok(Math.abs(b.take(1, -1, 0, 0.03, H, 0) - 0.03) < 1e-12, "the push back the other way was refused");
    assert.ok(Math.hypot(b.x, b.z) < 1e-12, "the squeeze left a net translation");
    assert.ok(Math.abs(b.take(1, 0, 1, 0.2, H, 0) - cap) < 1e-12, "a push across a cancelled squeeze gets the whole cap");
  });

  it("bad: a wall translation or a sphere shift debited first leaves that much less to push", () => {
    const b = new PushBudget();
    b.debit(1, 0.02, 0);
    assert.ok(Math.abs(b.take(1, 1, 0, 0.05, H, 0) - (cap - 0.02)) < 1e-12);
    assert.equal(b.take(1, 1, 0, 0.05, H, 0), 0, "nothing is left once the corrections fill the cap");
  });

  it("close-but-wrong: a fast partner lifts the cap to satPushCap, so a 20 m/s hit separates as before", () => {
    const b = new PushBudget();
    assert.ok(Math.abs(b.take(1, 1, 0, 0.2, H, 20) - satPushCap(H)) < 1e-12);
  });

  it("good: the next slice starts empty", () => {
    const b = new PushBudget();
    b.take(1, 1, 0, 1, H, 0);
    assert.ok(Math.abs(b.take(1 + H, 1, 0, 1, H, 0) - cap) < 1e-12);
  });
});
