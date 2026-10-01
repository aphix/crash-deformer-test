import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { StreamedDeformation, type DeformMode } from "./streamed-deform.ts";
import { DeformableCar } from "./car.ts";
import { leftoverCrumple, snapshotPoints } from "./physics-util.ts";
import { DT, dummyGeom, forModes, mass, paint } from "./test-support.ts";
import { makeWorld, runPair, runWall, tickWorld } from "./crash-scenarios.test-util.ts";
import { sliceSpeed } from "./sat.ts";
import { fleetStyle } from "./fleet.ts";
import { bounceGround, bounceOffCar, DebrisSystem } from "./engine-fx.ts";

type PartRow = { name: string; hingeT: number; detached: boolean };

function spawnOffset(impactX: number, speed = 14, mode: DeformMode = "lattice") {
  const geom = dummyGeom();
  const d = new StreamedDeformation(geom);
  d.mode = mode;
  d.squash = 0.4;
  d.buckle = 0.45;
  const group = new THREE.Group();
  group.updateMatrixWorld();
  const vel = new THREE.Vector3(0, 0, speed);
  const omega = new THREE.Vector3();
  d.beginCrush(new THREE.Vector3(impactX, 0.36, 2.06), new THREE.Vector3(0, 0, -1), speed, speed, group, vel, omega);
  return { d, group, vel, omega, geom };
}

function stepWall(s: ReturnType<typeof spawnOffset>, dt: number, contactX: number): void {
  s.d.notifyContact();
  const fl = mass(s.d, "bumperFL").world;
  const fr = mass(s.d, "bumperFR").world;
  const contact = new THREE.Vector3(contactX, 0.38, (fl.z + fr.z) * 0.5);
  const n = new THREE.Vector3(0, 0, -1);
  const closing = Math.max(0, -s.vel.dot(n));
  s.d.feedOverlap(contact, n, 0.1, closing, dt);
  s.d.stepStructure(dt);
  s.d.followGroup(s.group, s.vel, s.omega, dt);
  s.d.update(dt, s.geom);
}

forModes("banana lattice / corner crush", (mode) => {
  it("good: right-front wall tucks FR more in Z than FL, rear does not grow", () => {
    const s = spawnOffset(0.62, 14, mode);
    for (let i = 0; i < 24; i++) stepWall(s, DT, mass(s.d, "bumperFR").world.x);
    const flz = mass(s.d, "bumperFL").local.z;
    const frz = mass(s.d, "bumperFR").local.z;
    const rlz = mass(s.d, "bumperRL").local.z;
    assert.ok(frz < flz - 0.08, `no corner banana: FL.z=${flz.toFixed(3)} FR.z=${frz.toFixed(3)}`);
    assert.ok(rlz <= (mode === "shape" ? -1.9 : -1.95), `rear extruded to ${rlz.toFixed(3)}`);
  });

  it("good: opposite corner stays wider in X (plan-view banana)", () => {
    const s = spawnOffset(0.62, 14, mode);
    for (let i = 0; i < 22; i++) stepWall(s, DT, mass(s.d, "bumperFR").world.x);
    const r = mass(s.d, "bumperFR").local.x;
    const l = mass(s.d, "bumperFL").local.x;
    assert.ok(r > l + 0.7, `track collapsed: FL.x=${l.toFixed(3)} FR.x=${r.toFixed(3)}`);
  });

  it("bad: a left hit must not invert the banana", () => {
    const s = spawnOffset(-0.62, 14, mode);
    for (let i = 0; i < 22; i++) stepWall(s, DT, mass(s.d, "bumperFL").world.x);
    const flz = mass(s.d, "bumperFL").local.z;
    const frz = mass(s.d, "bumperFR").local.z;
    assert.ok(flz < frz - 0.06, `inverted banana L=${flz.toFixed(3)} R=${frz.toFixed(3)}`);
  });

  it("close-but-wrong: squash=0.7 crushes the hit corner more than squash=0.2", () => {
    const lo = spawnOffset(0.62, 14, mode);
    lo.d.squash = 0.2;
    const hi = spawnOffset(0.62, 14, mode);
    hi.d.squash = 0.7;
    for (let i = 0; i < 18; i++) {
      stepWall(lo, DT, mass(lo.d, "bumperFR").world.x);
      stepWall(hi, DT, mass(hi.d, "bumperFR").world.x);
    }
    const a = 2.06 - mass(lo.d, "bumperFR").local.z;
    const b = 2.06 - mass(hi.d, "bumperFR").local.z;
    assert.ok(b > a * 1.15, `squash slider dead: lo=${a.toFixed(3)} hi=${b.toFixed(3)}`);
  });
});

