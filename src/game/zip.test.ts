import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { physicsSlice } from "./sat.ts";
import { stepCarPair } from "./pair-contact.ts";
import { applyGroundFriction, leftoverCrumple, CRASH } from "./physics-util.ts";

const IMPACT_SCALE = 0.032;

/** Exact spawn from the 2026-09-22 setup JSON. */
const SETUP = {
  cars: [
    {
      paint: "Titanium",
      spawn: { x: 2.7539, y: 0, z: 8.7782 },
      yaw: -2.8376,
      speed: 28.2381,
      vel: { x: -8.4528, y: 0, z: -26.9433 },
    },
    {
      paint: "Petrol",
      spawn: { x: -2.7539, y: 0, z: -8.7782 },
      yaw: 0.304,
      speed: 4.9748,
      vel: { x: 1.4891, y: 0, z: 4.7467 },
    },
  ],
};

function place(car: DeformableCar, spec: (typeof SETUP.cars)[number]): void {
  car.deform.setMode("shape");
  car.deform.squash = 0.4;
  car.deform.buckle = 0.45;
  car.group.position.set(spec.spawn.x, spec.spawn.y, spec.spawn.z);
  car.group.rotation.set(0, spec.yaw, 0, "YXZ");
  car.yaw = spec.yaw;
  car.refreshBasis();
  car.spawnSpeed = spec.speed;
  car.speed = spec.speed;
  car.velocity.set(spec.vel.x, spec.vel.y, spec.vel.z);
  car.angular.set(0, 0, 0);
  car.deform.bindKinematic(car.group, car.velocity, car.angular);
}

function bleed(car: DeformableCar, dt: number): void {
  if (!car.crashed) return;
  const q = car.deform.quietTime();
  const mu = q < 0.15 ? CRASH.muScuff : CRASH.muSlide * (1 + Math.min(1.4, q));
  applyGroundFriction(car.velocity, dt, mu, true);
}

