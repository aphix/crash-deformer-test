import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { launch, makeCar, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { armKill, assignClass, DEFAULT_REALISM } from "../vehicle/vehicle-classes.ts";
import { beginImpact, holdForThrow, impactScale, phaseClock, stepPhase, THROW_ONSET } from "../match/phase.ts";
import { throwComing } from "./ragdoll-trigger.ts";
import { RagdollSystem } from "./engine-ragdoll.ts";
import { FLAT_GROUND } from "../world/ground.ts";
import { occluder, solid, type Sight } from "./spectate-cam.ts";
import { CAR_HALF } from "../vehicle/car-mesh.ts";

const FRAME = 1 / 60;
/** The sandbox's open flat ground: nothing to stand in or look through. */
const OPEN: () => Sight = () => ({ ground: FLAT_GROUND, path: null, wallTop: 0, rim: Infinity, occ: [] });
const TORSO = [0.18, 0.27, 0.11];

/** A sedan armed as the fleet arms it; `police`: the police style and class. */
function fleetCar(police = false): DeformableCar {
  const car = police ? new DeformableCar({ body: 0x111111, accent: 0xffffff, name: "cop" }, new THREE.Scene(), null, "police") : makeCar();
  if (police) assignClass(car, "police");
  car.deform.setMode("shape");
  car.deform.squash = 0.32;
  car.deform.buckle = 0.45;
  armKill(car.deform, police ? "police" : "sedan", DEFAULT_REALISM, "default");
  return car;
}

function headOn(mps: number, police = false): [DeformableCar, DeformableCar] {
  const a = fleetCar(police);
  const b = fleetCar();
  launch(a, -5, 0, Math.PI / 2, mps, 0);
  launch(b, 5, 0, -Math.PI / 2, -mps, 0);
  return [a, b];
}

const _l = new THREE.Vector3();
const _f = new THREE.Vector3();
const _q = new THREE.Quaternion();
/** Car-local z of mass `name`. */
function endZ(car: DeformableCar, name: string): number {
  _f.set(0, 0, 1).applyQuaternion(car.group.quaternion);
  return _l.copy(car.deform.massWorld(name)).sub(car.group.position).dot(_f);
}
/**
 * Which solid part of `car`'s body holds world point `p` ("" for none): the bonnet or boot block and the door walls
 * below the beltline (the crushed ends from the bumper masses), the roof slab. The cabin and its openings are not solid.
 */
function solidAt(car: DeformableCar, p: THREE.Vector3): string {
  const nose = Math.max(endZ(car, "bumperFL"), endZ(car, "bumperFR")) + 0.05;
  const tail = Math.min(endZ(car, "bumperRL"), endZ(car, "bumperRR")) - 0.05;
  _l.copy(p).sub(car.group.position).applyQuaternion(_q.copy(car.group.quaternion).invert());
  const ax = Math.abs(_l.x);
  if (_l.y > 0.14 && _l.y < 0.83 && _l.z < nose && _l.z > tail) {
    if (ax < 0.8 && _l.z > 0.66) return "bonnet";
    if (ax < 0.8 && _l.z < -0.86) return "boot";
    if (ax >= 0.8 && ax < 0.91) return "door";
  }
  if (ax < 0.85 && _l.y > 1.25 && _l.y < 1.33 && _l.z > -0.86 && _l.z < 0.49) return "roof";
  return "";
}

type Dolls = { live: boolean; bodies: { translation(): THREE.Vector3Like; rotation(): THREE.QuaternionLike }[] }[];

describe("a throw's slow-mo waits until the driver is out of the car", () => {
  it("bad: a fleet head-on at 2×72 km/h plays the exit at 1× for THROW_ONSET, and in slow-mo no torso corner is ever inside a car's body", async () => {
    const cars = headOn(20);
    const w = makeWorld(cars, false, true);
    tickWorld(w);
    // The engine's pre-hit check (`maybePreSlowmo` → `throwComing`): this hit will throw, so the slow-mo is held.
    assert.ok(throwComing(cars, null), "the coming hit is judged a throw");
    w.clock.slomoAt = THROW_ONSET;
    const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
    await ragdolls.preload();
    const dolls: Dolls = ragdolls["dolls"];
    let wall = 0;
    let hitAt = -1;
    let slowAt = -1;
    let thrown = 0;
    const inside: string[] = [];
    const c = new THREE.Vector3();
    for (let f = 0; f < 480; f++) {
      // `tickWorld`'s own ease, so the dummies step the sim time the cars do.
      const ts = w.clock.timeScale + (w.clock.targetScale - w.clock.timeScale) * Math.min(1, FRAME * (w.clock.phase === "aftermath" ? 1.15 : 3.2));
      const approach = w.clock.phase === "approach";
      tickWorld(w);
      ragdolls.update(FRAME * ts, cars, true, true, 0, null);
      wall += FRAME;
      if (approach && w.clock.phase !== "approach") hitAt = wall;
      if (hitAt >= 0 && slowAt < 0 && ts < 0.5) slowAt = wall;
      for (const d of dolls) {
        if (!d.live) continue;
        thrown = Math.max(thrown, dolls.filter((x) => x.live).length);
        if (ts >= 0.5) continue;
        const t = d.bodies[0]!.translation();
        const r = d.bodies[0]!.rotation();
        for (let n = 0; n < 8; n++) {
          c.set(n & 1 ? TORSO[0]! : -TORSO[0]!, n & 2 ? TORSO[1]! : -TORSO[1]!, n & 4 ? TORSO[2]! : -TORSO[2]!).applyQuaternion(_q.set(r.x, r.y, r.z, r.w)).add(_l.set(t.x, t.y, t.z));
          const p = c.clone();
          for (const car of cars) {
            const s = solidAt(car, p);
            if (s) inside.push(`${(wall - hitAt).toFixed(3)} s in car ${cars.indexOf(car)}'s ${s}`);
          }
        }
      }
    }
    ragdolls.dispose();
    assert.equal(thrown, 2, "both drivers thrown");
    assert.ok(Math.abs(slowAt - hitAt - THROW_ONSET) < 0.03, `slow-mo ${((slowAt - hitAt) * 1000).toFixed(0)} ms after the hit`);
    // On main (slow-mo from the hit, the torso at the bonnet line) 361 slow-mo frames had a corner in a bonnet.
    assert.deepEqual(inside.slice(0, 4), [], "torso corners inside a car body in slow-mo");
  });

  it("bad: a driver thrown while the slow-mo already runs gets THROW_ONSET at 1× before it comes back", () => {
    const c = phaseClock();
    beginImpact(c, true);
    for (let t = 0; t < 0.5; t += FRAME) stepPhase(c, FRAME);
    holdForThrow(c);
    const at: number[] = [];
    for (let t = 0; t < 0.4; t += FRAME) {
      at.push(c.timeScale);
      stepPhase(c, FRAME);
    }
    assert.ok(at.slice(0, 14).every((s) => s === 1), `1× for the exit: ${at.slice(0, 16).join()}`);
    assert.equal(c.timeScale, impactScale(c), "the slow-mo is back");
    assert.equal(c.phase, "slowmo");
  });
});

describe("a thrown dummy meets the other cars' crushed bodies from the first frame", () => {
  it("bad: a dummy thrown low across another car's nose bounces off it, never inside its lower box, with no jump as the grace ends", async () => {
    const a = fleetCar();
    const b = fleetCar();
    a.spawnFacing(0, 0, 0, 0);
    b.spawnFacing(0, 6.5, Math.PI, 0);
    const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
    await ragdolls.preload();
    ragdolls.update(FRAME, [a, b], true, true, 0, null);
    // Out of car a just past its nose, lying flat at bonnet height, at 15 m/s into car b's nose 1.5 m on.
    ragdolls["spawn"]({ car: 0, p: new THREE.Vector3(0, 0.55, 2.9), q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2), v: new THREE.Vector3(0, 0, 15), w: new THREE.Vector3(), age: 0, cop: false });
    const dolls: Dolls = ragdolls["dolls"];
    const inside: string[] = [];
    let jump = 0;
    let maxZ = -Infinity;
    const prev = new THREE.Vector3(0, 0.55, 2.9);
    for (let f = 0; f < 60; f++) {
      ragdolls.update(FRAME, [a, b], true, true, 0, null);
      const t = dolls[0]!.bodies[0]!.translation();
      _l.set(t.x, t.y, t.z);
      const local = _l.clone().sub(b.group.position).applyQuaternion(_q.copy(b.group.quaternion).invert());
      if (Math.abs(local.x) < 0.86 && local.y > 0.05 && local.y < 0.85 && Math.abs(local.z) < 2.15) inside.push(`frame ${f} at ${local.toArray().map((v) => v.toFixed(2))}`);
      // The grace window ends 0.35 s in (frame 20–21): anything still inside a box would be shoved out here.
      if (f >= 18 && f <= 24) jump = Math.max(jump, _l.distanceTo(prev));
      maxZ = Math.max(maxZ, t.z);
      prev.copy(_l);
    }
    ragdolls.dispose();
    assert.deepEqual(inside, [], "torso inside the other car's lower box");
    assert.ok(maxZ < 6.5 - 2.15 + 0.2, `bounced off the nose: got as far as z ${maxZ.toFixed(2)}`);
    assert.ok(jump < 0.3, `moved ${jump.toFixed(2)} m in one frame as the grace ended`);
  });
});

