import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { leadIns } from "./race-police-leadin.test-util.ts";
import { COURSE_IDS, finishSweep, makeWorld, raceOnce } from "./race-world.test-util.ts";
import { Track } from "./track.ts";
import city from "./tracks/city.json" with { type: "json" };

/**
 * Full-sanity sweeps, not per-commit tests: whole races of 5 AI cars run on every course and several seeds, watched for a car that does not
 * finish, a cop lead-in that does not line up behind its target or meets its pair. Pinned in the regular suite, on the moment itself:
 * the head-on traffic car edging to its own kerb (`ai/traffic.test.ts`) for the city seed-1 DNF, a stakeout pair nose to nose running its
 * lead-ins without touching (`ai/police-lead-in.test.ts`) for the Dam Spine / Four-Count pairs, one stakeout's lead-in read on its heading
 * and T-bone (`race-finish.test.ts`); the razor-shelf cut mouths by `track.test.ts`.
 */
for (const course of COURSE_IDS) finishSweep(course);

describe("given a 2-lap city race at aggression 0.7 with field seed 1, on a fresh world", () => {
  it("when the race is run out, then it closes and all 5 cars finish, the AI-driven player car included (oncoming traffic must not hold it nose to nose until it is DNF)", () => {
    const track = new Track(city);
    const w = makeWorld();
    w.race.enter();
    try {
      // The finish sweep's bound: the grid and countdown, then 2 laps at 3 × the 9 m/s reference lap.
      const o = raceOnce(w, track, 4.5 + 2 * 3 * (track.length / 9), 1, 0.7);
      assert.ok(Number.isFinite(o.closedAt), "the race closed");
      assert.equal(o.finished, 5, `finished ${o.finished}/5; DNF ${o.dnf.map((d) => `${d.name}: ${d.cause}`).join("; ")}`);
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});

// A lead-in's heading is read against the road's direction of travel under the cop (it lines up behind its target on the
// road) and converges when it ends under 0.2 rad or under where it started. It was read against the target's own last
// velocity in that cell, with every lead-in required to converge. Measured on main ca86b51 and on this head over seeds 1-60
// at start phases 0 and 0.008 (the pools below; 87 and 84 distinct lead-ins, 98 together, since the phases and the two
// trees replay many of the same ones): the racer's cell failed 6 of 87 on main and 5 of 84 here (8 of 98, 8.2 %). A racer's
// line is not the road: it leads the tangent through a corner (seed 6, cop 5 at 67 s: 0.26 → 0.18 against the road, 0.28 →
// 0.35 against the racer, steer 0.48, no mate near) and swerves in a cell (seeds 30 and 48, cop 5 at 15 s: the racer 0.2 rad
// off the road there, 0.25 → 0.19 against the road). The road fails 3 of 98 (3.1 %), none of them the cop's own steer: seed 27
// cop 9 (32.8 s) and seed 32 cop 5 (40.0 s, on main) are a stakeout pair woken together, the pack-mate guard turning the cop
// off a head-on with its mate 12 m away (steer ±1 and brakes for 0.5-0.8 s; error 0.25 → 0.54 and 0.15 → 0.33); seed 32 cop 9
// (28.5 s) is a merge on a bend, where the error must rise while the cop turns into the road (0.18 → 0.23, 10 m to cross). So
// a pool of n checked lead-ins false-fails when more than k fail, at 3.1 %: 4 samples n = 7, k = 1: 1.9 %; 12 seeds n = 15,
// k = 2: 1.0 % (k = 0 would false-fail 20 % and 38 %). A real break (no lead-in lines up) fails most of them. Do not loosen k,
// or tighten it back to every lead-in, without re-measuring on that many seeds.
const DIVERGED_OF_SAMPLES = 1;
const DIVERGED_OF_SEEDS = 2;

describe("given 2-lap Watch races of 4 AI rivals on a course with police cars on", () => {
  it("when four differently seeded and phased oval races run, then police wait until a racer passes their stakeout and lead in behind it (heading converging, no side T-bone) before the pursuit attacks", () => {
    // Four samples: four fields (seeds: each rolls its rivals' aggression and the cops' beats), each started at its own
    // phase of one frame in 4 ms steps. Racers that never touch (the contact guard) no longer let one field's phases
    // fall apart into chaotic samples, so the samples differ by construction. The lead-ins a pack-mate rams (cop on cop,
    // unbumped by the target) do not count, so a single race converges 0 to 6 of its 6; samples that play out
    // identically are one sample, and the fields must really differ.
    const seen = new Set<string>();
    let wakes = 0;
    let converged = 0;
    let offRoad = 0;
    let pursuitHits = 0;
    const diverged: string[] = [];
    for (const [phase, seed] of [[0, 1], [0.004, 2], [0.008, 3], [0.012, 4]] as const) {
      const r = leadIns(phase, seed);
      if (seen.has(JSON.stringify(r))) continue;
      seen.add(JSON.stringify(r));
      wakes += r.wakes;
      converged += r.converged;
      diverged.push(...r.diverged);
      offRoad += r.offRoadLeadIns;
      pursuitHits += r.pursuitHits;
    }
    assert.ok(seen.size >= 3, `only ${seen.size} different samples out of 4 fields`);
    assert.ok(wakes >= 4 && converged >= 3 && offRoad <= converged, `wakes ${wakes}, unbumped lead-ins converged ${converged}, ${offRoad} left out for a target off the road`);
    assert.ok(diverged.length <= DIVERGED_OF_SAMPLES, `${diverged.length} of ${converged + diverged.length} lead-in headings did not converge: ${diverged.join("; ")}`);
    assert.ok(pursuitHits >= 1, "the pursuit after the lead-in never touched a racer");
  });

  it("when twelve seeded oval races run, then no two police cars meet during their lead-ins (a stakeout pair woken together must not drive into each other)", () => {
    let wakes = 0;
    let converged = 0;
    let offRoad = 0;
    const diverged: string[] = [];
    const met: string[] = [];
    for (let seed = 1; seed <= 12; seed++) {
      const r = leadIns(0, seed);
      wakes += r.wakes;
      converged += r.converged;
      diverged.push(...r.diverged);
      offRoad += r.offRoadLeadIns;
      if (r.leadInPairs > 0) met.push(`seed ${seed}: ${r.leadInPairs} pairs`);
    }
    assert.ok(wakes >= 40, `only ${wakes} lead-ins over 12 seeds`);
    // The headings really were checked (15 here, 1 more left out for a target off the road), so this cannot pass on an empty check.
    assert.ok(converged >= 8 && offRoad <= converged, `${converged} lead-in headings checked, ${offRoad} left out for a target off the road (of ${wakes})`);
    assert.ok(diverged.length <= DIVERGED_OF_SEEDS, `${diverged.length} of ${converged + diverged.length} lead-in headings did not converge: ${diverged.join("; ")}`);
    assert.deepEqual(met, [], `lead-in pairs that touched (of ${wakes} lead-ins)`);
  });

  it("when the long fast courses Dam Spine (seed 1) and Four-Count (seed 6) run, then no two cops touch during their lead-ins, and each cop that pulls away has a racer past its spot", () => {
    for (const [course, seed] of [["dam-spine", 1], ["four-count", 6]] as const) {
      const r = leadIns(0, seed, course);
      assert.ok(r.wakes >= 10, `${course} seed ${seed}: only ${r.wakes} wakes`);
      assert.equal(r.leadInPairs, 0, `${course} seed ${seed}: lead-in pairs that touched`);
    }
  });
});
