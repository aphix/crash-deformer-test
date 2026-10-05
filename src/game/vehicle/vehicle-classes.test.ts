import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applyDrive, DriverSeat, idleDrive, type DriveInput } from "./car-drive.ts";
import { DRAFT } from "../match/session.ts";
import { DeformableCar } from "./car.ts";
import { DriveCam } from "../present/engine-camera.ts";
import { makeCar, runWall } from "../contact/crash-scenarios.test-util.ts";
import {
  armKill,
  assignClass,
  CLASSES,
  cornerSpeed,
  gearAt,
  carRpm,
  drivability,
  HANDLING,
  killClass,
  killTravel,
  LIMP_FLOOR,
  VEHICLE_CLASS_IDS,
  type Drivability,
  type VehicleClassId,
} from "./vehicle-classes.ts";

const H = 1 / 120;
const PAINT = { body: 0xc5c8ce, accent: 0x9aa0a8, name: "Titanium" };
const DEFAULT_REALISM = HANDLING.realism;

afterEach(() => {
  HANDLING.realism = DEFAULT_REALISM;
});

function classCar(id: VehicleClassId): DeformableCar {
  const car = new DeformableCar(PAINT, new THREE.Scene(), null, CLASSES[id].style);
  assignClass(car, id);
  return car;
}

function along(car: DeformableCar): number {
  return car.velocity.x * car.fwdFlat.x + car.velocity.z * car.fwdFlat.z;
}

function step(car: DeformableCar, input: DriveInput, h = H): void {
  applyDrive(car, input, h);
  car.group.position.x += car.velocity.x * h;
  car.group.position.z += car.velocity.z * h;
  car.refreshBasis();
}

/**
 * Launch targets (docs/HANDLING.md § Acceleration), 0–100 km/h and time to top (s) at each end of the realism slider.
 * Realistic: the sourced 0–60 mph (sedan 6.1, muscle 4.3, truck 7.9, monster about 4), time to top about 2× the arcade.
 * Arcade: about 0.4× and 0.5× of those, real order kept (muscle and monster quickest, truck slowest off the line).
 */
const LAUNCH: Record<VehicleClassId, { topKmh: number; gears: number; arcade: [number, number]; real: [number, number] }> = {
  sedan: { topKmh: 200, gears: 5, arcade: [2.45, 12], real: [6.1, 24] },
  muscle: { topKmh: 210, gears: 5, arcade: [1.95, 9.5], real: [4.3, 19] },
  truck: { topKmh: 195, gears: 4, arcade: [2.5, 12.7], real: [7.9, 25.7] },
  monster: { topKmh: 190, gears: 4, arcade: [2, 11.5], real: [4, 23.1] },
  police: { topKmh: 200, gears: 5, arcade: [2.45, 12], real: [6.1, 24] },
};

// --- a mixed test loop: rounded rectangle, two hairpins and two sweepers ------

type Loop = { x: number[]; z: number[]; r: number[]; s: number[]; length: number };

/** 110 × 60 m box, corner radii 8 / 24 / 8 / 24, sampled every ~1 m, counter-clockwise from the bottom straight. */
function mixedLoop(): Loop {
  const W = 110;
  const D = 60;
  const radii = [8, 24, 8, 24];
  const corners = [
    [W, 0],
    [W, D],
    [0, D],
    [0, 0],
  ] as const;
  const x: number[] = [];
  const z: number[] = [];
  const r: number[] = [];
  const add = (px: number, pz: number, rad: number) => {
    x.push(px);
    z.push(pz);
    r.push(rad);
  };
  for (let c = 0; c < 4; c++) {
    const rad = radii[c]!;
    const prevRad = radii[(c + 3) % 4]!;
    const [cx, cz] = corners[c]!;
    const [px, pz] = corners[(c + 3) % 4]!;
    // Straight from the previous corner's exit to this corner's entry.
    const dx = Math.sign(cx - px);
    const dz = Math.sign(cz - pz);
    const len = Math.hypot(cx - px, cz - pz) - prevRad - rad;
    for (let t = 0; t < len; t += 1) add(px + dx * (prevRad + t), pz + dz * (prevRad + t), Infinity);
    // Quarter arc turning left (CCW seen from +y: heading (dx,dz) → (−dz… )) round the inside centre.
    const nx = -dz;
    const nz = dx;
    const ox = cx - dx * rad + nx * rad;
    const oz = cz - dz * rad + nz * rad;
    const a0 = Math.atan2(-nz, -nx);
    const steps = Math.ceil((Math.PI / 2) * rad);
    for (let i = 0; i < steps; i++) {
      const a = a0 + (i / steps) * (Math.PI / 2) * Math.sign(dx * nz - dz * nx);
      add(ox + Math.cos(a) * rad, oz + Math.sin(a) * rad, rad);
    }
  }
  const s: number[] = [0];
  for (let i = 1; i <= x.length; i++) {
    const j = i % x.length;
    s.push(s[i - 1]! + Math.hypot(x[j]! - x[i - 1]!, z[j]! - z[i - 1]!));
  }
  return { x, z, r, s, length: s[x.length]! };
}

