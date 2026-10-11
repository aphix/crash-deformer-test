import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { paint } from "../vehicle/test-support.ts";
import { armKill, assignClass, killClass, type VehicleClassId } from "../vehicle/vehicle-classes.ts";
import type { CarStyleId } from "../vehicle/car-variants.ts";
import { launch } from "./crash-scenarios.test-util.ts";
import { newWorld, settleStep, stepWorld } from "../engine/world-step.ts";

/**
 * Not a test file itself. The owner's saved clip of 2026-10-07 (docs/UNIFIED_CONTACT.md): a hatchback driving at 98 km/h
 * into the right-rear wheel of a coupe crossing its path at 29 km/h, restaged on fresh cars (the clip's own geometry and
 * speeds, each car starting half a second back on its own path).
 */

const SLICE = Math.fround(1 / 240);
/** Slices (1/240 s) of the world after the first touch that the cars are read at: the touch itself is over (it lasts 4 slices), the tyres' grip has had 0.1 s. */
export const READ_AFTER = 24;

function dressedCar(style: CarStyleId, vehicleClass: VehicleClassId, slot: number): DeformableCar {
  const car = new DeformableCar({ body: 0xffffff, accent: 0x404040, name: style }, new THREE.Scene(), null, style);
  assignClass(car, vehicleClass);
  car.group.userData.carIndex = slot;
  car.deform.squash = 0.32;
  car.deform.buckle = 0.45;
  car.deform.setMode("shape");
  armKill(car.deform, killClass(car), 0.25, "default");
  return car;
}

/** A car's motion as its masses carry it: centre, velocity, yaw rate (rad/s about +y), and the inertia about the centre. */
export type Motion = { mass: number; x: number; z: number; vx: number; vz: number; yawRate: number; inertia: number };

export function motionOf(car: DeformableCar): Motion {
  const masses = car.deform.masses;
  let mass = 0;
  let cx = 0;
  let cz = 0;
  let px = 0;
  let pz = 0;
  for (const m of masses) {
    mass += m.mass;
    cx += m.mass * m.world.x;
    cz += m.mass * m.world.z;
    px += m.mass * m.vel.x;
    pz += m.mass * m.vel.z;
  }
  cx /= mass;
  cz /= mass;
  const vx = px / mass;
  const vz = pz / mass;
  let angular = 0;
  let inertia = 0;
  for (const m of masses) {
    const rx = m.world.x - cx;
    const rz = m.world.z - cz;
    angular += m.mass * (rz * (m.vel.x - vx) - rx * (m.vel.z - vz));
    inertia += m.mass * (rx * rx + rz * rz);
  }
  return { mass, x: cx, z: cz, vx, vz, yawRate: angular / inertia, inertia };
}

/** What the restaged hit did, read off the cars' masses. */
export type OwnerHit = {
  /** Both cars' motion in the slice before the first touch, and `READ_AFTER` slices after it. */
  before: [Motion, Motion];
  after: [Motion, Motion];
  /** Where the striker's front-right corner was when the cars first touched, and the unit normal out of the struck car's right side. */
  point: THREE.Vector3;
  normal: THREE.Vector3;
};

/**
 * The striker (A, hatchback, 858 kg) drives at `speedA` m/s along +x, 0.7 degrees off it, its front-right corner onto the
 * struck car's (B, coupe, 858 kg) right side; B drives along -z at 8.03 m/s and starts `aim` m further along z than the clip
 * had it (0: the wheel 1.65 m behind B's centre; negative: nearer its middle; positive: nearer its tail).
 */
