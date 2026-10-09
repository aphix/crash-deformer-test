import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyDrive, type DriveInput } from "./car-drive.ts";
import { G } from "./car-air.ts";
import { WHEEL_POS } from "./car-mesh.ts";
import { makeCar } from "./ground-probe.test-util.ts";
import { STIFF_HZ, useStiffSprings } from "./stiff-springs.test-util.ts";

/**
 * A driven car on flat ground holds its pitch and roll. Its springs are the stiff, short ones of `useStiffSprings` (the
 * fewest variables: the body's own swing is the only motion), and a bump has just knocked it.
 */
const SLICE_RATES_HZ = [60, 120, 240] as const;
const KNOCK = { pitchRate: 0.3, rollRate: 0.21 };
const SETTLE_S = 3;
const MEASURED_S = 1;
const CRUISE: DriveInput = { throttle: 0.5, steer: 0, brake: 0, ebrake: false, boost: false };
/** A tilt step smaller than this (rad) is rounding noise, not a direction. */
const ROUNDING_RAD = 1e-9;
const HALF_TRACK = Math.abs(WHEEL_POS[0]![0]);
const HALF_WHEELBASE = Math.abs(WHEEL_POS[0]![2]);
/** One spring's static sag (m) at the stiff ride: a quarter of the weight over a quarter of the body's stiffness, G / (2π f)². */
const STATIC_SAG = G / (2 * Math.PI * STIFF_HZ) ** 2;

/** How many times the tilt `series` (rad, one per slice) turned around between slices. */
function reversals(series: readonly number[]): number {
  let turns = 0;
  let previousStep = 0;
  for (let i = 1; i < series.length; i++) {
    const step = series[i]! - series[i - 1]!;
    if (Math.abs(step) <= ROUNDING_RAD) continue;
    if (previousStep !== 0 && Math.sign(step) !== Math.sign(previousStep)) turns++;
    previousStep = step;
  }
  return turns;
}

function largest(series: readonly number[]): number {
  return Math.max(...series.map(Math.abs));
}

describe("given a driven car on flat ground with stiff, short springs, knocked in pitch and roll", () => {
  let restoreSprings = (): void => {};
  before(() => {
    restoreSprings = useStiffSprings();
  });
  after(() => restoreSprings());

  for (const hz of SLICE_RATES_HZ) {
    it(`when it cruises on slices of ${hz} Hz after the knock has died away, then its pitch and roll stay within the tilt of one spring's static sag and never reverse from slice to slice`, () => {
      const car = makeCar("sedan");
      car.spawnFacing(13.7, -41.3, 0.73, 0);
      car.angular.set(KNOCK.pitchRate, 0, KNOCK.rollRate);
      const slice = 1 / hz;
      const pitch: number[] = [];
      const roll: number[] = [];
      for (let s = 0; s < Math.round((SETTLE_S + MEASURED_S) * hz); s++) {
        applyDrive(car, CRUISE, slice);
        car.integrate(slice);
        if (s < Math.round(SETTLE_S * hz)) continue;
        pitch.push(car.pitch);
        roll.push(car.roll);
      }
      assert.ok(largest(pitch) <= STATIC_SAG / HALF_WHEELBASE, `pitch ${(largest(pitch) * 1000).toFixed(3)} mrad over the sag's ${((STATIC_SAG / HALF_WHEELBASE) * 1000).toFixed(3)}`);
      assert.ok(largest(roll) <= STATIC_SAG / HALF_TRACK, `roll ${(largest(roll) * 1000).toFixed(3)} mrad over the sag's ${((STATIC_SAG / HALF_TRACK) * 1000).toFixed(3)}`);
      assert.equal(reversals(pitch), 0, "pitch reversals");
      assert.equal(reversals(roll), 0, "roll reversals");
    });
  }
});
