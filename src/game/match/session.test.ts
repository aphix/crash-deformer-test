import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Track, blankPoint, blankProjection, pointOn } from "../world/track.ts";
import { BUST, CLEARANCE, COUNTDOWN, DRAFT, FINISH_GRACE, GRID_TIME, RESPAWN_DELAY, RaceSession, WRONG_WAY_ON, startLights } from "./session.ts";
import { Campaign, CAMPAIGN_POINTS } from "./campaign.ts";
import type { CarPose, Entrant, RaceEvent, RaceResultRow } from "./types.ts";
import { square as squareFile } from "../world/track.test-util.ts";
import { assertSameDigest } from "../vehicle/test-support.ts";
import oval from "../world/tracks/oval.json" with { type: "json" };
import { PoliceBrain, type PoliceWorld } from "../ai/police.ts";
import { RaceBrain } from "../ai/race-ai.ts";
import { blankAiCar, type AiCar } from "../ai/derby-ai.ts";

const DT = 1 / 60;

function field(n: number): Entrant[] {
  return Array.from({ length: n }, (_, i) => ({ id: i, name: `Car ${i}`, kind: i === 0 ? "player" : "ai", aggression: 0 }));
}

type Pose = { x: number; z: number; vx: number; vz: number; alive?: boolean };
/** Where a car is at race time `t` (end of the step). */
type Driver = (t: number) => Pose;
type Pt = { x: number; z: number };

const _pt = blankPoint();

/** Along the centreline (offset `lat`, + = left) from arc length `s0` at `v` m/s once the lights are green. */
function along(track: Track, s0: number, v: number, lat = 0): Driver {
  return (t) => {
    const p = track.pointAt(s0 + v * Math.max(0, t), _pt);
    return { x: p.x + p.tz * lat, z: p.z - p.tx * lat, vx: p.tx * v, vz: p.tz * v };
  };
}

/** Start from grid slot `i` (behind the line). */
function fromGrid(track: Track, i: number, v: number): Driver {
  const slot = track.gridSlot(i);
  const p = blankProjection();
  track.project(slot.x, slot.z, -1, p);
  return along(track, p.s, v, p.lateral);
}

/** Constant speed along a polyline from green; parked at its end. */
function polyline(pts: Pt[], v: number): Driver {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z));
  return (t) => {
    const d = Math.min(cum[cum.length - 1]!, v * Math.max(0, t));
    let k = 1;
    while (k < cum.length - 1 && cum[k]! < d) k++;
    const a = pts[k - 1]!;
    const b = pts[k]!;
    const seg = cum[k]! - cum[k - 1]! || 1;
    const f = (d - cum[k - 1]!) / seg;
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, vx: ((b.x - a.x) / seg) * v, vz: ((b.z - a.z) / seg) * v };
  };
}

function samples(at: (s: number) => Pt, from: number, to: number, step = 2): Pt[] {
  const out: Pt[] = [];
  for (let s = from; s <= to; s += step) out.push(at(s));
  return out;
}

function centreline(track: Track, from: number, to: number, step = 2): Pt[] {
  return samples((s) => {
    const p = track.pointAt(s, _pt);
    return { x: p.x, z: p.z };
  }, from, to, step);
}

/** Step until race time `to` (or the race ends / `until` holds); returns every event. */
function runTo(s: RaceSession, drivers: Driver[], to: number, until?: (s: RaceSession) => boolean): RaceEvent[] {
  const poses: CarPose[] = drivers.map(() => ({ x: 0, z: 0, yaw: 0, vx: 0, vz: 0, alive: true }));
  const events: RaceEvent[] = [];
  while (s.time < to - 1e-9 && s.phase !== "finished") {
    const t = s.time + DT;
    drivers.forEach((d, i) => {
      const p = d(t);
      const pose = poses[i]!;
      pose.x = p.x;
      pose.z = p.z;
      pose.vx = p.vx;
      pose.vz = p.vz;
      pose.yaw = Math.atan2(p.vx, p.vz);
      pose.alive = p.alive ?? true;
    });
    s.step(DT, poses);
    events.push(...s.events());
    if (until?.(s)) break;
  }
  return events;
}

const count = (ev: RaceEvent[], type: RaceEvent["type"]) => ev.filter((e) => e.type === type).length;

const square = new Track(squareFile());
const ovalTrack = new Track(oval);

