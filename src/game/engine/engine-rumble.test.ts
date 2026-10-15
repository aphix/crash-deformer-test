import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { HudStore } from "../hud/hud-store.ts";
import { LANDING } from "../present/landing.ts";
import type { ContactHit } from "../scenes/engine-props.ts";
import type { Rumble } from "../vehicle/gamepad.ts";
import { setGround } from "../world/ground.ts";
import { CrashEngine } from "./engine.ts";
import { element, stubBrowser } from "./engine-headless.test-util.ts";
import { FRAME_HZ } from "../kernel/constants.ts";

const FRAME = 1 / FRAME_HZ;

/** The parts of the engine this file reaches. */
type Reach = {
  seat: { mode: string; carIndex: number; view: string; drift: { s: number; clean: boolean; paid: number } };
  view: { drive: { landFall: number } };
  clock: { phase: string };
  pad: { rumble(r: Rumble): boolean };
  pairHit(a: number, b: number, hit: ContactHit): void;
  rumbleFrame(wallDt: number): void;
  live(): { drive: { slide: number }; spawnFacing(x: number, z: number, yaw: number, speed: number): void; spawnSpeed: number; speed: number }[];
};

describe("given the real engine, with a pad that records the effects it is sent", () => {
  // One engine for the file: a second `CrashEngine` in the same process never resolves `ready`.
  let engine: CrashEngine;
  let store: HudStore;
  let e: Reach;
  let sent: Rumble[] = [];
  const hit = (impulse: number): ContactHit => ({ impulse, contact: new THREE.Vector3(), normal: new THREE.Vector3(1, 0, 0) });
  /** The effects one frame sends after `act`. */
  const effects = (act: () => void): Rumble[] => {
    sent = [];
    act();
    engine.advance(FRAME, { frameDt: FRAME });
    return sent;
  };
  before(async () => {
    stubBrowser();
    store = new HudStore();
    engine = new CrashEngine(element(), store, element());
    Object.assign(engine["renderer"], { render() {}, compile() {}, compileAsync: () => Promise.resolve() });
    await engine.ready;
    engine.fadeScenes = false;
    e = engine as unknown as Reach;
    e.pad.rumble = (r) => {
      sent.push({ ...r });
      return true;
    };
    // Past the approach and with the cars parked well apart and still: nothing in the sandbox hits, lands or slides on its own.
    e.clock.phase = "aftermath";
    engine["looping"] = false;
    for (const [k, car] of e.live().entries()) {
      car.spawnFacing(0, 30 + 8 * k, 0, 0);
      car.speed = 0;
      car.spawnSpeed = 0;
    }
    e.seat.mode = "drive";
    e.seat.carIndex = 0;
    e.seat.view = "third";
  });
  after(() => {
    engine.dispose();
    setGround(null);
  });

  it("when the driven car is hit at 15 m/s, then the pad rumbles by that closing speed once, and a 1 m/s nudge sends nothing", () => {
    const fx = effects(() => e.pairHit(1, 0, hit(15)));
    assert.equal(fx.length, 1);
    assert.ok(Math.abs(fx[0]!.strong - 13 / 18) < 1e-9 && Math.abs(fx[0]!.ms - (80 + 320 * (13 / 18))) < 1e-6, JSON.stringify(fx[0]));
    assert.deepEqual(effects(() => e.pairHit(1, 0, hit(1))), []);
  });

  it("when a car the seat does not drive is hit, or the seat only follows the hit car, then the pad stays quiet", () => {
    assert.deepEqual(effects(() => e.pairHit(1, 2, hit(25))), [], "another car's hit");
    e.seat.mode = "follow";
    try {
      assert.deepEqual(effects(() => e.pairHit(1, 0, hit(25))), [], "a followed car");
    } finally {
      e.seat.mode = "drive";
    }
  });

  it("when the Rumble setting is off, then a hit sends nothing, and when it is on again, it does", () => {
    engine.setRumble(false);
    try {
      assert.equal(store.get().rumble, false, "the HUD carries the setting");
      assert.deepEqual(effects(() => e.pairHit(1, 0, hit(25))), []);
    } finally {
      engine.setRumble(true);
    }
    assert.equal(store.get().rumble, true);
    assert.equal(effects(() => e.pairHit(1, 0, hit(25))).length, 1);
  });

  it("when the drive camera lands the driven car after a fall, then the pad thuds by the fall once, and a landing the seat was not driving through plays later never", () => {
    e.view.drive.landFall = LANDING.fall + 10;
    const fx = effects(() => {});
    assert.equal(fx.length, 1);
    assert.ok(Math.abs(fx[0]!.strong - 1) < 1e-9 && Math.abs(fx[0]!.ms - 380) < 1e-6, JSON.stringify(fx[0]));
    assert.equal(e.view.drive.landFall, 0, "taken");
    e.seat.mode = "follow";
    e.view.drive.landFall = 12;
    engine.advance(FRAME, { frameDt: FRAME });
    e.seat.mode = "drive";
    assert.equal(e.view.drive.landFall, 0, "taken, and silent, while following");
    assert.deepEqual(effects(() => {}), []);
  });

  it("when the driven car slides, then the pad buzzes lightly every 0.1 s, and not under the long effect of a hit still playing", () => {
    const car = e.live()[0]!;
    car.drive.slide = 0.8;
    engine["slideClock"] = 0;
    try {
      sent = [];
      e.rumbleFrame(FRAME);
      assert.equal(sent.length, 1, "the buzz starts at once");
      for (let f = 1; f < 60; f++) e.rumbleFrame(FRAME);
      assert.ok(sent.length >= 9 && sent.length <= 11, `${sent.length} buzzes in a second`);
      assert.ok(sent.every((r) => r.strong === 0 && r.weak > 0.1 && r.weak < 0.25), "the light motor alone");
      // A hit's effect holds the buzz back for its own length (400 ms at 20 m/s).
      sent = [];
      e.pairHit(1, 0, hit(20));
      engine["shakeOnHits"]();
      assert.equal(sent.length, 1, "the hit");
      for (let f = 0; f < 20; f++) e.rumbleFrame(FRAME);
      assert.equal(sent.length, 1, "no buzz inside the hit's 0.4 s");
      for (let f = 0; f < 20; f++) e.rumbleFrame(FRAME);
      assert.ok(sent.length > 1, "the buzz comes back");
    } finally {
      car.drive.slide = 0;
    }
  });

  it("when the seat is sliding, then the HUD's drift is the seat's slide as a copy, and `NO_DRIFT` when the seat is not driving", () => {
    Object.assign(e.seat.drift, { s: 1.1, clean: true, paid: 2 });
    engine["emitHud"]();
    const shown = store.get().drift;
    assert.deepEqual(shown, { s: 1.1, clean: true, paid: 2 });
    assert.notEqual(shown, e.seat.drift, "published as a copy");
    e.seat.mode = "global";
    try {
      engine["emitHud"]();
      assert.deepEqual(store.get().drift, { s: 0, clean: true, paid: 0 });
    } finally {
      e.seat.mode = "drive";
      Object.assign(e.seat.drift, { s: 0, clean: true, paid: 0 });
    }
  });
});
