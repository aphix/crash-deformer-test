import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applyDrive, DRIVE, DriverSeat, driftPay, idleDrive, type DriveInput } from "./car-drive.ts";
import { blankIntent, FEEL, readIntent, shapeDrive } from "./drive-input.ts";
import { DeformableCar } from "./car.ts";
import { DT } from "./test-support.ts";
import { CLASSES, HANDLING } from "./vehicle-classes.ts";

/** The gameplay assists fade in and out over time and over how far the inputs are past a gate (masterclass 23:34): none is a switch. */

const RATES = [DT, DT / 2] as const;
const PAINT = { body: 0xc5c8ce, accent: 0x9aa0a8, name: "Titanium" };
const DEFAULT_REALISM = HANDLING.realism;

afterEach(() => {
  HANDLING.realism = DEFAULT_REALISM;
});

function carAt(speed: number): DeformableCar {
  const car = new DeformableCar(PAINT, new THREE.Scene());
  car.spawnFacing(0, 0, 0, speed);
  return car;
}

/** One slice with the car's speed along its nose pinned first: these tests grade the input, not the speed the car sheds meanwhile. */
function pinned(car: DeformableCar, input: DriveInput, dt: number, speed: number): void {
  car.velocity.set(car.fwdFlat.x * speed, 0, car.fwdFlat.z * speed);
  applyDrive(car, input, dt);
}

/** The slide a handbrake held `seconds` at `steer` and `speed` builds. */
function flickDrift(steer: number, speed: number, dt: number, seconds = 0.6): number {
  const car = carAt(speed);
  const input: DriveInput = { ...idleDrive(), throttle: 1, steer, ebrake: true };
  for (let t = 0; t < seconds - 1e-9; t += dt) pinned(car, input, dt, speed);
  return car.drive.drift;
}