forModes("CoG / followGroup", (mode) => {
  it("good: after a frontal pulse the body stays on the road", () => {
    const s = spawnOffset(0, 14, mode);
    for (let i = 0; i < 20; i++) stepWall(s, DT, 0);
    assert.ok(s.group.position.y < 0.15, `lofted to y=${s.group.position.y}`);
  });

  it("good: group XZ tracks the cell, not the crushed bumper", () => {
    const s = spawnOffset(0, 14, mode);
    for (let i = 0; i < 20; i++) stepWall(s, DT, 0);
    const cell = mass(s.d, "cell");
    assert.ok(Math.abs(s.group.position.x - (cell.world.x - cell.rest.x)) < 0.35);
    assert.ok(Math.abs(s.group.position.z - (cell.world.z - cell.rest.z)) < 0.45);
  });

  it("close-but-wrong: leftover crumple drops as the nose shortens", () => {
    const s = spawnOffset(0, 14, mode);
    const z0 = mass(s.d, "bumperFL").local.z;
    for (let i = 0; i < 28; i++) stepWall(s, DT, 0);
    const z1 = mass(s.d, "bumperFL").local.z;
    assert.ok(
      z0 - z1 > (mode === "shape" ? 0.02 : 0.08) || mass(s.d, "bumperFL").local.distanceTo(mass(s.d, "bumperFL").rest) > 0.05,
      `nose never shortened ${z0} → ${z1}`,
    );
    const after = leftoverCrumple(s.d.crumpleTravel());
    assert.ok(after <= 1);
  });
});

describe("torsion / tension beams [lattice]", () => {
  it("good: a stretched beam reports positive strain and stays alive", () => {
    const s = spawnOffset(0, 14, "lattice");
    const beam = s.d.snapshot() as { beams: { a: string; b: string; rest: number }[] };
    const spec = beam.beams.find((b) => b.a === "bumperFL" && b.b === "bumperFR");
    assert.ok(spec);
    const fl = mass(s.d, "bumperFL");
    const fr = mass(s.d, "bumperFR");
    fl.world.x -= 0.4;
    fr.world.x += 0.4;
    s.d.stepStructure(DT);
    const snap = s.d.snapshot() as { beams: { a: string; b: string; strain: number; alive: boolean }[] };
    const b = snap.beams.find((x) => x.a === "bumperFL" && x.b === "bumperFR")!;
    assert.ok(b.alive);
    assert.ok(b.strain > 0.05, `tension strain ${b.strain}`);
  });

  it("good: a compressed front beam reports negative strain", () => {
    const s = spawnOffset(0, 14, "lattice");
    for (let i = 0; i < 16; i++) stepWall(s, DT, 0);
    const snap = s.d.snapshot() as { beams: { a: string; b: string; strain: number }[] };
    const b = snap.beams.find((x) => x.a === "engineL" && x.b === "cell")!;
    assert.ok(b.strain < -0.02, `expected compression, got ${b.strain}`);
  });

  it("bad: far-side bumper beam must not go plastic on a right-front hit", () => {
    const s = spawnOffset(0.62, 14, "lattice");
    for (let i = 0; i < 16; i++) stepWall(s, DT, mass(s.d, "bumperFR").world.x);
    const snap = s.d.snapshot() as { beams: { a: string; b: string; plastic: number; rest: number }[] };
    const b = snap.beams.find((x) => x.a === "bumperRL" && x.b === "bumperRR")!;
    assert.ok(b.plastic > b.rest * 0.92, `rear beam plastic-shrunk to ${b.plastic}`);
  });
});

