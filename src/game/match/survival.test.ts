import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Track } from "../world/track.ts";
import { HAVANA } from "../world/tracks/havana.ts";
import { BUST, RaceSession } from "./session.ts";
import { SURVIVAL, settleRun } from "./survival.ts";
import type { CarPose, Entrant } from "./types.ts";

const track = new Track(HAVANA);
const you: Entrant = { id: 0, name: "You", kind: "player", aggression: 0 };
const DT = 1 / 60;
/** The owner's "like 10-15 seconds", as one number. */
const HOLD = 12;

function session(survival: boolean): RaceSession {
  return new RaceSession(track, [you], { laps: 3, noReset: true, survival: survival ? SURVIVAL : undefined });
}

const pose = (x: number, z: number, kph: number): CarPose => ({ x, z, yaw: 0, vx: 0, vz: kph / 3.6, alive: true });

/** Step the session until the green. */
function toGreen(s: RaceSession): void {
  while (s.phase !== "racing") s.step(DT, [pose(0, 420, 0)]);
}

/** Hold the car at `kph` with one cop `copAt` m away; seconds until the bust (null: none within `limit`). */
function bustAfter(s: RaceSession, kph: number, copAt: number, limit: number): number | null {
  toGreen(s);
  const t0 = s.time;
  for (let n = 0; n * DT < limit; n++) {
    s.step(DT, [pose(0, 420, kph)], [{ x: 0, z: 420 + copAt }]);
    if (s.cars[0]!.bustedAt !== null) return s.time - t0;
  }
  return null;
}

describe("given one player car on the Havana track, busted when held under 20 km/h within 20 m of a cop for a hold time (12 s in survival, shorter in a race)", () => {
  it("when the car is held under 20 km/h within 20 m of a cop, then it is busted after 12 s and not a step before, and a bust ends the one-car run with the car out", () => {
    assert.equal(SURVIVAL.bustTime, HOLD);
    const s = session(true);
    const at = bustAfter(s, 5, 10, 30);
    assert.ok(at !== null, "never busted");
    assert.ok(at > HOLD && at < HOLD + 2 * DT, `busted after ${at.toFixed(3)} s`);
    assert.equal(s.cars[0]!.status, "out", "a bust is out in a no-reset run");
    assert.equal(s.phase, "finished", "and the only car out ends the run");
  });

  it("when the same stopped-near-a-cop situation runs as an ordinary race instead of survival, then the car is busted at the race's own shorter hold and is a DNF", () => {
    assert.ok(SURVIVAL.bustTime > BUST.time, "the survival hold is the owner's 10-15 s, longer than the race's");
    const race = new RaceSession(track, [you], { laps: 3, noReset: false });
    const at = bustAfter(race, 5, 10, 40);
    assert.ok(at !== null && at > BUST.time && at < BUST.time + 2 * DT, `race busted after ${at}`);
    assert.equal(race.cars[0]!.status, "dnf");
  });

  it("when the car is farther than 20 m from every cop, or moving at 20 km/h and over, then it is never busted", () => {
    assert.equal(bustAfter(session(true), 5, BUST.near + 1, 40), null, "busted with the cop out of range");
    assert.equal(bustAfter(session(true), BUST.kph + 1, 5, 40), null, "busted while moving");
  });

  it("when the car moves off, or the cops fall away, partway through the hold, then the hold restarts from zero and the bust comes only after a full hold again", () => {
    const s = session(true);
    toGreen(s);
    const step = (kph: number, copAt: number, seconds: number): void => {
      for (let n = 0; n * DT < seconds; n++) s.step(DT, [pose(0, 420, kph)], [{ x: 0, z: 420 + copAt }]);
    };
    step(5, 10, HOLD - 1);
    step(40, 10, DT * 2);
    step(5, 10, HOLD - 1);
    assert.equal(s.cars[0]!.bustedAt, null, "a car that moved off was busted on the old clock");
    step(5, 60, DT * 2);
    step(5, 10, HOLD - 1);
    assert.equal(s.cars[0]!.bustedAt, null, "a car the cops lost was busted on the old clock");
    step(5, 10, 2);
    assert.notEqual(s.cars[0]!.bustedAt, null);
  });

  it("when the car drives the ring four times at 80 km/h, then no gates count, the run never finishes and the car is never flagged wrong-way", () => {
    const s = session(true);
    toGreen(s);
    const p = track.path;
    for (let lap = 0; lap < 4; lap++) {
      for (let k = 0; k < p.count; k++) s.step(DT, [pose(p.x[k]!, p.z[k]!, 80)], []);
    }
    const c = s.cars[0]!;
    assert.equal(c.lap, 0);
    assert.equal(c.status, "racing");
    assert.equal(s.phase, "racing");
    assert.equal(c.wrongWay, false);
  });
});

describe("given a survival run's recorded best time", () => {
  it("when a first run, a longer run and an equal run settle against it, then only a longer run is a new best", () => {
    assert.deepEqual(settleRun(null, 12.5), { best: 12.5, isNew: true });
    assert.deepEqual(settleRun(12.5, 30), { best: 30, isNew: true });
    assert.deepEqual(settleRun(30, 12.5), { best: 30, isNew: false });
    assert.deepEqual(settleRun(30, 30), { best: 30, isNew: false });
  });
});
