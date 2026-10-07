import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import type { RigidBody } from "@dimforge/rapier3d";
import { launch, makeCar } from "../contact/crash-scenarios.test-util.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { PREFABS, type PrefabId } from "../world/catalog.ts";
import { setGround } from "../world/ground.ts";
import { placeProps } from "../world/placements.ts";
import { Track } from "../world/track.ts";
import { parseTrack } from "../world/track-schema.ts";
import { square } from "../world/track.test-util.ts";
import { RagdollSystem } from "./engine-ragdoll.ts";

const FRAME = 1 / 60;
const UP = new THREE.Vector3(0, 1, 0);

/** The square test course with one `prefab` placed at (x, z). */
const course = (prefab: PrefabId, x: number, z: number) => new Track(parseTrack(square({ props: [{ prefab, x, z, yaw: 0, scale: 1 }] })));

/** The square course's road beside its first checkpoint: a point on its centre line, the way along it and the way across it to the left (both unit, level); the left wall's face stands `WALL_OFF` m across. */
const ROAD = (() => {
  const p = new Track(parseTrack(square())).path;
  const k = 31;
  return { x: p.x[k]!, z: p.z[k]!, along: new THREE.Vector3(p.tx[k]!, 0, p.tz[k]!), left: new THREE.Vector3(p.tz[k]!, 0, -p.tx[k]!) };
})();
/** The road's half width plus its run-off. */
const WALL_OFF = 7;

/** A dummies' world on `track` (its ground active), Rapier in unless `loaded` is false. */
async function system(track: Track, loaded = true): Promise<RagdollSystem> {
  const sys = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  if (loaded) await sys.preload();
  setGround(track.ground());
  sys.setCourse(track, placeProps(track), null);
  sys.update(FRAME, [], true, false, 0, null);
  return sys;
}

const bodyOf = (sys: RagdollSystem): RigidBody => sys["props"]["bodies"][0]!;

/** `seconds` of frames with `cars` about; `each` sees prop 0's middle and its up axis after every frame. */
function run(sys: RagdollSystem, seconds: number, cars: DeformableCar[], each: (p: THREE.Vector3, up: THREE.Vector3) => void): void {
  const p = new THREE.Vector3();
  const v = new THREE.Vector3();
  const up = new THREE.Vector3();
  const q = new THREE.Quaternion();
  for (let f = 0; f < Math.round(seconds / FRAME); f++) {
    sys.update(FRAME, cars, true, false, 0, null);
    if (!sys.propAt(0, p, v)) continue;
    const r = bodyOf(sys).rotation();
    each(p, up.copy(UP).applyQuaternion(q.set(r.x, r.y, r.z, r.w)));
  }
}

