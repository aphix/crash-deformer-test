import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applyDrive, type DriveInput } from "./car-drive.ts";
import { DeformableCar } from "./car.ts";
import { TYRE_R } from "../deform/deform-state.ts";
import { setGround, type Ground } from "../world/ground.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { paint } from "./test-support.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";

/**
 * The owner's ramp test: a car dropped 0.5 m onto a wedge, brake and handbrake held, must settle with all
 * four tyres on the face and the body on the slope. The wedge rises along +X from x = −10 to x = 10, flat
 * below and on top; the car drops mid-face at the origin. Not exported: RapierEval reads it as the spec.
 */
const FOOT = -10;
const RUN = 20;
const FRAME = 1 / 60;
const SETTLE_S = 3;
const BRAKE: DriveInput = { throttle: 0, steer: 0, brake: 1, ebrake: true, boost: false };
const DEG = Math.PI / 180;

function wedge(deg: number): Ground {
  const t = Math.tan(deg * DEG);
  const s = Math.sin(deg * DEG);
  const c = Math.cos(deg * DEG);
  return {
    heightAt: (x) => Math.max(0, Math.min(RUN * t, (x - FOOT) * t)),
    normalAt: (x, _z, out) => {
      const face = x > FOOT && x < FOOT + RUN;
      out.x = face ? -s : 0;
      out.y = face ? c : 1;
      out.z = 0;
      return out;
    },
    frictionAt: () => 1,
    surfaceAt: () => "asphalt",
  };
}

/** Yaw (forward = (sin yaw, 0, cos yaw)) for each heading, seen from the foot of the ramp looking up it (+X). */
const HEADINGS = { up: Math.PI / 2, down: -Math.PI / 2, left: Math.PI, right: 0 } as const;

type Settled = { gaps: number[]; pitchErr: number; rollErr: number; tiltErr: number; pitch: number; roll: number; slide: number };

/** Elevation (deg) a horizontal unit direction (dx, dz) takes when laid onto the face: atan(tan θ · (d · uphill)). */
function faceElevation(deg: number, dx: number): number {
  return Math.atan(Math.tan(deg * DEG) * dx) / DEG;
}

function settle(deg: number, yaw: number): Settled {
  const g = wedge(deg);
  setGround(g);
  const car = new DeformableCar(paint(), new THREE.Scene());
  car.spawnFacing(0, 0, yaw, 0);
  car.group.position.y = g.heightAt(0, 0) + 0.5;
  const w = newWorld([car]);
  let acc = 0;
  for (let f = 0; f < SETTLE_S / FRAME; f++) {
    acc = Math.min(0.05, acc + FRAME);
    while (acc > 1e-5) {
      const h = physicsSlice(acc, sliceSpeed(w.cars));
      applyDrive(car, BRAKE, h);
      stepWorld(w, h);
      acc -= h;
    }
    car.updateSkin();
  }
  car.group.updateWorldMatrix(true, true);
  const s = Math.sin(deg * DEG);
  const c = Math.cos(deg * DEG);
  const p = new THREE.Vector3();
  // Tyre clearance along the face normal: wheel centre's distance from the face plane minus the tyre radius.
  const gaps = car.wheels.map((wh) => {
    wh.getWorldPosition(p);
    return (p.x - FOOT) * -s + p.y * c - TYRE_R;
  });
  const q = car.group.quaternion;
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const left = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const pitch = Math.asin(fwd.y) / DEG;
  const roll = Math.asin(left.y) / DEG;
  // Expected: the spawn heading's forward and left (up × forward) laid onto the face.
  const pitchErr = pitch - faceElevation(deg, Math.sin(yaw));
  const rollErr = roll - faceElevation(deg, Math.cos(yaw));
  const tiltErr = Math.acos(Math.min(1, up.x * -s + up.y * c)) / DEG;
  const slide = Math.hypot(car.group.position.x, car.group.position.z);
  car.dispose();
  return { gaps, pitchErr, rollErr, tiltErr, pitch, roll, slide };
}

describe("ramp: a braked car dropped on a wedge settles onto the face", () => {
  afterEach(() => setGround(null));

  for (const deg of [10, 20, 30]) {
    for (const [name, yaw] of Object.entries(HEADINGS)) {
      it(`${deg}° facing ${name}: 4 tyres within 2 cm of the face, pitch/roll within 1.5° of the slope${deg < 30 ? ", slide ≤ 0.5 m" : ""}`, (t) => {
        const r = settle(deg, yaw);
        t.diagnostic(
          `${deg}° ${name}: gaps ${r.gaps.map((v) => v.toFixed(3)).join("/")} m, pitch ${r.pitch.toFixed(2)}° (err ${r.pitchErr.toFixed(2)}), roll ${r.roll.toFixed(2)}° (err ${r.rollErr.toFixed(2)}), tilt ${r.tiltErr.toFixed(2)}°, slide ${r.slide.toFixed(3)} m`,
        );
        const failures: string[] = [];
        r.gaps.forEach((gap, i) => {
          if (Math.abs(gap) > 0.02) failures.push(`wheel ${i} gap ${gap.toFixed(3)} m`);
        });
        if (Math.abs(r.pitchErr) > 1.5) failures.push(`pitch ${r.pitch.toFixed(2)}° vs face ${(r.pitch - r.pitchErr).toFixed(2)}°`);
        if (Math.abs(r.rollErr) > 1.5) failures.push(`roll ${r.roll.toFixed(2)}° vs face ${(r.roll - r.rollErr).toFixed(2)}°`);
        if (r.tiltErr > 1.5) failures.push(`body up ${r.tiltErr.toFixed(2)}° off the face normal`);
        if (deg < 30 && r.slide > 0.5) failures.push(`slid ${r.slide.toFixed(3)} m`);
        assert.deepEqual(failures, []);
      });
    }
  }
});
