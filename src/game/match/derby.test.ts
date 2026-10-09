import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DerbyBrain, blankAiCar } from "../ai/derby-ai.ts";
import { personality } from "../ai/personality.ts";
import { DerbyMatch, HIT_POINTS, DISABLE_POINTS, SCORE_GAP, STALEMATE, snapshotAiCar } from "./derby.ts";
import { clipDerbyCar, clipToDerbyBowl, DERBY_RADIUS, derbyRadius, makeDerbyArena } from "../scenes/derby-arena.ts";
import { idleDrive, applyDrive } from "../vehicle/car-drive.ts";
import { fleetStyle, layoutDerby, MAX_CARS } from "../scenes/fleet.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { physicsSlice } from "../contact/sat.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";
import { CAGES } from "../kernel/rig-spec.ts";
import { armKill, carClass, DEFAULT_REALISM } from "../vehicle/vehicle-classes.ts";
import { aiCar, assertSameDigest, decide } from "../vehicle/test-support.ts";

describe("given a brawler (full aggression) driving at a target that comes straight at it with a flattened nose", () => {
  it("when it decides its drive input, then it swings wide or backs in rather than charging nose first (head-on hits are banned in the rule books)", () => {
    const brain = new DerbyBrain();
    brain.setAggression(2, 1);
    const me = aiCar(2, { z: -8 });
    const flat = aiCar(1, { z: 8, yaw: Math.PI, vz: -8, front: 0.8, damage: 0.8 });
    const input = decide(brain, me, [me, flat]);
    assert.ok(Math.abs(input.steer) > 0.3 || input.throttle < 0, `charged nose first: steer ${input.steer} throttle ${input.throttle}`);
  });
});

describe("given a derby car that fights with its tail as the bumper", () => {
  it("when a target is behind it, then it backs into it, even with its own front wrecked; and when a target is ahead, then it first handbrake J-turns (a handbrake spin to bring its tail round)", () => {
    const parked = aiCar(0, { vz: 0 });
    const behind = aiCar(1, { z: -10 });
    const back = decide(new DerbyBrain(), parked, [parked, behind]);
    assert.ok(back.throttle < -0.5, `didn't back in: throttle ${back.throttle}`);
    const spent = aiCar(0, { vz: 0, front: 0.7, damage: 0.7 });
    assert.ok(decide(new DerbyBrain(), spent, [spent, behind]).throttle < 0, "front-damaged car donated its block");
    const rolling = aiCar(0, { vz: 8 });
    const ahead = aiCar(1, { z: 12, vz: 0 });
    const brain = new DerbyBrain();
    const turn = decide(brain, rolling, [rolling, ahead]);
    assert.equal(brain.tacticOf(0), "jturn");
    assert.ok(turn.ebrake && turn.throttle === 0 && Math.abs(turn.steer) > 0.5, `no J-turn: ${JSON.stringify(turn)}`);
  });
});

describe("given a derby car 1.2 m from the arena wall with another car 4 m to its side", () => {
  it("when it decides its drive input, then it turns or backs away from the wall instead of driving into the concrete", () => {
    const me = aiCar(3, { x: 0, z: DERBY_RADIUS - 1.2 });
    const foe = aiCar(1, { x: 4, z: 0 });
    const input = decide(new DerbyBrain(), me, [me, foe]);
    assert.ok(Math.abs(input.steer) > 0.5 || input.throttle < 0, `steer ${input.steer} throttle ${input.throttle}`);
  });
});

describe("given a derby car backing tail first toward a target that faces it", () => {
  it("when the target is crossing at 8 m/s instead of parked, then the car steers more than 0.3 further to meet where the target will be, instead of aiming where it was", () => {
    // Backing at it tail first: facing away, rolling backwards toward it.
    const me = aiCar(3, { z: -10, yaw: Math.PI, vz: 8 });
    // It faces us, so we back straight down its nose lane; crossing, it drags the aim sideways.
    const parked = aiCar(1, { yaw: Math.PI, vz: 0 });
    const crossing = aiCar(1, { yaw: Math.PI, vx: 8, vz: 0 });
    const atParked = decide(new DerbyBrain(), me, [me, parked]);
    const atCrossing = decide(new DerbyBrain(), me, [me, crossing]);
    assert.ok(
      atCrossing.steer > atParked.steer + 0.3,
      `no lead: steer ${atCrossing.steer.toFixed(2)} vs parked ${atParked.steer.toFixed(2)}`,
    );
  });
});

