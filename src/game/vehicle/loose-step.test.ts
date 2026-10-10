import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { CRASH } from "../deform/physics-util.ts";
import { GRAVITY } from "../kernel/constants.ts";
import { newWorld, stepWorld, type World } from "../engine/world-step.ts";
import { activeGround, Ground, setGround } from "../world/ground.ts";
import { armSolids, Surface } from "../world/surfaces.ts";
import { DeformableCar } from "./car.ts";
import type { DetachPart, LooseBody } from "./car-core.ts";
import { CAR_HALF } from "./car-mesh.ts";
import { crownY } from "./car-cage-rig.ts";
import { SKIN } from "./car-surfaces.ts";
import { RESTITUTION, invInertia } from "./car-air.ts";
import { newLooseShape, stepLoose } from "./loose-step.ts";
import { corner, LIES_FLAT, lowest, RESTS, thinAxisUp } from "./loose-step.test-util.ts";
import { assertSameDigest, paint } from "./test-support.ts";

const H = 1 / 120;

/** A flat road at height `raise`, under everything. */
class RaisedRoad extends Ground {
  constructor(raise: number) {
    super();
    this.addPlane(raise, -1e7, 1e7, -1e7, 1e7, Infinity);
  }
}

/** The farthest the box reaches along the unit direction `dir` from the origin (m). */
function farthest(part: LooseBody, dir: THREE.Vector3): number {
  let far = -Infinity;
  for (let k = 0; k < part.shape.count; k++) far = Math.max(far, corner(part, k).dot(dir));
  return far;
}

/** A loose slab (a bumper's size: 1.7 across, 0.3 high, 0.5 deep) with its middle at (0, `y`, 0) and velocity `v`. */
function slab(y: number, v: THREE.Vector3): LooseBody {
  const object = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.3, 0.5));
  object.position.set(0, y, 0);
  return { object, velocity: v.clone(), angular: new THREE.Vector3(), radius: 0.4, shape: newLooseShape() };
}

/** A torn part thrown along the road at the speed a racer drops it, stepped for `seconds` on ground raised by `raise` m. */
function slideRaised(raise: number, seconds: number): THREE.Vector3 {
  setGround(new RaisedRoad(raise));
  try {
    const p = slab(raise + 0.15, new THREE.Vector3(30, 0, 0));
    for (let t = 0; t < seconds; t += H) stepLoose(p, H, -1);
    return p.object.position.clone().sub(new THREE.Vector3(0, raise, 0));
  } finally {
    setGround(null);
  }
}