/** Flying-lap time (s) of class `id` round `loop`, driven by a planner that knows only `classStats`. */
function lapTime(id: VehicleClassId, loop: Loop): number {
  const k = CLASSES[id];
  const car = classCar(id);
  const n = loop.x.length;
  car.spawnFacing(loop.x[0]!, loop.z[0]!, Math.atan2(loop.x[1]! - loop.x[0]!, loop.z[1]! - loop.z[0]!), 0);
  const input = idleDrive();
  let idx = 0;
  let travelled = 0;
  let lapStart = -1;
  for (let t = 0; t < 120; t += H) {
    const px = car.group.position.x;
    const pz = car.group.position.z;
    // Progress: walk the index forward while the next sample is closer.
    for (let g = 0; g < 8; g++) {
      const j = (idx + 1) % n;
      if (Math.hypot(loop.x[j]! - px, loop.z[j]! - pz) > Math.hypot(loop.x[idx]! - px, loop.z[idx]! - pz)) break;
      travelled += loop.s[idx + 1]! - loop.s[idx]!;
      idx = j;
    }
    if (lapStart < 0 && travelled >= loop.length) lapStart = t;
    if (lapStart >= 0 && travelled >= 2 * loop.length) return t - lapStart;
    const v = Math.hypot(car.velocity.x, car.velocity.z);
    const look = (idx + Math.round(4 + 0.35 * v)) % n;
    const want = Math.atan2(loop.x[look]! - px, loop.z[look]! - pz);
    const heading = Math.atan2(car.fwdFlat.x, car.fwdFlat.z);
    const err = Math.atan2(Math.sin(want - heading), Math.cos(want - heading));
    let target = k.topSpeed;
    for (let ahead = 0; ahead < 60; ahead += 2) {
      const r = loop.r[(idx + ahead) % n]!;
      if (r === Infinity) continue;
      target = Math.min(target, Math.sqrt(cornerSpeed(k, r) ** 2 * 0.85 + 2 * k.brake * 0.6 * ahead));
    }
    input.steer = THREE.MathUtils.clamp(err * 2.4, -1, 1);
    input.throttle = v < target ? 1 : 0;
    input.brake = v > target + 1 ? 1 : 0;
    step(car, input);
  }
  throw new Error(`${id} never finished two laps`);
}

describe("given the mixed test loop (a 110 m by 60 m rounded rectangle with two hairpins and two sweepers), driven by a planner that knows only each class's published stats", () => {
  it("when every vehicle class laps it, then each class's lap time is within 5 % of the field's mean", (t) => {
    const loop = mixedLoop();
    const times = VEHICLE_CLASS_IDS.map((id) => lapTime(id, loop));
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const table = VEHICLE_CLASS_IDS.map((id, i) => `${id} ${times[i]!.toFixed(2)} s`).join(", ");
    t.diagnostic(`${loop.length.toFixed(0)} m loop: ${table}`);
    for (const lap of times) assert.ok(Math.abs(lap / mean - 1) <= 0.05, `laps: ${table} (mean ${mean.toFixed(2)})`);
  });
});

describe("given the published stats of the vehicle classes", () => {
  it("when the classes are compared, then muscle is fastest flat out, the monster is slowest to turn, muscle slides more than the sedan and the truck is heavier than the sedan", () => {
    const tops = VEHICLE_CLASS_IDS.map((id) => CLASSES[id].topSpeed);
    assert.equal(Math.max(...tops), CLASSES.muscle.topSpeed);
    const turns = VEHICLE_CLASS_IDS.map((id) => CLASSES[id].turn);
    assert.equal(Math.min(...turns), CLASSES.monster.turn);
    assert.ok(CLASSES.muscle.drift > CLASSES.sedan.drift && CLASSES.truck.mass > CLASSES.sedan.mass);
  });
});

