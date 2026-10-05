import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { applyDrive, idleDrive } from "./car-drive.ts";
import { assignClass, CLASSES } from "./vehicle-classes.ts";
import { paint } from "./test-support.ts";
import { runWall } from "../contact/crash-scenarios.test-util.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";

/**
 * A wreck under power turns its masses as the driver steers (`applyDrive`'s `driveMasses`). Turning positions alone left
 * the masses' velocities where they were, so a spinning wreck that was steered lost (or, counter-steered, gained)
 * angular momentum with no torque behind it: derby seed 39 c1 went 3.3 → 8.7 rad/s over 0.45 s, ΔL −6394.
 */
const H = 1 / 120;

/** A sedan, masses live at 8 m/s along +z, every mass turning rigidly at `w` rad/s about the masses' centroid (v = w (z, −x)). */
function spinning(w: number): DeformableCar {
  const c = new DeformableCar(paint(), new THREE.Scene(), null, CLASSES.sedan.style);
  assignClass(c, "sedan");
  c.spawnFacing(0, 0, 0, 8);
  c.deform.armMasses(c.group, c.velocity, c.angular);
  const ms = c.deform.masses;
  const [cx, cz] = centroid(ms);
  for (const m of ms) {
    m.vel.x = w * (m.world.z - cz);
    m.vel.z = 8 - w * (m.world.x - cx);
  }
  return c;
}

function centroid(ms: DeformableCar["deform"]["masses"]): [number, number] {
  let x = 0;
  let z = 0;
  let mass = 0;
  for (const m of ms) {
    x += m.world.x * m.mass;
    z += m.world.z * m.mass;
    mass += m.mass;
  }
  return [x / mass, z / mass];
}

/** Angular momentum about the masses' centroid (y), and the linear momentum, of the dynamic masses. */
function momentum(c: DeformableCar): { l: number; px: number; pz: number } {
  const ms = c.deform.masses.filter((m) => m.dynamic);
  const [cx, cz] = centroid(ms);
  let px = 0;
  let pz = 0;
  let mass = 0;
  for (const m of ms) {
    px += m.vel.x * m.mass;
    pz += m.vel.z * m.mass;
    mass += m.mass;
  }
  let l = 0;
  for (const m of ms) l += m.mass * ((m.world.z - cz) * (m.vel.x - px / mass) - (m.world.x - cx) * (m.vel.z - pz / mass));
  return { l, px, pz };
}

describe("steering a wreck under power", () => {
  it("bad: a spinning wreck steered for 0.5 s keeps its angular momentum (turning positions alone lost 29 % of it, 2824 → 2018)", () => {
    const c = spinning(3);
    const before = momentum(c);
    for (let k = 0; k < 60; k++) applyDrive(c, { ...idleDrive(), throttle: 0.5, steer: 1 }, H);
    const after = momentum(c);
    assert.ok(Math.abs(before.l) > 1000, `no spin to keep: L ${before.l.toFixed(0)}`);
    assert.ok(Math.abs(after.l / before.l - 1) < 0.01, `L ${before.l.toFixed(0)} → ${after.l.toFixed(0)} kg·m²/s over 0.5 s of steering`);
  });

  it("bad: the same with the wreck spinning the other way round (L −2824 → −2018 on turned positions alone)", () => {
    const c = spinning(-3);
    const before = momentum(c);
    for (let k = 0; k < 60; k++) applyDrive(c, { ...idleDrive(), throttle: 0.5, steer: 1 }, H);
    const after = momentum(c);
    assert.ok(Math.abs(after.l / before.l - 1) < 0.01, `L ${before.l.toFixed(0)} → ${after.l.toFixed(0)}`);
  });
});

describe("a driven, dented car reports the turn it drives", () => {
  it("bad: steered hard for 1 s after a wall hit, the heading it turned (c.yaw) is what it reported (angular.y read L/I, ~0, while it drove round at ~1 rad/s)", () => {
    const c = new DeformableCar(paint(), new THREE.Scene(), null, CLASSES.sedan.style);
    assignClass(c, "sedan");
    runWall(30, 1, "front", { car: c, after: 0.3 });
    assert.ok(c.crashed && c.deform.massActive && c.deform.drivetrainAlive, "fixture: the hit must leave a dented car that still drives");
    const w = newWorld([c]);
    let reported = 0;
    let drawn = 0;
    let prev = c.yaw;
    for (let k = 0; k < 120; k++) {
      applyDrive(c, { ...idleDrive(), throttle: 1, steer: 1 }, H);
      stepWorld(w, H);
      let dy = c.yaw - prev;
      dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
      prev = c.yaw;
      if (k >= 60) {
        drawn += dy;
        reported += c.angular.y * H;
      }
    }
    assert.ok(Math.abs(drawn) > 0.3, `fixture: drawn turn ${drawn.toFixed(2)} rad in 0.5 s: no turn to report`);
    assert.ok(Math.abs(reported - drawn) < 0.15 * Math.abs(drawn), `reported ${reported.toFixed(3)} rad, drawn ${drawn.toFixed(3)} rad over 0.5 s`);
  });
});
