import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../world/ground.ts";
import { frame, makeWorld, type World } from "../world/race-world.test-util.ts";
import { FINE_PEDALS, REHIT_S, type HighlightClip } from "../match/highlights.ts";
import { makeSnapshot, Reader, readSnapshot, Writer } from "../net/codec.ts";
import { carLayout } from "../net/car-pose.ts";
import { clipBytes, readClip, writeClip } from "../net/reel-codec.ts";
import { ClipSim } from "./engine-replay.ts";

/**
 * A recorded race crash replayed headless (docs/HIGHLIGHTS.md), over many seeded races: the harness of
 * `engine-replay.test.ts` (a race is ~10 s of headless sim, a seed with its clips 12-20 s: a sweep of 64 seeds is four
 * shards of 16, each `SEEDS=17,18,... node --experimental-strip-types --test engine-replay.test.ts`).
 */

/** A ramming field (aggression 1) of 12 on the city course: crashes come in the first lap. */
const FIELD = { trackId: "city", laps: 1, aiCount: 11, noReset: false, aggression: 1 };
/** Race seconds recorded (the first lap's crashes), and the clips wanted from them. */
const RACE_S = 75;
const CLIPS = 5;
/** Acceptance (docs/HIGHLIGHTS.md): the replay's first impact within 0.2 s and 1.5 m of the recorded one. */
const TIME_TOL = 0.2;
const POS_TOL = 1.5;
/**
 * The cars a clip's impact involves keep their exact pedals (`HighlightClip.fine`), and a replay of them is the live sim:
 * at the first impact's step, before its keyframe corrects them, they stand exactly where the record has them (the
 * netplay wire's float32 pose, both sides: measured over seeds 1-64, 236 clips: 0 m; it was up to 3.3 m).
 */
const INVOLVED_TOL = 0;

/**
 * A race with no clip by this race second gets a hit of its own: the player's car drives flat out straight ahead (the way
 * `replay-fidelity.test.ts` scripts its attacker) into the first wall it meets. A seed whose AI field races a clean lap
 * (every hit under `MIN_SCORE`) would leave nothing to replay: seed 14 of 1-64, and seed 7 once a trajectory changed.
 */
const SCRIPTED_AT = 12;

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
 * from their recorded spots at the impact step before that step's keyframe corrects them (the pop a viewer would see):
 * every car (`dPos`; a bystander keeps only 8-bit pedals between keyframes) and the involved ones alone (`dInvolved`, `involved` of them).
 */
function replay(w: World, clip: HighlightClip): { dt: number; dPos: number; dInvolved: number; involved: number } {
  const cars = clip.cars.map((c) => w.cars[c.slot]!);
  const sim = new ClipSim(clip, cars, {
    dress: w.dress,
    collide: (car, slot, h) => w.race.courseHit(car, slot, h),
    restore: (slot, mem, at) => w.race.remember(slot, mem, at),
    knocks: (bits) => w.race.knockTo(bits),
    bounce: undefined,
  });
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
  const nc = cars.length;
  let dPos = 0;
  let dInvolved = 0;
  let involved = 0;
  for (let j = 0; j < nc; j++) {
    const d = Math.hypot(sim.preSnap[j * 3]! - rec.cars[j]!.x, sim.preSnap[j * 3 + 1]! - rec.cars[j]!.y, sim.preSnap[j * 3 + 2]! - rec.cars[j]!.z);
    dPos = Math.max(dPos, d);
    if (!clip.fine.some((p, i) => Math.floor(i / FINE_PEDALS) % nc === j && !Number.isNaN(p))) continue;
    involved++;
    dInvolved = Math.max(dInvolved, d);
  }
  return { dt: sim.firstHit < 0 ? Infinity : Math.abs(sim.firstHit - clip.firstImpact), dPos, dInvolved, involved };
}

/**
 * One test per seed: its race's crashes recorded, then each clip replayed and held to the bounds. The seeds of a sweep
 * (`SEEDS=14,28 node ...` runs just those) must between them leave clips and involved cars to hold: a test whose
 * races recorded nothing proves nothing.
 */
export function sweepSeeds(from: number, to: number): void {
  const seeds = process.env.SEEDS ? process.env.SEEDS.split(",").map(Number) : Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const total = { clips: 0, involved: 0 };
  describe(`highlight replay, seeds ${seeds[0]} to ${seeds[seeds.length - 1]}`, () => {
    for (const seed of seeds) it(`bad: seed ${seed}: a recorded race crash replayed headless must hit within ${TIME_TOL} s and ${POS_TOL} m of the record, its involved cars to the bit`, (t) => {
      const w = makeWorld();
      w.race.enter();
      try {
        const clips = record(w, seed);
        assert.ok(clips.length >= 1, `seed ${seed}: no clip in ${RACE_S} s of a ramming field and a flat-out player: the recorder or the ledger saw no crash`);
        const rows: string[] = [];
        const worst = { dt: 0, dPos: 0, dInvolved: 0 };
        for (const clip of clips) {
          const r = replay(w, clip);
          assert.ok(r.involved >= 1, `seed ${seed}: a clip with no car of exact pedals: nothing to hold to the bit`);
          rows.push(
            `${clip.cars.length} cars (${r.involved} involved), ${(clipBytes(clip) / 1024).toFixed(0)} KB, score ${clip.score.toFixed(1)}, ${clip.firstB < 0 ? "wall" : "pair"} impact at ${clip.firstImpact.toFixed(2)} s: ` +
              `dt ${r.dt.toFixed(3)} s, worst car ${r.dPos.toFixed(3)} m off, worst involved car ${r.dInvolved.toExponential(1)} m off, before the impact correction`,
          );
          worst.dt = Math.max(worst.dt, r.dt);
          worst.dPos = Math.max(worst.dPos, r.dPos);
          worst.dInvolved = Math.max(worst.dInvolved, r.dInvolved);
          total.involved += r.involved;
        }
        total.clips += clips.length;
        t.diagnostic(rows.join("\n"));
        assert.ok(worst.dt <= TIME_TOL, `seed ${seed}: first impact ${worst.dt.toFixed(3)} s off the record (> ${TIME_TOL})\n${rows.join("\n")}`);
        assert.ok(worst.dPos <= POS_TOL, `seed ${seed}: a car ${worst.dPos.toFixed(2)} m off its recorded spot at the first impact (> ${POS_TOL})\n${rows.join("\n")}`);
        assert.ok(worst.dInvolved <= INVOLVED_TOL, `seed ${seed}: an involved car ${worst.dInvolved.toExponential(2)} m off its recorded spot at the first impact (> ${INVOLVED_TOL})\n${rows.join("\n")}`);
      } finally {
        w.race.exit();
        setGround(null);
      }
    });
    it(`the sweep replayed at least a clip and an involved car per seed`, () => {
      assert.ok(total.clips >= seeds.length && total.involved >= total.clips, `${total.clips} clips and ${total.involved} involved cars over ${seeds.length} seeds`);
    });
  });
}
