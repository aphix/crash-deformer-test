import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applyDrive, idleDrive } from "../car-drive.ts";
import { DeformableCar } from "../car.ts";
import { blankAiCar, type AiCar } from "../derby-ai.ts";
import { snapshotAiCar } from "../derby.ts";
import { fleetStyle } from "../fleet.ts";
import { SURFACE_IDS, SURFACES } from "./catalog.ts";
import { onSurface } from "./race-ai.ts";
import { Track, blankProjection, projectPath } from "./track.ts";
import { TrafficBrain } from "./traffic.ts";
import city from "./tracks/city.json" with { type: "json" };

const DT = 1 / 60;
const track = new Track(city);

function cars(n: number, scene: THREE.Scene): DeformableCar[] {
  return Array.from({ length: n }, (_, i) => new DeformableCar({ body: 0x808080, accent: 0x404040, name: `t${i}` }, scene, null, fleetStyle(i)));
}

/** Drive `fleet` with `brain` for `seconds`; `sample(i, car)` every 6th step. */
function run(brain: TrafficBrain, fleet: DeformableCar[], seconds: number, sample: (i: number, c: DeformableCar) => void, frozen = -1): void {
  const ground = track.ground();
  const snaps: AiCar[] = fleet.map((_, i) => blankAiCar(i));
  const scratch = idleDrive();
  const park = { ...idleDrive(), brake: 1 };
  for (let step = 0; step < seconds / DT; step++) {
    fleet.forEach((c, i) => snapshotAiCar(snaps[i]!, i, c.group.position.x, c.group.position.z, c.yaw, c.velocity.x, c.velocity.z, true, c.deform.masses));
    fleet.forEach((c, i) => {
      const surf = SURFACES[SURFACE_IDS[ground.surfaceIndex(c.group.position.x, c.group.position.z)]!];
      applyDrive(c, onSurface(i === frozen ? park : brain.think(snaps[i]!, snaps, DT), surf, scratch), DT);
      c.integrate(DT);
    });
    if (step % 6 === 0) fleet.forEach((c, i) => sample(i, c));
  }
}

describe("traffic", () => {
  it("spawns spread round the loop in their lanes, facing their lane's way, clear of the grid", () => {
    const brain = new TrafficBrain(track, 0);
    const spots = brain.spawns(8);
    const p = blankProjection();
    spots.forEach((s, i) => {
      projectPath(track.path, s.x, s.z, -1, p);
      const lane = brain.laneOf(i);
      assert.ok(Math.abs(p.lateral - lane.offset) < 0.2, `car ${i} lateral ${p.lateral.toFixed(2)} vs lane ${lane.offset}`);
      const along = Math.sin(s.yaw) * track.path.tx[p.k]! + Math.cos(s.yaw) * track.path.tz[p.k]!;
      assert.ok(along * lane.dir > 0.95, `car ${i} faces its lane direction`);
      assert.ok(p.s > 50 && p.s < track.length - 50, `car ${i} on the grid (s ${p.s.toFixed(0)})`);
    });
    assert.ok(brain.laneOf(1).dir === -1 && brain.laneOf(0).dir === 1, "both directions are used");
  });

  it("8 cars cruise their lanes for a minute: in lane, moving, oncoming lane against the race", () => {
    const scene = new THREE.Scene();
    const brain = new TrafficBrain(track, 0);
    const fleet = cars(8, scene);
    brain.spawns(8).forEach((s, i) => fleet[i]!.spawnFacing(s.x, s.z, s.yaw, 0));
    const p = blankProjection();
    let inLane = 0;
    let samples = 0;
    let along = 0;
    run(brain, fleet, 60, (i, c) => {
      projectPath(track.path, c.group.position.x, c.group.position.z, -1, p);
      const lane = brain.laneOf(i);
      samples++;
      if (Math.abs(p.lateral - lane.offset) < 1.5) inLane++;
      along += ((c.velocity.x * track.path.tx[p.k]! + c.velocity.z * track.path.tz[p.k]!) * lane.dir) / brain.speed;
    });
    assert.ok(inLane / samples >= 0.95, `in lane ${((inLane / samples) * 100).toFixed(1)}%`);
    assert.ok(along / samples > 0.6, `mean speed along the lane ${(along / samples).toFixed(2)} of cruise`);
  });

  it("stops behind a car stopped in its lane, then edges round it", () => {
    const scene = new THREE.Scene();
    const brain = new TrafficBrain(track, 0);
    const [mover, blocker] = cars(2, scene);
    // Both in lane 0 (race direction, right side) on the start avenue.
    const lane = brain.laneOf(0);
    const at = (s: number) => {
      const pt = track.pointAt(s, { x: 0, y: 0, z: 0, tx: 0, tz: 1, half: 0 });
      return { x: pt.x + pt.tz * lane.offset, z: pt.z - pt.tx * lane.offset, yaw: Math.atan2(pt.tx, pt.tz) };
    };
    const a = at(5);
    const b = at(40);
    mover!.spawnFacing(a.x, a.z, a.yaw, brain.speed);
    blocker!.spawnFacing(b.x, b.z, b.yaw, 0);
    // Car 1 stays parked (frozen) in car 0's lane.
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
    assert.ok(p.s > 40, `got past the blocker (s ${p.s.toFixed(1)})`);
  });
});
