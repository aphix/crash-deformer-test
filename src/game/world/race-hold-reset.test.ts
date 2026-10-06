import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { setGround } from "./ground.ts";
import { TRACKS } from "./tracks/index.ts";
import { parseTrack } from "./track-schema.ts";
import { Track } from "./track.ts";
import { FRAME, makeWorld, frame, type World } from "./race-world.test-util.ts";
import { makeCarFrame } from "../net/codec.ts";
import { carLayout } from "../net/car-pose.ts";
import { RESPAWN_REQUEST_DELAY } from "../match/session.ts";

/** How many parts are torn off the car, and how many wheels are off it. */
function lost(w: World): { parts: number; wheels: number; massActive: boolean } {
  const car = w.live()[0]!;
  const f = makeCarFrame(carLayout(car));
  car.readPartNetState(f.parts);
  return { parts: f.parts.flags.filter((x) => x & 1).length, wheels: f.parts.wheelLoose, massActive: car.deform.massActive };
}

/** The player's car racing on the oval a few seconds in, with a mirror torn off and a hit taken. */
function damaged(): { w: World; state: { acc: number } } {
  const w = makeWorld();
  const track = new Track(TRACKS.find((j) => parseTrack(j).id === "oval"));
  w.race.enter();
  w.race.command({ type: "quit" });
  w.race.command({ type: "options", options: { trackId: track.id, laps: 3, aiCount: 2, noReset: false, aggression: 0.3 } });
  w.race.command({ type: "start" });
  const state = { acc: 0 };
  w.seat.mode = "drive";
  w.seat.carIndex = 0;
  w.seat.intent.analogGas = true;
  for (let n = 0; n * FRAME < 12; n++) {
    w.seat.intent.gas = w.race.hud().phase === "racing" ? 1 : 0;
    frame(w, state);
  }
  const car = w.live()[0]!;
  car.breakMirror(1, new THREE.Vector3(0, 0, 1));
  car.applyImpact(car.group.position.clone().addScaledVector(car.forward, 2), car.forward.clone().negate(), 6, 6);
  for (let n = 0; n < 30; n++) frame(w, state);
  return { w, state };
}

describe("given the player's car in a respawn race with a mirror torn off and a crash taken", () => {
  it("when the reset is held, then the car is back on the road at once at rest with the torn mirror still gone and the wreck state kept, and when it is tapped, then it comes back whole after the pause", (t) => {
    t.after(() => setGround(null));
    const { w, state } = damaged();
    const before = lost(w);
    assert.ok(before.parts >= 1, "a part is off");
    assert.ok(before.massActive, "the crash started");
    w.race.holdReset();
    for (let n = 0; n < 5; n++) frame(w, state);
    const held = lost(w);
    assert.equal(held.parts, before.parts, "the torn parts stay torn");
    assert.equal(held.wheels, before.wheels, "the wheels off stay off");
    assert.equal(held.massActive, true, "the wreck state is kept");
    assert.ok(w.live()[0]!.velocity.length() < 3, `the car starts again from rest (${w.live()[0]!.velocity.length().toFixed(1)} m/s)`);
    assert.equal(w.race.hud().you!.status, "racing");
    w.race.requestRespawn();
    for (let n = 0; n < (RESPAWN_REQUEST_DELAY + 0.5) / FRAME; n++) frame(w, state);
    const whole = lost(w);
    assert.equal(whole.parts, 0, "a tap repairs");
    assert.equal(whole.massActive, false);
  });
});
