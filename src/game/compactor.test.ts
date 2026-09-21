import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COMPACTOR, CompactorRig, compactorStage, travelOf } from "./compactor.ts";
import { leftoverCrumple } from "./physics-util.ts";
import type { DeformMode } from "./streamed-deform.ts";

const MODES: DeformMode[] = ["lattice", "shape"];

function forModes(title: string, fn: (mode: DeformMode) => void): void {
  for (const mode of MODES) describe(`${title} [${mode}]`, () => fn(mode));
}

function massAABB(d: { masses: { local: { x: number; y: number; z: number } }[] }): {
  length: number;
  width: number;
  height: number;
} {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const m of d.masses) {
    minX = Math.min(minX, m.local.x);
    maxX = Math.max(maxX, m.local.x);
    minY = Math.min(minY, m.local.y);
    maxY = Math.max(maxY, m.local.y);
    minZ = Math.min(minZ, m.local.z);
    maxZ = Math.max(maxZ, m.local.z);
  }
  return { length: maxZ - minZ, width: maxX - minX, height: maxY - minY };
}

function axialOf(d: { masses: { name: string; rest: { z: number }; local: { z: number } }[] }, name: string): number {
  const m = d.masses.find((n) => n.name === name);
  if (!m) return 0;
  return Math.abs(m.rest.z - m.local.z);
}

function intrusion(face: number): number {
  return Math.max(0, COMPACTOR.bumperZ - face);
}

describe("compactor constants", () => {
  it("good: plates start past the bumper and pass the hubs on the way in", () => {
    assert.ok(COMPACTOR.startFace > COMPACTOR.bumperZ);
    assert.ok(COMPACTOR.wellFace > COMPACTOR.hubZ);
    assert.ok(COMPACTOR.midFace === COMPACTOR.hubZ);
    assert.ok(COMPACTOR.maxFace < COMPACTOR.hubZ);
    assert.ok(COMPACTOR.maxFace < 0.68, "max face must pass the rails at 0.68");
  });

  it("bad: startFace inside the bumper would teleport the nose on frame 1", () => {
    assert.ok(COMPACTOR.startFace - COMPACTOR.bumperZ > 0.1);
  });

  it("edge: wellFace is the well lip, not the hub centre", () => {
    assert.ok(COMPACTOR.wellFace - COMPACTOR.hubZ >= 0.1);
    assert.ok(COMPACTOR.wellFace - COMPACTOR.hubZ < 0.3);
  });

  it("close-but-wrong: stages are descending faces, not a single on/off crush", () => {
    assert.equal(compactorStage(2.22), "open");
    assert.equal(compactorStage(1.8), "contact");
    assert.equal(compactorStage(1.42), "wells");
    assert.equal(compactorStage(1.0), "mid");
    assert.equal(compactorStage(0.62), "max");
  });
});