describe("given a sedan already at its class top speed under full throttle", () => {
  it("when it passes through a draft (the slipstream behind another car) and then leaves it, then its top speed rises by the draft's top-speed scale only while it is in the draft and settles back to the class top speed after", () => {
    const car = classCar("sedan");
    const top = CLASSES.sedan.topSpeed;
    car.spawnFacing(0, 0, 0, 0);
    car.velocity.set(car.fwdFlat.x * top, 0, car.fwdFlat.z * top);
    const gas = { ...idleDrive(), throttle: 1 };
    const run = (seconds: number, scale: number) => {
      for (let t = 0; t < seconds; t += H) {
        applyDrive(car, gas, H, scale);
        car.group.position.x += car.velocity.x * H;
        car.group.position.z += car.velocity.z * H;
        car.refreshBasis();
      }
      return along(car);
    };
    assert.ok(Math.abs(run(2, 1) - top) < 1e-6, "flat out at the class top");
    const drafting = run(4, DRAFT.top);
    assert.ok(Math.abs(drafting - top * DRAFT.top) < 1e-6, `drafting: ${drafting.toFixed(3)} vs ${(top * DRAFT.top).toFixed(3)} m/s`);
    assert.ok(Math.abs(run(4, 1) - top) < 1e-6, "back to the class top once out of the draft");
  });
});

describe("given each vehicle class driven at full throttle from a standstill, with the realism slider at its arcade end and at its realistic end", () => {
  for (const id of VEHICLE_CLASS_IDS) {
    for (const end of ["arcade", "real"] as const) {
      const L = LAUNCH[id];
      const [zeroTo100, toTop] = L[end];
      it(`when a ${id} is driven at the ${end} end, then it reaches 100 km/h in ${zeroTo100} s and ${L.topKmh} km/h top after ${toTop} s (±5 %), its pull steps down only at its ${L.gears - 1} gear shifts, and the gauge's gear changes at those same shifts`, () => {
      HANDLING.realism = end === "arcade" ? 0 : 1;
      const car = classCar(id);
      const input = { ...idleDrive(), throttle: 1 };
      const v = [0];
      for (let t = 0; t < 32; t += H) {
        step(car, input);
        v.push(along(car));
      }
      const top = v[v.length - 1]!;
      const t100 = v.findIndex((x) => x >= 100 / 3.6) * H;
      const tTop = v.findIndex((x) => x >= 0.995 * top) * H;
      // Gear buckets: the pull holds within a gear and changes by > 10 % only at a shift, always down; the HUD's
      // gear (`gearAt`) steps up on exactly those steps.
      const shifts: string[] = [];
      const hudOff: string[] = [];
      let rises = 0;
      for (let i = 2; i < v.length && v[i]! < 0.99 * top; i++) {
        const before = (v[i - 1]! - v[i - 2]!) / H;
        const after = (v[i]! - v[i - 1]!) / H;
        const hudShift = gearAt(CLASSES[id], v[i - 1]!) !== gearAt(CLASSES[id], v[i - 2]!);
        if (hudShift !== Math.abs(after / before - 1) > 0.1) hudOff.push(`${(v[i - 1]! * 3.6).toFixed(0)} km/h`);
        if (Math.abs(after / before - 1) <= 0.1) continue;
        shifts.push(`${before.toFixed(1)}→${after.toFixed(1)} m/s² at ${(v[i - 1]! * 3.6).toFixed(0)} km/h`);
        if (after > before) rises++;
      }
      assert.deepEqual(hudOff, [], `HUD gear disagrees with the pull at ${hudOff.join(", ")}`);
      const got = `0–100 ${t100.toFixed(2)} s, top ${(top * 3.6).toFixed(0)} km/h at ${tTop.toFixed(2)} s, shifts [${shifts.join(", ")}]`;
      assert.ok(t100 > 0 && Math.abs(t100 / zeroTo100 - 1) <= 0.05, got);
      assert.ok(Math.abs((top * 3.6) / L.topKmh - 1) <= 0.05, got);
      assert.ok(Math.abs(tTop / toTop - 1) <= 0.05, got);
      assert.equal(shifts.length, L.gears - 1, got);
      assert.equal(rises, 0, got);
      });
    }
  }
});

