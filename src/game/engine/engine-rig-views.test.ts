import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import "../kernel/rapier-node.test-util.ts";
import { HudStore } from "../hud/hud-store.ts";
import { CHASE } from "../present/drive-cam.ts";
import { setGround } from "../world/ground.ts";
import { CrashEngine } from "./engine.ts";
import { element, stubBrowser } from "./engine-headless.test-util.ts";
import { FRAME_HZ } from "../kernel/constants.ts";

const FRAME = 1 / FRAME_HZ;
type Rig = "press" | "pistons" | "doors" | "corkscrew";

describe("given the real engine in a rig scene, watching its car", () => {
  // One engine for the file: a second `CrashEngine` in the same process never resolves `ready`.
  let engine: CrashEngine;
  let hud: HudStore;
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) engine.advance(FRAME, { frameDt: FRAME });
  };
  /** Enter `id` from the fleet (a pick of the scene in play goes back to the fleet), its car watched (Q/E or a click), no key held. */
  const watch = (id: Rig): void => {
    engine["seat"].mode = "global";
    engine["view"].spec = null;
    engine["setScene"]("fleet");
    engine["setScene"](id);
    engine["seat"].focus(0);
    engine["keys"].clear();
    run(FRAME); // one frame with no key down: the seat's pedal edge starts fresh
    engine["emitHud"]();
  };
  /** W for a moment (the seat takes the wheel), then released. */
  const takeWheel = (): void => {
    engine["keys"].add("KeyW");
    run(0.1);
    engine["keys"].clear();
  };
  before(async () => {
    stubBrowser();
    hud = new HudStore();
    engine = new CrashEngine(element(), hud, element());
    Object.assign(engine["renderer"], { render() {}, compile() {}, compileAsync: () => Promise.resolve() });
    await engine.ready;
    engine.fadeScenes = false;
    // The rig car's spawn speed is drawn from the speed range at a random scene seed (10-32 m/s): a slow draw loses more than 10% in a second to rolling drag, which the 0.9 coast bars read as a stall. A fixed 24 m/s coasts the same every run.
    engine.setSpeedRange(24, 24);
    // The pacer's step timing is wall clock: a loaded box makes a frame run past its deadline and give sim time up (the car coasts slow).
    // A clock that reads 1 µs later each time (far from the deadline, real now + 8 ms, for any run this long) is not blind, so every frame steps its whole time.
    let tick = 0;
    Object.assign(engine.pace, { now: () => (tick += 0.001) });
  });
  after(() => {
    engine.dispose();
    setGround(null);
  });

  it("when V is pressed in each rig scene, then the HUD names the next spectator view, and the orbit is where it starts and where nine presses end", () => {
    for (const id of ["press", "pistons", "doors", "corkscrew"] as const) {
      watch(id);
      assert.equal(engine["sceneId"], id);
      assert.equal(hud.get().cam, "orbit", `${id}: the rig's default view is the orbit`);
      const seen: unknown[] = [];
      for (let i = 0; i < 9; i++) {
        engine.cycleCamera();
        seen.push(hud.get().cam);
      }
      assert.deepEqual(seen, ["auto", "free", "auto", "third", "far", "first", "cine", "dutch", "orbit"], `${id}: the views V cycles from the orbit (the free view after Auto, and V from it back to Auto), round to it`);
      engine.cycleCamera();
      assert.equal(hud.get().cam, "auto", `${id}: and round again`);
    }
  });

  it("when the chase view is picked on the corkscrew, then the camera sits behind the car within the chase distance, and the view and the run's coast survive a reset", () => {
    watch("corkscrew");
    const car = engine["carA"];
    run(0.5);
    // The orbit's next is Auto, then the free view (V from it comes back to Auto), then the chase.
    for (let presses = 0; presses < 4; presses++) engine.cycleCamera();
    assert.equal(engine["view"].specView(false), "third");
    run(0.7);
    const cam = engine["camera"].position;
    const dx = cam.x - car.group.position.x;
    const dz = cam.z - car.group.position.z;
    const dist = Math.hypot(dx, cam.y - car.group.position.y, dz);
    const along = dx * car.fwdFlat.x + dz * car.fwdFlat.z;
    assert.ok(car.velocity.length() > 5, `the car is under way at ${car.velocity.length().toFixed(1)} m/s`);
    assert.ok(along < 0, `the camera is ahead of the car (${along.toFixed(2)} m along its heading)`);
    assert.ok(dist <= CHASE.third.dist + 1.5, `the camera is ${dist.toFixed(2)} m off, the chase distance is ${CHASE.third.dist}`);
    engine.reset();
    assert.equal(engine["view"].specView(false), "third", "the reset keeps the view");
    run(1);
    assert.ok(car.velocity.length() > 0.9 * car.spawnSpeed, `the corkscrew car coasts at ${car.velocity.length().toFixed(1)} of ${car.spawnSpeed.toFixed(1)} m/s after the reset`);
  });

  it("when the car was driven and the scene resets (the HUD's reset, or the loop), then the seat hands the car back and it coasts the run at its spawn speed again", () => {
    watch("corkscrew");
    const car = engine["carA"];
    takeWheel();
    assert.equal(engine["seat"].mode, "drive", "W took the wheel");
    engine.reset();
    assert.equal(engine["seat"].mode, "follow", "the reset handed the car back to the rig");
    assert.equal(hud.get().seat, "follow", "the HUD says so");
    run(1);
    assert.ok(car.velocity.length() > 0.9 * car.spawnSpeed, `coasting at ${car.velocity.length().toFixed(1)} of ${car.spawnSpeed.toFixed(1)} m/s`);
  });

  it("when the car was driven, Esc steps back and the scene resets, then it coasts the run at its spawn speed", () => {
    watch("corkscrew");
    const car = engine["carA"];
    takeWheel();
    engine["seat"].esc();
    assert.equal(engine["seat"].mode, "follow");
    engine.reset();
    run(1);
    assert.ok(car.velocity.length() > 0.9 * car.spawnSpeed, `coasting at ${car.velocity.length().toFixed(1)} of ${car.spawnSpeed.toFixed(1)} m/s`);
  });
});
