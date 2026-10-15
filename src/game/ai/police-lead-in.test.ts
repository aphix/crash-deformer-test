import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { snapshotAiCar } from "../match/derby.ts";
import { SURFACES } from "../world/catalog.ts";
import { setGround } from "../world/ground.ts";
import { blankPoint, blankProjection } from "../world/track.ts";
import { applyDrive, idleDrive } from "../vehicle/car-drive.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { fleetStyle } from "../scenes/fleet.ts";
import { onSurface } from "./race-ai.ts";
import { BEAT, rig, track } from "./police-rig.test-util.ts";
import { FRAME_HZ } from "../kernel/constants.ts";

const DT = 1 / FRAME_HZ;
/** The racer's speed past the stakeout (m/s): the long fast courses' pace. */
const RACER_SPEED = 50;
/** Seconds run from the first cop's wake: the lead-in (1.8 s) and a beat past it. */
const SECONDS = 3;
/** How far apart (m) the stakeout pair stands: one cop's nose at the other's. */
const PAIR_GAP = 12;
/** A car's half length and half width (m): the footprint two cops must not overlap. */
const HALF_LENGTH = 2.3;
const HALF_WIDTH = 0.95;

/** Where along the lap the stakeout stands (shares of its length): the oval's near straight and its far one. */
const SHARES = [0.4, 0.7];

type Footprint = { x: number; z: number; yaw: number };

const footprintOf = (car: DeformableCar): Footprint => ({ x: car.group.position.x, z: car.group.position.z, yaw: car.yaw });

/** Whether two car footprints overlap, by the separating axes of the two rectangles. */
function overlaps(a: Footprint, b: Footprint): boolean {
  for (const f of [a, b]) {
    const axes = [
      [Math.sin(f.yaw), Math.cos(f.yaw)],
      [Math.cos(f.yaw), -Math.sin(f.yaw)],
    ] as const;
    for (const [ax, az] of axes) {
      const reach = (c: Footprint) => HALF_LENGTH * Math.abs(Math.sin(c.yaw) * ax + Math.cos(c.yaw) * az) + HALF_WIDTH * Math.abs(Math.cos(c.yaw) * ax - Math.sin(c.yaw) * az);
      if (Math.abs((b.x - a.x) * ax + (b.z - a.z) * az) > reach(a) + reach(b)) return false;
    }
  }
  return true;
}

/** The pair's run: which cops woke, the cops that pulled away without the racer past their spot, and the frames the two footprints overlapped. */
function runPair(leadShare: number): { pulled: boolean[]; bad: string[]; touched: string[]; closest: number } {
  const r = rig(2, 1, leadShare);
  const ground = track.ground();
  setGround(ground);
  try {
    const scene = new THREE.Scene();
    const fleet = [0, 1, 2].map((i) => new DeformableCar({ body: 0x808080, accent: 0x404040, name: `car${i}` }, scene, null, fleetStyle(i)));
    const proj = blankProjection();
    const pt = blankPoint();
    // The pair as the sweeps found it: the second cop stands ${PAIR_GAP} m on from the first along the road, in its lane, facing it (the first faces the way the racers go).
    const first = track.project(r.cars[1]!.x, r.cars[1]!.z, -1, proj);
    const lateral = first.lateral;
    const stand = (id: number, s: number, turn: number) => {
      const q = track.pointAt(s, pt);
      Object.assign(r.cars[id]!, { x: q.x + q.tz * lateral, z: q.z - q.tx * lateral, yaw: Math.atan2(q.tx, q.tz) + turn });
    };
    stand(1, first.s, 0);
    stand(2, first.s + PAIR_GAP, Math.PI);
    for (const [i, car] of fleet.entries()) car.spawnFacing(r.cars[i]!.x, r.cars[i]!.z, r.cars[i]!.yaw, 0);
    const spotS = [1, 2].map((i) => track.project(r.cars[i]!.x, r.cars[i]!.z, -1, proj).s);
    const racerS0 = track.project(r.cars[0]!.x, r.cars[0]!.z, -1, proj).s;
    const park = { ...idleDrive(), brake: 1 };
    const scratch = idleDrive();
    const pulled = [false, false];
    const touched: string[] = [];
    const bad: string[] = [];
    let closest = Infinity;
    for (let f = 0; f < SECONDS / DT; f++) {
      const p = track.pointAt((racerS0 + RACER_SPEED * f * DT) % track.length, pt);
      fleet[0]!.spawnFacing(p.x, p.z, Math.atan2(p.tx, p.tz), RACER_SPEED);
      for (const [i, car] of fleet.entries()) snapshotAiCar(r.cars[i]!, i, car, true);
      if (f % Math.round(BEAT / DT) === 0) r.beat();
      for (const id of [1, 2]) {
        const car = fleet[id]!;
        const driving = r.police.drives(id);
        if (driving && !pulled[id - 1]) {
          pulled[id - 1] = true;
          const ahead = track.project(fleet[0]!.group.position.x, fleet[0]!.group.position.z, -1, proj).s - spotS[id - 1]!;
          if (ahead < 0) bad.push(`cop ${id} pulled away at ${(f * DT).toFixed(2)} s with the racer ${(-ahead).toFixed(0)} m short of its spot`);
        }
        const input = driving ? r.police.think(r.cars[id]!, r.cars, DT) : park;
        const surf = SURFACES[ground.surfaceAt(car.group.position.x, car.group.position.z)];
        applyDrive(car, onSurface(input, surf, scratch), DT);
        car.integrate(DT);
      }
      closest = Math.min(closest, fleet[1]!.group.position.distanceTo(fleet[2]!.group.position));
      if (overlaps(footprintOf(fleet[1]!), footprintOf(fleet[2]!))) touched.push(`${(f * DT).toFixed(2)} s`);
    }
    return { pulled, bad, touched, closest };
  } finally {
    setGround(null);
  }
}

describe("given a stakeout pair of cops standing 12 m apart in one lane of the oval, nose to nose, and a racer passing them at 50 m/s", () => {
  for (const share of SHARES) {
    it(`when the racer passes the stakeout ${share} of the lap on and the cops wake into their lead-ins, then no two cops touch, and each cop that pulls away has the racer past its spot`, (t) => {
      const r = runPair(share);
      t.diagnostic(`closest ${r.closest.toFixed(1)} m`);
      assert.ok(r.pulled[0] && r.pulled[1], `both cops woke (cop 1 ${r.pulled[0]}, cop 2 ${r.pulled[1]}): the test proves nothing`);
      assert.deepEqual(r.bad, []);
      assert.deepEqual(r.touched, [], "frames in which the two cops' footprints overlapped");
    });
  }
});
