import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { StreamedDeformation } from "./streamed-deform.ts";
import { DT, dummyGeom, mass } from "../vehicle/test-support.ts";

/**
 * What `followGroup` reports for a wreck (its `velocity` and `angular`) is what its masses do. It fits a frame to them
 * (heading, height), and a fit moves for reasons the masses do not: a mass pushed or crushed sideways, a re-measure
 * after a pair push, the first read of a tilted body. Those moves were written out as the car's spin and vertical speed.
 */
type Wreck = { d: StreamedDeformation; group: THREE.Group; vel: THREE.Vector3; omega: THREE.Vector3 };

function wreck(tilt?: { pitch: number; roll: number; y: number }, hit = { x: 0, speed: 0 }): Wreck {
  const d = new StreamedDeformation(dummyGeom());
  d.mode = "shape";
  const group = new THREE.Group();
  if (tilt) {
    group.rotation.set(tilt.pitch, 0, tilt.roll, "YXZ");
    group.position.y = tilt.y;
  }
  group.updateMatrixWorld();
  const vel = new THREE.Vector3(0, 0, hit.speed);
  const omega = new THREE.Vector3();
  d.beginCrush(new THREE.Vector3(hit.x, 0.36, 2.06), new THREE.Vector3(0, 0, -1), hit.speed, hit.speed, group, vel, omega);
  return { d, group, vel, omega };
}

/** Every mass moving as one rigid body turning `w` rad/s about the masses' centroid (v = w (z, −x)), the centroid at (vx, vz). */
function spinRigid(d: StreamedDeformation, w: number, vx: number, vz: number): void {
  let m = 0;
  let cx = 0;
  let cz = 0;
  for (const q of d.masses) {
    m += q.mass;
    cx += q.world.x * q.mass;
    cz += q.world.z * q.mass;
  }
  cx /= m;
  cz /= m;
  for (const q of d.masses) {
    q.vel.x = vx + w * (q.world.z - cz);
    q.vel.y = 0;
    q.vel.z = vz - w * (q.world.x - cx);
  }
}

/** Sim time (s) of a resting wreck's quiet steps before the checks: past the yaw sample's old minimum span. */
const SETTLE = 6;

function settled(): Wreck {
  const s = wreck();
  for (let i = 0; i < SETTLE; i++) {
    s.d.stepStructure(DT);
    s.d.followGroup(s.group, s.vel, s.omega, DT);
  }
  return s;
}

describe("followGroup reports the masses' motion, not the frame's", () => {
  it("good: a wreck whose masses turn rigidly at 2 rad/s reports 2 rad/s and the centroid's velocity", () => {
    const s = settled();
    spinRigid(s.d, 2, 1.5, -0.5);
    s.d.followGroup(s.group, s.vel, s.omega, DT);
    assert.ok(Math.abs(s.omega.y - 2) < 1e-6, `spin ${s.omega.y.toFixed(4)} rad/s, the masses turn at 2`);
    assert.ok(Math.abs(s.vel.x - 1.5) < 1e-6 && Math.abs(s.vel.z + 0.5) < 1e-6, `velocity ${s.vel.x.toFixed(3)}, ${s.vel.z.toFixed(3)}`);
  });

  it("bad: engine and axle swung 0.35 rad in one step reports the masses' 2 rad/s, not the engine → axle axis' (7.9 rad/s on main)", () => {
    const s = settled();
    spinRigid(s.d, 2, 0, 0);
    const axle = mass(s.d, "axleR").world;
    const engines = [mass(s.d, "engineL").world, mass(s.d, "engineR").world];
    const before = new THREE.Vector2(engines[0]!.x + engines[1]!.x, engines[0]!.z + engines[1]!.z).multiplyScalar(0.5).sub(new THREE.Vector2(axle.x, axle.z));
    const turn = 0.35;
    // Turn the engine pair about the axle, as a swung block: the same axis read 0.35 rad on.
    for (const e of engines) {
      const dx = e.x - axle.x;
      const dz = e.z - axle.z;
      e.x = axle.x + dx * Math.cos(turn) + dz * Math.sin(turn);
      e.z = axle.z - dx * Math.sin(turn) + dz * Math.cos(turn);
    }
    const after = new THREE.Vector2(engines[0]!.x + engines[1]!.x, engines[0]!.z + engines[1]!.z).multiplyScalar(0.5).sub(new THREE.Vector2(axle.x, axle.z));
    const axis = Math.abs(Math.atan2(after.x, after.y) - Math.atan2(before.x, before.y));
    assert.ok(Math.abs(axis - turn) < 1e-9, `the axis turned ${axis.toFixed(3)} rad`);
    s.d.stepStructure(DT);
    s.d.followGroup(s.group, s.vel, s.omega, DT);
    assert.ok(Math.abs(s.omega.y - 2) < 0.5, `spin ${s.omega.y.toFixed(2)} rad/s: the frame's turn is not the masses'`);
  });

  it("bad: a pair push re-poses a tilted body in flight at dt = 0 (its frame drops 0.1 m), and the next timed read gives it a vertical speed (5.7 m/s down on main)", () => {
    const s = wreck({ pitch: 0.4, roll: 0.5, y: 1.5 });
    s.d.aloft = true;
    const y0 = s.group.position.y;
    s.d.followGroup(s.group, s.vel, s.omega, 0);
    const moved = Math.abs(s.group.position.y - y0);
    assert.ok(moved > 0.05, `the first read moved the frame ${moved.toFixed(3)} m: the setup no longer re-poses it`);
    s.d.stepStructure(DT);
    s.d.followGroup(s.group, s.vel, s.omega, DT);
    assert.ok(Math.abs(s.vel.y) < 1, `vertical speed ${s.vel.y.toFixed(2)} m/s from a ${moved.toFixed(3)} m re-measure`);
  });
});