describe("race rules", () => {
  it("countdown: off on the grid, red, yellow, then green and one go event at 0", () => {
    assert.deepEqual([-5, -3.2, -2.9, -1.1, -0.9, -0.01, 0, 1.4, 1.6].map(startLights), [0, 0, 1, 1, 2, 2, 3, 3, 0]);
    const s = new RaceSession(square, field(2), { laps: 1, noReset: false });
    assert.equal(s.phase, "grid");
    assert.ok(Math.abs(s.time + GRID_TIME + COUNTDOWN) < 1e-9);
    const parked = [fromGrid(square, 0, 0), fromGrid(square, 1, 0)];
    runTo(s, parked, -COUNTDOWN + 0.1);
    assert.equal(s.phase, "countdown");
    const ev = runTo(s, parked, 0.1);
    assert.equal(s.phase, "racing");
    assert.equal(count(ev, "go"), 1);
  });

  it("laps count only over the line with every checkpoint in order; the first car home wins", () => {
    const s = new RaceSession(square, field(2), { laps: 2, noReset: false });
    const ev = runTo(s, [fromGrid(square, 0, 20), fromGrid(square, 1, 18)], 120);
    const laps = ev.filter((e) => e.type === "lap");
    assert.deepEqual(laps.map((e) => e.type === "lap" && [e.id, e.lap]), [[0, 1], [1, 1], [0, 2], [1, 2]]);
    const lap0 = s.cars[0]!.lapTimes;
    // Lap 1 is timed from green (the grid is 6 m behind the line), lap 2 line to line.
    assert.ok(Math.abs(lap0[1]! - square.length / 20) < 0.02, `lap 2 ${lap0[1]} vs ${square.length / 20}`);
    assert.ok(Math.abs(lap0[0]! - lap0[1]! - 6 / 20) < 0.02, "lap 1 includes the run to the line");
    assert.equal(s.cars[0]!.bestLap, Math.min(...lap0));
    assert.equal(s.winnerId, 0);
    assert.equal(s.winBy, "laps");
    assert.equal(s.phase, "finished");
    const res = s.results();
    assert.deepEqual(res.map((r) => [r.id, r.place, r.status]), [[0, 1, "finished"], [1, 2, "finished"]]);
    assert.equal(res[0]!.gap, 0);
    assert.ok(res[1]!.gap! > 0 && Math.abs(res[1]!.time! - res[0]!.time! - res[1]!.gap!) < 1e-9);
    assert.ok(s.cars[1]!.split! > 0 && s.cars[0]!.split === 0, "split to the first car through the line");
  });

  it("a cut across the infield that skips a checkpoint earns nothing; the skipped gate stays next", () => {
    const s = new RaceSession(square, field(1), { laps: 1, noReset: false });
    const L = square.length;
    const pts = [...centreline(square, L - 6, L + square.gateS(1) + 4), { x: 60, z: 60 }, ...centreline(square, L - 30, L + 20)];
    const ev = runTo(s, [polyline(pts, 20)], 40);
    assert.equal(count(ev, "lap"), 0);
    assert.equal(s.cars[0]!.next, 2);
    assert.equal(s.cars[0]!.lap, 0);
    assert.equal(s.cars[0]!.missed, true, "the HUD is told a checkpoint was skipped");
  });

  it("driving back and forth over the line never counts a lap", () => {
    const s = new RaceSession(square, field(1), { laps: 1, noReset: false });
    const L = square.length;
    const pts: Pt[] = [];
    for (let k = 0; k < 5; k++) pts.push(...centreline(square, L - 6, L + 8), ...centreline(square, L - 6, L + 8).reverse());
    const ev = runTo(s, [polyline(pts, 15)], 40);
    assert.equal(count(ev, "lap"), 0);
    assert.equal(s.cars[0]!.next, 1);
    assert.equal(s.cars[0]!.missed, false, "re-crossing the line just passed is no skip");
  });

  it("the oval's service road counts after checkpoint 4 and is quicker; from the wrong sector it earns nothing", () => {
    const sc = ovalTrack.shortcuts[0]!;
    assert.deepEqual([sc.from, sc.to], [4, 0]);
    const L = ovalTrack.length;
    const road = samples((s) => {
      const p = pointOn(sc.path, s, _pt);
      return { x: p.x, z: p.z };
    }, 0, sc.path.length, 1);
    const g = sc.gates[0]!;
    const mouth = { x: (g.ax + g.bx) / 2 - g.nx * 6, z: (g.az + g.bz) / 2 - g.nz * 6 };
    const exit = blankProjection();
    ovalTrack.project(road[road.length - 1]!.x, road[road.length - 1]!.z, -1, exit);
    const tail = [...road, ...centreline(ovalTrack, L + exit.s + 4, 2 * L + 10)];

    const cut = new RaceSession(ovalTrack, field(1), { laps: 1, noReset: false });
    const ev = runTo(cut, [polyline([...centreline(ovalTrack, L - 6, L + ovalTrack.gateS(4) + 10), mouth, ...tail], 25)], 60);
    assert.equal(count(ev, "lap"), 1, "the shortcut lap counts");
    const full = new RaceSession(ovalTrack, field(1), { laps: 1, noReset: false });
    runTo(full, [fromGrid(ovalTrack, 0, 25)], 60);
    assert.ok(cut.cars[0]!.finishTime! < full.cars[0]!.finishTime! - 2, "and it is quicker than the full lap");

    const early = new RaceSession(ovalTrack, field(1), { laps: 1, noReset: false });
    const wrong = [...centreline(ovalTrack, L - 6, L + ovalTrack.gateS(3) + 4), { x: 20, z: 20 }, mouth, ...tail];
    assert.equal(count(runTo(early, [polyline(wrong, 25)], 60), "lap"), 0);
    assert.equal(early.cars[0]!.next, 4, "still owes checkpoint 4");
  });

  it("a shortcut still counts when the car cuts in past its mouth gate or misses its exit gate", () => {
    const sc = ovalTrack.shortcuts[0]!;
    const L = ovalTrack.length;
    const along = (from: number, to: number) =>
      samples((s) => {
        const p = pointOn(sc.path, s, _pt);
        return { x: p.x, z: p.z };
      }, from, to, 1);
    const exit = blankProjection();
    ovalTrack.project(sc.path.x[sc.path.count - 1]!, sc.path.z[sc.path.count - 1]!, -1, exit);
    const approach = centreline(ovalTrack, L - 6, L + ovalTrack.gateS(4) + 10);
    const home = centreline(ovalTrack, L + exit.s + 6, 2 * L + 10);
    // Straight onto the service road between its first two gates.
    const cutIn = [...approach, ...along((sc.gates[0]!.s + sc.gates[1]!.s) / 2, sc.path.length), ...home];
    const a = new RaceSession(ovalTrack, field(1), { laps: 1, noReset: false });
    assert.equal(count(runTo(a, [polyline(cutIn, 25)], 60), "lap"), 1, "cut in past the mouth");
    // Off the service road before its last gate, straight back onto the main road.
    const early = [...approach, ...along(0, sc.gates[sc.gates.length - 2]!.s + 3), ...home];
    const b = new RaceSession(ovalTrack, field(1), { laps: 1, noReset: false });
    assert.equal(count(runTo(b, [polyline(early, 25)], 60), "lap"), 1, "left before the exit gate");
  });

  it("the oval's open infield counts as the service road: beside the dirt, or straight across between the wall gaps", () => {
    const sc = ovalTrack.shortcuts[0]!;
    const L = ovalTrack.length;
    const homeFrom = (x: number, z: number) => {
      const p = blankProjection();
      ovalTrack.project(x, z, -1, p);
      return centreline(ovalTrack, L + p.s + 6, 2 * L + 10);
    };
    // Down the right straight past checkpoint 4, then onto the infield.
    const approach = centreline(ovalTrack, L - 6, L + ovalTrack.gateS(4) + 40);
    // The service road 6 m toward the middle of the infield: on the grass beside the dirt the whole way.
    const beside = samples((s) => {
      const p = pointOn(sc.path, s, _pt);
      return { x: p.x + p.tz * 6, z: p.z - p.tx * 6 };
    }, 0, sc.path.length, 1);
    const across = [{ x: 44, z: -55 }, { x: 0, z: -62 }, { x: -44, z: -55 }];
    for (const [name, pts] of [["beside the dirt", beside], ["straight across", across]] as const) {
      const s = new RaceSession(ovalTrack, field(1), { laps: 1, noReset: false });
      const end = pts[pts.length - 1]!;
      const ev = runTo(s, [polyline([...approach, ...pts, ...homeFrom(end.x, end.z)], 25)], 60);
      assert.equal(count(ev, "lap"), 1, `${name}: the lap counts`);
      assert.equal(s.cars[0]!.status, "finished", name);
      assert.equal(s.cars[0]!.missed, false, name);
    }
  });

  it("wrong way: flagged after holding against the track, cleared after turning round", () => {
    const s = new RaceSession(square, field(1), { laps: 3, noReset: false });
    const go = fromGrid(square, 0, 15);
    runTo(s, [go], 6);
    const sNow = 6 * 15 - 6;
    const back: Driver = (t) => along(square, sNow, -12)(t - 6);
    runTo(s, [back], 6 + WRONG_WAY_ON * 0.6);
    assert.equal(s.cars[0]!.wrongWay, false, "a moment backwards is not wrong way yet");
    runTo(s, [back], 6 + WRONG_WAY_ON * 1.6);
    assert.equal(s.cars[0]!.wrongWay, true);
    const t1 = s.time;
    const sBack = sNow - 12 * (t1 - 6);
    runTo(s, [(t) => along(square, sBack, 12)(t - t1)], t1 + 2);
    assert.equal(s.cars[0]!.wrongWay, false);
  });

  it("positions: progress order on the road, grid order on a dead heat", () => {
    const s = new RaceSession(square, field(4), { laps: 1, noReset: false });
    runTo(s, [fromGrid(square, 0, 12), fromGrid(square, 1, 12), fromGrid(square, 2, 16), fromGrid(square, 3, 10)], 4);
    assert.deepEqual(s.order(), [2, 0, 1, 3]);
    const tie = new RaceSession(square, field(2), { laps: 1, noReset: false });
    const L = square.length;
    runTo(tie, [along(square, L - 6, 10), along(square, L - 6, 10)], 3);
    assert.equal(tie.cars[1]!.progress, tie.cars[0]!.progress);
    assert.deepEqual(tie.order(), [0, 1]);
  });

  it("respawn: 3 s after a death, on the centreline near the wreck, facing the race, clear of other cars", () => {
    const s = new RaceSession(square, field(2), { laps: 3, noReset: false });
    const L = square.length;
    const dieAt = 4;
    const crash = along(square, L - 6, 15, 3);
    const wreck = { ...crash(dieAt), vx: 0, vz: 0 };
    const dying: Driver = (t) => (t < dieAt ? crash(t) : { ...wreck, alive: false });
    // Car 1 sits on the centreline right beside the wreck, so the first spot is taken.
    const park = along(square, 15 * dieAt - 6, 0)(0);
    const blocker: Driver = (t) => (t < 0 ? fromGrid(square, 1, 0)(t) : park);
    const ev = runTo(s, [dying, blocker], dieAt + 0.2);
    const died = ev.find((e) => e.type === "died");
    assert.ok(died && died.type === "died" && died.id === 0);
    assert.ok(Math.abs(died.respawnAt - dieAt - RESPAWN_DELAY) < 0.05);
    // The host repairs the car on the respawn event; stop there.
    const ev2 = runTo(s, [dying, blocker], dieAt + RESPAWN_DELAY + 0.1, (x) => x.cars[0]!.status === "racing");
    const rs = ev2.find((e) => e.type === "respawn");
    assert.ok(rs && rs.type === "respawn");
    assert.equal(s.cars[0]!.status, "racing");
    const p = blankProjection();
    square.project(rs.x, rs.z, -1, p);
    assert.ok(Math.abs(p.lateral) < square.path.half[p.k]! * 0.5 + 0.05, `on the road near the centre (lateral ${p.lateral.toFixed(2)})`);
    const heading = Math.atan2(square.path.tx[p.k]!, square.path.tz[p.k]!);
    assert.ok(Math.cos(rs.yaw - heading) > 0.99, "facing the race direction");
    assert.ok(Math.abs(p.s - (15 * dieAt - 6)) <= 2 * CLEARANCE + 1, `near the wreck (s ${p.s.toFixed(1)})`);
    assert.ok(Math.hypot(rs.x - park.x, rs.z - park.z) >= CLEARANCE, "clear of the parked car");
  });

  it("a respawn never lands past the next checkpoint, even when the wreck slid over it", () => {
    const s = new RaceSession(square, field(1), { laps: 3, noReset: false });
    const g1 = square.gateS(1);
    const go = along(square, square.length - 6, 15);
    const tDie = (g1 + 5) / 15;
    const slid = { ...along(square, g1 + 6, 0)(0), alive: false };
    const ev = runTo(s, [(t) => (t < tDie ? go(t) : slid)], tDie + RESPAWN_DELAY + 0.5);
    const rs = ev.find((e) => e.type === "respawn");
    assert.ok(rs && rs.type === "respawn");
    const p = blankProjection();
    square.project(rs.x, rs.z, -1, p);
    assert.ok(p.s <= g1 - 2.9, `respawned at s ${p.s.toFixed(1)}, gate at ${g1.toFixed(1)}`);
    assert.equal(s.cars[0]!.next, 1);
  });

  it("no-reset: a dead car is out for good; the last car running wins on survival", () => {
    const s = new RaceSession(square, field(3), { laps: 5, noReset: true });
    const killAt = (i: number, at: number): Driver => {
      const d = fromGrid(square, i, 14);
      return (t) => (t < at ? d(t) : { ...d(at), vx: 0, vz: 0, alive: false });
    };
    const ev = runTo(s, [killAt(0, 3), killAt(1, 6), fromGrid(square, 2, 14)], 60);
    assert.deepEqual(ev.filter((e) => e.type === "out").map((e) => e.type === "out" && e.id), [0, 1]);
    assert.equal(count(ev, "respawn"), 0);
    assert.equal(s.requestRespawn(0), false);
    assert.equal(s.phase, "finished");
    assert.equal(s.winnerId, 2);
    assert.equal(s.winBy, "survival");
    assert.deepEqual(s.results().map((r) => [r.id, r.status]), [[2, "finished"], [1, "out"], [0, "out"]]);
  });

  it("resets on: a death costs a pause, then the car races on and can still finish", () => {
    const s = new RaceSession(square, field(1), { laps: 1, noReset: false });
    const go = fromGrid(square, 0, 18);
    let back: Driver | null = null;
    const d: Driver = (t) => {
      if (t >= 3 && t < 3.05) return { ...go(3), alive: false };
      if (s.cars[0]!.status === "respawning") return { ...go(3), alive: false };
      if (!back) {
        const c = s.cars[0]!;
        const p = blankProjection();
        square.project(c.x, c.z, -1, p);
        const t0 = t;
        back = (u) => along(square, p.s, 18)(u - t0);
      }
      return back(t);
    };
    const ev = runTo(s, [d], 120);
    assert.equal(count(ev, "died"), 1);
    assert.equal(count(ev, "out"), 0);
    assert.equal(count(ev, "respawn"), 1);
    assert.equal(s.cars[0]!.status, "finished");
    assert.ok(s.cars[0]!.finishTime! > square.length / 18 + RESPAWN_DELAY - 0.5);
  });

  it("snapshots are plain JSON and restore to an identical race", () => {
    const drivers = [fromGrid(square, 0, 20), fromGrid(square, 1, 17), fromGrid(square, 2, 15)];
    const a = new RaceSession(square, field(3), { laps: 2, noReset: false });
    runTo(a, drivers, 9);
    const b = RaceSession.restore(square, JSON.parse(JSON.stringify(a.snapshot())));
    assertSameDigest(b.snapshot(), a.snapshot(), "restored race at 9 s");
    runTo(a, drivers, 80);
    runTo(b, drivers, 80);
    assert.equal(a.phase, "finished");
    assertSameDigest(b.snapshot(), a.snapshot(), "restored race at the finish");
  });

  it("end(): running cars are DNF and rank behind the finishers", () => {
    const s = new RaceSession(square, field(2), { laps: 1, noReset: false });
    runTo(s, [fromGrid(square, 0, 22), fromGrid(square, 1, 8)], 60, (x) => x.cars[0]!.status === "finished");
    s.end();
    assert.equal(s.phase, "finished");
    assert.deepEqual(s.results().map((r) => [r.id, r.status]), [[0, "finished"], [1, "dnf"]]);
  });

  it("after the winner every car finishes at its next line crossing, ranked by laps then time; one that never arrives is DNF at its deadline", () => {
    const L = square.length;
    const s = new RaceSession(square, field(4), { laps: 2, noReset: false });
    const toLine = (i: number) => {
      const slot = square.gridSlot(i);
      const p = blankProjection();
      square.project(slot.x, slot.z, -1, p);
      return p.s;
    };
    const parkAt = (i: number) => polyline(centreline(square, toLine(i), 2 * L + 40), 22);
    // Winner; a lap down at the flag (crosses before the next full-distance finisher); full distance; parked after lap 1.
    runTo(s, [fromGrid(square, 0, 30), fromGrid(square, 1, 14), fromGrid(square, 2, 26), parkAt(3)], 200);
    assert.equal(s.phase, "finished");
    const res = s.results();
    assert.deepEqual(
      res.map((r) => [r.id, r.status, r.laps]),
      [[0, "finished", 2], [2, "finished", 2], [1, "finished", 1], [3, "dnf", 1]],
    );
    assert.ok(s.cars[1]!.finishTime! < s.cars[2]!.finishTime!, "the lapped car crossed first and still ranks behind");
    assert.equal(res[2]!.gap, null, "a lapped finisher has no time gap");
    const win = s.cars[0]!.finishTime!;
    assert.ok(Math.abs(s.time - (win + FINISH_GRACE)) <= DT + 1e-9, `closed at ${s.time.toFixed(2)} s, the winner + ${FINISH_GRACE} s is ${(win + FINISH_GRACE).toFixed(2)} s`);
  });

  it("a car on a long lap when the winner finishes gets LAP_SLACK × its own lap to reach the line, past the fixed grace", () => {
    const L = square.length;
    const dist = (i: number) => {
      const slot = square.gridSlot(i);
      const p = blankProjection();
      square.project(slot.x, slot.z, -1, p);
      return L - p.s;
    };
    // The winner's time over 3 laps at 30 m/s; the slow car crosses the line 4 s before it, so its
    // next crossing (one ~(win − 4) s lap later) comes well after the winner + FINISH_GRACE.
    const win = (dist(0) + 3 * L) / 30;
    const slowV = (dist(1) + L) / (win - 4);
    const s = new RaceSession(square, field(2), { laps: 3, noReset: false });
    runTo(s, [fromGrid(square, 0, 30), fromGrid(square, 1, slowV)], 300);
    const slow = s.cars[1]!;
    assert.equal(slow.status, "finished", `the slow car is ${slow.status} on ${slow.lap} laps`);
    assert.equal(slow.lap, 2, "flagged at its next crossing");
    assert.ok(slow.finishTime! > s.cars[0]!.finishTime! + FINISH_GRACE, `crossed at ${slow.finishTime!.toFixed(1)} s, after the fixed grace`);
  });

  it("a car whose best lap was a shortcut's still gets LAP_SLACK × its slowest lap on the loop lap after it (the best lap is no pace for a loop)", () => {
    const L = square.length;
    const p1 = blankProjection();
    const slot = square.gridSlot(1);
    square.project(slot.x, slot.z, -1, p1);
    const dist1 = L - p1.s;
    const slot0 = square.gridSlot(0);
    const p0 = blankProjection();
    square.project(slot0.x, slot0.z, -1, p0);
    // The winner's speed puts car 1's third crossing 40 s after the winner's (past FINISH_GRACE): lap 1 at the winner's speed (a lap round a shortcut), then 1.7× slower loop laps.
    const vW = (1.4 * L + dist1 - (L - p0.s)) / 40;
    const tA = (dist1 + L) / vW;
    const cut: Driver = (t) => {
      const tt = Math.max(0, t);
      const fast = tt <= tA;
      const q = square.pointAt(p1.s + (fast ? vW * tt : vW * tA + (vW / 1.7) * (tt - tA)), _pt);
      const v = fast ? vW : vW / 1.7;
      return { x: q.x + q.tz * p1.lateral, z: q.z - q.tx * p1.lateral, vx: q.tx * v, vz: q.tz * v };
    };
    const s = new RaceSession(square, field(2), { laps: 3, noReset: false });
    runTo(s, [fromGrid(square, 0, vW), cut], 600);
    const lagged = s.cars[1]!;
    assert.equal(lagged.status, "finished", `the car whose lap 1 was fast is ${lagged.status} on ${lagged.lap} laps`);
    assert.ok(lagged.finishTime! > s.cars[0]!.finishTime! + FINISH_GRACE, `crossed at ${lagged.finishTime!.toFixed(1)} s, after the fixed grace`);
  });
});

