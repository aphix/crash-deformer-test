import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { applyDrive, idleDrive } from "../vehicle/car-drive.ts";
import { armKill, assignClass, CLASSES, HANDLING, killClass, VEHICLE_CLASS_IDS, type VehicleClassId } from "../vehicle/vehicle-classes.ts";
import { newWorld, settleStep, stepWorld } from "../engine/world-step.ts";
import { INITIAL_HUD } from "../hud/hud-store.ts";
import { physicsSlice, satCars, sliceSpeed } from "./sat.ts";
import { tyreOverlap } from "./pair-contact.ts";

/**
 * Hooked cars: two cars locked together while one drives away (the owner's cop cars "hooked" onto the cars they chase, the
 * front car's rear corner inside the follower's nose). A pair's contact axis comes from its cages' outlines; a corner pushed past
 * its partner's midplane used to read "out" the way that drives the whole cars deeper in, and the next SAT pass picked the
 * opposite side's row and undid the push.
 */
const FRAME = 1 / 60;
const scene = new THREE.Scene();

/** A car as the race builds it: its class's body, the HUD's default crush knobs and the class's kill travel. */
function build(cls: VehicleClassId): DeformableCar {
  const car = new DeformableCar({ body: 0x808080, accent: 0x404040, name: cls }, scene, null, CLASSES[cls].style);
  assignClass(car, cls);
  car.deform.squash = INITIAL_HUD.squash;
  car.deform.buckle = INITIAL_HUD.buckle;
  car.deform.setMode(INITIAL_HUD.deformMode);
  armKill(car.deform, killClass(car), HANDLING.realism, "default");
  return car;
}

/** Whether the pair is in contact the way `resolveCarPair` tests it: the cages' plan outlines or the tyres overlap. */
function touching(a: DeformableCar, b: DeformableCar, n: THREE.Vector3, p: THREE.Vector3): boolean {
  return satCars(a, b, n, p) !== null || tyreOverlap(a, b) > 0;
}

describe("given two cars hooked together (the front car's rear corner inside the follower's nose, as a cop car hooks onto the car it chases)", () => {
  it("when the pair's contact axis is read over a grid of overlapping poses, then it never pushes the two cars' centres together", () => {
    const a = build("sedan");
    const b = build("sedan");
    const n = new THREE.Vector3();
    const p = new THREE.Vector3();
    let hits = 0;
    let together = 0;
    let first = "";
    // A ahead of B by `gap` m along B's nose, `lat` m to its right and turned `yaw` rad: every overlap of the grid.
    for (let gap = 1.6; gap <= 4.6; gap += 0.4) {
      for (let lat = -1.9; lat <= 1.9; lat += 0.2) {
        for (let yaw = -0.8; yaw <= 0.8; yaw += 0.4) {
          b.spawnFacing(0, 0, 0, 0);
          a.spawnFacing(lat, gap, yaw, 0);
          const dx = a.group.position.x - b.group.position.x;
          const dz = a.group.position.z - b.group.position.z;
          if (satCars(a, b, n, p) === null) continue;
          hits++;
          // `satCars`' axis runs b → a: against a − b it would push the cars deeper in.
          if (n.x * dx + n.z * dz < 0) {
            together++;
            first ||= `gap ${gap.toFixed(1)} lat ${lat.toFixed(1)} yaw ${yaw.toFixed(1)}`;
          }
        }
      }
    }
    assert.ok(hits > 500, `only ${hits} overlapping poses: the grid missed the cars`);
    assert.equal(together, 0, `${together} of ${hits} contact axes pushed the cars' centres together, first at ${first}`);
  });

  describe("when every class pair drives flat out with the front car's rear corner 1 m inside the follower's nose", () => {
    for (const front of VEHICLE_CLASS_IDS) {
      for (const back of VEHICLE_CLASS_IDS) {
        it(`then a ${front} ahead of a ${back} is in contact for under 1 s of the first 3 s and ends more than 6 m clear`, () => {
          const a = build(front);
          const b = build(back);
          // B faces +z at the origin; A's rear-right corner (0.95 right, 2.2 behind its origin) sits 0.6 m right of B's axis,
          // 1.0 m inside B's nose (2.3 m ahead of B's origin), A turned 0.15 rad to B's left.
          const yaw = -0.15;
          const px = 0.6 - (0.95 * Math.cos(yaw) - 2.2 * Math.sin(yaw));
          const pz = 2.3 - 1.0 - (-0.95 * Math.sin(yaw) - 2.2 * Math.cos(yaw));
          b.spawnFacing(0, 0, 0, 22);
          a.spawnFacing(px, pz, yaw, 22);
          const cars = [a, b];
          const w = newWorld(cars);
          const gas = { ...idleDrive(), throttle: 1 };
          const n = new THREE.Vector3();
          const p = new THREE.Vector3();
          let acc = 0;
          let contact = 0;
          for (let f = 0; f < 3 / FRAME; f++) {
            acc = Math.min(0.05, acc + FRAME);
            const vmax = sliceSpeed(cars);
            for (let steps = 0; acc > 1e-5 && steps < 8; steps++) {
              const h = Math.fround(physicsSlice(acc, vmax));
              applyDrive(a, gas, h);
              applyDrive(b, gas, h);
              stepWorld(w, h);
              acc -= h;
              settleStep(cars, h, false);
            }
            if (touching(a, b, n, p)) contact += FRAME;
          }
          const gap = Math.hypot(a.group.position.x - b.group.position.x, a.group.position.z - b.group.position.z);
          assert.ok(contact < 1, `in contact ${contact.toFixed(2)} s of 3 s, centres ${gap.toFixed(1)} m apart: hooked`);
          assert.ok(gap > 6, `centres only ${gap.toFixed(1)} m apart after 3 s`);
        });
      }
    }
  });
});