forModes("compactor until wheel wells", (mode) => {
  it("good: nose and tail crush, cabin barely moves, no loft", () => {
    const r = new CompactorRig(mode);
    r.runTo(COMPACTOR.wellFace);
    const nose = (travelOf(r.d, "bumperFL") + travelOf(r.d, "bumperFR")) * 0.5;
    const tail = (travelOf(r.d, "bumperRL") + travelOf(r.d, "bumperRR")) * 0.5;
    const cell = travelOf(r.d, "cell");
    const roof = travelOf(r.d, "roof");
    assert.ok(nose > 0.18, `nose ${nose.toFixed(3)}`);
    assert.ok(tail > 0.18, `tail ${tail.toFixed(3)}`);
    assert.ok(cell < (mode === "shape" ? 0.22 : 0.14), `cabin collapsed early ${cell.toFixed(3)}`);
    assert.ok(roof < (mode === "shape" ? 0.22 : 0.16), `roof ${roof.toFixed(3)}`);
    assert.ok(r.maxGroupY < 0.22, `lofted group.y=${r.maxGroupY.toFixed(3)}`);
    assert.ok(r.maxCellY < 1.15, `cell world.y ${r.maxCellY.toFixed(3)}`);
  });

  it("good: both plates take real impulse (front-heavy sedan, not 50/50)", () => {
    const r = new CompactorRig(mode);
    r.runTo(COMPACTOR.wellFace);
    assert.ok(r.frontJ > 80, `front plate dead ${r.frontJ}`);
    assert.ok(r.rearJ > (mode === "shape" ? 40 : 80), `rear plate dead ${r.rearJ}`);
    assert.ok(r.rearJ > r.frontJ * (mode === "shape" ? 0.02 : 0.2), `rear starved F=${r.frontJ.toFixed(0)} R=${r.rearJ.toFixed(0)}`);
    assert.ok(r.frontJ < 25000, `front plate impulse exploded ${r.frontJ} [${mode}]`);
  });

  it("bad: a one-sided inward would leave the rear bumper at rest", () => {
    const r = new CompactorRig(mode);
    r.runTo(COMPACTOR.wellFace);
    assert.ok(travelOf(r.d, "bumperRL") > 0.12, "rear ignored — far-side clamp still on");
  });

  it("bad: first plate contact does not light-speed the car", () => {
    const r = new CompactorRig(mode);
    r.runTo(COMPACTOR.bumperZ - 0.05);
    for (const m of r.d.masses) {
      assert.ok(m.vel.length() < 40, `${m.name} vel ${m.vel.length()} [${mode}]`);
      assert.ok(Math.abs(m.world.z) < 6 && m.world.y < 3, `${m.name} at ${m.world.toArray()} [${mode}]`);
    }
    assert.ok(r.group.position.length() < 4, `group ${r.group.position.toArray()}`);
  });

  it("edge: plates sitting at startFace never touch the car", () => {
    const r = new CompactorRig(mode);
    r.runTo(COMPACTOR.startFace);
    assert.equal(r.contacted, false);
    assert.equal(travelOf(r.d, "bumperFL"), 0);
    assert.equal(r.frontJ, 0);
  });

  it("close-but-wrong: at the well lip the hubs are nicked, not folded past the midpoint", () => {
    const r = new CompactorRig(mode);
    r.runTo(COMPACTOR.wellFace);
    const hub = (travelOf(r.d, "hubFL") + travelOf(r.d, "hubFR")) * 0.5;
    const bumper = (travelOf(r.d, "bumperFL") + travelOf(r.d, "bumperFR")) * 0.5;
    assert.ok(bumper > hub * (mode === "shape" ? 0.45 : 1), `hubs out-crushed the bumper (${hub} vs ${bumper})`);
    assert.ok(hub < (mode === "shape" ? 0.99 : 0.28), `hubs already past midpoint travel=${hub.toFixed(3)}`);
  });
});