describe("given each vehicle class driven under the chase camera", () => {
  for (const id of VEHICLE_CLASS_IDS) {
    it(`when W+A and then W+D are held, then the ${id}'s nose swings left on screen with W+A and right with W+D`, () => {
      for (const [key, sign] of [
        ["KeyA", -1],
        ["KeyD", 1],
      ] as const) {
        const car = classCar(id);
        car.spawnFacing(0, 0, 0, 10);
        const seat = new DriverSeat();
        seat.focus(0);
        seat.mode = "drive";
        const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 180);
        const rig = new DriveCam();
        const hold = (keys: string[], seconds: number) => {
          for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
            seat.sample(new Set(keys), null);
            step(car, seat.input(car, 1 / 60), 1 / 60);
            rig.update(cam, car, "third", 1 / 60, 0, 0);
          }
          cam.updateMatrixWorld();
        };
        const noseDx = () =>
          car.group.localToWorld(new THREE.Vector3(0, 0.6, 2.2)).project(cam).x -
          car.group.localToWorld(new THREE.Vector3(0, 0.6, 0)).project(cam).x;
        hold(["KeyW"], 1.5);
        assert.ok(Math.abs(noseDx()) < 0.01, `${id} camera not settled: ${noseDx()}`);
        hold(["KeyW", key], 0.6);
        assert.ok(sign * noseDx() > 0.02, `${id} ${key}: nose screen dx ${noseDx().toFixed(3)}`);
      }
    });
  }
});

describe("given the sedan's gear buckets (the speed ranges of each gear)", () => {
  it("when its speed climbs from near standstill past the top of the last gear, then the gauge's engine revs climb within each gear to near the redline, drop once at each upshift in step with the gauge's gear, fall below 35 % at the foot of the next gear, and idle at 0.18 in reverse", () => {
    const k = CLASSES.sedan;
    const at = (v: number) => carRpm({ style: { id: "sedan" }, velocity: { x: 0, z: v }, fwdFlat: { x: 0, z: 1 } });
    let drops = 0;
    let prev = at(0);
    for (let v = 0.1; v < k.topSpeed * 1.3; v += 0.05) {
      const rpm = at(v);
      assert.ok(rpm >= 0 && rpm <= 1, `${v} m/s: ${rpm}`);
      if (rpm < prev - 0.05) {
        drops++;
        assert.notEqual(gearAt(k, v), gearAt(k, v - 0.05), `revs fell at ${v} m/s without a shift`);
      }
      prev = rpm;
    }
    assert.equal(drops, k.gears.length - 1, "one drop per upshift");
    assert.ok(at(k.gears[1]![0] * k.topSpeed - 0.01) > 0.99, "near the redline at the top of a bucket");
    assert.ok(at(k.gears[1]![0] * k.topSpeed + 0.01) < 0.35, "back at the foot of the next");
    assert.equal(carRpm({ style: { id: "sedan" }, velocity: { x: 0, z: -5 }, fwdFlat: { x: 0, z: 1 } }), 0.18, "idles in reverse");
  });
});

describe("given the monster truck class", () => {
  it("when it stands still and then drives with the steering locked at 12 m/s, then its wheels sit on the ground at their full radius, its body is lifted over 0.4 m, and it turns at under 90 % of a sedan's rate", () => {
    const monster = classCar("monster");
    monster.spawnFacing(0, 0, 0, 0);
    monster.group.updateMatrixWorld(true);
    for (const w of monster.wheels) {
      const centre = w.getWorldPosition(new THREE.Vector3());
      const radius = 0.32 * w.getWorldScale(new THREE.Vector3()).y;
      assert.ok(Math.abs(centre.y - radius) < 0.01, `wheel floats/sinks: centre ${centre.y.toFixed(3)} r ${radius.toFixed(3)}`);
    }
    assert.ok(monster.body.getWorldPosition(new THREE.Vector3()).y > 0.4, "body not lifted");
    const circle = (id: VehicleClassId) => {
      const car = classCar(id);
      car.spawnFacing(0, 0, 0, 12);
      const input = { ...idleDrive(), throttle: 0.6, steer: 1 };
      for (let t = 0; t < 1; t += H) step(car, input);
      return Math.abs(car.angular.y);
    };
    assert.ok(circle("monster") < circle("sedan") * 0.9, `monster yaw ${circle("monster")} vs sedan ${circle("sedan")}`);
  });
});