forModes("doors hinge then detach", (mode) => {
  /** The engine's right-door hit (28 m/s closing) held for 45 frames; returns the parts by name. */
  const rightSideHit = (): Record<string, PartRow> => {
    const scene = new THREE.Scene();
    const car = new DeformableCar(paint(), scene);
    car.deform.setMode(mode);
    car.spawn(8, 12, 12);
    car.group.updateMatrixWorld();
    const hit = car.group.position.clone().addScaledVector(car.right, 0.9);
    hit.y = 0.5;
    const inward = car.right.clone().negate();
    car.applyImpact(hit, inward, 28, 28);
    for (let i = 0; i < 45; i++) {
      car.deform.notifyContact();
      car.deform.feedOverlap(hit, inward, 0.08, 12, DT);
      car.deform.stepStructure(DT);
      car.syncPose(DT);
      car.updateDeform(DT);
    }
    const snap = car.snapshot() as { parts: PartRow[] };
    return Object.fromEntries(snap.parts.map((p) => [p.name, p]));
  };

  it("good: a right-side hit opens the right door, not the left", () => {
    const { doorR: r, doorL: l } = rightSideHit();
    assert.ok(r!.hingeT > 0.15, `right door never hinged (${r!.hingeT})`);
    assert.ok(r!.hingeT > l!.hingeT + 0.08, `doors tied together R=${r!.hingeT} L=${l!.hingeT}`);
  });

  it("bad: the right-side hit folds or breaks the right mirror and leaves the left one alone (C3)", () => {
    const { mirrorR: r, mirrorL: l } = rightSideHit();
    assert.ok(r!.detached || r!.hingeT > 0.3, `right mirror untouched (${r!.hingeT})`);
    assert.ok(!l!.detached && l!.hingeT === 0, `left mirror moved (${l!.hingeT}, detached ${l!.detached})`);
  });

  it("good: front bumper folds then can detach on a hard nose hit", () => {
    const scene = new THREE.Scene();
    const car = new DeformableCar(paint(), scene);
    car.deform.setMode(mode);
    car.spawn(8, 12, 16);
    car.group.updateMatrixWorld();
    const hit = car.group.position.clone().addScaledVector(car.forward, 2.05);
    hit.y = 0.4;
    const inward = car.forward.clone().negate();
    car.applyImpact(hit, inward, 40, 40);
    for (let i = 0; i < 50; i++) {
      car.deform.notifyContact();
      car.deform.feedOverlap(hit, inward, 0.1, 16, DT);
      car.deform.stepStructure(DT);
      car.syncPose(DT);
      car.updateDeform(DT);
    }
    const snap = car.snapshot() as { parts: { name: string; hingeT: number; detached: boolean; folding: boolean }[] };
    const b = snap.parts.find((p) => p.name === "bumperF")!;
    assert.ok(b.hingeT > 0.2 || b.detached, `bumper never folded (${b.hingeT})`);
  });

  it("bad: detached parts are in world space (not still parented at rest local)", () => {
    const scene = new THREE.Scene();
    const car = new DeformableCar(paint(), scene);
    car.deform.setMode(mode);
    car.spawn(8, 12, 14);
    car.group.updateMatrixWorld();
    const hit = car.group.position.clone().addScaledVector(car.forward, 2.05);
    hit.y = 0.4;
    const inward = car.forward.clone().negate();
    car.applyImpact(hit, inward, 50, 50);
    for (let i = 0; i < 60; i++) {
      car.deform.notifyContact();
      car.deform.feedOverlap(hit, inward, 0.12, 18, DT);
      car.deform.stepStructure(DT);
      car.syncPose(DT);
      car.updateDeform(DT);
      car.afterContacts(DT);
    }
    const snap = car.snapshot() as { parts: { name: string; detached: boolean; pos: { y: number } }[] };
    const loose = snap.parts.filter((p) => p.detached);
    for (const p of loose) {
      assert.ok(p.pos.y > -0.05, `${p.name} fell through the map to y=${p.pos.y}`);
    }
  });

  it("close-but-wrong: headlights are independent — a right-front crush must not kill the left lamp first", () => {
    const scene = new THREE.Scene();
    const car = new DeformableCar(paint(), scene);
    car.deform.setMode(mode);
    car.spawn(8, 12, 14);
    car.group.updateMatrixWorld();
    const hit = car.group.position.clone().addScaledVector(car.forward, 2.0).addScaledVector(car.right, 0.7);
    hit.y = 0.4;
    const inward = car.forward.clone().negate();
    car.applyImpact(hit, inward, 22, 22);
    for (let i = 0; i < 20; i++) {
      car.deform.notifyContact();
      car.deform.feedOverlap(hit, inward, 0.08, 10, DT);
      car.deform.stepStructure(DT);
      car.syncPose(DT);
      car.updateDeform(DT);
    }
    const snap = car.snapshot() as { lamps: { kind: string; side: number; intact: boolean }[] };
    const right = snap.lamps.find((l) => l.kind === "head" && l.side === 1)!;
    const left = snap.lamps.find((l) => l.kind === "head" && l.side === -1)!;
    if (!right.intact) assert.ok(left.intact, "right-front hit killed the left head first");
  });
});

