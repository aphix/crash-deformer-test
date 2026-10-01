import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DerbyBrain, blankAiCar, personality, type AiCar } from "./derby-ai.ts";
import { DerbyMatch, HIT_POINTS, DISABLE_POINTS, HIT_DEBOUNCE, STALEMATE, snapshotAiCar } from "./derby.ts";
import { clipToDerbyBowl, DERBY_RADIUS, makeDerbyArena } from "./derby-arena.ts";
import { idleDrive, applyDrive, type DriveInput } from "./car-drive.ts";
import { fleetStyle, layoutDerby, MAX_CARS } from "./fleet.ts";
import { DeformableCar } from "./car.ts";
import { CAR_HALF } from "./car-mesh.ts";
import { physicsSlice } from "./sat.ts";
import { stepCarPair, resolveCarPair } from "./pair-contact.ts";

function car(id: number, extra: Partial<AiCar> = {}): AiCar {
  return { ...blankAiCar(id), vz: 8, ...extra };
}

/** One decision with the opening hold already behind us (first call ages the car 2 s). */
function decide(brain: DerbyBrain, self: AiCar, others: AiCar[], dt = 2): DriveInput {
  return { ...brain.think(self, others, dt) };
}

describe("derby AI", () => {
  it("good: a brawler with the better nose takes the head-on; equal noses swing for the flank", () => {
    assert.ok(personality(2).aggression > 0.45);
    const me = car(2, { z: -8 });
    const flat = car(1, { z: 8, yaw: Math.PI, vz: -8, front: 0.8, damage: 0.8 });
    const straight = decide(new DerbyBrain(), me, [me, flat]);
    assert.ok(straight.throttle > 0.5, `wanted a charge, got ${straight.throttle}`);
    assert.ok(Math.abs(straight.steer) < 0.15, `head-on should be straight, steer ${straight.steer}`);
    const mint = car(1, { z: 8, yaw: Math.PI, vz: -8 });
    const wide = decide(new DerbyBrain(), me, [me, mint]);
    assert.ok(Math.abs(wide.steer) > 0.3, `equal noses should swing wide, steer ${wide.steer}`);
  });

  it("good: a spent nose backs in tail-first; the same car mint drives at it", () => {
    const foe = car(1, { z: 5 });
    const spent = car(0, { front: 0.7, damage: 0.7 });
    assert.ok(decide(new DerbyBrain(), spent, [spent, foe]).throttle < 0, "front-damaged car donated its block");
    const mint = car(0);
    assert.ok(decide(new DerbyBrain(), mint, [mint, foe]).throttle > 0, "mint car reversed for no reason");
  });

  it("good: near the wall we turn off it, not into the concrete", () => {
    const me = car(3, { x: 0, z: DERBY_RADIUS - 1.2 });
    const foe = car(1, { x: 4, z: 0 });
    const input = decide(new DerbyBrain(), me, [me, foe]);
    assert.ok(Math.abs(input.steer) > 0.5 || input.throttle < 0, `steer ${input.steer} throttle ${input.throttle}`);
  });

  it("good: leads a crossing target instead of aiming where it was", () => {
    const me = car(3, { z: -10 });
    const parked = car(1, { yaw: Math.PI / 2, vz: 0 });
    const crossing = car(1, { yaw: Math.PI / 2, vx: 8, vz: 0 });
    const atParked = decide(new DerbyBrain(), me, [me, parked]);
    const atCrossing = decide(new DerbyBrain(), me, [me, crossing]);
    assert.ok(
      atCrossing.steer > atParked.steer + 0.3,
      `no lead: steer ${atCrossing.steer.toFixed(2)} vs parked ${atParked.steer.toFixed(2)}`,
    );
  });

  it("good: a second hunter takes the other victim instead of dogpiling the nearest", () => {
    // Two parked victims side by side, same exposure to both hunters; A is a hair closer.
    const a = car(4, { x: -2.8, vz: 0 });
    const b = car(5, { x: 3, vz: 0 });
    const south = car(2, { z: -10 });
    const north = car(3, { z: 10, yaw: Math.PI, vz: -8 });
    const all = [south, north, a, b];
    const alone = new DerbyBrain();
    decide(alone, north, all);
    assert.equal(alone.huntersOf(4), 1, "the lone hunter should take the nearer victim");
    const pair = new DerbyBrain();
    decide(pair, south, all);
    decide(pair, north, all);
    assert.deepEqual([pair.huntersOf(4), pair.huntersOf(5)], [1, 1]);
  });

  it("good: throttle with no motion backs out, and a second wedge tries the other gear", () => {
    const brain = new DerbyBrain();
    const me = car(3, { z: -3, vz: 0 });
    const foe = car(1, { z: 3, yaw: Math.PI / 2, vz: 0 });
    const others = [me, foe];
    assert.ok(decide(brain, me, others).throttle > 0);
    let backed = 0;
    for (let k = 0; k < 15 && backed === 0; k++) {
      const input = decide(brain, me, others, 0.1);
      if (brain.recovering(3)) backed = input.throttle;
    }
    assert.ok(backed < 0, "never backed out of a dead push");
    let escape = 0;
    for (let k = 0; k < 40 && escape <= 0; k++) {
      const input = decide(brain, me, others, 0.1);
      if (brain.recovering(3)) escape = input.throttle;
    }
    assert.ok(escape > 0, "kept reversing into the same blocked side");
  });

  it("good: drivers differ by id but are the same driver every match", () => {
    assert.deepEqual(personality(7), personality(7));
    const field = Array.from({ length: 10 }, (_, i) => personality(i));
    assert.ok(new Set(field.map((p) => p.side)).size === 2, "everyone flanks the same way");
    assert.ok(field.some((p) => p.hold === 0) && field.some((p) => p.hold > 0.3), "whole field launches in lockstep");
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

describe("ai snapshot", () => {
  it("good: a mint car reads 0, a dead drivetrain reads 1", () => {
    const c = new DeformableCar({ body: 0xc5c8ce, accent: 0x9aa0a8, name: "Titanium" }, new THREE.Scene());
    const s = snapshotAiCar(blankAiCar(0), 0, 0, 0, 0, 0, 0, true, c.deform.masses);
    assert.ok(s.front < 0.02 && s.rear < 0.02 && s.damage < 0.02, `mint read ${s.front}/${s.rear}/${s.damage}`);
    assert.equal(snapshotAiCar(blankAiCar(0), 0, 0, 0, 0, 0, 0, false, c.deform.masses).damage, 1);
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
    const match = new DerbyMatch();
    match.begin([
      { id: 0, name: "Titanium" },
      { id: 1, name: "Petrol" },
    ]);
    let t = 0;
    let minD = Infinity;
    while (t < 5.05) {
      const h = physicsSlice(1 / 60, Math.max(a.speed, b.speed, 4));
      const snaps = match.snapshots(2);
      [a, b].forEach((c, i) =>
        snapshotAiCar(snaps[i]!, i, c.group.position.x, c.group.position.z, c.yaw, c.velocity.x, c.velocity.z, c.deform.drivetrainAlive, c.deform.masses),
      );
      applyDrive(a, match.think(snaps[0]!, snaps, h), h);
      applyDrive(b, match.think(snaps[1]!, snaps, h), h);
      stepCarPair(a, b, h);
      for (const car of [a, b]) clipDerbyCar(car);
      match.step(h, [
        { id: 0, name: "Titanium", alive: a.deform.drivetrainAlive },
        { id: 1, name: "Petrol", alive: b.deform.drivetrainAlive },
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

function clipDerbyCar(car: DeformableCar): void {
  const p = car.group.position;
  const v = car.velocity;
  const next = clipToDerbyBowl(p.x, p.z, v.x, v.z, 2.15);
  if (!next.hit) return;
  if (car.deform.massActive) car.deform.translateMasses(next.x - p.x, next.z - p.z, next.vx - v.x, next.vz - v.z);
  p.set(next.x, p.y, next.z);
  v.set(next.vx, v.y, next.vz);
}

/** Which face of `car` the world point sits on. */
function face(car: DeformableCar, p: THREE.Vector3): "front" | "rear" | "side" {
  const dx = p.x - car.group.position.x;
  const dz = p.z - car.group.position.z;
  const along = (dx * car.fwdFlat.x + dz * car.fwdFlat.z) / CAR_HALF.z;
  const across = (dx * car.fwdFlat.z - dz * car.fwdFlat.x) / CAR_HALF.x;
  if (Math.abs(along) * 1.15 < Math.abs(across)) return "side";
  return along > 0 ? "front" : "rear";
}

type DerbyRun = { hits: number; noseToNose: number; worstWedge: number; t: number; state: string; deaths: number[]; zips: string[] };

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

/** Six AI cars in the bowl (seed 7). */
function sixCarDerby(seconds: number): DerbyRun {
  const n = 6;
  const scene = new THREE.Scene();
  const cars = Array.from({ length: n }, (_, i) => new DeformableCar({ body: 0xc5c8ce, accent: 0x9aa0a8, name: `c${i}` }, scene));
  let seed = 7;
  const rng = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const slots = layoutDerby(n, DERBY_RADIUS, 12, rng);
  cars.forEach((c, i) => c.spawnFacing(slots[i]!.x, slots[i]!.z, slots[i]!.yaw, slots[i]!.speed));
  return runDerby(cars, seconds);
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

function ownerDerby(seconds: number): DerbyRun {
  const scene = new THREE.Scene();
  const cars = OWNER_DERBY.map(([x, z, yaw], i) => {
    const c = new DeformableCar({ body: 0xffffff, accent: 0x444444, name: `o${i}` }, scene, null, fleetStyle(i));
    c.spawnFacing(x, z, yaw, 12);
    return c;
  });
  return runDerby(cars, seconds);
}

/**
 * AI cars in the bowl in the engine's contact order, until `seconds` or the match ends. A zip is a
 * slice where a live wreck's mass centroid moves more than 3× its speed allows (+5 cm); the slice its
 * masses go live is skipped (the group origin sits 0.23 m behind the mass centroid).
 */
function runDerby(cars: DeformableCar[], seconds: number): DerbyRun {
    const n = cars.length;
    const names = cars.map((c) => c.paint.name);
    const match = new DerbyMatch();
    match.begin(cars.map((_, i) => ({ id: i, name: names[i]! })));
    for (const c of cars) {
      c.deform.squash = 0.4;
      c.deform.buckle = 0.45;
      c.deform.setMode("shape");
    }
    const wedged = new Array<number>(n).fill(0);
    let worstWedge = 0;
    let hits = 0;
    let noseToNose = 0;
    let t = 0;
    let state = "running";
    const deaths: number[] = [];
    const zips: string[] = [];
    while (t < seconds && state === "running") {
      const before = cars.map((c) => (c.deform.massActive ? centroid(c) : null));
      const speed0 = cars.map((c) => Math.hypot(c.velocity.x, c.velocity.z));
      const shove = new Array<number>(n).fill(0);
      let vmax = 8;
      for (const c of cars) vmax = Math.max(vmax, c.speed);
      const h = physicsSlice(1 / 60, vmax);
      const snaps = match.snapshots(n);
      cars.forEach((c, i) =>
        snapshotAiCar(snaps[i]!, i, c.group.position.x, c.group.position.z, c.yaw, c.velocity.x, c.velocity.z, c.deform.drivetrainAlive, c.deform.masses),
      );
      cars.forEach((c, i) => applyDrive(c, match.think(snaps[i]!, snaps, h), h));
      for (const c of cars) {
        if (c.deform.massActive) c.syncPose(h);
        else c.integrate(h);
      }
      for (let a = 0; a < n; a++) {
        for (let b = a + 1; b < n; b++) {
          const ca = cars[a]!;
          const cb = cars[b]!;
          if (ca.group.position.distanceToSquared(cb.group.position) > 28) continue;
          if (ca.deform.massActive || cb.deform.massActive) ca.deform.collideWith(cb.deform, h);
        }
      }
      for (let k = 0; k < 3; k++) {
        for (const c of cars) {
          if (c.deform.massActive) c.syncPose(0);
          else c.refreshBasis();
        }
        let moved = false;
        for (let a = 0; a < n; a++) {
          for (let b = a + 1; b < n; b++) {
            const ca = cars[a]!;
            const cb = cars[b]!;
            const pair = resolveCarPair(ca, cb, k === 0, h);
            if (!pair) continue;
            moved = true;
            // The hull push shoves a car out of a rammer's way at up to the rammer's speed.
            shove[a] = Math.max(shove[a]!, speed0[b]!);
            shove[b] = Math.max(shove[b]!, speed0[a]!);
            const aInto = -(ca.velocity.x * pair.normal.x + ca.velocity.z * pair.normal.z);
            const bInto = cb.velocity.x * pair.normal.x + cb.velocity.z * pair.normal.z;
            if (!match.noteHit(a, b, aInto, bInto, pair.impulse)) continue;
            hits++;
            if (face(ca, pair.contact) === "front" && face(cb, pair.contact) === "front") noseToNose++;
          }
        }
        if (!moved) break;
      }
      for (const c of cars) {
        if (c.deform.massActive) {
          c.deform.stepStructure(h);
          c.syncPose(h);
          if (!c.deform.drivetrainAlive) c.deform.cutDrive(h);
        }
        c.afterContacts(h);
        clipDerbyCar(c);
      }
      state = match.step(h, cars.map((c, i) => ({ id: i, name: names[i]!, alive: c.deform.drivetrainAlive })));
      const dead = cars.filter((c) => !c.deform.drivetrainAlive).length;
      while (deaths.length < dead) deaths.push(t);
      cars.forEach((c, i) => {
        const stuck = c.deform.drivetrainAlive && Math.abs(c.drive.throttle) > 0.3 && Math.hypot(c.velocity.x, c.velocity.z) < 1;
        wedged[i] = stuck ? wedged[i]! + h : 0;
        worstWedge = Math.max(worstWedge, wedged[i]!);
      });
      cars.forEach((c, i) => {
        const a = before[i];
        if (!a || !c.deform.massActive) return;
        const b = centroid(c);
        const moved = Math.hypot(b.x - a.x, b.z - a.z);
        const v = Math.max(speed0[i]!, Math.hypot(c.velocity.x, c.velocity.z), shove[i]!);
        if (moved > 3 * v * h + 0.05) zips.push(`t=${t.toFixed(2)} ${names[i]} moved ${moved.toFixed(2)} m in ${(h * 1000).toFixed(1)} ms at ${v.toFixed(1)} m/s`);
      });
      t += h;
    }
    return { hits, noseToNose, worstWedge, t, state, deaths, zips };
}

describe("derby match, six AI cars", () => {
  it("good: 20 s of derby — cars keep hitting, mostly not nose to nose, and nobody sits wedged", () => {
    const { hits, noseToNose, worstWedge } = sixCarDerby(20);
    assert.ok(hits >= 20, `only ${hits} scored hits in 20 s`);
    assert.ok(noseToNose / hits < 0.25, `${noseToNose}/${hits} hits were nose to nose`);
    assert.ok(worstWedge < 3, `a car sat on the throttle without moving for ${worstWedge.toFixed(2)} s`);
  });

  it("bad: repeated hard hits disable cars and the match ends by elimination before the 90 s stalemate", () => {
    const run = sixCarDerby(STALEMATE);
    const at = run.deaths.map((d) => d.toFixed(1)).join(",");
    assert.ok(run.state === "winner" && run.t < STALEMATE - 1, `no elimination win: ${run.state} at ${run.t.toFixed(1)} s, deaths [${at}]`);
    assert.equal(run.deaths.length, 5, `deaths [${at}]`);
    assert.ok(run.deaths[0]! > 2, `first car died at ${run.deaths[0]!.toFixed(1)} s, before the field had met`);
  });

  it("bad: a re-armed wreck never outruns its own masses — owner's 9-car derby, 15 s", () => {
    const { zips } = ownerDerby(15);
    assert.equal(zips.length, 0, `${zips.length} zips: ${zips.slice(0, 4).join("; ")}`);
  });
});