for (const dt of RATES) {
  const hz = (1 / dt).toFixed(0);

  describe(`given a handbrake held at a sedan's speed, stepping at ${hz} Hz`, () => {
    it("when the lock grows from just under the gate to full, then the slide it builds grows with it: none under 0.15, gentle just past it, full at 0.5", () => {
      const at = [0.14, 0.16, 0.2, 0.3, 0.4, 0.5, 1].map((s) => flickDrift(s, 12, dt));
      assert.equal(at[0], 0, `under the gate: ${at[0]}`);
      assert.ok(at[1]! > 0 && at[1]! < 0.1, `just past the gate: ${at[1]!.toFixed(3)}`);
      for (let i = 1; i < at.length; i++) assert.ok(at[i]! >= at[i - 1]!, `lock ${i}: ${at.map((x) => x.toFixed(2)).join(" ")}`);
      for (let i = 1; i < at.length; i++) assert.ok(at[i]! - at[i - 1]! < 0.3, `a step of the lock jumped the slide: ${at.map((x) => x.toFixed(2)).join(" ")}`);
      assert.ok(at[5]! > 0.9 && at[6]! > 0.9, `full lock: ${at[5]!.toFixed(2)} ${at[6]!.toFixed(2)}`);
    });

    it("when the speed grows from just under the slide minimum to 10 m/s at full lock, then the slide it builds grows with it: none at 5.9, gentle at 6.1, about half at 8, full at 10", () => {
      const at = [5.9, 6.1, 8, 10].map((v) => flickDrift(1, v, dt, 0.4));
      assert.equal(at[0], 0, `under the minimum: ${at[0]}`);
      assert.ok(at[1]! > 0 && at[1]! < 0.1, `just past it: ${at[1]!.toFixed(3)}`);
      assert.ok(at[2]! > 0.3 && at[2]! < 0.7, `8 m/s: ${at[2]!.toFixed(3)}`);
      assert.ok(at[3]! > 0.9, `10 m/s: ${at[3]!.toFixed(3)}`);
    });

    it("when a slide is set at drift 0.03 to 0.09 in steps of 0.01 across the point the yaw clamp hands over, then the yaw rate it gives never steps by more than 0.1 rad/s between neighbours: the clamp is blended out, not dropped at 0.05", () => {
      HANDLING.realism = 0;
      const yawAt = (drift: number) => {
        const car = carAt(20);
        car.drive.drift = drift;
        pinned(car, { ...idleDrive(), throttle: 0.6, steer: 1 }, dt, 20);
        return Math.abs(car.angular.y);
      };
      const yaw = [0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09].map(yawAt);
      for (let i = 1; i < yaw.length; i++) {
        assert.ok(Math.abs(yaw[i]! - yaw[i - 1]!) < 0.1, `yaw ${yaw.map((y) => y.toFixed(3)).join(" ")}`);
      }
    });
  });

  describe(`given a keyboard brake tap at a speed with the wheel at lock, stepping at ${hz} Hz`, () => {
    /** The handbrake grip (`drive.ebrakeK`) the car applies after a brake tap of `tap` s, per slice. */
    function grip(tap: number): number[] {
      const car = carAt(15);
      const feel = { wheel: 0, gas: 0, brake: 0, brakeHeld: 0, pulse: 0 };
      const out = idleDrive();
      const series: number[] = [];
      const run = (keys: string[], seconds: number, record: boolean) => {
        const intent = readIntent(new Set(keys), null, blankIntent());
        for (let t = 0; t < seconds - 1e-9; t += dt) {
          shapeDrive(intent, feel, 15, dt, out);
          pinned(car, out, dt, 15);
          if (record) series.push(car.drive.ebrakeK);
        }
      };
      run(["KeyW", "KeyA"], 0.5, false);
      run(["KeyW", "KeyA", "KeyS"], tap, false);
      run(["KeyW", "KeyA"], 0.6, true);
      return series;
    }
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0) * dt;

    it("when the tap lasts 0.03 s, 0.1 s and 0.24 s, then the handbrake's peak grip and impulse grow with it: a short tap is a small kick, a long one the full flick", () => {
      const taps = [0.03, 0.1, 0.24].map(grip);
      const peaks = taps.map((s) => Math.max(...s));
      assert.ok(peaks[0]! > 0 && peaks[0]! < 0.7, `short peak ${peaks[0]}`);
      assert.ok(peaks[1]! > peaks[0]! + 0.05, `mid peak ${peaks[1]}`);
      assert.ok(peaks[2]! > 0.95, `long peak ${peaks[2]}`);
      assert.ok(sum(taps[0]!) < sum(taps[1]!) && sum(taps[1]!) < sum(taps[2]!), `impulses ${taps.map((s) => sum(s).toFixed(4)).join(" ")}`);
    });

    it("when the tap ends, then the grip comes in and goes out at no more than 1/ebrakeIn and 1/ebrakeOut per second and is back to 0 well inside 0.6 s: no step at the window's edges", () => {
      for (const tap of [0.03, 0.24]) {
        const s = grip(tap);
        let prev = 0;
        for (const g of s) {
          const d = g - prev;
          assert.ok(d <= dt / DRIVE.ebrakeIn + 1e-9 && -d <= dt / DRIVE.ebrakeOut + 1e-9, `tap ${tap}: step ${d.toFixed(4)}`);
          prev = g;
        }
        assert.equal(s[s.length - 1], 0, `tap ${tap}: still ${s[s.length - 1]}`);
      }
      assert.ok(FEEL.tapPulse > FEEL.tapPulseMin);
    });
  });

  describe(`given a sedan boosting over its unboosted top speed that touches down from a jump, stepping at ${hz} Hz`, () => {
    it("when its first grounded slices run with boost held, then it keeps its speed (the thrust is on at once, so the drive never brakes it to the unboosted top)", () => {
      const k = CLASSES.sedan;
      const speed = k.topSpeed * (1 + (k.boostTop - 1) / 2);
      const car = carAt(speed);
      // Airborne the boost is off, so it touches down with no thrust applied.
      car.drive.boostK = 0;
      for (let t = 0; t < 0.1 - 1e-9; t += dt) applyDrive(car, { ...idleDrive(), throttle: 1, boost: true }, dt);
      const v = Math.hypot(car.velocity.x, car.velocity.z);
      assert.ok(v > speed - 0.2, `${speed.toFixed(1)} m/s fell to ${v.toFixed(1)} m/s in 0.1 s`);
    });
  });
}

describe("given the seat paying out a slide that ends", () => {
  const stub = (quiet: number) => ({
    velocity: new THREE.Vector3(10, 0, 0),
    fwdFlat: new THREE.Vector3(1, 0, 0),
    drive: { drift: 1, boostK: 0 },
    deform: { quietTime: () => quiet },
  });
  /** What a 1 s slide pays when it ends `quiet` s after the last contact. */
  function paid(quiet: number): number {
    const seat = new DriverSeat();
    seat.boost = 0;
    const car = stub(quiet);
    for (let t = 0; t < 1 - 1e-9; t += DT) seat.input(car as never, DT);
    car.drive.drift = 0;
    seat.input(car as never, DT);
    return seat.boost;
  }

  it("when the last contact was 0, 0.25, 0.49, 0.51 and 2 s before the end, then the payout grows with its age to the full share, with no cliff between 0.49 and 0.51", () => {
    const pay = [0, 0.25, 0.49, 0.51, 2].map(paid);
    const full = driftPay(1);
    assert.equal(pay[0], 0);
    assert.ok(Math.abs(pay[1]! - full * 0.5) < 1e-9, `0.25 s: ${pay[1]}`);
    assert.ok(Math.abs(pay[3]! - full) < 1e-9 && Math.abs(pay[4]! - full) < 1e-9, `clean: ${pay[3]} ${pay[4]}`);
    assert.ok(pay[3]! - pay[2]! < 0.05 * full, `cliff: ${pay[2]} → ${pay[3]}`);
  });
});
