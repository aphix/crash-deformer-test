import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyDrive, DRIVE, idleDrive, type DriveInput } from "./car-drive.ts";
import type { DeformableCar } from "./car.ts";
import { makeCar } from "./ground-probe.test-util.ts";
import { HANDLING } from "./vehicle-classes.ts";
import { FINE_HZ, QUIET_HZ } from "../kernel/constants.ts";

// A slide held with the stick in the deadband keeps its body angle; the hold fades out as the stick leaves (`held`, over one deadband of
// travel), so the aim moves from the angle held to the angle steered without a step (masterclass 23:34, fade over binaries).

const DEFAULT_REALISM = HANDLING.realism;
afterEach(() => {
  HANDLING.realism = DEFAULT_REALISM;
});

/** The muscle car in a held slide at the arcade end: a handbrake flick at 25 m/s, full lock on the gas, then hands off for half a second. */
function heldSlide(h: number): DeformableCar {
  HANDLING.realism = 0;
  const car = makeCar("muscle");
  car.spawnFacing(0, 0, 0, 25);
  const step = (input: DriveInput, s: number) => {
    for (let t = 0; t < s; t += h) {
      applyDrive(car, input, h);
      car.integrate(h);
    }
  };
  step({ ...idleDrive(), throttle: 1, steer: 1, ebrake: true }, 0.4);
  step({ ...idleDrive(), throttle: 1, steer: 1 }, 0.6);
  step({ ...idleDrive(), throttle: 1, steer: 0 }, 0.5);
  assert.ok(car.drive.drift > 0.9, `held at drift ${car.drive.drift.toFixed(2)}`);
  return car;
}

for (const h of [1 / QUIET_HZ, 1 / FINE_HZ]) {
  describe(`given the muscle car in a held slide, the stick leaving the deadband over half a second, at ${Math.round(1 / h)} Hz`, () => {
    it("when the stick crosses the deadband, then the yaw rate changes no faster across the crossing than in the slices before it, within 20 %, and the hold is still whole inside the deadband", () => {
      const car = heldSlide(h);
      const rates: number[] = [];
      const steers: number[] = [];
      for (let t = 0; t < 0.5; t += h) {
        const steer = (0.3 * t) / 0.5;
        const yaw = car.yaw;
        applyDrive(car, { ...idleDrive(), throttle: 1, steer }, h);
        car.integrate(h);
        rates.push((car.yaw - yaw) / h);
        steers.push(steer);
      }
      const cross = steers.findIndex((s) => s > DRIVE.driftDeadband);
      const before = Math.abs(rates[cross - 1]! - rates[cross - 2]!);
      const at = Math.abs(rates[cross]! - rates[cross - 1]!);
      // Across the crossing the yaw rate may move at most 20 % of itself per slice more than it did the slice before (a switch dropped it 80 % in one slice).
      assert.ok(at <= before + 0.2 * Math.abs(rates[cross - 1]!) * (h * QUIET_HZ), `the yaw rate stepped ${at.toFixed(3)} rad/s at the crossing (${rates[cross - 1]!.toFixed(3)} → ${rates[cross]!.toFixed(3)}), ${before.toFixed(3)} the slice before`);
      assert.ok(car.drive.drift > 0.9, `the slide is still held at drift ${car.drive.drift.toFixed(2)} past the deadband`);
    });

    it("when the stick stays inside the deadband, then the aim is the angle held: the yaw rate is the same slice for slice as with the stick dead centre", () => {
      const centre = heldSlide(h);
      const inside = heldSlide(h);
      for (let t = 0; t < 0.3; t += h) {
        const y0 = centre.yaw;
        const y1 = inside.yaw;
        applyDrive(centre, { ...idleDrive(), throttle: 1, steer: 0 }, h);
        applyDrive(inside, { ...idleDrive(), throttle: 1, steer: 0.5 * DRIVE.driftDeadband }, h);
        centre.integrate(h);
        inside.integrate(h);
        assert.equal(inside.yaw - y1, centre.yaw - y0, `yaw step at ${t.toFixed(3)} s`);
      }
    });

    describe("given a gentle hands-off slide (a short flick) unwinding on the gas", () => {
      it("when the body straightens through the slip gate, then the yaw rate never rises from one slice to the next: the hold ends as a catch, not a kick back to the steered angle", () => {
        HANDLING.realism = 0;
        const car = makeCar("muscle");
        car.spawnFacing(0, 0, 0, 25);
        const step = (input: DriveInput, s: number, each?: () => void) => {
          for (let t = 0; t < s; t += h) {
            applyDrive(car, input, h);
            car.integrate(h);
            each?.();
          }
        };
        step({ ...idleDrive(), throttle: 1, steer: 1, ebrake: true }, 0.12);
        step({ ...idleDrive(), throttle: 1, steer: 1 }, 0.15);
        assert.ok(car.drive.drift > 0.5, `sliding at drift ${car.drive.drift.toFixed(2)}`);
        let last = Infinity;
        const rises: string[] = [];
        let t = 0;
        step({ ...idleDrive(), throttle: 1, steer: 0 }, 4, () => {
          t += h;
          const rate = Math.abs(car.yawRate);
          if (rate > last + 1e-9) rises.push(`${t.toFixed(2)} s: ${last.toFixed(3)} → ${rate.toFixed(3)}`);
          last = rate;
        });
        assert.deepEqual(rises, [], `the yaw rate rose at ${rises.slice(0, 4).join("; ")}${rises.length > 4 ? ` (+${rises.length - 4})` : ""}`);
        assert.equal(car.drive.drift, 0, "the slide ended");
      });
    });
  });
}
