import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { armKill, assignClass, HANDLING, killClass } from "../vehicle/vehicle-classes.ts";
import { paint } from "../vehicle/test-support.ts";
import { makeWorld, tickWorld, type CrashWorld } from "../contact/crash-scenarios.test-util.ts";
import { setGround } from "../world/ground.ts";
import type { LabLayout, LabPresetId } from "../scenes/lab.ts";
import { Lab } from "./engine-lab.ts";

/** Headless Lab: a layout's cars built and placed, the Lab's ground made active, its hooks on the engine's step (`tickWorld`). */
export type LabRig = { lab: Lab; cars: DeformableCar[]; w: CrashWorld };

const FRAME = 1 / 60;

export function labRig(layout: LabLayout | LabPresetId): LabRig {
  const lab = new Lab();
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
  return { lab, cars, w };
}

/** `seconds` of sim at 60 frames a second (`tickWorld`: the engine's frame); the Lab reads the world before every slice. */
export function runLab(r: LabRig, seconds: number): void {
  for (let t = 0; t < seconds - 1e-9; t += FRAME) tickWorld(r.w, FRAME);
}

/** Put the flat ground back for the next suite. */
export function leaveLab(): void {
  setGround(null);
}