describe("captured two-car spawn must not zip at slomo handoff", () => {
  it("bad: 10 s wall with built-in slomo must stay well under crash speed", () => {
    const scene = new THREE.Scene();
    const a = new DeformableCar({ body: 0xc5c8ce, accent: 0x9aa0a8, name: "Titanium" }, scene);
    const b = new DeformableCar({ body: 0x3d8a86, accent: 0x2a6360, name: "Petrol" }, scene);
    place(a, SETUP.cars[0]!);
    place(b, SETUP.cars[1]!);

    let wall = 0;
    let timeScale = 1;
    let targetScale = 1;
    let phase: "approach" | "impact" | "slowmo" | "aftermath" = "approach";
    let wallSinceImpact = 0;
    let acc = 0;
    let peakKph = 0;
    let kphAt10 = 0;
    const closing0 = a.velocity.clone().sub(b.velocity).length() * 3.6;

    const wallDt = 1 / 60;
    while (wall < 10.02) {
      wall += wallDt;
      if (phase !== "approach") wallSinceImpact += wallDt;
      if (phase === "impact" && wallSinceImpact > 0.12) phase = "slowmo";
      else if (phase === "slowmo" && wallSinceImpact > 6.5) {
        targetScale = 1;
        phase = "aftermath";
      }
      timeScale += (targetScale - timeScale) * Math.min(1, wallDt * (phase === "aftermath" ? 1.15 : 3.2));

      acc += wallDt * timeScale;
      if (acc > 0.05) acc = 0.05;
      const vmax = Math.max(a.velocity.length(), b.velocity.length(), 4);
      while (acc > 1e-5) {
        const h = physicsSlice(acc, vmax);
        stepCarPair(a, b, h);
        bleed(a, h);
        bleed(b, h);
        acc -= h;
        if (phase === "approach" && (a.crashed || b.crashed)) {
          phase = "impact";
          wallSinceImpact = 0;
          targetScale = IMPACT_SCALE;
          if (timeScale > IMPACT_SCALE * 1.15) timeScale = IMPACT_SCALE;
        }
      }

      const kph = Math.max(a.velocity.length(), b.velocity.length()) * 3.6;
      if (kph > peakKph) peakKph = kph;
      if (wall >= 10) kphAt10 = kph;
    }

    assert.ok(a.crashed || b.crashed, "setup never collided");
    assert.ok(
      kphAt10 < closing0 * 0.55,
      `10s zip ${kphAt10.toFixed(0)} km/h (closing was ${closing0.toFixed(0)}, peak ${peakKph.toFixed(0)}) petrol=${(b.velocity.length() * 3.6).toFixed(0)} titanium=${(a.velocity.length() * 3.6).toFixed(0)}`,
    );
    assert.ok(
      b.velocity.length() * 3.6 < 70,
      `petrol (green) wild accel ${(b.velocity.length() * 3.6).toFixed(0)} km/h`,
    );
  });

  it("bad: offset spawn with slomo off must not start a lateral slide at ~9s", () => {
    const scene = new THREE.Scene();
    const a = new DeformableCar({ body: 0xc5c8ce, accent: 0x9aa0a8, name: "Titanium" }, scene);
    const b = new DeformableCar({ body: 0x3d8a86, accent: 0x2a6360, name: "Petrol" }, scene);
    place(a, {
      paint: "Titanium",
      spawn: { x: 4.6891, y: 0, z: 7.9153 },
      yaw: -2.6068,
      speed: 14.2597,
      vel: { x: -7.268, y: 0, z: -12.2684 },
    });
    place(b, {
      paint: "Petrol",
      spawn: { x: -4.6891, y: 0, z: -7.9153 },
      yaw: 0.5348,
      speed: 27.7548,
      vel: { x: 14.1463, y: 0, z: 23.8791 },
    });

    let wall = 0;
    let acc = 0;
    let crashedAt = -1;
    let speedAt89 = 0;
    let latAt89 = 0;
    let peakAfter6 = 0;
    let speedAt6 = 0;
    const wallDt = 1 / 60;
    const samples: string[] = [];

    while (wall < 10.02) {
      wall += wallDt;
      acc += wallDt;
      if (acc > 0.05) acc = 0.05;
      const vmax = Math.max(a.velocity.length(), b.velocity.length(), 4);
      while (acc > 1e-5) {
        const h = physicsSlice(acc, vmax);
        stepCarPair(a, b, h);
        bleed(a, h);
        bleed(b, h);
        acc -= h;
      }
      if (crashedAt < 0 && (a.crashed || b.crashed)) crashedAt = wall;
      const sa = a.velocity.length();
      const sb = b.velocity.length();
      const speed = Math.max(sa, sb);
      const fa = a.fwdFlat;
      const fb = b.fwdFlat;
      const latA = Math.abs(a.velocity.x * fa.z - a.velocity.z * fa.x);
      const latB = Math.abs(b.velocity.x * fb.z - b.velocity.z * fb.x);
      const lat = Math.max(latA, latB);
      if (wall >= 6 && speed > peakAfter6) peakAfter6 = speed;
      if (Math.abs(wall - 6) < wallDt) speedAt6 = speed;
      if (Math.abs(wall - 8.9) < wallDt) {
        speedAt89 = speed;
        latAt89 = lat;
      }
      const t = Math.round(wall);
      if (Math.abs(wall - t) < wallDt * 0.6 && t >= 0 && t <= 10) {
        samples.push(
          `t=${t} a=${(sa * 3.6).toFixed(0)} latA=${(latA * 3.6).toFixed(0)} b=${(sb * 3.6).toFixed(0)} latB=${(latB * 3.6).toFixed(0)} q=${a.deform.quietTime().toFixed(2)}/${b.deform.quietTime().toFixed(2)} dist=${a.group.position.distanceTo(b.group.position).toFixed(2)} leftover=${leftoverCrumple(a.deform.crumpleTravelCorner()).toFixed(2)}/${leftoverCrumple(b.deform.crumpleTravelCorner()).toFixed(2)} yaw=${a.yaw.toFixed(2)}/${b.yaw.toFixed(2)}`,
        );
      }
    }

    assert.ok(crashedAt >= 0, "setup never collided");
    assert.ok(
      speedAt89 < 4 && latAt89 < 3,
      `8.9s slide ${(speedAt89 * 3.6).toFixed(0)} km/h (lat ${(latAt89 * 3.6).toFixed(0)}) peakAfter6=${(peakAfter6 * 3.6).toFixed(0)} at6=${(speedAt6 * 3.6).toFixed(0)} crashedAt=${crashedAt.toFixed(2)}\n${samples.join("\n")}`,
    );
  });

  it("bad: offset 16 vs 20 m/s must not reverse-slide the wreck by 11s", () => {
    const scene = new THREE.Scene();
    const a = new DeformableCar({ body: 0xc5c8ce, accent: 0x9aa0a8, name: "Titanium" }, scene);
    const b = new DeformableCar({ body: 0x3d8a86, accent: 0x2a6360, name: "Petrol" }, scene);
    place(a, {
      paint: "Titanium",
      spawn: { x: 7.4084, y: 0, z: 5.4548 },
      yaw: -2.2055,
      speed: 16.3694,
      vel: { x: -13.1817, y: 0, z: -9.7056 },
    });
    place(b, {
      paint: "Petrol",
      spawn: { x: -7.4084, y: 0, z: -5.4548 },
      yaw: 0.9361,
      speed: 20.1106,
      vel: { x: 16.1944, y: 0, z: 11.9239 },
    });
    const fwdA0 = { x: a.velocity.x, z: a.velocity.z };
    const lenA0 = Math.hypot(fwdA0.x, fwdA0.z) || 1;
    fwdA0.x /= lenA0;
    fwdA0.z /= lenA0;
    const fwdB0 = { x: b.velocity.x, z: b.velocity.z };
    const lenB0 = Math.hypot(fwdB0.x, fwdB0.z) || 1;
    fwdB0.x /= lenB0;
    fwdB0.z /= lenB0;

    let wall = 0;
    let acc = 0;
    let crashedAt = -1;
    let posA2: { x: number; z: number } | null = null;
    let posB2: { x: number; z: number } | null = null;
    const wallDt = 1 / 60;
    const samples: string[] = [];

    while (wall < 11.05) {
      wall += wallDt;
      acc += wallDt;
      if (acc > 0.05) acc = 0.05;
      const vmax = Math.max(a.velocity.length(), b.velocity.length(), 4);
      while (acc > 1e-5) {
        const h = physicsSlice(acc, vmax);
        stepCarPair(a, b, h);
        bleed(a, h);
        bleed(b, h);
        acc -= h;
      }
      if (crashedAt < 0 && (a.crashed || b.crashed)) crashedAt = wall;
      if (posA2 == null && wall >= 2) {
        posA2 = { x: a.group.position.x, z: a.group.position.z };
        posB2 = { x: b.group.position.x, z: b.group.position.z };
      }
      const alongA = a.velocity.x * fwdA0.x + a.velocity.z * fwdA0.z;
      const alongB = b.velocity.x * fwdB0.x + b.velocity.z * fwdB0.z;
      const t = Math.round(wall);
      if (Math.abs(wall - t) < wallDt * 0.6 && t >= 0 && t <= 11) {
        samples.push(
          `t=${t} alongA=${alongA.toFixed(2)} alongB=${alongB.toFixed(2)} spA=${a.velocity.length().toFixed(2)} spB=${b.velocity.length().toFixed(2)} dist=${a.group.position.distanceTo(b.group.position).toFixed(2)} q=${a.deform.quietTime().toFixed(2)} leftover=${leftoverCrumple(a.deform.crumpleTravelCorner()).toFixed(2)}/${leftoverCrumple(b.deform.crumpleTravelCorner()).toFixed(2)} posA=${a.group.position.x.toFixed(2)},${a.group.position.z.toFixed(2)}`,
        );
      }
    }

    const driftA = posA2 ? Math.hypot(a.group.position.x - posA2.x, a.group.position.z - posA2.z) : 99;
    const driftB = posB2 ? Math.hypot(b.group.position.x - posB2.x, b.group.position.z - posB2.z) : 99;
    const alongA = a.velocity.x * fwdA0.x + a.velocity.z * fwdA0.z;
    const alongB = b.velocity.x * fwdB0.x + b.velocity.z * fwdB0.z;
    assert.ok(crashedAt >= 0, "setup never collided");
    assert.ok(
      driftA < 2.5 && driftB < 2.5 && alongA > -1.2 && alongB > -1.2,
      `reverse slide driftA=${driftA.toFixed(2)} driftB=${driftB.toFixed(2)} alongA=${alongA.toFixed(2)} alongB=${alongB.toFixed(2)} crashedAt=${crashedAt.toFixed(2)}\n${samples.join("\n")}`,
    );
  });
});
