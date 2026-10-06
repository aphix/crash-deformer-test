import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Track, blankProjection, projectPath } from "../world/track.ts";
import { square as squareFile } from "../world/track.test-util.ts";
import oval from "../world/tracks/oval.json" with { type: "json" };
import { GATE_MARGIN, RESPAWN_DELAY, RESPAWN_REQUEST_DELAY, RaceSession } from "./session.ts";
import type { RaceEvent } from "./types.ts";
import { along, centreline, field, onRoad, polyline, runTo, shortcutLine, type Driver, type Pt } from "./session-drive.test-util.ts";

const square = new Track(squareFile());
const ovalTrack = new Track(oval);
const L = square.length;
const g1 = square.gateS(1);
const g2 = square.gateS(2);

const respawnOf = (ev: readonly RaceEvent[]) => ev.find((e): e is Extract<RaceEvent, { type: "respawn" }> => e.type === "respawn");

/** The drive of a car that leaves the square's road at 170 m, crosses the infield to the road at 330 m and carries on through checkpoint 3 (374 m) to 390 m, and the race time it gets there. */
function crossedInfield(): { pts: Pt[]; tDie: number } {
  const before = [...centreline(square, L - 6, L + 170), { x: 121.5, z: 43.3 }];
  return { pts: [...before, ...centreline(square, 330, 401)], tDie: (lengthOf(before) + 60) / 20 };
}

/** The length (m) of a polyline. */
function lengthOf(pts: Pt[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z);
  return d;
}

describe("given a three-lap race on the square track whose first checkpoint is the line, with checkpoints 1 and 2 at 122 and 252 m", () => {
  it("when a car crosses checkpoint 3 across the infield without checkpoint 2 and wrecks beyond it, then it is put back on the road where it left it before checkpoint 2, not at the checkpoint and not in the field", () => {
    const s = new RaceSession(square, field(1), { laps: 3, noReset: false });
    // On the road to 170 m, across the infield to the road at 330 m (past checkpoint 2, owed), through checkpoint 3 at 374 m, dead at 390 m.
    const { pts, tDie } = crossedInfield();
    const dead: Driver = (t) => ({ ...polyline(pts, 20)(t), alive: t < tDie });
    const ev = runTo(s, [dead], tDie + RESPAWN_DELAY + 0.5);
    const c = s.cars[0]!;
    assert.equal(c.next, 2, "checkpoint 2 is still owed");
    const r = respawnOf(ev);
    assert.ok(r, "a respawn event");
    assert.equal(r.keep, false);
    const at = onRoad(square, r.x, r.z);
    assert.ok(at.s >= 165 && at.s <= 185, `landed at ${at.s.toFixed(1)} m, wanted where it left the road (about 170-180 m)`);
    assert.ok(Math.abs(at.lateral) < 0.5, `on the centreline (${at.lateral.toFixed(2)} m off)`);
    assert.ok(at.s <= g2 - GATE_MARGIN + 1e-6 && at.s >= g1, "between the last checkpoint it hit and 3 m short of the one it owes");
  });

  it("when a car leaves the road for the infield and asks for a reset there, then it lands on the road at the last spot it was on it, not on the road nearest the field it ended in", () => {
    const s = new RaceSession(square, field(1), { laps: 3, noReset: false });
    // On the road to 160 m, then 60 m straight into the infield, parked at (60, 70): nearer the left straight (60 m from it, 60-120 m) than the top road.
    const pts = [...centreline(square, L - 6, L + 160), { x: 60, z: 70 }];
    const drive = polyline(pts, 20);
    const stop = (t: number) => (t > 14 ? { ...drive(t), vx: 0, vz: 0 } : drive(t));
    runTo(s, [stop], 15);
    assert.ok(s.requestRespawn(0));
    const ev = runTo(s, [stop], 15 + RESPAWN_REQUEST_DELAY + 0.5);
    const r = respawnOf(ev)!;
    const at = onRoad(square, r.x, r.z);
    assert.ok(at.s >= 155 && at.s <= 185, `landed at ${at.s.toFixed(1)} m, wanted where it left the road (about 160-180 m)`);
    assert.ok(Math.abs(at.lateral) < 0.5, "on the centreline");
  });

  it("when a car that missed nothing wrecks on the road between two checkpoints, then it is put back on the road where it stopped, as before", () => {
    const s = new RaceSession(square, field(1), { laps: 3, noReset: false });
    const pts = centreline(square, L - 6, L + 190);
    const dead: Driver = (t) => ({ ...polyline(pts, 20)(t), alive: t < 11 });
    const ev = runTo(s, [dead], 11 + RESPAWN_DELAY + 0.5);
    const stoppedAt = onRoad(square, s.cars[0]!.x, s.cars[0]!.z).s;
    const r = respawnOf(ev)!;
    const at = onRoad(square, r.x, r.z);
    assert.ok(Math.abs(at.s - stoppedAt) < 1, `landed at ${at.s.toFixed(1)} m, stopped at ${stoppedAt.toFixed(1)} m`);
    assert.ok(Math.abs(at.lateral) < 0.5);
  });

  it("when a car drove round the end of a checkpoint on the grass and wrecks on the road beyond it, then it is put back on the road where it left it before that checkpoint, never at or past it", () => {
    const s = new RaceSession(square, field(1), { laps: 3, noReset: false });
    // Down the left straight to 62 m, 25 m out to the right of the road (it reaches 19 m past the centreline), past checkpoint 1 at 122 m on the grass, back onto the road at 182 m.
    const wide = centreline(square, g1 - 60, g1 + 60).map((p) => ({ x: p.x - 25, z: p.z }));
    const pts = [...centreline(square, L - 6, L + g1 - 60), ...wide, ...centreline(square, g1 + 60, g1 + 100)];
    const tDie = (lengthOf(pts) - 20) / 20;
    const dead: Driver = (t) => ({ ...polyline(pts, 20)(t), alive: t < tDie });
    const ev = runTo(s, [dead], tDie + RESPAWN_DELAY + 0.5);
    assert.equal(s.cars[0]!.next, 1, "checkpoint 1 was missed");
    const r = respawnOf(ev)!;
    const at = onRoad(square, r.x, r.z);
    assert.ok(at.s >= g1 - 65 && at.s <= g1 - 40, `landed at ${at.s.toFixed(1)} m, wanted where it left the road (about ${g1 - 60}-${g1 - 45} m)`);
    assert.ok(Math.abs(at.lateral) < 0.5);
  });
});

