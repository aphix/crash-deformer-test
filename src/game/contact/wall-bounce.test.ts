import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCar } from "./crash-scenarios.test-util.ts";
import { makeBox, solidFace } from "./external-contact.ts";
import { wallBounce } from "./pair-contact.ts";
import { FINE_HZ } from "../kernel/constants.ts";

// A light touch of a running car on a fixed face pushes it out and, where the face and the tyres hold it, back along the face the way it
// came in: never further along the face than the car itself moved along it in the slice.

const H = 1 / FINE_HZ;
/** The wall: its face on z = 0, facing +z toward the car. */
const NX = 0;
const NZ = 1;

/** A sedan at (0, z) facing +z, moving at (vx, vz), its tyres' sideways grip `hold` left, pushed out of a `pen` deep overlap; returns how far it moved along the face (x). */
function bounce(z: number, vx: number, vz: number, hold: number, pen: number): number {
  const car = makeCar();
  launch(car, 0, z, 0, vx, vz);
  car.drive.hold = hold;
  const face = solidFace(makeBox(), NX, NZ, 0, 0, 0, z, 10, 1);
  const x0 = car.group.position.x;
  wallBounce(car, face, NX, NZ, pen, H, false);
  return car.group.position.x - x0;
}

describe("given a running sedan touching a wall face lightly, its tyres holding its sideways speed", () => {
  it("when it is all but stopped and turned a corner 1.5 cm into the face (closing 1e-5 m/s, 3e-4 m/s along it), then the push out moves it along the face no further than it moved along it in the slice", () => {
    const along = 3e-4;
    const moved = bounce(2.3, -along, -1e-5, 1, 0.015);
    // `along0 · pen / closing` put a stopped cop 0.45 m a frame along a wall into its stakeout partner (Dam Spine seed 1).
    assert.ok(Math.abs(moved) <= along * H * (1 + 1e-9), `moved ${moved.toExponential(3)} m along the face; it moved ${(along * H).toExponential(3)} m along it in the slice`);
  });

  it("when it drove into the face at 30° and 10 m/s this slice, then it is put back along the face by exactly the slice's move along it", () => {
    const vx = -10 * Math.sin(Math.PI / 3);
    const vz = -10 * Math.cos(Math.PI / 3);
    const moved = bounce(2.3, vx, vz, 20, -vz * H);
    assert.ok(Math.abs(moved - -vx * H) < 1e-9, `moved ${moved.toExponential(4)} m back along the face, the slice moved it ${(vx * H).toExponential(4)}`);
  });
});
