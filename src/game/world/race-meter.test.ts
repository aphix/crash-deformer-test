import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TRACK_ID } from "./constants.ts";
import { setGround } from "./ground.ts";
import { frame, makeWorld } from "./race-world.test-util.ts";

/** Seconds the race runs before the views are read: past a third of the oval's first lap, when its police packs are out. */
const RUN_S = 40;

describe("given an oval race with police on, whose player car the race AI drives while the seat only follows (a bench, a watched race)", () => {
  it("when the player's car, a rival and a police car are each viewed, then the two racers show their driver's boost meter and the police car a full bottle (police boost with no meter)", () => {
    const w = makeWorld();
    w.race.enter();
    try {
      w.race.command({ type: "options", options: { trackId: TRACK_ID.oval, laps: 3, aiCount: 4, police: true } });
      w.race.reseed(1);
      w.race.command({ type: "start" });
      w.seat.mode = "follow";
      const state = { acc: 0 };
      for (let n = 0; n < RUN_S * 60; n++) frame(w, state);
      const racers = w.race.racers.length;
      assert.ok(w.live().length > racers, "the police are out");
      const meterOf = (id: number): number | null => {
        w.seat.carIndex = id;
        return w.race.hud().view!.boost;
      };
      // A seat meter no AI meter holds: an AI-driven car showing the seat's (the old bench bug's sibling) would read it back.
      w.seat.boost = 0.123456;
      for (const id of [0, 1]) {
        const m = meterOf(id);
        assert.ok(m !== null && m >= 0 && m <= 1 && m !== w.seat.boost, `car ${id} (${w.race.racers[id]!.kind}) shows meter ${m}`);
      }
      assert.equal(meterOf(racers), 1, "a police unit's bottle is full");
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});

describe("given an oval race whose player car the seat drives", () => {
  it("when the seat has been sliding, then the player's view carries the slide (seconds, clean, payouts) as a copy, and every other car's view carries none", () => {
    const w = makeWorld();
    w.race.enter();
    try {
      w.race.command({ type: "options", options: { trackId: TRACK_ID.oval, laps: 3, aiCount: 4, police: false } });
      w.race.reseed(1);
      w.race.command({ type: "start" });
      const state = { acc: 0 };
      for (let n = 0; n < 60; n++) frame(w, state);
      w.seat.mode = "drive";
      w.seat.carIndex = 0;
      Object.assign(w.seat.drift, { s: 1.4, clean: false, paid: 3 });
      const mine = w.race.hud().view!;
      assert.deepEqual(mine.drift, { s: 1.4, clean: false, paid: 3 });
      w.seat.drift.s = 2;
      assert.equal(mine.drift.s, 1.4, "a copy: the seat goes on writing its own");
      w.seat.mode = "follow";
      w.seat.carIndex = 1;
      assert.deepEqual(w.race.hud().view!.drift, { s: 0, clean: true, paid: 0 }, "a rival's view");
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});