describe("detach and wheel rules follow where the hit lands (C1–C4, A3)", () => {
  it("bad: a 30 km/h side slide springs the struck door but keeps it on; frontal and offset 64 km/h walls latch both doors (C1)", () => {
    const side = runWall(30, 1, "side");
    assert.ok(!side.detached.includes("doorL"), `30 km/h side slide tore the door off: ${side.detached.join(",")}`);
    assert.ok(side.hinge.doorL! > 0.15, `struck door never sprang (${side.hinge.doorL})`);
    for (const [name, r] of [["wall64", runWall(64)], ["offset64", runWall(64, 0.4)]] as const) {
      assert.ok(!r.detached.some((p) => p.startsWith("door")), `${name} detached ${r.detached.join(",")}`);
      assert.ok(Math.max(r.hinge.doorL!, r.hinge.doorR!) <= 0.2, `${name} doors L=${r.hinge.doorL} R=${r.hinge.doorR}`);
    }
  });

  it("bad: a slow hit that folds the bumper hard leaves it on; a 56 km/h wall tears it off (C2)", () => {
    const car = new DeformableCar(paint(), new THREE.Scene());
    car.deform.setMode("shape");
    car.spawn(8, 12, 16);
    car.group.updateMatrixWorld();
    const hit = car.group.position.clone().addScaledVector(car.forward, 2.05);
    hit.y = 0.4;
    const inward = car.forward.clone().negate();
    car.applyImpact(hit, inward, 16, 25 / 3.6);
    for (let i = 0; i < 50; i++) {
      car.deform.notifyContact();
      car.deform.feedOverlap(hit, inward, 0.1, 16, DT);
      car.deform.stepStructure(DT);
      car.syncPose(DT);
      car.updateDeform(DT);
    }
    const bumper = (car.snapshot() as { parts: PartRow[] }).parts.find((p) => p.name === "bumperF")!;
    assert.ok(!bumper.detached && bumper.hingeT > 0.1, `25 km/h EBS: hingeT ${bumper.hingeT} detached ${bumper.detached}`);
    assert.ok(runWall(56).detached.includes("bumperF"), "56 km/h wall kept the bumper");
  });

  it("bad: a wheel leaves on a hard small-overlap hit only — not in a 2×56 km/h head-on or on a 50 km/h T-bone's struck car (C4)", () => {
    assert.deepEqual(runWall(64, 0.4).hubsPopped, ["hubFL"], "64 km/h 40 % offset");
    for (const r of runPair(56, 56)) assert.ok(r.hubsPopped.length < 2, `2×56 head-on popped ${r.hubsPopped.join(",")}`);
    const [struck] = runPair(0, 50, "t-bone");
    assert.deepEqual(struck.hubsPopped, [], "T-bone struck car");
  });

  it("bad: the engine block stays one 0.60 m casting through a corner wall and a T-bone (A3)", () => {
    const [struck, bullet] = runPair(0, 50, "t-bone");
    for (const [name, r] of [["offset56", runWall(56, 0.4)], ["struck", struck], ["bullet", bullet]] as const) {
      assert.ok(r.engineGapErr <= 0.012, `${name}: engineL–engineR off 0.60 by ${r.engineGapErr.toFixed(3)} m`);
    }
  });
});

