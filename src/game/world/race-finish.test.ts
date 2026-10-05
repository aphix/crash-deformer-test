import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { FRAME, finishSweep, frame, makeWorld, raceOnce, type World } from "./race-world.test-util.ts";
import { blankPoint, blankProjection, Track } from "./track.ts";
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

  it("a Watch race starts on Auto driver + Auto camera; a driving race starts on neither; a hand pick still overrides", () => {
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

  /**
   * One 2-lap police race on the oval (field seed 1), its frame accumulator starting at `phase` seconds: the same field
   * and the same cops, but the physics steps partition the frames differently, so the cars take a different chaotic
   * path through it. Every lead-in's heading is checked as it ends; the counts and the lead-ins whose heading did not
   * converge come back for the pooled floors and caps.
   */
  function leadIns(phase: number, seed = 1): { wakes: number; converged: number; diverged: string[]; offRoadLeadIns: number; tbones: number; pursuitHits: number; leadInPairs: number } {
    const w = makeWorld();
    w.race.enter();
    try {
      w.race.command({ type: "options", options: { trackId: "oval", laps: 2, aiCount: 4, spectate: true, police: true } });
      w.race.reseed(seed);
      w.race.command({ type: "start" });
      const track = new Track(oval);
      const L = track.length;
      const proj = blankProjection();
      const arc = (i: number) => track.project(w.cars[i]!.group.position.x, w.cars[i]!.group.position.z, -1, proj).s;
      const ahead = (s: number, from: number) => s - from - L * Math.round((s - from) / L);
      const angle = (ax: number, az: number, bx: number, bz: number) => Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
      const racers = w.race.racers.length;
      const tangent = blankPoint();
      // Per racer, the cells of the road (per 2 m of it) it has driven on: a lead-in whose target never drove its cell has no road there to line up on.
      const drove = Array.from({ length: racers }, () => new Uint8Array(Math.ceil(L / 2)));
      // Per police car: its parked spot's arc (NaN: not parked), the lead-in window's target and end, and its last
      // contact with any car (a parked car knocked along, or a lead-in knocked off line by a pack-mate, says nothing of its steering).
      const parkS = new Float64Array(64).fill(NaN);
      const target = new Int32Array(64).fill(-1);
      const leadEnd = new Float64Array(64);
      const angle0 = new Float64Array(64).fill(NaN);
      const bumped = new Float64Array(64).fill(-1e9);
      // Per police car: a pack-mate came within `CROWD` m during its lead-in (the pack guard swerved it round the mate, which
      // says nothing of its steering toward the target, as a knock from one does not).
      const CROWD = 8;
      const crowded = new Uint8Array(64);
      // Per police car: a stretch of the target's heading the cop is matching was never driven on the road (the target merged off a
      // shortcut there), so the lead-in has no reference and is not checked; `offRoadLeadIns` counts those.
      const offRoad = new Uint8Array(64);
      let t = 0;
      let wakes = 0;
      let converged = 0;
      let offRoadLeadIns = 0;
      let tbones = 0;
      let pursuitHits = 0;
      const diverged: string[] = [];
      // Pairs of police cars that touched while both were inside their lead-in windows (a stakeout pair parks 12 m apart, one
      // facing each racer's travel and one against it, so both full-throttle lead-ins met head-on).
      const leadInPairs = new Set<number>();
      const hit = w.step.pairHit;
      w.step.pairHit = (a, b, h, first) => {
        hit?.(a, b, h, first);
        if (!first) return;
        if (a >= racers && b >= racers && t < leadEnd[a]! && t < leadEnd[b]!) leadInPairs.add((a * 64 + b) * 1e4 + Math.round(leadEnd[a]!));
        if (a >= racers) bumped[a] = t;
        if (b >= racers) bumped[b] = t;
        if (a >= racers === b >= racers) return;
        const [p, r] = a >= racers ? [a, b] : [b, a];
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
      const state = { acc: phase };
      const bound = 4.5 + 2 * 3 * (new Track(oval).length / 9);
      for (let n = 0; w.race.phase !== "finished" && n * FRAME < bound; n++) {
        frame(w, state);
        t = n * FRAME;
        for (let r = 0; r < racers; r++) {
          const p = w.cars[r]!.group.position;
          const on = track.project(p.x, p.z, -1, proj);
          // Only where the racer drives the road: a racer merging off a shortcut has no road under it, so the cop that lines
          // up behind it has no stretch of road to line up on (seed 1, cop 6 at 38 s: the target merged off the road).
          // Cells never driven stay 0: no sample.
          if (Math.abs(on.lateral) > track.path.half[on.k]!) continue;
          drove[r]![Math.floor(on.s / 2)] = 1;
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
            assert.ok(bestD < 80 || t - bumped[i]! < 0.5, `police car ${i} pulled away at ${t.toFixed(2)} s with no racer past its spot (nearest past ${bestD.toFixed(0)} m)`);
            parkS[i] = NaN;
            target[i] = best;
            leadEnd[i] = t + 1.8;
            angle0[i] = NaN;
            crowded[i] = 0;
            offRoad[i] = 0;
            wakes++;
          }
          const r = target[i]!;
          if (r < 0 || t >= leadEnd[i]! || speed < 3) continue;
          for (let j = racers; j < w.live().length; j++) {
            if (j !== i && w.cars[j]!.group.visible && w.cars[i]!.group.position.distanceTo(w.cars[j]!.group.position) < CROWD) crowded[i] = 1;
          }
          const s = arc(i);
          if (!drove[r]![Math.floor(s / 2)]) offRoad[i] = 1;
          // The cop's heading against the road's direction of travel under it: lining up behind its target on the road.
          const road = track.pointAt(s, tangent);
          const a = angle(v.x, v.z, road.tx, road.tz);
          if (Number.isNaN(angle0[i]!)) angle0[i] = a;
          if (t + FRAME >= leadEnd[i]! && bumped[i]! < leadEnd[i]! - 1.8 && !crowded[i]) {
            if (offRoad[i]) {
              offRoadLeadIns++;
              continue;
            }
            if (a < angle0[i]! || a < 0.2) converged++;
            else diverged.push(`seed ${seed} car ${i} at ${t.toFixed(1)} s: ${angle0[i]!.toFixed(2)} → ${a.toFixed(2)} rad`);
          }
        }
      }
      assert.equal(w.race.phase, "finished", "the race closed");
      assert.equal(tbones, 0, "a police car T-boned its target during its lead-in");
      return { wakes, converged, diverged, offRoadLeadIns, tbones, pursuitHits, leadInPairs: leadInPairs.size };
    } finally {
      w.race.exit();
      setGround(null);
    }
  }

  // A lead-in's heading is read against the road's direction of travel under the cop (it lines up behind its target on the
  // road) and converges when it ends under 0.2 rad or under where it started. It was read against the target's own last
  // velocity in that cell, with every lead-in required to converge. Measured on main ca86b51 and on this head over seeds 1-60
  // at start phases 0 and 0.008 (the pools below; 87 and 84 distinct lead-ins, 98 together, since the phases and the two
  // trees replay many of the same ones): the racer's cell failed 6 of 87 on main and 5 of 84 here (8 of 98, 8.2 %). A racer's
  // line is not the road: it leads the tangent through a corner (seed 6, cop 5 at 67 s: 0.26 → 0.18 against the road, 0.28 →
  // 0.35 against the racer, steer 0.48, no mate near) and swerves in a cell (seeds 30 and 48, cop 5 at 15 s: the racer 0.2 rad
  // off the road there, 0.25 → 0.19 against the road). The road fails 3 of 98 (3.1 %), none of them the cop's own steer: seed 27
  // cop 9 (32.8 s) and seed 32 cop 5 (40.0 s, on main) are a stakeout pair woken together, the pack-mate guard turning the cop
  // off a head-on with its mate 12 m away (steer ±1 and brakes for 0.5-0.8 s; error 0.25 → 0.54 and 0.15 → 0.33); seed 32 cop 9
  // (28.5 s) is a merge on a bend, where the error must rise while the cop turns into the road (0.18 → 0.23, 10 m to cross). So
  // a pool of n checked lead-ins false-fails when more than k fail, at 3.1 %: 4 samples n = 7, k = 1: 1.9 %; 12 seeds n = 15,
  // k = 2: 1.0 % (k = 0 would false-fail 20 % and 38 %). A real break (no lead-in lines up) fails most of them. Do not loosen k,
  // or tighten it back to every lead-in, without re-measuring on that many seeds.
  const DIVERGED_OF_SAMPLES = 1;
  const DIVERGED_OF_SEEDS = 2;

  it("police wait until a racer passes their stakeout, then lead in behind it (heading converging, no side T-bone) before the pursuit attacks", () => {
    // Four samples: four fields (seeds: each rolls its rivals' aggression and the cops' beats), each started at its own
    // phase of one frame in 4 ms steps. Racers that never touch (the contact guard) no longer let one field's phases
    // fall apart into chaotic samples, so the samples differ by construction. The lead-ins a pack-mate rams (cop on cop,
    // unbumped by the target) do not count, so a single race converges 0 to 6 of its 6; samples that play out
    // identically are one sample, and the fields must really differ.
    const seen = new Set<string>();
    let wakes = 0;
    let converged = 0;
    let offRoad = 0;
    let pursuitHits = 0;
    const diverged: string[] = [];
    for (const [phase, seed] of [[0, 1], [0.004, 2], [0.008, 3], [0.012, 4]] as const) {
      const r = leadIns(phase, seed);
      if (seen.has(JSON.stringify(r))) continue;
      seen.add(JSON.stringify(r));
      wakes += r.wakes;
      converged += r.converged;
      diverged.push(...r.diverged);
      offRoad += r.offRoadLeadIns;
      pursuitHits += r.pursuitHits;
    }
    assert.ok(seen.size >= 3, `only ${seen.size} different samples out of 4 fields`);
    assert.ok(wakes >= 4 && converged >= 3 && offRoad <= converged, `wakes ${wakes}, unbumped lead-ins converged ${converged}, ${offRoad} left out for a target off the road`);
    assert.ok(diverged.length <= DIVERGED_OF_SAMPLES, `${diverged.length} of ${converged + diverged.length} lead-in headings did not converge: ${diverged.join("; ")}`);
    assert.ok(pursuitHits >= 1, "the pursuit after the lead-in never touched a racer");
  });

  it("two police cars never meet during their lead-ins (a stakeout pair woken together drove into each other at 17-25 m/s)", () => {
    let wakes = 0;
    let converged = 0;
    let offRoad = 0;
    const diverged: string[] = [];
    const met: string[] = [];
    for (let seed = 1; seed <= 12; seed++) {
      const r = leadIns(0, seed);
      wakes += r.wakes;
      converged += r.converged;
      diverged.push(...r.diverged);
      offRoad += r.offRoadLeadIns;
      if (r.leadInPairs > 0) met.push(`seed ${seed}: ${r.leadInPairs} pairs`);
    }
    assert.ok(wakes >= 40, `only ${wakes} lead-ins over 12 seeds`);
    // The headings really were checked (15 here, 1 more left out for a target off the road), so this cannot pass on an empty check.
    assert.ok(converged >= 8 && offRoad <= converged, `${converged} lead-in headings checked, ${offRoad} left out for a target off the road (of ${wakes})`);
    assert.ok(diverged.length <= DIVERGED_OF_SEEDS, `${diverged.length} of ${converged + diverged.length} lead-in headings did not converge: ${diverged.join("; ")}`);
    assert.deepEqual(met, [], `lead-in pairs that touched (of ${wakes} lead-ins)`);
  });
});
