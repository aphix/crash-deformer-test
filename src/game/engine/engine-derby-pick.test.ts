import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import "../kernel/rapier-node.test-util.ts";
import { HudStore } from "../hud/hud-store.ts";
import { setGround } from "../world/ground.ts";
import { CrashEngine } from "./engine.ts";
import { element, frameField, stubBrowser } from "./engine-headless.test-util.ts";
import { FRAME_HZ } from "../kernel/constants.ts";

const FRAME = 1 / FRAME_HZ;
const CANVAS_W = 800;
const CANVAS_H = 600;

describe("given the real engine in a derby match past its green light, nobody seated", () => {
  // One engine for the file: a second `CrashEngine` in the same process never resolves `ready`.
  let engine: CrashEngine;
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) engine.advance(FRAME, { frameDt: FRAME });
  };
  /** The opening shot of the field, pulled back until every car shows (the stand-in canvas has no size, so no view offset). */
  const frameCamera = (): void => frameField(engine, CANVAS_W, CANVAS_H);
  /** The canvas pixel a car's roof shows at, or null while the car is off the view. */
  const screenSpot = (index: number): { x: number; y: number } | null => {
    const camera = engine["camera"];
    const spot = engine["live"]()[index]!.group.position.clone();
    spot.y += 0.5;
    spot.project(camera);
    if (spot.z > 1 || Math.abs(spot.x) > 0.95 || Math.abs(spot.y) > 0.95) return null;
    return { x: (spot.x * 0.5 + 0.5) * CANVAS_W, y: (-spot.y * 0.5 + 0.5) * CANVAS_H };
  };
  before(async () => {
    stubBrowser();
    engine = new CrashEngine(element(), new HudStore(), element());
    Object.assign(engine["renderer"], { render() {}, compile() {}, compileAsync: () => Promise.resolve() });
    await engine.ready;
    engine.fadeScenes = false;
    let tick = 0;
    Object.assign(engine.pace, { now: () => (tick += 0.001) });
    engine.toggleDerby();
    run(8);
    frameCamera();
  });
  after(() => {
    engine.dispose();
    setGround(null);
  });

  it("when each car on screen is clicked, then the seat follows that car, and a pedal press takes its wheel", () => {
    assert.equal(engine.derbyMode, true, "the derby is on");
    assert.ok(engine["derby"].time > 0, "past the green light");
    let clicked = 0;
    for (let index = 0; index < engine["carCount"]; index++) {
      engine["seat"].mode = "global";
      engine["seat"].carIndex = -1;
      engine["keys"].clear();
      run(FRAME); // one frame with no key down: the seat's pedal edge starts fresh
      frameCamera();
      const spot = screenSpot(index);
      // A car drawn over another's centre is the one a press there picks: that car's turn, not this one's.
      if (spot === null || engine["carAt"](spot.x, spot.y) !== index) continue;
      engine["watchCar"](engine["carAt"](spot.x, spot.y));
      assert.equal(engine["seat"].mode, "follow", `a click on car ${index} follows it`);
      assert.equal(engine["seat"].carIndex, index, `a click on car ${index} follows that car`);
      engine["keys"].add("KeyW");
      run(0.1);
      engine["keys"].clear();
      assert.equal(engine["seat"].mode, "drive", `W takes the wheel of car ${index}`);
      assert.equal(engine["seat"].carIndex, index, `W drives car ${index}`);
      clicked++;
    }
    assert.ok(clicked >= 2, `at least two of the five cars were on screen to click (saw ${clicked})`);
  });
});