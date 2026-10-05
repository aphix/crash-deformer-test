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

describe("a car missing wheels", () => {
  for (const cls of CLASS_IDS) {
    it(`bad: ${cls} with both front wheels gone cannot steer: full lock either way turns it ~0 (intact: well over 1 rad/s)`, () => {
      const intact = swing([], cls, { steer: 1 });
      assert.ok(intact > 1, `intact ${intact.toFixed(2)} rad`);
      for (const steer of [1, -1]) {
        const none = swing([0, 1], cls, { steer });
        assert.ok(Math.abs(none) < 0.02, `front pair gone, steer ${steer}: turned ${none.toFixed(3)} rad in 1 s`);
      }
      assert.ok(Math.abs(swing([0, 1, 2], cls, { steer: 1 })) < 0.02, "front pair and a rear wheel gone still steered");
    });

    it(`good: ${cls} with one front wheel gone steers on a reduced lock, and a car with only its rear wheels gone steers as ever`, () => {
      const intact = swing([], cls, { steer: 1 });
      const one = swing([0], cls, { steer: 1 });
      assert.ok(one > 0.15 * intact && one < 0.75 * intact, `one front: ${one.toFixed(2)} rad vs intact ${intact.toFixed(2)}`);
      const rear = swing([2, 3], cls, { steer: 1 });
      assert.ok(rear > 0.8 * intact, `rear pair gone: ${rear.toFixed(2)} rad vs intact ${intact.toFixed(2)}`);
    });
  }

  it("bad: the derby AI's own steering does nothing either, with its front wheels gone", () => {
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

  it("bad: the race AI's steering, its rival-contact guard's too, does nothing with its front wheels gone", () => {
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

  it("good: thrust comes from the wheels still on: every wheel lost costs speed after 3 s of full throttle", () => {
    const at3 = (lost: number[]) => {
      const c = car(lost);
      run(c, 3, { throttle: 1 });
      return c.speed;
    };
    const speeds = [[], [0], [0, 1], [0, 1, 2]].map(at3);
    for (let i = 1; i < speeds.length; i++) assert.ok(speeds[i]! < speeds[i - 1]! - 1, `speeds by wheels lost: ${speeds.map((s) => s.toFixed(1))}`);
    assert.ok(speeds[3]! > 1, "three wheels gone and the car cannot move at all");
  });

  it("good: brakes are the wheels still on: a stop from 20 m/s lengthens with each axle's wheels lost", () => {
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

  it("good: a corner with no wheel scrapes the body along: a freewheeling car loses speed faster the fewer wheels it has", () => {
    const lose = (lost: number[]) => {
      const c = car(lost, "sedan", 20);
      run(c, 2, { neutral: true });
      return 20 - c.speed;
    };
    const [none, two] = [lose([]), lose([0, 2])];
    assert.ok(two > none + 1.5, `2 s of coasting from 20 m/s: intact -${none.toFixed(2)}, two wheels gone -${two.toFixed(2)} m/s`);
  });

  it("bad: the handbrake holds nothing with both rear wheels gone: no slide, and the car does what it does with the lever down", () => {
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

  it("close-but-wrong: a bare front axle still lets the car roll on: under throttle it holds its pace, never stuck on the spot", () => {
    const c = car([0, 1], "sedan", 15);
    run(c, 1, { throttle: 0.6, steer: 1 });
    assert.ok(c.speed > 12, `a bare front axle held the car to ${c.speed.toFixed(1)} m/s`);
  });

  it("good: every wheel on leaves every control whole; the mask names the wheels in FL FR RL RR order", () => {
    assert.equal(car([]).deform.wheelsOnMask, 15);
    assert.equal(car([0, 3]).deform.wheelsOnMask, 6);
    const out = wheelLoss(15, new Float64Array(LOSS_SIZE));
    assert.deepEqual(Array.from(out), [1, 1, 1, 1, 1, 0, 2]);
    assert.deepEqual(Array.from(wheelLoss(WHEEL_RL | WHEEL_RR, out)).slice(0, 2), [0, 0.5], "rear pair only: no steering, half the drive");
  });
});
