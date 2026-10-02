import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { FRAME, finishSweep, frame, makeWorld, raceOnce, type World } from "./race-world.test-util.ts";
import { Track } from "./track.ts";
import city from "./tracks/city.json" with { type: "json" };
import oval from "./tracks/oval.json" with { type: "json" };

/** Frames until the race is over or `bound` race seconds pass (grid and countdown included). */
function runOut(w: World, bound: number): void {
  const state = { acc: 0 };
  for (let n = 0; w.race.phase !== "finished" && n * FRAME < bound; n++) frame(w, state);
}

for (const course of ["oval", "rally", "city", "stunt"]) finishSweep(course);

describe("race finish: city traffic", () => {
  it("city at aggression 0.7, seed 1, on a fresh world: every car finishes (oncoming traffic once held the AI-driven player car nose to nose until it was DNF)", () => {
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

describe("race finish: one lap", () => {
  it("a 1-lap oval race closes on laps with every car home on its single lap, placed and gapped by finish time", () => {
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
      rows.forEach((r, k) => assert.ok(Math.abs(r.gap! - (byTime[k]!.finishTime! - win)) < 1e-9, `P${r.place} gap ${r.gap}`));
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});

describe("race: spectator only", () => {
  it("Watch races an all-AI field with no player row; the camera follows pole, cycling reaches every car, and the race closes", () => {
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
      for (let k = 0; k < 5; k++) {
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

  it("a Watch campaign is the same all-AI field every round, scored into standings", () => {
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

describe("race: police chase", () => {
  it("police on: stakeouts park with sirens off, wake into pursuits with sirens on, Watch cycles onto them, police never race, the race closes", () => {
    const w = makeWorld();
    w.race.enter();
    try {
      w.race.command({ type: "options", options: { trackId: "oval", laps: 2, aiCount: 4, spectate: true, police: true } });
      w.race.reseed(1);
      w.race.command({ type: "start" });
      const racers = w.race.racers.length;
      let parkedDark = 0;
      let chasingLit = 0;
      let watched = false;
      const state = { acc: 0 };
      const bound = 4.5 + 2 * 3 * (new Track(oval).length / 9);
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
          for (let k = 0; k < racers + out.length && w.seat.carIndex < racers; k++) w.race.command({ type: "cycle", dir: 1 });
          assert.ok(w.seat.carIndex >= racers, "cycling never reached a police car on the course");
          assert.equal(w.race.hud().spectating, "Police");
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
});
