import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../ground.ts";
import { frame, makeWorld, type World } from "../race/race-world.test-util.ts";

/** Host world with network peers seated on `seats`, a 3-car AI field, the oval, started. */
function hostRace(seats: number[]): World {
  const w = makeWorld();
  w.race.enter();
  w.race.setSeats(seats);
  w.race.command({ type: "options", options: { trackId: "oval", aiCount: 3, laps: 1 } });
  w.race.command({ type: "start" });
  return w;
}

/** A client world that adopted the host's rules state as car `self` (wire: JSON). */
function clientOf(host: World, self: number): World {
  const c = makeWorld();
  c.race.enter();
  // The host's field size (NetPlay sets it from snapshots); the setup park makes aiCount + 1 cars.
  c.race.command({ type: "options", options: { trackId: "oval", aiCount: host.live().length - 1 } });
  c.race.applySnapshot(JSON.parse(JSON.stringify(host.race.snapshot())), self);
  return c;
}

describe("race netplay: seats and the replicated rules state", () => {
  it("seats a network peer as remote on the host, and as this browser's player on its own client", (t) => {
    t.after(() => setGround(null));
    const host = hostRace([2]);
    const hud = host.race.hud();
    assert.deepEqual(
      hud.standings.map((r) => [r.id, r.name, r.you]).sort((a, b) => Number(a[0]) - Number(b[0])),
      [
        [0, "You", true],
        [1, "Car1", false],
        [2, "Player 2", false],
        [3, "Car3", false],
      ],
    );

    const client = clientOf(host, 2);
    const ch = client.race.hud();
    assert.equal(ch.you?.id, 2, "the client's own row is its car");
    const names = new Map(ch.standings.map((r) => [r.id, r.name]));
    assert.equal(names.get(0), "Host");
    assert.equal(names.get(2), "You");
    assert.equal(client.seat.mode, "drive");
    assert.equal(client.seat.carIndex, 2);
    host.race.exit();
    client.race.exit();
  });

  it("drives the remote seat from the peer's input, not the AI, and respawns it on the peer's request", (t) => {
    t.after(() => setGround(null));
    const host = hostRace([2]);
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

  it("lets a peer that joined mid-race spectate until the next race", (t) => {
    t.after(() => setGround(null));
    const host = hostRace([]);
    const late = clientOf(host, 4);
    assert.equal(late.race.hud().you, null, "not in this race's field");
    assert.notEqual(late.seat.carIndex, 4);
    assert.notEqual(late.seat.mode, "drive");
    host.race.exit();
    late.race.exit();
  });
});
