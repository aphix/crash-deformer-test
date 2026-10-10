import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { humanSlot } from "../match/survival.ts";
import type { DriveInput } from "../vehicle/car-drive.ts";
import { FRAME, frame, makeWorld, type World } from "./race-world.test-util.ts";
import { hold, leaveSurvival } from "./survival-run.test-util.ts";
import { Track } from "./track.ts";
import { HAVANA } from "./tracks/havana.ts";

/**
 * A hosted Survival run with several humans (docs/SURVIVAL.md, Co-op): the host's car 0 and a network peer on each of the cars the room seated,
 * the cops after all of them, the run lost when no human is free. The peers' pedals are what the host last heard (`setRemoteInput`).
 */
const start = new Track(HAVANA).survival!.start;

function coopWorld(peers: readonly number[], seed = 1): World {
  const w = makeWorld();
  w.race.reseed(seed);
  w.race.setSeats(new Map(peers.map((car) => [car, `Peer ${car}`])));
  w.race.enter(true);
  return w;
}

const STILL: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: true, boost: false };
/** Round and round at about 7 m/s: above the bust's 20 km/h, so the police never hold it. */
const CIRCLE: DriveInput = { throttle: 0.45, steer: 0.45, brake: 0, ebrake: false, boost: false };

describe("given a hosted Survival run with the host and two peers seated", () => {
  it("when the run starts, then all three humans stand on their own start slots, abreast of the start anchor, and the team reads three humans free", (t) => {
    const w = coopWorld([1, 2]);
    t.after(() => leaveSurvival(w));
    const state = { acc: 0 };
    for (let n = 0; n < 60; n++) {
      hold(w);
      w.race.setRemoteInput(1, STILL);
      w.race.setRemoteInput(2, STILL);
      frame(w, state);
    }
    assert.deepEqual(w.race.racers.map((e) => e.kind), ["player", "remote", "remote"]);
    // Where `humanSlot` seats them, in the order the run seats the cars (the peers first, the host last).
    const seated = [humanSlot(start, 0), humanSlot(start, 1), humanSlot(start, 2)];
    const cars = [w.cars[1]!, w.cars[2]!, w.cars[0]!];
    for (const [k, car] of cars.entries()) {
      const p = car.group.position;
      assert.ok(Math.hypot(p.x - seated[k]!.x, p.z - seated[k]!.z) < 1, `car ${k} stands within a metre of its slot`);
    }
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) assert.ok(cars[a]!.group.position.distanceTo(cars[b]!.group.position) > 3.5, "no two humans overlap");
    assert.deepEqual(w.race.hud().team, { humans: 3, free: 3, place: null, won: null });
  });

  it("when the pack launches, then it is sized for the three humans: more units than a lone player meets", (t) => {
    const w = coopWorld([1, 2]);
    t.after(() => leaveSurvival(w));
    const solo = makeWorld();
    solo.race.enter(true);
    t.after(() => leaveSurvival(solo));
    assert.ok(w.live().length - 3 > solo.live().length - 1, `${w.live().length - 3} units for three humans, ${solo.live().length - 1} for one`);
  });
});

describe("given a hosted Survival run with one human", () => {
  it("when the run starts, then there is no team: the HUD and the rules read as a lone player's", (t) => {
    const w = coopWorld([]);
    t.after(() => leaveSurvival(w));
    assert.equal(w.race.hud().team, null);
  });
});

describe("given a hosted Survival run with the host and one peer, the host sitting still and the peer circling", () => {
  it("when the humans fall one after the other, then the run goes on while one is free, ends when none is, and its time is the team's: the last fall", (t) => {
    const w = coopWorld([1]);
    t.after(() => leaveSurvival(w));
    const state = { acc: 0 };
    let sitting = false;
    let firstFall = Infinity;
    let finishedAt = -1;
    for (let n = 0; n * FRAME < 240; n++) {
      // The peer circles until the host has been busted, then sits too (so the run can end).
      hold(w);
      w.race.setRemoteInput(1, sitting ? STILL : CIRCLE);
      frame(w, state);
      if (n % 10 !== 0) continue;
      const hud = w.race.hud();
      const team = hud.team!;
      if (team.free < 2 && firstFall === Infinity) {
        firstFall = w.race.time;
        sitting = true;
      }
      assert.equal(hud.phase === "finished", team.free === 0, `at ${w.race.time.toFixed(1)} s: the run is over exactly when no human is free (${team.free} free)`);
      if (hud.phase === "finished") {
        finishedAt = w.race.time;
        break;
      }
    }
    t.diagnostic(`first fall ${firstFall.toFixed(1)} s, run over ${finishedAt.toFixed(1)} s`);
    assert.ok(finishedAt > 0, "the run ended: no human is free");
    assert.ok(firstFall < finishedAt, `the first fall (${firstFall.toFixed(1)} s) came before the run's end (${finishedAt.toFixed(1)} s)`);
    const result = w.race.hud().survival!.result!;
    assert.equal(result.time, finishedAt, "the run's time is the race clock at the last fall");
    assert.equal(w.race.hud().team!.won, false, "a Survival run is only ever lost");
  });
});

describe("given a hosted Survival run seating a peer in car 2 only, car 1 empty", () => {
  it("when the run starts, then car 1 is nobody's: parked out of the way, never hunted and never keeping the run alive", (t) => {
    const w = coopWorld([2]);
    t.after(() => leaveSurvival(w));
    const state = { acc: 0 };
    for (let n = 0; n < 120; n++) {
      hold(w);
      w.race.setRemoteInput(2, STILL);
      frame(w, state);
    }
    const empty = w.race.snapshot()!.cars.find((c) => c.id === 1)!;
    assert.equal(empty.kind, "ai");
    assert.equal(empty.status, "out", "no human drives it");
    assert.ok(w.cars[1]!.group.position.z > 1000, "parked off the course");
    assert.deepEqual(w.race.hud().team, { humans: 2, free: 2, place: null, won: null });
  });
});

describe("given a hosted Survival run with the host and a peer seated", () => {
  it("when a second peer joins mid-run, then the run stays as it was; and when the run is retried, then the field takes the new peer in, and drops the first when it has gone", (t) => {
    const w = coopWorld([1]);
    t.after(() => leaveSurvival(w));
    const state = { acc: 0 };
    for (let n = 0; n < 30; n++) frame(w, state);
    w.race.setSeats(new Map([[1, "Peer 1"], [2, "Peer 2"]]));
    assert.equal(w.race.racers.length, 2, "nobody is added to a run in progress");
    w.race.command({ type: "retry" });
    assert.deepEqual(w.race.racers.map((e) => e.kind), ["player", "remote", "remote"]);
    assert.equal(w.race.hud().team!.humans, 3);
    w.race.setSeats(new Map());
    w.race.command({ type: "retry" });
    assert.deepEqual(w.race.racers.map((e) => e.kind), ["player"], "a peer who has gone leaves the field");
    assert.equal(w.race.hud().team, null);
  });
});
