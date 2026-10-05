import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../world/ground.ts";
import { frame, makeWorld, type World } from "../world/race-world.test-util.ts";
import { readRace, writeRace } from "./codec.ts";

/** Host world with network peers seated on `seats` (car → name), its player named "Ann", a 3-car AI field, the oval, started. */
function hostRace(seats: ReadonlyMap<number, string>): World {
  const w = makeWorld();
  w.race.enter();
  w.race.playerName = "Ann";
  w.race.setSeats(seats);
  w.race.command({ type: "options", options: { trackId: "oval", aiCount: 3, laps: 1 } });
  w.race.command({ type: "start" });
  return w;
}

/** A client world that adopted the host's rules state as car `self`, through the race message a client decodes. */
function clientOf(host: World, self: number): World {
  const c = makeWorld();
  c.race.enter();
  // The host's field size (NetPlay sets it from snapshots); the setup park makes aiCount + 1 cars.
  c.race.command({ type: "options", options: { trackId: "oval", aiCount: host.live().length - 1 } });
  host.race.look = 0xcafe1234;
  const wire = readRace(writeRace({ lobby: null, trackId: "oval", look: host.race.look, snap: host.race.snapshot() }));
  assert.ok(wire?.snap, "the host's race state passes the client's checks");
  assert.equal(wire.look, 0xcafe1234, "the field's driver-look seed crosses the wire");
  c.race.look = wire.look;
  c.race.applySnapshot(wire.snap, self);
  return c;
}

describe("given a host race on the oval with three AI cars, the host player Ann, and a network peer Zed seated on car 2", () => {
  it("when a client adopts the host's rules state as car 2, then the host seats Zed as a remote car and the client seats him as its own player, each under the chosen names", (t) => {
    t.after(() => setGround(null));
    const host = hostRace(new Map([[2, "Zed"]]));
    const hud = host.race.hud();
    assert.deepEqual(
      hud.standings.map((r) => [r.id, r.name, r.you]).sort((a, b) => Number(a[0]) - Number(b[0])),
      [
        [0, "Ann", true],
        [1, "Car1", false],
        [2, "Zed", false],
        [3, "Car3", false],
      ],
    );

    const client = clientOf(host, 2);
    const ch = client.race.hud();
    assert.equal(ch.you?.id, 2, "the client's own row is its car");
    assert.deepEqual(
      ch.standings.map((r) => [r.id, r.name, r.you]).sort((a, b) => Number(a[0]) - Number(b[0])),
      [
        [0, "Ann", false],
        [1, "Car1", false],
        [2, "Zed", true],
        [3, "Car3", false],
      ],
    );
    assert.equal(client.seat.mode, "drive");
    assert.equal(client.seat.carIndex, 2);
    host.race.exit();
    client.race.exit();
  });

  it("when the peer sends throttle input after the race starts, then its car waits on the grid until then, the peer's input drives it rather than the AI, and its respawn request is honoured while the paused host's own is ignored", (t) => {
    t.after(() => setGround(null));
    const host = hostRace(new Map([[2, "Zed"]]));
    const state = { acc: 0 };
    const start = host.live()[2]!.group.position.clone();
    for (let k = 0; k < 60 * 6 && host.race.phase !== "racing"; k++) frame(host, state);
    assert.equal(host.race.phase, "racing");
    // No input yet: the seat is held, it never falls back to the AI.
    for (let k = 0; k < 60; k++) frame(host, state);
    assert.ok(host.live()[2]!.group.position.distanceTo(start) < 1, "an unseated remote car waits on the grid");
    host.race.setRemoteInput(2, { throttle: 1, steer: 0, brake: 0, ebrake: false, boost: false });
    for (let k = 0; k < 120; k++) frame(host, state);
    assert.ok(host.live()[2]!.velocity.length() > 5, "the peer's throttle drives its car");
    // The host's own menu (pause) gates only the host's respawn, never a peer's.
    host.race.command({ type: "pause" });
    host.race.requestRespawn(0);
    host.race.requestRespawn(2);
    const snap = host.race.snapshot()!;
    assert.equal(snap.cars.find((c) => c.id === 2)!.status, "respawning", "the peer's respawn request reached the rules");
    assert.equal(snap.cars.find((c) => c.id === 0)!.status, "racing", "the paused host's own request is ignored");
    host.race.exit();
  });
});

describe("given a host race with no network peers seated", () => {
  it("when a peer joins mid-race as car 4 and adopts the host's state, then it spectates until the next race instead of driving", (t) => {
    t.after(() => setGround(null));
    const host = hostRace(new Map());
    const late = clientOf(host, 4);
    assert.equal(late.race.hud().you, null, "not in this race's field");
    assert.notEqual(late.seat.carIndex, 4);
    assert.notEqual(late.seat.mode, "drive");
    host.race.exit();
    late.race.exit();
  });
});
