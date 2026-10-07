import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { StreamedDeformation } from "./streamed-deform.ts";
import { TYRE_R } from "./deform-state.ts";
import type { DeformMode } from "./deform-rig.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { leftoverCrumple, snapshotPoints } from "./physics-util.ts";
import { DT, dummyGeom, forModes, mass, paint } from "../vehicle/test-support.ts";
import { makeCar, makeWorld, runPair, runWall, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { sliceSpeed } from "../contact/sat.ts";
import { fleetStyle } from "../scenes/fleet.ts";
import { bounceGround, bounceOffCar, DebrisSystem } from "../present/engine-fx.ts";

type PartRow = { name: string; hingeT: number; detached: boolean };

function spawnOffset(impactX: number, speed = 14, mode: DeformMode = "lattice") {
  const geom = dummyGeom();
  const d = new StreamedDeformation(geom);
  d.mode = mode;
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
  s.d.stepCrush(dt, true);
  s.d.update(s.geom);
}

forModes("given a car driving at 14 m/s into a wall that meets one front corner", (mode) => {
  it("when the wall hits the right-front corner, then the right-front bumper sits at least 8 cm further back than the left-front one and the rear bumper stays at least 1.95 m behind the middle (1.9 m in shape mode)", () => {
    const s = spawnOffset(0.62, 14, mode);
    for (let i = 0; i < 24; i++) stepWall(s, DT, mass(s.d, "bumperFR").world.x);
    const flz = mass(s.d, "bumperFL").local.z;
    const frz = mass(s.d, "bumperFR").local.z;
    const rlz = mass(s.d, "bumperRL").local.z;
    assert.ok(frz < flz - 0.08, `no corner banana: FL.z=${flz.toFixed(3)} FR.z=${frz.toFixed(3)}`);
    assert.ok(rlz <= (mode === "shape" ? -1.9 : -1.95), `rear extruded to ${rlz.toFixed(3)}`);
  });

  it("when the wall hits the right-front corner, then the two front bumper corners stay more than 0.7 m apart across the car, the far corner staying wide as the nose bends sideways", () => {
    const s = spawnOffset(0.62, 14, mode);
    for (let i = 0; i < 22; i++) stepWall(s, DT, mass(s.d, "bumperFR").world.x);
    const r = mass(s.d, "bumperFR").local.x;
    const l = mass(s.d, "bumperFL").local.x;
    assert.ok(r > l + 0.7, `track collapsed: FL.x=${l.toFixed(3)} FR.x=${r.toFixed(3)}`);
  });

  it("when the wall hits the left-front corner, then the left-front bumper sits at least 6 cm further back than the right-front one, so the sideways bend is not mirrored the wrong way", () => {
    const s = spawnOffset(-0.62, 14, mode);
    for (let i = 0; i < 22; i++) stepWall(s, DT, mass(s.d, "bumperFL").world.x);
    const flz = mass(s.d, "bumperFL").local.z;
    const frz = mass(s.d, "bumperFR").local.z;
    assert.ok(flz < frz - 0.06, `inverted banana L=${flz.toFixed(3)} R=${frz.toFixed(3)}`);
  });

  it("when the squash slider (how readily the body crushes) is 0.7 instead of 0.2 and the wall hits the right-front corner, then the hit corner is pushed back more than 1.15 times as far", () => {
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

forModes("given a car driving at 14 m/s head-on into a wall", (mode) => {
  it("when its nose is crushed by the first 20 frames of the hit, then the car body stays on the road, below 0.15 m high", () => {
    const s = spawnOffset(0, 14, mode);
    for (let i = 0; i < 20; i++) stepWall(s, DT, 0);
    assert.ok(s.group.position.y < 0.15, `lofted to y=${s.group.position.y}`);
  });

  it("when its nose is crushed by the first 20 frames of the hit, then the car body's position follows the cabin block (within 0.35 m sideways and 0.45 m lengthwise), not the crushed bumper", () => {
    const s = spawnOffset(0, 14, mode);
    for (let i = 0; i < 20; i++) stepWall(s, DT, 0);
    const cell = mass(s.d, "cell");
    assert.ok(Math.abs(s.group.position.x - (cell.world.x - cell.rest.x)) < 0.35);
    assert.ok(Math.abs(s.group.position.z - (cell.world.z - cell.rest.z)) < 0.45);
  });

  it("when the nose shortens over 28 frames, then the front bumper has moved back at least 8 cm (2 cm in shape mode) or sits over 5 cm from its rest position, and the remaining-crumple fraction is at most 1", () => {
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

describe("given a car in lattice deform mode (a lattice of beams joins its parts)", () => {
  it("when the front bumper's two corners are each pulled 0.4 m outward, then the beam between them reports stretch (strain above 0.05) and is still intact", () => {
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

  it("when the nose is crushed head-on for 16 frames, then the beam from the left engine mount to the cabin reports compression (strain below -0.02)", () => {
    const s = spawnOffset(0, 14, "lattice");
    for (let i = 0; i < 16; i++) stepWall(s, DT, 0);
    const snap = s.d.snapshot() as { beams: { a: string; b: string; strain: number }[] };
    const b = snap.beams.find((x) => x.a === "engineL" && x.b === "cell")!;
    assert.ok(b.strain < -0.02, `expected compression, got ${b.strain}`);
  });

  it("when the wall hits the right-front corner, then the rear bumper's cross beam keeps over 92 % of its rest length, so the far side is not squashed", () => {
    const s = spawnOffset(0.62, 14, "lattice");
    for (let i = 0; i < 16; i++) stepWall(s, DT, mass(s.d, "bumperFR").world.x);
    const snap = s.d.snapshot() as { beams: { a: string; b: string; plastic: number; rest: number }[] };
    const b = snap.beams.find((x) => x.a === "bumperRL" && x.b === "bumperRR")!;
    assert.ok(b.plastic > b.rest * 0.92, `rear beam plastic-shrunk to ${b.plastic}`);
  });
});

forModes("given a car struck on its right side at 28 m/s, with the contact held for 45 frames", (mode) => {
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
      car.stepBreakage(DT);
      car.updateSkin();
    }
    const snap = car.snapshot() as { parts: PartRow[] };
    return Object.fromEntries(snap.parts.map((p) => [p.name, p]));
  };

  it("when the hit settles, then the right door has opened (hinge past 0.15) and by at least 0.08 more than the left door", () => {
    const { doorR: r, doorL: l } = rightSideHit();
    assert.ok(r!.hingeT > 0.15, `right door never hinged (${r!.hingeT})`);
    assert.ok(r!.hingeT > l!.hingeT + 0.08, `doors tied together R=${r!.hingeT} L=${l!.hingeT}`);
  });

  it("when the hit settles, then the right mirror has folded (hinge past 0.3) or broken off, and the left mirror is untouched, not detached and not hinged", () => {
    const { mirrorR: r, mirrorL: l } = rightSideHit();
    assert.ok(r!.detached || r!.hingeT > 0.3, `right mirror untouched (${r!.hingeT})`);
    assert.ok(!l!.detached && l!.hingeT === 0, `left mirror moved (${l!.hingeT}, detached ${l!.detached})`);
  });
});

forModes("given a car hit on its nose at 40 m/s, with the contact held for 50 frames", (mode) => {
  it("when the nose hit settles, then the front bumper has folded (hinge past 0.2) or detached", () => {
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
      car.stepBreakage(DT);
      car.updateSkin();
    }
    const snap = car.snapshot() as { parts: { name: string; hingeT: number; detached: boolean; folding: boolean }[] };
    const b = snap.parts.find((p) => p.name === "bumperF")!;
    assert.ok(b.hingeT > 0.2 || b.detached, `bumper never folded (${b.hingeT})`);
  });
});

forModes("given a car spawned far from the map's origin and hit on its nose at 50 m/s, with the contact held for 60 frames", (mode) => {
  it("when parts detach, then some do and every loose part lies in world space near the car (within 30 m of it, above the ground), not at its rest position near the origin", () => {
    const scene = new THREE.Scene();
    const car = new DeformableCar(paint(), scene);
    car.deform.setMode(mode);
    car.spawn(80, 120, 14);
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
      car.stepBreakage(DT);
      car.updateSkin();
      car.afterContacts(DT);
    }
    const snap = car.snapshot() as { parts: { name: string; detached: boolean; pos: { x: number; y: number; z: number } }[] };
    const loose = snap.parts.filter((p) => p.detached);
    assert.ok(loose.length > 0, "the 50/50 nose hit detached nothing");
    const at = car.group.position;
    for (const p of loose) {
      assert.ok(p.pos.y > -0.05, `${p.name} fell through the map to y=${p.pos.y}`);
      // Left at its rest-local coordinates it would sit near the origin, ~140 m from the car spawned at (80, 120).
      const off = Math.hypot(p.pos.x - at.x, p.pos.z - at.z);
      assert.ok(off < 30, `${p.name} lies ${off.toFixed(1)} m from its car`);
    }
  });
});

forModes("given a car with one part detached", () => {
  it("when the car is disposed of, then the geometry and own materials of its attached and loose parts are all freed", () => {
    const scene = new THREE.Scene();
    const car = new DeformableCar(paint(), scene);
    car.spawn(0, 0, 0);
    const parts = car["parts"];
    car["detachPart"](parts[0]!, 10);
    const live = new Set<THREE.BufferGeometry | THREE.Material>();
    for (const p of parts) {
      p.object.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        live.add(o.geometry);
        for (const m of [o.material].flat() as THREE.Material[]) if (!m.userData.shared) live.add(m);
      });
    }
    for (const r of live) r.addEventListener("dispose", () => live.delete(r));
    car.dispose();
    assert.equal(live.size, 0, `${live.size} part geometries/materials left undisposed`);
  });
});

forModes("given a freshly built car", () => {
  it("when it is disposed of, then every geometry and own material in its group, the hull overlay's lines included, is freed", () => {
    const scene = new THREE.Scene();
    const car = new DeformableCar(paint(), scene);
    const live = new Set<THREE.BufferGeometry | THREE.Material>();
    let drawn = 0;
    car.group.traverse((o) => {
      const d = o as THREE.Mesh | THREE.Line | THREE.Points;
      if (!d.geometry) return;
      drawn++;
      live.add(d.geometry);
      for (const m of [d.material].flat() as THREE.Material[]) if (!m.userData.shared) live.add(m);
    });
    assert.ok([...live].some((r) => r instanceof THREE.BufferGeometry && r === (car["hullHelper"] as THREE.LineSegments).geometry), "the hull overlay is among what the car owns");
    assert.ok(drawn > 20, `${drawn} drawn objects found`);
    for (const r of live) r.addEventListener("dispose", () => live.delete(r));
    car.dispose();
    assert.equal(live.size, 0, `${live.size} geometries/materials left undisposed`);
  });
});

forModes("given a car whose wheel hubs all pop off after a 2 m/s nose knock", (mode) => {
  it("when it runs for 5 s, then each wheel leaves the car as its own body, lands on its tyre at ground level and stops sliding, and the drivetrain is dead with no wheels left", () => {
    const scene = new THREE.Scene();
    const car = new DeformableCar(paint(), scene);
    car.deform.setMode(mode);
    car.spawn(0, 0, 8);
    car.group.updateMatrixWorld();
    const hit = car.group.position.clone().addScaledVector(car.forward, 2.05);
    car.applyImpact(hit, car.forward.clone().negate(), 2, 2);
    for (const m of car.deform.masses) if (m.hub) car.deform.popHub(m);
    const before = car.wheels.map((w) => w.position.clone());
    for (let i = 0; i < 300; i++) {
      if (i === 299) for (const [k, w] of car.wheels.entries()) before[k]!.copy(w.position);
      car.syncPose(DT);
      car.afterContacts(DT);
    }
    assert.equal(car.deform.drivetrainAlive, false, "no wheels and the drivetrain still runs");
    for (const [k, w] of car.wheels.entries()) {
      assert.equal(w.parent, scene, `wheel ${k} still rides the car`);
      assert.ok(Math.abs(w.position.y - TYRE_R) < 0.01, `wheel ${k} rests at y ${w.position.y.toFixed(3)}, not on its tyre`);
      assert.ok(w.position.distanceTo(before[k]!) < 1e-3, `wheel ${k} still sliding after 5 s`);
    }
  });
});

forModes("given a car hit on its right-front corner at 22 m/s, with the contact held for 20 frames", (mode) => {
  it("when the right-front corner is crushed, then the left headlight is not destroyed before the right one", () => {
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
      car.stepBreakage(DT);
      car.updateSkin();
    }
    const snap = car.snapshot() as { lamps: { kind: string; side: number; intact: boolean }[] };
    const right = snap.lamps.find((l) => l.kind === "head" && l.side === 1)!;
    const left = snap.lamps.find((l) => l.kind === "head" && l.side === -1)!;
    if (!right.intact) assert.ok(left.intact, "right-front hit killed the left head first");
  });
});

describe("given a car hitting a wall", () => {
  it("when it slides sideways into it at 30 km/h, or hits it head-on at 64 km/h full-width or with a 40 % offset, then the 30 km/h slide springs the struck door (hinge past 0.15) without tearing it off, and neither 64 km/h hit tears a door off or opens one past 0.2", () => {
    const side = runWall(30, 1, "side");
    assert.ok(!side.detached.includes("doorL"), `30 km/h side slide tore the door off: ${side.detached.join(",")}`);
    assert.ok(side.hinge.doorL! > 0.15, `struck door never sprang (${side.hinge.doorL})`);
    for (const [name, r] of [["wall64", runWall(64)], ["offset64", runWall(64, 0.4)]] as const) {
      assert.ok(!r.detached.some((p) => p.startsWith("door")), `${name} detached ${r.detached.join(",")}`);
      assert.ok(Math.max(r.hinge.doorL!, r.hinge.doorR!) <= 0.2, `${name} doors L=${r.hinge.doorL} R=${r.hinge.doorR}`);
    }
  });
});

describe("given a car's front bumper, in shape deform mode", () => {
  it("when the car takes a 25 km/h nose hit and, separately, hits a wall at 56 km/h, then the 25 km/h hit folds the bumper (hinge past 0.1) but leaves it on, and the 56 km/h wall tears it off", () => {
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
      car.stepBreakage(DT);
      car.updateSkin();
    }
    const bumper = (car.snapshot() as { parts: PartRow[] }).parts.find((p) => p.name === "bumperF")!;
    assert.ok(!bumper.detached && bumper.hingeT > 0.1, `25 km/h EBS: hingeT ${bumper.hingeT} detached ${bumper.detached}`);
    assert.ok(runWall(56).detached.includes("bumperF"), "56 km/h wall kept the bumper");
  });
});

describe("given a wheel that leaves its car only on a hard small-overlap hit", () => {
  it("when cars hit a wall at 64 km/h with a 40 % offset, head-on at 2×56 km/h, and as the struck car of a 50 km/h T-bone, then only the front-left wheel leaves in the offset wall hit, fewer than two leave each car of the head-on and none leaves the struck car", () => {
    assert.deepEqual(runWall(64, 0.4).hubsPopped, ["hubFL"], "64 km/h 40 % offset");
    for (const r of runPair(56, 56)) assert.ok(r.hubsPopped.length < 2, `2×56 head-on popped ${r.hubsPopped.join(",")}`);
    const [struck] = runPair(0, 50, "t-bone");
    assert.deepEqual(struck.hubsPopped, [], "T-bone struck car");
  });
});

describe("given a corner crushed to within 0.12 m of its wheel hub", () => {
  it("when cars hit head-on at 2×80 km/h, then both front wheels come off both cars, whereas a full-width wall at 56 or 64 km/h or a 2×56 km/h head-on takes none off", () => {
    for (const r of runPair(80, 80)) assert.deepEqual(r.hubsPopped, ["hubFL", "hubFR"], "2×80 head-on");
    for (const r of runPair(56, 56)) assert.deepEqual(r.hubsPopped, [], "2×56 head-on");
    for (const kph of [56, 64]) assert.deepEqual(runWall(kph).hubsPopped, [], `${kph} km/h full-width wall`);
  });
});

describe("given an engine block made of a left and a right half, 0.60 m apart", () => {
  it("when a car hits a wall at 56 km/h with a 40 % offset, and a car is T-boned at 50 km/h, then the halves stay within 1.2 cm of their 0.60 m spacing on the offset-hit car and on both T-bone cars", () => {
    const [struck, bullet] = runPair(0, 50, "t-bone");
    for (const [name, r] of [["offset56", runWall(56, 0.4)], ["struck", struck], ["bullet", bullet]] as const) {
      assert.ok(r.engineGapErr <= 0.012, `${name}: engineL–engineR off 0.60 by ${r.engineGapErr.toFixed(3)} m`);
    }
  });
});

describe("given a car's glass panes", () => {
  it("when a car hits a wall at 35 km/h and at 56 km/h, and is hit from the side at 50 km/h, then the windscreen cracks at 35 and shatters at 56 with the rear glass intact, and the side hit shatters the left door glass but not the right", () => {
    const glassAfter = (kph: number, approach: "front" | "side") => {
      const car = makeCar();
      runWall(kph, 1, approach, { car });
      return car["glassPanes"].map((g) => g.state);
    };
    // Pane order (addGlass): 0 windscreen, 1 rear glass, 2/3 door glass L/R.
    const slow = glassAfter(35, "front");
    assert.deepEqual([slow[0], slow[1]], ["cracked", "intact"], "35 km/h wall");
    assert.equal(glassAfter(56, "front")[0], "shattered", "56 km/h wall windscreen");
    const side = glassAfter(50, "side");
    assert.deepEqual([side[2], side[3]], ["shattered", "intact"], "50 km/h left side hit: door glass L/R");
  });
});

describe("given two cars driving head-on at each other, with the squash setting at 0.32", () => {
  it("when each car drives at 40, 56, 64 or 100 km/h, then their tyres never overlap by more than 1 cm and no part jumps farther than 3·v·h + 5 cm in a physics step (v the speed, h the step); below 100 km/h no wheel pops off, and at 56 km/h the nose crushes 0.25–0.50 m", () => {
    for (const kph of [40, 56, 64, 100]) {
      for (const r of runPair(kph, kph, "head-on", { squash: 0.32 })) {
        assert.ok(r.tyreOverlap <= 0.01, `${kph} km/h head-on: tyres overlap ${r.tyreOverlap.toFixed(3)} m`);
        if (kph < 100) assert.equal(r.hubsPopped.length, 0, `${kph} km/h head-on popped ${r.hubsPopped.join(",")}`);
        // No mass steps past 3·v·h + 5 cm in a slice: not through the hit, its springback, or the stopped wreck levelling out.
        assert.ok(r.massStepExcess <= 0, `${kph} km/h head-on: ${r.massStepName} stepped ${r.massStepExcess.toFixed(3)} m past 3·v·h + 5 cm in a slice`);
        // The stop is the last limit, not a shorter crumple: 56 km/h stays in the 0.25–0.50 m nose band.
        if (kph === 56) assert.ok(r.noseShortL >= 0.25 && r.noseShortL <= 0.5, `56 km/h nose ${r.noseShortL.toFixed(3)} m`);
      }
    }
  });

  it("when each car's speed rises through 100, 115, 130, 150, 180 and 200 km/h, then each pair's mean nose crush is never more than 5 % below that of the slower pair before it", () => {
    let prev = 0;
    for (const kph of [100, 115, 130, 150, 180, 200]) {
      const [a, b] = runPair(kph, kph, "head-on", { squash: 0.32 });
      const nose = (a.noseShortL + b.noseShortL) / 2;
      assert.ok(nose >= prev * 0.95, `${kph} km/h head-on: mean nose ${nose.toFixed(3)} m after ${prev.toFixed(3)} m at the slower speed`);
      prev = nose;
    }
  });
});

describe("given a car hitting a wall or being hit from the side, until the stopped wreck levels out", () => {
  it("when a car hits at 64 km/h full-width, at 64 km/h with a 40 % offset, and at 56 km/h side-on, then no part jumps farther than 3·v·h + 5 cm in a physics step (v the speed, h the step)", () => {
    for (const [label, r] of [
      ["64 full", runWall(64)],
      ["64 offset", runWall(64, 0.4)],
      ["56 side", runWall(56, 1, "side")],
    ] as const) {
      assert.ok(r.massStepExcess <= 0, `${label}: ${r.massStepName} stepped ${r.massStepExcess.toFixed(3)} m past 3·v·h + 5 cm in a slice`);
    }
  });
});

/** 50 km/h T-bone (runPair's layout): the struck door's deepest intrusion in the first 0.3 s of
 *  contact, and the least gap (m) between the bullet's cell and the struck cell along the travel. */
function tbone(squash: number): { door: number; gap: number } {
  const a = makeCar("shape", squash);
  const b = makeCar("shape", squash);
  for (const [c, x, yaw, vx] of [[a, 0, 0, 0], [b, 6, -Math.PI / 2, -50 / 3.6]] as const) {
    c.spawnFacing(x, 0, yaw, 0);
    c.velocity.set(vx, 0, 0);
    c.deform.bindKinematic(c.group, c.velocity, c.angular);
  }
  const w = makeWorld([a, b], false, false);
  let door = 0;
  let gap = Infinity;
  let since = -1;
  for (let f = 0; f < 150; f++) {
    tickWorld(w);
    if (since < 0 && a.crashed) since = 0;
    if (since < 0 || !a.deform.massActive || !b.deform.massActive) continue;
    since += 1 / 60;
    if (since <= 0.3) door = Math.max(door, 0.78 - (mass(a.deform, "doorR").local.x - mass(a.deform, "cell").local.x));
    gap = Math.min(gap, mass(b.deform, "cell").world.x - mass(a.deform, "cell").world.x);
  }
  return { door, gap };
}

describe("given a 50 km/h T-bone, a car driving into the side of a stationary car", () => {
  // CRUSH_CALIBRATION tbone50 band (IIHS side 50 km/h): struck-door intrusion 0.12–0.28 m. Car-car
  // contact stopped the bullet's nose dead while the struck car got no momentum: door 0.01 m in the
  // impact; without the in-contact ground drag the bullet then drove through the struck car (its cell
  // 3.6–5 m past), and that pass-through was the 0.26 m "door" the calibration once recorded.
  it("when the cars run with the squash setting at 0.32 and at 0.4, then within 0.3 s of contact the struck door is pushed in 0.12–0.28 m and the striking car's cabin never gets within 0.9 m of the struck car's cabin", () => {
    for (const squash of [0.32, 0.4]) {
      const { door, gap } = tbone(squash);
      assert.ok(door >= 0.12 && door <= 0.28, `squash ${squash}: door ${door.toFixed(3)} m in the impact`);
      assert.ok(gap > 0.9, `squash ${squash}: bullet cell ${gap.toFixed(2)} m from the struck cell`);
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

describe("given the recorded 16-car pile-up in which wrecks spun on the spot, in shape deform mode", () => {
  it("when it runs for 6 s, then no wreck is still turning at the end: each turns less than 0.1 rad over the last 2 s", () => {
    const cars = SPIN_FLEET.map(([name, x, z, yaw, speed], i) => {
      const car = new DeformableCar({ body: 0xffffff, accent: 0x444444, name }, new THREE.Scene(), null, fleetStyle(i));
      car.deform.setMode("shape");
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
      for (const [i, c] of cars.entries()) {
        const d = c.group.rotation.y - prev[i]!;
        prev[i] = c.group.rotation.y;
        if (f >= 4 * 60) turn[i]! += Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
      }
    }
    const worst = turn.indexOf(Math.max(...turn));
    assert.ok(turn[worst]! < 0.1, `${SPIN_FLEET[worst]![0]} turned ${turn[worst]!.toFixed(2)} rad in the last 2 s, |ω| ${cars[worst]!.angular.y.toFixed(2)}`);
  });

  it("when the squash setting is 0.4 and the buckle setting 0.45, then no wreck turns faster than 5 rad/s over any 0.1 s of the first 2.5 s", () => {
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
    const yaws = cars.map(() => [] as number[]);
    const peak = cars.map(() => 0);
    for (let f = 0; f < 2.5 * 60; f++) {
      tickWorld(w);
      for (const [i, c] of cars.entries()) {
        const h = yaws[i]!;
        h.push(c.group.rotation.y);
        if (h.length > 6) {
          const d = h[h.length - 1]! - h[h.length - 7]!;
          peak[i] = Math.max(peak[i]!, Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) * 10);
        }
      }
    }
    const worst = peak.indexOf(Math.max(...peak));
    assert.ok(peak[worst]! <= 5, `${SPIN_FLEET[worst]![0]} turned at ${peak[worst]!.toFixed(2)} rad/s over 0.1 s`);
  });
});

/** A wreck at (0, z) heading `yaw`, sliding along +z at `v` (m/s), its masses armed by a light knock. */
function slidingWreck(z: number, v: number, yaw = 0): DeformableCar {
  const car = new DeformableCar(paint(), new THREE.Scene());
  car.deform.setMode("shape");
  car.spawnFacing(0, z, yaw, 0);
  car.velocity.set(0, 0, v);
  car.speed = v;
  car.deform.bindKinematic(car.group, car.velocity, car.angular);
  car.applyImpact(car.group.localToWorld(new THREE.Vector3(0.7, 0.4, 2.2)), car.forward.clone().negate(), 2, 2);
  return car;
}

/** Mass-weighted speed (m/s) of every mass of `cars` together. */
function groupSpeed(cars: DeformableCar[]): number {
  let px = 0;
  let pz = 0;
  let m = 0;
  for (const c of cars) {
    for (const p of c.deform.masses) {
      px += p.vel.x * p.mass;
      pz += p.vel.z * p.mass;
      m += p.mass;
    }
  }
  return Math.hypot(px, pz) / m;
}

/** Mean deceleration (m/s²) of `cars` over `secs` of engine ticks, after the impact clock has run. */
function slideDecel(cars: DeformableCar[], secs: number): number {
  const w = makeWorld(cars, false, false);
  w.clock.phase = "slowmo";
  w.clock.wallSinceImpact = 1;
  for (let f = 0; f < 12; f++) tickWorld(w);
  const v0 = groupSpeed(cars);
  for (let f = 0; f < secs * 60; f++) tickWorld(w);
  return (v0 - groupSpeed(cars)) / secs;
}

describe("given crashed wrecks sliding to a stop on the ground", () => {
  // Owner dump: a pair of wrecks grinding together slid at 0.44 g against 1.4–1.8 g alone: the mass
  // drag waited for the car-contact quiet timer, which the rubbing kept resetting.
  it("when two wrecks grind together, one's nose on the other's side, both sliding along, then they slow down at least as fast as one wreck alone, within 15 %", () => {
    const lone = slideDecel([slidingWreck(0, 10)], 1);
    // T-bone grind: the faster wreck's nose on the slower one's side, both sliding along +z.
    const pair = slideDecel([slidingWreck(-4, 11), slidingWreck(0, 9, Math.PI / 2)], 1);
    assert.ok(pair >= lone * 0.85, `pair ${(pair / 9.81).toFixed(2)} g vs alone ${(lone / 9.81).toFixed(2)} g`);
  });
});

describe("given a crashed car yawing at 2 rad/s, with a door glass pane hung off its centre", () => {
  it("when the pane shatters, then the shard leaves with the pane's own velocity, to within 5 %, and the pane is moving faster than 0.5 m/s", () => {
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
});

describe("given a car with a drive speed of 0 m/s and a real velocity of (24, 0, -7) m/s", () => {
  it("when the speed of the physics slice is read, then it is 25 m/s, the wreck's real speed, not its stale drive speed", () => {
    const car = new DeformableCar(paint(), new THREE.Scene());
    car.speed = 0;
    car.velocity.set(24, 0, -7);
    assert.equal(sliceSpeed([car]), 25);
  });
});

describe("given a debris piece sliding along the ground at 6 m/s", () => {
  it("when it slides for 0.5 s at 60 Hz and again at 240 Hz, then it ends within 5 % of the same distance both times, so it loses the same speed per second at either rate", () => {
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
});

describe("given a debris system with room for 16 pieces, after a burst of 10 pieces has flown for 0.1 s", () => {
  it("when a second burst of 3 pieces is fired, then 13 pieces are live and the first burst's 10 pieces stay where they flew instead of being cut or teleported", () => {
    const debris = new DebrisSystem(new THREE.Scene(), 16);
    debris.burst(new THREE.Vector3(5, 0, 0), new THREE.Vector3(0, 0, -1), 10);
    debris.update(0.1, bounceGround);
    debris.burst(new THREE.Vector3(-5, 0, 0), new THREE.Vector3(0, 0, -1), 3);
    const items = debris.snapshot().items;
    assert.equal(items.length, 13, "live pieces after a 10 then a 3 burst");
    assert.equal(items.filter((p) => p.x > 2).length, 10, "the first burst's pieces stay where they flew");
  });
});

describe("given a debris system of 8 pieces whose first piece is nearly spent", () => {
  it("when it runs for six 1/60 s steps, then the spent piece is no longer drawn (scale 0), the live pieces have differing scales, and pieces 1 and 2 have different rotations", () => {
    const debris = new DebrisSystem(new THREE.Scene(), 8);
    debris.burst(new THREE.Vector3(), new THREE.Vector3(0, 0, -1), 8);
    debris["life"][0] = 0.05;
    for (let i = 0; i < 6; i++) debris.update(1 / 60, bounceGround);
    const m = new THREE.Matrix4();
    const col = new THREE.Vector3();
    const qs = [0, 1, 2].map(() => new THREE.Quaternion());
    const scales: number[] = [];
    for (let i = 0; i < 8; i++) {
      debris["mesh"].getMatrixAt(i, m);
      scales.push(col.setFromMatrixColumn(m, 0).length());
      qs[Math.min(i, 2)]!.setFromRotationMatrix(m.extractRotation(m.clone()));
    }
    assert.equal(scales[0], 0, "spent piece 0 is still drawn");
    assert.ok(new Set(scales.slice(1).map((x) => x.toFixed(4))).size > 1, `every live piece has scale ${scales[1]}`);
    assert.ok(qs[1]!.angleTo(qs[2]!) > 0.01, "pieces 1 and 2 share one rotation");
  });
});

describe("given a car moving sideways at 8 m/s with debris touching its leading flank", () => {
  it("when the flank sweeps the debris, then the debris leaves moving sideways faster than 8 m/s instead of being left inside the car", () => {
    const car = new DeformableCar(paint(), new THREE.Scene());
    car.spawnFacing(0, 0, 0, 0);
    car.velocity.set(8, 0, 0);
    const pos = new THREE.Vector3(0.85, 0.6, 0);
    const vel = new THREE.Vector3();
    bounceOffCar(car, pos, vel, 0.03);
    assert.ok(vel.x > 8, `debris vx ${vel.x.toFixed(2)} after the 8 m/s flank swept it`);
  });
});

describe("given two overlapping wrecks in shape deform mode, one resting and one sliding at 6 m/s along z and 4 m/s toward it", () => {
  it("when they scrape flank to flank, then they are reported in contact and the resting wreck takes over 60 kg·m/s of the slide through friction", () => {
    const a = spawnOffset(0, 0, "shape");
    const b = spawnOffset(0, 0, "shape");
    for (const m of b.d.masses) {
      m.world.x += 1.5;
      m.vel.set(-4, 0, 6);
    }
    for (const m of a.d.masses) m.vel.set(0, 0, 0);
    const pz = (d: StreamedDeformation) => d.masses.reduce((s, m) => s + m.vel.z * m.mass, 0);
    assert.ok(a.d.collideWith(b.d, 1 / 240), "overlapping masses are a contact the world reports as a touch (`World.partTouch`)");
    // 11 kg·m/s reaches it through the normals alone; Coulomb friction (μ 0.45) hands over ~147.
    assert.ok(pz(a.d) > 60, `the struck wreck took ${pz(a.d).toFixed(1)} kg·m/s of the 6 m/s slide`);
  });
});

forModes("given two cars overlapping head-on, each driving into the other", (mode) => {
  it("when they stay in contact for 20 frames, then neither car is thrown off the map (under 40 m from the origin), neither exceeds 60 m/s and none of their parts ends up NaN or past 60 m/s", () => {
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
      a.stepBreakage(DT);
      b.stepBreakage(DT);
      a.updateSkin();
      b.updateSkin();
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

describe("given particle positions read through snapshotPoints (the reader of debris positions)", () => {
  it("when one sample is dead and the other alive, then only the live one is reported, at a height of at least 0", () => {
    const pos = new Float32Array([1, 0.2, 2, 3, 250, 4]);
    const life = new Float32Array([0.4, 0]);
    const snap = snapshotPoints(pos, null, null, life, true);
    assert.equal(snap.items.length, 1);
    assert.ok(snap.items[0]!.y >= 0);
  });

  it("when a sample whose lifetime is still running sits at y = 250 (the height dead particles are parked at), then it is not reported as a live particle", () => {
    const pos = new Float32Array([0, 250, 0]);
    const life = new Float32Array([0.5]);
    const snap = snapshotPoints(pos, null, null, life, true);
    assert.equal(snap.items.length, 0);
  });
});

describe("given two cars driving head-on at each other, in shape deform mode", () => {
  const slow = runPair(28, 28);
  const fast = runPair(56, 56);
  const nose = (r: (typeof slow)[number]) => Math.max(r.noseMaxL, r.noseMaxR);

  const headOnNoseCrushCases = [
    { it: "when each car drives at 28 km/h, then each nose crushes between 0.15 and 0.40 m", speed: "slow", min: 0.15, max: 0.4 },
    { it: "when each car drives at 56 km/h, then each nose crushes between 0.35 and 0.70 m", speed: "fast", min: 0.35, max: 0.7 },
  ] as const;

  for (const testCase of headOnNoseCrushCases) {
    it(testCase.it, () => {
      for (const r of { slow, fast }[testCase.speed]) assert.ok(nose(r) >= testCase.min && nose(r) <= testCase.max, `nose ${nose(r).toFixed(3)}`);
    });
  }

  it("when the speed doubles from 28 to 56 km/h each, then each car's nose crushes more than 1.4 times deeper", () => {
    for (let i = 0; i < 2; i++) assert.ok(nose(fast[i]!) > 1.4 * nose(slow[i]!), `56=${nose(fast[i]!).toFixed(3)} 28=${nose(slow[i]!).toFixed(3)}`);
  });

  it("when they hit at 28 km/h each with full overlap, then the impact point stays within 0.2 m of the centre line on both cars", () => {
    for (const r of slow) assert.ok(Math.abs(r.impactLocalX) < 0.2, `impactLocal.x=${r.impactLocalX.toFixed(3)}`);
  });

  it("when the 2×56 km/h head-on is run in slow motion, then each nose's shortening is within 15 % of the full-speed head-on's, on both cars", () => {
    const slomo = runPair(56, 56, "head-on", { slomo: true });
    for (let i = 0; i < 2; i++) {
      for (const k of ["noseShortL", "noseShortR"] as const) {
        const ratio = slomo[i]![k] / fast[i]![k];
        assert.ok(Math.abs(ratio - 1) <= 0.15, `car ${i} ${k}: slomo ${slomo[i]![k].toFixed(3)} vs full ${fast[i]![k].toFixed(3)}`);
      }
    }
  });
});

describe("given a car hitting a wall at 64 km/h with a 40 % offset", () => {
  // The slab's cabin floor read the struck corner's current length: a corner springing back off the face moved
  // the floor out, its push stretched the nose further, and in slow motion (faster spring-back per sim second)
  // that ran away: R nose 0.330 → 0.255 in 7 ms of sim time (R 0.272 vs 0.330). `slabTravel` keeps the hit's low mark.
  it("when the hit is run in slow motion, then each nose's shortening is within 15 % of the full-speed hit's", () => {
    const full = runWall(64, 0.4);
    const slow = runWall(64, 0.4, "front", { slomo: true });
    for (const k of ["noseShortL", "noseShortR"] as const) {
      assert.ok(Math.abs(slow[k] / full[k] - 1) <= 0.15, `${k}: slomo ${slow[k].toFixed(3)} vs full ${full[k].toFixed(3)}`);
    }
  });
});

describe("given a car's glass panes, named for ragdoll ejection (a thrown-out driver)", () => {
  it("when a door pane is smashed, then that pane alone breaks, once, with a shard burst at the car, and the windscreen and doors are found on their own sides of the car", () => {
    const bursts: THREE.Vector3[] = [];
    const car = new DeformableCar(paint(), new THREE.Scene(), (origin) => bursts.push(origin.clone()));
    car.spawn(4, 9, 0);
    const at = (name: "windshield" | "doorL" | "doorR") => car.group.worldToLocal(car.glassWorld(name, new THREE.Vector3()));
    assert.ok(at("windshield").z > 0.6 && Math.abs(at("windshield").x) < 0.05, `windshield at ${at("windshield").toArray()}`);
    assert.ok(at("doorL").x < -0.6 && at("doorR").x > 0.6, `doors at ${at("doorL").x} / ${at("doorR").x}`);
    assert.equal(car.smashGlass("doorL"), true);
    assert.equal(car.smashGlass("doorL"), false, "a shattered pane smashed twice");
    assert.deepEqual(car.snapshot().glass, ["intact", "intact", "shattered", "intact", "intact", "intact"]);
    assert.equal(bursts.length, 1);
  });
});