/** The owner's "wrecks spin on the spot" capture (16-car fleet, shape mode): [paint, x, z, yaw, speed]. */
const SPIN_FLEET: [string, number, number, number, number][] = [
  ["Titanium", 20.8638, -8.1178, -1.1997, 28.513],
  ["Petrol", 23.6128, -13.4449, -1.0532, 14.733],
  ["Oxide", -2.6618, 25.8978, 3.0392, 19.6],
  ["Ink", 4.7018, -10.6017, -0.4174, 8.143],
  ["Bronze", 16.9026, 1.0423, -1.6324, 28.182],
  ["Moss", 7.1054, -21.5383, -0.3187, 9.485],
  ["Sand", -5.053, -23.6293, 0.2107, 10.532],
  ["Slate", -22.967, -17.576, 0.9176, 6.567],
  ["Ash", -18.2872, 7.1024, 1.9412, 8.595],
  ["Coal", 9.5697, -3.1629, -1.2516, 15.037],
  ["Khaki", -11.9963, 3.9944, 1.8922, 24.795],
  ["Teal", 11.3389, 15.7196, -2.5167, 17.877],
  ["Titanium-2", 0.1981, 17.6727, -3.1304, 8.599],
  ["Petrol-2", -1.1815, -12.542, 0.0939, 6.018],
  ["Oxide-2", 6.4505, 4.0158, -2.1276, 21.422],
  ["Ink-2", -24.5784, 5.4783, 1.7901, 24.339],
];

describe("a crushed wreck keeps its heading", () => {
  it("bad: after the 16-car fleet pile-up no wreck keeps turning on the spot", () => {
    const cars = SPIN_FLEET.map(([name, x, z, yaw, speed], i) => {
      const car = new DeformableCar({ body: 0xffffff, accent: 0x444444, name }, new THREE.Scene(), null, fleetStyle(i));
      car.deform.setMode("shape");
      car.deform.squash = 0.4;
      car.deform.buckle = 0.45;
      car.spawnFacing(x, z, yaw, 0);
      car.velocity.set(Math.sin(yaw) * speed, 0, Math.cos(yaw) * speed);
      car.speed = speed;
      car.spawnSpeed = speed;
      car.deform.bindKinematic(car.group, car.velocity, car.angular);
      return car;
    });
    const w = makeWorld(cars, false, false);
    const turn = cars.map(() => 0);
    const prev = cars.map((c) => c.group.rotation.y);
    for (let f = 0; f < 6 * 60; f++) {
      tickWorld(w);
      cars.forEach((c, i) => {
        const d = c.group.rotation.y - prev[i]!;
        prev[i] = c.group.rotation.y;
        if (f >= 4 * 60) turn[i]! += Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
      });
    }
    const worst = turn.indexOf(Math.max(...turn));
    assert.ok(turn[worst]! < 0.1, `${SPIN_FLEET[worst]![0]} turned ${turn[worst]!.toFixed(2)} rad in the last 2 s, |ω| ${cars[worst]!.angular.y.toFixed(2)}`);
  });
});