describe("given two parked victims, with hunters backing toward them tail first", () => {
  it("when one lone hunter, two cautious hunters and two full-aggression hunters (facing a wrecked victim) choose, then the lone hunter takes the nearer victim, the cautious pair take one victim each, and the wreck draws both full-aggression hunters", () => {
    // Two parked victims; A is nearer both hunters, who are backing toward them tail first.
    const a = aiCar(4, { x: -2.2, vz: 0 });
    const b = aiCar(5, { x: 3.6, vz: 0 });
    const south = aiCar(2, { z: -10, yaw: Math.PI, vz: 8 });
    const north = aiCar(3, { z: 10, vz: -8 });
    const all = [south, north, a, b];
    const alone = new DerbyBrain();
    decide(alone, north, all);
    assert.equal(alone.huntersOf(4), 1, "the lone hunter should take the nearer victim");
    const pair = new DerbyBrain();
    pair.setAggression(2, 0.2);
    pair.setAggression(3, 0.2);
    decide(pair, south, all);
    decide(pair, north, all);
    assert.deepEqual([pair.huntersOf(4), pair.huntersOf(5)], [1, 1]);
    const wreck = aiCar(5, { x: 3.6, vz: 0, front: 0.8, damage: 0.8 });
    const brutes = new DerbyBrain();
    brutes.setAggression(2, 1);
    brutes.setAggression(3, 1);
    decide(brutes, south, [south, north, a, wreck]);
    decide(brutes, north, [south, north, a, wreck]);
    assert.deepEqual([brutes.huntersOf(4), brutes.huntersOf(5)], [0, 2], "the weakened car should draw both brutes");
  });
});

describe("given a derby car wedged 3 m from a foe that sits across its path", () => {
  it("when its throttle is held with no motion, then it backs out, and when a second wedge follows it tries the other gear instead of the same blocked one", () => {
    const brain = new DerbyBrain();
    const me = aiCar(3, { z: -3, vz: 0 });
    const foe = aiCar(1, { z: 3, yaw: Math.PI / 2, vz: 0 });
    const others = [me, foe];
    const push = decide(brain, me, others).throttle;
    assert.ok(Math.abs(push) > 0.35, `not pushing: ${push}`);
    let backed = 0;
    for (let k = 0; k < 15 && backed === 0; k++) {
      const input = decide(brain, me, others, 0.1);
      if (brain.recovering(3)) backed = input.throttle;
    }
    assert.ok(backed * push < 0, "never backed out of a dead push");
    let escape = 0;
    for (let k = 0; k < 40 && escape * backed >= 0; k++) {
      const input = decide(brain, me, others, 0.1);
      if (brain.recovering(3)) escape = input.throttle;
    }
    assert.ok(escape * backed < 0, "kept trying the same blocked gear");
  });
});

describe("given derby drivers built from their ids in two matches", () => {
  it("when the drivers are built, then driver 7 is the same driver both times, and across ten ids some flank each way and some launch at once while others hold back", () => {
    assertSameDigest(personality(7), personality(7), "driver 7 in two matches");
    const field = Array.from({ length: 10 }, (_, i) => personality(i));
    assert.ok(new Set(field.map((p) => p.side)).size === 2, "everyone flanks the same way");
    assert.ok(field.some((p) => p.hold === 0) && field.some((p) => p.hold > 0.3), "whole field launches in lockstep");
  });
});

describe("given a three-car derby match", () => {
  it("when cars hit, then a hard hit scores one point per pair per gap: the same contact twice, a repeat inside the gap or a 3 m/s tap scores nothing, and a hit after the gap scores again", () => {
    const m = new DerbyMatch();
    m.begin(
      [
        { id: 0, name: "Titanium" },
        { id: 1, name: "Petrol" },
        { id: 2, name: "Oxide" },
      ],
      { start: 0 },
    );
    assert.equal(m.noteHit(0, 1, 8, 2, 6), true);
    assert.equal(m.noteHit(0, 1, 8, 2, 6), false, "same contact twice");
    m.time = SCORE_GAP / 2;
    m.noteHit(0, 1, 8, 2, 6);
    m.noteHit(0, 2, 3, 0, 6);
    assert.equal(m.row(0)!.score, HIT_POINTS, "inside the gap, or a 3 m/s tap, scored");
    m.time = SCORE_GAP + 0.05;
    m.noteHit(0, 1, 8, 2, 6);
    assert.equal(m.row(0)!.score, HIT_POINTS * 2);
    assert.equal(m.row(0)!.hits, 2);
  });
});

