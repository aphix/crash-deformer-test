import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { makeBox, partContact } from "../contact/external-contact.ts";
import { makeCar, runWall } from "../contact/crash-scenarios.test-util.ts";
import { DeformableCar } from "../vehicle/car.ts";
import type { DetachPart } from "../vehicle/car-core.ts";
import { PANEL_SMUSH_MIN } from "../vehicle/car-wear.ts";
import { assertSameDigest, DT, paint } from "../vehicle/test-support.ts";
import type { DoorScenario, RamShot } from "./door-rig.ts";
import { fireRam } from "./door-rig.test-util.ts";

/**
 * Frame invariance (docs/CONTACT_PARITY.md, docs/PANEL_FLAP.md): what the Doors ram does depends only on the relative motion.
 * The ram running along a parked car and the car driven into a still ram at the same closing speed meet through the same
 * contact, so a door, a mirror and a quarter panel end the same way: shut or torn, mirror on or off, the hinge load, the panel's
 * dent. Every scenario × both directions of travel × {ram moves, car moves} × both sides.
 */

type Shot = { scenario: DoorScenario; kph: number; kg: number; note: string };

const SHOTS: Shot[] = [
  { scenario: "mirror", kph: 4, kg: 60, note: "folds, breaks the mirror" },
  { scenario: "mirror", kph: 50, kg: 1500, note: "fast heavy" },
  { scenario: "overOpen", kph: 5, kg: 120, note: "strap holds" },
  { scenario: "overOpen", kph: 15, kg: 300, note: "tears door off the other way" },
  { scenario: "shut", kph: 4, kg: 300, note: "re-closes and latches" },
  { scenario: "shut", kph: 40, kg: 300, note: "slams it off" },
  { scenario: "panelPush", kph: 1.5, kg: 60, note: "smushes the panel back" },
  { scenario: "panelPush", kph: 3, kg: 120, note: "smushes the panel back" },
  { scenario: "panelPush", kph: 12, kg: 300, note: "tears the panel off" },
  { scenario: "panelPull", kph: 1.5, kg: 60, note: "opens the panel more, holds" },
  { scenario: "panelPull", kph: 4, kg: 300, note: "tears the panel off" },
];

function same(a: RamShot, b: RamShot, what: string): void {
  assertSameDigest([...a.detached].sort(), [...b.detached].sort(), `${what}: parts off ${a.detached} vs ${b.detached}`);
  assert.equal(a.latched, b.latched, `${what}: latch`);
  assert.ok(Math.abs(a.doorDeg - b.doorDeg) < 0.5, `${what}: door ${a.doorDeg.toFixed(2)}° vs ${b.doorDeg.toFixed(2)}°`);
  assert.ok(Math.abs(a.mirrorFoldDeg - b.mirrorFoldDeg) < 0.5, `${what}: mirror fold ${a.mirrorFoldDeg} vs ${b.mirrorFoldDeg}`);
  assert.ok(Math.abs(a.hingeLoadJ - b.hingeLoadJ) <= 0.01 * Math.max(a.hingeLoadJ, 1), `${what}: hinge load ${a.hingeLoadJ} vs ${b.hingeLoadJ} J`);
  assert.ok(Math.abs(a.panelHinge - b.panelHinge) < 0.005, `${what}: panel ${a.panelHinge} vs ${b.panelHinge}`);
  assert.equal(a.ramStopped, b.ramStopped, `${what}: ram stopped`);
}

describe("given a ram and a parked car meeting at the same closing speed, once with the ram moving and once with the car moving (mirror, overOpen and shut: the door scenes; panelPush and panelPull: the ram pushes the quarter panel in or pulls it out)", () => {
  for (const side of [-1, 1] as const) {
    for (const s of SHOTS) {
      it(`when the ${s.scenario} shot (${s.note}) hits the ${side < 0 ? "L" : "R"} side at ${s.kph} km/h with ${s.kg} kg, then the moving car ends with the same parts off, latch, door, mirror fold, hinge load, panel dent and ram stop as the moving ram`, () => {
        const ram = fireRam(makeCar(), s.scenario, { kph: s.kph, kg: s.kg, side });
        const car = fireRam(makeCar(), s.scenario, { kph: s.kph, kg: s.kg, side, carMoves: true });
        same(ram, car, `${s.scenario}`);
      });
    }
  }

  it("when the table of shots is read, then it covers every door scene and a panel torn off, smushed back and opened, in both travel directions", () => {
    const dirs = new Set(SHOTS.map((s) => s.scenario));
    assert.deepEqual([...dirs].sort(), ["mirror", "overOpen", "panelPull", "panelPush", "shut"]);
    const outcomes = SHOTS.map((s) => fireRam(makeCar(), s.scenario, { kph: s.kph, kg: s.kg, side: 1 }));
    assert.ok(outcomes.some((o) => o.detached.includes("quarterR")), "no shot tore the panel");
    assert.ok(outcomes.some((o) => o.panelHinge > PANEL_SMUSH_MIN && o.panelHinge < 0.4 && !o.detached.includes("quarterR")), "no shot smushed it");
    assert.ok(outcomes.some((o) => o.panelHinge > 0.8 && !o.detached.includes("quarterR")), "no shot opened it");
  });
});

