import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { CRASH, FRICTION_G } from "../deform/physics-util.ts";
import { GRAVITY } from "../kernel/constants.ts";
import { bounceRigs, newWorld, stepWorld, type World } from "../engine/world-step.ts";
import { activeGround, Ground, setGround } from "../world/ground.ts";
import { DeformableCar } from "./car.ts";
import type { DetachPart, WorldBounce } from "./car-core.ts";
import { CAR_HALF } from "./car-mesh.ts";
import { roofHeight, SKIN } from "./car-surfaces.ts";
import { stepLoose } from "./loose-step.ts";
import { assertSameDigest, paint } from "./test-support.ts";

/** The engine's `bounceWorld` in a scene with no rigs up (no compactor plates, no jersey slab), as `CrashEngine` wires it into `World.bounce`. */
const sceneBounce: WorldBounce = (pos, vel, r) => bounceRigs(pos, vel, r, NaN, null);

const H = 1 / 120;

/** A flat road at height `raise`, under everything. */
class RaisedRoad extends Ground {
  constructor(raise: number) {
    super();
    this.addPlane(raise, -1e7, 1e7, -1e7, 1e7, Infinity);
  }
}

/** A torn part thrown along the road at the speed a racer drops it, stepped for `seconds` on ground raised by `raise` m. */
function slideRaised(raise: number, seconds: number): THREE.Vector3 {
  setGround(new RaisedRoad(raise));
  try {
    const p = { object: new THREE.Object3D(), velocity: new THREE.Vector3(30, 0, 0), angular: new THREE.Vector3(), radius: 0.4 };
    p.object.position.set(0, raise + 0.12, 0);
    for (let t = 0; t < seconds; t += H) stepLoose(p, H, 0.12, -1, sceneBounce);
    return p.object.position.clone().sub(new THREE.Vector3(0, raise, 0));
  } finally {
    setGround(null);
  }
}

describe("given a torn part sliding along a road", () => {
  it("when the road is raised (a dam, a bridge, a crest), then the part slides, slows and stops exactly as it does on a road at ground level", () => {
    const low = slideRaised(0, 6);
    const high = slideRaised(18, 6);
    assert.ok(Math.abs(high.x - low.x) < 1e-9 && Math.abs(high.y - low.y) < 1e-9, `raised road: ${high.x.toFixed(2)} m along, level road: ${low.x.toFixed(2)} m`);
  });
});

/** Car B's plan x: parked beside car A (at the origin), a body width and a metre between their flanks. */
const B_X = 2 * CAR_HALF.x + 1;

type Lot = { w: World; cars: DeformableCar[]; part: DetachPart };

/** Car A parked at the origin and, with `withB`, car B parked at `B_X` beside it, both facing +z; A's front bumper torn off (at rest). */
function lot(withB: boolean): Lot {
  const scene = new THREE.Scene();
  const a = new DeformableCar(paint(), scene);
  a.spawnFacing(0, 0, 0, 0);
  const cars = [a];
  if (withB) {
    const b = new DeformableCar(paint(), scene);
    b.spawnFacing(B_X, 0, 0, 0);
    cars.push(b);
  }
  const w = newWorld(cars);
  w.bounce = sceneBounce;
  const part = a["parts"].find((p) => p.name === "bumperF")!;
  a["detachPart"](part, 0, new THREE.Vector3());
  part.angular.set(0, 0, 0);
  return { w, cars, part };
}

/** The part at (x, y, z) moving at `vel`, then the world run `seconds` through the engine's step (`stepWorld`: the cars move its loose parts). */
function throwPart(l: Lot, x: number, y: number, z: number, vel: THREE.Vector3, seconds: number): void {
  l.part.object.position.set(x, y, z);
  l.part.velocity.copy(vel);
  for (let t = 0; t < seconds; t += H) stepWorld(l.w, H);
}

/** Its plan speed (m/s). */
const planSpeed = (p: DetachPart): number => Math.hypot(p.velocity.x, p.velocity.z);

/** A part sliding at this speed (m/s) along the road. */
const SLIDE_V = 8;

/** Where the bumper slides: beside B's flank (and clear of A's), along +z from z = 0. */
const SLIDE_X = B_X - CAR_HALF.x - 0.3;

/** The bumper put on the road at `SLIDE_X` sliding at `SLIDE_V`, run twice its stopping time; the part after it. */
function slide(withB: boolean): DetachPart {
  const l = lot(withB);
  throwPart(l, SLIDE_X, activeGround().heightAt(SLIDE_X, 0), 0, new THREE.Vector3(0, 0, SLIDE_V), (2 * SLIDE_V) / (CRASH.muSlide * FRICTION_G));
  return l.part;
}

