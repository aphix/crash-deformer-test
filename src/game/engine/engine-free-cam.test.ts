import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { HudStore } from "../hud/hud-store.ts";
import { setGround } from "../world/ground.ts";
import { CrashEngine } from "./engine.ts";
import { element, stubBrowser } from "./engine-headless.test-util.ts";
import { FRAME_HZ } from "../kernel/constants.ts";
import { FreeCam } from "../present/free-cam.ts";

const FRAME = 1 / FRAME_HZ;
/** The fleet disc's free cruise (m/s), read off the eye itself: the view's own scale is `free-cam.test.ts`'s to pin. */
const DISC_CRUISE = new FreeCam().cruise;

describe("given the real engine in the fleet, watching a car", () => {
  // One engine for the file: a second `CrashEngine` in the same process never resolves `ready`.
  let engine: CrashEngine;
  let hud: HudStore;
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * FRAME_HZ; i++) engine.advance(FRAME, { frameDt: FRAME });
  };
  const press = (code: string): void => {
    engine["onKey"](Object.assign(new Event("keydown"), { code, repeat: false, ctrlKey: false, metaKey: false, altKey: false }) as KeyboardEvent);
    engine["keys"].delete(code);
  };
  /** The fleet, its first car followed, View pressed until the HUD names the free view (at most one turn of the ring), no key held. */
  const flyFree = (): void => {
    engine["view"].leaveFree();
    engine["view"].spec = null;
    engine["setScene"]("fleet");
    engine["seat"].focus(0);
    engine["keys"].clear();
    run(FRAME);
    for (let presses = 0; presses < 10 && hud.get().cam !== "free"; presses++) engine.cycleCamera();
    assert.equal(hud.get().cam, "free", "the free view is in the ring");
    run(FRAME);
  };
  const eye = (): THREE.Vector3 => engine["camera"].position.clone();
  const level = (a: THREE.Vector3, b: THREE.Vector3): number => Math.hypot(a.x - b.x, a.z - b.z);

  before(async () => {
    stubBrowser();
    hud = new HudStore();
    engine = new CrashEngine(element(), hud, element());
    Object.assign(engine["renderer"], { render() {}, compile() {}, compileAsync: () => Promise.resolve() });
    await engine.ready;
    engine.fadeScenes = false;
    let tick = 0;
    Object.assign(engine.pace, { now: () => (tick += 0.001) });
  });
  after(() => {
    engine.dispose();
    setGround(null);
  });

  it("when View is cycled round to the free view, then the HUD names it, the seat still follows, and W flies the eye the cruise speed a second without taking the wheel", () => {
    flyFree();
    const start = eye();
    engine["keys"].add("KeyW");
    run(1);
    engine["keys"].clear();
    assert.equal(engine["seat"].mode, "follow", "W flew the camera; it did not take the wheel");
    assert.ok(Math.abs(level(eye(), start) - DISC_CRUISE) < 0.5, `the eye flew ${level(eye(), start).toFixed(2)} m level in a second, cruise ${DISC_CRUISE} m/s`);
  });

  it("when the same W is held without the free view, then the seat takes the wheel (the control for the test above)", () => {
    engine["view"].leaveFree();
    engine["view"].spec = null;
    engine["seat"].focus(0);
    engine["keys"].clear();
    run(FRAME);
    engine["keys"].add("KeyW");
    run(0.1);
    engine["keys"].clear();
    assert.equal(engine["seat"].mode, "drive", "W drives in the other views");
    engine["seat"].esc();
  });

  it("when the free view is on and nothing is held, then the eye stays where it was while the watched car is carried 40 m away", () => {
    flyFree();
    const car = engine["cars"][0]!;
    const start = eye();
    car.group.position.x += 40;
    run(0.3);
    assert.ok(eye().distanceTo(start) < 1e-6, `the eye drifted ${eye().distanceTo(start)} m`);
  });

  it("when the free view is on, then the camera's own rig is the free one", () => {
    flyFree();
    assert.equal(engine["cameraRig"](), "free");
  });

  it("when PageDown is held for five seconds in the free view, then the eye stops above the ground", () => {
    flyFree();
    engine["keys"].add("PageDown");
    run(5);
    engine["keys"].clear();
    assert.ok(eye().y > 0.5, `the eye sank to ${eye().y.toFixed(2)} m`);
    assert.ok(eye().y < 1.5, `and rests on the clearance, at ${eye().y.toFixed(2)} m`);
  });

  it("when Esc is pressed in the free view, then the view before it comes back with the seat still following, and a second Esc steps out to the whole field", () => {
    flyFree();
    press("Escape");
    assert.equal(engine["view"].flying, false, "the free view ended");
    assert.equal(hud.get().cam, "auto", "the HUD names the view it came from (Auto, just before the free one in the ring)");
    assert.equal(engine["seat"].mode, "follow", "the first Esc did not step out");
    press("Escape");
    assert.equal(engine["seat"].mode, "global", "the second Esc steps out as before");
  });

  it("when View is pressed in the free view, then it goes back to the view before it", () => {
    flyFree();
    engine.cycleCamera();
    assert.equal(hud.get().cam, "auto", "back to Auto, the view before the free one in the ring");
  });

  it("when the seat is driven, then View cycles the car's own views and never reaches the free view", () => {
    engine["view"].leaveFree();
    engine["seat"].mode = "drive";
    engine["seat"].carIndex = 0;
    for (let presses = 0; presses < 8; presses++) {
      engine.cycleCamera();
      assert.equal(engine["view"].flying, false, `press ${presses + 1}`);
    }
    engine["seat"].esc();
  });

  it("when the seat takes the wheel during the free view (a race handing the viewer its car), then the free view ends and the driven views are back", () => {
    flyFree();
    engine["seat"].mode = "drive";
    run(FRAME);
    assert.equal(engine["view"].flying, false, "driving is not spectating");
    engine["emitHud"]();
    assert.equal(hud.get().cam, null, "and the HUD no longer names a spectator view");
    engine["seat"].esc();
  });

  it("when the highlight reel is playing its shots and the free view is on, then the viewer's eye holds the camera, not the reel's shot", () => {
    flyFree();
    const reel = engine["highlights"];
    const reelAim = reel.aim;
    const start = eye();
    reel.playing = true;
    reel.aim = (camera) => camera.position.set(500, 60, -400);
    try {
      engine["aimRigs"](FRAME);
      assert.ok(eye().distanceTo(start) < 1e-6, `the camera is at ${eye().toArray().join(", ")}, the reel's shot is at 500, 60, -400`);
      assert.equal(engine["cameraRig"](), "free", "and the trace names the free rig");
    } finally {
      reel.playing = false;
      reel.aim = reelAim;
    }
  });

  it("when the whole field is shown, then View flies free from it and View again goes back", () => {
    engine["view"].leaveFree();
    engine["seat"].clear();
    engine["setScene"]("fleet");
    run(FRAME);
    assert.equal(hud.get().cam, null, "the whole field shows no camera name");
    engine.cycleCamera();
    assert.equal(hud.get().cam, "free", "View from the whole field");
    run(FRAME);
    assert.equal(engine["view"].flying, true);
    engine.cycleCamera();
    assert.equal(hud.get().cam, null, "and back");
    assert.equal(engine["view"].flying, false);
  });

  it("when a scene is picked in the free view, then the free view ends", () => {
    flyFree();
    engine["setScene"]("derby");
    assert.equal(engine["view"].flying, false);
    engine["setScene"]("derby");
  });
});