describe("given a sedan at 16 m/s with the realism slider at its arcade end", () => {
  it("when it flicks the handbrake with full throttle and steering, holds the steering, then eases off, then the tail kicks out beyond 0.25 rad, the slide is held (over 0.5) above 11 m/s, and the arcade assist straightens it to under 0.06 rad of slip", () => {
    HANDLING.realism = 0;
    const car = classCar("sedan");
    car.spawnFacing(0, 0, 0, 16);
    const flick = { ...idleDrive(), throttle: 1, steer: 1, ebrake: true };
    for (let t = 0; t < 0.35; t += H) step(car, flick);
    const slip = () => Math.abs(Math.atan2(car.velocity.x * car.fwdFlat.z - car.velocity.z * car.fwdFlat.x, along(car)));
    assert.ok(slip() > 0.25, `slip after the flick ${slip().toFixed(2)} rad`);
    const hold = { ...idleDrive(), throttle: 1, steer: 1 };
    for (let t = 0; t < 0.8; t += H) step(car, hold);
    assert.ok(slip() > 0.2 && car.drive.slide > 0.5, `slide not held: slip ${slip().toFixed(2)} slide ${car.drive.slide.toFixed(2)}`);
    assert.ok(Math.hypot(car.velocity.x, car.velocity.z) > 11, `drift bled to ${Math.hypot(car.velocity.x, car.velocity.z).toFixed(1)} m/s`);
    const release = { ...idleDrive(), throttle: 0.6 };
    for (let t = 0; t < 1; t += H) step(car, release);
    assert.ok(slip() < 0.06, `assist did not catch it: slip ${slip().toFixed(2)} rad`);
  });
});

describe("given the drivability rules (how a car's health, crash state, wheels left and the realism slider limit its power and top speed)", () => {
  const out: Drivability = { stage: "healthy", power: 1, top: 1, pull: 0 };

  it("when health falls from full to 0.9, 0.5 and 0.1 after a crash and then the car is dead, then the stage goes healthy, dented, damaged, limping, dead, and a lost wheel makes a 0.9-health car damaged, never merely dented", () => {
    const at = (alive: boolean, crashed: boolean, h: number, wheels = 4) => drivability(alive, crashed, h, wheels, 1, 1, out).stage;
    assert.deepEqual(
      [at(true, false, 1), at(true, true, 0.9), at(true, true, 0.5), at(true, true, 0.1), at(false, true, 0)],
      ["healthy", "dented", "damaged", "limping", "dead"],
    );
    assert.equal(at(true, true, 0.9, 3), "damaged", "a lost wheel is never cosmetic");
  });

  it(`when health runs from 0 to 1 with 1 to 4 wheels left at realism 0, 0.5 and 1, then anything short of dead keeps at least ${LIMP_FLOOR * 100} % of top speed and some power`, () => {
    for (const realism of [0, 0.5, 1]) {
      for (let h = 0; h <= 1; h += 0.05) {
        for (let wheels = 1; wheels <= 4; wheels++) {
          drivability(true, true, h, wheels, -1, realism, out);
          assert.ok(out.top >= LIMP_FLOOR && out.power > 0, `realism ${realism} health ${h.toFixed(2)} wheels ${wheels}: top ${out.top}`);
        }
      }
    }
  });
});

describe("given a crashed sedan whose engine is pushed in to 98 % of the depth that kills its drivetrain, at the realistic end of the realism slider", () => {
  it("when it holds full throttle for 20 s, then it reaches at least its limp floor speed (60 % of top speed) but stays under 90 % of top speed, and it pulls toward the struck (left) side", () => {
    HANDLING.realism = 1;
    const car = classCar("sedan");
    car.spawnFacing(0, 0, 0, 0);
    car.crashed = true;
    car.deform.engineTravel = car.deform.killTravel * 0.98;
    car.deform.impactInward.set(-1, 0, 0);
    const gas = { ...idleDrive(), throttle: 1 };
    // A limping sedan's pull is about halved: ~10 s up to its floor in the gear buckets.
    for (let t = 0; t < 20; t += H) step(car, gas);
    const v = along(car);
    assert.ok(v >= LIMP_FLOOR * CLASSES.sedan.topSpeed - 0.05 && v < CLASSES.sedan.topSpeed * 0.9, `limping at ${v.toFixed(2)} m/s`);
    assert.ok(car.angular.y > 0.05, `no pull toward the struck (left) side: yaw ${car.angular.y.toFixed(3)}`);
  });
});

