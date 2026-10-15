import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DerbyBrain, blankAiCar } from "../ai/derby-ai.ts";
import { personality } from "../ai/personality.ts";
import { DerbyMatch, HIT_POINTS, DISABLE_POINTS, SCORE_GAP, snapshotAiCar } from "./derby.ts";
import { DERBY_RADIUS } from "../scenes/derby-arena.ts";
import { arenaWorld, leaveArena } from "../scenes/derby-arena.test-util.ts";
import { DERBY_BOXES, DERBY_FREE_PROPS, DERBY_PROP } from "../scenes/derby-ground.ts";
import { idleDrive, applyDrive } from "../vehicle/car-drive.ts";
import { layoutDerby, MAX_CARS } from "../scenes/fleet.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { physicsSlice } from "../contact/sat.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";
import { aiCar, assertSameDigest, decide } from "../vehicle/test-support.ts";
import { FRAME_HZ } from "../kernel/constants.ts";

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

const ARENA_APPROACH_ANGLE = -Math.PI / 8;
const APPROACH_START_FROM_WALL = 12;
const APPROACH_SPEED = 25;
const FIRST_HIT_SECONDS = 1;
const RUN_ON_SECONDS = 3;
const WALL_CAGE_REACH = 1;
const OUTWARD_SPEED_LEFT = 2;

describe("given a derby car driven at the arena wall at 25 m/s from 12 m out (the sedan)", () => {
  afterEach(leaveArena);
  it("when it has hit it and run on 3 s, then it stays inside the wall (cage reach: car centre hypot < DERBY_RADIUS - 1) and it has lost its outward speed", () => {
    const car = new DeformableCar({ body: 0xc5c8ce, accent: 0x9aa0a8, name: "Titanium" }, new THREE.Scene());
    car.deform.setMode("shape");
    const outward = { x: Math.sin(ARENA_APPROACH_ANGLE), z: Math.cos(ARENA_APPROACH_ANGLE) };
    const startRadius = DERBY_RADIUS - APPROACH_START_FROM_WALL;
    car.spawnFacing(outward.x * startRadius, outward.z * startRadius, ARENA_APPROACH_ANGLE, APPROACH_SPEED);
    const { world } = arenaWorld([car]);
    let elapsed = 0;
    while (elapsed < FIRST_HIT_SECONDS + RUN_ON_SECONDS) {
      const slice = physicsSlice(1 / FRAME_HZ, Math.max(car.speed, 4));
      applyDrive(car, { ...idleDrive(), throttle: 1 }, slice);
      stepWorld(world, slice);
      elapsed += slice;
    }
    const reach = Math.hypot(car.group.position.x, car.group.position.z);
    assert.ok(reach < DERBY_RADIUS - WALL_CAGE_REACH, `car centre ${reach.toFixed(2)} m out`);
    const outwardSpeed = car.velocity.x * outward.x + car.velocity.z * outward.z;
    assert.ok(outwardSpeed < OUTWARD_SPEED_LEFT, `still ${outwardSpeed.toFixed(2)} m/s outward`);
  });
});

describe("given the wall's boxes (DERBY_BOXES kind DERBY_PROP.wall)", () => {
  it("when each box's long axis is compared with the ring's radial direction, then each lies along the ring (tangent), not radial, its inner face is on DERBY_RADIUS, and there are at least 16 boxes", () => {
    const walls = DERBY_BOXES.filter((box) => box.kind === DERBY_PROP.wall);
    for (const wall of walls) {
      const centreRadius = Math.hypot(wall.x, wall.z);
      const dot = Math.abs((Math.sin(wall.yaw) * wall.x + Math.cos(wall.yaw) * wall.z) / centreRadius);
      assert.ok(dot < 0.25, `wall box long-axis is radial, dot=${dot.toFixed(2)}`);
      assert.ok(Math.abs(centreRadius - wall.hx - DERBY_RADIUS) < 0.01, `wall box inner face off the ring, r=${(centreRadius - wall.hx).toFixed(2)}`);
    }
    assert.ok(walls.length >= 16);
  });
});

describe("given six derby cars laid out in the bowl", () => {
  it("when their start slots are laid out, then all six sit on a ring inside the bowl, within the car limit, each facing its centre", () => {
    const slots = layoutDerby(6, DERBY_RADIUS, () => 0.5, DERBY_FREE_PROPS);
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
      const h = physicsSlice(1 / FRAME_HZ, Math.max(a.speed, b.speed, 4));
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
  afterEach(leaveArena);
  it("when the AI drives both cars for 5 s after the green light, then both engines still run, the cars are still moving and they met (closest approach under 6.5 m), not parked nose to nose", () => {
    const scene = new THREE.Scene();
    const a = new DeformableCar({ body: 0xc5c8ce, accent: 0x9aa0a8, name: "Titanium" }, scene);
    const b = new DeformableCar({ body: 0x3d8a86, accent: 0x2a6360, name: "Petrol" }, scene);
    let seed = 7;
    const slots = layoutDerby(2, DERBY_RADIUS, () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646, DERBY_FREE_PROPS);
    for (const [i, c] of [a, b].entries()) {
      c.deform.setMode("shape");
      c.spawnFacing(slots[i]!.x, slots[i]!.z, slots[i]!.yaw, 0);
    }
    const match = new DerbyMatch();
    match.begin([
      { id: 0, name: "Titanium" },
      { id: 1, name: "Petrol" },
    ]);
    const { world: w } = arenaWorld([a, b]);
    // Match time: negative through the start lights, 0 at green.
    let t = match.time;
    let minD = Infinity;
    while (t < 5.05) {
      const h = physicsSlice(1 / FRAME_HZ, Math.max(a.speed, b.speed, 4));
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
