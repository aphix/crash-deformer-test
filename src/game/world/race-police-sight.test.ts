import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { FRAME, frame, makeWorld } from "./race-world.test-util.ts";
import { MIN_LIFE, OUT_RANGE, PoliceBrain } from "../ai/police.ts";
import { SIGHT_AHEAD, SIGHT_BEHIND, SIGHT_NEAR } from "../ai/cop-sight.ts";
import type { HunterWorld } from "../ai/cop-brain.ts";
import { DEFAULT_RACE_OPTIONS } from "../match/types.ts";
import { TRACK_ID } from "./constants.ts";
import { blankProjection, Track } from "./track.ts";
import fourCount from "./tracks/four-count.json" with { type: "json" };

/** Race seconds a seed runs: the first stakeout is a third of the first lap in, and packs chase and give up for the 100 s after it. */
const BOUND = 150;
const SEEDS = [1, 2];
/** A cop driving faster than this (m/s) is moving. */
const MOVING = 2;

/**
 * The owner's flagged Four-Count clips (a cop gone while driving 56 m from the player; a cop put on the road, standing 0.75 s and gone; two
 * dropped in beside the reel's cars) read as a race's police pops: here a seeded police race on Four-Count, every placement and put-away checked
 * against where the racers stood at that frame.
 */
interface PopReport {
  parks: number;
  stores: number;
  movingStores: number;
  /** Placements and put-aways that broke a rule, as sentences. */
  broken: string[];
}

function policeRace(seed: number): PopReport {
  const w = makeWorld();
  w.race.enter();
  const track = new Track(fourCount);
  const proj = blankProjection();
  try {
    w.race.command({ type: "quit" });
    w.race.command({ type: "options", options: { ...DEFAULT_RACE_OPTIONS, trackId: TRACK_ID.fourCount, laps: 3, police: true } });
    w.race.reseed(seed);
    w.race.command({ type: "start" });
    w.seat.mode = "follow";
    const brain = Reflect.get(w.race, "police");
    const world: HunterWorld = Reflect.get(w.race, "patrolWorld");
    assert.ok(brain instanceof PoliceBrain, "the race has a police brain");
    const racers = w.race.racers.length;
    const report: PopReport = { parks: 0, stores: 0, movingStores: 0, broken: [] };
    const bornAt = new Map<number, number>();
    let recalling = false;

    /** The racer nearest (x, z): its straight-line distance and the metres of road (x, z) lies ahead of it; whether it sees the spot at all. */
    const racerSeeing = (x: number, z: number): { sees: boolean; nearest: number; text: string } => {
      const spotS = track.project(x, z, -1, proj).s;
      let nearest = Infinity;
      let text = "";
      for (let i = 0; i < racers; i++) {
        const p = w.cars[i]!.group.position;
        const dist = Math.hypot(p.x - x, p.z - z);
        nearest = Math.min(nearest, dist);
        const along = spotS - track.project(p.x, p.z, -1, proj).s;
        const ahead = along - track.length * Math.round(along / track.length);
        if (dist < SIGHT_NEAR || (ahead > -SIGHT_BEHIND && ahead < SIGHT_AHEAD)) text ||= `racer ${i}: ${dist.toFixed(0)} m away, spot ${ahead.toFixed(0)} m ahead of it along the road`;
      }
      return { sees: text !== "", nearest, text };
    };

    const park = world.park.bind(world);
    world.park = (id, x, y, z, yaw) => {
      const seen = racerSeeing(x, z);
      report.parks++;
      bornAt.set(id, w.race.time);
      if (seen.sees) report.broken.push(`${w.race.time.toFixed(2)} s: cop ${id} put on the road in sight of ${seen.text}`);
      park(id, x, y, z, yaw);
    };
    const store = world.store.bind(world);
    world.store = (id) => {
      const car = w.cars[id]!;
      const p = car.group.position;
      const seen = racerSeeing(p.x, p.z);
      const moving = car.velocity.length() > MOVING;
      const age = w.race.time - (bornAt.get(id) ?? -Infinity);
      report.stores++;
      if (moving) report.movingStores++;
      if (moving && seen.nearest < SIGHT_NEAR) report.broken.push(`${w.race.time.toFixed(2)} s: cop ${id} put away moving ${(car.velocity.length() * 3.6).toFixed(0)} km/h, ${seen.nearest.toFixed(0)} m from a racer`);
      const stoppedStallRecall = recalling && !moving;
      if (seen.sees && !stoppedStallRecall) report.broken.push(`${w.race.time.toFixed(2)} s: cop ${id} put away in sight of ${seen.text}`);
      const excused = world.down(id) || recalling || seen.nearest > OUT_RANGE;
      if (age < MIN_LIFE && !excused) report.broken.push(`${w.race.time.toFixed(2)} s: cop ${id} put away ${age.toFixed(2)} s after it was put on the road`);
      store(id);
    };
    const recall = brain.recall.bind(brain);
    brain.recall = (id, to) => {
      recalling = true;
      recall(id, to);
      recalling = false;
    };

    const state = { acc: 0 };
    for (let n = 0; n * FRAME < BOUND && w.race.phase !== "finished"; n++) frame(w, state);
    return report;
  } finally {
    w.race.exit();
    setGround(null);
  }
}

describe(`given seeded police races on Four-Count (seeds ${SEEDS.join(", ")}) with the AI racers driving`, () => {
  it(`when each runs ${BOUND} s, then no cop is put on the road or put away in any racer's sight, none moving within ${SIGHT_NEAR} m of one, and none put away inside ${MIN_LIFE} s of being put on the road unless it is knocked out, stuck or ${OUT_RANGE} m off`, (t) => {
    let parks = 0;
    let movingStores = 0;
    for (const seed of SEEDS) {
      const report = policeRace(seed);
      t.diagnostic(`seed ${seed}: ${report.parks} cops put on the road, ${report.stores} put away (${report.movingStores} of them moving)`);
      assert.equal(report.broken.length, 0, `seed ${seed}:\n${report.broken.join("\n")}`);
      parks += report.parks;
      movingStores += report.movingStores;
    }
    assert.ok(parks >= 8, `${parks} cops put on the road: the test proves nothing`);
    assert.ok(movingStores >= 1, "no moving cop was put away: the test proves nothing about them");
  });
});
