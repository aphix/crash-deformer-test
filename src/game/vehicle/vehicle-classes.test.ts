import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applyDrive, DriverSeat, idleDrive, type DriveInput } from "./car-drive.ts";
import { DeformableCar } from "./car.ts";
import { DriveCam } from "../present/engine-camera.ts";
import { makeCar, runWall } from "../contact/crash-scenarios.test-util.ts";
import {
  armKill,
  assignClass,
  CLASSES,
  cornerSpeed,
  drivability,
  HANDLING,
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
 * Launch targets (docs/HANDLING.md § Acceleration): each class's real 0–100 km/h and time to top speed scaled
 * to arcade pace (0–100 × ~0.4, time to top × ~0.5, first gear as punchy as the old launch so derby hits
 * keep their pace), real order kept (muscle and monster quickest, truck slowest off the line); top speeds within 5 % of 200 km/h.
 */
const LAUNCH: Record<VehicleClassId, { zeroTo100: number; topKmh: number; toTop: number; gears: number }> = {
  sedan: { zeroTo100: 2.45, topKmh: 200, toTop: 12, gears: 5 },
  muscle: { zeroTo100: 2, topKmh: 200, toTop: 9.1, gears: 5 },
  truck: { zeroTo100: 2.5, topKmh: 195, toTop: 12.7, gears: 4 },
  monster: { zeroTo100: 2, topKmh: 190, toTop: 11.5, gears: 4 },
  police: { zeroTo100: 2.45, topKmh: 200, toTop: 12, gears: 5 },
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

describe("vehicle classes", () => {
  it("good: every class laps the mixed loop within 5 % of the field's mean", (t) => {
    const loop = mixedLoop();
    const times = VEHICLE_CLASS_IDS.map((id) => lapTime(id, loop));
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const table = VEHICLE_CLASS_IDS.map((id, i) => `${id} ${times[i]!.toFixed(2)} s`).join(", ");
    t.diagnostic(`${loop.length.toFixed(0)} m loop: ${table}`);
    for (const lap of times) assert.ok(Math.abs(lap / mean - 1) <= 0.05, `laps: ${table} (mean ${mean.toFixed(2)})`);
  });

  it("good: classes differ where you'd expect — muscle fastest flat out, monster slowest to turn", () => {
    const tops = VEHICLE_CLASS_IDS.map((id) => CLASSES[id].topSpeed);
    assert.equal(Math.max(...tops), CLASSES.muscle.topSpeed);
    const turns = VEHICLE_CLASS_IDS.map((id) => CLASSES[id].turn);
    assert.equal(Math.min(...turns), CLASSES.monster.turn);
    assert.ok(CLASSES.muscle.drift > CLASSES.sedan.drift && CLASSES.truck.mass > CLASSES.sedan.mass);
  });

  for (const id of VEHICLE_CLASS_IDS) {
    const L = LAUNCH[id];
    it(`good: ${id} — 0–100 km/h in ${L.zeroTo100} s, ${L.topKmh} km/h top after ${L.toTop} s (±5 %), the pull stepping down at ${L.gears - 1} shifts`, () => {
      const car = classCar(id);
      const input = { ...idleDrive(), throttle: 1 };
      const v = [0];
      for (let t = 0; t < 30; t += H) {
        step(car, input);
        v.push(along(car));
      }
      const top = v[v.length - 1]!;
      const t100 = v.findIndex((x) => x >= 100 / 3.6) * H;
      const tTop = v.findIndex((x) => x >= 0.995 * top) * H;
      // Gear buckets: the pull holds within a gear and changes by > 10 % only at a shift, always down.
      const shifts: string[] = [];
      let rises = 0;
      for (let i = 2; i < v.length && v[i]! < 0.99 * top; i++) {
        const before = (v[i - 1]! - v[i - 2]!) / H;
        const after = (v[i]! - v[i - 1]!) / H;
        if (Math.abs(after / before - 1) <= 0.1) continue;
        shifts.push(`${before.toFixed(1)}→${after.toFixed(1)} m/s² at ${(v[i - 1]! * 3.6).toFixed(0)} km/h`);
        if (after > before) rises++;
      }
      const got = `0–100 ${t100.toFixed(2)} s, top ${(top * 3.6).toFixed(0)} km/h at ${tTop.toFixed(2)} s, shifts [${shifts.join(", ")}]`;
      assert.ok(t100 > 0 && Math.abs(t100 / L.zeroTo100 - 1) <= 0.05, got);
      assert.ok(Math.abs((top * 3.6) / L.topKmh - 1) <= 0.05, got);
      assert.ok(Math.abs(tTop / L.toTop - 1) <= 0.05, got);
      assert.equal(shifts.length, L.gears - 1, got);
      assert.equal(rises, 0, got);
    });
  }

  for (const id of VEHICLE_CLASS_IDS) {
    it(`good: ${id} — chase cam, W+A swings the nose LEFT on screen and W+D RIGHT`, () => {
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

  it("good: monster truck — big wheels on the ground, body high, wider turning circle than a sedan", () => {
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

  it("good: a handbrake flick at speed kicks the tail out, keeps its pace, and the arcade assist catches it", () => {
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

describe("damage → drivability", () => {
  const out: Drivability = { stage: "healthy", power: 1, top: 1, pull: 0 };

  it("good: stages go healthy → dented → damaged → limping → dead as health falls", () => {
    const at = (alive: boolean, crashed: boolean, h: number, wheels = 4) => drivability(alive, crashed, h, wheels, 1, 1, out).stage;
    assert.deepEqual(
      [at(true, false, 1), at(true, true, 0.9), at(true, true, 0.5), at(true, true, 0.1), at(false, true, 0)],
      ["healthy", "dented", "damaged", "limping", "dead"],
    );
    assert.equal(at(true, true, 0.9, 3), "damaged", "a lost wheel is never cosmetic");
  });

  it(`good: anything short of dead keeps ≥ ${LIMP_FLOOR * 100} % of top speed, at every slider position`, () => {
    for (const realism of [0, 0.5, 1]) {
      for (let h = 0; h <= 1; h += 0.05) {
        for (let wheels = 1; wheels <= 4; wheels++) {
          drivability(true, true, h, wheels, -1, realism, out);
          assert.ok(out.top >= LIMP_FLOOR && out.power > 0, `realism ${realism} health ${h.toFixed(2)} wheels ${wheels}: top ${out.top}`);
        }
      }
    }
  });

  it("good: a limping car still reaches its floor speed under full throttle, pulling toward the struck side", () => {
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

  it("good: the slider's arcade end survives three 50 km/h wall hits", () => {
    const car = makeCar();
    car.deform.killTravel = killTravel("sedan", 0, "default");
    for (let i = 0; i < 3; i++) runWall(50, 1, "front", { car });
    assert.equal(car.deform.drivetrainAlive, true, `dead after 3 hits, travel ${car.deform.engineTravel.toFixed(3)} m`);
  });

  it("good: the realistic end follows the sourced kill band — drives on after 35 km/h, dies at 64 km/h", () => {
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

  it("good: tougher classes take more before they die, and the monster most, at both ends", () => {
    for (const realism of [0, 1]) {
      const order = (["sedan", "muscle", "truck", "monster"] as const).map((id) => killTravel(id, realism, "default"));
      for (let i = 1; i < order.length; i++) assert.ok(order[i]! >= order[i - 1]!, `realism ${realism}: ${order.join(" ")}`);
      assert.ok(order[3]! > order[0]!);
    }
  });

  // Repeated 25 km/h side hits barely move the block (0.05 m of 0.31 / 0.45): a derby sedan is worn out
  // after 11 (wear 360 + its travel share), a race or fleet sedan drives on after 30 (crash-realism-10).
  it("good: a derby car is worn out by a dozen 25 km/h side hits that a race or fleet car drives away from", () => {
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
