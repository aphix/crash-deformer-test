import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCar } from "./crash-scenarios.test-util.ts";
import { physicsSlice, sliceSpeed } from "./sat.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";
import { applyDrive } from "../vehicle/car-drive.ts";
import type { DeformableCar } from "../vehicle/car.ts";

const FRAME = 1 / 60;
/** The pusher's drive speed (m/s): a derby AI's, 8 m/s (29 km/h). */
const DRIVE = 8;

/** Mass-weighted centroid (x, z) of a car's masses: what they have done. */
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
 * A car driven at `DRIVE` into a resting car's flank, in the engine's frame order (1/60 s frames, each stepped in slices of
 * `physicsSlice`), the pusher's throttle holding its speed as a driver does. Per frame: the resting car's centroid step (m)
 * and its reported speed (m/s, `car.velocity`, what `followGroup` reads off its masses), from the first frame it is a wreck.
 */
function shoveFlank(seconds: number): { step: number; speed: number }[] {
  const pusher = makeCar("shape");
  const victim = makeCar("shape");
  launch(victim, 0, 0, 0, 0, 0);
  launch(pusher, -6, 0, Math.PI / 2, DRIVE, 0);
  const world = newWorld([pusher, victim]);
  const frames: { step: number; speed: number }[] = [];
  let owed = 0;
  let before = centroid(victim);
  for (let f = 0; f < seconds / FRAME; f++) {
    owed += FRAME;
    const vmax = sliceSpeed([pusher, victim]);
    while (owed > 1e-6) {
      const h = physicsSlice(Infinity, vmax);
      const along = pusher.velocity.x * pusher.fwdFlat.x + pusher.velocity.z * pusher.fwdFlat.z;
      applyDrive(pusher, { throttle: Math.max(-1, Math.min(1, (DRIVE - along) * 2)), steer: 0, brake: 0, ebrake: false, boost: false }, h);
      stepWorld(world, h);
      owed -= h;
    }
    const after = centroid(victim);
    if (victim.deform.massActive) frames.push({ step: Math.hypot(after[0] - before[0], after[1] - before[1]), speed: Math.hypot(victim.velocity.x, victim.velocity.z) });
    before = after;
  }
  return frames;
}

describe("given a car driven at 8 m/s into a resting car's flank", () => {
  // Derby ten cars, 40 s, main ef6611a: 791 car-frames where a car moved over 0.06 m in one 1/60 s frame at a reported speed
  // under 1 m/s (the larger of this frame's and the last's), 0.14 m the longest step, every one of them shoved by a car
  // driven into it. The pair solver pushed the flank out by position, up to 4–8 m/s, and none of it became the car's
  // velocity: this scene held the resting car at 4.4 m/s of travel for 2 s at a reported 0.06 m/s.
  it("when the shove plays out for 2.5 s, then no frame moves the struck car over 0.06 m while its reported speed is under 1 m/s", () => {
    const frames = shoveFlank(2.5);
    assert.ok(frames.length > 100, `the resting car did not become a wreck (${frames.length} frames)`);
    const zips = frames.filter((fr, i) => fr.step > 0.06 && Math.max(fr.speed, frames[i - 1]?.speed ?? 0) < 1);
    assert.equal(zips.length, 0, `${zips.length} of ${frames.length} frames over 0.06 m at a reported speed under 1 m/s, first ${zips[0]?.step.toFixed(3)} m at ${zips[0]?.speed.toFixed(2)} m/s`);
  });

  // A shove that moves a car is its velocity: the cars trade the momentum their closing leaves (the pusher's drive speed
  // against the flank), so the reported speed is what the masses do. Measured here: reported 0.50 m/s against 4.5 m/s of
  // travel on ef6611a and with the hit and crush-hull trade alone (11 %), 5.5 against 7.0 m/s (79 %) with the COM-gap floor
  // traded as well: the rest is the wheels' re-fit (`clampLocal`) and a frame's average step against its end speed.
  it("when the shove plays out for 2.5 s, then the struck car's reported speed (after its first second) is at least 70 % of the speed its masses travel at", () => {
    const frames = shoveFlank(2.5).slice(60);
    const travel = frames.reduce((s, fr) => s + fr.step, 0) / (frames.length * FRAME);
    const reported = frames.reduce((s, fr) => s + fr.speed, 0) / frames.length;
    assert.ok(reported >= 0.7 * travel, `the shoved car reads ${reported.toFixed(2)} m/s while its masses travel ${travel.toFixed(2)} m/s`);
  });
});
