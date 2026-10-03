import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { makeWorld, type World } from "./race-world.test-util.ts";

/** A race start, a retry and the next race are scene resets like a sandbox one: the last run's debris, dummies and fx go first. */
describe("a race that starts again empties the scene first", () => {
  let w: World;
  before(() => {
    w = makeWorld();
    w.race.enter();
  });
  after(() => {
    w.race.exit();
    setGround(null);
  });

  it("bad: start, retry and campaign each ask the engine to clear once", () => {
    for (const cmd of [{ type: "start" }, { type: "retry" }, { type: "campaign" }] as const) {
      const before = w.clears;
      w.race.command(cmd);
      assert.equal(w.clears - before, 1, `${cmd.type}: one clear`);
    }
  });

  it("bad: re-parking the grid in setup (a field change) is not a run and clears nothing", () => {
    w.race.command({ type: "quit" });
    const before = w.clears;
    w.race.command({ type: "options", options: { aiCount: 3 } });
    assert.equal(w.clears, before);
  });
});
