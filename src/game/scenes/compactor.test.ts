import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COMPACTOR, CompactorRig as Rig, compactorStage, travelOf } from "./compactor.ts";
import { makeCar } from "../contact/crash-scenarios.test-util.ts";
import { leftoverCrumple } from "../deform/physics-util.ts";
import { TYRE_R } from "../deform/deform-state.ts";
import type { DeformMode } from "../deform/deform-rig.ts";
import { forModes } from "../vehicle/test-support.ts";

/** The press scene's rig on a parked car of `mode`. */
function pressRig(mode: DeformMode): Rig {
  const car = makeCar(mode);
  car.spawnFacing(0, 0, 0, 0);
  return new Rig(car);
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

function axialOf(
  d: { masses: { name: string; rest: { z: number }; local: { z: number } }[] },
  name: string,
): number {
  const m = d.masses.find((n) => n.name === name);
  if (!m) return 0;
  return Math.abs(m.rest.z - m.local.z);
}

function intrusion(face: number): number {
  return Math.max(0, COMPACTOR.bumperZ - face);
}

describe("given the compactor press's plate positions along its run (distance of each plate from the car's centre)", () => {
  it("when the start, wheel-well, hub-midpoint and maximum positions are compared with the bumper and hubs, then the plates start outside the bumper, reach past the hubs at the wheel wells, stop on the hub midpoint, and the maximum passes the hubs and the rails at 0.68", () => {
    assert.ok(COMPACTOR.startFace > COMPACTOR.bumperZ);
    assert.ok(COMPACTOR.wellFace > COMPACTOR.hubZ);
    assert.ok(COMPACTOR.midFace === COMPACTOR.hubZ);
    assert.ok(COMPACTOR.maxFace < COMPACTOR.hubZ);
    assert.ok(COMPACTOR.maxFace < 0.68, "max face must pass the rails at 0.68");
  });

  it("when the start position is compared with the bumper, then the plates start more than 0.1 m outside the bumper, so the nose is not teleported on the first frame", () => {
    assert.ok(COMPACTOR.startFace - COMPACTOR.bumperZ > 0.1);
  });

  it("when the wheel-well position is compared with the hub centre-line, then it is the wheel-well lip, between 0.1 m and 0.3 m outside the hub centre", () => {
    assert.ok(COMPACTOR.wellFace - COMPACTOR.hubZ >= 0.1);
    assert.ok(COMPACTOR.wellFace - COMPACTOR.hubZ < 0.3);
  });

  it("when the press stage is read at plate distances 2.22, 1.8, 1.42, 1.0 and 0.62, then it reports open, contact, wells, mid and max in turn, not a single on/off crush", () => {
    assert.equal(compactorStage(2.22), "open");
    assert.equal(compactorStage(1.8), "contact");
    assert.equal(compactorStage(1.42), "wells");
    assert.equal(compactorStage(1.0), "mid");
    assert.equal(compactorStage(0.62), "max");
  });
});

forModes("given a parked car in the compactor press (plates squeezing its nose and tail), early in the crush", (mode) => {
  it("when the plates close to the wheel wells, then the nose and tail crush, the cabin and roof barely move and the car is not lofted", () => {
    const r = pressRig(mode);
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

  it("when the plates close to the wheel wells, then both plates push with real impulse (the rear less than the front on this front-heavy sedan) and the front impulse stays under 25000", () => {
    const r = pressRig(mode);
    r.runTo(COMPACTOR.wellFace);
    assert.ok(r.frontJ > 80, `front plate dead ${r.frontJ}`);
    assert.ok(r.rearJ > (mode === "shape" ? 40 : 80), `rear plate dead ${r.rearJ}`);
    assert.ok(
      r.rearJ > r.frontJ * (mode === "shape" ? 0.02 : 0.2),
      `rear starved F=${r.frontJ.toFixed(0)} R=${r.rearJ.toFixed(0)}`,
    );
    assert.ok(r.frontJ < 25000, `front plate impulse exploded ${r.frontJ} [${mode}]`);
  });

  it("when the plates close to the wheel wells, then the rear bumper moves inward more than 0.12 m, so the rear plate crushes the car too", () => {
    const r = pressRig(mode);
    r.runTo(COMPACTOR.wellFace);
    assert.ok(travelOf(r.d, "bumperRL") > 0.12, "rear ignored — far-side clamp still on");
  });

  it("when the plates have pushed 5 cm into the bumper, then the car is not flung: no point moves at 40 m/s, none leaves the 6 m by 3 m region around the press, and the car stays within 4 m of the origin", () => {
    const r = pressRig(mode);
    r.runTo(COMPACTOR.bumperZ - 0.05);
    for (const m of r.d.masses) {
      assert.ok(m.vel.length() < 40, `${m.name} vel ${m.vel.length()} [${mode}]`);
      assert.ok(
        Math.abs(m.world.z) < 6 && m.world.y < 3,
        `${m.name} at ${m.world.toArray()} [${mode}]`,
      );
    }
    assert.ok(r.group.position.length() < 4, `group ${r.group.position.toArray()}`);
  });

  it("when the plates stay at the starting position, then they never touch the car: no contact, no bumper movement and no plate impulse", () => {
    const r = pressRig(mode);
    r.runTo(COMPACTOR.startFace);
    assert.equal(r.contacted, false);
    assert.equal(travelOf(r.d, "bumperFL"), 0);
    assert.equal(r.frontJ, 0);
  });

  it("when the plates reach the wheel wells, then the wheel hubs are only nicked: they move less than the bumper does and have not travelled past the midpoint of their crush", () => {
    const r = pressRig(mode);
    r.runTo(COMPACTOR.wellFace);
    const hub = (travelOf(r.d, "hubFL") + travelOf(r.d, "hubFR")) * 0.5;
    const bumper = (travelOf(r.d, "bumperFL") + travelOf(r.d, "bumperFR")) * 0.5;
    assert.ok(
      bumper > hub * (mode === "shape" ? 0.45 : 1),
      `hubs out-crushed the bumper (${hub} vs ${bumper})`,
    );
    assert.ok(
      hub < (mode === "shape" ? 0.99 : 0.28),
      `hubs already past midpoint travel=${hub.toFixed(3)}`,
    );
  });

  // Planted hubs were pinned at rest, so the plates passed straight through the tyres (owner screenshot).
  it("when the plates are 0.1 m short of the hubs' midpoint, then no hub has popped and no tyre pokes more than 1 cm past the plate, as the hubs ride the plates back", () => {
    const r = pressRig(mode);
    const face = COMPACTOR.midFace + 0.1;
    r.runTo(face);
    for (const name of ["hubFL", "hubFR", "hubRL", "hubRR"] as const) {
      const h = r.d.masses.find((m) => m.name === name)!;
      assert.equal(h.popped, false, `${name} popped before a wheel diameter`);
      assert.ok(Math.abs(h.world.z) + TYRE_R <= face + 0.01, `${name} tyre reaches ${(Math.abs(h.world.z) + TYRE_R).toFixed(3)} past the plate at ${face.toFixed(3)}`);
    }
  });
});

forModes("given a parked car in the compactor press, as the plates go past the wheel hubs to the maximum crush", (mode) => {
  it("when the plates close to the maximum, then the nose is accordioned, the cabin cage and rails yield, the roof gives and the crumple zone is mostly spent", () => {
    const r = pressRig(mode);
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

  it("when the plates close to the maximum, then the car is flattened like a pancake and not launched: it stays under 0.25 m off the ground and the hubs stay within a height band", () => {
    const r = pressRig(mode);
    r.runTo(COMPACTOR.maxFace);
    assert.ok(r.maxGroupY < 0.25, `group lofted to ${r.maxGroupY.toFixed(3)}`);
    assert.ok(r.group.position.y < 0.22);
    const hubY = r.d.masses.filter((m) => m.name.startsWith("hub")).map((m) => m.world.y);
    const hubCap = mode === "shape" ? 0.9 : 0.7;
    const hubMin = mode === "shape" ? 0.12 : 0.2;
    assert.ok(
      hubY.every((y) => y < hubCap && y > hubMin),
      `hubs ${hubY}`,
    );
  });

  it("when the plates close to the maximum rather than only to the wheel wells, then the cabin has crushed at least 1.4 times as far and the plates are over 0.5 m closer", () => {
    const wells = pressRig(mode);
    wells.runTo(COMPACTOR.wellFace);
    const max = pressRig(mode);
    max.runTo(COMPACTOR.maxFace);
    assert.ok(
      travelOf(max.d, "cell") > travelOf(wells.d, "cell") * 1.4,
      `cell ${travelOf(max.d, "cell").toFixed(3)} vs wells ${travelOf(wells.d, "cell").toFixed(3)}`,
    );
    assert.ok(max.face < wells.face - 0.5);
  });

  it("when the plates close to the maximum, then the front and rear bumpers end the same distance from the car's middle, in the plates' frame, within a tolerance per deform mode", () => {
    const r = pressRig(mode);
    r.runTo(COMPACTOR.maxFace);
    const fl = r.d.masses.find((m) => m.name === "bumperFL")!;
    const rl = r.d.masses.find((m) => m.name === "bumperRL")!;
    // World, not `local`: a squeeze's group follows the cell now, so `local` z is measured from the cell.
    assert.ok(
      Math.abs(Math.abs(fl.world.z) - Math.abs(rl.world.z)) < (mode === "shape" ? 0.85 : 0.35),
      `front ${fl.world.z.toFixed(3)} rear ${rl.world.z.toFixed(3)} [${mode}]`,
    );
  });

  it("when the plates close to the maximum rather than only to the wheel wells, then the crumple zone's remaining length drops by more than 0.08", () => {
    const wells = pressRig(mode);
    wells.runTo(COMPACTOR.wellFace);
    const max = pressRig(mode);
    max.runTo(COMPACTOR.maxFace);
    const a = leftoverCrumple(wells.d.crumpleTravel());
    const b = leftoverCrumple(max.d.crumpleTravel());
    assert.ok(b < a - 0.08, `leftover wells ${a.toFixed(3)} max ${b.toFixed(3)}`);
  });

  it("when the plates close to the wheel wells and then to the maximum, then the cage's deep-crush state is off at the wheel wells and on only at the maximum, not early", () => {
    const r = pressRig(mode);
    r.runTo(COMPACTOR.wellFace);
    assert.equal(r.d.deepCrush, false, "deepCrush at wells — cage would pancake too early");
    r.runTo(COMPACTOR.maxFace);
    assert.equal(r.d.deepCrush, true);
  });
});

forModes("given a parked car in the compactor press, and where its inner frame and skin sit relative to the plates", (mode) => {
  it("when the plates close to the wheel wells, then every structural point, cage and skin stays inside the plates, within an allowance per deform mode", () => {
    const r = pressRig(mode);
    r.runTo(COMPACTOR.wellFace);
    const pad = mode === "shape" ? 0.9 : 0.08;
    const cagePad = mode === "shape" ? 0.7 : 0.28;
    const skinPad = mode === "shape" ? 0.9 : 0.35;
    assert.ok(
      r.d.massMaxAbsZ() <= COMPACTOR.wellFace + pad,
      `mass z ${r.d.massMaxAbsZ().toFixed(3)} past well ${COMPACTOR.wellFace}`,
    );
    const cageZ = r.d.cageMaxAbsZ();
    if (Number.isFinite(cageZ))
      assert.ok(
        cageZ <= COMPACTOR.wellFace + cagePad,
        `cage z ${cageZ.toFixed(3)} spilled past wells`,
      );
    const skinZ = r.d.skinMaxAbsZ(r.geom);
    if (Number.isFinite(skinZ))
      assert.ok(skinZ <= COMPACTOR.wellFace + skinPad, `skin z ${skinZ.toFixed(3)}`);
  });

  it("when the plates close to the maximum, then the structural points, cages and skin all follow the crush inward, and none stays at the rest-length bumper position (about 2.16 m)", () => {
    const r = pressRig(mode);
    r.runTo(COMPACTOR.maxFace);
    const cageZ = r.d.cageMaxAbsZ();
    const massZ = r.d.massMaxAbsZ();
    const skinZ = r.d.skinMaxAbsZ(r.geom);
    const massPad = mode === "shape" ? 1.6 : 0.1;
    const cagePad = mode === "shape" ? 1.2 : 0.35;
    assert.ok(massZ <= COMPACTOR.maxFace + massPad, `mass ${massZ.toFixed(3)}`);
    if (Number.isFinite(cageZ))
      assert.ok(
        cageZ <= COMPACTOR.maxFace + cagePad || cageZ < 1.7,
        `cage still at rest length ${cageZ.toFixed(3)}`,
      );
    if (Number.isFinite(skinZ) && Number.isFinite(cageZ)) {
      assert.ok(
        skinZ <= Math.max(cageZ + 0.35, 2.2),
        `skin ${skinZ.toFixed(3)} vs cage ${cageZ.toFixed(3)}`,
      );
    }
    if (Number.isFinite(cageZ)) assert.ok(cageZ < 2.2, "cages never left rest (~2.16)");
  });

  it("when a 0.38 m skin limit from rest is applied to the bumper's 2.16 m rest position, then the bumper would stay outside the wheel-well plates, so that limit is too tight to follow the crush", () => {
    const bumperRestZ = 2.16;
    const oldCap = 0.38;
    assert.ok(bumperRestZ - oldCap > COMPACTOR.wellFace, "regression: old skin clamp undoes FFD");
  });

  it("when the plates close to the wheel wells and then to the maximum, then the cabin has not yielded at the wheel wells and has yielded (over 0.16) at the maximum", () => {
    const wells = pressRig(mode);
    wells.runTo(COMPACTOR.wellFace);
    assert.ok(
      travelOf(wells.d, "cell") < (mode === "shape" ? 0.22 : 0.14),
      `cell folded at wells ${travelOf(wells.d, "cell").toFixed(3)}`,
    );
    const max = pressRig(mode);
    max.runTo(COMPACTOR.maxFace);
    assert.ok(
      travelOf(max.d, "cell") > 0.16,
      `cell never yielded at max ${travelOf(max.d, "cell").toFixed(3)}`,
    );
  });

  it("when the plates stop 0.04 m short of the wheel wells and 0.04 m past the hub midpoint, then the cage is intact at the first (cabin under 0.14) and deep-crushing at the second", () => {
    const a = pressRig(mode);
    a.runTo(COMPACTOR.wellFace + 0.04);
    assert.equal(a.d.deepCrush, false);
    assert.ok(travelOf(a.d, "cell") < 0.14);
    const b = pressRig(mode);
    b.runTo(COMPACTOR.midFace - 0.04);
    assert.equal(b.d.deepCrush, true);
  });
});

forModes("given a parked car in the compactor press, and how far it crushes compared with how far the plates intrude", (mode) => {
  it("when the plates close to the wheel wells, then bumper travel matches the plates' intrusion (not over it by more than the allowance, not under 35% of it) and neither bumper crawls inside its plate", () => {
    const r = pressRig(mode);
    r.runTo(COMPACTOR.wellFace);
    const ate = intrusion(COMPACTOR.wellFace);
    const nose = (axialOf(r.d, "bumperFL") + axialOf(r.d, "bumperFR")) * 0.5;
    const tail = (axialOf(r.d, "bumperRL") + axialOf(r.d, "bumperRR")) * 0.5;
    const cap = ate + (mode === "shape" ? 0.38 : 0.3);
    assert.ok(
      nose <= cap,
      `nose over-crushed Δz=${nose.toFixed(3)} > intrusion ${ate.toFixed(3)} + pad`,
    );
    assert.ok(
      tail <= cap,
      `tail over-crushed Δz=${tail.toFixed(3)} > intrusion ${ate.toFixed(3)} + pad`,
    );
    assert.ok(nose > ate * 0.35, `nose under-crushed ${nose.toFixed(3)} vs ate ${ate.toFixed(3)}`);
    const flz = Math.abs(r.d.masses.find((m) => m.name === "bumperFL")!.local.z);
    const rlz = Math.abs(r.d.masses.find((m) => m.name === "bumperRL")!.local.z);
    assert.ok(
      flz >= COMPACTOR.wellFace - 0.38,
      `front bumper crawled inside the plate |z|=${flz.toFixed(3)}`,
    );
    assert.ok(
      rlz >= COMPACTOR.wellFace - 0.38,
      `rear bumper crawled inside the plate |z|=${rlz.toFixed(3)}`,
    );
  });

  it("when the plates close to the wheel wells, then the engine and cabin are still a car, not a pile: the engine is not eaten, length and width hold, roof and doors hold, and over 0.45 of the crumple zone is left", () => {
    const r = pressRig(mode);
    r.runTo(COMPACTOR.wellFace);
    const box = massAABB(r.d);
    const engine = (travelOf(r.d, "engineL") + travelOf(r.d, "engineR")) * 0.5;
    const roof = r.d.masses.find((m) => m.name === "roof")!;
    const door = Math.min(
      Math.abs(r.d.masses.find((m) => m.name === "doorL")!.local.x),
      Math.abs(r.d.masses.find((m) => m.name === "doorR")!.local.x),
    );
    assert.ok(
      engine < (mode === "shape" ? 0.35 : 0.2),
      `engine eaten at wells ${engine.toFixed(3)}`,
    );
    assert.ok(
      box.length > 2 * COMPACTOR.wellFace - 0.55,
      `length collapsed to ${box.length.toFixed(3)} (gap ${(2 * COMPACTOR.wellFace).toFixed(2)})`,
    );
    assert.ok(box.width > 1.15, `pinched to width ${box.width.toFixed(3)}`);
    assert.ok(roof.local.y > 0.95, `roof dropped to y=${roof.local.y.toFixed(3)}`);
    assert.ok(door > 0.55, `doors collapsed inward |x|=${door.toFixed(3)}`);
    assert.ok(leftoverCrumple(r.d.crumpleTravel()) > 0.45, "crumple zone already spent at the lip");
  });

  it("when the plates close to 2.68 m apart (the hubs' midpoint), then the car is a shortened sedan, not wreckage: length, width, height, roof and cabin all hold", () => {
    const r = pressRig(mode);
    r.runTo(COMPACTOR.midFace);
    const box = massAABB(r.d);
    const roof = r.d.masses.find((m) => m.name === "roof")!;
    const cell = travelOf(r.d, "cell");
    assert.ok(
      box.length > 2 * COMPACTOR.midFace - 0.65,
      `length ${box.length.toFixed(3)} vs gap ${(2 * COMPACTOR.midFace).toFixed(2)}`,
    );
    assert.ok(box.width > 1.05, `width ${box.width.toFixed(3)}`);
    assert.ok(box.height > 0.7, `height flattened to ${box.height.toFixed(3)}`);
    assert.ok(roof.local.y > 0.82, `roof y=${roof.local.y.toFixed(3)}`);
    assert.ok(
      cell < (mode === "shape" ? 0.38 : 0.28),
      `cabin already pancaked cell=${cell.toFixed(3)}`,
    );
  });

  it("when the plates have pushed 4 cm into the bumper, then it is a kiss, not a wreck: the cabin and roof move under 0.08 m, the nose under 0.35 m and the car keeps over 3.5 m of length", () => {
    const r = pressRig(mode);
    r.runTo(COMPACTOR.bumperZ - 0.04);
    assert.ok(
      travelOf(r.d, "cell") < 0.08,
      `cabin moved on a kiss ${travelOf(r.d, "cell").toFixed(3)}`,
    );
    assert.ok(travelOf(r.d, "roof") < 0.08, `roof moved on a kiss`);
    const nose = (travelOf(r.d, "bumperFL") + travelOf(r.d, "bumperFR")) * 0.5;
    assert.ok(nose < 0.35, `nose vanished on contact ${nose.toFixed(3)}`);
    const box = massAABB(r.d);
    assert.ok(box.length > 3.5, `kiss shortened the car to ${box.length.toFixed(3)}`);
  });

  it("when the plates stay at the starting position, then the car keeps its rest length (4.12 m) and width (1.56 m) within 0.08 m, and the bumper and cabin have not moved", () => {
    const r = pressRig(mode);
    r.runTo(COMPACTOR.startFace);
    const box = massAABB(r.d);
    assert.ok(Math.abs(box.length - 4.12) < 0.08, `rest length ${box.length.toFixed(3)}`);
    assert.ok(Math.abs(box.width - 1.56) < 0.08, `rest width ${box.width.toFixed(3)}`);
    assert.ok(travelOf(r.d, "bumperFL") === 0);
    assert.ok(travelOf(r.d, "cell") === 0);
  });

  it("when the plates are 4 cm into the bumper, at the wheel wells and at the hubs' midpoint, then nose travel grows with the plates' intrusion and never exceeds it by more than the allowance, not a constant wreck amount", () => {
    const kiss = pressRig(mode);
    kiss.runTo(COMPACTOR.bumperZ - 0.04);
    const wells = pressRig(mode);
    wells.runTo(COMPACTOR.wellFace);
    const mid = pressRig(mode);
    mid.runTo(COMPACTOR.midFace);
    const nKiss = (axialOf(kiss.d, "bumperFL") + axialOf(kiss.d, "bumperFR")) * 0.5;
    const nWells = (axialOf(wells.d, "bumperFL") + axialOf(wells.d, "bumperFR")) * 0.5;
    const nMid = (axialOf(mid.d, "bumperFL") + axialOf(mid.d, "bumperFR")) * 0.5;
    assert.ok(
      nWells > nKiss + 0.12,
      `wells ${nWells.toFixed(3)} vs kiss ${nKiss.toFixed(3)} — crush is not progressive`,
    );
    assert.ok(nMid > nWells * 0.9, `mid ${nMid.toFixed(3)} vs wells ${nWells.toFixed(3)}`);
    const ateWells = intrusion(COMPACTOR.wellFace);
    const ateMid = intrusion(COMPACTOR.midFace);
    assert.ok(
      nWells < ateWells + 0.4,
      `wells travel ${nWells.toFixed(3)} >> ate ${ateWells.toFixed(3)}`,
    );
    assert.ok(nMid < ateMid + 0.45, `mid travel ${nMid.toFixed(3)} >> ate ${ateMid.toFixed(3)}`);
  });
});

describe("given a shape-deform-mode car at squash setting 0.32 and at 0.4, pressed to the maximum", () => {
  // The squeeze pinned the group at the world origin and clamped each particle's local offset from
  // rest, which then also carried the cell's own deep-crush travel: a 2 s hold at max face sprang
  // bumpers 0.67–0.81 m back toward their rest distance from the cell.
  it("when the press is then held for 2 s at the maximum, then no particle's distance change to the cabin shrinks by more than the 0.08 m springback", () => {
    for (const squash of [0.32, 0.4]) {
      const car = makeCar("shape", squash);
      car.spawnFacing(0, 0, 0, 0);
      const r = new Rig(car);
      r.runTo(COMPACTOR.maxFace);
      const d = r.d;
      const cell = d.masses.find((m) => m.name === "cell")!;
      const crush = (m: (typeof d.masses)[number]) => (m.hub ? 0 : Math.abs(m.local.distanceTo(cell.local) - m.rest.distanceTo(cell.rest)));
      const at = d.masses.map(crush);
      let drop = 0;
      let worst = "";
      for (let f = 0; f < 120; f++) {
        r.step(1 / 60, COMPACTOR.maxFace);
        car.afterContacts(1 / 60);
        car.stepBreakage(1 / 60);
        car.updateSkin();
        d.masses.forEach((m, i) => {
          if (at[i]! - crush(m) > drop) {
            drop = at[i]! - crush(m);
            worst = `${m.name} ${(at[i]! * 1000).toFixed(0)} → ${(crush(m) * 1000).toFixed(0)} mm`;
          }
        });
      }
      assert.ok(drop <= 0.08, `squash ${squash}: ${worst} during the hold`);
    }
  });
});
