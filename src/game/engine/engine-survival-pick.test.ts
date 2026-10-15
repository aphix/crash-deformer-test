import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import "../kernel/rapier-node.test-util.ts";
import { HudStore } from "../hud/hud-store.ts";
import { TRACK_ID } from "../world/constants.ts";
import { setGround } from "../world/ground.ts";
import { CrashEngine } from "./engine.ts";
import { element, stubBrowser } from "./engine-headless.test-util.ts";

/**
 * Where a Survival run's course is picked (docs/SURVIVAL.md): a shared `#` boots straight into a run on the course it names, the
 * scene bar's Survival opens Survival's own menu first (the run starts on Start survival), and the address follows the pick.
 */

const FRAME = 1 / 60;

describe("given the real engine booted on #scene=survival&track=national-mall", () => {
  // One engine for the file: a second `CrashEngine` in the same process never resolves `ready`.
  let engine: CrashEngine;
  const bar: string[] = [];
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) engine.advance(FRAME, { frameDt: FRAME });
  };
  before(async () => {
    stubBrowser();
    globalThis.location.hash = "#scene=survival&track=national-mall";
    // The address bar as the browser keeps it: a write lands in `location.hash`.
    globalThis.history.replaceState = (_state, _unused, url) => {
      bar.push(String(url));
      globalThis.location.hash = String(url).slice(String(url).indexOf("#"));
    };
    engine = new CrashEngine(element(), new HudStore(), element());
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

  it("when the page has loaded, then a Survival run is on the Mall at once, with no menu in front of it", () => {
    run(0.5);
    const hud = engine["race"].hud();
    assert.equal(engine["race"].active, true);
    assert.equal(engine["race"].survival, true);
    assert.equal(engine["race"].courseId, TRACK_ID.nationalMall);
    assert.equal(hud.menu, null, "a link starts the run like every other scene");
    assert.notEqual(hud.survival, null, "a run, not a parked field");
  });

  it("when the scene bar's Survival is pressed from the fleet, then Survival's menu is up on the picked course with no run started, a pick moves the course behind it, and Start survival runs the picked course", () => {
    engine.toggleSurvival(); // in Survival: back to the fleet
    assert.equal(engine["race"].active, false);
    engine.toggleSurvival(); // the bottom bar's way in
    const menu = engine["race"].hud();
    assert.equal(engine["race"].active, true);
    assert.equal(menu.menu, "survival", "the menu comes first");
    assert.equal(menu.phase, null, "no race session behind it");
    assert.equal(menu.survival, null, "no run");
    assert.equal(menu.time, 0, "no clock");
    assert.equal(menu.survivalCourse, TRACK_ID.nationalMall, "the last pick stands");
    engine.raceCommand({ type: "survivalCourse", id: "havana" });
    assert.equal(engine["race"].hud().menu, "survival", "a pick keeps the menu up");
    assert.equal(engine["race"].courseId, "havana", "the course behind the menu follows");
    run(0.5);
    assert.equal(engine["race"].hud().phase, null, "waiting in the menu starts nothing");
    engine.raceCommand({ type: "survivalCourse", id: TRACK_ID.nationalMall });
    engine.raceCommand({ type: "start" });
    const started = engine["race"].hud();
    assert.equal(started.menu, null);
    assert.notEqual(started.survival, null);
    assert.equal(engine["race"].courseId, TRACK_ID.nationalMall, "Start survival runs the picked course");
  });

  it("when Change course is pressed in a run, then Survival's menu is back with the run dropped, and the address names the course picked there", () => {
    run(1);
    engine.raceCommand({ type: "survivalMenu" });
    const menu = engine["race"].hud();
    assert.equal(menu.menu, "survival");
    assert.equal(menu.survival, null, "the run is dropped");
    engine.raceCommand({ type: "survivalCourse", id: "havana" });
    engine.raceCommand({ type: "start" });
    run(FRAME);
    assert.equal(engine["race"].courseId, "havana");
    assert.match(bar.at(-1)!, /#scene=survival&track=havana$/, "the # follows the run");
  });

  it("when the # is edited to name the Mall again, then the run restarts on it", () => {
    run(1);
    const before = engine["race"].hud().time;
    globalThis.location.hash = "#scene=survival&track=national-mall";
    engine["onShareHash"]();
    assert.equal(engine["race"].courseId, TRACK_ID.nationalMall);
    assert.equal(engine["race"].survival, true);
    assert.ok(engine["race"].hud().time < before, "a fresh run clock");
  });
});