describe("rotation sense and frame-rate independence (A9, A10, A15)", () => {
  it("bad: glass shards leave a yawing car with the pane's own velocity (finite difference of integrate)", () => {
    let shard: THREE.Vector3 | null = null;
    const car = new DeformableCar(paint(), new THREE.Scene(), (_o, v) => {
      shard = v.clone();
    });
    car.spawnFacing(0, 0, 0.3, 0);
    car.crashed = true;
    car.velocity.set(0, 0, 0);
    car.angular.set(0, 2, 0);
    car.group.updateMatrixWorld(true);
    // A pane hung off the body's centre (door glass), so ω × r is not zero.
    const pane = car["glassPanes"].find((g) => g.mesh.getWorldPosition(new THREE.Vector3()).distanceTo(car.group.position) > 0.5)!;
    const p0 = pane.mesh.getWorldPosition(new THREE.Vector3());
    car["shatterGlass"](pane);
    const h = 1e-4;
    car.integrate(h);
    car.group.updateMatrixWorld(true);
    const fd = pane.mesh.getWorldPosition(new THREE.Vector3()).sub(p0).divideScalar(h);
    const v = shard as THREE.Vector3 | null;
    assert.ok(v, "no shard burst");
    const err = Math.hypot(v.x - fd.x, v.z - fd.z);
    assert.ok(Math.hypot(fd.x, fd.z) > 0.5, `pane barely moves (${fd.x.toFixed(2)},${fd.z.toFixed(2)})`);
    assert.ok(err < 0.05 * Math.hypot(fd.x, fd.z), `shard v=(${v.x.toFixed(2)},${v.z.toFixed(2)}) pane v=(${fd.x.toFixed(2)},${fd.z.toFixed(2)})`);
  });

  it("bad: physics slices follow a wreck's real velocity, not its stale drive speed (A10)", () => {
    const car = new DeformableCar(paint(), new THREE.Scene());
    car.speed = 0;
    car.velocity.set(24, 0, -7);
    assert.equal(sliceSpeed([car]), 25);
  });

  it("bad: sliding debris loses the same speed per second at 60 Hz and 240 Hz (A15)", () => {
    const slide = (hz: number) => {
      const debris = new DebrisSystem(new THREE.Scene(), 1);
      debris.burst(new THREE.Vector3(0, -0.05, 0), new THREE.Vector3(0, 0, -1), 1);
      debris["vx"][0] = 6;
      debris["vy"][0] = 0;
      debris["vz"][0] = 0;
      debris["life"][0] = 10;
      for (let i = 0; i < hz * 0.5; i++) debris.update(1 / hz, bounceGround);
      return debris.snapshot().items[0]!.x;
    };
    const x60 = slide(60);
    const x240 = slide(240);
    assert.ok(Math.abs(x60 - x240) < 0.05 * x240, `0.5 s slide: ${x60.toFixed(3)} m at 60 Hz vs ${x240.toFixed(3)} m at 240 Hz`);
  });

  it("bad: debris touching a car's leading flank is swept along with it, not left inside (A15)", () => {
    const car = new DeformableCar(paint(), new THREE.Scene());
    car.spawnFacing(0, 0, 0, 0);
    car.velocity.set(8, 0, 0);
    const pos = new THREE.Vector3(0.85, 0.6, 0);
    const vel = new THREE.Vector3();
    bounceOffCar(car, pos, vel, 0.03);
    assert.ok(vel.x > 8, `debris vx ${vel.x.toFixed(2)} after the 8 m/s flank swept it`);
  });

  it("bad: two wrecks scraping flank to flank trade sliding speed through Coulomb friction (A15)", () => {
    const a = spawnOffset(0, 0, "shape");
    const b = spawnOffset(0, 0, "shape");
    for (const m of b.d.masses) {
      m.world.x += 1.5;
      m.vel.set(-4, 0, 6);
    }
    for (const m of a.d.masses) m.vel.set(0, 0, 0);
    const pz = (d: StreamedDeformation) => d.masses.reduce((s, m) => s + m.vel.z * m.mass, 0);
    a.d.collideWith(b.d, 1 / 240);
    // 11 kg·m/s reaches it through the normals alone; Coulomb friction (μ 0.45) hands over ~147.
    assert.ok(pz(a.d) > 60, `the struck wreck took ${pz(a.d).toFixed(1)} kg·m/s of the 6 m/s slide`);
  });
});

