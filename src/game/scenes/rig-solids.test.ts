import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { launch, makeCar, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { propContact, type PropHits } from "../contact/prop-contact.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { armSolids } from "../world/surfaces.ts";
import type { LampPole, RampBall } from "./engine-props.ts";
import { BALL_BREAK_CLOSING, foldPole, POLE_FOLD_CLOSING, RIG_BALL_FIRST, RIG_BALLS, RIG_POLE_FIRST, RIG_POLES, RigSolids, shatterBall } from "./rig-solids.ts";

/**
 * The fleet's lamp posts and ramp balls as prisms of the rigs' store, hit by a car launched at them: the post's fold speed and the ball's
 * hub pop are what main's `resolveLampPoles` / `resolveRampBalls` did (measured on main with a car launched at one post or ball: a post folded
 * from a closing speed of 3.5 m/s, 3.93 m/s folded and 3.35 m/s did not; a ball shattered from 7.5 m/s, 7.86 m/s popped the nearest hub
 * and 6.88 m/s did not).
 */

/** The post or ball's distance (m) ahead of the car's origin. */
const TARGET_Z = 14;
/** A car reaches the target's face within this long (s) at the speeds below. */
const RUN_S = 8;

type Scene = { poles: LampPole[]; balls: RampBall[]; popped: string[]; folded: number[]; shattered: number[] };

/** A car at the origin launched along +z at `speed` m/s at a post (`target` "pole") or a ball ("ball") `offset` m to the side, over `RUN_S` s through `propContact`. */
function hit(target: "pole" | "ball", speed: number, offset = 0): { scene: Scene; car: DeformableCar } {
  const car = makeCar("shape");
  const world = makeWorld([car], false, false);
  const rigs = new RigSolids();
  const knocked = new Uint8Array(RIG_BALL_FIRST + RIG_BALLS);
  const poles: LampPole[] = Array.from({ length: RIG_POLES }, () => ({ group: new THREE.Group(), intact: true, radius: 0.12, kicked: new Set<string>() }));
  const balls: RampBall[] = Array.from({ length: RIG_BALLS }, () => ({ mesh: new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6)), radius: 0.78, intact: true, kicked: new Set<string>() }));
  const scene: Scene = { poles, balls, popped: [], folded: [], shattered: [] };
  const at = target === "pole" ? poles[0]! : { group: balls[0]!.mesh };
  at.group.position.set(offset, target === "pole" ? 0 : -0.65 * 0.78, TARGET_Z);
  balls[0]!.mesh.scale.setScalar(0.78);
  // The other posts and balls are away: out of the car's way, out of play.
  for (let k = 1; k < RIG_POLES; k++) poles[k]!.group.visible = false;
  for (let k = 1; k < RIG_BALLS; k++) balls[k]!.mesh.visible = false;
  if (target === "pole") balls[0]!.mesh.visible = false;
  else poles[0]!.group.visible = false;
  const hits: PropHits = {
    knock: (index, _car, vx, _vy, vz) => {
      scene.folded.push(index);
      foldPole(poles[index - RIG_POLE_FIRST]!, vx, vz);
    },
    fx: () => {},
    wall: (index, carIndex, closing) => {
      if (index < RIG_BALL_FIRST) return;
      if (shatterBall(balls[index - RIG_BALL_FIRST]!, world.cars[carIndex]!, closing)) scene.shattered.push(index);
    },
  };
  armSolids(rigs);
  world.world.beforeSlice = () => {
    rigs.syncPoles(poles, knocked);
    rigs.syncBalls(balls, true);
    return false;
  };
  world.world.collide = (c, i, h) => propContact(c, i, rigs, knocked, hits, h);
  launch(car, 0, 0, 0, 0, speed);
  for (let i = 0; i < RUN_S * 60; i++) tickWorld(world);
  for (const m of car.deform.masses) if (m.hub && m.popped) scene.popped.push(m.name);
  return { scene, car };
}

describe("given a lamp post standing in the way of a car (a prism of the rigs' store)", () => {
  afterEach(() => armSolids(null));

  it("when the car closes on it at 0.5 m/s under its fold speed, then the post stands and the car does not pass it", () => {
    const { scene, car } = hit("pole", POLE_FOLD_CLOSING - 0.5);
    assert.deepEqual(scene.folded, [], "the post folded under its fold speed");
    assert.ok(scene.poles[0]!.intact);
    assert.ok(car.group.position.z < TARGET_Z, `the car's origin passed the post (z ${car.group.position.z.toFixed(2)} m)`);
  });

  it("when the car closes on it at 0.5 m/s over its fold speed, then the post folds over", () => {
    const { scene } = hit("pole", POLE_FOLD_CLOSING + 0.5);
    assert.equal(scene.folded.length, 1);
    assert.equal(scene.folded[0], RIG_POLE_FIRST);
    assert.ok(!scene.poles[0]!.intact);
  });

  it("when the car closes on it 0.6 m off its middle, then the same speeds stand and fold it", () => {
    assert.deepEqual(hit("pole", POLE_FOLD_CLOSING - 0.5, 0.6).scene.folded, []);
    const folded = hit("pole", POLE_FOLD_CLOSING + 0.5, 0.6).scene.folded;
    assert.equal(folded.length, 1);
    assert.equal(folded[0], RIG_POLE_FIRST);
  });
});

describe("given a half-buried ramp ball in the way of a car (a prism of the rigs' store)", () => {
  afterEach(() => armSolids(null));

  it("when the car closes on it 1 m/s under the break speed, then the ball stays whole and no hub pops", () => {
    const { scene } = hit("ball", BALL_BREAK_CLOSING - 1);
    assert.deepEqual(scene.shattered, []);
    assert.deepEqual(scene.popped, []);
  });

  it("when the car closes on it 0.5 m/s over the break speed, then the ball shatters and the hub nearest the hit pops (the middle: front left, as main's)", () => {
    const { scene } = hit("ball", BALL_BREAK_CLOSING + 0.5);
    assert.equal(scene.shattered.length, 1);
    assert.equal(scene.shattered[0], RIG_BALL_FIRST);
    assert.deepEqual(scene.popped, ["hubFL"]);
  });

  it("when the car closes on it over the break speed 0.7 m to the right of its middle, then the front right hub pops", () => {
    const { scene } = hit("ball", BALL_BREAK_CLOSING + 0.5, 0.7);
    assert.deepEqual(scene.popped, ["hubFR"]);
  });
});
