import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { FINE_HZ } from "../kernel/constants.ts";
import { SPIN_RATE_BAR, verticalTurn } from "./vertical-turn.test-util.ts";

const STEP_S = 1 / FINE_HZ;
const EULER_ORDER = "YXZ";
const RATE_TOLERANCE = 0.05;

const quaternion = (xyzw: readonly number[]) => new THREE.Quaternion(xyzw[0], xyzw[1], xyzw[2], xyzw[3]);
const eulerYaw = (q: THREE.Quaternion) => new THREE.Euler().setFromQuaternion(q, EULER_ORDER).y;

/** Derby seed 1, c2 at 12.60 s: airborne after a ring-wall hit, nose 70° up and rolling, its mass spin about the vertical 3.7 rad/s while its Euler yaw read 6.8. */
const TUMBLING_FROM = [-0.5119077976834439, 0.28822882465912086, -0.27331843105631415, -0.7616899543458667] as const;
const TUMBLING_TO = [-0.5145082933736278, 0.2810557888158411, -0.27139291079902245, -0.7633051471010016] as const;

describe("given a car airborne and pitched 70° up, rolling, one 240 Hz step apart (the derby seed 1 tumble)", () => {
  it("when its turn is read about the vertical, then it is under the spin bar though its Euler yaw changes faster than the bar", () => {
    const from = quaternion(TUMBLING_FROM);
    const to = quaternion(TUMBLING_TO);
    const eulerRate = Math.abs(eulerYaw(to) - eulerYaw(from)) / STEP_S;
    const verticalRate = Math.abs(verticalTurn(from, to)) / STEP_S;
    assert.ok(eulerRate > SPIN_RATE_BAR, `Euler yaw ${eulerRate.toFixed(2)} rad/s: the pose no longer separates the two readings`);
    assert.ok(Math.abs(verticalRate - 3.7) < 0.2, `vertical turn ${verticalRate.toFixed(2)} rad/s`);
    assert.ok(verticalRate < SPIN_RATE_BAR, `vertical turn ${verticalRate.toFixed(2)} rad/s is past the spin bar`);
  });
});

const levelCases = [
  { it: "when it turns left at 2 rad/s, then the vertical turn is its yaw change", yawRate: 2 },
  { it: "when it turns right at 7 rad/s, then the vertical turn is its yaw change, signed", yawRate: -7 },
] as const;

describe("given a car level on its wheels", () => {
  for (const testCase of levelCases) {
    it(testCase.it, () => {
      const from = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.4, 0, EULER_ORDER));
      const to = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.4 + testCase.yawRate * STEP_S, 0, EULER_ORDER));
      assert.ok(Math.abs(verticalTurn(from, to) / STEP_S - testCase.yawRate) < RATE_TOLERANCE, `read ${(verticalTurn(from, to) / STEP_S).toFixed(3)} rad/s`);
    });
  }
});
