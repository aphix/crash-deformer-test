import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { launch } from "../contact/crash-scenarios.test-util.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { newWorld, settleStep, stepWorld } from "../engine/world-step.ts";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { MU_BODY } from "../vehicle/car-air.ts";
import { EjectionWatch } from "../vehicle/ejection.ts";
import { activeGround, Ground, NO_FLOOR, setGround } from "./ground.ts";
import { makeWorld as raceWorld } from "./race-world.test-util.ts";
import { armedCar } from "./solid-parity.test-util.ts";
import { C_H, C_NY, HIT_SIZE, pointContact, PQ_SIZE, PQ_X, PQ_Y, PQ_Z } from "./surfaces.ts";
import { blankPoint, Track } from "./track.ts";
import { parseTrack } from "./track-schema.ts";
import { OFF_MENU, TRACKS } from "./tracks/index.ts";

/**
 * Owner, 2026-10-08: "a driver should be able to drive on a box prop, a jersey barrier, a ramp, or a roof, all the same". The
 * terrain is the same solid to a car as a box prop: a cut face stops a car driven square into it, a slope it can climb is a ramp.
 * Dam-spine has cut faces beside its road (2.5 to 4 m high within a metre or two, normal up component ny 0.24 to 0.38 where the
 * course is read at 0.5 m: 34 of 211 000 cells under 0.5) and 52 degree flanks (ny 0.58 to 0.66) leading down to them.
 *
 * Where the line falls between them is the body's friction, `MU_BODY`. A point mass sliding horizontally at v into a face whose
 * normal has the horizontal share nh = sqrt(1 - ny^2) loses v nh along the normal and keeps v ny along the face; Coulomb friction
 * takes at most MU_BODY v nh of that, so it stops dead while ny <= MU_BODY / sqrt(1 + MU_BODY^2) (ny 0.51). A car is not a point mass:
 * the contact sits on the nose, a lever r from the centre of mass, and the same Coulomb law answers in impulses. The normal impulse
 * is jn = v nh / kn and the tangential one needed to stop the slide jt = v ny / kt, each over the contact's effective inverse mass
 * k = 1 + I (r x dir)^2 (I the body's inverse inertia per unit mass about the pitch axis). The nose stops dead while
 * MU_BODY nh / kn >= ny / kt, that is ny / nh <= MU_BODY kt / kn: the sedan's lever (2.0 m forward, 0.52 m down, I 0.56) makes kt
 * 3.2 against kn 1.5 and the limit ny 0.71, not 0.51. Measured on this tree the sedan at 12 m/s stops at every face up to ny 0.66
 * and rides onto a ny 0.72 one (the point-mass limit's ny 0.58 flank sticks: -1.94 m past the foot, 0.33 m up). The hull rows and
 * the tyres' footprint answer a terrain cell by this one law (the tyre's `STEP_MAX` makes a higher face a wall to it), so the
 * terrain needs no side rule of its own. `.bench/uc2/cliff.ts`, which found the sedan climbing 5 to 9 m, launched it horizontally off
 * the top of the flank: it flew.
 * Mutation: body friction 0 in `stepFree` (both caps) fails the ny 0.30, 0.40 and 0.50 faces (the sedan rides 4 to 9 m up them).
 */

const SPEED = 12;
/** How far (m) the sedan starts from the foot, on level ground the whole way, so it arrives at its launch speed. */
const RUN_UP = 8;
/** The face rises this much (m): what dam-spine's cut faces rise within 3 m, at least. */
const HEIGHT = 2.7;
/** The normal's up component below which friction stops a sliding point mass dead (derived above). */
const POINT_STOPS_BELOW = MU_BODY / Math.sqrt(1 + MU_BODY * MU_BODY);
/** The sedan's nose lever from its centre of mass (m, forward and up: the belly's front row) and its inverse inertia about the pitch axis. */
const LEVER = { x: 2.0, y: -0.52 };
const INV_I_PITCH = 3 / (CAR_HALF.y ** 2 + CAR_HALF.z ** 2);
/** The normal's up component below which the nose's friction stops the sedan dead: ny / nh = MU_BODY kt / kn, solved by bisection. */
function stopsBelow(): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const ny = (lo + hi) / 2;
    const nh = Math.sqrt(1 - ny * ny);
    const kn = 1 + INV_I_PITCH * (LEVER.x * ny - LEVER.y * -nh) ** 2;
    const kt = 1 + INV_I_PITCH * (LEVER.x * nh - LEVER.y * ny) ** 2;
    if (ny / nh < (MU_BODY * kt) / kn) lo = ny;
    else hi = ny;
  }
  return lo;
}
const STOPS_BELOW = stopsBelow();
/** Faces spread across what stops it (the measured cut faces 0.24 to 0.38, and one just under the point-mass limit), and a flank over the nose's. */
const STOPPING_NY = [0.2, 0.3, 0.4, 0.97 * POINT_STOPS_BELOW] as const;
const FLANK_NY = 1.13 * STOPS_BELOW;
/** The origin may reach the foot no further than this (m), and rise over its height at the first touch no more than this (m). */
const PAST_FOOT = 0.5;
const CLIMB = 0.5;
const COURSE = "dam-spine";

