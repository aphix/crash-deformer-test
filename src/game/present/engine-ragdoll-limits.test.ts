import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { flatSystem, flatThrow, headOn, rangeWall } from "./ragdoll-throws.test-util.ts";
import { noPose, type Pose, POSE_KEYS, throwSet, worst } from "./ragdoll-pose.test-util.ts";

/** The neck's stated swing (deg) and turn: 60–70° and about 70°. */
const SWING = 65;
const TWIST = 70;
/** Slack over a limit (deg): the solver gives a degree or two on the frame of a 30 m/s hit. */
const SLACK = 5;
/** The deepest the head box may sink into the chest box (m). */
const HEAD_IN = 0.02;
/** The most an elbow or a knee may bend the wrong way (deg). */
const HYPER = 10;

/** 60 flat-ground throws (4–30 m/s, every heading, half head-first, half tumbling), the range wall and a fleet head-on: the worst of each `Pose`. */
async function worstOfThrows(): Promise<Pose> {
  const all = noPose();
  const sys = await flatSystem();
  for (const shot of throwSet(60, 7)) worst(all, flatThrow(sys, shot, 4));
  sys.dispose();
  // The wall and the head-ons must really throw a dummy, or their zeros prove nothing.
  const scenes = [await rangeWall(5), ...(await headOn(20, 4))];
  for (const p of scenes) {
    assert.ok(p.swing > 10, "the scene threw a dummy whose neck moved");
    worst(all, p);
  }
  return all;
}

describe("given a thrown crash-test dummy whose joints must keep to human anatomy", () => {
  it("when it is thrown 60 times on flat ground, against the range wall and in a head-on, then the neck swings at most 65° + 5° and turns at most 70° + 5°, the head box sinks at most 2 cm into the chest, and no elbow or knee bends backward past 10°", async () => {
    const w = await worstOfThrows();
    const report = POSE_KEYS.map((k) => `${k} ${w[k].toFixed(3)}`).join(", ");
    assert.ok(w.swing <= SWING + SLACK, `neck swing ${w.swing.toFixed(1)}°: ${report}`);
    assert.ok(w.twist <= TWIST + SLACK, `neck twist ${w.twist.toFixed(1)}°: ${report}`);
    assert.ok(w.headChest <= HEAD_IN, `head in chest ${(w.headChest * 100).toFixed(1)} cm: ${report}`);
    assert.ok(w.elbow <= HYPER, `elbow hyperextended ${w.elbow.toFixed(1)}°: ${report}`);
    assert.ok(w.knee <= HYPER, `knee hyperextended ${w.knee.toFixed(1)}°: ${report}`);
  });

  for (const [name, tilt, spin] of [
    ["face first, tumbling forward", 135, 6],
    ["head first, straight down", 180, 0],
  ] as const) {
    it(`when a dummy is dropped ${name} at 10 m/s, then its head stays out of its chest through the fall, the landing and the rest, and its neck stays within the swing limit`, async () => {
      const sys = await flatSystem();
      // Turned `tilt` degrees about x (90 lies him face down, 180 stands him on his head), thrown straight down, spinning forward at `spin` rad/s.
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (tilt * Math.PI) / 180);
      const w = flatThrow(sys, { p: new THREE.Vector3(0, 1.5, 0), q, v: new THREE.Vector3(0, -10, 0), w: new THREE.Vector3(spin, 0, 0) }, 4);
      sys.dispose();
      assert.ok(w.headChest <= HEAD_IN, `head sank ${(w.headChest * 100).toFixed(1)} cm into the chest`);
      assert.ok(w.swing <= SWING + SLACK, `neck swing ${w.swing.toFixed(1)}°`);
    });
  }
});