forModes("compactor max crush (past wheel midpoint)", (mode) => {
  it("good: cage and rails yield once the plates pass the hubs", () => {
    const r = new CompactorRig(mode);
    r.runTo(COMPACTOR.maxFace);
    const cell = travelOf(r.d, "cell");
    const rail = Math.max(travelOf(r.d, "railL"), travelOf(r.d, "railR"));
    const roof = travelOf(r.d, "roof");
    const nose = (travelOf(r.d, "bumperFL") + travelOf(r.d, "bumperFR")) * 0.5;
    assert.ok(nose > 0.7, `nose should be accordioned, got ${nose.toFixed(3)}`);
    assert.ok(cell > 0.16, `rollcage never yielded cell=${cell.toFixed(3)}`);
    assert.ok(rail > 0.2, `rails never folded ${rail.toFixed(3)}`);
    assert.ok(roof > 0.08, `roof stayed a brick ${roof.toFixed(3)}`);
    assert.ok(leftoverCrumple(r.d.crumpleTravel()) < 0.55, "still a full crumple zone at max");
  });

  it("good: still no pop — a max crush is a pancake, not a launch", () => {
    const r = new CompactorRig(mode);
    r.runTo(COMPACTOR.maxFace);
    assert.ok(r.maxGroupY < 0.25, `group lofted to ${r.maxGroupY.toFixed(3)}`);
    assert.ok(r.group.position.y < 0.22);
    const hubY = r.d.masses.filter((m) => m.name.startsWith("hub")).map((m) => m.world.y);
    const hubCap = mode === "shape" ? 0.9 : 0.7;
    const hubMin = mode === "shape" ? 0.12 : 0.2;
    assert.ok(hubY.every((y) => y < hubCap && y > hubMin), `hubs ${hubY}`);
  });

  it("bad: max crush is not just the wells pose with a different label", () => {
    const wells = new CompactorRig(mode);
    wells.runTo(COMPACTOR.wellFace);
    const max = new CompactorRig(mode);
    max.runTo(COMPACTOR.maxFace);
    assert.ok(
      travelOf(max.d, "cell") > travelOf(wells.d, "cell") * 1.4,
      `cell ${travelOf(max.d, "cell").toFixed(3)} vs wells ${travelOf(wells.d, "cell").toFixed(3)}`,
    );
    assert.ok(max.face < wells.face - 0.5);
  });

  it("edge: walls stay symmetric — |z| of front bumper rest-travel ≈ rear", () => {
    const r = new CompactorRig(mode);
    r.runTo(COMPACTOR.maxFace);
    const fl = r.d.masses.find((m) => m.name === "bumperFL")!;
    const rl = r.d.masses.find((m) => m.name === "bumperRL")!;
    assert.ok(
      Math.abs(Math.abs(fl.local.z) - Math.abs(rl.local.z)) < (mode === "shape" ? 0.85 : 0.35),
      `front ${fl.local.z.toFixed(3)} rear ${rl.local.z.toFixed(3)} [${mode}]`,
    );
  });

  it("close-but-wrong: leftover crumple uses remaining length, so max face must drop it below wells", () => {
    const wells = new CompactorRig(mode);
    wells.runTo(COMPACTOR.wellFace);
    const max = new CompactorRig(mode);
    max.runTo(COMPACTOR.maxFace);
    const a = leftoverCrumple(wells.d.crumpleTravel());
    const b = leftoverCrumple(max.d.crumpleTravel());
    assert.ok(b < a - 0.08, `leftover wells ${a.toFixed(3)} max ${b.toFixed(3)}`);
  });

  it("close-but-wrong: deepCrush only arms after the hub midpoint, not at the well lip", () => {
    const r = new CompactorRig(mode);
    r.runTo(COMPACTOR.wellFace);
    assert.equal(r.d.deepCrush, false, "deepCrush at wells — cage would pancake too early");
    r.runTo(COMPACTOR.maxFace);
    assert.equal(r.d.deepCrush, true);
  });
});

forModes("compactor lattice and skin stay inside the plates", (mode) => {
  it("good: until the wells, every mass and cage is inside the plates", () => {
    const r = new CompactorRig(mode);
    r.runTo(COMPACTOR.wellFace);
    const pad = mode === "shape" ? 0.9 : 0.08;
    const cagePad = mode === "shape" ? 0.7 : 0.28;
    const skinPad = mode === "shape" ? 0.9 : 0.35;
    assert.ok(r.d.massMaxAbsZ() <= COMPACTOR.wellFace + pad, `mass z ${r.d.massMaxAbsZ().toFixed(3)} past well ${COMPACTOR.wellFace}`);
    const cageZ = r.d.cageMaxAbsZ();
    if (Number.isFinite(cageZ)) assert.ok(cageZ <= COMPACTOR.wellFace + cagePad, `cage z ${cageZ.toFixed(3)} spilled past wells`);
    const skinZ = r.d.skinMaxAbsZ(r.geom);
    if (Number.isFinite(skinZ)) assert.ok(skinZ <= COMPACTOR.wellFace + skinPad, `skin z ${skinZ.toFixed(3)}`);
  });

  it("good: max crush keeps cages with the masses, not at rest bumper length", () => {
    const r = new CompactorRig(mode);
    r.runTo(COMPACTOR.maxFace);
    const cageZ = r.d.cageMaxAbsZ();
    const massZ = r.d.massMaxAbsZ();
    const skinZ = r.d.skinMaxAbsZ(r.geom);
    const massPad = mode === "shape" ? 1.6 : 0.1;
    const cagePad = mode === "shape" ? 1.2 : 0.35;
    assert.ok(massZ <= COMPACTOR.maxFace + massPad, `mass ${massZ.toFixed(3)}`);
    if (Number.isFinite(cageZ)) assert.ok(cageZ <= COMPACTOR.maxFace + cagePad || cageZ < 1.7, `cage still at rest length ${cageZ.toFixed(3)}`);
    if (Number.isFinite(skinZ) && Number.isFinite(cageZ)) {
      assert.ok(skinZ <= Math.max(cageZ + 0.35, 2.2), `skin ${skinZ.toFixed(3)} vs cage ${cageZ.toFixed(3)}`);
    }
    if (Number.isFinite(cageZ)) assert.ok(cageZ < 2.2, "cages never left rest (~2.16)");
  });

  it("bad: a 0.38m rest-relative skin cap would leave the bumper outside the wells", () => {
    const bumperRestZ = 2.16;
    const oldCap = 0.38;
    assert.ok(bumperRestZ - oldCap > COMPACTOR.wellFace, "regression: old skin clamp undoes FFD");
  });

  it("good: until wells the cell has not yielded; past the hub it has", () => {
    const wells = new CompactorRig(mode);
    wells.runTo(COMPACTOR.wellFace);
    assert.ok(travelOf(wells.d, "cell") < (mode === "shape" ? 0.22 : 0.14), `cell folded at wells ${travelOf(wells.d, "cell").toFixed(3)}`);
    const max = new CompactorRig(mode);
    max.runTo(COMPACTOR.maxFace);
    assert.ok(travelOf(max.d, "cell") > 0.16, `cell never yielded at max ${travelOf(max.d, "cell").toFixed(3)}`);
  });

  it("close-but-wrong: wellFace + 0.04 still has an intact cage; midFace - 0.04 has started", () => {
    const a = new CompactorRig(mode);
    a.runTo(COMPACTOR.wellFace + 0.04);
    assert.equal(a.d.deepCrush, false);
    assert.ok(travelOf(a.d, "cell") < 0.14);
    const b = new CompactorRig(mode);
    b.runTo(COMPACTOR.midFace - 0.04);
    assert.equal(b.d.deepCrush, true);
  });
});