describe("given a one-lap race on the oval whose service road is a shortcut from checkpoint 4 to the line", () => {
  it("when a car on the service road leaves its road for the infield and wrecks there, then it is put back on the service road at the last spot it was on it, after the last service-road gate it hit", () => {
    const sc = ovalTrack.shortcuts[0]!;
    const s = new RaceSession(ovalTrack, field(1), { laps: 1, noReset: false });
    const lo = sc.gates[4]!.s;
    // Main road past checkpoint 4, in at the mouth, along the service road to 100 m (past its 5th gate at 91 m), then 40 m out into the infield; dead 10 m out.
    const g = sc.gates[0]!;
    const mouth = { x: (g.ax + g.bx) / 2 - g.nx * 6, z: (g.az + g.bz) / 2 - g.nz * 6 };
    const onTheRoad = [...centreline(ovalTrack, ovalTrack.length - 6, ovalTrack.length + ovalTrack.gateS(4) + 10), mouth, ...shortcutLine(sc.path, 0, 100)];
    const end = onTheRoad[onTheRoad.length - 1]!;
    const before = onTheRoad[onTheRoad.length - 2]!;
    const heading = Math.hypot(end.x - before.x, end.z - before.z);
    // Square off the road: 40 m to its left.
    const pts = [...onTheRoad, { x: end.x + ((end.z - before.z) / heading) * 40, z: end.z - ((end.x - before.x) / heading) * 40 }];
    const tDie = (lengthOf(onTheRoad) + 10) / 18;
    const dead: Driver = (t) => ({ ...polyline(pts, 18)(t), alive: t < tDie });
    const ev = runTo(s, [dead], tDie + RESPAWN_DELAY + 0.5);
    const c = s.cars[0]!;
    assert.equal(c.route, 0, "still on the service road");
    const r = respawnOf(ev)!;
    const p = projectPath(sc.path, r.x, r.z, -1, blankProjection());
    assert.ok(p.dist2 < 0.25, `on the service road's centreline (${Math.sqrt(p.dist2).toFixed(2)} m off)`);
    assert.ok(p.s >= lo && p.s <= sc.gates[5]!.s - GATE_MARGIN + 1e-6, `at ${p.s.toFixed(1)} m of the road, between its gates at ${lo.toFixed(0)} and ${sc.gates[5]!.s.toFixed(0)} m`);
    assert.ok(p.s >= 95, `where it left the road (${p.s.toFixed(1)} m), not back at the gate`);
  });
});

