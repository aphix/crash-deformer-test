import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { makeCar } from "../contact/crash-scenarios.test-util.ts";
import { FRAME_HZ } from "../kernel/constants.ts";
import { blankEjection, ejectionVelocity } from "../vehicle/ejection.ts";
import { setGround } from "../world/ground.ts";
import { RagdollSystem } from "./engine-ragdoll.ts";
import { type BoxPlacement, NO_RELEASE_SCALE, type ReleaseScale } from "./ragdoll-boxes.ts";

const FRAME = 1 / FRAME_HZ;
/** The default life of a thrown dummy (s): `LIFE` in engine-ragdoll.ts. */
const DEFAULT_LIFE_SECONDS = 10;
/** Sim seconds a held dummy must outlive (the minigames' flow: the camera holds with no timer). */
const HELD_SECONDS = 60;
/** A dummy held that long has been still for most of it (s). */
const HELD_STILL_SECONDS = 30;
/** The release scale of the scaled-launch row, and how near (m/s, an f32's resolution at 11 m/s) a scaled component must be. */
const FORWARD_SCALE = 0.5;
const UPWARD_SCALE = 1.2;
const SPEED_TOLERANCE = 1e-5;
const ONE_BOX: readonly BoxPlacement[] = [{ x: 20, y: 0.5, z: 0, yaw: 0, width: 1, height: 1, depth: 1 }];

/** A ragdoll system on the range's flat sand with no cars. */
async function system(): Promise<RagdollSystem> {
  const sys = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  sys.sand = true;
  await sys.preload();
  setGround(null);
  sys.update(FRAME, [], true, false, null);
  return sys;
}

/** An ejection out of the car's windshield, far from the origin: car velocity (7, -1, 5), his own (2, 12, 3). */
function farEjection() {
  const ejection = blankEjection();
  ejection.dir.set(0, 0, 1);
  ejection.pos.set(-300, 1.5, 0);
  ejection.rel.set(2, 12, 3);
  ejection.carVel.set(7, -1, 5);
  return ejection;
}

const dummyOf = (sys: RagdollSystem) => sys["dolls"][0]!;