describe("the ride-along frames one dummy and those near it, never the whole field", () => {
  /** Upright dummies dropped at (x, 1.2, z), sliding along +z at `vz`, then `frames` of riding. */
  async function ride(at: [number, number][], vz: number, frames: number, each: (camera: THREE.PerspectiveCamera, ragdolls: RagdollSystem) => void): Promise<void> {
    const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
    await ragdolls.preload();
    ragdolls.update(FRAME, [], true, true, 0, null);
    at.forEach(([x, z], car) => ragdolls["spawn"]({ car, p: new THREE.Vector3(x, 1.2, z), q: new THREE.Quaternion(), v: new THREE.Vector3(0, 0, vz), w: new THREE.Vector3(), age: 0, cop: false }));
    ragdolls.follow();
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 180);
    for (let f = 0; f < frames; f++) {
      ragdolls.update(FRAME, [], true, true, 0, null);
      if (ragdolls.frameCamera(camera, FRAME, false, -1, false, 50, OPEN) === "none") break;
      camera.updateMatrixWorld();
      each(camera, ragdolls);
    }
    ragdolls.dispose();
  }

  it("bad: three dummies 40 m apart: the camera stays within the near-frame distance of its target", async () => {
    let far = 0;
    await ride([[-40, 0], [0, 0], [40, 0]], 6, 240, (camera, ragdolls) => {
      // Between shots the camera is flying to the next one; the framing is judged where it has arrived.
      if (ragdolls["cam"]["blend"] >= 1) far = Math.max(far, camera.position.distanceTo(ragdolls.rideLook));
    });
    // `CAM_NEAR` 6 m: (4.5 + 1.6·6) back, (1.8 + 0.5·6) aside, (1.3 + 0.4·6) up is 15.4 m. On main: about 63 m.
    assert.ok(far > 4 && far < 15.5, `camera ${far.toFixed(1)} m from its target`);
  });

  it("good: two dummies 3 m apart are both in frame", async () => {
    const out: string[] = [];
    let frames = 0;
    await ride([[0, 0], [3, 0]], 4, 60, (camera, ragdolls) => {
      frames++;
      const dolls: Dolls = ragdolls["dolls"];
      for (const [s, d] of dolls.entries()) {
        if (!d.live) continue;
        const h = d.bodies[1]!.translation();
        const ndc = new THREE.Vector3(h.x, h.y, h.z).project(camera);
        if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1 || ndc.z > 1) out.push(`dummy ${s} at ${ndc.toArray().map((v) => v.toFixed(2))}`);
      }
    });
    assert.ok(frames > 30, `rode ${frames} frames`);
    assert.deepEqual(out.slice(0, 4), [], "a head out of frame");
  });
});

