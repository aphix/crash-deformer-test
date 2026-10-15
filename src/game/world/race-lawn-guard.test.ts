import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { GUARD_AT_POST, GUARD_DEPLOY_S, GUARD_DOWN, GUARD_IN } from "../scenes/lawn-guard.ts";
import { KILL_WINDOW_S } from "../scenes/lawn-guard.test-util.ts";
import { frame, makeWorld, type World } from "./race-world.test-util.ts";
import { TRACK_ID } from "./constants.ts";
import type { CarRecord } from "../match/types.ts";

/**
 * The White House lawn's guards come out of the building and shoot a car on the lawn until its engine dies (`scenes/lawn-guard.ts`: the share of
 * shots that hit, the hits that kill). The whole race stack headless (`race-world.test-util.ts`): the player's car parked on the North Lawn mid-race.
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
    assert.ok(died > GUARD_DEPLOY_S && died < GUARD_DEPLOY_S + KILL_WINDOW_S, `the engine died ${died.toFixed(2)} s after the car stopped on the lawn`);
    assert.ok(back > died, `reset ${(back - died).toFixed(2)} s after it died`);
    assert.ok(Math.hypot(car.group.position.x - NORTH_LAWN.x, car.group.position.z - NORTH_LAWN.z) > 150, "back on the course, off the grounds");
    assert.equal(rec(PLAYER).deaths, 1, "one wreck");
  });
});

/** What the owner typed the Konami code into: nothing here draws the flash, so nothing is touched. */
const overlay = { appendChild: <T extends Node>(node: T): T => node };

describe("given a National Mall race in which the Konami code was typed and the player's car sits on the White House's North Lawn", () => {
  it("when the race is restarted, then the guards are back on duty (the car's engine dies on the lawn again) and the secret can be brought out again", () => {
    const r = w.race;
    r.command({ type: "options", options: { trackId: TRACK_ID.nationalMall, laps: 3, aiCount: 1, noReset: false } });
    r.reseed(3);
    r.command({ type: "start" });
    const state = { acc: 0 };
    const toLawn = (): void => {
      for (let n = 0; n < 60 * 12 && r.phase !== "racing"; n++) tick(state);
      w.cars[PLAYER]!.spawnFacing(NORTH_LAWN.x, NORTH_LAWN.z, 0, 0);
    };
    toLawn();
    assert.equal(r.revealSecret(overlay), true, "the code brings the secret out");
    assert.equal(r.revealSecret(overlay), false, "once");
    for (let n = 0; n < 60 * 12; n++) tick(state);
    assert.ok(w.cars[PLAYER]!.deform.drivetrainAlive, "the guards stand down: the car sits on the lawn untouched");

    r.command({ type: "retry" });
    toLawn();
    for (let n = 0; n < 60 * 12 && w.cars[PLAYER]!.deform.drivetrainAlive; n++) tick(state);
    assert.ok(!w.cars[PLAYER]!.deform.drivetrainAlive, "the guards fire on the restarted race's lawn");
    assert.equal(r.revealSecret(overlay), true, "the code works again");
  });
});

describe("given a National Mall race with the squad out at its posts round the player's car parked on the North Lawn", () => {
  it("when the car is driven at 15 m/s through guard 0's post, then the race throws him as a dummy once and the squad has him down, and when the race restarts he is back inside", () => {
    const r = w.race;
    r.command({ type: "options", options: { trackId: TRACK_ID.nationalMall, laps: 3, aiCount: 1, noReset: false } });
    r.reseed(3);
    r.command({ type: "start" });
    const state = { acc: 0 };
    for (let n = 0; n < 60 * 12 && r.phase !== "racing"; n++) tick(state);
    const car = w.cars[PLAYER]!;
    car.spawnFacing(NORTH_LAWN.x, NORTH_LAWN.z, 0, 0);
    for (let n = 0; n < 60 * 3; n++) tick(state);
    const guard = r["guard"]!;
    assert.equal(guard.mode[0], GUARD_AT_POST, "guard 0 at his post");
    assert.equal(w.figures.length, 0, "nobody thrown while the car sat");
    car.spawnFacing(guard.guardX[0]!, guard.guardZ[0]! - 8, 0, 15);
    for (let n = 0; n < 60; n++) tick(state);
    assert.equal(guard.mode[0], GUARD_DOWN, "the squad has him down");
    const mine = w.figures.filter((f) => f.guard === 0);
    assert.equal(mine.length, 1, "thrown once");
    assert.equal(mine[0]!.car, PLAYER, "by the player's car");
    r.command({ type: "start" });
    for (let i = 0; i < guard.mode.length; i++) assert.equal(guard.mode[i], GUARD_IN, `guard ${i} back inside`);
  });
});
