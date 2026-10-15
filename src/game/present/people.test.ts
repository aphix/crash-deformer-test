import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCar } from "../contact/crash-scenarios.test-util.ts";
import { parseTrack } from "../world/track-schema.ts";
import { Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { TRACK_ID } from "../world/constants.ts";
import type { DriverLook } from "./driver-look.ts";
import { People, VipEscort } from "./people.ts";

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
