import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TRACK_ID } from "./constants.ts";
import { setGround } from "./ground.ts";
import { frame, makeWorld } from "./race-world.test-util.ts";

/** Seconds the race runs before the views are read: past a third of the oval's first lap, when its police packs are out. */
const RUN_S = 40;

describe("given an oval race with police on, whose player car the race AI drives while the seat only follows (a bench, a watched race)", () => {
  it("when the player's car, a rival and a police car are each viewed, then the two racers show their driver's boost meter and the police car shows none", () => {
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
      for (const id of [0, 1]) {
        const m = meterOf(id);
        assert.ok(m !== null && m >= 0 && m <= 1, `car ${id} (${w.race.racers[id]!.kind}) shows meter ${m}`);
      }
      assert.equal(meterOf(racers), null, "a police car has no nitrous");
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});