describe("given a knockable prop standing in the infield of a course", () => {
  // A car at 10 m/s sends a prop off at 11 m/s and 4.5 m/s up (the race's prop rule).
  const tumbleCases = [
    { it: "when a cone is knocked at 11 m/s, then it tumbles, lands on the ground and comes to rest lying on it", prefab: "cone" },
    { it: "when a tyre stack is knocked at 11 m/s, then it tumbles, lands on the ground and comes to rest lying on it", prefab: "tyre-stack" },
    { it: "when a crate is knocked at 11 m/s, then it tumbles, lands on the ground and comes to rest lying on it", prefab: "crate" },
    { it: "when a hay bale is knocked at 11 m/s, then it tumbles, lands on the ground and comes to rest lying on it", prefab: "hay-bale" },
  ] as const;
  for (const testCase of tumbleCases) {
    it(testCase.it, async (t) => {
      const track = course(testCase.prefab, 60, 60);
      const ground = track.ground();
      const sys = await system(track);
      sys.knockProp(0, -1, 11, 4.5, 0);
      let tilt = 0;
      let lowest = Infinity;
      const end = new THREE.Vector3();
      run(sys, 10, [], (p, up) => {
        tilt = Math.max(tilt, Math.acos(Math.min(1, Math.abs(up.y))));
        lowest = Math.min(lowest, p.y - ground.heightAt(p.x, p.z, p.y));
        end.copy(p);
      });
      const body = bodyOf(sys);
      const v = body.linvel();
      const w = body.angvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      const spin = Math.hypot(w.x, w.y, w.z);
      const asleep = body.isSleeping();
      const rise = end.y - ground.heightAt(end.x, end.z, end.y);
      const [sx, sy, sz] = PREFABS[testCase.prefab].size;
      sys.dispose();
      t.diagnostic(`tilted ${((tilt * 180) / Math.PI).toFixed(0)}°, rests ${(end.x - 60).toFixed(1)} m on, middle ${rise.toFixed(2)} m up (lowest ${lowest.toFixed(2)}), ${speed.toFixed(3)} m/s, ${spin.toFixed(3)} rad/s, asleep ${asleep}`);
      assert.ok(tilt > Math.PI / 4, `it never tipped past 45° (${((tilt * 180) / Math.PI).toFixed(0)}°)`);
      assert.ok(end.x - 60 > 5, `it came down ${(end.x - 60).toFixed(1)} m from its spot`);
      assert.ok(lowest > 0.1, `its middle sank to ${lowest.toFixed(2)} m over the ground`);
      assert.ok(rise < Math.max(sx, sy, sz) / 2 + 0.05, `it rests with its middle ${rise.toFixed(2)} m up: not on the ground`);
      assert.ok(speed < 0.05 && spin < 0.1 && asleep, `still moving at ${speed.toFixed(3)} m/s, ${spin.toFixed(3)} rad/s (asleep: ${asleep})`);
    });
  }
  // Knocked across the infield (a tyre stack knocked that way rolls on for seconds; knocked 5° off the other way it stops).
  const restCases = [
    { it: "when a cone is knocked at 11 m/s and comes to rest, then it lies asleep within half a second of stopping", prefab: "cone", kick: [11, 4.5, 0] },
    { it: "when a tyre stack is knocked at 11 m/s and comes to rest, then it lies asleep within half a second of stopping", prefab: "tyre-stack", kick: [0.96, 4.5, 10.96] },
    { it: "when a crate is knocked at 11 m/s and comes to rest, then it lies asleep within half a second of stopping", prefab: "crate", kick: [11, 4.5, 0] },
    { it: "when a hay bale is knocked at 11 m/s and comes to rest, then it lies asleep within half a second of stopping", prefab: "hay-bale", kick: [11, 4.5, 0] },
  ] as const;
  for (const testCase of restCases) {
    it(testCase.it, async () => {
      const sys = await system(course(testCase.prefab, 60, 60));
      const [vx, vy, vz] = testCase.kick;
      sys.knockProp(0, -1, vx, vy, vz);
      const body = bodyOf(sys);
      // Sim s from which it has moved under 0.1 m/s and turned under 0.1 rad/s (-1: moving), and when it slept.
      let stopped = -1;
      let slept = -1;
      for (let f = 1; f <= Math.round(10 / FRAME); f++) {
        sys.update(FRAME, [], true, false, 0, null);
        if (body.isSleeping()) {
          slept = f * FRAME;
          break;
        }
        const v = body.linvel();
        const w = body.angvel();
        if (Math.hypot(v.x, v.y, v.z) >= 0.1 || Math.hypot(w.x, w.y, w.z) >= 0.1) stopped = -1;
        else if (stopped < 0) stopped = f * FRAME;
      }
      sys.dispose();
      assert.ok(slept > 0, "it never slept in 10 s");
      assert.ok(stopped > 0 && slept - stopped <= 0.5, `it lay still ${(slept - stopped).toFixed(2)} s before it slept (stopped at ${stopped.toFixed(2)} s)`);
    });
  }
});

