import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { COM_Y } from "../vehicle/car-air.ts";
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
 * wall). Per physics slice from the spawn until the car is up the wedge (z under the slab's end) or has crashed. "The plane
 * through its touching wheels" is fitted through each touching tyre's tread contact point (the tread point with the smallest
 * gap: its x, z and the ground height under it), as docs/UNIFIED_CONTACT.md 10.5 designs the wheel contact: a tyre on a ramp's
 * edge rests on the edge, whichever side of it the hub is.
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

type Result = {
  yaw: number;
  heading: number;
  shove: number;
  dv: number;
  tilt: number;
  tiltAt: string;
  airWhileTouching: number;
  slices: number;
  crashed: boolean;
  /** Worst angle (deg) between the plane through the touching wheels' hub points and the one through their tread contact points, over the slices where every one of those points has the same ground normal (one plane under all of them). */
  planeGap: number;
  /** Slices that `planeGap` covers, and of those the ones on level ground. */
  planeSlices: number;
  flatSlices: number;
};

const _q = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Elevation (deg) of a body axis and the unit plan direction it points in (`dir`). */
function axis(q: THREE.Quaternion, x: number, y: number, z: number, dir: Float64Array): number {
  _ax.set(x, y, z).applyQuaternion(q);
  const len = Math.hypot(_ax.x, _ax.z);
  dir[0] = _ax.x / len;
  dir[1] = _ax.z / len;
  return Math.asin(_ax.y) * DEG;
}

