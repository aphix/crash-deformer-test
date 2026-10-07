import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applyDrive, type DriveInput } from "./car-drive.ts";
import { DeformableCar } from "./car.ts";
import { assignClass, CLASSES, type VehicleClassId } from "./vehicle-classes.ts";
import { paint } from "./test-support.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";
import { setGround } from "../world/ground.ts";
import { Track, blankPoint, blankProjection, pointOn, type TrackPath } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";

/**
 * Tyres on banked road. Bound 2 cm: a loaded tyre's sidewall squats about that much and the drawn road sits
 * ROAD_LIFT (1.5 cm) over the ground, so a gap inside it can't be seen; the bank's low edge sank tyres 7.8 cm
 * (stunt) where the 1 m ground grid rounded the road's edge into the runoff.
 */
const BOUND = 0.02;
const FRAME = 1 / 60;
const DEG = 180 / Math.PI;

const courses = TRACKS.map((j) => new Track(j));
const stunt = courses.find((t) => t.id === "stunt")!;
/** +1 when the steepest bank's low edge is on the left (lateral > 0): a positive bank lowers the left edge. */
const LOW = Math.sign(stunt.path.bank.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0));

/** The main road's stamped height at (x, z) (`TrackGround.stampPath`: the banked plane, held flat past the edge). */
function roadY(path: TrackPath, s: number, lat: number): number {
  const u = (s / path.length) * path.count;
  const k = Math.floor(u) % path.count;
  const b = (k + 1) % path.count;
  const f = u - Math.floor(u);
  const half = path.half[k]! + (path.half[b]! - path.half[k]!) * f;
  const bank = path.bank[k]! + (path.bank[b]! - path.bank[k]!) * f;
  return path.y[k]! + (path.y[b]! - path.y[k]!) * f - Math.max(-half, Math.min(half, lat)) * Math.tan(bank);
}

/** Tread points (wheel-local; axle along x) on the mesh's tyre crown, `TYRE_PROFILE` in car-materials.ts. */
const TREAD: THREE.Vector3[] = [];
for (let a = 0; a < 48; a++) {
  const t = (a / 48) * Math.PI * 2;
  for (const [r, x] of [[0.32, 0], [0.314, 0.082], [0.314, -0.082], [0.298, 0.104], [0.298, -0.104]] as const) {
    TREAD.push(new THREE.Vector3(x, Math.cos(t) * r, Math.sin(t) * r));
  }
}

/**
 * A `cls` car driven at 25 m/s along lateral `lat(half)` through the main loop's steepest bank (50 m either
 * side); the worst tread clearance (m, negative = sunk) of any drawn tyre on a grounded frame.
 */
function bankRun(track: Track, cls: VehicleClassId, lat: (half: number) => number): { low: number; high: number; at: string } {
  const path = track.path;
  let kMax = 0;
  for (let k = 0; k < path.count; k++) if (Math.abs(path.bank[k]!) > Math.abs(path.bank[kMax]!)) kMax = k;
  const sMax = (kMax / path.count) * path.length;
  const ground = track.ground();
  setGround(ground);
  const car = new DeformableCar(paint(), new THREE.Scene(), null, CLASSES[cls].style);
  assignClass(car, cls);
  const pt = blankPoint();
  const at = (s: number) => {
    pointOn(path, s, pt);
    const l = lat(pt.half);
    return [pt.x + pt.tz * l, pt.z - pt.tx * l] as const;
  };
  pointOn(path, sMax - 50, pt);
  const [x0, z0] = at(sMax - 50);
  car.spawnFacing(x0, z0, Math.atan2(pt.tx, pt.tz), 25);
  car.group.position.y = ground.heightAt(x0, z0, pt.y + 0.5);
  const w = newWorld([car]);
  const proj = blankProjection();
  const input: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
  const p = new THREE.Vector3();
  let low = Infinity;
  let high = -Infinity;
  let where = "";
  let acc = 0;
  for (let n = 0; n < 6 / FRAME; n++) {
    const s = track.project(car.group.position.x, car.group.position.z, proj.k, proj).s;
    if (s > sMax + 50) break;
    const [tx, tz] = at(s + 8 + car.speed * 0.4);
    const err = Math.atan2(tx - car.group.position.x, tz - car.group.position.z) - car.yaw;
    input.steer = Math.max(-1, Math.min(1, 2.5 * Math.atan2(Math.sin(err), Math.cos(err))));
    input.throttle = car.speed < 25 ? 1 : 0;
    input.brake = car.speed > 27 ? 1 : 0;
    acc = Math.min(0.05, acc + FRAME);
    while (acc > 1e-5) {
      const h = physicsSlice(acc, sliceSpeed(w.cars));
      applyDrive(car, input, h);
      stepWorld(w, h);
      acc -= h;
    }
    car.updateSkin();
    assert.equal(car.crashed, false, `${cls} crashed on ${track.id}'s bank`);
    if (car.airborne) continue;
    car.group.updateWorldMatrix(true, true);
    for (const [i, wh] of car.wheels.entries()) {
      let gap = Infinity;
      for (const t of TREAD) {
        p.copy(t).applyMatrix4(wh.matrixWorld);
        gap = Math.min(gap, p.y - ground.heightAt(p.x, p.z, car.group.position.y + 0.5));
      }
      if (gap < low || gap > high) where = `wheel ${i} at s ${s.toFixed(0)} (bank ${(path.bank[proj.k]! * DEG).toFixed(1)}°)`;
      low = Math.min(low, gap);
      high = Math.max(high, gap);
    }
  }
  car.dispose();
  return { low, high, at: where };
}

