import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { frame, makeWorld } from "./race-world.test-util.ts";
import { placeProps, propColliders } from "./placements.ts";
import { Track } from "./track.ts";
import oval from "./tracks/oval.json" with { type: "json" };
import { SimPacer } from "../engine/sim-pace.ts";

/**
 * Owner, 2026-10-05: "something seems much less likely to crush and eject correctly at higher speeds". A device whose 1/240 s
 * steps do not fit the frame steps at 1/120 s (`SimPacer`, adaptive), and a hit that falls between two steps of 0.46 m of
 * travel at 55 m/s decided the crash: the same hit into the same wall killed the engine at one approach phase and spared it at
 * another (engine block 0.274 m to 0.484 m, the kill at 0.45 m). The whole stack headless (`race-world.test-util.ts`) with the
 * engine's own pacer holding each floor: a lone sedan, gas held, into the oval's straight wall.
 */
const track = new Track(oval);
const colliders = propColliders(placeProps(track));

type Wall = { fx: number; fz: number; ox: number; oz: number; run: number };

/** The oval's longest straight left wall with no prop within 4 m of a car crossing the road to it: its face point, the unit toward it and the run across the road. */
function straightWall(): Wall {
  const p = track.path;
  let best: Wall | null = null;
  for (let k = 0; k < p.count; k++) {
    let straight = true;
    for (let j = -12; j <= 12 && straight; j++) {
      const a = (k + j + p.count) % p.count;
      if (!p.wallL[a] || Math.abs(p.tx[k]! * p.tz[a]! - p.tz[k]! * p.tx[a]!) > 0.01) straight = false;
    }
    if (!straight) continue;
    const limit = p.half[k]! + p.runL[k]!;
    const run = limit + p.half[k]! + p.runR[k]! - 1.5;
    const ox = p.tz[k]!;
    const oz = -p.tx[k]!;
    const fx = p.x[k]! + ox * limit;
    const fz = p.z[k]! + oz * limit;
    const clear = colliders.every((c) => {
      const t = Math.max(0, Math.min(1, ((c.x - (fx - ox * run)) * ox + (c.z - (fz - oz * run)) * oz) / run));
      return Math.hypot(c.x - (fx - ox * run * (1 - t)), c.z - (fz - oz * run * (1 - t))) >= c.r + 4;
    });
    if (clear && (!best || run > best.run)) best = { fx, fz, ox, oz, run };
  }
  if (!best) throw new Error("the oval has no clear straight wall");
  return best;
}

const WALL = straightWall();
/** What the sim does with the car in the 3 s after it is launched. */
type Hit = { travel: number; killed: boolean; thrown: boolean };

/** A sedan launched at `speed` from the road's far edge (`phase` of one 1/120 s step of travel closer), gas held, stepped by a pacer on the 1/120 s floor or the 1/240 s one. */
function hit(speed: number, coarse: boolean, phase: number): Hit {
  const w = makeWorld();
  try {
    w.race.enter();
    w.race.command({ type: "quit" });
    w.race.command({ type: "options", options: { trackId: "oval", laps: 3, aiCount: 0, noReset: true } });
    w.race.reseed(1);
    w.race.command({ type: "start" });
    w.seat.mode = "drive";
    w.seat.carIndex = 0;
    w.seat.intent.analogGas = true;
    w.seat.intent.gas = 1;
    const pace = new SimPacer();
    pace.pin = coarse;
    const state = { acc: 0 };
    for (let n = 0; w.race.phase !== "racing" && n < 60 * 30; n++) frame(w, state, undefined, pace);
    assert.equal(w.race.phase, "racing");
    const car = w.cars[0]!;
    const back = WALL.run - (phase * speed) / 120;
    car.spawnFacing(WALL.fx - WALL.ox * back, WALL.fz - WALL.oz * back, Math.atan2(WALL.ox, WALL.oz), speed);
    for (let n = 0; n < 60 * 3; n++) frame(w, state, undefined, pace);
    return { travel: car.deform.engineTravel, killed: !car.deform.drivetrainAlive, thrown: car.driverOut !== null };
  } finally {
    w.race.exit();
    setGround(null);
  }
}

const SPEEDS = [30, 40, 55, 66];
const PHASES = [0, 0.25, 0.5, 0.75];
/** Calibration tolerance (m of engine block travel) between the two floors: 6 % of the 0.45 m that kills. */
const SAME = 0.03;

describe("given a sedan flat out into the oval's straight wall at 30 to 66 m/s, from four approach phases against the step grid", () => {
  for (const [floor, coarse] of [["1/240 s", false], ["1/120 s", true]] as const) {
    it(`when the pacer steps at ${floor}, then every hit kills the engine and throws the driver`, () => {
      const missed: string[] = [];
      for (const speed of SPEEDS) {
        for (const phase of PHASES) {
          const h = hit(speed, coarse, phase);
          if (!h.killed || !h.thrown) missed.push(`${speed} m/s phase ${phase}: block ${h.travel.toFixed(3)} m, killed ${h.killed}, thrown ${h.thrown}`);
        }
      }
      assert.deepEqual(missed, []);
    });
  }

  it("when the pacer steps at 1/120 s instead of 1/240 s, then the engine block travels as far, hit for hit", () => {
    const apart: string[] = [];
    for (const speed of SPEEDS) {
      for (const phase of PHASES) {
        const fine = hit(speed, false, phase);
        const coarse = hit(speed, true, phase);
        if (Math.abs(coarse.travel - fine.travel) > SAME) apart.push(`${speed} m/s phase ${phase}: ${fine.travel.toFixed(3)} m at 1/240 s, ${coarse.travel.toFixed(3)} m at 1/120 s`);
      }
    }
    assert.deepEqual(apart, []);
  });
});