export function ownerHit(aim: number, speedA = 27.301): OwnerHit {
  const a = dressedCar("hatchback", "sedan", 0);
  const b = dressedCar("coupe", "muscle", 27);
  const yawA = Math.atan2(27.536, -0.331);
  const vax = Math.sin(yawA) * speedA;
  const vaz = Math.cos(yawA) * speedA;
  const lead = 0.5;
  launch(a, 119.122 - vax * lead, 55.312 - vaz * lead, yawA, vax, vaz);
  launch(b, 122.3, 53.296 - aim + 8.034 * lead, Math.PI, 0, -8.034);
  const cars = [a, b];
  const world = newWorld(cars, null, null);
  let touchedAt = -1;
  let step = 0;
  // The rigid answer is taken at the contact the engine reports for the first touch (the overlap patch's centre: the nose's face
  // against a flat flank presses at its middle, half a nose's width from the corner that touches first), along the struck car's side.
  const point = new THREE.Vector3();
  world.pairHit = (_i, _j, hit) => {
    if (touchedAt < 0 && hit.impulse > 0.2) {
      touchedAt = step;
      point.copy(hit.contact);
    }
  };
  let before: [Motion, Motion] = [motionOf(a), motionOf(b)];
  const normal = new THREE.Vector3();
  for (; step < 240 * 3; step++) {
    const last: [Motion, Motion] = [motionOf(a), motionOf(b)];
    stepWorld(world, SLICE);
    settleStep(cars, SLICE, false);
    if (touchedAt === step) {
      before = last;
      normal.set(b.rightFlat.x, 0, b.rightFlat.z);
    }
    if (touchedAt >= 0 && step === touchedAt + READ_AFTER) break;
  }
  if (touchedAt < 0) throw new Error("the restaged cars never touched");
  return { before, after: [motionOf(a), motionOf(b)], point, normal };
}

/**
 * What a rigid-body impulse with no rebound at the touching point gives each car (momentum and angular momentum kept, the points leave
 * together), then Coulomb friction `mu` on the sliding of the points that is left, along the contact's tangent: the textbook answer,
 * from vectors.
 */
export type Rigid = { impulse: number; dvA: THREE.Vector3; dvB: THREE.Vector3; dwA: number; dwB: number; crushJ: number };

export function rigidExchange(hit: OwnerHit, mu: number): Rigid {
  const [a, b] = hit.before;
  const n = hit.normal;
  const t = new THREE.Vector3(-n.z, 0, n.x);
  const rA = new THREE.Vector3(hit.point.x - a.x, 0, hit.point.z - a.z);
  const rB = new THREE.Vector3(hit.point.x - b.x, 0, hit.point.z - b.z);
  const leverA = new THREE.Vector3().crossVectors(rA, n).y;
  const leverB = new THREE.Vector3().crossVectors(rB, n).y;
  const closing = -((a.vx - b.vx) * n.x + (a.vz - b.vz) * n.z);
  const inverse = 1 / a.mass + 1 / b.mass + (leverA * leverA) / a.inertia + (leverB * leverB) / b.inertia;
  const impulse = closing / inverse;
  const dvA = n.clone().multiplyScalar(impulse / a.mass);
  const dvB = n.clone().multiplyScalar(-impulse / b.mass);
  let dwA = (impulse * leverA) / a.inertia;
  let dwB = (-impulse * leverB) / b.inertia;
  // The points' velocities (v + w x r = (vx + w rz, vz - w rx)) after the normal impulse, and the sliding along the tangent.
  const wA = a.yawRate + dwA;
  const wB = b.yawRate + dwB;
  const slide =
    (a.vx + dvA.x + wA * rA.z - (b.vx + dvB.x + wB * rB.z)) * t.x + (a.vz + dvA.z - wA * rA.x - (b.vz + dvB.z - wB * rB.x)) * t.z;
  const leverAt = new THREE.Vector3().crossVectors(rA, t).y;
  const leverBt = new THREE.Vector3().crossVectors(rB, t).y;
  const tangential = 1 / a.mass + 1 / b.mass + (leverAt * leverAt) / a.inertia + (leverBt * leverBt) / b.inertia;
  const friction = Math.max(-mu * impulse, Math.min(mu * impulse, -slide / tangential));
  dvA.addScaledVector(t, friction / a.mass);
  dvB.addScaledVector(t, -friction / b.mass);
  dwA += (friction * leverAt) / a.inertia;
  dwB -= (friction * leverBt) / b.inertia;
  return { impulse, dvA, dvB, dwA, dwB, crushJ: (0.5 * closing * closing) / inverse };
}
