import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { JerseyBarrier } from "./engine-props.ts";
import { FleetRamps, RAMP } from "./fleet-ramps.ts";
import { setGround } from "../world/ground.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { paint } from "../vehicle/test-support.ts";
import { newWorld, stepWorld, type World } from "../engine/world-step.ts";

const FRAME = 1 / 60;
const TYRE_CENTRE = 0.32;

/** Ramps on a slab whose long axis is +z (the engine's end-on placement), and one car `x0` across, `z0` along. */
function scene(withSlab: boolean): { ramps: FleetRamps; w: World; car: DeformableCar } {
  const three = new THREE.Scene();
  const ramps = new FleetRamps(three);
  const slab = withSlab ? new JerseyBarrier(three, new THREE.Group()) : null;
  slab?.reset();
  ramps.place(0, slab);
  setGround(ramps);
  const car = new DeformableCar(paint(), three);
  const w = newWorld([car], slab);
  w.collide = (c) => void ramps.contact(c);
  return { ramps, w, car };
}

function run(w: World, seconds: number, each: () => void): void {
  let acc = 0;
  for (let t = 0; t < seconds; t += FRAME) {
    acc = Math.min(0.05, acc + FRAME);
    while (acc > 1e-5) {
      const h = physicsSlice(acc, sliceSpeed(w.cars));
      stepWorld(w, h);
      acc -= h;
    }
    w.cars[0]!.updateDeform(FRAME);
    each();
  }
}

describe("fleet ramps", () => {
  afterEach(() => setGround(null));

  it("14 m/s up a ramp: flies the slab end-on without touching it, lands past the far ramp on all four wheels", (t) => {
    const { ramps, w, car } = scene(true);
    car.spawnFacing(0, -14, 0, 14);
    const p = car.group.position;
    const wp = new THREE.Vector3();
    let air = 0;
    let peak = 0;
    run(w, 3, () => {
      if (p.y > ramps.heightAt(p.x, p.z, p.y) + 0.02) air += FRAME;
      peak = Math.max(peak, p.y);
    });
    car.group.updateWorldMatrix(true, true);
    const gaps = car.wheels.map((wh) => {
      wh.getWorldPosition(wp);
      return wp.y - TYRE_CENTRE - ramps.heightAt(wp.x, wp.z, wp.y);
    });
    t.diagnostic(`air ${air.toFixed(2)} s, peak ${peak.toFixed(2)} m, end z ${p.z.toFixed(1)} y ${p.y.toFixed(3)}, gaps ${gaps.map((g) => g.toFixed(3)).join("/")} m, slab hit ${w.barrierHits[0] === true}`);
    const failures: string[] = [];
    if (air < 0.6) failures.push(`air ${air.toFixed(2)} s`);
    if (peak < RAMP.top + 0.3) failures.push(`peak ${peak.toFixed(2)} m`);
    if (w.barrierHits[0]) failures.push("touched the slab");
    if (car.crashed) failures.push("crashed");
    if (p.z < RAMP.start + RAMP.len) failures.push(`came down at z ${p.z.toFixed(1)}, short of the far ramp's foot`);
    gaps.forEach((g, i) => {
      if (Math.abs(g) > 0.02) failures.push(`wheel ${i} gap ${g.toFixed(3)} m`);
    });
    assert.deepEqual(failures, []);
  });

  it("8 m/s without the slab: comes down across the far ramp's high end and rides its face down, not launched off the step", (t) => {
    const { w, car } = scene(false);
    car.spawnFacing(0, -14, 0, 8);
    const p = car.group.position;
    let peak = 0;
    run(w, 3, () => {
      peak = Math.max(peak, p.y);
    });
    t.diagnostic(`peak ${peak.toFixed(2)} m, end z ${p.z.toFixed(1)} y ${p.y.toFixed(3)} vy ${car.velocity.y.toFixed(2)} m/s`);
    assert.ok(peak < RAMP.top + 0.4 && p.y < 0.01, `peak ${peak.toFixed(2)} m, end y ${p.y.toFixed(2)} m`);
  });

  it("a ramp's side is a wall: a car driven square into its high end stops at the face, never up or through it", (t) => {
    const { ramps, w, car } = scene(false);
    // Square to the +z ramp's side 1 m from its high end (face 0.94 m up), from 6 m out on −x.
    const z = RAMP.start + 1;
    car.spawnFacing(-6, z, Math.PI / 2, 10);
    const p = car.group.position;
    let deepest = -Infinity;
    let highest = 0;
    run(w, 2, () => {
      // How far the nose (2.22 m ahead of the centre) reached past the ramp's side face.
      deepest = Math.max(deepest, p.x + 2.22 + RAMP.halfW);
      highest = Math.max(highest, p.y);
    });
    t.diagnostic(`face ${ramps.heightAt(0, z).toFixed(2)} m high; nose reached ${deepest.toFixed(3)} m past it, highest ${highest.toFixed(3)} m, end vx ${car.velocity.x.toFixed(2)} m/s, crashed ${car.crashed}`);
    const failures: string[] = [];
    if (deepest > 0.15) failures.push(`nose ${deepest.toFixed(3)} m into the ramp`);
    if (highest > 0.05) failures.push(`climbed to ${highest.toFixed(3)} m`);
    if (car.velocity.x > 0.1) failures.push(`still driving in at ${car.velocity.x.toFixed(2)} m/s`);
    assert.deepEqual(failures, []);
  });
});