describe("given a two-car derby match where one car lands seven hits on the other", () => {
  it("when the other car's engine dies, then the disable is a bonus on top of the hits and the last survivor wins regardless of points", () => {
    const m = new DerbyMatch();
    m.begin([
      { id: 0, name: "Titanium" },
      { id: 1, name: "Petrol" },
    ]);
    m.noteHit(1, 0, 9, 1, 10);
    for (let i = 0; i < 6; i++) {
      m.time += SCORE_GAP + 0.05;
      m.noteHit(1, 0, 9, 1, 8);
    }
    m.step(0.05, [
      { id: 0, name: "Titanium", alive: false, x: 0, z: 0 },
      { id: 1, name: "Petrol", alive: true, x: 0, z: 5 },
    ]);
    assert.equal(m.row(1)!.disables, 1);
    assert.equal(m.row(1)!.score, 7 * HIT_POINTS + DISABLE_POINTS);
    assert.equal(m.winnerId, 1);
    assert.equal(m.winnerName, "Petrol");
  });
});

describe("given a two-car derby match where the car with more points is disabled", () => {
  it("when the other car survives, then the survivor wins although the dead car has more points", () => {
    const m = new DerbyMatch();
    m.begin([
      { id: 0, name: "Oxide" },
      { id: 1, name: "Ink" },
    ]);
    for (let i = 0; i < 8; i++) {
      m.time += SCORE_GAP + 0.02;
      m.noteHit(0, 1, 10, 0, 9);
    }
    m.step(0.02, [
      { id: 0, name: "Oxide", alive: false, x: 0, z: 0 },
      { id: 1, name: "Ink", alive: true, x: 0, z: 5 },
    ]);
    assert.equal(m.winnerId, 1);
    assert.ok(m.row(0)!.score > m.row(1)!.score);
  });
});

describe("given a car outside the derby bowl wall", () => {
  it("when it is clipped to the bowl, then it is pushed back inside and loses outward speed", () => {
    const hit = clipToDerbyBowl(0, DERBY_RADIUS + 2, 0, 12);
    assert.equal(hit.hit, true);
    assert.ok(Math.hypot(hit.x, hit.z) < DERBY_RADIUS - 1);
    assert.ok(hit.vz < 12);
  });
});

describe("given the derby arena's wall slabs", () => {
  it("when each slab's long axis is compared with the ring's radial direction, then every slab lies along the ring (tangent), not radial, sits on the ring's radius, and there are at least 16", () => {
    const arena = makeDerbyArena();
    const long = new THREE.Vector3();
    const radial = new THREE.Vector3();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    let slabs = 0;
    for (const child of arena.children) {
      const walls = child as THREE.InstancedMesh;
      if (!walls.isInstancedMesh || walls.geometry.type !== "BoxGeometry") continue;
      for (let i = 0; i < walls.count; i++) {
        slabs++;
        walls.getMatrixAt(i, m);
        m.decompose(radial, q, s);
        long.set(0, 0, 1).applyQuaternion(q);
        radial.setY(0);
        const len = radial.length() || 1;
        const dot = Math.abs(long.dot(radial) / len);
        assert.ok(dot < 0.25, `slab long-axis is radial, dot=${dot.toFixed(2)}`);
        assert.ok(Math.abs(len - DERBY_RADIUS) < 0.01, `slab off the ring, r=${len.toFixed(2)}`);
      }
    }
    assert.ok(slabs >= 16);
  });
});

describe("given six derby cars laid out in the bowl", () => {
  it("when their start slots are laid out, then all six sit on a ring inside the bowl, within the car limit, each facing its centre", () => {
    const slots = layoutDerby(6, DERBY_RADIUS, () => 0.5);
    assert.equal(slots.length, 6);
    assert.ok(slots.length <= MAX_CARS);
    for (const s of slots) {
      assert.ok(Math.hypot(s.x, s.z) < DERBY_RADIUS - 3);
      // Nose (sin yaw, cos yaw) along the line to the origin.
      const r = Math.hypot(s.x, s.z);
      assert.ok(Math.sin(s.yaw) * (-s.x / r) + Math.cos(s.yaw) * (-s.z / r) > 0.9999);
    }
  });
});