describe("given a torn part sliding along a road", () => {
  it("when the road is raised (a dam, a bridge, a crest), then the part slides, slows and stops exactly as it does on a road at ground level", () => {
    const low = slideRaised(0, 6);
    const high = slideRaised(18, 6);
    assert.ok(Math.abs(high.x - low.x) < 1e-6 && Math.abs(high.y - low.y) < 1e-6, `raised road: ${high.x.toFixed(2)} m along, level road: ${low.x.toFixed(2)} m`);
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
  const part = a["parts"].find((p) => p.name === "bumperF")!;
  a["detachPart"](part, 0, new THREE.Vector3());
  part.angular.set(0, 0, 0);
  return { w, cars, part };
}

/** The part with its object at (x, y, z), its axes the world's, moving at `vel`, then the world run `seconds` through the engine's step (`stepWorld`: the cars move its loose parts). */
function throwPart(l: Lot, x: number, y: number, z: number, vel: THREE.Vector3, seconds: number): void {
  l.part.object.position.set(x, y, z);
  l.part.object.quaternion.identity();
  l.part.angular.set(0, 0, 0);
  l.part.velocity.copy(vel);
  for (let t = 0; t < seconds; t += H) stepWorld(l.w, H);
}

/** Its plan speed (m/s). */
const planSpeed = (p: DetachPart): number => Math.hypot(p.velocity.x, p.velocity.z);

/** A part sliding at this speed (m/s) along the road. */
const SLIDE_V = 8;

/** Where the bumper slides: beside B's flank (and clear of A's), along +z from z = 0. */
const SLIDE_X = B_X - CAR_HALF.x - 0.3;

/** How far (m) a part sliding straight may drift sideways: a millimetre. */
const STRAIGHT = 1e-3;

/** The bumper let down on the road at `SLIDE_X` and left to lie, then sliding at `SLIDE_V`, run twice its stopping time; the part after it. */
function slide(withB: boolean): DetachPart {
  const l = lot(withB);
  throwPart(l, SLIDE_X, 0.3, 0, new THREE.Vector3(), 1);
  const o = l.part.object.position;
  throwPart(l, o.x, o.y, 0, new THREE.Vector3(0, 0, SLIDE_V), (2 * SLIDE_V) / (CRASH.muSlide * GRAVITY));
  return l.part;
}

/** That it stopped, straight along its line, in the Coulomb distance v²/(2 μ grip g) to within one step's travel (g: the sim's own gravity, the weight its friction presses with). */
function assertCoulombStop(part: DetachPart): void {
  const travelled = part.object.position.z;
  const grip = activeGround().frictionAt(SLIDE_X, travelled);
  const stop = SLIDE_V ** 2 / (2 * CRASH.muSlide * grip * GRAVITY);
  assert.equal(planSpeed(part), 0, "plan speed after twice its stopping time");
  assert.ok(Math.abs(travelled - stop) <= SLIDE_V * H, `slid ${travelled.toFixed(3)} m; Coulomb at μ ${CRASH.muSlide} × grip ${grip}: ${stop.toFixed(3)} m ± one step's ${(SLIDE_V * H).toFixed(3)} m`);
  assert.ok(Math.abs(part.object.position.x - SLIDE_X) < STRAIGHT, `it slides straight along its line (${part.object.position.x - SLIDE_X} m off)`);
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

/** The bumper dropped onto parked car B's roof, left `rest` s, then pushed off it sideways for `slide` s; its lowest point (m) on the roof and at the end. */
function roofDrop(l: Lot, at: number, rest: number, slide: number): { onRoof: number; restSpeed: number; end: THREE.Vector3; endLow: number; roofY: number } {
  const b = l.cars[1]!;
  const roofY = b.group.position.y + crownY(b);
  throwPart(l, at, roofY + DROP, b.group.position.z, new THREE.Vector3(), rest);
  const onRoof = lowest(l.part);
  const restSpeed = l.part.velocity.length();
  const o = l.part.object.position;
  throwPart(l, o.x, o.y, o.z, new THREE.Vector3(PUSH_V, 0, 0), slide);
  return { onRoof, restSpeed, end: l.part.object.position.clone(), endLow: lowest(l.part), roofY };
}

describe("given a front bumper torn off a parked car and dropped 0.5 m onto the roof of a second car parked beside it", () => {
  it("when it lands, then it rests on the roof; when pushed across it at 5 m/s, then it slides off the roof's edge and comes to rest on the road", () => {
    const l = lot(true);
    const { onRoof, restSpeed, end, endLow, roofY } = roofDrop(l, B_X, 1, 2);
    assert.ok(onRoof <= roofY + RESTS && onRoof >= roofY - SKIN, `lowest point ${onRoof.toFixed(3)} m up, roof crown ${roofY.toFixed(3)} m (a point ${SKIN} m under a top stands on it)`);
    assert.ok(restSpeed <= 2 * GRAVITY * H, `its speed resting on the roof: ${restSpeed.toFixed(4)} m/s, at most the jitter a step's gravity gives (${(2 * GRAVITY * H).toFixed(4)} m/s)`);
    assert.ok(end.x > B_X + CAR_HALF.x, `ended at x ${end.x.toFixed(2)}, B's flank at ${(B_X + CAR_HALF.x).toFixed(2)}`);
    assert.ok(endLow >= -RESTS && endLow <= RESTS, `ended with its lowest point ${endLow.toFixed(3)} m over the road`);
    assert.equal(planSpeed(l.part), 0, "plan speed on the road");
  });
});

/** A hood (the torn panel's own box: wide, long and thin) let go this high (m) over the road, tumbling. */
const HOOD_DROP = 1;
/** Within this long (s) it has settled. */
const SETTLES_S = 3;

/** The hood of a parked car, torn off, let go `HOOD_DROP` m up with a spin, run `SETTLES_S` s at steps of `dt`. */
function dropHood(dt: number): DetachPart {
  const l = lot(false);
  const hood = l.cars[0]!["parts"].find((p) => p.name === "hood")!;
  l.cars[0]!["detachPart"](hood, 0, new THREE.Vector3());
  hood.object.position.set(SLIDE_X, HOOD_DROP, 0);
  hood.velocity.set(0, 0, 0);
  hood.angular.set(2.5, 1.1, 3.1);
  for (let t = 0; t < SETTLES_S; t += dt) stepLoose(hood, dt, -1);
  return hood;
}

describe("given a torn hood let go a metre over the road, spinning", () => {
  it("when three seconds have passed, then its lowest point rests on the road (within a centimetre) and its thin axis is up", () => {
    const hood = dropHood(H);
    const up = thinAxisUp(hood);
    assert.ok(up > LIES_FLAT, `its thin axis is ${up.toFixed(3)} up`);
    const low = lowest(hood);
    assert.ok(low >= -1e-9 && low <= RESTS, `its lowest point is ${low.toFixed(4)} m over the road`);
  });

  it("when a slab slides at 8 m/s along the road at steps of 1/60 s and of 1/240 s, then the two slide as far as each other to within 5 %", () => {
    const far = (dt: number): number => {
      const part = slab(0.15, new THREE.Vector3(0, 0, SLIDE_V));
      for (let t = 0; t < (2 * SLIDE_V) / (CRASH.muSlide * GRAVITY); t += dt) stepLoose(part, dt, -1);
      return part.object.position.z;
    };
    const coarse = far(1 / 60);
    const fine = far(1 / 240);
    assert.ok(Math.abs(coarse - fine) <= 0.05 * fine, `${coarse.toFixed(3)} m at 1/60 s, ${fine.toFixed(3)} m at 1/240 s`);
  });
});

/** A wall (a thin box prism 0.3 m thick, 12 m wide, 2 m high) across the road with its near face at z = `WALL_Z`. */
const WALL_Z = 5;
const WALL_HALF_THICK = 0.15;
/** The slab starts at z 0 (its depth is 0.5 m) so it has to slide `WALL_GAP` m before its front meets the wall's face. */
const WALL_GAP = WALL_Z - 0.25;
/** The speed (m/s) it is meant to arrive with: the road's sliding friction takes `2 μ g gap` off the square of its launch speed. */
const ARRIVES_AT = 6;
const WALL_LAUNCH = Math.sqrt(ARRIVES_AT * ARRIVES_AT + 2 * CRASH.muSlide * GRAVITY * WALL_GAP);

/** A slab launched at the wall's face along the road, `wall` armed or not: how far its front reaches (m) in 4 s. */
function slideToWall(wall: boolean): number {
  const walls = new Surface();
  walls.addPrism({ x: 0, z: WALL_Z + WALL_HALF_THICK, yaw: 0, hx: 6, hz: WALL_HALF_THICK, base: 0, top: 2, id: 0 });
  armSolids(wall ? walls : null);
  try {
    const part = slab(0.15, new THREE.Vector3(0, 0, WALL_LAUNCH));
    for (let t = 0; t < 4; t += H) stepLoose(part, H, -1);
    return farthest(part, new THREE.Vector3(0, 0, 1));
  } finally {
    armSolids(null);
  }
}

describe("given a torn part sliding along the road into a wall", () => {
  it("when it meets the wall at 6 m/s (the same launch with no wall slides on past the wall's face), then it stops at the wall: its far end is no more than a centimetre inside the wall's face", () => {
    const free = slideToWall(false);
    assert.ok(free > WALL_Z + WALL_HALF_THICK * 2, `with no wall the slab's front reaches z ${free.toFixed(3)} m, past the wall's back face at ${WALL_Z + 2 * WALL_HALF_THICK} m: the launch reaches the wall`);
    const reach = slideToWall(true);
    assert.ok(reach <= WALL_Z + RESTS, `its far end reached z ${reach.toFixed(3)} m, the wall's face is at ${WALL_Z} m`);
    // It bounces off the face at `RESTITUTION` of its closing speed and slides back until the road's friction stops it (the road's grip, not 1, scales μ: twice the grip-1 distance is the bound).
    const rebound = (RESTITUTION * ARRIVES_AT) ** 2 / (2 * CRASH.muSlide * GRAVITY);
    assert.ok(reach > WALL_Z - 2 * rebound, `its far end stopped at z ${reach.toFixed(3)} m, further from the wall's face (${WALL_Z} m) than a rebound slides (${rebound.toFixed(3)} m)`);
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

/** A slab (`slab`) let settle on the road: three seconds at `H`. */
function settled(): LooseBody {
  const part = slab(0.15, new THREE.Vector3(0, 0, 0));
  for (let t = 0; t < 3; t += H) stepLoose(part, H, -1);
  return part;
}

describe("given a torn part at rest on the road", () => {
  it("when nothing is near, then it sleeps and a step leaves its pose as it was", () => {
    const part = settled();
    assert.ok(part.shape.asleep, "it fell asleep");
    const at = part.object.position.clone();
    const turn = part.object.quaternion.clone();
    // Asleep it is not asked what is under it: the road dropped 20 m away leaves it where it lay.
    setGround(new RaisedRoad(-20));
    try {
      for (let k = 0; k < 60; k++) stepLoose(part, H, -1);
    } finally {
      setGround(null);
    }
    assert.ok(part.object.position.equals(at) && part.object.quaternion.equals(turn), "pose unchanged over a second");
    assert.ok(part.shape.asleep, "still asleep");
  });

  it("when a hit gives it speed, then it wakes and leaves the road", () => {
    const part = settled();
    const y = part.object.position.y;
    part.velocity.set(0, 3, 0);
    stepLoose(part, H, -1);
    assert.ok(!part.shape.asleep && part.object.position.y > y + 0.01, `woke and rose ${(part.object.position.y - y).toFixed(3)} m`);
  });

  it("when a moving solid is far, then it sleeps on, and when the solid is moved onto it, then it wakes and is put out of it", () => {
    const solids = new Surface();
    const plate = solids.addPrism({ x: 30, z: 30, yaw: 0, hx: 1, hz: 1, base: 0, top: 2, id: 0, moves: true });
    armSolids(solids);
    try {
      const part = settled();
      const at = part.object.position.clone();
      solids.movePrism(plate, 10, 10, 0, 0, 0);
      stepLoose(part, H, -1);
      assert.ok(part.shape.asleep, "a solid 10 m away leaves it asleep");
      solids.movePrism(plate, at.x + 0.9, at.z, 0, 0, 0);
      stepLoose(part, H, -1);
      assert.ok(part.object.position.distanceTo(at) > 0.05, `moved ${part.object.position.distanceTo(at).toFixed(3)} m`);
    } finally {
      armSolids(null);
    }
  });
});

describe("given a body with unequal inertias turned to any orientation", () => {
  it("when a vector goes through its world-frame inverse inertia, then it is what the body-frame inertia gives it turned to the world and back (within 1e-9)", () => {
    const shape = newLooseShape();
    shape.invI.set(3.1, 0.7, 1.9);
    let seed = 12345;
    const next = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
    let worst = 0;
    for (let k = 0; k < 100; k++) {
      const q = new THREE.Quaternion(next(), next(), next(), next() + 1.5).normalize();
      const x = new THREE.Vector3(next(), next(), next());
      const turn = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
      const want = x.clone().applyMatrix3(turn.clone().transpose()).multiply(shape.invI).applyMatrix3(turn);
      worst = Math.max(worst, invInertia(x.clone(), q, q.clone().invert(), shape.invI).distanceTo(want));
    }
    assert.ok(worst < 1e-9, `worst miss ${worst} over 100 orientations`);
  });
});
