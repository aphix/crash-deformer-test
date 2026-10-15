import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import "../kernel/rapier-node.test-util.ts";
import { HudStore } from "../hud/hud-store.ts";
import { setGround } from "../world/ground.ts";
import { CrashEngine } from "./engine.ts";
import { element, stubBrowser } from "./engine-headless.test-util.ts";

const FRAME = 1 / 60;
const CANVAS_W = 800;
const CANVAS_H = 600;

describe("given the real engine in a derby match past its green light, nobody seated", () => {
  // One engine for the file: a second `CrashEngine` in the same process never resolves `ready`.
  let engine: CrashEngine;
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) engine.advance(FRAME, { frameDt: FRAME });
  };
  /** The stand-in canvas has no size, so the camera's view offset is NaN: a plain frustum at the stand-in canvas's aspect, matrices current. */
  const frameCamera = (): void => {
    const camera = engine["camera"];
    camera.clearViewOffset();
    camera.aspect = CANVAS_W / CANVAS_H;
    camera.updateProjectionMatrix();
    engine["scene"].updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
  };
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
      if (spot === null) continue;
      engine["pickCar"](spot.x, spot.y);
      assert.deepEqual([engine["seat"].mode, engine["seat"].carIndex], ["follow", index], `a click on car ${index} follows it`);
      engine["keys"].add("KeyW");
      run(0.1);
      engine["keys"].clear();
      assert.deepEqual([engine["seat"].mode, engine["seat"].carIndex], ["drive", index], `W takes the wheel of car ${index}`);
      clicked++;
    }
    assert.ok(clicked >= 2, `at least two of the five cars were on screen to click (saw ${clicked})`);
  });
});