describe("given every course's banked road, where the ground meets the flat runoff beside it", () => {
  afterEach(() => setGround(null));

  it("when the ground height is read from 1 m inside each road edge to 1 m outside, then it keeps the crease where the bank's tilted plane meets the flat runoff, to within 1 cm on every course", () => {
    const bad: string[] = [];
    for (const track of courses) {
      const path = track.path;
      const ground = track.ground();
      const pt = blankPoint();
      const pr = blankProjection();
      let worst = 0;
      let at = "";
      for (let s = 0; s < path.length; s += 0.5) {
        const k = Math.floor((s / path.length) * path.count) % path.count;
        if (Math.abs(path.bank[k]!) < 1 / DEG) continue;
        if (path.deck[k] || path.deck[(k + 1) % path.count] || path.deck[(k + path.count - 1) % path.count]) continue;
        pointOn(path, s, pt);
        for (const side of [1, -1]) {
          // From 1 m inside the edge to 1 m out (runoff permitting): the 1 m grid's reach either side of the crease.
          for (let l = pt.half - 1; l <= pt.half + Math.min(1, (side > 0 ? path.runL[k]! : path.runR[k]!) - 0.5); l += 0.1) {
            const x = pt.x + pt.tz * side * l;
            const z = pt.z - pt.tx * side * l;
            // The stamp's own frame: the nearest segment's arc length and perpendicular lateral.
            track.project(x, z, k, pr);
            const y = roadY(path, pr.s, pr.lateral);
            const d = ground.heightAt(x, z, y + 0.5) - y;
            if (Math.abs(d) > Math.abs(worst)) {
              worst = d;
              at = `s ${pr.s.toFixed(1)} lateral ${pr.lateral.toFixed(2)} (half ${pt.half.toFixed(1)})`;
            }
          }
        }
      }
      if (Math.abs(worst) > 0.01) bad.push(`${track.id}: ground ${(worst * 100).toFixed(1)} cm off the road at ${at}`);
    }
    assert.deepEqual(bad, []);
  });
});

for (const cls of ["sedan", "monster"] as const) {
  describe(`given a ${cls} driving at 25 m/s through the stunt course's steepest bank`, () => {
    afterEach(() => setGround(null));

    for (const [name, lat] of [
      ["the low edge", (h: number) => (h - 1) * LOW],
      ["the centre", () => 0],
      ["the high edge", (h: number) => -(h - 1) * LOW],
    ] as const) {
      describe(`when it drives along ${name} of the road`, () => {
        it(`then every tyre stays within ${BOUND * 100} cm of the ground`, (t) => {
          const r = bankRun(stunt, cls, lat);
          t.diagnostic(`${cls} ${name}: tread clearance ${(r.low * 100).toFixed(1)}..${(r.high * 100).toFixed(1)} cm, worst ${r.at}`);
          assert.ok(r.low >= -BOUND && r.high <= BOUND, `${cls} on ${name}: ${(r.low * 100).toFixed(1)}..${(r.high * 100).toFixed(1)} cm, worst ${r.at}`);
        });
      });
    }
  });
}
