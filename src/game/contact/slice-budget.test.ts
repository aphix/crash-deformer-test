import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCar, makeWorld } from "./crash-scenarios.test-util.ts";
import { stepWorld } from "../engine/world-step.ts";
import { pushCar } from "./pair-contact.ts";
import { PushBudget, STEP_CEIL } from "../deform/push-budget.ts";
import type { DeformableCar } from "../vehicle/car.ts";

/** The slice a derby steps at (`physicsSlice(1/60, 8)`): 6.9 ms. */
const H = 1 / 145;
/** The faster of the two cars in the worst slice of derby main seed 161 / the owner's o6 at t = 3.46 (4.65 m/s). */
const TOUCH = 4.65;
/** The corrections of that slice (derby `o6`, 17491eb): the pair push's unit normal, and what the structure step and the re-fit then moved the centroid along it (m). */
const PUSH_N = [-0.9119, 0.4104] as const;
const STRUCTURE_DRIFT = 0.0122;
const REFIT_DRIFT = 0.0086;
/** The bowl clip's translation in that slice (m), across the pushes. */
const CLIP = 0.015;

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

/** A wreck: a bullet's slow head-on, settled 2.5 s, planted (quiet well past 0.35 s). */
function plantedWreck(): DeformableCar {
  const wreck = makeCar("shape");
  const bullet = makeCar("shape");
  launch(wreck, 0, 0, 0, 0, 0);
  launch(bullet, 0, 9, Math.PI, 0, -9);
  const settle = makeWorld([wreck, bullet], false, false);
  for (let t = 0; t < 2.5; t += 1 / 120) stepWorld(settle.world, 1 / 120);
  assert.ok(wreck.deform.massActive && wreck.deform.quietTime() > 0.35, "no planted wreck");
  return wreck;
}

type Drifting = {
  clampLocal: (group: unknown) => void;
  updateDrivetrain: () => void;
  masses: { world: { x: number; z: number } }[];
};

/**
 * `car`'s shape restoring along the push, as o6's did (17491eb, derby owner's 9-car heat, t = 3.46): the structure step
 * moves the whole masses `STRUCTURE_DRIFT` along it, and the first re-fit after it (`followGroup`'s clamp) `REFIT_DRIFT`.
 * What a wreck's shape does is the state's; what a slice may do with it is the budget's, whatever it is.
 */
function restoreAlongPush(car: DeformableCar): void {
  const d = car.deform as unknown as Drifting;
  const shift = (by: number): void => {
    for (const m of d.masses) {
      m.world.x += PUSH_N[0] * by;
      m.world.z += PUSH_N[1] * by;
    }
  };
  let refit = false;
  const clamp = d.clampLocal.bind(d);
  d.clampLocal = (group) => {
    clamp(group);
    if (refit) shift(REFIT_DRIFT);
    refit = false;
  };
  const drivetrain = d.updateDrivetrain.bind(d);
  d.updateDrivetrain = () => {
    drivetrain();
    shift(STRUCTURE_DRIFT);
    refit = true;
  };
}

