import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DERBY_RADIUS } from "../scenes/derby-arena.ts";
import { DISC_GROUND, DISC_RADIUS, FLAT_GROUND, Ground, setGround } from "../world/ground.ts";
import { FRAME_HZ } from "../kernel/constants.ts";
import { blankFreeInput, DRAG_PITCH_PER_PX as PITCH_PER_PX, DRAG_YAW_PER_PX as YAW_PER_PX, FreeCam, type FreeInput, PAD_YAW_RATE, sceneExtent } from "./free-cam.ts";

const DT = 1 / FRAME_HZ;
const DISC_REACH = new FreeCam().reach;
const DISC_CRUISE = new FreeCam().cruise;

/** A camera at `at` looking down -z (yaw 0, pitch 0), and a free eye begun from it. */
function begun(at = new THREE.Vector3(0, 30, 0)) {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 180);
  camera.position.copy(at);
  const free = new FreeCam();
  free.begin(camera);
  return { camera, free };
}

/** `seconds` of frames holding `held`. */
function fly(free: FreeCam, camera: THREE.PerspectiveCamera, held: Partial<FreeInput>, seconds: number): void {
  const input = { ...blankFreeInput(), ...held };
  for (let frame = 0; frame < Math.round(seconds * FRAME_HZ); frame++) free.step(camera, input, DT);
}

afterEach(() => setGround(null));