describe("a police driver is thrown in uniform", () => {
  it("good: a police car's head-on throws its driver in the navy shirt, the other car's in the civilian tee", async () => {
    const cars = headOn(20, true);
    const scene = new THREE.Scene();
    const ragdolls = new RagdollSystem(scene, () => {}, () => {});
    await ragdolls.preload();
    const w = makeWorld(cars, false, false);
    for (let f = 0; f < 60; f++) {
      tickWorld(w);
      ragdolls.update(FRAME, cars, true, true, 0, null);
    }
    const mesh = scene.getObjectByName("ragdolls") as THREE.InstancedMesh;
    // Slots fill in car order; each slot's first piece is the chest.
    const per = mesh.count / 2;
    const chest = (s: number) => `#${mesh.getColorAt(s * per, new THREE.Color()).getHexString()}`;
    const shirts = [chest(0), chest(1)];
    ragdolls.dispose();
    assert.deepEqual(shirts, ["#1b2a4a", "#2b2d32"]);
  });
});

/** The two cars as the engine's `spectateSight` sees them: upright cylinders the cinematic eye may not stand in. */
function carSight(cars: readonly DeformableCar[]): () => Sight {
  return () => ({
    ground: FLAT_GROUND,
    path: null,
    wallTop: 0,
    rim: Infinity,
    occ: cars.map((c) => occluder(c.group.position.x, c.group.position.z, 0, CAR_HALF.z, CAR_HALF.z, true, c.group.position.y - 0.3, c.group.position.y + 1.6)),
  });
}

