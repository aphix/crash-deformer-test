import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { FRAME, frame, makeWorld } from "./race-world.test-util.ts";
import { PoliceBrain } from "../ai/police.ts";
import { DEFAULT_RACE_OPTIONS } from "../match/types.ts";
import { TRACK_ID } from "./constants.ts";

/** The race's stall rule: a police car out driving that gains under 25 m in 8 s with nothing touching it is put away (`RaceField.copStalls`). */
const WINDOW = 8;
const BOUND = 120;
/** Cops put away (the pair of a stakeout) after which the race stops: the rule has been watched to its end. */
const STALLS_SEEN = 2;

/** A police race on the oval whose cops have their pedals cut (throttle off, brakes on) from the moment they wake: seconds each spent out driving. */
function frozenCops(seed: number): number[] {
  const w = makeWorld();
  w.race.enter();
  try {
    w.race.command({ type: "quit" });
    w.race.command({ type: "options", options: { ...DEFAULT_RACE_OPTIONS, trackId: TRACK_ID.oval, laps: 3, police: true } });
    w.race.reseed(seed);
    w.race.command({ type: "start" });
    w.seat.mode = "follow";
    const brain = Reflect.get(w.race, "police");
    assert.ok(brain instanceof PoliceBrain, "the race has a police brain");
    const think = brain.think.bind(brain);
    brain.think = (self, snaps, dt) => {
      const input = think(self, snaps, dt);
      input.throttle = 0;
      input.brake = 1;
      input.ebrake = true;
      return input;
    };
    const since = new Map<number, number>();
    const spent: number[] = [];
    const state = { acc: 0 };
    for (let n = 0; n * FRAME < BOUND && w.race.phase !== "finished"; n++) {
      frame(w, state);
      if (w.race.phase !== "racing") continue;
      for (let id = brain.first; id < brain.first + brain.count; id++) {
        const at = since.get(id);
        if (brain.drives(id)) {
          if (at === undefined) since.set(id, w.race.time);
        } else if (at !== undefined) {
          spent.push(w.race.time - at);
          since.delete(id);
        }
      }
      if (spent.length >= STALLS_SEEN && since.size === 0) break;
    }
    for (const at of since.values()) spent.push(w.race.time - at);
    return spent;
  } finally {
    w.race.exit();
    setGround(null);
  }
}

describe("given a police race on the oval whose cops have their drive cut from the moment they wake", () => {
  it("when a woken cop sits in place with nothing touching it, then it is put away once its stall window has run out: none stays out driving longer", (t) => {
    const spent = frozenCops(1);
    t.diagnostic(`seconds out driving: ${spent.map((s) => s.toFixed(2)).join(", ")}`);
    assert.ok(spent.length > 0, "a cop woke");
    assert.ok(Math.max(...spent) < WINDOW + 1, `a cop sat in place for ${Math.max(...spent).toFixed(2)} s, past its ${WINDOW} s window`);
  });
});
