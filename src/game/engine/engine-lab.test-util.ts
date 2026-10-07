import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { armKill, assignClass, HANDLING, killClass } from "../vehicle/vehicle-classes.ts";
import { paint } from "../vehicle/test-support.ts";
import { makeWorld, tickWorld, type CrashWorld } from "../contact/crash-scenarios.test-util.ts";
import { setGround } from "../world/ground.ts";
import { RagdollSystem } from "../present/engine-ragdoll.ts";
import type { LabLayout, LabPresetId } from "../scenes/lab.ts";
import { Lab } from "./engine-lab.ts";

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

/** Put the flat ground back for the next suite. */
export function leaveLab(): void {
  setGround(null);
}