describe("given a free eye begun from the camera's pose", () => {
  it("when it begins and no key is held, then the camera keeps the position and view it had", () => {
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 180);
    camera.position.set(3, 7, -4);
    camera.lookAt(10, 2, -30);
    const before = camera.getWorldDirection(new THREE.Vector3());
    const free = new FreeCam();
    free.begin(camera);
    fly(free, camera, {}, 1);
    const after = camera.getWorldDirection(new THREE.Vector3());
    assert.ok(camera.position.distanceTo(new THREE.Vector3(3, 7, -4)) < 1e-9, `the eye moved to ${camera.position.toArray().join(", ")}`);
    assert.ok(after.distanceTo(before) < 1e-6, `the view turned by ${after.distanceTo(before)}`);
  });

  const moves = [
    { it: "when forward is held for a second, then the eye goes the cruise speed ahead", held: { forward: 1 }, expectedX: 0, expectedY: 30, expectedZ: -DISC_CRUISE },
    { it: "when back is held for a second, then the eye goes the cruise speed astern", held: { forward: -1 }, expectedX: 0, expectedY: 30, expectedZ: DISC_CRUISE },
    { it: "when strafe right is held for a second, then the eye goes the cruise speed right", held: { strafe: 1 }, expectedX: DISC_CRUISE, expectedY: 30, expectedZ: 0 },
    { it: "when rise is held for a second, then the eye climbs the cruise speed", held: { rise: 1 }, expectedX: 0, expectedY: 30 + DISC_CRUISE, expectedZ: 0 },
    { it: "when sink is held for a second, then the eye drops the cruise speed", held: { rise: -1 }, expectedX: 0, expectedY: 30 - DISC_CRUISE, expectedZ: 0 },
    { it: "when forward and fast are held for a second, then the eye goes three times the cruise speed ahead", held: { forward: 1, fast: true }, expectedX: 0, expectedY: 30, expectedZ: -3 * DISC_CRUISE },
    { it: "when forward and strafe are held together for a second, then the eye goes the cruise speed along the diagonal, no faster", held: { forward: 1, strafe: 1 }, expectedX: DISC_CRUISE / Math.SQRT2, expectedY: 30, expectedZ: -DISC_CRUISE / Math.SQRT2 },
  ];
  for (const testCase of moves) {
    it(testCase.it, () => {
      const { camera, free } = begun();
      fly(free, camera, testCase.held, 1);
      assert.ok(Math.abs(camera.position.x - testCase.expectedX) < 1e-6, `x ${camera.position.x}`);
      assert.ok(Math.abs(camera.position.y - testCase.expectedY) < 1e-6, `y ${camera.position.y}`);
      assert.ok(Math.abs(camera.position.z - testCase.expectedZ) < 1e-6, `z ${camera.position.z}`);
    });
  }

  it("when the view is dragged a quarter turn left and forward is held, then the eye goes along the new heading", () => {
    const { camera, free } = begun();
    free.lookBy(-Math.PI / 2 / YAW_PER_PX, 0);
    fly(free, camera, { forward: 1 }, 1);
    assert.ok(Math.abs(camera.position.x + DISC_CRUISE) < 1e-6, `x ${camera.position.x} (a left turn from -z faces -x)`);
    assert.ok(Math.abs(camera.position.z) < 1e-6, `z ${camera.position.z}`);
  });

  it("when the view looks a radian down and forward is held, then the eye moves level, in the look plane", () => {
    const { camera, free } = begun();
    free.lookBy(0, 1 / PITCH_PER_PX);
    fly(free, camera, { forward: 1 }, 1);
    assert.ok(Math.abs(camera.position.y - 30) < 1e-6, `height ${camera.position.y}`);
    assert.ok(Math.abs(camera.position.z + DISC_CRUISE) < 1e-6, `z ${camera.position.z}`);
  });

  const looks = [
    { it: "when the pointer drags 100 px right, then the view turns right by 100 px of yaw", dx: 100, dy: 0, expectedYaw: -100 * YAW_PER_PX, expectedPitch: 0 },
    { it: "when the pointer drags 100 px down, then the view looks down by 100 px of pitch", dx: 0, dy: 100, expectedYaw: 0, expectedPitch: -100 * PITCH_PER_PX },
    { it: "when the pointer drags far down, then the pitch stops short of straight down", dx: 0, dy: 1e6, expectedYaw: 0, expectedPitch: -1.5 },
    { it: "when the pointer drags far up, then the pitch stops short of straight up", dx: 0, dy: -1e6, expectedYaw: 0, expectedPitch: 1.5 },
  ];
  for (const testCase of looks) {
    it(testCase.it, () => {
      const { camera, free } = begun();
      free.lookBy(testCase.dx, testCase.dy);
      fly(free, camera, {}, DT);
      const view = camera.getWorldDirection(new THREE.Vector3());
      assert.ok(Math.abs(free.yaw - testCase.expectedYaw) < 1e-9, `yaw ${free.yaw}`);
      assert.ok(Math.abs(free.pitch - testCase.expectedPitch) < 1e-9, `pitch ${free.pitch}`);
      assert.ok(Math.abs(view.y - Math.sin(testCase.expectedPitch)) < 1e-6, `the camera's own view has the pitch (${view.y})`);
    });
  }

  it("when the right stick is held right for a second, then the view turns right by the pad's yaw rate", () => {
    const { camera, free } = begun();
    fly(free, camera, { lookX: 1 }, 1);
    assert.ok(Math.abs(free.yaw + PAD_YAW_RATE) < 1e-6, `yaw ${free.yaw}`);
  });

  const wheels = [
    { it: "when the wheel is turned up a lot, then a flight is eight times the cruise", deltaY: -1e5, expectedAhead: 8 * DISC_CRUISE * 0.1 },
    { it: "when the wheel is turned down a lot, then a flight is an eighth of the cruise", deltaY: 1e5, expectedAhead: (DISC_CRUISE / 8) * 0.1 },
    { it: "when the wheel is turned up a notch, then a flight is exp(0.15) times the cruise", deltaY: -100, expectedAhead: DISC_CRUISE * Math.exp(0.15) * 0.1 },
  ];
  for (const testCase of wheels) {
    it(testCase.it, () => {
      const { camera, free } = begun();
      free.speedBy(testCase.deltaY);
      fly(free, camera, { forward: 1 }, 0.1);
      assert.ok(Math.abs(-camera.position.z - testCase.expectedAhead) < 1e-6, `${-camera.position.z} m ahead in 0.1 s, expected ${testCase.expectedAhead}`);
    });
  }

  it("when two fingers drag 100 px right, then the eye slides left by a quarter of the reach per 100 px", () => {
    const { camera, free } = begun();
    free.panBy(100, 0);
    fly(free, camera, {}, DT);
    assert.ok(Math.abs(camera.position.x + (100 * DISC_REACH) / 400) < 1e-6, `x ${camera.position.x} (${DISC_REACH} m of reach over 400 px)`);
  });

  it("when a pinch widens by 40 px, then the eye goes a tenth of the reach forward along the view, and closing it comes back", () => {
    const { camera, free } = begun();
    free.lookBy(0, 1 / PITCH_PER_PX);
    free.dollyBy(40);
    fly(free, camera, {}, DT);
    const ahead = new THREE.Vector3(0, 30, 0).sub(camera.position).length();
    assert.ok(Math.abs(ahead - DISC_REACH / 10) < 1e-6, `${ahead} m along the look`);
    assert.ok(camera.position.y < 30 - 5, `the eye went down the view's slope (${camera.position.y})`);
    free.dollyBy(-40);
    fly(free, camera, {}, DT);
    assert.ok(camera.position.distanceTo(new THREE.Vector3(0, 30, 0)) < 1e-6, "closing the fingers returns it");
  });
});

