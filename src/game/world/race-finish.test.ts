import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { leadIns } from "./race-police-leadin.test-util.ts";
import { FRAME, frame, makeWorld, type World } from "./race-world.test-util.ts";
import { Track } from "./track.ts";
import oval from "./tracks/oval.json" with { type: "json" };

/** Frames until the race is over or `bound` race seconds pass (grid and countdown included). */
function runOut(w: World, bound: number): void {
  const state = { acc: 0 };
  for (let n = 0; w.race.phase !== "finished" && n * FRAME < bound; n++) frame(w, state);
}

/** Lead-in headings judged (a cop woken, its 1.8 s run) before the per-commit lead-in test stops its race. */
const LEAD_INS_CHECKED = 2;
/** Race seconds the first police car may take to come out on the city course (it does at 14 s with field seed 2). */
const POLICE_BOUND = 40;
/** Seconds Auto runs among the police and traffic cars (it may switch about once a second). */
const AUTO_SECONDS = 10;

describe("given a 1-lap oval race of 4 AI rivals and the AI-driven player slot, with field seed 1", () => {
  it("when the race is run to its end, then it closes on laps with every car home on its single lap, placed and gapped by finish time", () => {
    const w = makeWorld();
    w.race.enter();
    try {
      w.race.command({ type: "options", options: { trackId: "oval", laps: 1, aiCount: 4 } });
      w.race.reseed(1);
      w.race.command({ type: "start" });
      w.seat.mode = "follow";
      runOut(w, 4.5 + 3 * (new Track(oval).length / 9));
      const snap = w.race.snapshot()!;
      assert.equal(snap.phase, "finished");
      assert.equal(snap.laps, 1);
      assert.equal(snap.winBy, "laps");
      for (const c of snap.cars) {
        assert.equal(c.status, "finished", `${c.name} is ${c.status}`);
        assert.equal(c.lap, 1, `${c.name} laps`);
        assert.equal(c.lapTimes.length, 1, `${c.name} lap times`);
      }
      const rows = w.race.hud().results!;
      const byTime = [...snap.cars].sort((a, b) => a.finishTime! - b.finishTime!);
      assert.equal(rows.map((r) => r.id).join(), byTime.map((c) => c.id).join(), "classified in finish-time order");
      assert.deepEqual(rows.map((r) => r.place), [1, 2, 3, 4, 5]);
      const win = byTime[0]!.finishTime!;
      for (const [k, r] of rows.entries()) assert.ok(Math.abs(r.gap! - (byTime[k]!.finishTime! - win)) < 1e-9, `P${r.place} gap ${r.gap}`);
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});

describe("given a Watch race (spectator only) on the oval with 4 AI rivals and this browser's car racing as AI, field seed 1", () => {
  it("when the viewer cycles through the cars and the race runs out, then there is no player row, the camera follows pole, cycling reaches every car, and the race closes with an all-AI result", () => {
    const w = makeWorld();
    w.race.enter();
    try {
      w.race.command({ type: "options", options: { trackId: "oval", laps: 1, aiCount: 4, spectate: true } });
      w.race.reseed(1);
      w.race.command({ type: "start" });
      assert.deepEqual(w.race.racers.map((e) => e.kind), ["ai", "ai", "ai", "ai", "ai"], "this browser's car races as AI");
      const pole = w.race.snapshot()!.cars.find((c) => c.grid === 0)!;
      let hud = w.race.hud();
      assert.equal(hud.you, null);
      assert.equal(w.seat.mode, "follow");
      assert.equal(w.seat.carIndex, pole.id);
      assert.equal(hud.spectating, pole.name);
      const seen = new Set<number>();
      // Six entries: the other four cars, Auto (the car in view stays), then back to the first.
      for (let k = 0; k < 6; k++) {
        w.race.command({ type: "cycle", dir: 1 });
        seen.add(w.seat.carIndex);
      }
      assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4], "Q/E and the touch prev/next reach every car, our own AI one too");
      runOut(w, 4.5 + 3 * (new Track(oval).length / 9));
      hud = w.race.hud();
      assert.equal(hud.phase, "finished");
      assert.equal(hud.results!.length, 5);
      assert.ok(hud.standings.every((r) => !r.you), "no You row");
      assert.ok(hud.results!.every((r) => r.kind === "ai"));
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});

describe("given an oval race of 2 AI rivals started first as a driving race and then as a Watch race", () => {
  it("when a car is picked by hand and a new Watch race starts, then a Watch start sets the driver and the camera to Auto, a driving start leaves both off, a hand pick overrides Auto, and each new Watch start re-applies it", () => {
    const w = makeWorld();
    w.race.enter();
    try {
      w.race.command({ type: "options", options: { trackId: "oval", laps: 1, aiCount: 2, spectate: false } });
      w.race.reseed(1);
      w.race.command({ type: "start" });
      assert.equal(w.race.hud().auto, false);
      assert.equal(w.watchCams, 0);
      w.race.command({ type: "options", options: { trackId: "oval", laps: 1, aiCount: 2, spectate: true } });
      w.race.command({ type: "start" });
      assert.equal(w.race.hud().auto, true);
      assert.equal(w.watchCams, 1);
      w.race.command({ type: "cycle", dir: 1 });
      assert.equal(w.race.hud().auto, false, "a hand pick overrides");
      w.race.command({ type: "start" });
      assert.equal(w.race.hud().auto, true, "each new Watch start re-applies it");
      assert.equal(w.watchCams, 2);
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});

describe("given a Watch race on the oval with 4 AI rivals, whose driver list is the cars, then Auto, then back to car 0", () => {
  it("when the viewer cycles both ways and picks cars by hand or by the standings' Auto row, then Auto is one more entry (the car in view stays, named), a car pick turns it off, the Auto row turns it on, and Auto only switches to a car still racing, at most once a second", () => {
    const w = makeWorld();
    w.race.enter();
    try {
      w.race.command({ type: "options", options: { trackId: "oval", laps: 1, aiCount: 4, spectate: true } });
      w.race.reseed(1);
      w.race.command({ type: "start" });
      w.race.command({ type: "watch", id: 0 });
      assert.equal(w.race.hud().auto, false);
      for (let k = 0; k < 4; k++) w.race.command({ type: "cycle", dir: 1 });
      assert.equal(w.seat.carIndex, 4);
      assert.equal(w.race.hud().auto, false);
      w.race.command({ type: "cycle", dir: 1 });
      let hud = w.race.hud();
      assert.equal(hud.auto, true, "after the last car comes Auto");
      assert.equal(w.seat.carIndex, 4, "the car in view stays");
      assert.equal(hud.spectating, w.race.racers[4]!.name, "and is the one named");
      w.race.command({ type: "cycle", dir: 1 });
      assert.equal(w.seat.carIndex, 0, "then the list wraps to car 0");
      assert.equal(w.race.hud().auto, false);
      w.race.command({ type: "cycle", dir: -1 });
      assert.equal(w.race.hud().auto, true, "backwards from car 0 is Auto");
      w.race.command({ type: "cycle", dir: -1 });
      assert.equal(w.seat.carIndex, 4);
      assert.equal(w.race.hud().auto, false);
      w.race.command({ type: "watch", id: -1 });
      assert.equal(w.race.hud().auto, true, "the standings' Auto row");
      assert.equal(w.seat.carIndex, 4);
      w.race.command({ type: "watch", id: 2 });
      assert.equal(w.race.hud().auto, false, "a car picked by hand");
      assert.equal(w.seat.carIndex, 2);

      // Off, autoStep leaves the camera alone; on, it switches only to racing cars, no faster than once a second.
      const state = { acc: 0 };
      for (let n = 0; n < 300; n++) {
        frame(w, state);
        w.race.autoStep(-1, true);
      }
      assert.equal(w.seat.carIndex, 2);
      w.race.command({ type: "watch", id: -1 });
      let prev = w.seat.carIndex;
      let at = -Infinity;
      let switches = 0;
      const bound = 4.5 + 3 * (new Track(oval).length / 9);
      for (let n = 0; w.race.phase !== "finished" && n * FRAME < bound; n++) {
        frame(w, state);
        w.race.autoStep(-1, true);
        if (w.seat.carIndex === prev) continue;
        prev = w.seat.carIndex;
        switches++;
        assert.equal(w.race.snapshot()!.cars.find((c) => c.id === prev)!.status, "racing", `switched to car ${prev} at ${w.race.time.toFixed(1)} s`);
        assert.ok(w.race.time - at >= 1, `two switches ${(w.race.time - at).toFixed(2)} s apart`);
        at = w.race.time;
        hud = w.race.hud();
        assert.equal(hud.auto, true);
        assert.equal(hud.spectating, w.race.racers[prev]!.name);
      }
      assert.ok(switches >= 1, "Auto never moved off its first car in a whole race");
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});

describe("given a Watch race on the city course with police and traffic cars among the racers", () => {
  it("when the viewer cycles with Q/E and Auto runs, then they visit racers only, never a police or traffic car", () => {
    const w = makeWorld();
    w.race.enter();
    try {
      w.race.command({ type: "options", options: { trackId: "city", laps: 1, aiCount: 4, spectate: true, police: true } });
      w.race.reseed(2);
      w.race.command({ type: "start" });
      const state = { acc: 0 };
      const racers = w.race.racers.length;
      const policeOut = () => w.live().some((c, i) => i >= racers && c.group.visible && c.style.id === "police");
      // Police park beside the course from a third of the first lap on: the moment starts when the first one is out among the traffic.
      for (let n = 0; n < POLICE_BOUND / FRAME && !policeOut(); n++) frame(w, state);
      assert.ok(policeOut(), `no police car came out within ${POLICE_BOUND} s`);
      assert.ok(w.live().length > racers, "the fixture has police and traffic cars past the racers");
      w.race.command({ type: "watch", id: 0 });
      for (let k = 0; k < 3 * (racers + 1); k++) {
        w.race.command({ type: "cycle", dir: k % 2 === 0 ? 1 : -1 });
        assert.ok(w.seat.carIndex < racers, `cycling landed on car ${w.seat.carIndex}, past the ${racers} racers`);
      }
      w.race.command({ type: "watch", id: -1 });
      for (let n = 0; n < AUTO_SECONDS / FRAME; n++) {
        frame(w, state);
        w.race.autoStep(-1, true);
        assert.ok(w.seat.carIndex < racers, `Auto picked car ${w.seat.carIndex} at ${w.race.time.toFixed(1)} s, past the ${racers} racers`);
      }
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});

describe("given a Watch campaign with 3 AI rivals and this browser's car racing as AI", () => {
  it("when the campaign starts, then it has no player row, a car under watch, and standings made of AI cars only", () => {
    const w = makeWorld();
    w.race.enter();
    try {
      w.race.command({ type: "options", options: { laps: 1, aiCount: 3, spectate: true } });
      w.race.command({ type: "campaign" });
      const hud = w.race.hud();
      assert.equal(hud.mode, "campaign");
      assert.equal(hud.you, null);
      assert.notEqual(hud.spectating, null);
      assert.deepEqual(hud.campaign!.standings.map((r) => r.kind), ["ai", "ai", "ai", "ai"]);
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});

describe("given a 1-lap Watch race of 4 AI rivals on the oval with police cars on", () => {
  it("when the race runs out, then stakeouts park with sirens off, wake into pursuits with sirens on, Watch cycling never lands on them, police never race or appear in the results, and the race closes", () => {
    const w = makeWorld();
    w.race.enter();
    try {
      w.race.command({ type: "options", options: { trackId: "oval", laps: 1, aiCount: 4, spectate: true, police: true } });
      w.race.reseed(1);
      w.race.command({ type: "start" });
      const racers = w.race.racers.length;
      let parkedDark = 0;
      let chasingLit = 0;
      let watched = false;
      const state = { acc: 0 };
      const bound = 4.5 + 3 * (new Track(oval).length / 9);
      for (let n = 0; w.race.phase !== "finished" && n * FRAME < bound; n++) {
        frame(w, state);
        if (n % 30 !== 0) continue;
        const out = w.live().filter((c, i) => i >= racers && c.group.visible);
        assert.ok(out.every((c) => c.style.id === "police"), "only police cars join the racers (oval has no traffic)");
        for (const c of out) {
          if (c.sirens) chasingLit++;
          else if (c.velocity.length() < 0.3) parkedDark++;
        }
        if (!watched && out.length > 0) {
          for (let k = 0; k < racers + out.length; k++) {
            w.race.command({ type: "cycle", dir: 1 });
            assert.ok(w.seat.carIndex < racers, `cycling reached car ${w.seat.carIndex}, a police car on the course`);
          }
          watched = true;
        }
      }
      assert.equal(w.race.phase, "finished", "the race closed");
      assert.ok(w.race.policeStats!.pursuits >= 1, `pursuits ${w.race.policeStats!.pursuits}`);
      assert.ok(parkedDark > 0, "no parked police car with its sirens off was ever seen");
      assert.ok(chasingLit > 0, "no police car ever ran its sirens");
      const results = w.race.hud().results!;
      assert.equal(results.length, racers);
      assert.ok(results.every((r) => r.id < racers && w.live()[r.id]!.style.id !== "police"), "a police car is in the results");
    } finally {
      w.race.exit();
      setGround(null);
    }
  });

  it("when one stakeout's cop wakes as a racer passes and its lead-in runs its 1.8 s, then it lined up behind the racer on the road (heading converging) without a side T-bone", () => {
    // The first two lead-in headings judged on the oval (seed 1), then the race stops: the moment is the cops' wake and lead-in, not the 2 laps after it.
    const r = leadIns(0, 1, "oval", (checked) => checked >= LEAD_INS_CHECKED);
    assert.ok(r.wakes >= LEAD_INS_CHECKED, `only ${r.wakes} cops woke`);
    assert.ok(r.converged >= 1, `no lead-in heading converged (${r.converged} did, ${r.diverged.length} did not: ${r.diverged.join("; ")})`);
    assert.equal(r.diverged.length, 0, `lead-in headings that did not converge: ${r.diverged.join("; ")}`);
    assert.equal(r.tbones, 0, "a police car T-boned its target during its lead-in");
  });
});
