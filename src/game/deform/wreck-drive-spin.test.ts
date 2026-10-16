import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { StreamedDeformation } from "./streamed-deform.ts";
import { DT, dummyGeom } from "../vehicle/test-support.ts";
import { stepWreck, type WreckRig } from "./physics-util.test-util.ts";

/** The glancing hit's spin in the owner's fleet capture (seed 12003896, the pickup: -5.0 rad/s as its contact window closed). */
const SPIN = 5;
/** The contact window (`StreamedDeformation.live`) closes this long (s) after the last contact. */
const WINDOW_CLOSED_S = 0.4;
/** What a spin may change by in one step while nothing touches the wreck (rad/s). */
const SMOOTH_STEP = 0.25;

function spinningWreckPastItsHit(): WreckRig {
  const d = new StreamedDeformation(dummyGeom());
  d.mode = "shape";
  const group = new THREE.Group();
  group.updateMatrixWorld();
  const vel = new THREE.Vector3(0, 0, 20);
  const omega = new THREE.Vector3(0, SPIN, 0);
  d.beginCrush(new THREE.Vector3(0.62, 0.36, 2.06), new THREE.Vector3(0, 0, -1), 20, 20, group, vel, omega);
  return { d, group, vel, omega };
}

/** Steps the wreck until its contact window has been closed, its engine cut or not; the largest one-step change of its spin. */
function stepPastWindowClosing(rig: WreckRig, engineStalled: boolean): number {
  let largestChange = 0;
  assert.ok(rig.d.drivetrainAlive, "the drivetrain lives");
  rig.d.engineStalled = engineStalled;
  while (rig.d.quietTime() < WINDOW_CLOSED_S) {
    const before = rig.omega.y;
    stepWreck(rig, DT);
    largestChange = Math.max(largestChange, Math.abs(rig.omega.y - before));
  }
  return largestChange;
}

const cases = [
  { it: "when its drivetrain lives but its engine is cut by a side hit, then its spin runs on through the closing of the contact window", engineStalled: true, expectedSpinKept: true },
  { it: "when its drivetrain lives and its engine runs, then its tyres own the turn and the body keeps none", engineStalled: false, expectedSpinKept: false },
] as const;

describe("given a wreck spinning at 5 rad/s whose last contact was a glancing hit", () => {
  for (const testCase of cases) {
    it(testCase.it, () => {
      const rig = spinningWreckPastItsHit();
      const largestChange = stepPastWindowClosing(rig, testCase.engineStalled);
      if (testCase.expectedSpinKept) {
        assert.ok(Math.abs(rig.omega.y - SPIN) < 0.5, `spin ${rig.omega.y.toFixed(2)} rad/s after the window closed, from ${SPIN}`);
        assert.ok(largestChange < SMOOTH_STEP, `the spin changed by ${largestChange.toFixed(2)} rad/s in one step`);
      } else {
        assert.equal(rig.omega.y, 0, "the body's spin once the tyres own the turn");
      }
    });
  }
});