forModes("compactor stiffness (does not crush too much)", (mode) => {
  it("good: at the well lip bumper travel matches plate intrusion, not a vanished nose", () => {
    const r = new CompactorRig(mode);
    r.runTo(COMPACTOR.wellFace);
    const ate = intrusion(COMPACTOR.wellFace);
    const nose = (axialOf(r.d, "bumperFL") + axialOf(r.d, "bumperFR")) * 0.5;
    const tail = (axialOf(r.d, "bumperRL") + axialOf(r.d, "bumperRR")) * 0.5;
    const cap = ate + (mode === "shape" ? 0.38 : 0.3);
    assert.ok(nose <= cap, `nose over-crushed Δz=${nose.toFixed(3)} > intrusion ${ate.toFixed(3)} + pad`);
    assert.ok(tail <= cap, `tail over-crushed Δz=${tail.toFixed(3)} > intrusion ${ate.toFixed(3)} + pad`);
    assert.ok(nose > ate * 0.35, `nose under-crushed ${nose.toFixed(3)} vs ate ${ate.toFixed(3)}`);
    const flz = Math.abs(r.d.masses.find((m) => m.name === "bumperFL")!.local.z);
    const rlz = Math.abs(r.d.masses.find((m) => m.name === "bumperRL")!.local.z);
    assert.ok(flz >= COMPACTOR.wellFace - 0.38, `front bumper crawled inside the plate |z|=${flz.toFixed(3)}`);
    assert.ok(rlz >= COMPACTOR.wellFace - 0.38, `rear bumper crawled inside the plate |z|=${rlz.toFixed(3)}`);
  });

  it("good: until the wells the engine and cabin are still a car, not a pile", () => {
    const r = new CompactorRig(mode);
    r.runTo(COMPACTOR.wellFace);
    const box = massAABB(r.d);
    const engine = (travelOf(r.d, "engineL") + travelOf(r.d, "engineR")) * 0.5;
    const roof = r.d.masses.find((m) => m.name === "roof")!;
    const door = Math.min(
      Math.abs(r.d.masses.find((m) => m.name === "doorL")!.local.x),
      Math.abs(r.d.masses.find((m) => m.name === "doorR")!.local.x),
    );
    assert.ok(engine < (mode === "shape" ? 0.35 : 0.2), `engine eaten at wells ${engine.toFixed(3)}`);
    assert.ok(box.length > 2 * COMPACTOR.wellFace - 0.55, `length collapsed to ${box.length.toFixed(3)} (gap ${ (2 * COMPACTOR.wellFace).toFixed(2)})`);
    assert.ok(box.width > 1.15, `pinched to width ${box.width.toFixed(3)}`);
    assert.ok(roof.local.y > 0.95, `roof dropped to y=${roof.local.y.toFixed(3)}`);
    assert.ok(door > 0.55, `doors collapsed inward |x|=${door.toFixed(3)}`);
    assert.ok(leftoverCrumple(r.d.crumpleTravel()) > 0.45, "crumple zone already spent at the lip");
  });

  it("good: at the 2.68m gap (hub midpoint) it is a shortened sedan, not wreckage", () => {
    const r = new CompactorRig(mode);
    r.runTo(COMPACTOR.midFace);
    const box = massAABB(r.d);
    const roof = r.d.masses.find((m) => m.name === "roof")!;
    const cell = travelOf(r.d, "cell");
    assert.ok(box.length > 2 * COMPACTOR.midFace - 0.65, `length ${box.length.toFixed(3)} vs gap ${(2 * COMPACTOR.midFace).toFixed(2)}`);
    assert.ok(box.width > 1.05, `width ${box.width.toFixed(3)}`);
    assert.ok(box.height > 0.7, `height flattened to ${box.height.toFixed(3)}`);
    assert.ok(roof.local.y > 0.82, `roof y=${roof.local.y.toFixed(3)}`);
    assert.ok(cell < (mode === "shape" ? 0.38 : 0.28), `cabin already pancaked cell=${cell.toFixed(3)}`);
  });

  it("bad: a bumper kiss is not a wreck", () => {
    const r = new CompactorRig(mode);
    r.runTo(COMPACTOR.bumperZ - 0.04);
    assert.ok(travelOf(r.d, "cell") < 0.08, `cabin moved on a kiss ${travelOf(r.d, "cell").toFixed(3)}`);
    assert.ok(travelOf(r.d, "roof") < 0.08, `roof moved on a kiss`);
    const nose = (travelOf(r.d, "bumperFL") + travelOf(r.d, "bumperFR")) * 0.5;
    assert.ok(nose < 0.35, `nose vanished on contact ${nose.toFixed(3)}`);
    const box = massAABB(r.d);
    assert.ok(box.length > 3.5, `kiss shortened the car to ${box.length.toFixed(3)}`);
  });

  it("edge: plates parked at startFace leave rest length/width/height", () => {
    const r = new CompactorRig(mode);
    r.runTo(COMPACTOR.startFace);
    const box = massAABB(r.d);
    assert.ok(Math.abs(box.length - 4.12) < 0.08, `rest length ${box.length.toFixed(3)}`);
    assert.ok(Math.abs(box.width - 1.56) < 0.08, `rest width ${box.width.toFixed(3)}`);
    assert.ok(travelOf(r.d, "bumperFL") === 0);
    assert.ok(travelOf(r.d, "cell") === 0);
  });

  it("close-but-wrong: bumper travel tracks intrusion, not a constant wreck amount", () => {
    const kiss = new CompactorRig(mode);
    kiss.runTo(COMPACTOR.bumperZ - 0.04);
    const wells = new CompactorRig(mode);
    wells.runTo(COMPACTOR.wellFace);
    const mid = new CompactorRig(mode);
    mid.runTo(COMPACTOR.midFace);
    const nKiss = (axialOf(kiss.d, "bumperFL") + axialOf(kiss.d, "bumperFR")) * 0.5;
    const nWells = (axialOf(wells.d, "bumperFL") + axialOf(wells.d, "bumperFR")) * 0.5;
    const nMid = (axialOf(mid.d, "bumperFL") + axialOf(mid.d, "bumperFR")) * 0.5;
    assert.ok(nWells > nKiss + 0.12, `wells ${nWells.toFixed(3)} vs kiss ${nKiss.toFixed(3)} — crush is not progressive`);
    assert.ok(nMid > nWells * 0.9, `mid ${nMid.toFixed(3)} vs wells ${nWells.toFixed(3)}`);
    const ateWells = intrusion(COMPACTOR.wellFace);
    const ateMid = intrusion(COMPACTOR.midFace);
    assert.ok(nWells < ateWells + 0.4, `wells travel ${nWells.toFixed(3)} >> ate ${ateWells.toFixed(3)}`);
    assert.ok(nMid < ateMid + 0.45, `mid travel ${nMid.toFixed(3)} >> ate ${ateMid.toFixed(3)}`);
  });
});
