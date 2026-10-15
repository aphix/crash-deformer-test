import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { frame, makeWorld, type World } from "./race-world.test-util.ts";
import { TRACK_ID } from "./constants.ts";
import type { CarRecord } from "../match/types.ts";

/**
 * Owner, 2026-10-14: "If you go on the whitehouse lawn, a bunch of human models should come out of the building and shoot at the
 * car, rapidly destroying it (the bullets should deal damage, and be what actually destroys the car after 10-15 shots)". The whole
 * race stack headless (`race-world.test-util.ts`): the player's car parked on the North Lawn mid-race.
 */
const PLAYER = 0;
/** The North Lawn, between the White House and Pennsylvania Avenue's plaza. */
const NORTH_LAWN = { x: -1000, z: -1090 };

const w: World = makeWorld();
before(() => {
  w.race.enter();
});
after(() => {
  w.race.exit();
  setGround(null);
});

const rec = (id: number): CarRecord => w.race.snapshot()!.cars.find((c) => c.id === id)!;

/** One frame with the player's seat holding still (no gas, no wheel). */
function tick(state: { acc: number }): void {
  w.seat.mode = "drive";
  w.seat.carIndex = PLAYER;
  w.seat.intent.gas = 0;
  w.seat.intent.wheel = 0;
  frame(w, state);
}

describe("given a National Mall race, its player's car parked on the White House's North Lawn after the start", () => {
  it("when the guards are left to it, then the car's engine dies within seconds, the race counts it a wreck and resets it onto the course", () => {
    const r = w.race;
    r.command({ type: "options", options: { trackId: TRACK_ID.nationalMall, laps: 3, aiCount: 1, noReset: false } });
    r.reseed(3);
    r.command({ type: "start" });
    const state = { acc: 0 };
    for (let n = 0; n < 60 * 12 && r.phase !== "racing"; n++) tick(state);
    assert.equal(r.phase, "racing", "the race is on");
    const car = w.cars[PLAYER]!;
    car.spawnFacing(NORTH_LAWN.x, NORTH_LAWN.z, 0, 0);
    const t0 = r.time;
    let died = -1;
    let back = -1;
    for (let n = 0; n < 60 * 16 && back < 0; n++) {
      tick(state);
      if (died < 0 && !car.deform.drivetrainAlive) died = r.time - t0;
      if (died >= 0 && rec(PLAYER).status === "racing" && car.deform.drivetrainAlive) back = r.time - t0;
    }
    assert.ok(died > 2.5 && died < 7, `the engine died ${died.toFixed(2)} s after the car stopped on the lawn`);
    assert.ok(back > died, `reset ${(back - died).toFixed(2)} s after it died`);
    assert.ok(Math.hypot(car.group.position.x - NORTH_LAWN.x, car.group.position.z - NORTH_LAWN.z) > 150, "back on the course, off the grounds");
    assert.equal(rec(PLAYER).deaths, 1, "one wreck");
  });
});
