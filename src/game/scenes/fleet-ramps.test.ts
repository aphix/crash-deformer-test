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
import { assignClass, VEHICLE_CLASS_IDS } from "../vehicle/vehicle-classes.ts";

const FRAME = 1 / 60;
const TYRE_CENTRE = 0.32;
const DEG = 180 / Math.PI;

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

type Jump = { air: number; peak: number; noseOff: number; turn: number; sink: number; gaps: number[]; endZ: number; slabHit: boolean; crashed: boolean };

/**
 * One car at `v` m/s up the −z ramp, end-on over the slab. Flight: frames with every tyre more than 5 cm off the
 * ground. noseOff: the most the nose's elevation strays from the flight path's (deg) after the first 0.1 s of
 * flight; turn: the most the nose's elevation changes in one frame (deg) from takeoff to 0.5 s after touchdown (a
 * snap); sink: the deepest any tyre gets into the ground over the run (m).
 */
function jump(v: number): Jump {
  const { ramps, w, car } = scene(true);
  car.spawnFacing(0, -14, 0, v);
  const p = car.group.position;
  const q = car.group.quaternion;
  const wp = new THREE.Vector3();
  const f = new THREE.Vector3();
  const gaps = [0, 0, 0, 0];
  let air = 0;
  let peak = 0;
  let noseOff = 0;
  let turn = 0;
  let sink = 0;
  let since = -1;
  let lastNose = 0;
  run(w, 3, () => {
    car.group.updateWorldMatrix(true, true);
    car.wheels.forEach((wh, i) => {
      wh.getWorldPosition(wp);
      gaps[i] = wp.y - TYRE_CENTRE - ramps.heightAt(wp.x, wp.z, wp.y);
    });
    sink = Math.max(sink, -Math.min(...gaps));
    peak = Math.max(peak, p.y);
    const nose = Math.asin(f.set(0, 0, 1).applyQuaternion(q).y) * DEG;
    const path = Math.atan2(car.velocity.y, Math.hypot(car.velocity.x, car.velocity.z)) * DEG;
    const flying = Math.min(...gaps) > 0.05;
    if (flying) {
      air += FRAME;
      since = 0;
      if (air > 0.1) noseOff = Math.max(noseOff, Math.abs(nose - path));
    } else if (since >= 0) since += FRAME;
    if (air > 0 && since < 0.5) turn = Math.max(turn, Math.abs(nose - lastNose));
    lastNose = nose;
  });
  return { air, peak, noseOff, turn, sink, gaps, endZ: p.z, slabHit: w.barrierHits[0] === true, crashed: car.crashed };
}