describe("given a prop on the middle of a course's road, 7 m from the wall's face", () => {
  it("when a cone is knocked straight at the wall at 20 m/s, then it stops on the wall's face and never gets past it", async () => {
    const sys = await system(course("cone", ROAD.x, ROAD.z));
    sys.knockProp(0, -1, ROAD.left.x * 20, 1, ROAD.left.z * 20);
    let farthest = -Infinity;
    run(sys, 3, [], (p) => (farthest = Math.max(farthest, (p.x - ROAD.x) * ROAD.left.x + (p.z - ROAD.z) * ROAD.left.z)));
    sys.dispose();
    assert.ok(farthest > WALL_OFF - 1, `it never reached the wall (${farthest.toFixed(2)} m across)`);
    assert.ok(farthest < WALL_OFF, `its middle got ${(farthest - WALL_OFF).toFixed(2)} m past the wall's face`);
  });

  it("when a crate is knocked at 15 m/s at a car parked broadside 4 m across, then it stops against the car's side and never gets into it", async () => {
    const car = makeCar();
    launch(car, ROAD.x + ROAD.left.x * 4, ROAD.z + ROAD.left.z * 4, Math.atan2(ROAD.along.x, ROAD.along.z), 0, 0);
    const sys = await system(course("crate", ROAD.x, ROAD.z));
    sys.knockProp(0, -1, ROAD.left.x * 15, 2, ROAD.left.z * 15);
    let farthest = -Infinity;
    run(sys, 3, [car], (p) => (farthest = Math.max(farthest, (p.x - ROAD.x) * ROAD.left.x + (p.z - ROAD.z) * ROAD.left.z)));
    sys.dispose();
    // The car's side is 0.86 m from its middle line; the crate is 0.5 m to its middle.
    assert.ok(farthest > 2, `it never reached the car (${farthest.toFixed(2)} m across)`);
    assert.ok(farthest < 4 - 0.86 - 0.35, `its middle got ${farthest.toFixed(2)} m across, into the car's side at ${(4 - 0.86).toFixed(2)} m`);
  });
});

describe("given a course whose props a car knocks before the dummies' physics has loaded", () => {
  it("when the physics arrives, then the knocked prop flies off from its spot then, and none before", async () => {
    const sys = await system(course("crate", 60, 60), false);
    sys.knockProp(0, -1, 11, 4.5, 0);
    const p = new THREE.Vector3();
    const v = new THREE.Vector3();
    sys.update(FRAME, [], true, false, 0, null);
    assert.equal(sys.propAt(0, p, v), false, "it flew before the physics was in");
    await sys.preload();
    let farthest = -Infinity;
    run(sys, 2, [], (at) => (farthest = Math.max(farthest, at.x)));
    sys.dispose();
    assert.ok(farthest - 60 > 5, `it went ${(farthest - 60).toFixed(1)} m`);
  });
});

describe("given a course with a knocked prop lying where it fell", () => {
  it("when the run is reset, then the prop stands on its spot again; when the course's ground is left, its standing props leave the physics; and when it is back, they stand again", async () => {
    const track = course("crate", 60, 60);
    const sys = await system(track);
    const standing = sys["world"]!.colliders.len();
    sys.knockProp(0, -1, 11, 4.5, 0);
    run(sys, 3, [], () => {});
    sys.reset();
    const p = new THREE.Vector3();
    const v = new THREE.Vector3();
    assert.equal(sys.propAt(0, p, v), false, "still out after the reset");
    const at = bodyOf(sys).translation();
    const spot = placeProps(track)[0]!;
    assert.ok(Math.hypot(at.x - spot.x, at.y - spot.y - PREFABS.crate.size[1] / 2, at.z - spot.z) < 1e-4, `it stands at ${at.x}, ${at.y}, ${at.z}`);
    setGround(null);
    sys.update(FRAME, [], true, false, 0, null);
    const away = sys["world"]!.colliders.len();
    setGround(track.ground());
    sys.update(FRAME, [], true, false, 0, null);
    const back = sys["world"]!.colliders.len();
    sys.dispose();
    assert.ok(away < standing, `the props stayed in the physics off their course (${away} colliders, ${standing} on it)`);
    assert.equal(back, standing, "back on the course");
  });
});

