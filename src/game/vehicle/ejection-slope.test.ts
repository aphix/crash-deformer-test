import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { setGround } from "../world/ground.ts";
import { blankPoint, blankProjection, pointOn, Track } from "../world/track.ts";
import { parseTrack } from "../world/track-schema.ts";
import { TRACKS } from "../world/tracks/index.ts";
import type { DriveInput } from "./car-drive.ts";
import type { ExitPane } from "./car-core.ts";
import { EjectionWatch } from "./ejection.ts";
import { armKill, DEFAULT_REALISM, killClass, VEHICLE_CLASS_IDS, type VehicleClassId } from "./vehicle-classes.ts";
import { frame, makeCar, worldOf } from "./ground-probe.test-util.ts";

/**
 * Owner, 2026-10-03: "drivers are now getting thrown out of their cars when going on that same slope [the stunt course's
 * CRUSH crest] and also on banked turns, far more than would be expected". A car that has been hit once (any contact, even
 * a 2 km/h scrape) is a live lattice of masses (`massActive`); since WheelGround its frame lies on the ground's plane
 * under the hubs while the masses stay, and across a crest (pitch -5 -> +6 deg in 0.4 s) the cabin 0.55 m up read 0.1 m
 * "back" in it: `engineTravel` latched that as crush and the engine died with nothing touching the car, and the
 * ejection watch read the kill as a hit and threw the driver along the normal of a hit 1-60 s old.
 * Here a car takes one light hit (closing 7 m/s, nothing near the block), settles, and is driven over the ground.
 */
const track = (id: string): Track => new Track(TRACKS.find((t) => parseTrack(t).id === id));

type Hit = "side" | "rear" | "front";
/** Where a hit lands (car-local) and the way it pushes in; +z is the car's nose. */
const HITS: Record<Hit, [THREE.Vector3, THREE.Vector3]> = {
  side: [new THREE.Vector3(-0.9, 0.5, -0.5), new THREE.Vector3(0.84, 0, -0.52)],
  rear: [new THREE.Vector3(0, 0.5, -2.2), new THREE.Vector3(0, 0, 1)],
  front: [new THREE.Vector3(0, 0.5, 2.2), new THREE.Vector3(0, 0, -1)],
};

type Run = {
  /** The block's travel (m) the moment the car reached `s0`, 1+ s after its hit. */
  settled: number;
  /** ... and at the end. */
  end: number;
  alive: boolean;
  thrown: ExitPane[];
  /** Where along the course the run ended. */
  endS: number;
};

/**
 * A fleet car hit once at 0.5 s (a pair of AI cars gave each other 7 m/s closing), driven down `trk`'s main loop from
 * 60 m before `s0` at `pace` m/s to `s1`, the edge-triggered ejection watch running as in a race. `touch` = [from, to]:
 * something brushes the car every frame while it is between those two distances along the course (`notifyContact`,
 * the call the contact pass makes for every touching slice), with no force on it.
 */
function crashedRun(trk: Track, cls: VehicleClassId, pace: number, hit: Hit, s0: number, s1: number, touch?: readonly [number, number]): Run {
  const ground = trk.ground();
  setGround(ground);
  const car = makeCar(cls);
  armKill(car.deform, killClass(car), DEFAULT_REALISM, "default");
  const pt = blankPoint();
  const at = (s: number) => {
    pointOn(trk.path, s, pt);
    return [pt.x, pt.z] as const;
  };
  const [x0, z0] = at(s0 - 60);
  car.spawnFacing(x0, z0, Math.atan2(pt.tx, pt.tz), pace);
  car.group.position.y = ground.heightAt(x0, z0, pt.y + 0.5);
  const w = worldOf(car);
  const watch = new EjectionWatch();
  w.ejection = watch;
  const st = { acc: 0 };
  const proj = blankProjection();
  const input: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
  const thrown: ExitPane[] = [];
  const wp = new THREE.Vector3();
  const wi = new THREE.Vector3();
  let settled = NaN;
  let s = s0 - 60;
  for (let n = 0; n < 60 * 60; n++) {
    const p = car.group.position;
    s = trk.project(p.x, p.z, proj.k, proj).s;
    if (s > s1 && s < s1 + 100) break;
    if (n === 30) {
      car.group.updateWorldMatrix(true, false);
      wp.copy(HITS[hit][0]).applyMatrix4(car.group.matrixWorld);
      wi.copy(HITS[hit][1]).applyQuaternion(car.group.quaternion);
      car.applyImpact(wp, wi, 7, 3.5);
    }
    if (Number.isNaN(settled) && s >= s0) settled = car.deform.engineTravel;
    const [tx, tz] = at(s + 8 + car.speed * 0.4);
    const err = Math.atan2(tx - p.x, tz - p.z) - car.yaw;
    input.steer = Math.max(-1, Math.min(1, 2.5 * Math.atan2(Math.sin(err), Math.cos(err))));
    input.throttle = car.speed < pace ? 1 : 0;
    input.brake = car.speed > pace + 2 ? 1 : 0;
    if (touch && s >= touch[0] && s <= touch[1]) car.deform.notifyContact();
    frame(w, input, st);
    for (const e of watch.take()) thrown.push(e.exit);
  }
  const run = { settled, end: car.deform.engineTravel, alive: car.deform.drivetrainAlive, thrown, endS: s };
  car.dispose();
  return run;
}