describe("fleet ramps", () => {
  afterEach(() => setGround(null));

  for (const [v, name, landZ] of [
    [14, "flies the slab end-on and lands on the flat past the far ramp", RAMP.start + RAMP.len],
    [11, "flies the slab end-on and lands on the far ramp's face", RAMP.start],
  ] as const) {
    it(`${v} m/s up a ramp: ${name}; the nose follows the flight path, no tyre sinks or snaps on landing, all four end on the ground`, (t) => {
      const r = jump(v);
      t.diagnostic(
        `air ${r.air.toFixed(2)} s, peak ${r.peak.toFixed(2)} m, nose off path ≤ ${r.noseOff.toFixed(1)}°, most turn in a frame ${r.turn.toFixed(1)}°, deepest tyre ${r.sink.toFixed(3)} m, end z ${r.endZ.toFixed(1)}, gaps ${r.gaps.map((g) => g.toFixed(3)).join("/")} m, slab hit ${r.slabHit}`,
      );
      const failures: string[] = [];
      if (r.air < 0.6) failures.push(`air ${r.air.toFixed(2)} s`);
      if (r.peak < RAMP.top + 0.3) failures.push(`peak ${r.peak.toFixed(2)} m`);
      if (r.slabHit) failures.push("touched the slab");
      if (r.crashed) failures.push("crashed");
      if (r.endZ < landZ) failures.push(`ended at z ${r.endZ.toFixed(1)}, short of ${landZ.toFixed(1)}`);
      if (r.noseOff > 3) failures.push(`nose ${r.noseOff.toFixed(1)}° off the flight path`);
      if (r.turn > 6) failures.push(`nose turned ${r.turn.toFixed(1)}° in one frame`);
      if (r.sink > 0.02) failures.push(`a tyre ${r.sink.toFixed(3)} m into the ground`);
      r.gaps.forEach((g, i) => {
        if (Math.abs(g) > 0.02) failures.push(`wheel ${i} gap ${g.toFixed(3)} m`);
      });
      assert.deepEqual(failures, []);
    });
  }

  it("14 m/s jump, every class: the springs take the landing and stop swinging (all under 1 cm) within 2 s, the body's sill stays off the ground", (t) => {
    const failures: string[] = [];
    const sill = new THREE.Vector3();
    for (const cls of VEHICLE_CLASS_IDS) {
      const { ramps, w, car } = scene(true);
      car.spawnFacing(0, -14, 0, 14);
      assignClass(car, cls);
      const body = car.group.getObjectByName("classLift")!;
      let touch = -1;
      let flew = false;
      let peak = 0;
      let swung = 0;
      let low = Infinity;
      let time = 0;
      // 4 s: 2.2 s past touchdown, before the car rolls off the disc's rim.
      run(w, 4, () => {
        time += FRAME;
        if (car.airborne && !car.airContact) flew = true;
        if (flew && touch < 0 && (car.airContact || !car.airborne)) touch = time;
        if (touch < 0) return;
        const o = car.suspension.offset;
        peak = Math.min(peak, ...o);
        if (Math.max(...o.map(Math.abs)) > 0.01) swung = time - touch;
        car.group.updateWorldMatrix(true, true);
        body.localToWorld(sill.set(0, 0.25, 0));
        low = Math.min(low, sill.y - ramps.heightAt(sill.x, sill.z, sill.y));
      });
      t.diagnostic(`${cls}: peak compression ${(-peak * 100).toFixed(1)} cm, swinging until ${swung.toFixed(2)} s after touchdown, sill ≥ ${low.toFixed(3)} m`);
      if (touch < 0) failures.push(`${cls} never came down`);
      if (peak > -0.02) failures.push(`${cls} springs took ${(-peak * 100).toFixed(1)} cm`);
      if (swung > 2) failures.push(`${cls} still swinging ${swung.toFixed(2)} s after touchdown`);
      if (low < 0.05) failures.push(`${cls} sill ${low.toFixed(3)} m off the ground`);
      car.dispose();
    }
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

  it("a car struck just before touchdown is a wreck on its masses: once it stops it is not flying (drive idled)", (t) => {
    const { ramps, w, car } = scene(true);
    car.spawnFacing(0, -14, 0, 14);
    const p = car.group.position;
    let hitAt = -1;
    let time = 0;
    let stopped = 0;
    let stuck = 0;
    run(w, 5, () => {
      time += FRAME;
      if (hitAt < 0 && car.airborne && time > 0.5 && p.y - ramps.heightAt(p.x, p.z, p.y) < 0.4) {
        hitAt = time;
        car.applyImpact(new THREE.Vector3(p.x + 1, p.y + 0.5, p.z), new THREE.Vector3(-1, 0, 0), 20, 12);
      }
      if (hitAt < 0 || car.velocity.length() > 0.3) return;
      stopped += FRAME;
      if (car.airborne) stuck += FRAME;
    });
    t.diagnostic(`struck at ${hitAt.toFixed(2)} s, stopped ${stopped.toFixed(2)} s, of it flying ${stuck.toFixed(2)} s; masses ${car.deform.massActive}`);
    assert.ok(hitAt > 0 && stopped > 1, `struck at ${hitAt.toFixed(2)} s, stopped ${stopped.toFixed(2)} s`);
    assert.ok(stuck < 0.25, `stopped yet flying for ${stuck.toFixed(2)} s`);
  });
});
