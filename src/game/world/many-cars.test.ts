import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { frame, makeWorld } from "./race-world.test-util.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { assignClass } from "../vehicle/vehicle-classes.ts";
import { fleetClass, fleetStyle } from "../scenes/fleet.ts";
import { SimPacer } from "../engine/sim-pace.ts";

/**
 * Fields past the 32-car cap: the step's near-pair list (`world-step.ts` `collectNear`) holds 32 cars' pairs and grows
 * for more, and the approach marks (`markApproaches`) walk it. Before this no run ever stepped more than 32 cars. The
 * headless stack (`race-world.test-util.ts`) with the engine's pacer held on the 1/120 s floor, so the approach marks run
 * every step: the field on a ring, every car driving at its centre, a pile-up of all of them.
 */
const SIZES = [36, 40];
/** Ring radius (m): adjacent cars start 5.6 m apart or more at 40 cars. */
const RING = 36;
/** Closing speed of each car toward the centre (m/s): they meet about 3 s in. */
const SPEED = 12;
/** Sim seconds run. */
const SECONDS = 5;

type Pileup = { thrown: string; nonFinite: number; fine: number; pastCap: number; contacts: number };

function pileup(n: number): Pileup {
  const w = makeWorld();
  const scene = new THREE.Scene();
  const cars = new Array<DeformableCar>(n);
  for (let i = 0; i < n; i++) {
    const car = new DeformableCar({ body: 0x808080, accent: 0x404040, name: `Car${i}` }, scene, null, fleetStyle(i));
    assignClass(car, fleetClass(i));
    const a = (2 * Math.PI * i) / n;
    const x = RING * Math.sin(a);
    const z = RING * Math.cos(a);
    car.spawnFacing(x, z, Math.atan2(-x, -z), SPEED);
    cars[i] = car;
  }
  w.live = () => cars;
  let pastCap = 0;
  let contacts = 0;
  w.onPairContact = (a, b) => {
    contacts++;
    if (b >= 32) pastCap++;
  };
  const pace = new SimPacer();
  pace.pin = true;
  const state = { acc: 0 };
  let thrown = "";
  try {
    for (let f = 0; f < 60 * SECONDS; f++) frame(w, state, undefined, pace);
  } catch (e) {
    thrown = String(e);
  }
  let nonFinite = 0;
  for (const car of cars) {
    const p = car.group.position;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) nonFinite++;
  }
  return { thrown, nonFinite, fine: w.step.fine, pastCap, contacts };
}

describe("given a field of 36 or 40 cars on a ring, each driving at its centre, stepped on the 1/120 s floor", () => {
  for (const n of SIZES) {
    it(`when ${n} cars pile up for ${SECONDS} s, then the step runs, every car stays at a real position and cars past the 32nd collide`, (t) => {
      const r = pileup(n);
      t.diagnostic(`contacts ${r.contacts}, on a car past the 32nd ${r.pastCap}, fine slice ${r.fine.toFixed(5)} s`);
      assert.equal(r.thrown, "");
      assert.ok(r.fine > 0, `fine floor ${r.fine}`);
      assert.equal(r.nonFinite, 0);
      assert.ok(r.pastCap > 0, `contacts on a car past the 32nd: ${r.pastCap}`);
    });
  }
});
