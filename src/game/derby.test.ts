import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { thinkDerby, engineDamage } from "./derby-ai.ts";
import { DerbyMatch, HIT_POINTS, DISABLE_POINTS, HIT_DEBOUNCE, snapshotAiCar } from "./derby.ts";
import { clipToDerbyBowl, DERBY_RADIUS, makeDerbyArena } from "./derby-arena.ts";
import { idleDrive, applyDrive, DriverSeat } from "./car-drive.ts";
import { layoutDerby, MAX_CARS } from "./fleet.ts";
import { DeformableCar } from "./car.ts";
import { physicsSlice } from "./sat.ts";
import { stepCarPair } from "./pair-contact.ts";

function car(id: number, extra: Partial<Parameters<typeof thinkDerby>[0]> = {}) {
  return {
    id,
    x: 0,
    z: 0,
    yaw: 0,
    vx: 0,
    vz: 8,
    alive: true,
    damage: 0,
    ...extra,
  };
}

describe("derby AI", () => {
  it("good: healthier car will take a head-on", () => {
    const me = car(0, { damage: 0.1, z: -8, yaw: 0 });
    const foe = car(1, { damage: 0.8, z: 8 });
    const input = thinkDerby(me, [me, foe], { radius: DERBY_RADIUS, time: 1 });
    assert.ok(input.throttle > 0.5, `wanted chase throttle, got ${input.throttle}`);
    assert.equal(input.ebrake, false);
  });

  it("good: a more-damaged car reverses instead of donating the block", () => {
    const me = car(0, { damage: 0.7, z: 0, yaw: 0 });
    const foe = car(1, { damage: 0.1, z: 5 });
    const input = thinkDerby(me, [me, foe], { radius: DERBY_RADIUS, time: 1 });
    assert.ok(input.throttle < 0, `wanted reverse, got ${input.throttle}`);
  });

  it("good: near the wall we steer inward, not into the concrete", () => {
    const me = car(0, { x: 0, z: DERBY_RADIUS - 1.2, yaw: 0, damage: 0 });
    const foe = car(1, { x: 4, z: 0 });
    const input = thinkDerby(me, [me, foe], { radius: DERBY_RADIUS, time: 1 });
    assert.ok(input.steer !== 0 || input.throttle < 0.6);
  });
});

describe("derby scoring", () => {
  it("good: hits debounce so buckle chatter is one point", () => {
    const m = new DerbyMatch();
    m.begin([
      { id: 0, name: "Titanium" },
      { id: 1, name: "Petrol" },
    ]);
    assert.equal(m.noteHit(0, 1, 8, 2, 6), true);
    assert.equal(m.noteHit(0, 1, 8, 2, 6), false);
    m.time = HIT_DEBOUNCE + 0.05;
    assert.equal(m.noteHit(0, 1, 8, 2, 6), true);
    assert.equal(m.row(0)!.score, HIT_POINTS * 2);
    assert.equal(m.row(0)!.hits, 2);
  });

  it("good: disabling is 10 on top of the last hit, last survivor wins regardless of points", () => {
    const m = new DerbyMatch();
    m.begin([
      { id: 0, name: "Titanium" },
      { id: 1, name: "Petrol" },
    ]);
    m.noteHit(1, 0, 9, 1, 10);
    for (let i = 0; i < 6; i++) {
      m.time += HIT_DEBOUNCE + 0.05;
      m.noteHit(1, 0, 9, 1, 8);
    }
    assert.ok(m.row(1)!.score > 4);
    m.step(0.05, [
      { id: 0, name: "Titanium", alive: false },
      { id: 1, name: "Petrol", alive: true },
    ]);
    assert.equal(m.row(1)!.disables, 1);
    assert.equal(m.row(1)!.score, 7 * HIT_POINTS + DISABLE_POINTS);
    assert.equal(m.winnerId, 1);
    assert.equal(m.winnerName, "Petrol");
  });

  it("good: a dead car with more points still loses to the survivor", () => {
    const m = new DerbyMatch();
    m.begin([
      { id: 0, name: "Oxide" },
      { id: 1, name: "Ink" },
    ]);
    for (let i = 0; i < 8; i++) {
      m.time += HIT_DEBOUNCE + 0.02;
      m.noteHit(0, 1, 10, 0, 9);
    }
    m.step(0.02, [
      { id: 0, name: "Oxide", alive: false },
      { id: 1, name: "Ink", alive: true },
    ]);
    assert.equal(m.winnerId, 1);
    assert.ok(m.row(0)!.score > m.row(1)!.score);
  });
});

describe("derby arena", () => {
  it("good: outside the bowl is pushed back and loses outward speed", () => {
    const hit = clipToDerbyBowl(0, DERBY_RADIUS + 2, 0, 12);
    assert.equal(hit.hit, true);
    assert.ok(Math.hypot(hit.x, hit.z) < DERBY_RADIUS - 1);
    assert.ok(hit.vz < 12);
  });

  it("good: wall slabs lie tangent to the ring, not radial", () => {
    const arena = makeDerbyArena();
    const long = new THREE.Vector3();
    const radial = new THREE.Vector3();
    let slabs = 0;
    for (const child of arena.children) {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || mesh.geometry.type !== "BoxGeometry") continue;
      slabs++;
      long.set(0, 0, 1).applyQuaternion(mesh.quaternion);
      radial.copy(mesh.position).setY(0);
      const len = radial.length() || 1;
      const dot = Math.abs(long.dot(radial) / len);
      assert.ok(dot < 0.25, `slab long-axis is radial, dot=${dot.toFixed(2)}`);
    }
    assert.ok(slabs >= 16);
  });
});