class Probe extends DeformableCar {
  part(name: string): DetachPart {
    return this.parts.find((p) => p.name === name)!;
  }
}

describe("given a quarter panel smushed back by a 56 km/h rear crash into a wall", () => {
  it("when the car steps 60 frames of its own hinge target, then the pushed-back panel stays at its dent instead of rising, while a panel that was not pushed does rise above 0.25", () => {
    const hit = (smush: boolean): number => {
      const car = new Probe(paint(), new THREE.Scene());
      car.deform.setMode("shape");
      runWall(56, 0.3, "rear", { car });
      const p = car.part("quarterR");
      const was = p.hingeT;
      assert.ok(was > 0.25 && !p.detached, `the wall left the panel at ${was}`);
      if (smush) car.bendPanel(1, 0.15);
      else {
        p.hingeT = 0.15;
      }
      for (let f = 0; f < 60; f++) car.stepBreakage(DT);
      return p.hingeT;
    };
    assert.ok(Math.abs(hit(true) - 0.15) < 1e-9, `a pushed-back panel rose to ${hit(true)}`);
    assert.ok(hit(false) > 0.25, "the control did not rise");
  });
});

/**
 * The shared contact itself, with world positions: a box standing still and the car driven at it (the box takes the speed the
 * striker loses), against the box driven along a parked car. No rig between them.
 */
function strike(part: "door" | "panel", dir: 1 | -1, kph: number, kg: number, carMoves: boolean): { off: string[]; door: number; latched: boolean; panel: number } {
  const car = makeCar();
  const u = kph / 3.6;
  car.spawnFacing(0, 0, 0, 0);
  car.velocity.set(0, 0, carMoves ? -dir * u : 0);
  car.sampleMotion();
  if (part === "door") car.setDoorOpen(1, (55 * Math.PI) / 180);
  else car.setPanelOpen(1, 0.45);
  const box = makeBox();
  const inner = part === "door" ? 1.1 : 0.885;
  box.hx = 0.3;
  box.hy = 0.225;
  box.hz = 0.25;
  box.x = inner + box.hx;
  box.y = 0.525;
  box.yaw = dir > 0 ? 0 : Math.PI;
  box.z = -dir * (2.8 + box.hz);
  box.vz = carMoves ? 0 : dir * u;
  box.kg = kg;
  const h = 0.0005;
  for (let t = 0; t < 7 / u && t < 20; t += h) {
    car.group.position.z += car.velocity.z * h;
    box.z += box.vz * h;
    const hit = partContact(car, box, h);
    if (hit.du > 0) box.vz -= hit.nz * hit.du;
    car.swingDoors(h);
  }
  return {
    off: (["doorR", "quarterR"] as const).filter((n) => car.partOff(n)),
    door: car.doorHinge(1).theta,
    latched: car.doorHinge(1).latched,
    panel: car.quarterPanel(1).hingeT,
  };
}

describe("given a still box with the car driven at it, and the same box driven along a parked car", () => {
  type Strike = ReturnType<typeof strike>;
  const CASES: [string, "door" | "panel", 1 | -1, number, number, (r: Strike) => boolean][] = [
    ["door driven shut, light", "door", -1, 4, 300, (r) => r.off.length === 0 && r.latched],
    ["door slammed off", "door", -1, 40, 300, (r) => r.off.join() === "doorR"],
    ["door driven past its stop, soft", "door", 1, 5, 120, (r) => r.off.length === 0 && !r.latched && r.door > 1.1],
    ["door torn off the other way", "door", 1, 15, 300, (r) => r.off.join() === "doorR"],
    ["panel pushed back", "panel", 1, 3, 120, (r) => r.off.length === 0 && r.panel < 0.4],
    ["panel torn off from behind", "panel", 1, 12, 300, (r) => r.off.join() === "quarterR"],
    ["panel pulled out, soft", "panel", -1, 1.5, 60, (r) => r.off.length === 0 && r.panel > 0.8],
    ["panel torn off from the front", "panel", -1, 4, 300, (r) => r.off.join() === "quarterR"],
  ];
  for (const [name, part, dir, kph, kg, meaningful] of CASES) {
    it(`when the shot is "${name}", then the moving car ends with the same parts off, latch, door and panel as the moving box`, () => {
      const box = strike(part, dir, kph, kg, false);
      const car = strike(part, dir, kph, kg, true);
      assert.ok(meaningful(box), `the shot did not do what it is named for: ${JSON.stringify(box)}`);
      assertSameDigest(car.off, box.off, "parts off");
      assert.equal(car.latched, box.latched, "latch");
      assert.ok(Math.abs(car.door - box.door) < 0.01, `door ${car.door} vs ${box.door} rad`);
      assert.ok(Math.abs(car.panel - box.panel) < 0.01, `panel ${car.panel} vs ${box.panel}`);
    });
  }
});