describe("given the AI's damage reading of a car", () => {
  it("when a mint car and a car with a dead drivetrain are read, then the mint car reads near 0 and the dead drivetrain reads 1", () => {
    const c = new DeformableCar({ body: 0xc5c8ce, accent: 0x9aa0a8, name: "Titanium" }, new THREE.Scene());
    const s = snapshotAiCar(blankAiCar(0), 0, c, true);
    assert.ok(s.front < 0.02 && s.rear < 0.02 && s.damage < 0.02, `mint read ${s.front}/${s.rear}/${s.damage}`);
    assert.equal(snapshotAiCar(blankAiCar(0), 0, c, false).damage, 1);
  });
});

describe("given the idle drive input", () => {
  it("when it is read, then throttle is zero and neither handbrake nor boost is on", () => {
    const d = idleDrive();
    assert.equal(d.throttle, 0);
    assert.equal(d.ebrake, false);
    assert.equal(d.boost, false);
  });
});

/** 50 km/h rigid wall. Two cars at half that each see about half the delta-v. */
const FRONT_DISABLE_MPS = 50 / 3.6;

describe("given two cars, each at half the speed of a 50 km/h rigid-wall hit, driving head-on at each other in shape deform mode", () => {
  it("when they crash for 1.6 s, then both engines still run", () => {
    const scene = new THREE.Scene();
    const half = FRONT_DISABLE_MPS * 0.5;
    const a = new DeformableCar({ body: 0xc5c8ce, accent: 0x9aa0a8, name: "Titanium" }, scene);
    const b = new DeformableCar({ body: 0x3d8a86, accent: 0x2a6360, name: "Petrol" }, scene);
    for (const car of [a, b]) car.deform.setMode("shape");
    a.group.position.set(0, 0, 8);
    b.group.position.set(0, 0, -8);
    a.group.rotation.set(0, Math.PI, 0, "YXZ");
    b.group.rotation.set(0, 0, 0, "YXZ");
    a.yaw = Math.PI;
    b.yaw = 0;
    a.refreshBasis();
    b.refreshBasis();
    a.velocity.set(0, 0, -half);
    b.velocity.set(0, 0, half);
    a.deform.bindKinematic(a.group, a.velocity, a.angular);
    b.deform.bindKinematic(b.group, b.velocity, b.angular);
    const w = newWorld([a, b]);
    let t = 0;
    while (t < 1.6) {
      const h = physicsSlice(1 / 60, Math.max(a.speed, b.speed, 4));
      stepWorld(w, h);
      t += h;
    }
    const travel = (car: DeformableCar) => {
      const el = car.deform.masses.find((m) => m.name === "engineL")!;
      const er = car.deform.masses.find((m) => m.name === "engineR")!;
      return Math.max(el.local.distanceTo(el.rest), er.local.distanceTo(er.rest));
    };
    assert.equal(a.deform.drivetrainAlive, true, `titanium died on a 25 km/h head-on travel=${travel(a).toFixed(3)}`);
    assert.equal(b.deform.drivetrainAlive, true, `petrol died on a 25 km/h head-on travel=${travel(b).toFixed(3)}`);
  });
});