forModes("two-car first contact stays on the map", (mode) => {
  it("bad: head-on overlap does not light-speed either car", () => {
    const scene = new THREE.Scene();
    const a = new DeformableCar(paint(), scene);
    const b = new DeformableCar(paint(), scene);
    a.deform.setMode(mode);
    b.deform.setMode(mode);
    a.spawn(0, 0, 18);
    b.spawn(0, 8, 18);
    a.group.updateMatrixWorld();
    b.group.updateMatrixWorld();
    const hit = a.group.position.clone().lerp(b.group.position, 0.5);
    hit.y = 0.4;
    const inward = b.group.position.clone().sub(a.group.position).setY(0).normalize();
    a.applyImpact(hit, inward, 30, 15);
    b.applyImpact(hit, inward.clone().negate(), 30, 15);
    for (let i = 0; i < 20; i++) {
      a.deform.notifyContact();
      b.deform.notifyContact();
      a.deform.feedOverlap(hit, inward, 0.12, 16, DT);
      b.deform.feedOverlap(hit, inward.clone().negate(), 0.12, 16, DT);
      a.deform.stepStructure(DT);
      b.deform.stepStructure(DT);
      a.syncPose(DT);
      b.syncPose(DT);
      a.updateDeform(DT);
      b.updateDeform(DT);
    }
    for (const car of [a, b]) {
      assert.ok(car.group.position.length() < 40, `${mode} group ${car.group.position.toArray()}`);
      assert.ok(car.velocity.length() < 60, `${mode} vel ${car.velocity.length()}`);
      for (const m of car.deform.masses) {
        assert.ok(Number.isFinite(m.world.x + m.vel.z), `${m.name} NaN`);
        assert.ok(m.vel.length() < 60, `${m.name} ${m.vel.length()}`);
      }
    }
  });
});

describe("particles stay in world space above the ground", () => {
  it("good: snapshotPoints parks dead samples, live ones keep y>=0", () => {
    const pos = new Float32Array([1, 0.2, 2, 3, 250, 4]);
    const life = new Float32Array([0.4, 0]);
    const snap = snapshotPoints(pos, null, null, life, true);
    assert.equal(snap.items.length, 1);
    assert.ok(snap.items[0]!.y >= 0);
  });

  it("close-but-wrong: y=250 is treated as dead parking, not a live particle below the map", () => {
    const pos = new Float32Array([0, 250, 0]);
    const life = new Float32Array([0.5]);
    const snap = snapshotPoints(pos, null, null, life, true);
    assert.equal(snap.items.length, 0);
  });
});

describe("car-car crush scales with speed [shape]", () => {
  const slow = runPair(28, 28);
  const fast = runPair(56, 56);
  const nose = (r: (typeof slow)[number]) => Math.max(r.noseMaxL, r.noseMaxR);

  it("good: a 2×28 km/h head-on crushes each nose 0.15–0.40 m", () => {
    for (const r of slow) assert.ok(nose(r) >= 0.15 && nose(r) <= 0.4, `nose ${nose(r).toFixed(3)}`);
  });

  it("good: a 2×56 km/h head-on crushes each nose 0.35–0.70 m", () => {
    for (const r of fast) assert.ok(nose(r) >= 0.35 && nose(r) <= 0.7, `nose ${nose(r).toFixed(3)}`);
  });

  it("close-but-wrong: doubling the speed crushes more than 1.4× deeper", () => {
    for (let i = 0; i < 2; i++) assert.ok(nose(fast[i]!) > 1.4 * nose(slow[i]!), `56=${nose(fast[i]!).toFixed(3)} 28=${nose(slow[i]!).toFixed(3)}`);
  });

  it("good: a full-overlap head-on stays centred on both cars", () => {
    for (const r of slow) assert.ok(Math.abs(r.impactLocalX) < 0.2, `impactLocal.x=${r.impactLocalX.toFixed(3)}`);
  });
});
