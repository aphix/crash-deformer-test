import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { launch, makeCar } from "../contact/crash-scenarios.test-util.ts";
import { LawnGuard } from "../scenes/lawn-guard.ts";
import { parseTrack } from "../world/track-schema.ts";
import { Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { TRACK_ID } from "../world/constants.ts";
import type { DriverLook } from "./driver-look.ts";
import { GroundsArt } from "./grounds-art.ts";
import { GuardSquad, People, VipEscort } from "./people.ts";
import { DummyMesh } from "./ragdoll-mesh.ts";

/** Once the Konami code is in, a man in a suit walks out of the White House to the car, rides with the player and is thrown out with the driver when it crashes. */
const json = TRACKS.find((j) => parseTrack(j).id === TRACK_ID.nationalMall)!;
const track = new Track(json);
const spec = track.json.guards!;
const ground = track.ground();
const FRAME = 1 / 60;
/** The North Lawn, 40 m in front of the North Portico. */
const NORTH_LAWN = { x: -990, z: -1104 };

/** The VIP's escort over a car parked on the lawn: `seconds` of frames, the secret out or not; the throws it asked for. */
function escort(secretOut: boolean, seconds: number) {
  const vip = new VipEscort(spec, ground, new People(1), 0);
  const car = makeCar();
  launch(car, NORTH_LAWN.x, NORTH_LAWN.z, 0, 0, 0);
  const cars = [car];
  const throws: { car: number; look: DriverLook }[] = [];
  const throwPassenger = (i: number, look: DriverLook): void => void throws.push({ car: i, look });
  let boardedAt = -1;
  for (let t = 0; t < seconds; t += FRAME) {
    vip.frame(FRAME, secretOut, 0, cars, throwPassenger);
    if (boardedAt < 0 && vip.ridingIn === 0) boardedAt = t;
  }
  return { vip, car, cars, throws, throwPassenger, boardedAt };
}

describe("given the National Mall's VIP and the player's car parked on the White House's North Lawn", () => {
  it("when the course's secret is out, then he walks out of the house to the passenger door and gets in, and when the driver is thrown out he is thrown with him, once: a portly blond man in a blue suit", () => {
    const { vip, car, cars, throws, throwPassenger, boardedAt } = escort(true, 40);
    assert.ok(boardedAt > 5 && boardedAt < 35, `boarded ${boardedAt.toFixed(1)} s after the car stopped (a walk of some 40 m)`);
    assert.equal(throws.length, 0, "nobody thrown while the car is whole");
    car.driverOut = "windshield";
    vip.frame(FRAME, true, 0, cars, throwPassenger);
    vip.frame(FRAME, true, 0, cars, throwPassenger);
    assert.equal(throws.length, 1, "thrown once with the driver");
    assert.equal(throws[0]!.car, 0, "out of the player's car");
    assert.equal(throws[0]!.look.woman, false, "a man");
    assert.ok(((throws[0]!.look.hair >> 16) & 0xff) > 0xc0 && ((throws[0]!.look.hair >> 8) & 0xff) > 0xa0, "blond");
    const suit = throws[0]!.look.shirt;
    assert.ok(suit === throws[0]!.look.pants && (suit & 0xff) > ((suit >> 8) & 0xff) && (suit & 0xff) > (suit >> 16) && (suit & 0xff) < 0x90, "a navy-blue suit, jacket and trousers alike");
    assert.equal(throws[0]!.look.portly, true, "portly");
    assert.equal(vip.ridingIn, -1, "no longer riding");
  });

  it("when the secret is still in, then he never comes out, though the same car would draw him once it is", () => {
    assert.equal(escort(false, 40).boardedAt, -1, "never boards");
    assert.ok(escort(true, 40).boardedAt > 0, "with the secret out he boards");
  });
});

/** A guard squad over the National Mall's lawn, its people's meshes, and the car it fires on. */
function lawn() {
  const people = new People(spec.count + 1);
  const squad = new GuardSquad(spec, ground, people);
  const guard = new LawnGuard(spec, 1);
  guard.reset(1);
  const car = makeCar();
  launch(car, NORTH_LAWN.x, NORTH_LAWN.z, 0, 0, 0);
  const frames = (seconds: number, alarm: number): void => {
    for (let t = 0; t < seconds; t += FRAME) {
      guard.alarm = alarm < 0 ? -1 : alarm + t;
      guard.target = alarm < 0 ? -1 : 0;
      squad.frame(FRAME, guard, [car], () => {});
      people.update(FRAME);
    }
  };
  return { people, squad, guard, frames };
}

describe("given the National Mall's guard squad, inside the house until the alarm goes up", () => {
  it("when nobody is out, then nothing of theirs is drawn; when the alarm sends them out, they are drawn; when it stands down and they are back inside, they are not", () => {
    const { people, frames } = lawn();
    frames(1, -1);
    assert.equal(people.group.visible, false, "a quiet lawn draws nothing");
    frames(4, 0);
    assert.equal(people.group.visible, true, "the squad out on the lawn is drawn");
    frames(20, -1);
    assert.equal(people.group.visible, false, "the squad back inside draws nothing");
  });

  it("when a gun fires with nobody else out, then its flash goes out first, its tracer a moment later, and then nothing is drawn", () => {
    const { people } = lawn();
    people.fire(0, 0, 1, 0);
    people.update(FRAME);
    assert.equal(people.group.visible, true, "the shot shows");
    assert.ok(people["flashes"].visible && people["tracers"].visible, "flash and tracer both show");
    people.update(0.04);
    assert.ok(!people["flashes"].visible && people["tracers"].visible, "the flash is out, the tracer still runs");
    people.update(0.2);
    assert.equal(people.group.visible, false, "the shot is out");
    assert.ok(!people["tracers"].visible, "the tracer is out");
  });
});

describe("given the VIP riding with the squad inside", () => {
  it("when he is in the passenger seat, then one figure is drawn, not the squad's empty places too", () => {
    const art = new GroundsArt(spec, ground, new THREE.Group());
    const car = makeCar();
    launch(car, NORTH_LAWN.x, NORTH_LAWN.z, 0, 0, 0);
    const host = { sparks: () => {}, throwPassenger: () => {} };
    for (let t = 0; t < 40; t += FRAME) art.frame(FRAME, null, true, [car], 0, host);
    const drawn = art["people"].group.children.find((c): c is DummyMesh => c instanceof DummyMesh)!;
    const slots = spec.count + 1;
    assert.equal(drawn.count, drawn.instanceMatrix.count / slots, "the draw ends after slot 0");
  });
});
