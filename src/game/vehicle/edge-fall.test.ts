import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { beginFakeFall, type DeformableCar } from "./car.ts";
import { makeCar, makeWorld, runPair, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { edgeAction, FAKE_DEPTH, FLEET_MIN_SEP, layoutFleet, respawnSlot, RESPAWN_S, VAPOR_DEPTH } from "../scenes/fleet.ts";
import { DISC_GROUND, DISC_RADIUS, FLAT_GROUND, setGround, type Ground } from "../world/ground.ts";
import { assertSameDigest, assertSameNumbers } from "./test-support.ts";

const G_FRAME2 = 9.6 / 3600;

/** Car at (x, 0) heading +X at `vx` m/s; a wreck (`wreck`) moves on its masses. */
function launch(x: number, vx: number, wreck: boolean): DeformableCar {
  const car = makeCar("shape");
  car.spawnFacing(x, 0, Math.PI / 2, 0);
  car.velocity.set(vx, 0, 0);
  car.speed = vx;
  car.spawnSpeed = vx;
  car.deform.bindKinematic(car.group, car.velocity, car.angular);
  if (wreck) car.deform.armMasses(car.group, car.velocity, car.angular);
  return car;
}

/** Worst change (m) of any mass-pair distance from rest: how far the body is bent or stretched. */
function shapeErr(car: DeformableCar): number {
  const ms = car.deform.masses;
  let worst = 0;
  for (let i = 0; i < ms.length; i++) {
    for (let j = i + 1; j < ms.length; j++) {
      worst = Math.max(worst, Math.abs(ms[i]!.world.distanceTo(ms[j]!.world) - ms[i]!.rest.distanceTo(ms[j]!.rest)));
    }
  }
  return worst;
}

/** Every mass and group position, frame by frame, for an exact replay diff. */
function record(cars: DeformableCar[], frames: number): number[] {
  const w = makeWorld(cars, false, false);
  const out: number[] = [];
  for (let f = 0; f < frames; f++) {
    tickWorld(w);
    for (const c of cars) {
      out.push(c.group.position.x, c.group.position.y, c.group.position.z);
      for (const m of c.deform.masses) out.push(m.world.x, m.world.y, m.world.z);
    }
  }
  return out;
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fleetCrash(ground: Ground): number[] {
  setGround(ground);
  const slots = layoutFleet(6, 12, 16, seeded(7));
  const cars = slots.map((s) => {
    const c = makeCar("shape");
    c.spawn(s.x, s.z, s.speed);
    return c;
  });
  return record(cars, 200);
}

describe("given the fleet course's disc-shaped ground (a round pad with a rim past which the ground ends)", () => {
  afterEach(() => setGround(null));

  for (const wreck of [false, true]) {
    it(`when a ${wreck ? "wreck sliding" : "car driven"} goes past the rim at 16 m/s, then it falls in one piece, is swapped for a frozen fake at ${FAKE_DEPTH} m down and is vaporized (removed) at ${VAPOR_DEPTH} m down`, () => {
      setGround(DISC_GROUND);
      const car = launch(40, 16, wreck);
      const w = makeWorld([car], false, false);
      const p = car.group.position;
      const skin = car.body.geometry.getAttribute("position").array;
      let prevY = 0;
      let prevD = 0;
      let worstJerk = 0;
      let worstShape = 0;
      let frozenMasses: number[] = [];
      let frozenSkin: number[] = [];
      let fakeAt = -1;
      let frame = 0;
      // `CrashEngine.stepEdge`'s order: physics for the frame, then the edge rule.
      for (; frame < 300; frame++) {
        tickWorld(w);
        for (const m of car.deform.masses) assert.ok(Number.isFinite(m.world.x + m.world.y + m.world.z), `mass NaN at frame ${frame}`);
        assert.ok(Number.isFinite(p.x + p.y + p.z), `group NaN at frame ${frame}`);
        const d = p.y - prevY;
        // A pop is any frame whose height change departs from the last one by more than gravity's share.
        if (frame > 2) worstJerk = Math.max(worstJerk, Math.abs(d - prevD));
        prevD = d;
        prevY = p.y;
        if (!car.falling) worstShape = Math.max(worstShape, shapeErr(car));
        const act = edgeAction(p.y, car.falling, car.vaporized, false, 0);
        if (act === "vaporize") break;
        if (act === "fake") {
          beginFakeFall(car);
          fakeAt = frame;
          frozenMasses = car.deform.masses.flatMap((m) => [m.world.x, m.world.y, m.world.z]);
          frozenSkin = Array.from(skin);
        }
      }
      assert.ok(fakeAt > 0 && p.y < -VAPOR_DEPTH, `y ${p.y.toFixed(2)} m after ${frame} frames (fake at ${fakeAt}): the ground did not end`);
      assert.ok(Math.hypot(p.x, p.z) > DISC_RADIUS, "fell inside the rim");
      assert.ok(frame < 200, `took ${frame} frames to fall ${VAPOR_DEPTH} m`);
      assert.ok(worstJerk <= G_FRAME2 * 1.05, `height popped ${worstJerk.toFixed(4)} m/frame² (gravity ${G_FRAME2.toFixed(4)})`);
      // Measured 0.000 m driven, ≈0.1 m for the wreck (its nose tips over the rim first; 0.03 before the rim).
      assert.ok(worstShape < 0.2, `body bent ${worstShape.toFixed(3)} m while falling`);
      // The fake is the car as it was: no mass or skin vertex moved after the swap, only the group.
      assertSameNumbers(car.deform.masses.flatMap((m) => [m.world.x, m.world.y, m.world.z]), frozenMasses, "masses after the swap");
      assertSameNumbers(skin, frozenSkin, "skin after the swap");
    });
  }

  it("when a wreck moving at (3, −2, 5) m/s and spinning is swapped for the fake fall, then the fake keeps its linear and angular velocity, the spin to within 35 %", () => {
    const car = launch(0, 0, true);
    const v = new THREE.Vector3(3, -2, 5);
    const spin = new THREE.Vector3(0.4, -1.1, 0.7);
    const c = new THREE.Vector3();
    for (const m of car.deform.masses) c.addScaledVector(m.world, m.mass / car.deform.masses.reduce((s, n) => s + n.mass, 0));
    for (const m of car.deform.masses) m.vel.copy(v).add(new THREE.Vector3().subVectors(m.world, c).cross(spin).negate());
    // The group's origin moves with the body: v + spin × (origin − centre).
    const want = v.clone().add(car.group.position.clone().sub(c).cross(spin).negate());
    const arm = car.group.position.distanceTo(c);
    beginFakeFall(car);
    assert.ok(car.falling && !car.deform.massActive);
    // A least-squares fit of a non-spherical body recovers the spin approximately, never exactly.
    assert.ok(car.fallSpin.distanceTo(spin) < 0.35 * spin.length(), `spin ${car.fallSpin.toArray()} vs ${spin.toArray()}`);
    assert.ok(car.velocity.distanceTo(want) <= 0.35 * spin.length() * arm + 1e-9, `velocity ${car.velocity.toArray()} vs ${want.toArray()}`);
  });

  it("when a vaporized car is stepped for 30 frames, then it is out of the sim: its group and masses stay put", () => {
    setGround(DISC_GROUND);
    const car = launch(60, 10, false);
    car.group.position.y = -25;
    car.resetVisual();
    car.vaporized = true;
    const before = record([car], 1);
    assertSameNumbers(record([car], 30).slice(-before.length), before, "vaporized car");
  });

  it(`when a car falls past the edge depths, then it is faked, then vaporized, and only the driven car respawns ${RESPAWN_S} s later while an AI car stays gone`, () => {
    assert.equal(edgeAction(-FAKE_DEPTH + 0.1, false, false, true, 0), null);
    assert.equal(edgeAction(-FAKE_DEPTH - 0.1, false, false, true, 0), "fake");
    assert.equal(edgeAction(-FAKE_DEPTH - 0.1, true, false, true, 0), null);
    assert.equal(edgeAction(-VAPOR_DEPTH - 0.1, true, false, false, 0), "vaporize");
    assert.equal(edgeAction(-VAPOR_DEPTH - 0.1, false, true, true, RESPAWN_S - 0.1), null);
    assert.equal(edgeAction(-VAPOR_DEPTH - 0.1, false, true, true, RESPAWN_S + 0.1), "respawn");
    assert.equal(edgeAction(-VAPOR_DEPTH - 0.1, false, true, false, 60), null, "an AI car stays gone");
  });

  it("when a car respawns, then it is on the disc along the bearing it fell from, facing the centre, and clear of other cars", () => {
    const free = respawnSlot(60, 0, []);
    assert.ok(free.x > 30 && Math.abs(free.z) < 1e-9, "on the bearing it fell from");
    const parked = [{ x: free.x, z: free.z }];
    const s = respawnSlot(60, 0, parked);
    for (const slot of [free, s]) {
      assert.ok(Math.hypot(slot.x, slot.z) < DISC_RADIUS - 5);
      // Nose (sin yaw, cos yaw) points at the origin.
      assert.ok(Math.sin(slot.yaw) * -slot.x + Math.cos(slot.yaw) * -slot.z > Math.hypot(slot.x, slot.z) * 0.999);
    }
    assert.ok(Math.hypot(s.x - free.x, s.z - free.z) >= FLEET_MIN_SEP);
  });

  it("when a fleet crash and a head-on pair are replayed on the disc and on the flat pad, then the two grounds give exactly the same results inside the rim", () => {
    assertSameNumbers(fleetCrash(DISC_GROUND), fleetCrash(FLAT_GROUND), "fleet crash");
    setGround(DISC_GROUND);
    const disc = runPair(48, 48, "head-on");
    setGround(FLAT_GROUND);
    assertSameDigest(disc, runPair(48, 48, "head-on"), "head-on");
  });
});
