import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DerbyBrain, type AiCar } from "../ai/derby-ai.ts";
import { DerbyMatch } from "./derby.ts";
import { aiRecoverDelay, applyDrive, BOOST, DriverSeat, mayRecoverFlipped, selfRightDelay } from "../vehicle/car-drive.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { HANDLING, SELF_RIGHT_SLOWEST } from "../vehicle/vehicle-classes.ts";
import { aiCar, DT } from "../vehicle/test-support.ts";

/** A car at rest at the origin, upside down (roll π) when `over`, its engine alive unless `dead`. */
function parked(over: boolean, dead = false): DeformableCar {
  const car = new DeformableCar({ body: 0xc5c8ce, accent: 0x9aa0a8, name: "Titanium" }, new THREE.Scene());
  car.spawnFacing(0, 0, 0, 0);
  if (over) car.group.rotation.set(0, 0, Math.PI, "YXZ");
  car.deform.drivetrainAlive = !dead;
  car.refreshBasis();
  return car;
}

/** Slices until `due` first says yes (null: not within `seconds`). */
function firstYes(due: () => boolean, seconds: number): number | null {
  for (let n = 1; n * DT <= seconds; n++) if (due()) return n;
  return null;
}

/** `fn` with the handling slider at `realism`, restored after. */
function atRealism<T>(realism: number, fn: () => T): T {
  const was = HANDLING.realism;
  HANDLING.realism = realism;
  try {
    return fn();
  } finally {
    HANDLING.realism = was;
  }
}

describe("derby AI presses R by the player's rules", () => {
  it("good: a flipped car that still runs is righted on the very slice the player's self-right fires", () => {
    const car = parked(true);
    assert.equal(mayRecoverFlipped(car), true);
    const wait = selfRightDelay();
    assert.ok(Number.isFinite(wait) && wait > 1, `default realism self-right delay ${wait}`);
    assert.equal(aiRecoverDelay(), wait, "below the realistic end the AI waits the player's delay");
    const up = car.group.matrixWorld.elements[5]!;
    const match = new DerbyMatch();
    const seat = new DriverSeat();
    seat.mode = "drive";
    const ai = firstYes(() => match.recoverDue(0, car, DT), wait + 1);
    const player = firstYes(() => seat.selfRight(up, 0, DT), wait + 1);
    assert.ok(ai !== null && ai * DT >= wait - 1e-9 && ai * DT < wait + DT + 1e-9, `AI pressed R at ${ai} slices, delay ${wait} s`);
    assert.equal(ai, player, "the AI's R and the player's self-right fire on the same slice");
  });

  it("bad: a dead drivetrain is never righted, nor an upright car, nor one still sliding (the player's mayRecover)", () => {
    const wait = selfRightDelay();
    const dead = parked(true, true);
    assert.equal(mayRecoverFlipped(dead), false);
    const match = new DerbyMatch();
    assert.equal(firstYes(() => match.recoverDue(0, dead, DT), wait * 3), null, "dead engine righted itself");
    const upright = parked(false);
    assert.equal(firstYes(() => match.recoverDue(1, upright, DT), wait * 3), null, "upright car pressed R");
    const sliding = parked(true);
    sliding.velocity.set(0, 0, 6);
    assert.equal(firstYes(() => match.recoverDue(2, sliding, DT), wait * 3), null, "a car still sliding pressed R");
  });

  it("good: each car runs its own clock", () => {
    const wait = selfRightDelay();
    const match = new DerbyMatch();
    const a = parked(true);
    const b = parked(true);
    // Car 0 has lain 0.3 s short of the delay when car 1 first flips.
    const lead = Math.round((wait - 0.3) / DT);
    for (let n = 0; n < lead; n++) assert.equal(match.recoverDue(0, a, DT), false);
    let firedA = -1;
    let firedB = -1;
    for (let n = 1; n <= Math.ceil((wait + 1) / DT) && firedB < 0; n++) {
      if (match.recoverDue(0, a, DT) && firedA < 0) firedA = n;
      if (match.recoverDue(1, b, DT)) firedB = n;
    }
    assert.ok(firedA > 0 && firedA <= Math.ceil(0.3 / DT) + 2, `car 0 pressed R ${firedA} slices after car 1 flipped`);
    assert.ok(firedB >= lead + firedA - 3, `car 1 pressed R after ${firedB} slices, on car 0's clock`);
  });

  it("good: rolling back onto its wheels restarts the clock", () => {
    const wait = selfRightDelay();
    const match = new DerbyMatch();
    const car = parked(true);
    for (let n = 0; n < Math.round((wait - 0.3) / DT); n++) match.recoverDue(0, car, DT);
    car.group.rotation.set(0, 0, 0, "YXZ");
    car.refreshBasis();
    assert.equal(match.recoverDue(0, car, DT), false);
    car.group.rotation.set(0, 0, Math.PI, "YXZ");
    car.refreshBasis();
    const again = firstYes(() => match.recoverDue(0, car, DT), wait + 1);
    assert.ok(again !== null && again * DT >= wait - DT, `pressed R ${again} slices after flipping again`);
  });

  it("good: at the realistic end the player must press R, the AI still does after the slider's slowest delay", () => {
    atRealism(1, () => {
      assert.equal(selfRightDelay(), Infinity);
      assert.equal(aiRecoverDelay(), SELF_RIGHT_SLOWEST);
      const car = parked(true);
      const up = car.group.matrixWorld.elements[5]!;
      const seat = new DriverSeat();
      seat.mode = "drive";
      assert.equal(firstYes(() => seat.selfRight(up, 0, DT), 10), null, "the realistic end left R to the player");
      const match = new DerbyMatch();
      const slices = firstYes(() => match.recoverDue(0, car, DT), SELF_RIGHT_SLOWEST + 1);
      assert.ok(slices !== null && Math.abs(slices * DT - SELF_RIGHT_SLOWEST) <= DT, `AI pressed R at ${slices} slices`);
    });
  });
});

