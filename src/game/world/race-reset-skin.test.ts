import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { setGround } from "./ground.ts";
import { TRACKS } from "./tracks/index.ts";
import { parseTrack } from "./track-schema.ts";
import { Track } from "./track.ts";
import { FRAME, makeWorld, frame, type World } from "./race-world.test-util.ts";
import type { DeformableCar } from "../vehicle/car.ts";

/** The player's car on the oval 8 s in, with a mirror torn off and (`hit`) a hit taken, then settled: its torn mirror lies on the road. */
function crashed(hit = true): { w: World; car: DeformableCar; state: { acc: number } } {
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
  for (let n = 0; n * FRAME < 8; n++) {
    w.seat.intent.gas = w.race.hud().phase === "racing" ? 1 : 0;
    frame(w, state);
  }
  const car = w.live()[0]!;
  car.breakMirror(1, new THREE.Vector3(0, 0, 1));
  if (hit) car.applyImpact(car.group.position.clone().addScaledVector(car.forward, 2), car.forward.clone().negate(), 6, 6);
  w.seat.intent.gas = 0;
  const flying = (): boolean => car["parts"].some((p) => p.detached && (p.velocity.length() > 0.05 || p.angular.length() > 0.05));
  for (let n = 0; n < 60 || (flying() && n < 900); n++) frame(w, state);
  return { w, car, state };
}

/** The most any vertex of the skinned meshes is from `before` (their positions as read earlier), over every mesh the crush skin writes (m). */
function skinDrift(before: Float32Array[], car: DeformableCar): number {
  let worst = 0;
  for (const [i, g] of car.skinGeometries().entries()) {
    const a = g.getAttribute("position").array;
    for (let k = 0; k < a.length; k++) worst = Math.max(worst, Math.abs(a[k]! - before[i]![k]!));
  }
  return worst;
}

describe("given the player's car crashed in a race with a mirror torn off and lying on the road", () => {
  it("when the reset is held again and again, then the drawn body is the one the car had before the first hold, on the first frame of each", (t) => {
    t.after(() => setGround(null));
    const { w, car, state } = crashed();
    const skin = car.skinGeometries().map((g) => Float32Array.from(g.getAttribute("position").array));
    assert.ok(car.deform.massActive, "the fixture's crash started");
    for (let k = 1; k <= 3; k++) {
      w.race.holdReset();
      frame(w, state);
      assert.ok(skinDrift(skin, car) < 0.001, `hold ${k}: the drawn body drifted ${skinDrift(skin, car).toFixed(3)} m from the damaged car's`);
    }
  });

  it("when only a mirror is torn (no hit: no skin was ever baked) and the reset is held, then the drawn body is the whole, undented one, not collapsed by the net state's zero skin inputs", (t) => {
    t.after(() => setGround(null));
    const { w, car, state } = crashed(false);
    const skin = car.skinGeometries().map((g) => Float32Array.from(g.getAttribute("position").array));
    assert.ok(!car.deform.massActive && car.hasLoosePart(), "the fixture's car has a part off and no crash");
    w.race.holdReset();
    frame(w, state);
    assert.ok(skinDrift(skin, car) < 0.001, `the drawn body drifted ${skinDrift(skin, car).toFixed(3)} m from the car's own`);
  });

  it("when the reset is held again and again, then the torn mirror stays torn and where it lies, thrown no more", (t) => {
    t.after(() => setGround(null));
    const { w, car, state } = crashed();
    const torn = car["parts"].filter((p) => p.detached);
    assert.ok(torn.length >= 1, "the fixture's crash tore a part off");
    const lies = torn.map((p) => p.object.position.clone());
    for (let k = 1; k <= 3; k++) {
      w.race.holdReset();
      frame(w, state);
      assert.equal(car["parts"].filter((p) => p.detached).length, torn.length, `hold ${k}: the torn part count changed`);
      for (const p of torn) assert.ok(p.detached, `hold ${k}: ${p.name} is attached again`);
      for (const [i, p] of torn.entries()) assert.ok(p.object.position.distanceTo(lies[i]!) < 0.02, `hold ${k}: ${p.name} was moved ${p.object.position.distanceTo(lies[i]!).toFixed(2)} m from where it lies`);
    }
  });
});