describe("busted (BUST)", () => {
  const GREEN = 2;
  /**
   * Car 0 on the oval: 30 m/s from green, then each `[seconds, km/h]` leg from `GREEN` s, then 30 m/s again;
   * a chasing police car rides `gap` m beside it the whole race. Car 1 races on. Stepped to `to` s.
   */
  function bust(legs: [number, number][], gap: number, to: number, noReset = false): RaceSession {
    const s = new RaceSession(ovalTrack, field(2), { laps: 3, noReset });
    const slot = ovalTrack.gridSlot(0);
    const p0 = blankProjection();
    ovalTrack.project(slot.x, slot.z, -1, p0);
    const drive = (t: number): { s: number; v: number } => {
      let s0 = p0.s + 30 * Math.min(Math.max(0, t), GREEN);
      let at = GREEN;
      for (const [len, kph] of legs) {
        const v = kph / 3.6;
        if (t < at + len) return { s: s0 + v * Math.max(0, t - at), v: t < at ? 30 : v };
        s0 += v * len;
        at += len;
      }
      return { s: s0 + 30 * Math.max(0, t - at), v: 30 };
    };
    const other = fromGrid(ovalTrack, 1, 30);
    const poses: CarPose[] = [0, 1].map(() => ({ x: 0, z: 0, yaw: 0, vx: 0, vz: 0, alive: true }));
    const cop = [{ x: 0, z: 0 }];
    while (s.time < to - 1e-9 && s.phase !== "finished") {
      const t = s.time + DT;
      const d = drive(t);
      const p = ovalTrack.pointAt(d.s, _pt);
      Object.assign(poses[0]!, { x: p.x, z: p.z, vx: p.tx * d.v, vz: p.tz * d.v });
      cop[0]!.x = p.x + p.tz * gap;
      cop[0]!.z = p.z - p.tx * gap;
      // After the cop: `other` reuses the scratch point `p`.
      Object.assign(poses[1]!, other(t));
      s.step(DT, poses, cop);
    }
    return s;
  }

  it("good: stopped 4.1 s within 20 m of a chasing police car is busted: DNF with the reason, the others race on", () => {
    const s = bust([[4.1, 0]], 10, GREEN + 6);
    const c = s.cars[0]!;
    assert.equal(c.status, "dnf");
    assert.ok(Math.abs(c.bustedAt! - (GREEN + 4)) <= 2 * DT, `busted at ${c.bustedAt} s`);
    assert.equal(s.cars[1]!.status, "racing");
    assert.equal(s.cars[1]!.bustedAt, null);
    const rows = s.results();
    assert.equal(rows.find((r) => r.id === 0)!.busted, true);
    assert.equal(rows.find((r) => r.id === 1)!.busted, false);
  });

  it("good: in a no-reset race a bust puts the car out, timed like an elimination", () => {
    const s = bust([[4.1, 0]], 10, GREEN + 6, true);
    const c = s.cars[0]!;
    assert.equal(c.status, "out");
    assert.equal(c.outTime, c.bustedAt);
  });

  it("bad: 3.9 s stopped, 21 m off, or 21 km/h is not busted", () => {
    const cases: [[number, number][], number, string][] = [
      [[[3.9, 0]], 10, "3.9 s"],
      [[[8, 0]], 21, "21 m"],
      [[[8, 21]], 10, "21 km/h"],
    ];
    for (const [legs, gap, why] of cases) {
      const s = bust(legs, gap, GREEN + 10);
      assert.equal(s.cars[0]!.status, "racing", why);
      assert.equal(s.cars[0]!.bustedAt, null, why);
      assert.equal(s.cars[0]!.stopped, 0, `${why}: the timer is back at 0 once it drives on`);
    }
  });

  it("bad: speeding up restarts the timer: 3 s stopped, 1 s at 30 km/h, 3 s stopped is not busted", () => {
    const s = bust([[3, 0], [1, 30], [3, 0]], 10, GREEN + 7 - DT);
    assert.equal(s.cars[0]!.status, "racing");
    assert.ok(Math.abs(s.cars[0]!.stopped - 3) <= 2 * DT, `held ${s.cars[0]!.stopped.toFixed(2)} s since the restart`);
  });

  it("bad: no police car (police off) never busts anyone", () => {
    const s = new RaceSession(ovalTrack, field(1), { laps: 3, noReset: false });
    runTo(s, [() => ({ x: 0, z: 0, vx: 0, vz: 0 })], GREEN + 10);
    assert.equal(s.cars[0]!.status, "racing");
  });

  it("bad: a racer stopped beside a PARKED stakeout for over 4 s is not busted; once that unit chases, it is", () => {
    const brain = new RaceBrain(ovalTrack, 1);
    const police = new PoliceBrain(ovalTrack, brain, 1, 2, 1);
    const cars = [0, 1, 2].map(blankAiCar);
    const spots: Pt[] = [];
    const world: PoliceWorld = {
      park: (id, x, _y, z) => {
        spots[id] = { x, z };
        Object.assign(cars[id]!, { x, z, vx: 0, vz: 0 });
      },
      store: () => {},
      seen: () => false,
      down: () => false,
      sirens: () => {},
    };
    const hunt = new Uint8Array([1, 0, 0]);
    // The leader a third of a lap in: the first stakeout parks two units ahead of car 0.
    const start = ovalTrack.pointAt(ovalTrack.length * 0.4, _pt);
    Object.assign(cars[0]!, { x: start.x, z: start.z });
    police.update(0, 0.25, cars, hunt, ovalTrack.length * 0.4, world);
    assert.ok(spots[1], "no stakeout parked");
    const proj = blankProjection();
    const spotS = ovalTrack.project(spots[1]!.x, spots[1]!.z, -1, proj).s;
    const s = new RaceSession(ovalTrack, field(1), { laps: 3, noReset: false });
    const pose: CarPose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, alive: true };
    const out: AiCar[] = [];
    /** Car 0 parked on the centreline `ds` m along from unit 1's spot for `secs` s of green racing. */
    const sit = (ds: number, secs: number) => {
      const p = ovalTrack.pointAt(spotS + ds, _pt);
      Object.assign(cars[0]!, { x: p.x, z: p.z });
      Object.assign(pose, { x: p.x, z: p.z });
      const near = Math.hypot(p.x - spots[1]!.x, p.z - spots[1]!.z);
      assert.ok(near < BUST.near, `car 0 is ${near.toFixed(1)} m from the unit`);
      for (let t = 0; t < secs; t += DT) {
        if (Math.round(s.time / DT) % 15 === 0) police.update(s.time, 0.25, cars, hunt, 0, world);
        s.step(DT, [pose], s.time < 0 ? [] : police.chasers(cars, out));
      }
    };
    // Short of its spot: the unit stays parked, so it never counts.
    sit(-8, 4.5 + 5);
    assert.equal(out.length, 0, "a parked unit counted as chasing");
    assert.equal(s.cars[0]!.status, "racing");
    assert.equal(s.cars[0]!.bustedAt, null);
    // Past it: the pack wakes and chases, and the same stop is a bust.
    sit(5, 5);
    assert.ok(out.length > 0, "the woken unit is not chasing");
    assert.equal(s.cars[0]!.status, "dnf");
    assert.notEqual(s.cars[0]!.bustedAt, null);
  });
});

