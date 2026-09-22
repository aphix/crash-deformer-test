import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { physicsSlice } from "./sat.ts";
import { stepCarPair } from "./pair-contact.ts";
import { applyGroundFriction, CRASH } from "./physics-util.ts";

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
});