describe("given a dummy launched through launch() from a car", () => {
  it("when holdThrown() was called and a minute of sim passes, then he is still alive and still, and releaseThrown() removes him", async () => {
    const sys = await system();
    const car = makeCar();
    sys.holdThrown();
    sys.launch(farEjection(), [car]);
    const torso = new THREE.Vector3();
    for (let frame = 0; frame < HELD_SECONDS * FRAME_HZ; frame++) sys.update(FRAME, [], true, false, null);
    const heldStill = sys.latest(torso);
    sys.releaseThrown();
    const afterRelease = sys.latest(torso);
    sys.dispose();
    assert.ok(heldStill > HELD_STILL_SECONDS, `after ${HELD_SECONDS} s he has lain still for ${heldStill.toFixed(1)} s (-1: he is gone)`);
    assert.equal(afterRelease, -1, "released: he is gone");
  });

  it("when nothing was held and 11 s of sim pass, then his 10 s life is over and he is gone", async () => {
    const sys = await system();
    const car = makeCar();
    sys.launch(farEjection(), [car]);
    const torso = new THREE.Vector3();
    for (let frame = 0; frame < (DEFAULT_LIFE_SECONDS + 1) * FRAME_HZ; frame++) sys.update(FRAME, [], true, false, null);
    const gone = sys.latest(torso);
    sys.dispose();
    assert.equal(gone, -1, "gone after LIFE");
  });

  it("when he was held and released, then the next dummy lives 10 s again", async () => {
    const sys = await system();
    const car = makeCar();
    sys.holdThrown();
    sys.releaseThrown();
    sys.launch(farEjection(), [car]);
    const torso = new THREE.Vector3();
    for (let frame = 0; frame < (DEFAULT_LIFE_SECONDS + 1) * FRAME_HZ; frame++) sys.update(FRAME, [], true, false, null);
    const gone = sys.latest(torso);
    sys.dispose();
    assert.equal(gone, -1, "the default life is back");
  });

  it("when reset() is called while a box stands and a dummy is held, then the box is gone and the next dummy lives 10 s", async () => {
    const sys = await system();
    sys.setBoxes(ONE_BOX);
    sys.holdThrown();
    sys.reset();
    const count = sys.copyBoxPoses(new Float32Array(0));
    const car = makeCar();
    sys.launch(farEjection(), [car]);
    const life = dummyOf(sys).life;
    sys.dispose();
    assert.equal(count, 0, "no boxes after reset");
    assert.equal(life, DEFAULT_LIFE_SECONDS, "LIFE after reset");
  });

  it("when launched with no scale, with the identity scale and with forward 0.5 and upward 1.2, then the first two equal the ejection's own velocity bit for bit and the third has its horizontal halved and its vertical raised by a fifth", async () => {
    const car = makeCar();
    const launched = async (scale: ReleaseScale | null) => {
      const sys = await system();
      const ejection = farEjection();
      if (scale === null) sys.launch(ejection, [car]);
      else sys.launch(ejection, [car], true, scale);
      const velocity = dummyOf(sys).bodies[0]!.linvel();
      const position = dummyOf(sys).bodies[0]!.translation();
      const own = ejectionVelocity(ejection, new THREE.Vector3());
      sys.dispose();
      return { velocity, position, own };
    };
    const unscaled = await launched(null);
    const identity = await launched({ forward: 1, upward: 1 });
    const named = await launched(NO_RELEASE_SCALE);
    const scaled = await launched({ forward: FORWARD_SCALE, upward: UPWARD_SCALE });
    assert.equal(unscaled.velocity.x, Math.fround(unscaled.own.x), "default x");
    assert.equal(unscaled.velocity.y, Math.fround(unscaled.own.y), "default y");
    assert.equal(unscaled.velocity.z, Math.fround(unscaled.own.z), "default z");
    assert.equal(identity.velocity.x, unscaled.velocity.x, "identity x");
    assert.equal(identity.velocity.y, unscaled.velocity.y, "identity y");
    assert.equal(identity.velocity.z, unscaled.velocity.z, "identity z");
    assert.equal(named.velocity.x, unscaled.velocity.x, "NO_RELEASE_SCALE x");
    assert.equal(named.velocity.y, unscaled.velocity.y, "NO_RELEASE_SCALE y");
    assert.equal(named.velocity.z, unscaled.velocity.z, "NO_RELEASE_SCALE z");
    assert.equal(NO_RELEASE_SCALE.forward, 1, "the named identity's forward");
    assert.equal(NO_RELEASE_SCALE.upward, 1, "the named identity's upward");
    assert.ok(Math.abs(scaled.velocity.x - FORWARD_SCALE * unscaled.own.x) < SPEED_TOLERANCE, `scaled x ${scaled.velocity.x} vs ${FORWARD_SCALE * unscaled.own.x}`);
    assert.ok(Math.abs(scaled.velocity.y - UPWARD_SCALE * unscaled.own.y) < SPEED_TOLERANCE, `scaled y ${scaled.velocity.y} vs ${UPWARD_SCALE * unscaled.own.y}`);
    assert.ok(Math.abs(scaled.velocity.z - FORWARD_SCALE * unscaled.own.z) < SPEED_TOLERANCE, `scaled z ${scaled.velocity.z} vs ${FORWARD_SCALE * unscaled.own.z}`);
    assert.equal(scaled.position.x, unscaled.position.x, "the scale does not move him: same start x");
    assert.equal(scaled.position.y, unscaled.position.y, "the scale does not move him: same start y");
    assert.equal(scaled.position.z, unscaled.position.z, "the scale does not move him: same start z");
  });
});
