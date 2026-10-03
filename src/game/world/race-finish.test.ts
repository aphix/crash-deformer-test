import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { FRAME, finishSweep, frame, makeWorld, raceOnce, type World } from "./race-world.test-util.ts";
import { blankProjection, Track } from "./track.ts";
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

  it("Auto is one more entry in the driver list (cars, then Auto, then car 0); a car pick turns it off, watch -1 turns it on, and autoStep only ever lands on a car still racing", () => {
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

  it("with police and traffic on the course, Q/E cycling and Auto visit racers only", () => {
    const w = makeWorld();
    w.race.enter();
    try {
      w.race.command({ type: "options", options: { trackId: "city", laps: 1, aiCount: 4, spectate: true, police: true } });
      w.race.reseed(2);
      w.race.command({ type: "start" });
      const state = { acc: 0 };
      // Police park beside the course from a third of the first lap on, and give chase.
      for (let n = 0; n < 40 / FRAME; n++) frame(w, state);
      assert.ok(w.live().length > w.race.racers.length, "the fixture has police or traffic cars past the racers");
      const racers = w.race.racers.length;
      w.race.command({ type: "watch", id: 0 });
      for (let k = 0; k < 3 * (racers + 1); k++) {
        w.race.command({ type: "cycle", dir: k % 2 === 0 ? 1 : -1 });
        assert.ok(w.seat.carIndex < racers, `cycling landed on car ${w.seat.carIndex}, past the ${racers} racers`);
      }
      w.race.command({ type: "watch", id: -1 });
      for (let n = 0; n < 60 / FRAME; n++) {
        frame(w, state);
        w.race.autoStep(-1, true);
        assert.ok(w.seat.carIndex < racers, `Auto picked car ${w.seat.carIndex} at ${w.race.time.toFixed(1)} s, past the ${racers} racers`);
      }
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
  it("police on: stakeouts park with sirens off, wake into pursuits with sirens on, Watch cycling never lands on them, police never race, the race closes", () => {
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

  it("police wait until a racer passes their stakeout, then lead in behind it (heading converging, no side T-bone) before the pursuit attacks", () => {
    const w = makeWorld();
    w.race.enter();
    try {
      w.race.command({ type: "options", options: { trackId: "oval", laps: 2, aiCount: 4, spectate: true, police: true } });
      w.race.reseed(1);
      w.race.command({ type: "start" });
      const track = new Track(oval);
      const L = track.length;
      const proj = blankProjection();
      const arc = (i: number) => track.project(w.cars[i]!.group.position.x, w.cars[i]!.group.position.z, -1, proj).s;
      const ahead = (s: number, from: number) => s - from - L * Math.round((s - from) / L);
      const angle = (ax: number, az: number, bx: number, bz: number) => Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
      const racers = w.race.racers.length;
      // Each racer's velocity where it last drove, per 2 m of road: a police car following its path matches it there.
      const trail = Array.from({ length: racers }, () => new Float64Array(Math.ceil(L / 2) * 2));
      // Per police car: its parked spot's arc (NaN: not parked), the lead-in window's target and end, last racer
      // contact, and last contact with any car (a lead-in knocked off line by a pack-mate says nothing of its steering).
      const parkS = new Float64Array(64).fill(NaN);
      const target = new Int32Array(64).fill(-1);
      const leadEnd = new Float64Array(64);
      const angle0 = new Float64Array(64).fill(NaN);
      const touched = new Float64Array(64).fill(-1e9);
      const bumped = new Float64Array(64).fill(-1e9);
      let t = 0;
      let wakes = 0;
      let converged = 0;
      let tbones = 0;
      let pursuitHits = 0;
      const hit = w.step.pairHit;
      w.step.pairHit = (a, b, h, first) => {
        hit?.(a, b, h, first);
        if (!first) return;
        if (a >= racers) bumped[a] = t;
        if (b >= racers) bumped[b] = t;
        if (a >= racers === b >= racers) return;
        const [p, r] = a >= racers ? [a, b] : [b, a];
        touched[p] = t;
        if (t >= leadEnd[p]!) {
          pursuitHits++;
          return;
        }
        if (r !== target[p]) return;
        // A T-bone: the normal across the target's flank with the police car crossways to it.
        const ty = w.cars[r]!.yaw;
        const py = w.cars[p]!.yaw;
        const nAlong = Math.abs(h.normal.x * Math.sin(ty) + h.normal.z * Math.cos(ty));
        const cross = Math.abs(Math.sin(py) * Math.sin(ty) + Math.cos(py) * Math.cos(ty));
        if (nAlong < 0.5 && cross < 0.5) tbones++;
      };
      const state = { acc: 0 };
      const bound = 4.5 + 2 * 3 * (new Track(oval).length / 9);
      for (let n = 0; w.race.phase !== "finished" && n * FRAME < bound; n++) {
        frame(w, state);
        t = n * FRAME;
        for (let r = 0; r < racers; r++) {
          const k = Math.floor(arc(r) / 2) * 2;
          trail[r]![k] = w.cars[r]!.velocity.x;
          trail[r]![k + 1] = w.cars[r]!.velocity.z;
        }
        for (let i = racers; i < w.live().length; i++) {
          const car = w.cars[i]!;
          const v = car.velocity;
          const speed = Math.hypot(v.x, v.z);
          if (!car.group.visible) {
            parkS[i] = NaN;
            continue;
          }
          if (speed < 0.3 && !car.sirens && t >= leadEnd[i]!) {
            parkS[i] = arc(i);
            continue;
          }
          if (!Number.isNaN(parkS[i]!) && speed > 1) {
            // It moved: a racer must be past its spot (a patrol beat plus its pull-away), unless one just knocked it.
            let best = -1;
            let bestD = Infinity;
            for (let r = 0; r < racers; r++) {
              const d = ahead(arc(r), parkS[i]!);
              if (d >= 0 && d < bestD) [best, bestD] = [r, d];
            }
            assert.ok(bestD < 80 || t - touched[i]! < 0.5, `police car ${i} pulled away at ${t.toFixed(2)} s with no racer past its spot (nearest past ${bestD.toFixed(0)} m)`);
            parkS[i] = NaN;
            target[i] = best;
            leadEnd[i] = t + 1.8;
            angle0[i] = NaN;
            wakes++;
          }
          const r = target[i]!;
          if (r < 0 || t >= leadEnd[i]! || speed < 3) continue;
          const k = Math.floor(arc(i) / 2) * 2;
          const a = angle(v.x, v.z, trail[r]![k]!, trail[r]![k + 1]!);
          if (Number.isNaN(angle0[i]!)) angle0[i] = a;
          if (t + FRAME >= leadEnd[i]! && bumped[i]! < leadEnd[i]! - 1.8) {
            assert.ok(a < angle0[i]! || a < 0.2, `police car ${i}'s heading to its target's went ${angle0[i]!.toFixed(2)} → ${a.toFixed(2)} rad over its lead-in`);
            converged++;
          }
        }
      }
      assert.equal(w.race.phase, "finished", "the race closed");
      assert.ok(wakes >= 4 && converged >= 3, `wakes ${wakes}, unbumped lead-ins converged ${converged}`);
      assert.equal(tbones, 0, "a police car T-boned its target during its lead-in");
      assert.ok(pursuitHits >= 1, "the pursuit after the lead-in never touched a racer");
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});