describe("given a default two-car derby in shape deform mode", () => {
  it("when the AI drives both cars for 5 s after the green light, then both engines still run, the cars are still moving and they met (closest approach under 6.5 m), not parked nose to nose", () => {
    const scene = new THREE.Scene();
    const a = new DeformableCar({ body: 0xc5c8ce, accent: 0x9aa0a8, name: "Titanium" }, scene);
    const b = new DeformableCar({ body: 0x3d8a86, accent: 0x2a6360, name: "Petrol" }, scene);
    let seed = 7;
    const slots = layoutDerby(2, derbyRadius(2), () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646);
    for (const [i, c] of [a, b].entries()) {
      c.deform.setMode("shape");
      c.spawnFacing(slots[i]!.x, slots[i]!.z, slots[i]!.yaw, 0);
    }
    const match = new DerbyMatch();
    match.begin([
      { id: 0, name: "Titanium" },
      { id: 1, name: "Petrol" },
    ]);
    const w = newWorld([a, b]);
    w.afterCar = (car) => clipDerbyCar(car, derbyRadius(2));
    // Match time: negative through the start lights, 0 at green.
    let t = match.time;
    let minD = Infinity;
    while (t < 5.05) {
      const h = physicsSlice(1 / 60, Math.max(a.speed, b.speed, 4));
      const snaps = match.snapshots(2);
      for (const [i, c] of [a, b].entries()) snapshotAiCar(snaps[i]!, i, c, c.deform.drivetrainAlive);
      applyDrive(a, match.think(snaps[0]!, snaps, h), h);
      applyDrive(b, match.think(snaps[1]!, snaps, h), h);
      stepWorld(w, h);
      match.step(h, [
        { id: 0, name: "Titanium", alive: a.deform.drivetrainAlive, x: a.group.position.x, z: a.group.position.z },
        { id: 1, name: "Petrol", alive: b.deform.drivetrainAlive, x: b.group.position.x, z: b.group.position.z },
      ]);
      minD = Math.min(minD, Math.hypot(a.group.position.x - b.group.position.x, a.group.position.z - b.group.position.z));
      t += h;
    }
    assert.equal(a.deform.drivetrainAlive, true, "titanium engine died before 5s");
    assert.equal(b.deform.drivetrainAlive, true, "petrol engine died before 5s");
    const sp = Math.max(a.velocity.length(), b.velocity.length());
    assert.ok(sp > 3, `both parked at 5s, max speed ${sp.toFixed(2)} m/s`);
    assert.ok(minD < 6.5, `never met, closest ${minD.toFixed(2)} m`);
  });
});

/** Which face of `car` the world point sits on. */
function face(car: DeformableCar, p: THREE.Vector3): "front" | "rear" | "side" {
  const dx = p.x - car.group.position.x;
  const dz = p.z - car.group.position.z;
  const along = (dx * car.fwdFlat.x + dz * car.fwdFlat.z) / CAR_HALF.z;
  const across = (dx * car.fwdFlat.z - dz * car.fwdFlat.x) / CAR_HALF.x;
  if (Math.abs(along) * 1.15 < Math.abs(across)) return "side";
  return along > 0 ? "front" : "rear";
}

type DerbyRun = { hits: number; noseToNose: number; worstWedge: number; t: number; state: string; deaths: number[]; zips: string[]; pops: string[] };

/** Mass centroid (x, z): with the masses live it is where the car actually is. */
function centroid(car: DeformableCar): { x: number; z: number } {
  let x = 0;
  let z = 0;
  let m = 0;
  for (const p of car.deform.masses) {
    x += p.world.x * p.mass;
    z += p.world.z * p.mass;
    m += p.mass;
  }
  return { x: x / m, z: z / m };
}

/**
 * Crush knobs a derby runs at. `rear` is chassisRear's maxCrush; `realism` arms each car's class kill
 * travel and wreck energy as the engine's derby does (`armKill(…, "derby")`), null keeps the deformer's sourced 0.15 m.
 */
type Knobs = { squash: number; rear: number; realism: number | null };
/** Main's knobs before the crush calibration. */
const ARCADE: Knobs = { squash: 0.4, rear: 0.45, realism: null };
/** CrushCalibration's realistic defaults (lane/calib-defaults) at Handling's default realism. */
const REALISTIC: Knobs = { squash: 0.32, rear: 0.38, realism: DEFAULT_REALISM };

/** Builds and runs cars with chassisRear's maxCrush at `knobs.rear` (cages copy their spec at construction). */
function atKnobs(knobs: Knobs, build: () => DeformableCar[], seconds: number, start?: number): DerbyRun {
  const rear = CAGES.find((c) => c.name === "chassisRear")!;
  const rest = rear.maxCrush;
  rear.maxCrush = knobs.rear;
  try {
    return runDerby(build(), seconds, knobs, start);
  } finally {
    rear.maxCrush = rest;
  }
}

/** Six AI cars in the bowl, laid out from `seed`. */
function sixCarDerby(seconds: number, seed = 7, knobs = ARCADE): DerbyRun {
  return atKnobs(knobs, () => {
    const scene = new THREE.Scene();
    const cars = Array.from({ length: 6 }, (_, i) => new DeformableCar({ body: 0xc5c8ce, accent: 0x9aa0a8, name: `c${i}` }, scene));
    const rng = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const slots = layoutDerby(cars.length, DERBY_RADIUS, rng);
    for (const [i, c] of cars.entries()) c.spawnFacing(slots[i]!.x, slots[i]!.z, slots[i]!.yaw, 0);
    return cars;
  }, seconds);
}