describe("given a sedan set up for the arcade end of the realism slider", () => {
  it("when it takes three 50 km/h head-on wall hits, then its drivetrain is still alive", () => {
    const car = makeCar();
    car.deform.killTravel = killTravel("sedan", 0, "default");
    for (let i = 0; i < 3; i++) runWall(50, 1, "front", { car });
    assert.equal(car.deform.drivetrainAlive, true, `dead after 3 hits, travel ${car.deform.engineTravel.toFixed(3)} m`);
  });
});

describe("given a sedan set up for the realistic end of the realism slider (sourced kill band)", () => {
  it("when it hits a wall at 35 km/h and a fresh one at 64 km/h, then the kill travel is 0.15 m, the 35 km/h sedan drives on and the 64 km/h sedan's drivetrain dies", () => {
    assert.equal(killTravel("sedan", 1, "default"), 0.15);
    const slow = makeCar();
    slow.deform.killTravel = killTravel("sedan", 1, "default");
    runWall(35, 1, "front", { car: slow });
    assert.equal(slow.deform.drivetrainAlive, true, "35 km/h killed it");
    const fast = makeCar();
    fast.deform.killTravel = killTravel("sedan", 1, "default");
    runWall(64, 1, "front", { car: fast });
    assert.equal(fast.deform.drivetrainAlive, false, "64 km/h left it running");
  });
});

describe("given the engine kill travel of each class (how far the engine can be pushed in before the drivetrain dies)", () => {
  it("when the classes are read at the arcade end and the realistic end, then sedan, muscle, truck and monster each take at least as much as the one before, and the monster more than the sedan", () => {
    for (const realism of [0, 1]) {
      const order = (["sedan", "muscle", "truck", "monster"] as const).map((id) => killTravel(id, realism, "default"));
      for (let i = 1; i < order.length; i++) assert.ok(order[i]! >= order[i - 1]!, `realism ${realism}: ${order.join(" ")}`);
      assert.ok(order[3]! > order[0]!);
    }
  });

  it("when the police class is read against the sedan, then an AI police unit takes 15 to 20 % more at the default realism and more at both slider ends, while the player's police car counts as a sedan and an AI one as police", () => {
    const sedan = killTravel("sedan", DEFAULT_REALISM, "default");
    const police = killTravel("police", DEFAULT_REALISM, "default");
    assert.ok(police >= sedan * 1.15 && police <= sedan * 1.2, `police ${police.toFixed(3)} m vs sedan ${sedan.toFixed(3)} m`);
    for (const realism of [0, 1]) assert.ok(killTravel("police", realism, "default") > killTravel("sedan", realism, "default"), `realism ${realism}`);
    const cruiser = (carIndex: number) => ({ style: { id: "police" as const }, group: { userData: { carIndex } } });
    assert.equal(killClass(cruiser(0)), "sedan", "the player's slot");
    assert.equal(killClass(cruiser(7)), "police", "an AI unit's slot");
  });
});

describe("given a sedan armed for a derby and one armed for a race or fleet, hit repeatedly from the side at 25 km/h", () => {
  // Repeated 25 km/h side hits barely move the block (0.05 m of 0.31 / 0.45): a derby sedan is worn out
  // after 11 (wear 360 + its travel share), a race or fleet sedan drives on after 30 (crash-realism-10).
  it("when each takes side hits one after another up to 30, then the derby sedan's drivetrain is worn out after 6 to 20 hits and the race or fleet sedan survives all 30", () => {
    const hitsToKill = (ctx: "derby" | "default") => {
      const car = makeCar();
      armKill(car.deform, "sedan", DEFAULT_REALISM, ctx);
      let n = 0;
      while (n < 30 && car.deform.drivetrainAlive) {
        runWall(25, 1, "side", { car });
        n++;
      }
      return car.deform.drivetrainAlive ? Infinity : n;
    };
    const derby = hitsToKill("derby");
    assert.ok(derby >= 6 && derby <= 20, `derby sedan died after ${derby} hits`);
    assert.equal(hitsToKill("default"), Infinity, "a race / fleet sedan died of side hits");
  });
});
