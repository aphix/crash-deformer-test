import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { applyDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { JerseyBarrier } from "./engine-props.ts";
import { FleetRamps, RAMP } from "./fleet-ramps.ts";
import { setGround } from "../world/ground.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { paint } from "../vehicle/test-support.ts";
import { assignClass } from "../vehicle/vehicle-classes.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";
import { fit } from "../vehicle/ground-probe.test-util.ts";

/**
 * E1 of docs/UNIFIED_CONTACT.md (section 1.1, 7.1): the owner's ramp cases. A sedan cruises at v m/s with steer 0 and the
 * throttle holding its speed, at `th` degrees to the fleet ramp's long axis, its centreline crossing the toe line `e` m
 * inside the ramp's -x edge, so one or two wheels meet the wedge first (32 cells: th 0/15/30/45 x e -0.8..0.6, none aimed at a
 * wall). Per physics slice from the spawn until the car is up the wedge (z under the slab's end) or has crashed.
 */
const FRAME = 1 / 60;
const DEG = 180 / Math.PI;
const EDGE = -RAMP.halfW;
const TOE = RAMP.start + RAMP.len;
const TOUCH = 0.03;
const THS = [0, 15, 30, 45] as const;
const ES = [-0.8, -0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6] as const;
const SPEEDS = [8, 12, 20] as const;
/** The bars (docs/UNIFIED_CONTACT.md E1). */
const BAR = { yaw: 1.0, heading: 1.0, shove: 0.01, dv: 0.3, tilt: 1.5 } as const;

function wrap(a: number): number {
  let r = a;
  while (r > Math.PI) r -= 2 * Math.PI;
  while (r < -Math.PI) r += 2 * Math.PI;
  return r;
}

type Result = { yaw: number; heading: number; shove: number; dv: number; tilt: number; tiltAt: string; airWhileTouching: number; slices: number; crashed: boolean };

const _q = new THREE.Vector3();
const _ax = new THREE.Vector3();

/** Elevation (deg) of a body axis and the unit plan direction it points in (`dir`). */
function axis(q: THREE.Quaternion, x: number, y: number, z: number, dir: Float64Array): number {
  _ax.set(x, y, z).applyQuaternion(q);
  const len = Math.hypot(_ax.x, _ax.z);
  dir[0] = _ax.x / len;
  dir[1] = _ax.z / len;
  return Math.asin(_ax.y) * DEG;
}

/** Cross the toe once: the worst of every bar over every physics slice. */
function cross(v: number, thDeg: number, e: number): Result {
  const three = new THREE.Scene();
  const ramps = new FleetRamps(three);
  const slab = new JerseyBarrier(three, new THREE.Group());
  slab.reset();
  ramps.place(0, slab);
  setGround(ramps);
  const car = new DeformableCar(paint(), three);
  assignClass(car, "sedan");
  const w = newWorld([car], slab);
  w.collide = (c, _i, h) => void ramps.contact(c, h);
  const yaw = Math.PI + thDeg / DEG;
  const dx = Math.sin(yaw);
  const dz = Math.cos(yaw);
  car.spawnFacing(EDGE + e - dx * 10, TOE - dz * 10, yaw, v);
  const input: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
  const p = car.group.position;
  const out: Result = { yaw: 0, heading: 0, shove: 0, dv: 0, tilt: 0, tiltAt: "", airWhileTouching: 0, slices: 0, crashed: false };
  const yaw0 = car.group.rotation.y;
  const head0 = wrap(yaw);
  let lastVx = car.velocity.x;
  let lastVz = car.velocity.z;
  let lastX = p.x;
  let lastZ = p.z;
  const dirF = new Float64Array(2);
  const dirR = new Float64Array(2);
  const px = new Float64Array(4);
  const py = new Float64Array(4);
  const pz = new Float64Array(4);
  let acc = 0;
  for (let f = 0; f < 5 * 60; f++) {
    acc = Math.min(0.05, acc + FRAME);
    while (acc > 1e-5) {
      const h = physicsSlice(acc, sliceSpeed(w.cars));
      input.throttle = Math.max(0, Math.min(1, (v - Math.hypot(car.velocity.x, car.velocity.z)) / 1.5));
      applyDrive(car, input, h);
      stepWorld(w, h);
      car.stepBreakage(h);
      acc -= h;
      out.slices++;
      const fi = fit(car, ramps);
      let touching = 0;
      for (let i = 0; i < 4; i++) {
        car.wheels[i]!.getWorldPosition(_q);
        if (fi.gaps[i]! < TOUCH) {
          px[touching] = _q.x;
          pz[touching] = _q.z;
          py[touching] = ramps.heightAt(_q.x, _q.z, _q.y);
          touching++;
        }
      }
      if (fi.airborne && touching > 0) out.airWhileTouching++;
      out.yaw = Math.max(out.yaw, Math.abs(wrap(car.group.rotation.y - yaw0)) * DEG);
      out.heading = Math.max(out.heading, Math.abs(wrap(Math.atan2(car.velocity.x, car.velocity.z) - head0)) * DEG);
      out.dv = Math.max(out.dv, Math.hypot(car.velocity.x - lastVx, car.velocity.z - lastVz));
      out.shove = Math.max(out.shove, Math.hypot(p.x - lastX - car.velocity.x * h, p.z - lastZ - car.velocity.z * h));
      lastVx = car.velocity.x;
      lastVz = car.velocity.z;
      lastX = p.x;
      lastZ = p.z;
      if (touching >= 3) {
        // The plane through the touching wheels' ground points (least squares): y = a x + b z + c.
        let mx = 0;
        let my = 0;
        let mz = 0;
        for (let i = 0; i < touching; i++) {
          mx += px[i]! / touching;
          my += py[i]! / touching;
          mz += pz[i]! / touching;
        }
        let sxx = 0;
        let sxz = 0;
        let szz = 0;
        let sxy = 0;
        let szy = 0;
        for (let i = 0; i < touching; i++) {
          const ax = px[i]! - mx;
          const az = pz[i]! - mz;
          const ay = py[i]! - my;
          sxx += ax * ax;
          sxz += ax * az;
          szz += az * az;
          sxy += ax * ay;
          szy += az * ay;
        }
        const det = sxx * szz - sxz * sxz;
        if (Math.abs(det) > 1e-9) {
          const a = (sxy * szz - szy * sxz) / det;
          const b = (szy * sxx - sxy * sxz) / det;
          const q = car.group.quaternion;
          const pitch = axis(q, 0, 0, 1, dirF);
          const roll = axis(q, 1, 0, 0, dirR);
          const pitchErr = Math.abs(pitch - Math.atan(a * dirF[0]! + b * dirF[1]!) * DEG);
          const rollErr = Math.abs(roll - Math.atan(a * dirR[0]! + b * dirR[1]!) * DEG);
          const worst = Math.max(pitchErr, rollErr);
          if (worst > out.tilt) {
            out.tilt = worst;
            out.tiltAt = `${pitchErr > rollErr ? "pitch" : "roll"} at z ${p.z.toFixed(2)} on ${touching} wheels`;
          }
        }
      }
    }
    for (const c of w.cars) c.updateSkin();
    if (p.z < RAMP.start - 0.2 || car.crashed) break;
  }
  out.crashed = car.crashed;
  car.dispose();
  setGround(null);
  return out;
}

describe("given a sedan cruising at the fleet's jump ramp with steer 0 and the throttle holding its speed", () => {
  afterEach(() => setGround(null));

  for (const v of SPEEDS) {
    for (const th of THS) {
      for (const e of ES) {
        it(`when it drives at ${v} m/s at ${th}° to the ramp's axis and its centreline crosses the toe ${e} m inside the ramp's edge, then it keeps its heading within 1°, is never shoved sideways by more than 1 cm or changes speed by more than 0.3 m/s in a slice, stays within 1.5° of the plane through its touching wheels, and is airborne only while all four tyres are over 3 cm off the ground`, (t) => {
          const r = cross(v, th, e);
          t.diagnostic(
            `yaw ${r.yaw.toFixed(2)}°, velocity heading ${r.heading.toFixed(2)}°, shove ${(r.shove * 100).toFixed(2)} cm, dv ${r.dv.toFixed(3)} m/s, plane ${r.tilt.toFixed(2)}° (${r.tiltAt}), airborne with a tyre down in ${r.airWhileTouching} of ${r.slices} slices`,
          );
          const failures: string[] = [];
          if (r.crashed) failures.push("crashed");
          if (r.yaw > BAR.yaw) failures.push(`yaw ${r.yaw.toFixed(2)}°`);
          if (r.heading > BAR.heading) failures.push(`velocity heading ${r.heading.toFixed(2)}°`);
          if (r.shove > BAR.shove) failures.push(`shove ${(r.shove * 100).toFixed(2)} cm`);
          if (r.dv > BAR.dv) failures.push(`dv ${r.dv.toFixed(3)} m/s`);
          if (r.tilt > BAR.tilt) failures.push(`plane ${r.tilt.toFixed(2)}° (${r.tiltAt})`);
          if (r.airWhileTouching > 0) failures.push(`airborne with a tyre within 3 cm in ${r.airWhileTouching} slices`);
          assert.deepEqual(failures, []);
        });
      }
    }
  }
});