/** The owner's 9-car derby capture (main 75deb20, fleet styles, 12 m/s): x, z, yaw. Its wrecks zipped along the rim. */
const OWNER_DERBY: readonly (readonly [number, number, number])[] = [
  [9.5, -5.931, 3.6997],
  [3.465, -10.65, 4.3979],
  [-4.192, -10.386, 5.096],
  [-9.887, -5.262, 5.7941],
  [-10.956, 2.325, 6.4923],
  [-6.899, 8.823, 7.1904],
  [0.387, 11.193, 7.8885],
  [7.491, 8.326, 8.5866],
  [11.09, 1.563, 9.2848],
];

/** A capture of moving cars, so its match starts at green (no start lights). */
function ownerDerby(seconds: number, knobs = ARCADE, spawnMps = OWNER_SPAWN_MPS): DerbyRun {
  return atKnobs(knobs, () => {
    const scene = new THREE.Scene();
    return OWNER_DERBY.map(([x, z, yaw], i) => {
      const c = new DeformableCar({ body: 0xffffff, accent: 0x444444, name: `o${i}` }, scene, null, fleetStyle(i));
      c.spawnFacing(x, z, yaw, spawnMps);
      return c;
    });
  }, seconds, 0);
}

/** The capture's spawn speed (m/s) and the 15 speeds 0.05 m/s apart centred on it, around which wreck pops are looked for. */
const OWNER_SPAWN_MPS = 12;
const SPAWN_SPEEDS = Array.from({ length: 15 }, (_, i) => OWNER_SPAWN_MPS + (i - 7) * 0.05);

/**
 * AI cars in the bowl in the engine's contact order, until `seconds` after the green light or the match ends. A
 * zip is a slice where a live wreck's mass centroid moves more than 3× its speed allows (+5 cm); the slice its
 * masses go live is skipped (the group origin sits 0.23 m behind the mass centroid). `start`: seconds of start
 * lights (default the match's).
 */
function runDerby(cars: DeformableCar[], seconds: number, knobs: Knobs, start?: number): DerbyRun {
    const n = cars.length;
    const names = cars.map((c) => c.paint.name);
    const match = new DerbyMatch();
    match.begin(cars.map((_, i) => ({ id: i, name: names[i]! })), { start });
    const w = newWorld(cars);
    w.afterCar = (c) => clipDerbyCar(c, derbyRadius(n));
    for (const c of cars) {
      c.deform.squash = knobs.squash;
      c.deform.buckle = 0.45;
      c.deform.setMode("shape");
      if (knobs.realism !== null) armKill(c.deform, carClass(c), knobs.realism, "derby");
    }
    const wedged = new Array<number>(n).fill(0);
    let worstWedge = 0;
    let hits = 0;
    let noseToNose = 0;
    let t = match.time;
    let state = "running";
    const deaths: number[] = [];
    const zips: string[] = [];
    const pops: string[] = [];
    while (t < seconds && state === "running") {
      const before = cars.map((c) => (c.deform.massActive ? centroid(c) : null));
      const group0 = cars.map((c) => (c.crashed && c.deform.massActive ? { x: c.group.position.x, z: c.group.position.z } : null));
      const speed0 = cars.map((c) => Math.hypot(c.velocity.x, c.velocity.z));
      const shove = new Array<number>(n).fill(0);
      let vmax = 8;
      for (const c of cars) vmax = Math.max(vmax, c.speed);
      const h = physicsSlice(1 / 60, vmax);
      const snaps = match.snapshots(n);
      for (const [i, c] of cars.entries()) snapshotAiCar(snaps[i]!, i, c, c.deform.drivetrainAlive);
      for (const [i, c] of cars.entries()) applyDrive(c, match.think(snaps[i]!, snaps, h), h);
      w.pairHit = (a, b, pair) => {
        const ca = cars[a]!;
        const cb = cars[b]!;
        // The hull push shoves a car out of a rammer's way at up to the rammer's speed.
        shove[a] = Math.max(shove[a]!, speed0[b]!);
        shove[b] = Math.max(shove[b]!, speed0[a]!);
        const aInto = -(ca.velocity.x * pair.normal.x + ca.velocity.z * pair.normal.z);
        const bInto = cb.velocity.x * pair.normal.x + cb.velocity.z * pair.normal.z;
        if (!match.noteHit(a, b, aInto, bInto, pair.impulse)) return;
        hits++;
        if (face(ca, pair.contact) === "front" && face(cb, pair.contact) === "front") noseToNose++;
      };
      stepWorld(w, h);
      for (const c of cars) if (c.deform.massActive && !c.deform.drivetrainAlive) c.deform.cutDrive(h);
      state = match.step(h, cars.map((c, i) => ({ id: i, name: names[i]!, alive: c.deform.drivetrainAlive, x: c.group.position.x, z: c.group.position.z })));
      const dead = cars.filter((c) => !c.deform.drivetrainAlive).length;
      while (deaths.length < dead) deaths.push(t);
      for (const [i, c] of cars.entries()) {
        const stuck = c.deform.drivetrainAlive && Math.abs(c.drive.throttle) > 0.3 && Math.hypot(c.velocity.x, c.velocity.z) < 1;
        wedged[i] = stuck ? wedged[i]! + h : 0;
        worstWedge = Math.max(worstWedge, wedged[i]!);
      }
      for (const [i, c] of cars.entries()) {
        const a = before[i];
        if (!a || !c.deform.massActive) continue;
        const b = centroid(c);
        const moved = Math.hypot(b.x - a.x, b.z - a.z);
        const v = Math.max(speed0[i]!, Math.hypot(c.velocity.x, c.velocity.z), shove[i]!);
        if (moved > 3 * v * h + 0.05) zips.push(`t=${t.toFixed(2)} ${names[i]} moved ${moved.toFixed(2)} m in ${(h * 1000).toFixed(1)} ms at ${v.toFixed(1)} m/s`);
        const g = group0[i];
        const jump = g ? Math.hypot(c.group.position.x - g.x, c.group.position.z - g.z) : 0;
        if (g && jump > 3 * v * h + 0.02) pops.push(`t=${t.toFixed(2)} ${names[i]} group ${jump.toFixed(3)} m in ${(h * 1000).toFixed(1)} ms at ${v.toFixed(1)} m/s quiet ${c.deform.quietTime().toFixed(2)}`);
      }
      t += h;
    }
    return { hits, noseToNose, worstWedge, t, state, deaths, zips, pops };
}