/** That it stopped, straight along its line, in the Coulomb distance v²/(2 μ grip g) to within one step's travel. */
function assertCoulombStop(part: DetachPart): void {
  const travelled = part.object.position.z;
  const grip = activeGround().frictionAt(SLIDE_X, travelled);
  const stop = SLIDE_V ** 2 / (2 * CRASH.muSlide * grip * FRICTION_G);
  assert.equal(planSpeed(part), 0, "plan speed after twice its stopping time");
  assert.ok(Math.abs(travelled - stop) <= SLIDE_V * H, `slid ${travelled.toFixed(3)} m; Coulomb at μ ${CRASH.muSlide} × grip ${grip}: ${stop.toFixed(3)} m ± one step's ${(SLIDE_V * H).toFixed(3)} m`);
  assert.equal(part.object.position.x, SLIDE_X, "it slides straight along its line");
}

describe("given a front bumper torn off a parked car, sliding along the road at 8 m/s", () => {
  it("when it slides on open road, then it stops in the distance its slide friction gives at its speed", () => {
    assertCoulombStop(slide(false));
  });

  it("when it slides past the flank of a second car parked beside it, then it stops in the distance its slide friction gives at its speed, the same as on open road", () => {
    const beside = slide(true);
    assertCoulombStop(beside);
    assert.equal(beside.object.position.z, slide(false).object.position.z, "distance beside the parked car vs on open road");
  });
});

/** The part dropped this high (m) over car B's roof crown. */
const DROP = 0.5;
/** Pushed across the roof at this speed (m/s): its slide friction stops it after v²/(2 μ g) ≈ 1.7 m, past the roof's edge. */
const PUSH_V = 5;

/** The bumper dropped onto parked car B's roof, left `rest` s, then pushed off it sideways for `slide` s; its height (m) on the roof and at the end. */
function roofDrop(l: Lot, at: number, rest: number, slide: number): { onRoof: number; restSpeed: number; end: THREE.Vector3; roofY: number } {
  const b = l.cars[1]!;
  const roofY = b.group.position.y + roofHeight(b);
  throwPart(l, at, roofY + DROP, b.group.position.z, new THREE.Vector3(), rest);
  const onRoof = l.part.object.position.y;
  const restSpeed = Math.abs(l.part.velocity.y);
  throwPart(l, l.part.object.position.x, onRoof, l.part.object.position.z, new THREE.Vector3(PUSH_V, 0, 0), slide);
  return { onRoof, restSpeed, end: l.part.object.position.clone(), roofY };
}

describe("given a front bumper torn off a parked car and dropped 0.5 m onto the roof of a second car parked beside it", () => {
  it("when it lands, then it rests on the roof; when pushed across it at 5 m/s, then it slides off the roof's edge and comes to rest on the road", () => {
    const l = lot(true);
    const { onRoof, restSpeed, end, roofY } = roofDrop(l, B_X, 1, 2);
    const road = activeGround().heightAt(end.x, end.z);
    // Its rest over the road: the same rest it takes over the roof.
    const over = end.y - road;
    assert.ok(onRoof - over <= roofY + 1e-9 && onRoof - over >= roofY - SKIN, `resting ${(onRoof - over).toFixed(3)} m up, roof crown ${roofY.toFixed(3)} m (a point ${SKIN} m under a top stands on it)`);
    assert.ok(restSpeed <= GRAVITY * H, `its fall speed resting on the roof: ${restSpeed.toFixed(4)} m/s, at most one step's gravity (${(GRAVITY * H).toFixed(4)} m/s)`);
    assert.ok(end.x > B_X + CAR_HALF.x, `ended at x ${end.x.toFixed(2)}, B's flank at ${(B_X + CAR_HALF.x).toFixed(2)}`);
    assert.ok(over > 0 && over < roofY - SKIN, `ended ${over.toFixed(3)} m over the road`);
    assert.equal(planSpeed(l.part), 0, "plan speed on the road");
  });
});

/** Every car's whole sim state: pose, velocities, each mass, its faces' load crush, the drivetrain. */
function simState(cars: readonly DeformableCar[]): number[] {
  return cars.flatMap((c) => [
    ...c.group.position.toArray(),
    ...c.group.quaternion.toArray(),
    ...c.velocity.toArray(),
    ...c.angular.toArray(),
    ...c.deform.masses.flatMap((m) => [...m.world.toArray(), ...m.vel.toArray()]),
    ...c.deform.crush,
    c.deform.drivetrainAlive ? 1 : 0,
    c.deform.engineTravel,
  ]);
}

describe("given two cars parked side by side and a bumper torn off one (loose parts are cosmetic)", () => {
  it("when the bumper lands on the other car's roof and is pushed off it, then both cars' sim state is bit for bit what it is with the bumper lying on open road", () => {
    const onCar = lot(true);
    const away = lot(true);
    const { onRoof, roofY } = roofDrop(onCar, B_X, 1, 2);
    roofDrop(away, 40, 1, 2);
    assert.ok(onRoof > roofY - SKIN, `the bumper rested on the roof (${onRoof.toFixed(3)} m up, crown ${roofY.toFixed(3)} m)`);
    assertSameDigest(simState(onCar.cars), simState(away.cars), "every car's sim state with the bumper on the roof vs on open road");
  });
});