/** Least-squares plane y = a x + b z + c through the first n points (into `abc`); false when they are collinear. */
function fitPlane(px: Float64Array, py: Float64Array, pz: Float64Array, n: number, abc: Float64Array): boolean {
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (let i = 0; i < n; i++) {
    mx += px[i]! / n;
    my += py[i]! / n;
    mz += pz[i]! / n;
  }
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  let sxy = 0;
  let szy = 0;
  for (let i = 0; i < n; i++) {
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
  if (!(Math.abs(det) > 1e-9)) return false;
  abc[0] = (sxy * szz - szy * sxz) / det;
  abc[1] = (szy * sxx - sxy * sxz) / det;
  abc[2] = my - abc[0]! * mx - abc[1]! * mz;
  return true;
}

/** Angle (deg) between two fitted planes. */
function planeAngle(p: Float64Array, q: Float64Array): number {
  const dot = (p[0]! * q[0]! + 1 + p[1]! * q[1]!) / (Math.hypot(p[0]!, 1, p[1]!) * Math.hypot(q[0]!, 1, q[1]!));
  return Math.acos(Math.min(1, dot)) * DEG;
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
  const out: Result = { yaw: 0, heading: 0, shove: 0, dv: 0, tilt: 0, tiltAt: "", airWhileTouching: 0, slices: 0, crashed: false, planeGap: 0, planeSlices: 0, flatSlices: 0 };
  const yaw0 = car.group.rotation.y;
  const head0 = wrap(yaw);
  let lastVx = car.velocity.x;
  let lastVz = car.velocity.z;
  let lastX = p.x;
  let lastZ = p.z;
  _c.set(0, COM_Y, 0).applyQuaternion(car.group.quaternion);
  let lastCx = p.x + _c.x;
  let lastCz = p.z + _c.z;
  const dirF = new Float64Array(2);
  const dirR = new Float64Array(2);
  // The touching wheels' hub points (x, the ground's height under the hub, z) and tread contact points (`Fit.contacts`).
  const hx = new Float64Array(4);
  const hy = new Float64Array(4);
  const hz = new Float64Array(4);
  const cx = new Float64Array(4);
  const cy = new Float64Array(4);
  const cz = new Float64Array(4);
  const planeC = new Float64Array(3);
  const planeH = new Float64Array(3);
  const normal0 = new THREE.Vector3();
  const normal = new THREE.Vector3();
  let acc = 0;
  for (let f = 0; f < 5 * 60; f++) {
    acc = Math.min(0.05, acc + FRAME);
    while (acc > 1e-5) {
      const h = physicsSlice(acc, sliceSpeed(w.cars));
      input.throttle = Math.max(0, Math.min(1, (v - Math.hypot(car.velocity.x, car.velocity.z)) / 1.5));
      applyDrive(car, input, h);
      // `velocity` is the origin's on the wheels and the centre of mass's in the rigid step (`DeformableCar.rigid`): a slice the body
      // spends rigid throughout shoves it by its centre's move past that velocity (a body turning about its centre swings its origin,
      // and that is no shove); any other slice by its origin's (a landing lays the body on its wheels' plane about the origin).
      const rigid = car.rigid;
      stepWorld(w, h);
      car.stepBreakage(h);
      acc -= h;
      out.slices++;
      const fi = fit(car, ramps);
      let touching = 0;
      for (let i = 0; i < 4; i++) {
        if (fi.gaps[i]! >= TOUCH) continue;
        car.wheels[i]!.getWorldPosition(_q);
        hx[touching] = _q.x;
        hz[touching] = _q.z;
        hy[touching] = ramps.heightAt(_q.x, _q.z, _q.y);
        cx[touching] = fi.contacts[i * 3]!;
        cy[touching] = fi.contacts[i * 3 + 1]!;
        cz[touching] = fi.contacts[i * 3 + 2]!;
        touching++;
      }
      if (fi.airborne && touching > 0) out.airWhileTouching++;
      out.yaw = Math.max(out.yaw, Math.abs(wrap(car.group.rotation.y - yaw0)) * DEG);
      out.heading = Math.max(out.heading, Math.abs(wrap(Math.atan2(car.velocity.x, car.velocity.z) - head0)) * DEG);
      out.dv = Math.max(out.dv, Math.hypot(car.velocity.x - lastVx, car.velocity.z - lastVz));
      _c.set(0, COM_Y, 0).applyQuaternion(car.group.quaternion);
      const com = rigid && car.rigid;
      const mx = com ? p.x + _c.x - lastCx : p.x - lastX;
      const mz = com ? p.z + _c.z - lastCz : p.z - lastZ;
      out.shove = Math.max(out.shove, Math.hypot(mx - car.velocity.x * h, mz - car.velocity.z * h));
      lastVx = car.velocity.x;
      lastVz = car.velocity.z;
      lastX = p.x;
      lastZ = p.z;
      lastCx = p.x + _c.x;
      lastCz = p.z + _c.z;
      if (touching >= 3 && fitPlane(cx, cy, cz, touching, planeC)) {
        // The plane through the touching wheels' tread contact points (least squares): y = a x + b z + c.
        const q = car.group.quaternion;
        const pitch = axis(q, 0, 0, 1, dirF);
        const roll = axis(q, 1, 0, 0, dirR);
        const pitchErr = Math.abs(pitch - Math.atan(planeC[0]! * dirF[0]! + planeC[1]! * dirF[1]!) * DEG);
        const rollErr = Math.abs(roll - Math.atan(planeC[0]! * dirR[0]! + planeC[1]! * dirR[1]!) * DEG);
        const worst = Math.max(pitchErr, rollErr);
        if (worst > out.tilt) {
          out.tilt = worst;
          out.tiltAt = `${pitchErr > rollErr ? "pitch" : "roll"} at z ${p.z.toFixed(2)} on ${touching} wheels`;
        }
        // One plane under every point: the same ground normal at the hubs and at the contacts. There the two fits are the same plane.
        let one = fitPlane(hx, hy, hz, touching, planeH);
        ramps.normalAt(hx[0]!, hz[0]!, normal0, hy[0]! + 0.5);
        for (let i = 0; one && i < touching; i++) {
          ramps.normalAt(hx[i]!, hz[i]!, normal, hy[i]! + 0.5);
          if (normal.distanceTo(normal0) > 1e-9) one = false;
          ramps.normalAt(cx[i]!, cz[i]!, normal, cy[i]! + 0.5);
          if (normal.distanceTo(normal0) > 1e-9) one = false;
        }
        if (one) {
          out.planeSlices++;
          if (normal0.y > 1 - 1e-12) out.flatSlices++;
          out.planeGap = Math.max(out.planeGap, planeAngle(planeH, planeC));
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

describe("given a sedan driving up the middle of the ramp's wedge, so its tyres stand on the level floor and then on the wedge's one plane", () => {
  afterEach(() => setGround(null));

  it("when the plane through its touching wheels is fitted at their tread contact points and at their hub points, then the two planes agree within 0.01° wherever the ground under all of those points is one plane", () => {
    const r = cross(8, 0, RAMP.halfW);
    assert.ok(r.flatSlices >= 10, `only ${r.flatSlices} slices with every point on level ground`);
    assert.ok(r.planeSlices - r.flatSlices >= 5, `only ${r.planeSlices - r.flatSlices} slices with every point on the wedge's slope`);
    assert.ok(r.planeGap <= 0.01, `the planes differ by ${r.planeGap.toFixed(4)}° over ${r.planeSlices} single-plane slices`);
  });
});
