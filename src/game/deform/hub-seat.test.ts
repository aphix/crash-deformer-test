import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { StreamedDeformation } from "./streamed-deform.ts";
import { dummyGeom } from "../vehicle/test-support.ts";

/**
 * `seatHubs` frees the wheels of a wreck that is about to plant at no more than HUB_SLIP m/s off the body. The body a
 * wheel rides is the spinning one: its speed at the wheel is the centroid's plus spin × arm, so a wheel turning with
 * a fast wreck is not slipping, and cutting it back to the centroid's speed took the wreck's spin away at the plant.
 */
class Seat extends StreamedDeformation {
  seat(): void {
    this.seatHubs();
  }
}

function wreck(): Seat {
  const d = new Seat(dummyGeom());
  d.mode = "shape";
  const group = new THREE.Group();
  group.updateMatrixWorld();
  d.beginCrush(new THREE.Vector3(0, 0.36, 2.06), new THREE.Vector3(0, 0, -1), 0, 0, group, new THREE.Vector3(), new THREE.Vector3());
  return d;
}

function centroid(d: Seat): [number, number] {
  let x = 0;
  let z = 0;
  let m = 0;
  for (const q of d.masses) {
    x += q.world.x * q.mass;
    z += q.world.z * q.mass;
    m += q.mass;
  }
  return [x / m, z / m];
}

/** Every mass moving as one rigid body turning `w` rad/s about the masses' centroid (v = w (z, −x)). */
function spinRigid(d: Seat, w: number): void {
  const [cx, cz] = centroid(d);
  for (const q of d.masses) {
    q.vel.x = w * (q.world.z - cz);
    q.vel.y = 0;
    q.vel.z = -w * (q.world.x - cx);
  }
}

/** Angular momentum about the centroid (y), all masses. */
function momentum(d: Seat): number {
  const [cx, cz] = centroid(d);
  let l = 0;
  for (const q of d.masses) l += q.mass * ((q.world.z - cz) * q.vel.x - (q.world.x - cx) * q.vel.z);
  return l;
}

describe("seating a wreck's wheels", () => {
  it("bad: a wreck turning 8 rad/s keeps its angular momentum through the seat (its wheels ride 10.7 m/s off the centroid: cut to 8, the wheels' share of L went)", () => {
    const d = wreck();
    spinRigid(d, 8);
    const hub = d.masses.find((q) => q.hub)!;
    const [cx, cz] = centroid(d);
    const arm = Math.hypot(hub.world.x - cx, hub.world.z - cz);
    assert.ok(8 * arm > 8.5, `the wheel rides ${(8 * arm).toFixed(2)} m/s off the centroid: no slip to test`);
    const l0 = momentum(d);
    d.seat();
    const l1 = momentum(d);
    assert.ok(Math.abs(l1 / l0 - 1) < 0.01, `L ${l0.toFixed(0)} → ${l1.toFixed(0)} kg·m²/s: a wheel turning with the body is not slipping`);
  });

  it("bad: a wheel 20 m/s off the body's speed at the wheel is still cut back to the slip limit, spin or none", () => {
    for (const w of [0, 8]) {
      const d = wreck();
      spinRigid(d, w);
      const hub = d.masses.find((q) => q.hub)!;
      const [cx, cz] = centroid(d);
      const bodyX = w * (hub.world.z - cz);
      const bodyZ = -w * (hub.world.x - cx);
      hub.vel.x = bodyX + 20;
      hub.vel.z = bodyZ;
      d.seat();
      const slip = Math.hypot(hub.vel.x - bodyX, hub.vel.z - bodyZ);
      assert.ok(slip > 7.5 && slip < 8.5, `spin ${w}: slip ${slip.toFixed(2)} m/s, 8 allowed`);
    }
  });
});