describe("the ride opens on the windshield, then follows the dummy without a jump", () => {
  it("good: a head-on's first ride frame stands ahead of the thrown car on its forward axis, up and clear of both cars, looking back at it", async () => {
    const cars = headOn(26);
    const threw: number[] = [];
    const ragdolls: RagdollSystem = new RagdollSystem(new THREE.Scene(), (i) => { threw.push(i); ragdolls.follow(); }, () => {});
    await ragdolls.preload();
    const w = makeWorld(cars, false, false);
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 180);
    const sight = carSight(cars);
    for (let f = 0; f < 120 && !ragdolls.rideAlong; f++) {
      tickWorld(w);
      ragdolls.update(FRAME, cars, true, true, 0, null);
    }
    assert.ok(ragdolls.rideAlong, "a driver was thrown");
    const car = cars[threw[0]!]!;
    const fwd = car.fwdFlat.clone();
    const carPos = car.group.position.clone();
    assert.equal(ragdolls.frameCamera(camera, FRAME, false, -1, false, 50, sight), "shot");
    const rel = camera.position.clone().sub(carPos);
    const dir = camera.getWorldDirection(new THREE.Vector3());
    ragdolls.dispose();
    assert.ok(rel.dot(fwd) > 4 && rel.dot(fwd) <= 18.001, `${rel.dot(fwd).toFixed(2)} m ahead of the car`);
    assert.ok(Math.abs(rel.x * fwd.z - rel.z * fwd.x) < 1e-6, "on the forward axis");
    assert.ok(rel.y >= 3, `${rel.y.toFixed(2)} m up`);
    assert.equal(solid(sight(), camera.position.x, camera.position.y, camera.position.z, 0.5), false, "the eye stands clear of the cars");
    assert.ok(dir.dot(fwd) < -0.3, `looking back at the car: ${dir.dot(fwd).toFixed(2)}`);
  });

  it("bad: a dummy flying under the eye never whips the aim past MAX_TURN, and no shot change moves the camera more than a frame", async () => {
    const cars = headOn(26);
    const ragdolls: RagdollSystem = new RagdollSystem(new THREE.Scene(), () => ragdolls.follow(), () => {});
    await ragdolls.preload();
    const w = makeWorld(cars, false, false);
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 180);
    const sight = carSight(cars);
    const dir = new THREE.Vector3();
    const prevDir = new THREE.Vector3();
    const prevPos = new THREE.Vector3();
    let shot = "";
    let riding = 0;
    let maxTurn = 0;
    const jumps: string[] = [];
    const shots = new Set<string>();
    for (let f = 0; f < 900 && riding < 480; f++) {
      tickWorld(w);
      ragdolls.update(FRAME, cars, true, true, 0, null);
      if (!ragdolls.rideAlong) continue;
      if (ragdolls.frameCamera(camera, FRAME, false, -1, false, 50, sight) === "none") break;
      camera.getWorldDirection(dir);
      const now = ragdolls["cam"].shot;
      shots.add(now);
      if (riding > 0) {
        const turn = dir.angleTo(prevDir);
        maxTurn = Math.max(maxTurn, turn);
        if (now !== shot && camera.position.distanceTo(prevPos) > 0.1) jumps.push(`${shot}->${now} moved ${camera.position.distanceTo(prevPos).toFixed(2)} m`);
      }
      shot = now;
      prevPos.copy(camera.position);
      prevDir.copy(dir);
      riding++;
    }
    ragdolls.dispose();
    assert.ok(riding > 300, `rode ${riding} frames`);
    assert.deepEqual([...shots].slice(0, 2), ["glass", "follow"], "opens on the windshield, then follows");
    assert.deepEqual(jumps, []);
    assert.ok(maxTurn < 4 * FRAME * 1.1, `turned ${maxTurn.toFixed(3)} rad in one frame`);
  });
});

