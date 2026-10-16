import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FREEWHEEL, launch, makeCar, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { CONTACT_WINDOW } from "../deform/constants.ts";
import { CRASH, FRICTION_G } from "../deform/physics-util.ts";
import { FRAME_HZ } from "../kernel/constants.ts";
import type { DeformableCar } from "./car.ts";

// A struck car's tyres give the sliding friction of a locked tyre while it is in contact, and their arcade grip comes back over the contact window
// after it (`DeformSolve.settledShare`), not in one slice: the hit's sideways exchange is the contact's, whether the engine runs or the fuel is cut.

const FRAME = 1 / FRAME_HZ;
/** The bullet's speed (km/h) that leaves the struck car's engine running (under the crash sensor), and one that cuts its fuel. */
const BULLET_KPH = { running: 49, stalled: 55 } as const;
/** The sliding grip a tyre on flat asphalt gives (m/s²). */
const SLIDING_GRIP = CRASH.muSlide * FRICTION_G;
/** What the drive's speed change per second may exceed the sliding grip by: the freewheel's rolling resistance and air drag (`Surface.roll`, `DRIVE.drag`). */
const ROLLING_ALLOWANCE = 1.1;
/** Sideways speed (m/s) under which a slice says nothing of the tyres' grip: it would be cancelled whole in the slice. */
const SIDEWAYS_FLOOR = 1;
/** Seconds of the hit followed. */
const WATCH_S = 0.8;
/** The most the drive's sideways pull may rise between two slices after the contact, as a share of the climb from the sliding grip to the arcade grip: the grip comes back over the window, where a switch at its close climbs the whole of it at once. */
const MOST_RISE_SHARE = 0.25;

type Slice = { acceleration: number; quiet: number; windowOpen: boolean };

/** The struck sedan of a t-bone at `bulletKph`, at rest on its start, in neutral: the drive's speed change per second in each slice, and whether the contact window was open. */
function driveSlices(bulletKph: number): { slices: Slice[]; struck: DeformableCar; massesCommonShare: number } {
  const struck = makeCar();
  const bullet = makeCar();
  launch(struck, 0, 0, 0, 0, 0);
  launch(bullet, 6, 0, -Math.PI / 2, -bulletKph / 3.6, 0);
  const world = makeWorld([struck, bullet], false, false, FREEWHEEL);
  const stepSlice = world.world.beforeSlice!;
  const slices: Slice[] = [];
  const common = bulletKph / 3.6 / 2;
  let massesCommonShare = 0;
  world.world.beforeSlice = (h) => {
    const windowOpen = struck.crashed && struck.deform.massActive && struck.deform.live();
    const quiet = struck.deform.massActive ? struck.deform.quietTime() : Infinity;
    const vx = struck.velocity.x;
    const vz = struck.velocity.z;
    const sideways = Math.abs(vx * struck.fwdFlat.z - vz * struck.fwdFlat.x);
    const out = stepSlice(h);
    const accelerationX = (struck.velocity.x - vx) / h;
    const accelerationZ = (struck.velocity.z - vz) / h;
    if (struck.crashed && sideways > SIDEWAYS_FLOOR) slices.push({ acceleration: Math.hypot(accelerationX, accelerationZ), quiet, windowOpen });
    let momentum = 0;
    let mass = 0;
    for (const q of struck.deform.masses) {
      momentum += q.vel.x * q.mass;
      mass += q.mass;
    }
    massesCommonShare = Math.max(massesCommonShare, Math.abs(momentum / mass) / common);
    return out;
  };
  for (let t = 0; t < WATCH_S; t += FRAME) tickWorld(world);
  return { slices, struck, massesCommonShare };
}

for (const [engine, kph] of Object.entries(BULLET_KPH)) {
  describe(`given a sedan at rest t-boned at its right door by a bullet at ${kph} km/h (its engine ${engine === "running" ? "keeps running" : "is cut by the side hit"})`, () => {
    const { slices, struck, massesCommonShare } = driveSlices(kph);

    it(`when it is in contact, then the drive takes no more sideways speed per second than a sliding tyre's grip and the fade's share of one frame`, () => {
      assert.equal(struck.stalledS > 0, engine === "stalled", "the engine is cut as staged");
      // The contact clock moves once a frame: a car touched this frame reads under one frame of quiet, so the grip's return may have begun by that frame's share.
      const touching = slices.filter((slice) => slice.quiet < FRAME);
      assert.ok(touching.length > 10, `${touching.length} slices in contact with the car sliding sideways`);
      const best = Math.max(...slices.map((slice) => slice.acceleration));
      const bar = ROLLING_ALLOWANCE * SLIDING_GRIP + (best - SLIDING_GRIP) * (FRAME / CONTACT_WINDOW);
      const worst = Math.max(...touching.map((slice) => slice.acceleration));
      assert.ok(worst <= bar, `${worst.toFixed(1)} m/s² against the sliding grip ${SLIDING_GRIP.toFixed(1)} (bar ${bar.toFixed(1)})`);
    });

    it(`when the contact has ended, then the tyres' grip comes back over the contact window, never in one slice`, () => {
      const after = slices.filter((slice) => slice.quiet >= FRAME);
      const best = Math.max(...after.map((slice) => slice.acceleration));
      let rise = 0;
      for (let i = 1; i < after.length; i++) rise = Math.max(rise, after[i]!.acceleration - after[i - 1]!.acceleration);
      assert.ok(rise <= MOST_RISE_SHARE * (best - SLIDING_GRIP), `rose ${rise.toFixed(1)} m/s² in one slice, of a climb of ${(best - SLIDING_GRIP).toFixed(1)}`);
    });

    it(`when its contact window has closed, then the tyres give their arcade grip again, at least twice the sliding grip`, () => {
      const closed = slices.filter((slice) => !slice.windowOpen);
      assert.ok(closed.length > 10, `${closed.length} slices with the window closed and the car sliding sideways`);
      const best = Math.max(...closed.map((slice) => slice.acceleration));
      assert.ok(best >= 2 * SLIDING_GRIP, `${best.toFixed(1)} m/s² against twice the sliding grip ${(2 * SLIDING_GRIP).toFixed(1)}`);
    });

    it(`when the hit's exchange is made, then the struck car's masses reach 90 % of the pair's common speed`, () => {
      assert.ok(massesCommonShare >= 0.9, `${(massesCommonShare * 100).toFixed(0)} % of the common speed`);
    });
  });
}
