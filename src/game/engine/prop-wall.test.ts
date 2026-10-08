import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { placeProps, propColliders, type PropCollider } from "../world/placements.ts";
import { setGround } from "../world/ground.ts";
import { makeWorld } from "../world/race-world.test-util.ts";
import { Track } from "../world/track.ts";
import { parseTrack } from "../world/track-schema.ts";
import { OFF_MENU, TRACKS } from "../world/tracks/index.ts";
import { applyDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { bodyPoints } from "../vehicle/body-points.test-util.ts";
import { makeCar } from "../vehicle/ground-probe.test-util.ts";
import { WALL_HALF_L, WALL_PROBES } from "../contact/pair-contact.ts";
import { propContact } from "../contact/prop-contact.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { VEHICLE_CLASS_IDS, type VehicleClassId } from "../vehicle/vehicle-classes.ts";
import { newWorld, settleStep, stepWorld } from "./world-step.ts";
import type { DeformableCar } from "../vehicle/car.ts";

/**
 * A car never ends up through a thin solid prop (Havana's alley wall: 0.44 m thick panels at a car's height, in a row), and never stays hooked
 * on one. The owner drove a truck into one with the handbrake and boost on and its tail ended up out of the far side. The
 * contact reads the car's whole footprint and pushes it to the side its centre is on (`footprintOverlap`); before it, six
 * probes each picked the NEAREST face, so a corner past the panel's middle plane was pushed on out through the far face.
 */

const FRAME = 1 / 60;
/** Seconds the driver keeps backing out after a hit. */
const RECOVER = 3;
const D = Math.PI / 180;
/** The alley wall: five 10 m panels in a row across x = −40.25 (0.22 m either side at a car's height: the 0.44 m footing; the 0.6 m cap is 3 m up) from z = −13 to 37, joined at z = −3, 7, 17 and 27; the approach is from +x. */
const PANEL = { x: -40.25, z: 12, hx: 0.22 };
const WALL_Z = [-13, 37] as const;
const NEAR = PANEL.x + PANEL.hx;
const FAR = PANEL.x - PANEL.hx;

afterEach(() => setGround(null));

function alley() {
  const w = makeWorld();
  w.race.showLobby("havana");
  const track = new Track([...TRACKS, ...OFF_MENU].find((j) => parseTrack(j).id === "havana"));
  const panels = propColliders(placeProps(track)).filter((c: PropCollider) => c.prefab === "wall" && c.top - c.base > 1 && Math.abs(c.x - PANEL.x) < 1e-3);
  assert.equal(panels.length, 5, "the alley wall is five panels in a row");
  return w;
}

/** How far the body reaches past the wall's far face (m), and how deep inside the slab (m), along the wall. */
function reach(car: DeformableCar): { past: number; inside: number } {
  let past = 0;
  let inside = 0;
  for (const [x, z] of bodyPoints(car)) {
    if (z < WALL_Z[0] || z > WALL_Z[1]) continue;
    past = Math.max(past, FAR - x);
    if (x < NEAR && x > FAR) inside = Math.max(inside, Math.min(NEAR - x, x - FAR));
  }
  return { past, inside };
}

describe("given a panel of the Havana alley wall (0.44 m thick) and a car with one corner 0.2 m past the panel's middle plane", () => {
  for (const cls of ["sedan", "truck"] as const) {
    it(`when a ${cls}'s tail corner is 0.2 m past the middle plane, then it is pushed out by the face it came in at, with no corner past the far face and under 2 cm left in the slab`, () => {
      const w = alley();
      const car = makeCar(cls);
      // Nose to +x, tail toward the wall, the tail at x = −40.45: 0.5 m into the panel, 0.2 m past its middle plane.
      const x0 = -40.45 + WALL_HALF_L;
      car.spawnFacing(x0, PANEL.z, 90 * D, 0);
      propContact(car, 0, w.race["colliders"], w.race["knocked"], w.race["propHits"], 1 / 120);
      assert.ok(car.group.position.x > x0, `pushed east, to x=${car.group.position.x.toFixed(3)}`);
      const { past, inside } = reach(car);
      assert.equal(past, 0, "no corner past the far face");
      assert.ok(inside < 0.02, `${inside.toFixed(3)} m left in the slab`);
    });

    it(`when a ${cls}'s flank corner is 0.2 m past the middle plane, then it is pushed out the near face too, with no corner past the far face`, () => {
      const w = alley();
      const car = makeCar(cls);
      const x0 = -40.45 + WALL_PROBES[1]![0];
      car.spawnFacing(x0, PANEL.z, 0, 0);
      propContact(car, 0, w.race["colliders"], w.race["knocked"], w.race["propHits"], 1 / 120);
      assert.ok(car.group.position.x > x0, `pushed east, to x=${car.group.position.x.toFixed(3)}`);
      assert.equal(reach(car).past, 0);
    });
  }
});

/**
 * One scripted hit: the car `dist` m off the wall's near face at `speed`, its heading `alpha` off the wall and its path `vdir` off it, `steer`, handbrake and boost held for `secs`.
 * `hz` > 0 steps the sim at that fixed rate (else the engine's `physicsSlice`).
 */
function hit(cls: VehicleClassId, o: { dw: number; alpha: number; vdir: number; speed: number; steer: number; ebrake: boolean }, pinned: boolean, hz = 0) {
  const w = alley();
  const car = makeCar(cls);
  const cop = pinned ? makeCar("police") : null;
  const cars = cop ? [car, cop] : [car];
  const world = newWorld(cars);
  world.collide = (c, i, h) => w.race.courseHit(c, i, h);
  // Toward the wall is −x: yaw −90° has the nose there.
  const toward = -Math.PI / 2;
  car.spawnFacing(NEAR + 5, PANEL.z + o.dw, toward + o.alpha, o.speed);
  car.velocity.set(Math.sin(toward + o.vdir) * o.speed, 0, Math.cos(toward + o.vdir) * o.speed);
  if (cop) {
    cop.spawnFacing(NEAR + 12, PANEL.z + o.dw, toward, 22);
    cop.velocity.set(Math.sin(toward) * 22, 0, Math.cos(toward) * 22);
  }
  const drive: DriveInput = { throttle: 1, steer: o.steer, brake: 0, ebrake: o.ebrake, boost: true };
  const push: DriveInput = { throttle: 1, steer: 0, brake: 0, ebrake: false, boost: true };
  let acc = 0;
  let past = 0;
  let hitEnd: [number, number] = [0, 0];
  const SECS = 2;
  for (let f = 0; f < (SECS + RECOVER) / FRAME; f++) {
    const t = f * FRAME;
    acc = Math.min(0.05, acc + FRAME);
    // After the hit the driver backs out the way the nose does not point: gas if the nose is off the wall, reverse if it is on it.
    const out: DriveInput = { throttle: car.fwdFlat.x > 0 ? 1 : -1, steer: 0, brake: 0, ebrake: false, boost: false };
    while (acc > 1e-5) {
      const h = hz > 0 ? Math.min(acc, 1 / hz) : Math.fround(physicsSlice(acc, sliceSpeed(world.cars)));
      applyDrive(car, t < SECS ? drive : out, h);
      if (cop) applyDrive(cop, t < SECS ? push : { ...out, throttle: 0 }, h);
      stepWorld(world, h);
      settleStep(world.cars, h, false);
      acc -= h;
    }
    car.updateSkin();
    cop?.updateSkin();
    past = Math.max(past, reach(car).past);
    if (f === Math.round(SECS / FRAME)) hitEnd = [car.group.position.x, car.group.position.z];
  }
  return { car, past, inside: reach(car).inside, alive: car.deform.drivetrainAlive, drove: Math.hypot(car.group.position.x - hitEnd[0], car.group.position.z - hitEnd[1]) };
}

describe("given the Havana alley wall and a car swung into it with the handbrake and boost on, in each of nine ways (at a seam between panels, and at a panel's middle)", () => {
  // Seam cases (dw 5: z = 17, the joint of two panels) are the ones that went through by up to 4 m before; the rest are the swing at a panel's middle.
  const CASES = [
    { dw: 5, alpha: 45 * D, vdir: -30 * D, speed: 24, steer: 1, ebrake: false },
    { dw: 5, alpha: 45 * D, vdir: 0, speed: 12, steer: 1, ebrake: true },
    { dw: 5, alpha: 90 * D, vdir: -30 * D, speed: 24, steer: -1, ebrake: false },
    { dw: 5, alpha: 0, vdir: 0, speed: 12, steer: 1, ebrake: true },
    { dw: 5, alpha: 315 * D, vdir: 30 * D, speed: 24, steer: -1, ebrake: false },
    { dw: 0, alpha: 180 * D, vdir: 0, speed: 12, steer: 1, ebrake: false },
    { dw: 0, alpha: 90 * D, vdir: 0, speed: 10, steer: -1, ebrake: false },
    { dw: 0, alpha: 270 * D, vdir: 0, speed: 10, steer: 1, ebrake: false },
    { dw: 0, alpha: 150 * D, vdir: 0, speed: 10, steer: -1, ebrake: false },
  ];
  for (const cls of VEHICLE_CLASS_IDS) {
    for (const pinned of [false, true]) {
      it(`when ${pinned ? `a ${cls} pinned by a cop ramming from behind` : `a ${cls}`} is swung in each of the nine ways, then no corner ends more than 2 cm past the far face, under 5 cm of it is left in the wall, and a car that survives alone drives out of the wall`, () => {
        for (const c of CASES) {
          const r = hit(cls, c, pinned);
          assert.ok(r.past < 0.02, `${JSON.stringify(c)}: ${r.past.toFixed(2)} m past the far face`);
          assert.ok(r.inside < 0.05, `${JSON.stringify(c)}: left ${r.inside.toFixed(2)} m inside the slab`);
          // Alone, a car that lived through the hit drives out of the wall. (A pinned car can lose its wheel hubs to the cop; that is the pair contact's, not the wall's.)
          if (!pinned && r.alive) assert.ok(r.drove > 3, `${JSON.stringify(c)}: stuck, drove ${r.drove.toFixed(1)} m in ${RECOVER} s after the hit`);
        }
      });
    }
  }
});

describe("given the Havana alley wall and a physics step of 1/120 s (46 cm a step at 55 m/s, most of a panel's thickness)", () => {
  const CASES = [
    { dw: 5, alpha: 45 * D, vdir: -30 * D, speed: 55, steer: 1, ebrake: false },
    { dw: 0, alpha: 60 * D, vdir: 0, speed: 55, steer: -1, ebrake: true },
    { dw: 5, alpha: 0, vdir: 30 * D, speed: 55, steer: 1, ebrake: true },
  ];
  for (const cls of VEHICLE_CLASS_IDS) {
    for (const pinned of [false, true]) {
      it(`when ${pinned ? `a ${cls} pinned by a cop` : `a ${cls}`} drives into the panels at 55 m/s in each of three ways, then no corner ends more than 2 cm past the far face or more than 5 cm inside the slab`, () => {
        for (const c of CASES) {
          const r = hit(cls, c, pinned, 120);
          assert.ok(r.past < 0.02, `${JSON.stringify(c)}: ${r.past.toFixed(2)} m past the far face`);
          assert.ok(r.inside < 0.05, `${JSON.stringify(c)}: left ${r.inside.toFixed(2)} m inside the slab`);
        }
      });
    }
  }
});