describe("a slice's corrections share one net translation (PushBudget)", () => {
  // Derby seed 161 (main) and o6 (17491eb) zipped in one 6.9 ms slice: the pair pushes took the whole cap (44 mm), and
  // the structure step (12.2 mm), the re-fit (8.6 mm) and the bowl clip (14.9 mm) came after them, each debited to the
  // NEXT slice's budget, so the wreck's centroid moved 66 mm against a zip bound of 3·v·h + 5 cm = 61 mm.
  it("bad: a planted wreck's pushes, structure step and re-fit of one slice move it no further than the cap, whatever the clip", () => {
    const wreck = plantedWreck();
    restoreAlongPush(wreck);
    const w = makeWorld([wreck], false, false).world;
    let pass = 0;
    w.ballHit = (car) => {
      if (car === wreck && pass++ === 0) {
        // The pair solver's four pushes of a slice (`pushPair`), two of them at the cap already.
        for (const amount of [0.0168, 0.0214, 0.0215, 0.0215]) pushCar(wreck, PUSH_N[0], 0, PUSH_N[1], wreck.deform.takePush(PUSH_N[0], PUSH_N[1], amount, H, TOUCH));
      }
      return null;
    };
    w.afterCar = (car) => {
      if (car !== wreck) return;
      // The bowl's clip, across the pushes: a wall translation of the whole wreck, the group with it.
      wreck.deform.translateMasses(-PUSH_N[1] * CLIP, PUSH_N[0] * CLIP, 0, 0);
      wreck.group.position.x -= PUSH_N[1] * CLIP;
      wreck.group.position.z += PUSH_N[0] * CLIP;
    };
    // The most a slice's corrections may move the centroid: the pushes' cap at TOUCH (what a lone take of more than any cap
    // returns), or the ceiling the structure step's and the re-fits' drift is held to.
    const limit = Math.max(new PushBudget().take(1, 1, 0, 1, H, TOUCH), STEP_CEIL);
    for (let s = 0; s < 4; s++) {
      pass = 0;
      const before = centroid(wreck);
      stepWorld(w, H);
      const after = centroid(wreck);
      // The net translation the corrections made: the centroid's move, less the clip (a wall's, not the budget's) and the wreck's own motion.
      const net = Math.hypot(
        after[0] - before[0] + PUSH_N[1] * CLIP - wreck.velocity.x * H,
        after[1] - before[1] - PUSH_N[0] * CLIP - wreck.velocity.z * H,
      );
      assert.ok(net <= limit + 1e-6, `slice ${s}: corrections moved the centroid ${(net * 1000).toFixed(1)} mm, cap ${(limit * 1000).toFixed(1)} mm`);
    }
  });

  // Seed 275 of 17491eb: one `followGroup` re-fit moved a live car's centroid 49 mm (49/47/37/32 over four steps) right
  // after a 26 mm correction. A live wreck's frame sits on its cell, so a sphere hit that shifts the cell leaves the
  // other masses behind it, and the clamp drags them after: the whole cloud moves again, on top of the shift.
  it("bad: a live wreck's re-fit after a sphere shift adds no translation beyond what the shift and the cap leave", () => {
    const wreck = plantedWreck();
    // The slice length the wreck's budget is in (the last world slice's).
    stepWorld(makeWorld([wreck], false, false).world, H);
    const [wx, wz] = centroid(wreck);
    const other = makeCar("shape");
    launch(other, wx, wz + 1, wreck.yaw + 0.3, 0, 0);
    makeWorld([wreck, other], false, false);
    wreck.deform.notifyContact();
    const start = centroid(wreck);
    assert.ok(wreck.deform.collideWith(other.deform, H), "the cars' masses do not touch");
    const shifted = centroid(wreck);
    wreck.deform.followGroup(wreck.group, wreck.velocity, wreck.angular, 0);
    const end = centroid(wreck);
    const shift = Math.hypot(shifted[0] - start[0], shifted[1] - start[1]);
    const total = Math.hypot(end[0] - start[0], end[1] - start[1]);
    // The cap with nothing moving, or the ceiling: a shift past it leaves the re-fit nothing.
    const limit = Math.max(new PushBudget().take(1, 1, 0, 1, H, 0), STEP_CEIL);
    assert.ok(total <= Math.max(shift, limit) + 1e-6, `shift ${(shift * 1000).toFixed(1)} mm, then the re-fit: ${(total * 1000).toFixed(1)} mm in all, cap ${(limit * 1000).toFixed(1)} mm`);
  });

  // Derby seed 40 with the ceiling: the pushes took the whole cap (47.8 mm at 8.5 ms), so a structure drift AGAINST them
  // was refused as "nothing left" and the wreck stayed at 51.5 mm; against the net, it brings it in.
  it("good: a drift against a full net translation is allowed, one along it is refused", () => {
    const full = new PushBudget();
    assert.ok(Math.abs(full.settle(1, 0, 1, 1, H, TOUCH) - STEP_CEIL) < 1e-12, "a drift along nothing gets the ceiling");
    assert.equal(full.settle(1, 0, 1, 0.01, H, TOUCH), 0, "a drift along the full net was allowed");
    assert.ok(Math.abs(full.settle(1, 0, -1, 0.02, H, TOUCH) - 0.02) < 1e-12, "a drift back along the net was refused");
    assert.ok(Math.abs(full.z - (STEP_CEIL - 0.02)) < 1e-12, "the net was not brought in");
  });
});