describe("given a car racing on the square track that is held at reset", () => {
  const raceAt = (opts: { noReset: boolean } = { noReset: false }) => {
    const s = new RaceSession(square, field(2), { laps: 3, noReset: opts.noReset });
    const { pts, tDie } = crossedInfield();
    runTo(s, [polyline(pts, 20), along(square, L - 30, 15)], tDie);
    return s;
  };

  it("when the car is racing, then it goes back at once to the spot a reset would put it, with no wait and no death, the damage kept (keep), the race state as it was", () => {
    const s = raceAt();
    const c = s.cars[0]!;
    const next = c.next;
    assert.equal(c.missed, true);
    assert.ok(s.holdReset(0));
    const ev = s.events();
    assert.deepEqual(ev.map((e) => e.type), ["respawn"], "no died event, no delay");
    const r = respawnOf(ev)!;
    assert.equal(r.keep, true);
    assert.equal(c.status, "racing");
    assert.equal(c.deaths, 0);
    assert.equal(c.next, next, "it still owes the checkpoint it owed");
    assert.equal(c.missed, true, "and is still flagged until it crosses it");
    const at = onRoad(square, r.x, r.z);
    assert.ok(at.s >= 165 && at.s <= 185, `at ${at.s.toFixed(1)} m`);
  });

  it("when the race is a no-reset race, then a tap is refused but the hold works, the car is not put out and nobody is revived", () => {
    const s = raceAt({ noReset: true });
    assert.equal(s.requestRespawn(0), false);
    assert.equal(s.holdReset(0), true);
    assert.equal(s.cars[0]!.status, "racing");
    assert.deepEqual(s.events().map((e) => e.type), ["respawn"]);
  });

  it("when the car is out, respawning, finished or the race is not on, then the hold does nothing", () => {
    const s = new RaceSession(square, field(1), { laps: 3, noReset: false });
    assert.equal(s.holdReset(0), false, "grid");
    const pts = centreline(square, L - 6, L + 190);
    const dead: Driver = (t) => ({ ...polyline(pts, 20)(t), alive: t < 11 });
    runTo(s, [dead], 11.2);
    assert.equal(s.cars[0]!.status, "respawning");
    assert.equal(s.holdReset(0), false, "respawning");
    assert.equal(s.holdReset(7), false, "no such car");
    const out = new RaceSession(square, field(1), { laps: 3, noReset: true });
    runTo(out, [dead], 11.2);
    assert.equal(out.cars[0]!.status, "out");
    assert.equal(out.holdReset(0), false, "out");
    const done = new RaceSession(square, field(1), { laps: 1, noReset: false });
    runTo(done, [along(square, L - 6, 30)], 60);
    assert.equal(done.phase, "finished");
    assert.equal(done.holdReset(0), false, "finished");
  });

  it("when the run is endless (a Survival run: no checkpoints, no road to go back to), then the hold does nothing", () => {
    const s = new RaceSession(square, field(1), { laps: 3, noReset: true, survival: { bustTime: 5 } });
    runTo(s, [along(square, L - 6, 20)], 3);
    assert.equal(s.holdReset(0), false);
  });
});
