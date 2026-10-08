import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { armKill, assignClass, HANDLING, killClass } from "../vehicle/vehicle-classes.ts";
import { paint } from "../vehicle/test-support.ts";
import { makeWorld, tickWorld, type CrashWorld } from "../contact/crash-scenarios.test-util.ts";
import { setGround } from "../world/ground.ts";
import { RagdollSystem } from "../present/engine-ragdoll.ts";
import { AIR_LINEAR } from "../present/ragdoll-body.ts";
import { BOARD, type LabLayout, type LabPresetId } from "../scenes/lab.ts";
import { G } from "../vehicle/car-air.ts";
import { Lab, WALL, type LabShot } from "./engine-lab.ts";

/** Headless Lab: a layout's cars built and placed, the Lab's ground made active, its hooks on the engine's step (`tickWorld`); `dolls`: the dummies' world, when the rig has one. */
export type LabRig = { lab: Lab; cars: DeformableCar[]; w: CrashWorld; dolls: RagdollSystem | null };

const FRAME = 1 / 60;

export function labRig(layout: LabLayout | LabPresetId, dolls: RagdollSystem | null = null): LabRig {
  const lab = new Lab();
  lab.dolls = dolls;
  lab.load(layout);
  setGround(lab.ground);
  const cars = lab.types.map((t) => {
    const car = new DeformableCar(paint(), new THREE.Scene(), null, t.style);
    assignClass(car, t.cls);
    armKill(car.deform, killClass(car), HANDLING.realism, "default");
    return car;
  });
  lab.placeCars(cars);
  const w = makeWorld(cars, false, false);
  w.world.collide = lab.collide;
  w.world.pairHit = lab.pairHit;
  w.world.beforeSlice = lab.slice;
  return { lab, cars, w, dolls };
}

/** `labRig` with the dummies' world loaded (Rapier), as the engine has it once it is in: the layout's dummies stand at their poses. */
export async function labDollRig(layout: LabLayout | LabPresetId): Promise<LabRig> {
  const dolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  await dolls.preload();
  return labRig(layout, dolls);
}

/** `seconds` of sim at 60 frames a second (`tickWorld`: the engine's frame, then the dummies' step); the Lab reads the world before every slice. */
export function runLab(r: LabRig, seconds: number): void {
  for (let t = 0; t < seconds - 1e-9; t += FRAME) {
    tickWorld(r.w, FRAME);
    r.dolls?.update(FRAME * r.w.clock.timeScale, r.cars, true, true, 0, null);
  }
}

const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _velocity = new THREE.Vector3();

/**
 * Let item `thing` go at the velocity that carries it in a straight line at `speed` m/s on average from where it is to item `target`'s
 * middle (a dummy to a car: its windshield's middle), or for `WALL` to the board's face straight back from it, under gravity and, for a
 * dummy or a prop, the air's drag (`AIR_LINEAR`): a throw that hits what it is aimed at, for tests that need a hit.
 */
export function throwAt(r: LabRig, thing: number, target: number, speed: number): LabShot {
  r.lab.centre(thing, _from);
  const slot = target === WALL ? -1 : r.lab.slotOf[target]!;
  if (target === WALL) _to.copy(_from).setZ(BOARD.z);
  else if (r.lab.dollOf[thing]! >= 0 && slot >= 0) r.cars[slot]!.glassWorld("windshield", _to);
  else r.lab.centre(target, _to);
  const flight = _from.distanceTo(_to) / speed;
  const drag = r.lab.dollOf[thing]! >= 0 || r.lab.propOf[thing]! >= 0 ? AIR_LINEAR : 0;
  const reach = drag > 0 ? (1 - Math.exp(-drag * flight)) / drag : flight;
  const fall = drag > 0 ? (G / drag) * (flight - reach) : 0.5 * G * flight * flight;
  _velocity.subVectors(_to, _from);
  _velocity.y += fall;
  return r.lab.launch(thing, _velocity.divideScalar(reach));
}

/** `throwAt` with no lift: item `thing` goes at `speed` m/s along the bench straight toward item `target`'s middle, level, so a car stays on its tyres and meets the target's side where it stands (a lob over 20 m at 10 m/s peaks 4.8 m up and lands on a roof). */
export function throwLevelAt(r: LabRig, thing: number, target: number, speed: number): LabShot {
  r.lab.centre(thing, _from);
  r.lab.centre(target, _to);
  _velocity.subVectors(_to, _from).setY(0).setLength(speed);
  return r.lab.launch(thing, _velocity);
}

const UP = new THREE.Vector3(0, 1, 0);
const _across = new THREE.Vector3();
const _chest = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _turn = new THREE.Quaternion();
const _still = new THREE.Vector3();

/**
 * `throwAt` for a dummy, turned flat to the throw first: chest first, his spine across it (his head on its left), so his torso is
 * what meets what he is thrown at (the glass rule's strike), from where he stands or from `startAt`. The flick itself never turns
 * anything; this is the fixture for the glass rule's tests.
 */
export function throwFlatDummyAt(r: LabRig, thing: number, target: number, speed: number, startAt: THREE.Vector3 | null = null): LabShot {
  const doll = r.lab.dollOf[thing]!;
  if (startAt) r.dolls!.place(startAt, _turn.identity(), _still.set(0, 0, 0), _still, Infinity, doll);
  const shot = throwAt(r, thing, target, speed);
  _chest.copy(shot.launch).normalize();
  _across.crossVectors(UP, _chest).normalize();
  _turn.setFromRotationMatrix(_basis.makeBasis(_from.crossVectors(_across, _chest), _across, _chest));
  r.dolls!.place(r.lab.centre(thing, _to), _turn, shot.launch, _still.set(0, 0, 0), Infinity, doll);
  return shot;
}

/** Put the flat ground back for the next suite. */
export function leaveLab(): void {
  setGround(null);
}
