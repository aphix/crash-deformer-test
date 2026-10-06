import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BENCH_RACE } from "../engine/engine-bench-plan.ts";
import { decodeShare } from "../hud/share-url.ts";
import { DEFAULT_RACE_OPTIONS, type RaceOptions } from "../match/types.ts";
import { setGround } from "./ground.ts";
import { frame, makeWorld, type World } from "./race-world.test-util.ts";

/** A world in race mode (the setup card up), run through `body` and always left again. */
function inRaceMode(body: (w: World) => void): void {
  const w = makeWorld();
  w.race.enter();
  try {
    body(w);
  } finally {
    w.race.exit();
    setGround(null);
  }
}

/** The player's own race options as the setup card and the share URL read them (the race scene's `#` is built from these). */
const playersOptions = (w: World): RaceOptions => w.race.hud().options;

/** Every one of the player's race options is still its default, field by field so a failure names the field. */
function assertDefaultOptions(w: World, when = "the player's options"): void {
  const options = playersOptions(w);
  for (const key of Object.keys(DEFAULT_RACE_OPTIONS) as (keyof RaceOptions)[]) assert.equal(options[key], DEFAULT_RACE_OPTIONS[key], `${when}: ${key}`);
}

describe("given a player on the default race options, running the bench's own race", () => {
  it("when the bench sets its race up and then runs it, then it races its own course, laps and field while the player's options and the setup card hold no bench value", () => {
    inRaceMode((w) => {
      w.race.command(BENCH_RACE);
      assertDefaultOptions(w, "right after the bench applied its setup");
      w.race.reseed(1);
      w.race.command({ type: "start" });
      const state = { acc: 0 };
      for (let n = 0; n < 10 * 60; n++) frame(w, state);
      const hud = w.race.hud();
      assert.equal(hud.trackName, "Harbour Streets");
      assert.equal(hud.laps, 9);
      assert.equal(hud.field, 16);
      assertDefaultOptions(w, "while the bench race runs");
    });
  });

  it("when the race is left for the setup card, then the player's own options are back for the next race", () => {
    inRaceMode((w) => {
      w.race.command(BENCH_RACE);
      w.race.command({ type: "start" });
      w.race.command({ type: "quit" });
      assert.equal(w.race.menu, "setup");
      assertDefaultOptions(w);
      w.race.command({ type: "start" });
      const hud = w.race.hud();
      assert.equal(hud.laps, DEFAULT_RACE_OPTIONS.laps);
      assert.equal(hud.field, DEFAULT_RACE_OPTIONS.aiCount + 1);
      assert.equal(hud.trackName, "Brickyard Oval");
    });
  });
});

describe("given a player who chose the stunt course and 5 laps", () => {
  it("when a campaign begins, then the player's choices are untouched while round 1 runs on the campaign's own course", () => {
    inRaceMode((w) => {
      w.race.command({ type: "options", options: { trackId: "stunt", laps: 5 } });
      w.race.command({ type: "campaign" });
      assert.equal(w.race.hud().mode, "campaign");
      assert.notEqual(w.race.hud().trackName, "Crossover Canyon", "round 1 is not the player's course");
      assert.equal(playersOptions(w).trackId, "stunt");
      assert.equal(playersOptions(w).laps, 5);
    });
  });
});

describe("given the setup card on the default course", () => {
  it("when a saved highlight from the city course plays and then ends, then the field stands on the city meanwhile and on the player's course after, with the player's options never changed", () => {
    inRaceMode((w) => {
      w.race.command({ type: "program", options: { trackId: "city" } });
      w.race.reset();
      assert.equal(w.race.hud().trackName, "Harbour Streets");
      assertDefaultOptions(w);
      w.race.command({ type: "program", options: null });
      w.race.reset();
      assert.equal(w.race.hud().trackName, "Brickyard Oval");
      assertDefaultOptions(w);
    });
  });
});

describe("given a pasted share URL that names the city course, 9 laps, 15 AI cars, full aggression and police", () => {
  it("when the page applies it as the player's own settings, then the race options hold exactly those settings", () => {
    inRaceMode((w) => {
      const t = decodeShare("#scene=race&track=city&laps=9&ai=15&aggr=1&police=1");
      w.race.command({ type: "options", options: { trackId: t.track, laps: t.laps, aiCount: t.ai, aggression: t.aggr, police: t.police, noReset: t.noreset, spectate: t.spectate } });
      assert.deepEqual(playersOptions(w), { trackId: "city", laps: 9, aiCount: 15, aggression: 1, police: true, noReset: false, spectate: false });
    });
  });
});
