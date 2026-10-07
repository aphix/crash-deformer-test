import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applyDrive, idleDrive } from "../vehicle/car-drive.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { blankAiCar, type AiCar } from "./derby-ai.ts";
import { snapshotAiCar } from "../match/derby.ts";
import { fleetStyle } from "../scenes/fleet.ts";
import { setGround } from "../world/ground.ts";
import { SURFACES } from "../world/catalog.ts";
import { onSurface } from "./race-ai.ts";
import { Track, blankProjection, projectPath } from "../world/track.ts";
import { SPAWN_FAR, SPAWN_NEAR, TrafficBrain } from "./traffic.ts";
import city from "../world/tracks/city.json" with { type: "json" };

const DT = 1 / 60;
const track = new Track(city);

function cars(n: number, scene: THREE.Scene): DeformableCar[] {
  return Array.from({ length: n }, (_, i) => new DeformableCar({ body: 0x808080, accent: 0x404040, name: `t${i}` }, scene, null, fleetStyle(i)));
}

/** Drive `fleet` with `brain` for `seconds`; `sample(i, car)` every 6th step; car `frozen` stays parked. */
function run(brain: TrafficBrain, fleet: DeformableCar[], seconds: number, sample: (i: number, c: DeformableCar) => void, frozen = -1): void {
  const ground = track.ground();
  setGround(ground);
  const snaps: AiCar[] = fleet.map((_, i) => blankAiCar(i));
  const scratch = idleDrive();
  const park = { ...idleDrive(), brake: 1 };
  for (let step = 0; step < seconds / DT; step++) {
    for (const [i, c] of fleet.entries()) snapshotAiCar(snaps[i]!, i, c, true);
    for (const [i, c] of fleet.entries()) {
      const surf = SURFACES[ground.surfaceAt(c.group.position.x, c.group.position.z)];
      applyDrive(c, onSurface(i === frozen ? park : brain.think(snaps[i]!, snaps, DT), surf, scratch), DT);
      c.integrate(DT);
    }
    if (step % 6 === 0) for (const [i, c] of fleet.entries()) sample(i, c);
  }
  setGround(null);
}

describe("given the city track's ambient traffic (cars that drive the lanes around the player)", () => {
  const brain = new TrafficBrain(track, 0);

  it("when the traffic is first laid out, then it fills the loop lanes and then every side street, each car in its lane facing its lane's direction", () => {
    assert.equal(brain.count, 4 + 4 + 4);
    const p = blankProjection();
    for (const [i, s] of brain.spawns().entries()) {
      const slot = brain.slotOf(i);
      projectPath(slot.path, s.x, s.z, -1, p);
      assert.ok(Math.abs(p.lateral - slot.offset) < 0.2, `car ${i} lateral ${p.lateral.toFixed(2)} vs lane ${slot.offset}`);
      const along = Math.sin(s.yaw) * slot.path.tx[p.k]! + Math.cos(s.yaw) * slot.path.tz[p.k]!;
      assert.ok(along * slot.dir > 0.95, `car ${i} faces its lane direction`);
      if (slot.path === track.path) assert.ok(p.s > 70 && p.s < track.length - 70, `loop car ${i} on the grid (s ${p.s.toFixed(0)})`);
    }
    assert.ok(brain.slots.some((s) => s.path !== track.path && s.dir < 0) && brain.slots.some((s) => s.path !== track.path && s.dir > 0));
  });

  it("when twelve traffic cars drive 50 s from their start lanes, then they stay in their lanes at least 90% of the time and the cross-street cars drive through all four of the race loop's junctions", () => {
    const scene = new THREE.Scene();
    const fleet = cars(12, scene);
    brain.reset();
    for (const [i, s] of brain.spawns().entries()) fleet[i]!.spawnFacing(s.x, s.z, s.yaw, 0);
    // Junction centres where a side street meets the loop.
    const junctions = [
      [0, 0],
      [180, 0],
      [120, 60],
      [120, -60],
    ];
    const crossed = new Set<string>();
    let inLane = 0;
    let samples = 0;
    const p = blankProjection();
    run(brain, fleet, 50, (i, c) => {
      const slot = brain.slotOf(i);
      projectPath(slot.path, c.group.position.x, c.group.position.z, -1, p);
      samples++;
      if (Math.abs(p.lateral - slot.offset) < 1.5) inLane++;
      if (slot.path === track.path) return;
      for (const [jx, jz] of junctions) if (Math.hypot(c.group.position.x - jx!, c.group.position.z - jz!) < 4) crossed.add(`${jx},${jz}`);
    });
    assert.ok(inLane / samples >= 0.9, `in lane ${((inLane / samples) * 100).toFixed(1)}%`);
    assert.equal(crossed.size, 4, `junctions crossed: ${[...crossed].join(" ")}`);
  });

  it("when a car comes up on another stopped in its lane, then it stops behind it without touching, and after 8 more seconds has edged round it", () => {
    const scene = new THREE.Scene();
    const [mover, blocker] = cars(2, scene);
    const slot = brain.slotOf(0);
    brain.reset();
    const at = (s: number) => {
      const pt = track.pointAt(s, { x: 0, y: 0, z: 0, tx: 0, tz: 1, half: 0 });
      return { x: pt.x + pt.tz * slot.offset, z: pt.z - pt.tx * slot.offset, yaw: Math.atan2(pt.tx, pt.tz) };
    };
    const a = at(200);
    const b = at(235);
    mover!.spawnFacing(a.x, a.z, a.yaw, brain.speed);
    blocker!.spawnFacing(b.x, b.z, b.yaw, 0);
    let minGap = Infinity;
    let stopped = false;
    run(brain, [mover!, blocker!], 6, (i, c) => {
      if (i !== 0) return;
      const gap = Math.hypot(c.group.position.x - blocker!.group.position.x, c.group.position.z - blocker!.group.position.z);
      minGap = Math.min(minGap, gap);
      if (c.velocity.length() < 0.5) stopped = true;
    }, 1);
    assert.ok(stopped, "came to a stop");
    assert.ok(minGap > 4.6, `kept clear, closest ${minGap.toFixed(2)} m centre to centre`);
    run(brain, [mover!, blocker!], 8, () => {}, 1);
    const p = blankProjection();
    projectPath(track.path, mover!.group.position.x, mover!.group.position.z, -1, p);
    assert.ok(p.s > 240, `got past the blocker (s ${p.s.toFixed(1)})`);
  });

  it("when a put-away traffic car is asked for a spot, then it wakes on its lane inside the observer's spawn ring, at least 14 m from other cars, and gets no spot where the player is looking", () => {
    brain.reset();
    const id = 6;
    const observer = { ...blankAiCar(0), x: 0, z: -30 };
    const others = [observer, { ...blankAiCar(1), x: 2, z: 0 }];
    const spot = brain.spawnPoint(id, [observer], others, () => false);
    assert.ok(spot, "found a spot");
    const d = Math.hypot(spot.x - observer.x, spot.z - observer.z);
    assert.ok(d >= SPAWN_NEAR && d <= SPAWN_FAR, `distance ${d.toFixed(1)}`);
    assert.ok(Math.hypot(spot.x - 2, spot.z) >= 14);
    assert.equal(brain.spawnPoint(id, [observer], others, () => true), null, "never pops in where the player is looking");
  });
});