describe("the user's drag holds the ride-along, which then resumes from his view", () => {
  it("good: held, the cut to the next dummy waits and the camera is untouched; released, the first frame eases from his view and the cut lands", async () => {
    const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
    await ragdolls.preload();
    ragdolls.update(FRAME, [], true, true, 0, null);
    [[0, 0], [20, 0]].forEach(([x, z], car) => ragdolls["spawn"]({ car, p: new THREE.Vector3(x, 1.2, z), q: new THREE.Quaternion(), v: new THREE.Vector3(0, 0, 4), w: new THREE.Vector3(), age: 0, cop: false }));
    ragdolls.follow();
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 180);
    let held = false;
    let first = -1;
    // Once `first` lies still, with nobody holding the camera the ride would cut to the other one.
    const frame = (): string => {
      ragdolls.update(FRAME, [], true, true, 0, null);
      if (first >= 0) ragdolls["dolls"][first]!.still = 9;
      return ragdolls.frameCamera(camera, FRAME, false, -1, held, 50, OPEN);
    };
    for (let f = 0; f < 90; f++) frame();
    first = ragdolls["primary"];
    held = true;
    const userPos = camera.position.clone().add(new THREE.Vector3(3, 2, 3));
    const userQuat = camera.quaternion.clone();
    camera.position.copy(userPos);
    for (let f = 0; f < 120; f++) assert.equal(frame(), "held");
    assert.equal(ragdolls["primary"], first, "no cut while held");
    assert.ok(camera.position.equals(userPos) && camera.quaternion.equals(userQuat), "the ride leaves the user's camera alone");
    held = false;
    assert.equal(frame(), "shot");
    assert.notEqual(ragdolls["primary"], first, "the cut lands once released");
    assert.ok(camera.position.distanceTo(userPos) < 0.5, `moved ${camera.position.distanceTo(userPos).toFixed(2)} m on the first frame`);
    assert.ok(camera.quaternion.angleTo(userQuat) < 0.1, "turned only a little on the first frame");
    for (let f = 0; f < 150; f++) frame();
    assert.ok(camera.position.distanceTo(ragdolls.rideLook) < 15.5, "settled on the new dummy");
    ragdolls.dispose();
  });
});