/** `car` driven from (x, z) along the unit (dx, dz) at `speed` m/s for `seconds` of frames; `each` around every frame's dummies' world. */
function drive(sys: RagdollSystem, car: DeformableCar, x: number, z: number, dx: number, dz: number, speed: number, seconds: number, each: (frame: () => void) => void = (frame) => frame()): void {
  const yaw = Math.atan2(dx, dz);
  for (let f = 0; f < Math.round(seconds / FRAME); f++) {
    launch(car, x + dx * speed * f * FRAME, z + dz * speed * f * FRAME, yaw, dx * speed, dz * speed);
    each(() => sys.update(FRAME, [car], true, false, 0, null));
  }
}

/** The dummies' world on the square course with a crate knocked off (60, 60) at 11 m/s, run until it lies asleep, and where it lies. */
async function restingCrate(): Promise<{ sys: RagdollSystem; at: THREE.Vector3 }> {
  const sys = await system(course("crate", 60, 60));
  sys.knockProp(0, -1, 11, 4.5, 0);
  const at = new THREE.Vector3();
  for (let f = 0; f < Math.round(10 / FRAME) && !bodyOf(sys).isSleeping(); f++) sys.update(FRAME, [], true, false, 0, null);
  sys.propAt(0, at, new THREE.Vector3());
  return { sys, at };
}

describe("given a crate knocked over in a course's infield, lying asleep where it came to rest", () => {
  it("when a car drives by at 20 m/s with its middle line 5 m from the crate, out of reach of it, then the dummies' world takes no step", async () => {
    const { sys, at } = await restingCrate();
    const tick = sys["tick"];
    drive(sys, makeCar(), at.x + 5, at.z - 15, 0, 1, 20, 1.5);
    const steps = sys["tick"] - tick;
    sys.dispose();
    assert.equal(steps, 0, `the world took ${steps} steps for a car that never came within reach`);
  });

  it("when a car drives into it at 10 m/s, then the crate is shoved on over a metre", async () => {
    const { sys, at } = await restingCrate();
    drive(sys, makeCar(), at.x, at.z - 10, 0, 1, 10, 2);
    const now = new THREE.Vector3();
    sys.propAt(0, now, new THREE.Vector3());
    sys.dispose();
    assert.ok(now.distanceTo(at) > 1, `it moved ${now.distanceTo(at).toFixed(2)} m`);
  });
});

describe("given 24 crates knocked over where they stood, lying asleep in a row", () => {
  // Measured: 27.5–28.6 KB a frame while every sleeping crate was read each frame, 8.4–12.1 KB without (the world's own steps).
  it("when a car drives along the row 3 m off at 20 m/s, near enough that the world steps but never touching, then the crates stay asleep and a frame allocates at most 16 KB", async () => {
    const props = Array.from({ length: 24 }, (_, k) => ({ prefab: "crate" as const, x: 40 + 2 * k, z: 60, yaw: 0, scale: 1 }));
    const sys = await system(new Track(parseTrack(square({ props }))));
    for (let i = 0; i < props.length; i++) sys.knockProp(i, -1, 0, 0, 0);
    run(sys, 3, [], () => {});
    const bodies = sys["props"]["bodies"];
    const car = makeCar();
    // A first pass warms the code up; the second is measured.
    drive(sys, car, 30, 63, 1, 0, 20, 2.5);
    const tick = sys["tick"];
    let grown = 0;
    let frames = 0;
    drive(sys, car, 30, 63, 1, 0, 20, 2.5, (frame) => {
      const before = process.memoryUsage().heapUsed;
      frame();
      const after = process.memoryUsage().heapUsed;
      frames++;
      if (after > before) grown += after - before;
    });
    const steps = sys["tick"] - tick;
    const awake = bodies.filter((b) => !b!.isSleeping()).length;
    sys.dispose();
    const kb = grown / 1024 / frames;
    assert.ok(steps > 0, "the world never stepped: nothing here reads the crates");
    assert.equal(awake, 0, `${awake} crates woke`);
    assert.ok(kb <= 16, `${kb.toFixed(2)} KB per frame`);
  });
});
