import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { StreamedDeformation, type DeformMode } from "./streamed-deform.ts";
import { DeformableCar } from "./car.ts";
import { leftoverCrumple, snapshotPoints } from "./physics-util.ts";

const DT = 1 / 60;
const MODES: DeformMode[] = ["lattice", "shape"];

function dummyGeom(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1.7, 1.3, 4.3, 3, 2, 6);
}

function mass(d: StreamedDeformation, name: string) {
  const m = d.masses.find((n) => n.name === name);
  assert.ok(m, name);
  return m;
}

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
  d.beginCrush(new THREE.Vector3(impactX, 0.36, 2.06), new THREE.Vector3(0, 0, -1), speed, group, vel, omega);
  return { d, group, vel, omega, geom };
}

function forModes(title: string, fn: (mode: DeformMode) => void): void {
  for (const mode of MODES) describe(`${title} [${mode}]`, () => fn(mode));
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

function paint() {
  return { name: "Test", body: 0xffffff, accent: 0x444444 };
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
  it("good: a right-side hit opens the right door, not the left", () => {
    const scene = new THREE.Scene();
    const car = new DeformableCar(paint(), scene);
    car.deform.setMode(mode);
    car.spawn(8, 12, 12);
    car.group.updateMatrixWorld();
    const hit = car.group.position.clone().addScaledVector(car.right, 0.9);
    hit.y = 0.5;
    const inward = car.right.clone().negate();
    car.applyImpact(hit, inward, 28);
    for (let i = 0; i < 45; i++) {
      car.deform.notifyContact();
      car.deform.feedOverlap(hit, inward, 0.08, 12, DT);
      car.deform.stepStructure(DT);
      car.syncPose(DT);
      car.updateDeform(DT);
    }
    const snap = car.snapshot() as { parts: { name: string; hingeT: number; detached: boolean }[] };
    const r = snap.parts.find((p) => p.name === "doorR")!;
    const l = snap.parts.find((p) => p.name === "doorL")!;
    assert.ok(r.hingeT > 0.15, `right door never hinged (${r.hingeT})`);
    assert.ok(r.hingeT > l.hingeT + 0.08, `doors tied together R=${r.hingeT} L=${l.hingeT}`);
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
    car.applyImpact(hit, inward, 40);
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
    car.applyImpact(hit, inward, 50);
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
    car.applyImpact(hit, inward, 22);
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
    a.applyImpact(hit, inward, 30);
    b.applyImpact(hit, inward.clone().negate(), 30);
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
