import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../world/ground.ts";
import { frame, makeWorld, type World } from "../world/race-world.test-util.ts";
import { REHIT_S, type HighlightClip } from "../match/highlights.ts";
import { makeSnapshot, Reader, readSnapshot, Writer } from "../net/codec.ts";
import { carLayout } from "../net/car-pose.ts";
import { clipBytes, readClip, writeClip } from "../net/reel-codec.ts";
import { ClipSim } from "./engine-replay.ts";

/** A ramming field (aggression 1) of 12 on the city course: crashes come in the first lap. */
const FIELD = { trackId: "city", laps: 1, aiCount: 11, noReset: false, aggression: 1 };
/**
 * Seeds 1 to 8, each its own race (the field piles up in different places: clips that open on wrecks already in motion,
 * wall hits, pile-ups of 3 to 17 cars). Seeds 4 to 8 once missed the bound (a wall impact never reached, dt Infinity;
 * a restored wreck 18 mm off after one step): the solver state a keyframe restored left out each shape cluster's last
 * rotation and warm start (`simState`).
 */
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
/** Race seconds recorded (the first lap's crashes), and the clips wanted from them. */
const RACE_S = 75;
const CLIPS = 5;
/**
 * A race with no clip by this race second gets a hit of its own: the player's car drives flat out straight ahead (the way
 * `replay-fidelity.test.ts` scripts its attacker) into the first wall it meets. A seed whose AI field races a clean lap
 * (every hit under `MIN_SCORE`) would leave nothing to replay: seed 14 of 1-64, and seed 7 once a trajectory changed.
 */
const SCRIPTED_AT = 12;
/** Acceptance (docs/HIGHLIGHTS.md): the replay's first impact within 0.2 s and 1.5 m of the recorded one. */
const TIME_TOL = 0.2;
const POS_TOL = 1.5;

/** Clips recorded from one seeded race, through the codec (what a peer or a saved copy replays). */
function record(w: World, seed: number): HighlightClip[] {
  const r = w.race;
  r.command({ type: "quit" });
  r.command({ type: "options", options: FIELD });
  r.reseed(seed);
  r.command({ type: "start" });
  w.seat.mode = "follow";
  const state = { acc: 0 };
  for (let n = 0; n * (1 / 60) < RACE_S && r.recorder.ledger.kept.length < CLIPS && r.phase !== "finished"; n++) {
    if (r.recorder.now >= SCRIPTED_AT && r.recorder.ledger.kept.length === 0 && w.seat.mode !== "drive") {
      w.seat.mode = "drive";
      w.seat.carIndex = 0;
      w.seat.intent.gas = 1;
    }
    frame(w, state);
  }
  r.recorder.end();
  const L = carLayout(w.cars[0]!);
  return r.recorder.ledger.kept.map((c) => {
    const wr = new Writer(clipBytes(c));
    writeClip(wr, c);
    assert.equal(wr.off, clipBytes(c), "clipBytes is the exact size");
    return readClip(new Reader().reset(wr.done()), L);
  });
}

/**
 * Replay `clip` on the world's cars: how far from the record its first impact lands in time, and how far its cars are
 * from their recorded spots at the impact step before that step's keyframe corrects them (the pop a viewer would see).
 */
function replay(w: World, clip: HighlightClip, impactKey: boolean): { dt: number; dPos: number } {
  const cars = clip.cars.map((c) => w.cars[c.slot]!);
  const sim = new ClipSim(clip, cars, { dress: w.dress, collide: (car, slot, h) => w.race.courseHit(car, slot, h), placed: (slot) => w.race.relocated(slot), bounce: undefined });
  sim.useImpactKey = impactKey;
  // The record's first impact was a fresh contact (the pair apart for `REHIT_S` before it): a replay contact in that quiet spell is drift.
  sim.watchFrom = Math.max(0, clip.firstImpact - REHIT_S);
  const prev = w.race.onWallHit;
  w.race.onWallHit = (slot, closing) => sim.noteWall(slot, closing);
  try {
    w.race.resetProps();
    sim.restart();
    sim.advanceTo(clip.firstImpact + 2);
  } finally {
    w.race.onWallHit = prev;
  }
  const k = clip.keyStep.indexOf(sim.impactStep);
  assert.ok(k >= 0, "the clip keeps a keyframe at its first impact");
  const rec = makeSnapshot();
  readSnapshot(new Reader().reset(clip.keys[k]!), rec, carLayout(cars[0]!));
  let dPos = 0;
  for (let j = 0; j < cars.length; j++) dPos = Math.max(dPos, Math.hypot(sim.preSnap[j * 3]! - rec.cars[j]!.x, sim.preSnap[j * 3 + 2]! - rec.cars[j]!.z));
  return { dt: sim.firstHit < 0 ? Infinity : Math.abs(sim.firstHit - clip.firstImpact), dPos };
}

describe("highlight replay", () => {
  for (const seed of SEEDS) it(`bad: seed ${seed}: a recorded race crash replayed headless must hit within ${TIME_TOL} s and ${POS_TOL} m of the record`, (t) => {
    const w = makeWorld();
    w.race.enter();
    try {
      const clips = record(w, seed);
      assert.ok(clips.length >= 1, `seed ${seed}: no clip in ${RACE_S} s of a ramming field and a flat-out player: the recorder or the ledger saw no crash`);
      let worst = { dt: 0, dPos: 0 };
      const rows: string[] = [];
      for (const clip of clips) {
        const full = replay(w, clip, true);
        const free = replay(w, clip, false).dt;
        rows.push(
          `${clip.cars.length} cars, ${(clipBytes(clip) / 1024).toFixed(0)} KB, score ${clip.score.toFixed(1)}, ${clip.firstB < 0 ? "wall" : "pair"} impact at ${clip.firstImpact.toFixed(2)} s: ` +
            `dt ${full.dt.toFixed(3)} s (${free.toFixed(3)} s without the impact keyframe), worst car ${full.dPos.toFixed(3)} m off before the impact correction`,
        );
        worst = { dt: Math.max(worst.dt, full.dt), dPos: Math.max(worst.dPos, full.dPos) };
      }
      t.diagnostic(rows.join("\n"));
      assert.ok(worst.dt <= TIME_TOL, `seed ${seed}: first impact ${worst.dt.toFixed(3)} s off the record (> ${TIME_TOL})\n${rows.join("\n")}`);
      assert.ok(worst.dPos <= POS_TOL, `seed ${seed}: a car ${worst.dPos.toFixed(2)} m off its recorded spot at the first impact (> ${POS_TOL})\n${rows.join("\n")}`);
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});
