import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { launch, makeCar, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { armKill, DEFAULT_REALISM } from "../vehicle/vehicle-classes.ts";
import { THROW_ONSET } from "../match/phase.ts";
import { RANGE } from "../scenes/range.ts";
import { setGround } from "../world/ground.ts";
import { RagdollSystem } from "./engine-ragdoll.ts";
import { noPose, type Part, pose, type Pose, type Shot, worst } from "./ragdoll-pose.test-util.ts";

const FRAME = 1 / 60;
type Doll = { live: boolean; bodies: Part[] };

export const dollsOf = (sys: RagdollSystem): Doll[] => sys["dolls"];

/** A ragdoll system on open flat ground, no cars. */
export async function flatSystem(): Promise<RagdollSystem> {
  const sys = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  await sys.preload();
  setGround(null);
  sys.update(FRAME, [], true, false, 0, null);
  return sys;
}

/** Throw `shot` (slot 0) and return the worst `Pose` of the next `secs` sim seconds, one reading a frame. */
export function flatThrow(sys: RagdollSystem, shot: Shot, secs: number): Pose {
  sys.reset();
  sys["spawn"]({ car: 0, p: shot.p, q: shot.q, v: shot.v, w: shot.w, age: 0, cop: false, rides: true });
  const out = noPose();
  const d = dollsOf(sys)[0]!;
  for (let f = 0; f < Math.round(secs / FRAME); f++) {
    sys.update(FRAME, [], true, false, 0, null);
    worst(out, pose(d.bodies));
  }
  return out;
}

/** The ejection range: a sedan at the range's speed into its jersey barrier, the driver thrown; the worst `Pose` over `secs` sim seconds of him. */
export async function rangeWall(secs: number): Promise<Pose> {
  const car = makeCar("shape", 0.32, 0.45);
  armKill(car.deform, "sedan", DEFAULT_REALISM, "default");
  launch(car, -RANGE.run, 0, Math.PI / 2, RANGE.kph / 3.6, 0);
  const w = makeWorld([car], true, false);
  w.clock.slomoAt = THROW_ONSET;
  const sys = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  w.onEject = (e) => sys.launch(e, [car]);
  await sys.preload();
  sys.sand = true;
  const out = noPose();
  let out0 = -1;
  for (let wall = 0; wall < 30 && (out0 < 0 || wall - out0 < secs); wall += FRAME) {
    tickWorld(w, FRAME);
    sys.update(FRAME * w.clock.timeScale, [car], true, true, 0, new THREE.Group());
    const d = dollsOf(sys).find((x) => x.live);
    if (!d) continue;
    if (out0 < 0) out0 = wall;
    worst(out, pose(d.bodies));
  }
  sys.dispose();
  return out;
}

/** A sedan armed as the fleet arms it. */
function fleetCar() {
  const car = makeCar();
  car.deform.setMode("shape");
  car.deform.squash = 0.32;
  car.deform.buckle = 0.45;
  armKill(car.deform, "sedan", DEFAULT_REALISM, "default");
  return car;
}

/** A fleet head-on at 2 × `mps`: both drivers thrown; the worst `Pose` of each over `secs` sim seconds after the hit. */
export async function headOn(mps: number, secs: number): Promise<Pose[]> {
  const a = fleetCar();
  const b = fleetCar();
  launch(a, -5, 0, Math.PI / 2, mps, 0);
  launch(b, 5, 0, -Math.PI / 2, -mps, 0);
  const w = makeWorld([a, b], false, true);
  tickWorld(w);
  w.clock.slomoAt = THROW_ONSET;
  const sys = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  w.onEject = (e) => sys.launch(e, [a, b]);
  await sys.preload();
  const outs = [noPose(), noPose()];
  let first = -1;
  for (let wall = 0; wall < 30 && (first < 0 || wall - first < secs); wall += FRAME) {
    tickWorld(w, FRAME);
    sys.update(FRAME * w.clock.timeScale, [a, b], true, true, 0, null);
    for (const [s, d] of dollsOf(sys).entries()) {
      if (!d.live || s > 1) continue;
      if (first < 0) first = wall;
      worst(outs[s]!, pose(d.bodies));
    }
  }
  sys.dispose();
  return outs;
}
