import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Track, blankPoint, blankProjection, pointOn } from "../world/track.ts";
import { BUST, CLEARANCE, COUNTDOWN, DRAFT, FINISH_GRACE, GRID_TIME, RESPAWN_DELAY, RaceSession, WRONG_WAY_ON, startLights } from "./session.ts";
import { Campaign, CAMPAIGN_POINTS } from "./campaign.ts";
import type { CarPose, RaceEvent, RaceResultRow } from "./types.ts";
import { DT, along, centreline, field, fromGrid, polyline, runTo, samples, shortcutLine, type Driver, type Pt } from "./session-drive.test-util.ts";
import { square as squareFile } from "../world/track.test-util.ts";
import { assertSameDigest } from "../vehicle/test-support.ts";
import oval from "../world/tracks/oval.json" with { type: "json" };
import { PoliceBrain, type PoliceWorld } from "../ai/police.ts";
import { RaceBrain } from "../ai/race-ai.ts";
import { blankAiCar, type AiCar } from "../ai/derby-ai.ts";

const _pt = blankPoint();

const count = (ev: RaceEvent[], type: RaceEvent["type"]) => ev.filter((e) => e.type === type).length;

const square = new Track(squareFile());
const ovalTrack = new Track(oval);

describe("given a one-lap race between two cars on the square track, before the start", () => {
  it("when time runs from the grid through the countdown, then the start lights go off, red, yellow, then green at the right moments, the race goes from grid to countdown to racing, and one go event fires at 0", () => {
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
});

describe("given a two-lap race between two cars on the square track", () => {
  it("when both cars drive two laps over the line with every checkpoint in order, then laps count over the line (lap 1 timed from green, lap 2 line to line), the first car home wins by laps, and the results show its zero gap and the second car's positive gap and split", () => {
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
});

describe("given a one-lap race with one car on the square track", () => {
  it("when the car cuts across the infield and skips a checkpoint, then no lap counts, the skipped checkpoint stays next and the HUD is told a checkpoint was skipped", () => {
    const s = new RaceSession(square, field(1), { laps: 1, noReset: false });
    const L = square.length;
    const pts = [...centreline(square, L - 6, L + square.gateS(1) + 4), { x: 60, z: 60 }, ...centreline(square, L - 30, L + 20)];
    const ev = runTo(s, [polyline(pts, 20)], 40);
    assert.equal(count(ev, "lap"), 0);
    assert.equal(s.cars[0]!.next, 2);
    assert.equal(s.cars[0]!.lap, 0);
    assert.equal(s.cars[0]!.missed, true, "the HUD is told a checkpoint was skipped");
  });

  it("when the car drives back and forth over the line, then no lap ever counts and re-crossing the line just passed is not flagged as a skipped checkpoint", () => {
    const s = new RaceSession(square, field(1), { laps: 1, noReset: false });
    const L = square.length;
    const pts: Pt[] = [];
    for (let k = 0; k < 5; k++) pts.push(...centreline(square, L - 6, L + 8), ...centreline(square, L - 6, L + 8).reverse());
    const ev = runTo(s, [polyline(pts, 15)], 40);
    assert.equal(count(ev, "lap"), 0);
    assert.equal(s.cars[0]!.next, 1);
    assert.equal(s.cars[0]!.missed, false, "re-crossing the line just passed is no skip");
  });
});

describe("given a one-lap race with one car on the oval track, whose service road across the infield is a shortcut from checkpoint 4 to the line", () => {
  it("when the car takes the service road after checkpoint 4, then the shortcut lap counts and is more than 2 s quicker than the full lap, and when it joins the road without having passed checkpoint 4, then it earns no lap and still owes checkpoint 4", () => {
    const sc = ovalTrack.shortcuts[0]!;
    assert.deepEqual([sc.from, sc.to], [4, 0]);
    const L = ovalTrack.length;
    const road = shortcutLine(sc.path, 0, sc.path.length, 1);
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

  it("when the car cuts in past the shortcut's mouth gate, or leaves it before its exit gate, then the shortcut lap still counts", () => {
    const sc = ovalTrack.shortcuts[0]!;
    const L = ovalTrack.length;
    const exit = blankProjection();
    ovalTrack.project(sc.path.x[sc.path.count - 1]!, sc.path.z[sc.path.count - 1]!, -1, exit);
    const approach = centreline(ovalTrack, L - 6, L + ovalTrack.gateS(4) + 10);
    const home = centreline(ovalTrack, L + exit.s + 6, 2 * L + 10);
    // Straight onto the service road between its first two gates.
    const cutIn = [...approach, ...shortcutLine(sc.path, (sc.gates[0]!.s + sc.gates[1]!.s) / 2, sc.path.length, 1), ...home];
    const a = new RaceSession(ovalTrack, field(1), { laps: 1, noReset: false });
    assert.equal(count(runTo(a, [polyline(cutIn, 25)], 60), "lap"), 1, "cut in past the mouth");
    // Off the service road before its last gate, straight back onto the main road.
    const early = [...approach, ...shortcutLine(sc.path, 0, sc.gates[sc.gates.length - 2]!.s + 3, 1), ...home];
    const b = new RaceSession(ovalTrack, field(1), { laps: 1, noReset: false });
    assert.equal(count(runTo(b, [polyline(early, 25)], 60), "lap"), 1, "left before the exit gate");
  });

  it("when the car crosses the open infield beside the dirt road, or straight across between the wall gaps, then the lap counts either way, the car finishes and no checkpoint is flagged skipped", () => {
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
});

describe("given a three-lap race with one car on the square track, driven at 15 m/s and then turned round", () => {
  it("when the car drives backwards, then it is not wrong-way for a moment but is flagged after holding against the track for the wrong-way delay, and is cleared after it turns round and drives forward", () => {
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
});

describe("given races on the square track where cars are ranked mid-race", () => {
  it("when a four-car race is 4 s in, then the order follows progress along the road, and two cars level on progress keep grid order", () => {
    const s = new RaceSession(square, field(4), { laps: 1, noReset: false });
    runTo(s, [fromGrid(square, 0, 12), fromGrid(square, 1, 12), fromGrid(square, 2, 16), fromGrid(square, 3, 10)], 4);
    assert.deepEqual(s.order(), [2, 0, 1, 3]);
    const tie = new RaceSession(square, field(2), { laps: 1, noReset: false });
    const L = square.length;
    runTo(tie, [along(square, L - 6, 10), along(square, L - 6, 10)], 3);
    assert.equal(tie.cars[1]!.progress, tie.cars[0]!.progress);
    assert.deepEqual(tie.order(), [0, 1]);
  });
});

describe("given a three-lap race of two cars on the square track, where car 0 dies 4 s in and car 1 sits parked on the centreline beside the wreck", () => {
  it("when the respawn delay (3 s) passes, then car 0 respawns on the road near the centre, near the wreck, facing the race direction and clear of the parked car", () => {
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
});

describe("given a three-lap race with one car on the square track, whose wreck slid past the next checkpoint before it stopped", () => {
  it("when the car respawns, then it lands at least 2.9 m before that checkpoint, never past it, and the checkpoint is still next", () => {
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
});

describe("given a five-lap race of three cars on the square track with no resets", () => {
  it("when two cars die one after the other, then both are out for good (no respawn, and a respawn request is refused), the last car running wins on survival and the race ends with it finished and the dead cars out", () => {
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
});

describe("given a one-lap race with one car on the square track, with resets on", () => {
  it("when the car dies at 3 s, then it is respawned after a pause (never put out) and races on to finish, no sooner than a clean lap plus the respawn delay less 0.5 s", () => {
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
});

describe("given a two-lap race of three cars on the square track", () => {
  it("when the race is snapshotted at 9 s, passed through JSON text and restored, then the restored race matches the original at 9 s and, run on with the same drivers, again at the finish", () => {
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
});

describe("given a one-lap race of two cars on the square track where one car has finished and the other still runs", () => {
  it("when the race is ended, then the running car is DNF (did not finish) and ranks behind the finisher", () => {
    const s = new RaceSession(square, field(2), { laps: 1, noReset: false });
    runTo(s, [fromGrid(square, 0, 22), fromGrid(square, 1, 8)], 60, (x) => x.cars[0]!.status === "finished");
    s.end();
    assert.equal(s.phase, "finished");
    assert.deepEqual(s.results().map((r) => [r.id, r.status]), [[0, "finished"], [1, "dnf"]]);
  });
});

describe("given a two-lap race of four cars on the square track: a winner, a car a lap down at the flag, a full-distance car, and one parked after lap 1", () => {
  it("when the winner finishes, then every other car finishes at its next line crossing, ranked by laps then time (a lapped finisher has no time gap), the parked car is DNF at its deadline, and the race closes the finish grace after the winner", () => {
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
});

describe("given a three-lap race of two cars on the square track, where the second car crosses the line 4 s before the winner finishes and then runs a long slow lap", () => {
  it("when the winner finishes, then the slow car is allowed LAP_SLACK (a multiple of its own lap time) to reach the line, beyond the fixed finish grace, and is flagged finished at its next crossing after the grace", () => {
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
});

describe("given a three-lap race of two cars on the square track, where the second car's best lap was a shortcut and its loop laps are 1.7 times slower", () => {
  it("when the winner finishes, then the second car is allowed LAP_SLACK (a multiple of its own lap time) times its slowest lap rather than its best, and still finishes, crossing after the fixed finish grace", () => {
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

const GREEN = 2;

describe("given a three-lap race of two cars on the oval where a police car rides beside car 0 the whole race and a car stopped for 4 s within 20 m of a police car is busted", () => {
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

  it("when car 0 is stopped for 4.1 s within 20 m of the chasing police car, then it is busted at 4 s, DNF (did not finish) with the bust shown in the results, while the other car keeps racing", () => {
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

  it("when the same bust happens in a no-reset race, then the car is out rather than DNF, timed like an elimination", () => {
    const s = bust([[4.1, 0]], 10, GREEN + 6, true);
    const c = s.cars[0]!;
    assert.equal(c.status, "out");
    assert.equal(c.outTime, c.bustedAt);
  });

  it("when the car is stopped 3.9 s, or stopped 8 s but 21 m from the police car, or at 21 km/h, then it is not busted and its stopped timer is back at 0 once it drives on", () => {
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

  it("when the car speeds up in between (3 s stopped, 1 s at 30 km/h, 3 s stopped), then the timer restarts and it is not busted", () => {
    const s = bust([[3, 0], [1, 30], [3, 0]], 10, GREEN + 7 - DT);
    assert.equal(s.cars[0]!.status, "racing");
    assert.ok(Math.abs(s.cars[0]!.stopped - 3) <= 2 * DT, `held ${s.cars[0]!.stopped.toFixed(2)} s since the restart`);
  });
});

describe("given a three-lap race with one car on the oval and no police car (police off)", () => {
  it("when the car sits still, then it is never busted", () => {
    const s = new RaceSession(ovalTrack, field(1), { laps: 3, noReset: false });
    runTo(s, [() => ({ x: 0, z: 0, vx: 0, vz: 0 })], GREEN + 10);
    assert.equal(s.cars[0]!.status, "racing");
  });
});

describe("given a three-lap race with one car on the oval and a PARKED stakeout police unit beside its spot", () => {
  it("when a racer stops beside the parked unit for over 4 s, then it is not busted, and once that unit wakes and chases it is", () => {
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

describe("given a campaign of races across tracks (oval, rally, city)", () => {
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

  it("when three rounds are recorded, then points follow finishing place, standings sort by points with ties going to the better latest finish, each later round's grid puts the leader on pole, the campaign is done after its last track, recording more throws, and a snapshot restores identically", () => {
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

  it("when a round records nine of ten cars, then the car in 9th place scores nothing and the car missing from the round keeps a zero place", () => {
    const c = new Campaign(["oval"], field(10));
    c.record(Array.from({ length: 9 }, (_, i) => row(i, i + 1)));
    const st = c.standings();
    assert.equal(st.find((r) => r.id === 8)!.points, 0);
    assert.deepEqual(st.find((r) => r.id === 9)!.places, [0]);
  });
});

describe("given a two-car race on the square track, where one car follows another", () => {
  /** Straight up +z from green at `v` m/s, `x` m across; the rule needs no road. */
  const straight =
    (x: number, z0: number, v: number): Driver =>
    (t) => ({ x, z: z0 + v * Math.max(0, t), vx: 0, vz: v });
  const leader = straight(0, 20, 30);
  const race = () => new RaceSession(square, field(2), { laps: 9, noReset: false });

  it("when a car is held in a leader's trail, then it earns one bonus per DRAFT.every (the drafting interval) seconds, none before the first interval, and the leader earns none", () => {
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

  it("when the follower is 2.5 m off the leader's line, 20 m back, 1 m back, both at 12 m/s (under the speed floor) or on a broken run, then it earns no draft bonus and, the broken run aside, is never counted as drafting", () => {
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