/** The masses' angular momentum about their centroid (kg·m²/s about +y: Σ m r × v). */
function momentum(d: StreamedDeformation): number {
  let m = 0;
  let cx = 0;
  let cz = 0;
  let vx = 0;
  let vz = 0;
  for (const q of d.masses) {
    m += q.mass;
    cx += q.world.x * q.mass;
    cz += q.world.z * q.mass;
    vx += q.vel.x * q.mass;
    vz += q.vel.z * q.mass;
  }
  return d.masses.reduce((l, q) => l + q.mass * ((q.world.z - cz / m) * (q.vel.x - vx / m) - (q.world.x - cx / m) * (q.vel.z - vz / m)), 0);
}

describe("a wreck's own steps move no angular momentum", () => {
  // Shape matching and the engine block's spacing correct positions only: over the masses' velocities each correction moved
  // Σ m r × v (derby seed 8: a car shoved against a wall went 0.9 → 7.5 rad/s, shape matching alone adding 6400 kg·m²/s in 1.2 s).
  it("bad: an off-centre hit's wreck in flight keeps its angular momentum through its contact window (−44 % in 16 frames on main)", () => {
    const s = wreck({ pitch: 0, roll: 0, y: 1 }, { x: 0.62, speed: 14 });
    s.d.aloft = true;
    for (let f = 0; f < 12; f++) {
      s.d.notifyContact();
      const fl = mass(s.d, "bumperFL").world;
      s.d.feedOverlap(new THREE.Vector3(0.62, fl.y, fl.z), new THREE.Vector3(0, 0, -1), 0.08, 14, DT);
      s.d.applyImpulse(0, 0, -1, 14 * s.d.totalMass * DT * 0.7);
      s.d.stepStructure(DT);
      s.d.followGroup(s.group, s.vel, s.omega, DT);
    }
    const l0 = momentum(s.d);
    let worst = 0;
    for (let f = 0; f < 16; f++) {
      const before = momentum(s.d);
      s.d.stepStructure(DT);
      worst = Math.max(worst, Math.abs(momentum(s.d) - before));
      s.d.followGroup(s.group, s.vel, s.omega, DT);
    }
    assert.ok(Math.abs(l0) > 400, `the hit left ${l0.toFixed(0)} kg·m²/s: the setup no longer turns the wreck`);
    assert.ok(worst < 0.01 * Math.abs(l0), `a step moved ${worst.toFixed(1)} of ${l0.toFixed(0)} kg·m²/s`);
    assert.ok(Math.abs(momentum(s.d) - l0) < 0.02 * Math.abs(l0), `${l0.toFixed(0)} → ${momentum(s.d).toFixed(0)} kg·m²/s over the live window`);
  });
});
