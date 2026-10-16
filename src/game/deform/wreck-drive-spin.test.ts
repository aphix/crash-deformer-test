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

describe("given a wreck spinning at 5 rad/s whose last contact was a glancing hit", () => {
  it("when its drivetrain lives and the contact window closes, then its tyres own the turn and the body keeps none", () => {
    const rig = spinningWreckPastItsHit();
    assert.ok(rig.d.drivetrainAlive, "the drivetrain lives");
    while (rig.d.quietTime() < WINDOW_CLOSED_S) stepWreck(rig, DT);
    assert.equal(rig.omega.y, 0, "the body's spin once the tyres own the turn");
  });
});