describe("given derby matches between AI cars", () => {
  const owner = ownerDerby(15);
  const ownerReal = ownerDerby(15, REALISTIC);

  describe("given six AI cars in the bowl at the arcade crush knobs", () => {
    it("when 20 s of derby are played, then the cars keep hitting (at least 20 scored hits), under a quarter of the hits are nose to nose and nobody sits wedged on the throttle for 3 s", () => {
      const { hits, noseToNose, worstWedge } = sixCarDerby(20);
      assert.ok(hits >= 20, `only ${hits} scored hits in 20 s`);
      assert.ok(noseToNose / hits < 0.25, `${noseToNose}/${hits} hits were nose to nose`);
      assert.ok(worstWedge < 3, `a car sat on the throttle without moving for ${worstWedge.toFixed(2)} s`);
    });
  });

  // Lane crash-realism-6 replaced the ≥ 3/4-seed elimination test at squash 0.4 with the sourced 0.15 m
  // kill by the realistic defaults with the slider's class kill travel (0.45 m for a sedan at realism
  // 0.25): deaths come from accumulated wrecking (DESIGN_PILLARS), never from the first meeting.
  const realRuns = [7, 11, 13, 17, 19].map((seed) => ({ seed, run: sixCarDerby(STALEMATE, seed, REALISTIC) }));
  const realRows = realRuns.map(({ seed, run }) => `seed ${seed}: deaths [${run.deaths.map((d) => d.toFixed(1)).join(",")}]`).join("; ");

  describe("given five six-car matches (seeds 7, 11, 13, 17 and 19) at the realistic defaults", () => {
    // Main 7be2ad2: 3 deaths over the 5 seeds (seeds 7, 17, 19 none): rearmHit dropped every car-car hit
    // under 6 m/s EBS (43 km/h closing), so most rams added nothing. Now ≥ 13, the first at 21.5 s.
    it("when the matches run to the stalemate, then accumulated wrecking kills at least 10 cars in all, none before 8 s", () => {
      const deaths = realRuns.flatMap(({ run }) => run.deaths);
      assert.ok(deaths.length >= 10, `${deaths.length} deaths: ${realRows}`);
      assert.ok(Math.min(...deaths) > 8, `a car died before accumulated wrecking could kill it — ${realRows}`);
    });
  });

  // Target (Main): most matches end by physics elimination (5 of 6 dead) inside the 90 s stalemate.
  // At the race/fleet kill travel (0.45 m for a sedan at realism 0.25) physics alone reached 0/5: a sedan
  // needs Σ EBS² ≈ 600 m²/s² on its nose (≈ 20 rams at 40 km/h closing). A derby car's kill travel is
  // DERBY_KILL_SCALE (0.7935) of it plus a DERBY_WRECK_ENERGY (250) wear share, so accumulated wrecking ends the match.
  // A match is chaotic: the 6th digit of one wreck's vertical speed moves a slice's width and the heat decoheres (the
  // old "≥ 4 of 5 on seeds 7/11/13/17/19" flipped between 3 and 5 wins under any such change). Seeds 1–20 measure
  // the rate: main 765d53e 14/20, the airborne lane 13/20 (70 %, 65 %). ≥ 10/20 clears that by 3 and a half-rate
  // match (5/20, or none) fails: P(X ≥ 10) is under 3 % at 65 %.
  const rateRuns = Array.from({ length: 20 }, (_, i) => sixCarDerby(STALEMATE, i + 1, REALISTIC));
  describe("given twenty six-car matches (seeds 1 to 20) at the realistic defaults", () => {
    it("when the matches run to the 90 s stalemate, then at least 10 of the 20 end by elimination (5 of 6 cars dead) inside it", () => {
      const wins = rateRuns.filter((run) => run.deaths.length >= 5 && run.deaths[4]! <= STALEMATE).length;
      assert.ok(wins >= 10, `${wins}/20 elimination wins`);
    });
  });

  describe("given the owner's 9-car derby run for 15 s", () => {
    it("when settled wrecks are hit again in the 9-car derby, at crush squash 0.4 and rear 0.45 and again at the realistic 0.32 and 0.38, then no wreck ever moves faster than its own parts allow (it never jumps)", () => {
      assert.equal(owner.zips.length, 0, `0.4/0.45: ${owner.zips.length} zips: ${owner.zips.slice(0, 4).join("; ")}`);
      assert.equal(ownerReal.zips.length, 0, `0.32/0.38: ${ownerReal.zips.length} zips: ${ownerReal.zips.slice(0, 4).join("; ")}`);
    });

    // Was 19 pops in 15 s (0.10–0.24 m): the first contact on a planted wreck re-anchored the group on
    // the cell's rest inside one dt = 0 syncPose. Open: a wreck re-touched while its frame's lean eases is moved by the crush-mass path's
    // position corrections (`clampLocal`, `stepStructure`): 0.033 m in 8.8 ms at 0.4 m/s on the owner's capture, 0.051 m on spawn 12.15
    // with the planted hubs' frame charge. The wreck split goes in Stage 4 (a wreck is a rigid body on the one solve, no position
    // corrections); that stage turns this back on as it stands.
    // Same family in the browser derby (10 cars, 20 s, every step of every car against 3·v·h + 2 cm, the smoke scan): a wreck at 0.04-1 m/s
    // with no pair hit and no car within 3.3 m moves its masses 2-5.6 cm a step for 1-7 steps (seed 1: 4.3, 4.7, 4.9 cm at t = 7.83 s,
    // mass velocity 0.17-0.52 m/s; seed 2: 5.6 cm at 11.75 s): seeds 1/2/3/default give 3/4/1/7 events, max 4.9/5.6/2.1/2.7 cm on the lane
    // against 0/0/1/6, max 0/0/5.0/5.4 cm on da39401. Closes with the above.
    it(`when a car crashes, then its body never moves more than 3 times its speed times the slice length plus 2 cm in one slice, from each of ${SPAWN_SPEEDS.length} spawn speeds nudged around the capture's`, { todo: "wreck position corrections (clampLocal, stepStructure) pop a re-touched planted wreck: closes in Stage 4 with the wreck split" }, () => {
      for (const mps of SPAWN_SPEEDS) {
        const run = ownerDerby(15, ARCADE, mps);
        assert.equal(run.pops.length, 0, `spawn ${mps.toFixed(2)} m/s: ${run.pops.length} pops: ${run.pops.slice(0, 4).join("; ")}`);
      }
    });
  });
});
