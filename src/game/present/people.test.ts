import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { launch, makeCar } from "../contact/crash-scenarios.test-util.ts";
import type { FigureStrike } from "../scenes/figure-strike.ts";
import { GUARD_DOWN, LawnGuard, SHOT_RING } from "../scenes/lawn-guard.ts";
import { parseTrack } from "../world/track-schema.ts";
import { Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { TRACK_ID } from "../world/constants.ts";
import { setGround } from "../world/ground.ts";
import type { DriverLook } from "./driver-look.ts";
import { GroundsArt } from "./grounds-art.ts";
import { GuardSquad, People, VipEscort, nukeFlash } from "./people.ts";
import { drawnTriangles } from "../vehicle/drawn-body.test-util.ts";
import { DummyMesh } from "./ragdoll-mesh.ts";
import { FRAME_HZ } from "../kernel/constants.ts";

/** Once the Konami code is in, a man in a suit walks out of the White House to the car, rides with the player and is thrown out with the driver when it crashes. */
const json = TRACKS.find((j) => parseTrack(j).id === TRACK_ID.nationalMall)!;
const track = new Track(json);
const spec = track.json.guards!;
const ground = track.ground();
setGround(ground);
const FRAME = 1 / FRAME_HZ;
/** The North Lawn, 40 m in front of the North Portico. */
const NORTH_LAWN = { x: -990, z: -1104 };
/** A spot out on the Ellipse's road past the south fence, off the grounds. */
const OFF_GROUNDS = { x: -1000, z: -760 };

/** The VIP's escort over a car parked on the lawn: `seconds` of frames, the secret out or not; the throws it asked for. */
function escort(secretOut: boolean, seconds: number) {
  const vip = new VipEscort(spec, ground, new People(1), 0);
  const car = makeCar();
  launch(car, NORTH_LAWN.x, NORTH_LAWN.z, 0, 0, 0);
  const cars = [car];
  const throws: { car: number; look: DriverLook }[] = [];
  const throwPassenger = (i: number, look: DriverLook): void => void throws.push({ car: i, look });
  const figures: FigureStrike[] = [];
  const throwFigure = (strike: FigureStrike): void => void figures.push({ ...strike });
  let boardedAt = -1;
  for (let t = 0; t < seconds; t += FRAME) {
    vip.frame(FRAME, secretOut, 0, cars, throwPassenger, throwFigure);
    if (boardedAt < 0 && vip.ridingIn === 0) boardedAt = t;
  }
  return { vip, car, cars, throws, throwPassenger, throwFigure, figures, boardedAt };
}

describe("given the National Mall's VIP and the player's car parked on the White House's North Lawn", () => {
  it("when the course's secret is out, then he walks out of the house to the passenger door and gets in, and when the driver is thrown out he is thrown with him, once: a portly blond man in a blue suit", () => {
    const { vip, car, cars, throws, throwPassenger, throwFigure, boardedAt } = escort(true, 40);
    assert.ok(boardedAt > 5 && boardedAt < 35, `boarded ${boardedAt.toFixed(1)} s after the car stopped (a walk of some 40 m)`);
    assert.equal(throws.length, 0, "nobody thrown while the car is whole");
    car.driverOut = "windshield";
    vip.frame(FRAME, true, 0, cars, throwPassenger, throwFigure);
    vip.frame(FRAME, true, 0, cars, throwPassenger, throwFigure);
    assert.equal(throws.length, 1, "thrown once with the driver");
    assert.equal(throws[0]!.car, 0, "out of the player's car");
    assert.equal(throws[0]!.look.woman, false, "a man");
    assert.ok(((throws[0]!.look.hair >> 16) & 0xff) > 0xc0 && ((throws[0]!.look.hair >> 8) & 0xff) > 0xa0, "blond");
    const suit = throws[0]!.look.shirt;
    assert.ok(suit === throws[0]!.look.pants && (suit & 0xff) > ((suit >> 8) & 0xff) && (suit & 0xff) > (suit >> 16) && (suit & 0xff) < 0x90, "a navy-blue suit, jacket and trousers alike");
    assert.equal(throws[0]!.look.portly, true, "portly");
    assert.equal(vip.ridingIn, -1, "no longer riding");
  });

  it("when the secret is still in, then he never comes out, though the same car would draw him once it is", () => {
    assert.equal(escort(false, 40).boardedAt, -1, "never boards");
    assert.ok(escort(true, 40).boardedAt > 0, "with the secret out he boards");
  });

  const strikeCases = [
    { it: "when a car at 15 m/s is on him as he walks, then he is thrown once where he stood by the car, and is drawn no more", mps: 15, expectedFigures: 1 },
    { it: "when a car at 2 m/s is on him as he walks, then he is left standing", mps: 2, expectedFigures: 0 },
  ] as const;
  for (const testCase of strikeCases) {
    it(testCase.it, () => {
      const { vip, cars, throwPassenger, throwFigure, figures } = escort(true, 3);
      const where = { x: vip["x"], z: vip["z"] };
      assert.equal(vip["phase"], "walking", "he is out on his walk");
      const bullet = makeCar();
      launch(bullet, where.x, where.z, 0, 0, testCase.mps);
      cars.push(bullet);
      vip.frame(FRAME, true, 0, cars, throwPassenger, throwFigure);
      vip.frame(FRAME, true, 0, cars, throwPassenger, throwFigure);
      assert.equal(figures.length, testCase.expectedFigures, "figures thrown");
      assert.equal(vip["phase"], testCase.expectedFigures === 1 ? "thrown" : "walking", "his phase");
      if (testCase.expectedFigures === 0) return;
      assert.equal(figures[0]!.guard, -1, "the VIP, not a guard");
      assert.equal(figures[0]!.car, 1, "struck by the second car");
      assert.ok(Math.abs(figures[0]!.x - where.x) < 1e-3 && Math.abs(figures[0]!.z - where.z) < 1e-3, "where he stood");
      assert.equal((vip["people"]["mesh"]["shown"] >> 0) & 1, 0, "his figure is hidden");
    });
  }
});

/** A guard squad over the National Mall's lawn, its people's meshes, the car it fires on and a second car off the grounds. */
function lawn() {
  const people = new People(spec.count + 1);
  const squad = new GuardSquad(spec, ground, people);
  const guard = new LawnGuard(spec, 2);
  guard.reset(1);
  const car = makeCar();
  launch(car, NORTH_LAWN.x, NORTH_LAWN.z, 0, 0, 0);
  const bullet = makeCar();
  launch(bullet, OFF_GROUNDS.x, OFF_GROUNDS.z, 0, 0, 0);
  const cars = [car, bullet];
  const frames = (seconds: number, standDown: boolean): void => {
    guard.standDown = standDown;
    for (let t = 0; t < seconds; t += FRAME) {
      guard.step(cars, FRAME);
      squad.frame(guard, cars, () => {});
      people.update(FRAME);
    }
  };
  return { people, squad, guard, car, cars, bullet, frames };
}

/** Whether slot `slot` of the people's one mesh is drawn. */
const standing = (people: People, slot: number): boolean => ((people["mesh"]["shown"] >> slot) & 1) === 1;

describe("given the National Mall's guard squad, inside the house until the alarm goes up", () => {
  it("when nobody is out, then nothing of theirs is drawn; when the alarm sends them out, they are drawn; when it stands down and they are back inside, they are not", () => {
    const { people, frames } = lawn();
    frames(1, true);
    assert.equal(people.group.visible, false, "a quiet lawn draws nothing");
    frames(4, false);
    assert.equal(people.group.visible, true, "the squad out on the lawn is drawn");
    frames(20, true);
    assert.equal(people.group.visible, false, "the squad back inside draws nothing");
  });

  it("when a car at speed runs guard 0 down, then he is drawn no more while the rest of the squad still is, and after a restart he stands in the ranks again", () => {
    const { people, squad, guard, bullet, frames } = lawn();
    frames(3, false);
    assert.ok(standing(people, 1) && standing(people, 2), "guards 0 and 1 stand at their posts");
    launch(bullet, guard.guardX[0]!, guard.guardZ[0]!, 0, 0, 15);
    frames(2 * FRAME, false);
    assert.equal(guard.mode[0], GUARD_DOWN, "the sim has him down");
    assert.ok(!standing(people, 1), "he is no longer drawn");
    assert.ok(standing(people, 2), "the next guard still is");
    launch(bullet, OFF_GROUNDS.x, OFF_GROUNDS.z, 0, 0, 0);
    squad.reset();
    guard.reset(1);
    frames(3, false);
    assert.ok(standing(people, 1), "after the restart he stands again");
  });

  it("when a gun fires with nobody else out, then its flash goes out first, its tracer a moment later, and then nothing is drawn", () => {
    const { people } = lawn();
    people.fire(0, 0, 1, 0);
    people.update(FRAME);
    assert.equal(people.group.visible, true, "the shot shows");
    assert.ok(people["flashes"].visible && people["tracers"].visible, "flash and tracer both show");
    people.update(0.04);
    assert.ok(!people["flashes"].visible && people["tracers"].visible, "the flash is out, the tracer still runs");
    people.update(0.2);
    assert.equal(people.group.visible, false, "the shot is out");
    assert.ok(!people["tracers"].visible, "the tracer is out");
  });

  /** The squad out and aiming at the parked car, then one shot of guard 0's at it drawn on its own frame: where its tracer ended and the sparks asked for. */
  function shotAtCar(hit: boolean) {
    const { people, squad, guard, car, cars, frames } = lawn();
    frames(3, false);
    const k = guard.shots % SHOT_RING;
    guard.shotGuard[k] = 0;
    guard.shotCar[k] = 0;
    guard.shotHit[k] = hit ? 1 : 0;
    guard.shots++;
    const sparked: { at: THREE.Vector3; normal: THREE.Vector3 }[] = [];
    squad.frame(guard, cars, (at, normal) => void sparked.push({ at: at.clone(), normal: normal.clone() }));
    const muzzle = people.muzzle(1, new THREE.Vector3()).clone();
    const tracer = people["tracerAt"] as Float32Array;
    const last = ((people["tracerNext"] as number) + 23) % 24;
    return { car, sparked, muzzle, tracerEnd: new THREE.Vector3().fromArray(tracer, last * 6 + 3) };
  }

  /** Distance (m) along the ray from `o` along `d` to the first of the triangles (9 numbers each: Moller-Trumbore); Infinity for none. */
  function firstTriangle(tris: Float32Array, o: THREE.Vector3, d: THREE.Vector3): number {
    const edge1 = new THREE.Vector3();
    const edge2 = new THREE.Vector3();
    const p = new THREE.Vector3();
    const rel = new THREE.Vector3();
    const q = new THREE.Vector3();
    let best = Infinity;
    for (let i = 0; i < tris.length; i += 9) {
      edge1.fromArray(tris, i + 3).sub(rel.fromArray(tris, i));
      edge2.fromArray(tris, i + 6).sub(rel.fromArray(tris, i));
      const det = edge1.dot(p.crossVectors(d, edge2));
      if (Math.abs(det) < 1e-12) continue;
      rel.copy(o).sub(q.fromArray(tris, i));
      const u = rel.dot(p) / det;
      q.crossVectors(rel, edge1);
      const v = d.dot(q) / det;
      const t = edge2.dot(q) / det;
      if (u >= 0 && v >= 0 && u + v <= 1 && t >= 0) best = Math.min(best, t);
    }
    return best;
  }

  it("when a hit shot lands on a car, then the sparks start on the car's surface facing the shooter, where its tracer ends, not inside the body", () => {
    const { car, sparked, muzzle, tracerEnd } = shotAtCar(true);
    assert.equal(sparked.length, 1, "one shower for the hit");
    const { at, normal } = sparked[0]!;
    const inside = car.group.position.clone().add(new THREE.Vector3(0, 0.7, 0));
    assert.ok(muzzle.distanceTo(at) < muzzle.distanceTo(inside) - 0.5, `the point is ${(muzzle.distanceTo(inside) - muzzle.distanceTo(at)).toFixed(2)} m nearer the shooter than the car's middle`);
    assert.ok(normal.dot(muzzle.clone().sub(at)) > 0 && Math.abs(normal.length() - 1) < 1e-6, "the face's unit normal points at the shooter");
    // On the body: a ray from 5 cm off the point straight back at the car meets a drawn triangle of its body within a few cm of that.
    const turn = car.group.quaternion.clone().invert();
    const from = at.clone().addScaledVector(normal, 0.05).sub(car.group.position).applyQuaternion(turn);
    const way = normal.clone().negate().applyQuaternion(turn);
    const t = firstTriangle(drawnTriangles(car), from, way);
    assert.ok(Math.abs(t - 0.05) < 0.05, `the body is ${t.toFixed(3)} m along the ray from 5 cm off the point`);
    assert.ok(tracerEnd.distanceTo(at) < 1e-4, "the tracer ends where the sparks start");
  });

  it("when a shot misses the car, then its tracer flies past and no sparks fly", () => {
    const { sparked, tracerEnd, car } = shotAtCar(false);
    assert.equal(sparked.length, 0, "no sparks");
    assert.ok(tracerEnd.distanceTo(car.group.position) > 2, "the tracer ends wide of the car");
  });
});

describe("given the VIP riding with the squad inside", () => {
  it("when he is in the passenger seat, then one figure is drawn, not the squad's empty places too", () => {
    const art = new GroundsArt(spec, ground, new THREE.Group());
    const car = makeCar();
    launch(car, NORTH_LAWN.x, NORTH_LAWN.z, 0, 0, 0);
    const host = { sparks: () => {}, throwPassenger: () => {}, throwFigure: () => {} };
    for (let t = 0; t < 40; t += FRAME) art.frame(FRAME, null, true, [car], 0, host);
    const drawn = art["people"].group.children.find((c): c is DummyMesh => c instanceof DummyMesh)!;
    const slots = spec.count + 1;
    assert.equal(drawn.count, drawn.instanceMatrix.count / slots, "the draw ends after slot 0");
  });

  it("when the next race starts (`GroundsArt.reset`), then he is back inside: no figure is drawn and, the secret in again, he does not come out", () => {
    const art = new GroundsArt(spec, ground, new THREE.Group());
    const car = makeCar();
    launch(car, NORTH_LAWN.x, NORTH_LAWN.z, 0, 0, 0);
    const host = { sparks: () => {}, throwPassenger: () => {}, throwFigure: () => {} };
    for (let t = 0; t < 40; t += FRAME) art.frame(FRAME, null, true, [car], 0, host);
    const drawn = art["people"].group.children.find((c): c is DummyMesh => c instanceof DummyMesh)!;
    assert.equal(drawn.count, drawn.instanceMatrix.count / (spec.count + 1), "riding: his one figure is drawn");
    art.reset();
    for (let t = 0; t < 40; t += FRAME) art.frame(FRAME, null, false, [car], 0, host);
    assert.equal(drawn.count, 0, "nobody drawn");
  });
});

describe("given the secret's flash over a view", () => {
  it("when it is stopped before its peak, then the glare is gone at once and the sky picture never comes out", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const glare = { style: { cssText: "" }, removed: false, cancelled: false, remove: () => void (glare.removed = true), animate: () => ({ cancel: () => void (glare.cancelled = true) }) };
    Object.defineProperty(globalThis, "document", { value: { createElement: () => glare }, configurable: true });
    t.after(() => void Reflect.deleteProperty(globalThis, "document"));
    let peaked = false;
    const stop = nukeFlash({ appendChild: (node) => node }, () => void (peaked = true));
    stop();
    t.mock.timers.tick(10_000);
    assert.equal(peaked, false, "the picture's moment never comes");
    assert.ok(glare.removed && glare.cancelled, "the glare is taken down");
  });
});
