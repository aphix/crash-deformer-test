import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { applyDrive, idleDrive, type DriveInput } from "./car-drive.ts";
import { assignClass, CLASSES, type VehicleClassId } from "./vehicle-classes.ts";
import { LOSS_SIZE, WHEEL_RL, WHEEL_RR, wheelLoss } from "./wheel-loss.ts";
import { blankAiCar, DerbyBrain } from "../ai/derby-ai.ts";
import { RaceBrain } from "../ai/race-ai.ts";
import { Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { aiCar, decide, mass, paint } from "./test-support.ts";

/**
 * A car missing wheels drives like it: no front wheel, no steering; no wheel on a corner, a body scraping the road there;
 * thrust and brakes only from the wheels still on. One rule for the player and the AI (both go through `applyDrive`).
 */

const H = 1 / 120;
const HUBS = ["hubFL", "hubFR", "hubRL", "hubRR"] as const;
const CLASS_IDS = Object.keys(CLASSES) as VehicleClassId[];

/** A sedan (or `cls`) at `v` m/s along +z with the wheels `lost` (indices into FL FR RL RR) popped off their hubs. */
function car(lost: readonly number[], cls: VehicleClassId = "sedan", v = 0): DeformableCar {
  const c = new DeformableCar(paint(), new THREE.Scene(), null, CLASSES[cls].style);
  assignClass(c, cls);
  c.spawnFacing(0, 0, 0, v);
  for (const i of lost) c.deform.popHub(mass(c.deform, HUBS[i]!));
  return c;
}

function run(c: DeformableCar, secs: number, input: Partial<DriveInput> | ((t: number) => DriveInput)): void {
  for (let k = 0; k < Math.round(secs / H); k++) {
    applyDrive(c, typeof input === "function" ? input(k * H) : { ...idleDrive(), ...input }, H);
    c.integrate(H);
  }
}

/** Heading change (rad) over `secs` of `input` from 12 m/s. */
function swing(lost: readonly number[], cls: VehicleClassId, input: Partial<DriveInput>, secs = 1): number {
  const c = car(lost, cls, 12);
  const yaw0 = c.yaw;
  run(c, secs, { throttle: 0.3, ...input });
  return c.yaw - yaw0;
}

describe("given a car missing wheels (their hubs popped off)", () => {
  for (const cls of CLASS_IDS) {
    it(`when a ${cls} has both front wheels gone and is steered full lock either way, then it turns about 0 (under 0.02 rad in 1 s) where the intact car turns over 1 rad, and with a rear wheel gone as well it still does not steer`, () => {
      const intact = swing([], cls, { steer: 1 });
      assert.ok(intact > 1, `intact ${intact.toFixed(2)} rad`);
      for (const steer of [1, -1]) {
        const none = swing([0, 1], cls, { steer });
        assert.ok(Math.abs(none) < 0.02, `front pair gone, steer ${steer}: turned ${none.toFixed(3)} rad in 1 s`);
      }
      assert.ok(Math.abs(swing([0, 1, 2], cls, { steer: 1 })) < 0.02, "front pair and a rear wheel gone still steered");
    });

    it(`when a ${cls} loses one front wheel, then it steers on a reduced lock (15 to 75 % of the intact turn), and with both rear wheels gone it steers as ever (over 80 %)`, () => {
      const intact = swing([], cls, { steer: 1 });
      const one = swing([0], cls, { steer: 1 });
      assert.ok(one > 0.15 * intact && one < 0.75 * intact, `one front: ${one.toFixed(2)} rad vs intact ${intact.toFixed(2)}`);
      const rear = swing([2, 3], cls, { steer: 1 });
      assert.ok(rear > 0.8 * intact, `rear pair gone: ${rear.toFixed(2)} rad vs intact ${intact.toFixed(2)}`);
    });
  }

  it("when the derby AI steers hard toward a rival ahead and to one side, then a car with both front wheels gone does not turn on that steering (under 0.01 rad in 0.5 s) while the intact car does (over 0.3 rad)", () => {
    // A rival ahead and to one side: the brain steers hard toward it.
    const me = aiCar(0, { vz: 12 });
    const foe = aiCar(1, { x: 9, z: 16, yaw: Math.PI, vz: -8 });
    const input = decide(new DerbyBrain(), me, [me, foe]);
    assert.ok(Math.abs(input.steer) > 0.3, `the brain does not steer here: ${JSON.stringify(input)}`);
    const turned = (lost: number[]) => {
      const c = car(lost, "sedan", 12);
      const yaw0 = c.yaw;
      run(c, 0.5, () => ({ ...input, throttle: 0.3, ebrake: false, boost: false }));
      return Math.abs(c.yaw - yaw0);
    };
    assert.ok(turned([]) > 0.3, "the intact car did not turn on the AI's steering");
    assert.ok(turned([0, 1]) < 0.01, `front pair gone: turned ${turned([0, 1]).toFixed(3)} rad`);
  });

  it("when the race AI, 4 m off the line with its nose 0.5 rad off the road and a rival close alongside, steers hard back to the line, then a car with both front wheels gone does not turn on that steering (under 0.01 rad in 0.5 s) while the intact car does (over 0.2 rad)", () => {
    // Four metres off the line, nose 0.5 rad off the road, a rival close alongside: the brain steers hard back to the line.
    const oval = new Track(TRACKS[0]);
    const p = oval.pointAt(40, { x: 0, y: 0, z: 0, tx: 0, tz: 1, half: 0 });
    const at = (id: number, off: number, v: number) => ({ ...blankAiCar(id), x: p.x + off * p.tz, z: p.z - off * p.tx, yaw: Math.atan2(p.tx, p.tz), vx: p.tx * v, vz: p.tz * v });
    const me = { ...at(0, 4, 15), yaw: Math.atan2(p.tx, p.tz) + 0.5 };
    const rival = at(1, 6.4, 15);
    const brain = new RaceBrain(oval, 2);
    brain.setAggression(0, 0.5);
    let input = idleDrive();
    for (let k = 0; k < 40; k++) input = { ...brain.think(me, [me, rival], { next: 1, lap: 0 }, 1 / 60) };
    assert.ok(Math.abs(input.steer) > 0.3, `the brain does not steer here: ${JSON.stringify(input)}`);
    const turned = (lost: number[]) => {
      const c = car(lost, "sedan", 15);
      c.spawnFacing(me.x, me.z, me.yaw, 15);
      for (const i of lost) c.deform.popHub(mass(c.deform, HUBS[i]!));
      const yaw0 = c.yaw;
      run(c, 0.5, () => ({ ...input, throttle: 0.3, ebrake: false, boost: false }));
      return Math.abs(c.yaw - yaw0);
    };
    assert.ok(turned([]) > 0.2, "the intact car did not turn on the race AI's steering");
    assert.ok(turned([0, 1]) < 0.01, `front pair gone: turned ${turned([0, 1]).toFixed(3)} rad`);
  });

  it("when full throttle is held for 3 s with none, one, two and three wheels lost, then every wheel lost costs more than 1 m/s of speed, and with three gone the car can still move", () => {
    const at3 = (lost: number[]) => {
      const c = car(lost);
      run(c, 3, { throttle: 1 });
      return c.speed;
    };
    const speeds = [[], [0], [0, 1], [0, 1, 2]].map(at3);
    for (let i = 1; i < speeds.length; i++) assert.ok(speeds[i]! < speeds[i - 1]! - 1, `speeds by wheels lost: ${speeds.map((s) => s.toFixed(1))}`);
    assert.ok(speeds[3]! > 1, "three wheels gone and the car cannot move at all");
  });

  it("when a sedan brakes for 10 s from 20 m/s with none, one front, both front and both rear wheels lost, then each loss lengthens the stop by over 0.5 m and losing the front pair costs more than losing the rear pair", () => {
    const stop = (lost: number[]) => {
      const c = car(lost, "sedan", 20);
      run(c, 10, { brake: 1 });
      return c.group.position.z;
    };
    const intact = stop([]);
    const one = stop([0]);
    const front = stop([0, 1]);
    const rear = stop([2, 3]);
    assert.ok(one > intact + 0.5 && front > one + 0.5 && rear > intact + 0.5, `stops (m): intact ${intact.toFixed(1)}, one front ${one.toFixed(1)}, front pair ${front.toFixed(1)}, rear pair ${rear.toFixed(1)}`);
    assert.ok(front > rear, "the front brakes carry more than the rear: losing them must cost more");
  });

  it("when a sedan coasts in neutral for 2 s from 20 m/s with its front-left and rear-left wheels gone, then it loses over 1.5 m/s more speed than the intact car, because the body scrapes along where a wheel is missing", () => {
    const lose = (lost: number[]) => {
      const c = car(lost, "sedan", 20);
      run(c, 2, { neutral: true });
      return 20 - c.speed;
    };
    const [none, two] = [lose([]), lose([0, 2])];
    assert.ok(two > none + 1.5, `2 s of coasting from 20 m/s: intact -${none.toFixed(2)}, two wheels gone -${two.toFixed(2)} m/s`);
  });

  it("when a sedan flicks the handbrake while steering at 20 m/s, then with both rear wheels gone it does not slide (drift under 0.05) and drives as with the lever down, where the intact car slides (drift over 0.5)", () => {
    const flick = (lost: number[], ebrake: boolean) => {
      const c = car(lost, "sedan", 20);
      run(c, 0.6, { steer: 1, ebrake });
      return { drift: c.drive.drift, speed: c.speed, yaw: c.yaw };
    };
    const intact = flick([], true);
    assert.ok(intact.drift > 0.5, `intact handbrake flick: drift ${intact.drift.toFixed(2)}`);
    const bare = flick([2, 3], true);
    const down = flick([2, 3], false);
    assert.ok(bare.drift < 0.05, `rear pair gone: drift ${bare.drift.toFixed(2)}`);
    assert.ok(Math.abs(bare.speed - down.speed) < 0.01 && Math.abs(bare.yaw - down.yaw) < 1e-6, `lever up ${bare.speed.toFixed(2)} m/s ${bare.yaw.toFixed(3)} rad vs down ${down.speed.toFixed(2)} m/s ${down.yaw.toFixed(3)} rad`);
  });

  it("when a sedan with both front wheels gone holds 0.6 throttle at full lock for 1 s from 15 m/s, then it holds its pace above 12 m/s and is not stuck on the spot", () => {
    const c = car([0, 1], "sedan", 15);
    run(c, 1, { throttle: 0.6, steer: 1 });
    assert.ok(c.speed > 12, `a bare front axle held the car to ${c.speed.toFixed(1)} m/s`);
  });

  it("when wheels are lost, then the wheels-on mask names the wheels in front-left, front-right, rear-left, rear-right order, every wheel on leaves every control whole, and a rear pair alone gives no steering and half the drive", () => {
    assert.equal(car([]).deform.wheelsOnMask, 15);
    assert.equal(car([0, 3]).deform.wheelsOnMask, 6);
    const out = wheelLoss(15, new Float64Array(LOSS_SIZE));
    assert.deepEqual(Array.from(out), [1, 1, 1, 1, 1, 0, 2]);
    assert.deepEqual(Array.from(wheelLoss(WHEEL_RL | WHEEL_RR, out)).slice(0, 2), [0, 0.5], "rear pair only: no steering, half the drive");
  });
});
