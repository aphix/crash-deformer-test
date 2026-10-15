import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { RagdollSystem } from "../present/engine-ragdoll.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { newWorld, settleStep, stepWorld } from "../engine/world-step.ts";
import { applyDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { makeCar } from "../vehicle/ground-probe.test-util.ts";
import { assertSameNumbers } from "../vehicle/test-support.ts";
import { setGround } from "./ground.ts";
import { FRAME, makeWorld } from "./race-world.test-util.ts";
import { blankPoint, Track } from "./track.ts";
import { parseTrack } from "./track-schema.ts";
import { TRACKS } from "./tracks/index.ts";

/**
 * City's two cones at 395.5 and 400.5 m along the road (x 140 and 145, 6 and 5 m left of the centre line, a car's width off its edge): a car
 * driven down the road's left side at `SPEED` from 15 m before the first knocks both, the first and the second a quarter second apart.
 */
const COURSE = "city";
const START_S = 380;
/** Lateral offset (m left of the centre line) the car drives at: between the two cones' 6 and 5. */
const LANE = 5.5;
const SPEED = 20;
/** Seconds driven: the approach (0.75 s), both knocks, and the cones' tumble after them. */
const SECONDS = 3;

type Run = { knocks: number[]; knocked: number; state: number[]; flying: number };

/** The car down the road through the cones, with the dummies' world taking its knocks (props tumbling in Rapier) or with no such world. */
async function drive(withProps: boolean): Promise<Run> {
  const track = new Track(parseTrack(TRACKS.find((j) => parseTrack(j).id === COURSE)!));
  const w = makeWorld();
  const sys = withProps ? new RagdollSystem(new THREE.Scene(), () => {}, () => {}) : null;
  await sys?.preload();
  const knocks: number[] = [];
  let frames = 0;
  w.onKnock = (index, car, vx, vy, vz) => {
    knocks.push(frames, index, car);
    sys?.knockProp(index, car, vx, vy, vz);
  };
  w.race.showLobby(COURSE);
  const pt = blankPoint();
  track.pointAt(START_S, pt);
  const car = makeCar("sedan");
  car.spawnFacing(pt.x + pt.tz * LANE, pt.z - pt.tx * LANE, Math.atan2(pt.tx, pt.tz), SPEED);
  car.velocity.set(pt.tx * SPEED, 0, pt.tz * SPEED);
  const world = newWorld([car]);
  world.collide = (c, i, h) => w.race.courseHit(c, i, h);
  sys?.setCourse(w.race["track"]!, w.race["placed"], null);
  const input: DriveInput = { throttle: 1, steer: 0, brake: 0, ebrake: false, boost: false };
  let acc = 0;
  for (let f = 0; f < SECONDS / FRAME; f++) {
    frames = f + 1;
    acc = Math.min(0.05, acc + FRAME);
    while (acc > 1e-5) {
      const h = Math.fround(physicsSlice(acc, sliceSpeed(world.cars)));
      applyDrive(car, input, h);
      stepWorld(world, h);
      settleStep(world.cars, h, false);
      acc -= h;
    }
    car.updateSkin();
    sys?.update(FRAME, [car], true, false, null);
  }
  const state = [...car.group.position.toArray(), ...car.group.quaternion.toArray(), ...car.velocity.toArray()];
  const knocked = w.race["knocked"].reduce((n, k) => n + k, 0);
  const flying = sys ? sys["props"].count : 0;
  sys?.dispose();
  w.race.exit();
  setGround(null);
  return { knocks, knocked, state, flying };
}

describe("given a car driven down city's road through two cones", () => {
  it("when the knocked props tumble in the dummies' physics, then the car knocks the same props at the same steps and ends exactly where it does with no such physics", async () => {
    const bare = await drive(false);
    const tumbling = await drive(true);
    assert.equal(bare.knocked, 2, `the car knocked ${bare.knocked} props, not the two cones`);
    assert.equal(tumbling.flying, tumbling.knocked, "every knocked prop is out in the dummies' physics");
    assertSameNumbers(tumbling.knocks, bare.knocks, "the knocks: frame, prop and car");
    assert.equal(tumbling.knocked, bare.knocked, "the knocked count");
    assertSameNumbers(tumbling.state, bare.state, "the car's pose and velocity");
  });
});