describe("given the free eye over the ground", () => {
  it("when it sinks for five seconds over flat ground, then it stops above the ground and never goes below", () => {
    const { camera, free } = begun(new THREE.Vector3(0, 10, 0));
    setGround(FLAT_GROUND);
    let lowest = Infinity;
    for (let frame = 0; frame < 5 * FRAME_HZ; frame++) {
      free.step(camera, { ...blankFreeInput(), rise: -1 }, DT);
      lowest = Math.min(lowest, camera.position.y);
    }
    assert.ok(lowest > 0.5, `the eye reached ${lowest.toFixed(2)} m over the ground`);
    assert.ok(Math.abs(camera.position.y - lowest) < 1e-6, "and rests there");
  });

  it("when it flies into a hill, then it stays above the hill's surface under it on every frame", () => {
    // A hill face: 0.5 m up per metre toward -z, so flying ahead at 3 m runs into rock within 6 m.
    const hill = new Ground();
    hill.addFace(-50, -50, 0, 100, 100, 25, 25, -25, -25, Infinity);
    setGround(hill);
    const { camera, free } = begun(new THREE.Vector3(0, 3, 0));
    let worst = Infinity;
    for (let frame = 0; frame < 2 * FRAME_HZ; frame++) {
      free.step(camera, { ...blankFreeInput(), forward: 1 }, DT);
      const p = camera.position;
      worst = Math.min(worst, p.y - hill.heightAt(p.x, p.z, p.y));
    }
    assert.ok(camera.position.z < -20, `the eye flew ${-camera.position.z} m up the hill (the test needs it deep in the slope)`);
    assert.ok(worst > 0.5, `the eye came within ${worst.toFixed(2)} m of the ground`);
  });

  it("when it flies past the fleet disc's rim where there is no floor, then it still stands above y 0, not below it", () => {
    setGround(DISC_GROUND);
    const { camera, free } = begun(new THREE.Vector3(DISC_RADIUS + 20, 10, 0));
    fly(free, camera, { rise: -1 }, 3);
    assert.ok(camera.position.y > 0.5, `the eye is ${camera.position.y} m up past the rim`);
    assert.ok(Number.isFinite(camera.position.y), "and finite");
  });
});

describe("given the free eye's bounds", () => {
  const reaches = [
    { it: "when it flies straight out over the fleet disc for ten seconds, then it stops 3 disc radii from the middle", derby: false, expectedReach: 3 * DISC_RADIUS },
    { it: "when it flies straight out over the derby bowl for ten seconds, then it stops 3 bowl radii from the middle", derby: true, expectedReach: 3 * DERBY_RADIUS },
  ];
  for (const testCase of reaches) {
    it(testCase.it, () => {
      const { camera, free } = begun();
      sceneExtent(free.extent, testCase.derby, null);
      fly(free, camera, { forward: 1, fast: true }, 10);
      assert.ok(Math.abs(Math.hypot(camera.position.x, camera.position.z) - testCase.expectedReach) < 1e-6, `${Math.hypot(camera.position.x, camera.position.z)} m out`);
    });
  }

  it("when it climbs for ten seconds, then it stops at the reach's height", () => {
    const { camera, free } = begun();
    fly(free, camera, { rise: 1, fast: true }, 10);
    assert.ok(Math.abs(camera.position.y - DISC_REACH) < 1e-6, `${camera.position.y} m up`);
  });

  it("when the eye is over the fleet disc, then its reach is three disc radii and its cruise crosses that in six seconds", () => {
    assert.equal(DISC_REACH, 3 * DISC_RADIUS, "reach");
    assert.equal(DISC_CRUISE, DISC_REACH / 6, "cruise");
  });

  const extents = [
    { it: "when no course is raced and a derby is on, then the footprint is the bowl around the origin", derby: true, course: null, expectedX: 0, expectedZ: 0, expectedRadius: DERBY_RADIUS },
    { it: "when no course is raced and no derby, then the footprint is the fleet disc around the origin", derby: false, course: null, expectedX: 0, expectedZ: 0, expectedRadius: DISC_RADIUS },
    { it: "when a course is raced, then the footprint is its bounds' middle and half their diagonal", derby: false, course: { minX: 100, maxX: 400, minZ: -300, maxZ: 100 }, expectedX: 250, expectedZ: -100, expectedRadius: 250 },
  ];
  for (const testCase of extents) {
    it(testCase.it, () => {
      const out = sceneExtent({ x: 9, z: 9, radius: 9 }, testCase.derby, testCase.course);
      assert.equal(out.x, testCase.expectedX, "x");
      assert.equal(out.z, testCase.expectedZ, "z");
      assert.equal(out.radius, testCase.expectedRadius, "radius");
    });
  }

  it("when the course is a long road, then the cruise is the fastest the clamp allows", () => {
    const { camera, free } = begun();
    sceneExtent(free.extent, false, { minX: 0, maxX: 4000, minZ: 0, maxZ: 300 });
    free.eye.set(2000, 30, 150);
    fly(free, camera, { forward: 1 }, 1);
    assert.ok(Math.abs(camera.position.z - 150 + 60) < 1e-6, `${150 - camera.position.z} m ahead in a second (60 m/s)`);
  });
});
