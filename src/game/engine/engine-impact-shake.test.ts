import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { HudStore } from "../hud/hud-store.ts";
import { CHASE } from "../present/drive-cam.ts";
import type { ContactHit } from "../scenes/engine-props.ts";
import { setGround } from "../world/ground.ts";
import { CrashEngine } from "./engine.ts";
import { element, stubBrowser } from "./engine-headless.test-util.ts";
import { FRAME_HZ } from "../kernel/constants.ts";

const FRAME = 1 / FRAME_HZ;

/** The parts of the engine this file reaches: the private rules it drives are the ones under test. */
type Reach = {
  seat: { mode: string; carIndex: number; view: string };
  view: { trauma: number };
  clock: { phase: string };
  cine: { update(wallDt: number, simDt: number, cars: unknown[], followed: unknown, driving: boolean, fxDensity: number, velocityHits: boolean): void };
  pairHit(a: number, b: number, hit: ContactHit): void;
  race: { grid: number[]; propHits: { wall(index: number, car: number, closing: number, x: number, z: number, nx: number, nz: number): void } };
  derbyHits: { wall(index: number, car: number, closing: number, x: number, z: number, nx: number, nz: number): void };
  derbyMode: boolean;
  live(): { velocity: THREE.Vector3; speed: number; spawnFacing(x: number, z: number, yaw: number, speed: number): void; spawnSpeed: number }[];
};

describe("given the real engine and a hit on the car the camera follows", () => {
  // One engine for the file: a second `CrashEngine` in the same process never resolves `ready`.
  let engine: CrashEngine;
  let e: Reach;
  const hit = (impulse: number): ContactHit => ({ impulse, contact: new THREE.Vector3(), normal: new THREE.Vector3(1, 0, 0) });
  /** One frame after `act`: the trauma it left (less the frame's own decay). */
  const after1 = (act: () => void): number => {
    e.view.trauma = 0;
    act();
    engine.advance(FRAME, { frameDt: FRAME });
    return e.view.trauma;
  };
  before(async () => {
    stubBrowser();
    engine = new CrashEngine(element(), new HudStore(), element());
    Object.assign(engine["renderer"], { render() {}, compile() {}, compileAsync: () => Promise.resolve() });
    await engine.ready;
    engine.fadeScenes = false;
    e = engine as unknown as Reach;
  });
  after(() => {
    engine.dispose();
    setGround(null);
  });

  it("when two cars meet head-on in the sandbox after its first crash, then the followed car's view shakes by the hit, and a view that follows nobody does not", () => {
    // Past the approach: the first crash's own kick (`beginCinematic`) is out of this, so what shakes is the later-hit rule alone.
    e.clock.phase = "aftermath";
    e.seat.mode = "drive";
    e.seat.carIndex = 0;
    e.seat.view = "third";
    engine["looping"] = false;
    const cars = e.live();
    for (const [k, car] of cars.entries()) {
      if (k < 2) {
        const dir = k === 0 ? 1 : -1;
        car.spawnFacing(-dir * 6, -dir * 0.3, (dir * Math.PI) / 2, 0);
        car.velocity.set(dir * 12, 0, 0);
        car.speed = 12;
      } else {
        car.spawnFacing(0, 30 + 4 * k, 0, 0);
        car.speed = 0;
      }
      car.spawnSpeed = car.speed;
    }
    let peak = 0;
    for (let f = 0; f < 90; f++) {
      engine.advance(FRAME, { frameDt: FRAME });
      peak = Math.max(peak, e.view.trauma);
    }
    assert.ok(peak > 0.3, `a 24 m/s head-on shook the followed car's view to ${peak.toFixed(2)}`);
    e.seat.mode = "global";
    assert.equal(after1(() => e.pairHit(0, 1, hit(24))), 0, "no car followed");
    e.seat.mode = "drive";
  });

  it("when the race's followed car is hit by another car at 15 m/s, 1 m/s, or two others are, then it shakes by the hit, hardly at all, and not at all", () => {
    engine.toggleRace();
    engine.raceCommand({ type: "start" });
    for (let f = 0; f < 60 * 12; f++) engine.advance(FRAME, { frameDt: FRAME });
    const [a, b, c] = e.race.grid as [number, number, number];
    e.seat.mode = "drive";
    e.seat.carIndex = a;
    for (const view of ["third", "far", "first"]) {
      e.seat.view = view;
      const t = after1(() => e.pairHit(b, a, hit(15)));
      assert.ok(t > 0.6 && t < 0.75, `${view}: a 15 m/s hit leaves trauma ${t.toFixed(2)}`);
    }
    assert.ok(after1(() => e.pairHit(a, b, hit(1))) < 0.01, "a 1 m/s nudge");
    assert.equal(after1(() => e.pairHit(b, c, hit(25))), 0, "a hit between two other cars");
  });

  it("when the race's followed car meets a wall or prop at 15 m/s, then its view shakes, and when the strength knob is 0, it does not", () => {
    const [a, b] = e.race.grid as [number, number];
    e.seat.carIndex = a;
    e.seat.view = "third";
    const t = after1(() => e.race.propHits.wall(0, a, 15, 0, 0, 1, 0));
    assert.ok(t > 0.6, `wall hit leaves trauma ${t.toFixed(2)}`);
    assert.equal(after1(() => e.race.propHits.wall(0, b, 15, 0, 0, 1, 0)), 0, "another car's wall hit");
    engine.setChaseKnob("cam.shake", 0);
    try {
      assert.equal(after1(() => e.race.propHits.wall(0, a, 15, 0, 0, 1, 0)), 0, "strength 0");
      assert.equal(after1(() => e.pairHit(a, b, hit(15))), 0, "strength 0, pair hit");
    } finally {
      engine.resetSetting("cam.shake");
    }
    assert.equal(CHASE.shake, 1);
  });

  it("when the derby's followed car hits a car or the arena wall at 15 m/s, then its view shakes", () => {
    engine.toggleDerby();
    for (let f = 0; f < 60 * 2; f++) engine.advance(FRAME, { frameDt: FRAME });
    assert.ok(e.derbyMode, "the derby is on");
    e.seat.mode = "drive";
    e.seat.carIndex = 0;
    e.seat.view = "third";
    const pair = after1(() => e.pairHit(0, 1, hit(15)));
    const wall = after1(() => e.derbyHits.wall(0, 0, 15, 0, 0, 1, 0));
    assert.ok(pair > 0.6 && wall > 0.6, `pair hit ${pair.toFixed(2)}, wall hit ${wall.toFixed(2)}`);
  });

  it("when the followed car's velocity jumps 12 m/s in a frame with the world's contacts not running (a netplay client), then its view shakes, and with them running the jump alone does not", () => {
    const cars = e.live();
    const followed = cars[0]!;
    const jump = (velocityHits: boolean): number => {
      e.view.trauma = 0;
      // Past the last hit's 0.3 s cool-down.
      for (let f = 0; f < 25; f++) e.cine.update(FRAME, FRAME, cars, followed, false, 1, velocityHits);
      followed.velocity.x += 12;
      e.cine.update(FRAME, FRAME, cars, followed, false, 1, velocityHits);
      return e.view.trauma;
    };
    assert.equal(jump(false), 0, "contacts running: the contact hooks own the shake");
    assert.ok(jump(true) > 0.3, `client: trauma ${e.view.trauma.toFixed(2)}`);
  });
});