describe("derby AI boost by the player's rules", () => {
  /** A brain whose driver 0 hunts car 1, `z` m dead ahead (`foe` overrides it), nose first (tail spent, full aggression), past the opening hold and the 8 s opening caution. */
  function charging(z: number, me: Partial<AiCar> = {}, foe: Partial<AiCar> = {}): { brain: DerbyBrain; self: AiCar; all: AiCar[] } {
    const brain = new DerbyBrain();
    brain.setAggression(0, 1);
    const self = aiCar(0, { vz: 8, rear: 0.9, damage: 0.3, idle: 1000, ...me });
    const all = [self, aiCar(1, { z, vz: 0, ...foe })];
    brain.think(self, all, 9); // past the 8 s opening caution (`derby-opening.ts`), which would lift off a boosted charge
    brain.meter[0] = 1;
    return { brain, self, all };
  }

  it("good: a charge at a target ahead within 25 m boosts and drains the meter at the seat's rate", () => {
    const { brain, self, all } = charging(18);
    assert.equal(brain.tacticOf(0), "nose");
    const out = brain.think(self, all, 0.4);
    assert.equal(out.boost, true);
    assert.ok(Math.abs(brain.meter[0]! - (1 - 0.4 / BOOST.full)) < 1e-12, `meter ${brain.meter[0]}`);
    const seat = new DriverSeat();
    seat.mode = "drive";
    seat.sample(new Set(["ShiftLeft", "KeyW"]), null);
    seat.step(0.4);
    assert.equal(brain.meter[0], seat.boost, "the AI's meter drains like the seat's");
  });

  it("good: no boost with the target behind, past 25 m, inside the last 8 m, facing us, off to the side, or the meter empty", () => {
    const cases: readonly (readonly [string, number, boolean])[] = [
      ["inside 25 m", 24, true],
      ["outside 25 m", 26, false],
      ["outside the last 8 m", 9, true],
      ["inside the last 8 m", 7, false],
      ["behind", -18, false],
    ];
    for (const [label, z, boosts] of cases) {
      const { brain, self, all } = charging(z);
      assert.equal(brain.think(self, all, DT).boost, boosts, label);
      assert.equal(brain.tacticOf(0), "nose", `${label}: not a charge`);
    }
    const faced = charging(18, {}, { yaw: Math.PI });
    assert.equal(faced.brain.think(faced.self, faced.all, DT).boost, false, "boosted into a nose (head-on)");
    assert.equal(faced.brain.tacticOf(0), "nose", "head-on case: not a charge");
    const side = charging(18);
    side.all[1]!.x = 18;
    side.all[1]!.z = 2;
    assert.equal(side.brain.think(side.self, side.all, DT).boost, false, "target off the nose");
    const empty = charging(18);
    empty.brain.meter[0] = 0;
    assert.equal(empty.brain.think(empty.self, empty.all, DT).boost, false, "empty meter boosted");
    const tail = charging(18, { rear: 0, front: 0.9, damage: 0.6 });
    assert.equal(tail.brain.think(tail.self, tail.all, DT).boost, false, `tail first (${tail.brain.tacticOf(0)}) boosted`);
  });

  it("good: the meter refills at the seat's rate when not boosting, never past full", () => {
    const { brain, self, all } = charging(-18);
    brain.meter[0] = 0.2;
    brain.think(self, all, 0.9);
    assert.ok(Math.abs(brain.meter[0]! - (0.2 + 0.9 / BOOST.recharge)) < 1e-12, `meter ${brain.meter[0]}`);
    brain.think(self, all, 60);
    assert.equal(brain.meter[0], 1);
  });

  it("good: a takedown tops the AI's meter up by the seat's BOOST.takedown, capped at full", () => {
    const match = new DerbyMatch();
    match.begin([{ id: 0, name: "a" }, { id: 1, name: "b" }], { start: 0, seed: 1 });
    assert.equal(match.brain.meter[0], 1, "a match starts with a full meter");
    match.brain.meter[0] = 0.3;
    assert.equal(match.noteHit(0, 1, 6, 0, 6), true);
    for (const id of match.consumeBoosts()) match.brain.addBoost(id, BOOST.takedown);
    assert.ok(Math.abs(match.brain.meter[0]! - 0.7) < 1e-12, `meter ${match.brain.meter[0]}`);
    assert.equal(match.brain.meter[1], 1, "the victim earns nothing");
    match.brain.addBoost(0, BOOST.takedown);
    match.brain.addBoost(0, BOOST.takedown);
    assert.equal(match.brain.meter[0], 1);
    const seat = new DriverSeat();
    seat.boost = 0.3;
    seat.addBoost(BOOST.takedown);
    assert.ok(Math.abs(seat.boost - 0.7) < 1e-12, "the seat takes the same bonus");
  });

  it("good: the boost reaches applyDrive through DerbyMatch.think, still under the arena pace", () => {
    const match = new DerbyMatch();
    match.begin([{ id: 0, name: "a" }, { id: 1, name: "b" }], { start: 0, seed: 1 });
    match.brain.setAggression(0, 1);
    const snaps = match.snapshots(2);
    Object.assign(snaps[0]!, aiCar(0, { vz: 8, rear: 0.9, damage: 0.3 }));
    Object.assign(snaps[1]!, aiCar(1, { z: 18, vz: 0 }));
    match.think(snaps[0]!, snaps, 9); // past the 8 s opening caution
    match.brain.meter[0] = 1;
    const input = match.think(snaps[0]!, snaps, DT);
    assert.equal(input.boost, true);
    assert.ok(input.throttle > 0 && input.throttle < 0.5, `throttle ${input.throttle} is a share of the arena pace`);
    const car = parked(false);
    applyDrive(car, input, DT);
    assert.equal(car.drive.boost, true, "applyDrive did not boost");
  });
});
