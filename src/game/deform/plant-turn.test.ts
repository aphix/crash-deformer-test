import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { StreamedDeformation } from "./streamed-deform.ts";
import { DT, dummyGeom, mass } from "../vehicle/test-support.ts";

/**
 * A planted wreck (quiet 0.2 s, its wheels on the ground) keeps what its clamp writes back, turn included: the frame
 * follows the engine → axle axis and every mass is written into it. That turn moved positions only, so the masses'
 * velocities about their centroid stayed where they were: the same defect as `driveMasses` before it. The next hold of
 * the angular momentum (`yawMomentum`) then handed the difference back as a rigid spin on every mass, and the drawn
 * heading ran away (derby seed 269 c8: the axis went 3 → 7.8 rad/s in 0.17 s while the masses' L/I was 1.5).
 */
function planted(): { d: StreamedDeformation; group: THREE.Group } {
  const d = new StreamedDeformation(dummyGeom());
  d.mode = "shape";
  const group = new THREE.Group();
  group.updateMatrixWorld();
  const vel = new THREE.Vector3();
  const omega = new THREE.Vector3();
  d.beginCrush(new THREE.Vector3(0, 0.36, 2.06), new THREE.Vector3(0, 0, -1), 0, 0, group, vel, omega);
  for (let i = 0; i < 20; i++) {
    d.stepStructure(DT);
    d.followGroup(group, vel, omega, DT);
  }
  assert.ok(d.quietTime() > 0.25, `quiet ${d.quietTime().toFixed(2)} s: not planted`);
  return { d, group };
}

/** Every mass turning rigidly at `w` rad/s about the centroid (v = w (z, −x)), the engine block swinging 3 m/s on top of it. */
function spin(d: StreamedDeformation, w: number): void {
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
    q.vel.x = w * (q.world.z - cz) + (q.name === "engineL" ? 3 : q.name === "engineR" ? -3 : 0);
    q.vel.y = 0;
    q.vel.z = -w * (q.world.x - cx);
  }
}

type P = [number, number];

/** The net turn (rad, v = w (z, −x) sense) between two position sets of the masses, about their own centroids. */
function turnBetween(a: P[], b: P[], ms: number[]): number {
  const total = ms.reduce((t, x) => t + x, 0);
  const cen = (p: P[]): P => [p.reduce((t, q, i) => t + q[0] * ms[i]!, 0) / total, p.reduce((t, q, i) => t + q[1] * ms[i]!, 0) / total];
  const [ax, az] = cen(a);
  const [bx, bz] = cen(b);
  let s = 0;
  let c = 0;
  a.forEach((p, i) => {
    const rx = p[0] - ax;
    const rz = p[1] - az;
    const sx = b[i]![0] - bx;
    const sz = b[i]![1] - bz;
    s += ms[i]! * (rz * sx - rx * sz);
    c += ms[i]! * (rx * sx + rz * sz);
  });
  return Math.atan2(s, c);
}

describe("a planted wreck's write-back", () => {
  it("bad: the turn it writes into the masses (engine block swung 1 rad) turns their velocities about the centroid with it (it left them where they were on main)", () => {
    const { d, group } = planted();
    spin(d, 2);
    const axle = mass(d, "axleR").world;
    for (const name of ["engineL", "engineR"]) {
      const e = mass(d, name).world;
      const dx = e.x - axle.x;
      const dz = e.z - axle.z;
      e.x = axle.x + dx * Math.cos(1) + dz * Math.sin(1);
      e.z = axle.z - dx * Math.sin(1) + dz * Math.cos(1);
    }
    const ms = d.masses.map((q) => q.mass);
    const total = ms.reduce((t, x) => t + x, 0);
    const mean = (): P => [d.masses.reduce((t, q) => t + q.vel.x * q.mass, 0) / total, d.masses.reduce((t, q) => t + q.vel.z * q.mass, 0) / total];
    const [vx0, vz0] = mean();
    const u0 = d.masses.map((q): P => [q.vel.x - vx0, q.vel.z - vz0]);
    const p0 = d.masses.map((q): P => [q.world.x, q.world.z]);
    d.followGroup(group, new THREE.Vector3(), new THREE.Vector3(), 0);
    const w = turnBetween(p0, d.masses.map((q): P => [q.world.x, q.world.z]), ms);
    assert.ok(Math.abs(w) > 0.1, `the write-back turned the masses ${w.toFixed(3)} rad: the setup no longer turns them`);
    const [vx1, vz1] = mean();
    let err = 0;
    let norm = 0;
    d.masses.forEach((q, i) => {
      const ex = u0[i]![0] * Math.cos(w) + u0[i]![1] * Math.sin(w);
      const ez = u0[i]![1] * Math.cos(w) - u0[i]![0] * Math.sin(w);
      err += q.mass * ((q.vel.x - vx1 - ex) ** 2 + (q.vel.z - vz1 - ez) ** 2);
      norm += q.mass * (ex * ex + ez * ez);
    });
    const off = Math.sqrt(err / norm);
    assert.ok(off < 0.1, `the velocities about the centroid are ${(off * 100).toFixed(0)} % off a turn of ${w.toFixed(2)} rad with the positions`);
  });

  it("bad: the spin it reports includes the turn it kept: reported rad/s x dt = L/I x dt + the masses' net turn, within 25 % of that turn (it reported L/I alone, 0 for a wreck at rest, while the drawn heading turned)", () => {
    const { d, group } = planted();
    const axle = mass(d, "axleR").world;
    for (const name of ["engineL", "engineR"]) {
      const e = mass(d, name).world;
      const dx = e.x - axle.x;
      const dz = e.z - axle.z;
      e.x = axle.x + dx * Math.cos(0.5) + dz * Math.sin(0.5);
      e.z = axle.z - dx * Math.sin(0.5) + dz * Math.cos(0.5);
    }
    const ms = d.masses.map((q) => q.mass);
    const p0 = d.masses.map((q): P => [q.world.x, q.world.z]);
    const omega = new THREE.Vector3();
    d.followGroup(group, new THREE.Vector3(), omega, DT);
    const w = turnBetween(p0, d.masses.map((q): P => [q.world.x, q.world.z]), ms);
    assert.ok(Math.abs(w) > 0.03, `the write-back turned the masses ${w.toFixed(3)} rad: the setup no longer turns them`);
    const total = ms.reduce((t, x) => t + x, 0);
    const cx = d.masses.reduce((t, q) => t + q.world.x * q.mass, 0) / total;
    const cz = d.masses.reduce((t, q) => t + q.world.z * q.mass, 0) / total;
    const vx = d.masses.reduce((t, q) => t + q.vel.x * q.mass, 0) / total;
    const vz = d.masses.reduce((t, q) => t + q.vel.z * q.mass, 0) / total;
    let l = 0;
    let inertia = 0;
    for (const q of d.masses) {
      l += q.mass * ((q.world.z - cz) * (q.vel.x - vx) - (q.world.x - cx) * (q.vel.z - vz));
      inertia += q.mass * ((q.world.x - cx) ** 2 + (q.world.z - cz) ** 2);
    }
    const reported = omega.y * DT;
    const made = l / inertia * DT + w;
    assert.ok(Math.abs(reported - made) < 0.25 * Math.abs(w), `reported ${reported.toFixed(4)} rad over the step, the masses made ${made.toFixed(4)} (L/I ${(l / inertia * DT).toFixed(4)} + turn ${w.toFixed(4)})`);
  });
});