describe("campaign", () => {
  const row = (id: number, place: number, status: RaceResultRow["status"] = "finished"): RaceResultRow => ({
    id,
    name: `Car ${id}`,
    kind: "ai",
    place,
    status,
    time: null,
    gap: null,
    bestLap: null,
    laps: 3,
    busted: false,
  });

  it("scores places, sorts standings, and grids each later round leader on pole", () => {
    const c = new Campaign(["oval", "rally", "city"], field(4));
    assert.deepEqual(c.grid(), [0, 1, 2, 3], "round 1: entry order");
    assert.equal(c.trackId, "oval");
    c.record([row(2, 1), row(0, 2), row(3, 3), row(1, 4, "out")]);
    assert.deepEqual(c.standings().map((r) => [r.id, r.points]), [[2, 10], [0, 8], [3, 6], [1, 5]]);
    assert.deepEqual(c.grid(), [2, 0, 3, 1]);
    assert.equal(c.trackId, "rally");
    c.record([row(0, 1), row(2, 2), row(1, 3), row(3, 4)]);
    // 0 and 2 tie on 18 points and one win each: 0 placed better in the latest round.
    assert.deepEqual(c.standings().map((r) => [r.id, r.points, r.wins]), [[0, 18, 1], [2, 18, 1], [1, 11, 0], [3, 11, 0]]);
    assert.equal(CAMPAIGN_POINTS[0], 10);
    c.record([row(3, 1), row(1, 2), row(0, 3), row(2, 4)]);
    assert.equal(c.done, true);
    assert.equal(c.trackId, null);
    assert.throws(() => c.record([]));
    const restored = Campaign.restore(JSON.parse(JSON.stringify(c.snapshot())));
    assertSameDigest(restored.snapshot(), c.snapshot(), "restored campaign");
  });

  it("places past 8th score nothing; a car missing from a round keeps a 0 place", () => {
    const c = new Campaign(["oval"], field(10));
    c.record(Array.from({ length: 9 }, (_, i) => row(i, i + 1)));
    const st = c.standings();
    assert.equal(st.find((r) => r.id === 8)!.points, 0);
    assert.deepEqual(st.find((r) => r.id === 9)!.places, [0]);
  });
});