/** A flat plain with a face on it: from the foot at x = 0 it rises `HEIGHT` over the run its normal's `ny` gives, then a level top. */
class FaceGround extends Ground {
  readonly run: number;
  constructor(ny: number) {
    super();
    this.run = HEIGHT / (Math.sqrt(1 - ny * ny) / ny);
    this.addPlane(0, -500, 500, -500, 500, Infinity);
    this.addFace(0, -50, 0, this.run, 100, 0, HEIGHT, 0, HEIGHT, 50);
    this.addFace(this.run, -50, 0, 500, 100, HEIGHT, HEIGHT, HEIGHT, HEIGHT, 50);
  }
}

/** Drives a sedan at the `ny` face from its run-up: how far past the foot its origin got (m), how far it rose over its height at the first touch (m), its highest (m), and whether it met the face. */
function driveAt(ny: number): { past: number; climb: number; top: number; met: boolean } {
  setGround(new FaceGround(ny));
  const car = armedCar("sedan");
  const world = newWorld([car]);
  world.ejection = new EjectionWatch();
  launch(car, -RUN_UP, 0, Math.atan2(1, 0), SPEED, 0);
  let accumulated = 0;
  let past = -Infinity;
  let metY = NaN;
  let top = -Infinity;
  let rose = -Infinity;
  for (let frame = 0; frame < 180; frame++) {
    const fastest = sliceSpeed(world.cars);
    accumulated = Math.min(0.05, accumulated + 1 / 60);
    for (let steps = 0; accumulated > 1e-5 && steps < 8; steps++) {
      const h = Math.fround(physicsSlice(accumulated, fastest));
      stepWorld(world, h);
      settleStep(world.cars, h, false);
      accumulated -= h;
    }
    const p = car.group.position;
    if (Number.isNaN(metY) && car.velocity.length() < SPEED * 0.8) metY = p.y;
    if (!Number.isNaN(metY)) rose = Math.max(rose, p.y);
    top = Math.max(top, p.y);
    past = Math.max(past, p.x);
  }
  setGround(null);
  return { past, climb: rose - metY, top, met: !Number.isNaN(metY) };
}

after(() => setGround(null));

describe(`given a face rising ${HEIGHT} m on level ground, the body friction's limit ny ${STOPS_BELOW.toFixed(3)}`, () => {
  for (const ny of STOPPING_NY) {
    it(`when a sedan drives square into the ny ${ny.toFixed(2)} face at ${SPEED} m/s, then the face stops it: its origin never reaches the foot (${PAST_FOOT} m) and never rises over its height at the touch by more than ${CLIMB} m`, () => {
      const r = driveAt(ny);
      const at = `${r.past.toFixed(2)} m past the foot, rose ${r.climb.toFixed(2)} m, highest ${r.top.toFixed(2)} m`;
      assert.ok(r.met, `never met the face: ${at}`);
      assert.ok(r.past <= PAST_FOOT, at);
      assert.ok(r.climb <= CLIMB, at);
    });
  }

  it(`when it drives into the ny ${FLANK_NY.toFixed(2)} flank at ${SPEED} m/s, then it is a ramp: the origin rides up it onto the top`, () => {
    const r = driveAt(FLANK_NY);
    const run = new FaceGround(FLANK_NY).run;
    assert.ok(r.past > run && r.top >= HEIGHT, `${r.past.toFixed(2)} m past the foot (the flank is ${run.toFixed(2)} m), highest ${r.top.toFixed(2)} m`);
    setGround(null);
  });
});

describe(`given the terrain of ${COURSE}`, () => {
  const q = new Float64Array(PQ_SIZE);
  const hit = new Float64Array(HIT_SIZE);
  let cells = 0;
  let steepest = Infinity;
  let cuts = 0;
  let flanks = 0;

  before(() => {
    raceWorld().race.showLobby(COURSE);
    const track = new Track([...TRACKS, ...OFF_MENU].find((j) => parseTrack(j).id === COURSE));
    const ground = activeGround();
    const point = blankPoint();
    // Every 0.5 m of lateral lines out from the road, as far as a car could drive: the terrain's own cells, their normals read from above.
    for (let s = 0; s < track.length; s += 3) {
      track.pointAt(s, point);
      for (const side of [-1, 1]) {
        for (let d = 5; d <= 40; d += 0.5) {
          const x = point.x + point.tz * side * d;
          const z = point.z - point.tx * side * d;
          const h = ground.heightAt(x, z, 1e9);
          if (h === NO_FLOOR) continue;
          q[PQ_X] = x;
          q[PQ_Z] = z;
          q[PQ_Y] = h + 1;
          pointContact(q, -1, hit);
          if (Math.abs(hit[C_H]! - h) > 1e-3) continue;
          const ny = hit[C_NY]!;
          cells++;
          steepest = Math.min(steepest, ny);
          if (ny < POINT_STOPS_BELOW) cuts++;
          else if (ny > 0.55 && ny < 0.7) flanks++;
        }
      }
    }
  });

  it("when its cells are read, then it has cut faces the sedan above is stopped by (the steepest under the lowest face tried) and flanks of the ramp's kind", () => {
    assert.ok(cells > 100000, `${cells} cells read`);
    assert.ok(cuts >= 10 && steepest <= STOPPING_NY[0], `${cuts} cells under ny ${POINT_STOPS_BELOW.toFixed(2)}, the steepest ny ${steepest.toFixed(2)}`);
    assert.ok(flanks >= 1000, `${flanks} flank cells (ny 0.55 to 0.7)`);
  });
});
