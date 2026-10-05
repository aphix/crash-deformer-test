import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { applyDrive, idleDrive } from "./car-drive.ts";
import { assignClass, CLASSES } from "./vehicle-classes.ts";
import { paint } from "./test-support.ts";

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