describe("drafting", () => {
  /** Straight up +z from green at `v` m/s, `x` m across; the rule needs no road. */
  const straight =
    (x: number, z0: number, v: number): Driver =>
    (t) => ({ x, z: z0 + v * Math.max(0, t), vx: 0, vz: v });
  const leader = straight(0, 20, 30);
  const race = () => new RaceSession(square, field(2), { laps: 9, noReset: false });

  it("a car held in a leader's trail earns one bonus per DRAFT.every s; the leader earns none", () => {
    const s = race();
    const follower = straight(0.5, 12, 30);
    runTo(s, [leader, follower], DRAFT.every - 0.1);
    assert.equal(s.cars[1]!.drafts, 0, "a bonus before the first interval");
    assert.ok(s.cars[1]!.draft > DRAFT.every - 0.2, `drafting for ${s.cars[1]!.draft} s`);
    runTo(s, [leader, follower], DRAFT.every + 0.1);
    assert.equal(s.cars[1]!.drafts, 1);
    runTo(s, [leader, follower], 4 * DRAFT.every + 0.5);
    assert.equal(s.cars[1]!.drafts, 4);
    assert.equal(s.cars[0]!.drafts, 0, "the car in front drafted");
    assert.equal(s.cars[0]!.draft, 0);
  });

  it("none outside the trail: off its line, too far back, too close, under the speed floor, or a broken run", () => {
    const cases: [string, Driver, Driver][] = [
      ["2.5 m off its line", leader, straight(2.5, 12, 30)],
      ["20 m back", leader, straight(0, 0, 30)],
      ["1 m back", leader, straight(0, 19, 30)],
      ["both at 12 m/s", straight(0, 20, 12), straight(0, 12, 12)],
      // In the trail 1.5 s, out 0.5 s, back for the rest: no stretch reaches DRAFT.every.
      ["a broken run", leader, (t) => ({ ...straight(0, 12, 30)(t), x: t > 1.5 && t < 2 ? 3 : 0 })],
    ];
    for (const [name, lead, follower] of cases) {
      const s = race();
      runTo(s, [lead, follower], 3.4);
      assert.equal(s.cars[1]!.drafts, 0, name);
      assert.equal(s.cars[0]!.drafts, 0, name);
      if (name !== "a broken run") assert.equal(s.cars[1]!.draft, 0, `${name}: counted as drafting`);
    }
  });
});