describe("derby layout", () => {
  it("good: N cars sit on a ring, tangent, inside the bowl", () => {
    const slots = layoutDerby(6, DERBY_RADIUS, 12, () => 0.5);
    assert.equal(slots.length, 6);
    assert.ok(slots.length <= MAX_CARS);
    for (const s of slots) {
      assert.ok(Math.hypot(s.x, s.z) < DERBY_RADIUS - 3);
    }
  });
});

describe("engine damage helper", () => {
  it("good: dead drivetrain is 1, mint leftover is ~0", () => {
    assert.equal(engineDamage(false, 0), 1);
    assert.ok(engineDamage(true, 1.5) < 0.05);
  });
});

describe("drive input", () => {
  it("good: idle is zeros", () => {
    const d = idleDrive();
    assert.equal(d.throttle, 0);
    assert.equal(d.ebrake, false);
    assert.equal(d.boost, false);
  });
});

describe("driver seat", () => {
  it("good: click follows, WASD drives, esc steps back", () => {
    const s = new DriverSeat();
    s.focus(1);
    assert.equal(s.mode, "follow");
    s.poke(new Set(["KeyW", "ShiftLeft"]));
    assert.equal(s.mode, "drive");
    const input = s.input(new Set(["KeyW", "ShiftLeft"]));
    assert.equal(input.throttle, 1);
    assert.equal(input.boost, true);
    s.esc();
    assert.equal(s.mode, "follow");
    s.esc();
    assert.equal(s.mode, "global");
    assert.equal(s.carIndex, -1);
  });

  it("good: boost drains while held and refills on a takedown", () => {
    const s = new DriverSeat();
    s.focus(0);
    s.poke(new Set(["ShiftLeft"]));
    s.mode = "drive";
    s.step(0.8);
    assert.ok(s.boost < 0.6, `boost ${s.boost}`);
    s.addBoost(0.4);
    assert.ok(s.boost > 0.7);
  });

  it("good: look yaw collapses back toward the velocity heading", () => {
    const s = new DriverSeat();
    s.nudgeLook(80, 0);
    assert.ok(Math.abs(s.camYaw) > 0.2);
    s.mouseIdle = 1;
    s.step(0.5);
    const mid = Math.abs(s.camYaw);
    s.step(0.8);
    assert.ok(Math.abs(s.camYaw) < mid);
  });
});

/** 50 km/h rigid wall. Two cars at half that each see about half the delta-v. */
const FRONT_DISABLE_MPS = 50 / 3.6;

describe("derby durability and the default two-car stall", () => {
  it("good: head-on, each at half of 50 km/h, both engines still run", () => {
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
    let t = 0;
    while (t < 1.6) {
      const h = physicsSlice(1 / 60, Math.max(a.speed, b.speed, 4));
      stepCarPair(a, b, h);
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

  it("bad: default two-car derby must still be moving at 5s, not parked nose to nose", () => {
    const scene = new THREE.Scene();
    const a = new DeformableCar({ body: 0xc5c8ce, accent: 0x9aa0a8, name: "Titanium" }, scene);
    const b = new DeformableCar({ body: 0x3d8a86, accent: 0x2a6360, name: "Petrol" }, scene);
    const specs = [
      { car: a, x: -7.4485, z: -8.3642, yaw: 5.4399, vx: -8.9616, vz: 7.9806 },
      { car: b, x: 7.4485, z: 8.3642, yaw: 8.5815, vx: 8.9616, vz: -7.9806 },
    ];
    for (const s of specs) {
      s.car.deform.setMode("shape");
      s.car.deform.squash = 0.4;
      s.car.deform.buckle = 0.45;
      s.car.group.position.set(s.x, 0, s.z);
      s.car.group.rotation.set(0, s.yaw, 0, "YXZ");
      s.car.yaw = s.yaw;
      s.car.refreshBasis();
      s.car.velocity.set(s.vx, 0, s.vz);
      s.car.speed = 12;
      s.car.deform.bindKinematic(s.car.group, s.car.velocity, s.car.angular);
    }
    const world = { radius: DERBY_RADIUS, time: 0 };
    let t = 0;
    let minD = Infinity;
    while (t < 5.05) {
      const h = physicsSlice(1 / 60, Math.max(a.speed, b.speed, 4));
      world.time = t;
      const snaps = [
        snapshotAiCar(0, "Titanium", a.group.position.x, a.group.position.z, a.yaw, a.velocity.x, a.velocity.z, a.deform.drivetrainAlive, a.deform.crumpleTravel()),
        snapshotAiCar(1, "Petrol", b.group.position.x, b.group.position.z, b.yaw, b.velocity.x, b.velocity.z, b.deform.drivetrainAlive, b.deform.crumpleTravel()),
      ];
      applyDrive(a, thinkDerby(snaps[0]!, snaps, world), h);
      applyDrive(b, thinkDerby(snaps[1]!, snaps, world), h);
      stepCarPair(a, b, h);
      for (const car of [a, b]) {
        const p = car.group.position;
        const v = car.velocity;
        const next = clipToDerbyBowl(p.x, p.z, v.x, v.z, 2.15);
        if (!next.hit) continue;
        if (car.deform.massActive) car.deform.translateMasses(next.x - p.x, next.z - p.z, next.vx - v.x, next.vz - v.z);
        p.set(next.x, p.y, next.z);
        v.set(next.vx, v.y, next.vz);
      }
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