/** The most the block may move over ground with nothing touching the car (m): the noise of the lattice settling. */
const DRIFT = 0.005;

describe("a car that was hit once and drives on is not killed, and its driver not thrown, by the ground", () => {
  afterEach(() => setGround(null));

  const stunt = track("stunt");
  for (const cls of VEHICLE_CLASS_IDS) {
    for (const pace of [20, 30, 38]) {
      it(`bad: ${cls}, hit on its flank, over the stunt CRUSH crest and down the kicker at ${pace} m/s: the engine block stays put, nobody is thrown`, (t) => {
        const r = crashedRun(stunt, cls, pace, "side", 860, 960);
        t.diagnostic(`${cls} ${pace} m/s: block travel ${(r.settled * 1000).toFixed(1)} -> ${(r.end * 1000).toFixed(1)} mm, ended at s ${r.endS.toFixed(0)}`);
        assert.ok(r.endS > 950, `the run reached s ${r.endS.toFixed(0)}`);
        assert.ok(r.end - r.settled <= DRIFT, `the block moved ${((r.end - r.settled) * 1000).toFixed(0)} mm with nothing touching the car`);
        assert.ok(r.alive, "the engine died");
        assert.deepEqual(r.thrown, []);
      });
    }
  }

  // Owner/EjectFalse: "a car hit once earlier, touched at the stunt CRUSH crest, gains 0.08-0.12 m phantom engine-block
  // travel" (drivetrainHealth, handling, HUD damage). A planted wreck's frame sits on its hubs' mean, the cell 0.05-0.09 m
  // off it, and a touch moves the anchor back to the cell: the block, read in that frame, moved by the cell's offset, and
  // touched every frame over s 885-902 it added 62-66 mm (15 of 15 cases, main 9e1250e). `updateDrivetrain` now reads a
  // side or rear hit's block against the cabin and only while the frame sits on it (to PLANT_QUIET): the touch adds none.
  for (const cls of VEHICLE_CLASS_IDS) {
    for (const pace of [20, 30, 38]) {
      it(`bad: ${cls}, hit on its flank, then touched all the way over the stunt CRUSH crest (s 885-902) at ${pace} m/s: the touch adds under 5 mm of block travel`, (t) => {
        const r = crashedRun(stunt, cls, pace, "side", 860, 960, [885, 902]);
        t.diagnostic(`${cls} ${pace} m/s: block travel ${(r.settled * 1000).toFixed(1)} -> ${(r.end * 1000).toFixed(1)} mm`);
        assert.ok(r.endS > 950, `the run reached s ${r.endS.toFixed(0)}`);
        assert.ok(r.end - r.settled <= DRIFT, `the touch moved the block ${((r.end - r.settled) * 1000).toFixed(1)} mm`);
        assert.ok(r.alive, "the engine died");
      });
    }
  }

  for (const hit of ["rear", "front"] as const) {
    for (const cls of ["sedan", "truck"] as const) {
      it(`bad: ${cls}, hit on its ${hit}, over the crest at 30 m/s: the engine block stays put, nobody is thrown`, () => {
        const r = crashedRun(stunt, cls, 30, hit, 860, 960);
        assert.ok(r.end - r.settled <= DRIFT, `the block moved ${((r.end - r.settled) * 1000).toFixed(0)} mm with nothing touching the car`);
        assert.ok(r.alive, "the engine died");
        assert.deepEqual(r.thrown, []);
      });
    }
  }

  // Every course's whole loop: the stunt bowl (banks to 15 deg) and crest, the oval's banks, the rally hairpin and its climbs.
  for (const course of TRACKS.map((j) => parseTrack(j).id).filter((id) => id !== "city")) {
    for (const pace of [25, 32]) {
      it(`bad: ${course}, a damaged sedan round the whole loop at ${pace} m/s (banks, crests, climbs): the engine block stays put, nobody is thrown`, (t) => {
        const trk = track(course);
        const r = crashedRun(trk, "sedan", pace, "side", 60, trk.length - 30);
        t.diagnostic(`${course} ${pace} m/s: block travel ${(r.settled * 1000).toFixed(1)} -> ${(r.end * 1000).toFixed(1)} mm, ended at s ${r.endS.toFixed(0)} of ${trk.length.toFixed(0)}`);
        assert.ok(r.end - r.settled <= DRIFT, `the block moved ${((r.end - r.settled) * 1000).toFixed(0)} mm with nothing touching the car`);
        assert.ok(r.alive, "the engine died");
        assert.deepEqual(r.thrown, []);
      });
    }
  }
});
