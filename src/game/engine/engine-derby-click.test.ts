import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import "../kernel/rapier-node.test-util.ts";
import { HudStore } from "../hud/hud-store.ts";
import { setGround } from "../world/ground.ts";
import { CrashEngine } from "./engine.ts";
import { element, frameField as frameDerby, stubBrowser } from "./engine-headless.test-util.ts";

const FRAME = 1 / 60;
const CANVAS_W = 800;
const CANVAS_H = 600;
/** How long the button stays down (s): a slow click, long enough for a car at speed to leave the pointer. */
const HOLD = 0.5;

/** A canvas that carries the pointer events the engine's own `ChaseCamera` listens for. */
function pointerCanvas(): HTMLCanvasElement & HTMLElement {
  const bus = new EventTarget();
  return Object.assign(element(), {
    addEventListener: bus.addEventListener.bind(bus),
    removeEventListener: bus.removeEventListener.bind(bus),
    dispatchEvent: bus.dispatchEvent.bind(bus),
    setPointerCapture() {},
    releasePointerCapture() {},
  });
}

describe("given the real engine in a running derby, and a canvas that carries pointer events", () => {
  // One engine for the file: a second `CrashEngine` in the same process never resolves `ready`.
  let engine: CrashEngine;
  let canvas: HTMLCanvasElement;
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) engine.advance(FRAME, { frameDt: FRAME });
  };
  /** The stand-in canvas has no size, so the camera's view offset is NaN: a plain frustum at its aspect, matrices current. */
  const frameCamera = (): void => {
    const camera = engine["camera"];
    camera.clearViewOffset();
    camera.aspect = CANVAS_W / CANVAS_H;
    camera.updateProjectionMatrix();
    engine["scene"].updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
  };
  /** The canvas pixel car `index`'s centre shows at, or null while it is off the view. */
  const screenSpot = (index: number): { x: number; y: number } | null => {
    const spot = engine["live"]()[index]!.group.position.clone();
    spot.y += 0.5;
    spot.project(engine["camera"]);
    if (spot.z > 1 || Math.abs(spot.x) > 0.95 || Math.abs(spot.y) > 0.95) return null;
    return { x: (spot.x * 0.5 + 0.5) * CANVAS_W, y: (-spot.y * 0.5 + 0.5) * CANVAS_H };
  };
  const pointer = (type: "pointerdown" | "pointerup", x: number, y: number): void => {
    canvas.dispatchEvent(Object.assign(new Event(type), { button: 0, pointerId: 1, clientX: x, clientY: y }));
  };
  /** The derby's opening shot of the field as it stands now, pulled back until every car shows. */
  const frameField = (): void => frameDerby(engine, CANVAS_W, CANVAS_H);
  /** Whether a ray at canvas pixel (x, y) crosses any car's hull. */
  const onHull = (x: number, y: number): boolean => {
    const ray = engine["raycaster"];
    ray.setFromCamera({ x: (x / CANVAS_W) * 2 - 1, y: -(y / CANVAS_H) * 2 + 1 } as never, engine["camera"]);
    return ray.intersectObjects(engine["live"]().map((c) => c.group), true).length > 0;
  };
  before(async () => {
    stubBrowser();
    canvas = pointerCanvas();
    engine = new CrashEngine(canvas, new HudStore(), element());
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

  // The owner's routes to the derby: straight from load, from the race menu, and from the fleet through the race menu.
  const ROUTES: Record<string, string[]> = {
    "Derby from load": ["derby"],
    "Race, then Derby": ["race", "derby"],
    "Fleet, Race, Derby": ["fleet", "race", "derby"],
  };
  for (const [name, scenes] of Object.entries(ROUTES)) {
    it(`when ${name} and a car is pressed on the canvas, then released ${HOLD} s later with the cars still moving, then the seat follows that car`, () => {
      for (const scene of scenes) {
        engine["setScene"](scene as never);
        run(0.5);
      }
      run(12);
      assert.equal(engine.derbyMode, true, "the derby is on");
      let clicked = 0;
      for (let index = 0; index < engine["carCount"]; index++) {
        frameField();
        const spots = engine["live"]().map((_, i) => screenSpot(i));
        const spot = spots[index];
        // A car drawn over another's centre makes the car under the press the nearer one, not this one: skip those.
        if (!spot || engine["carAt"](spot.x, spot.y) !== index) continue;
        const speed = engine["live"]()[index]!.velocity.length();
        engine["seat"].mode = "global";
        engine["seat"].carIndex = -1;
        pointer("pointerdown", spot.x, spot.y);
        run(HOLD);
        frameCamera();
        pointer("pointerup", spot.x, spot.y);
        const view = engine["view"];
        const why = `press on car ${index} (${speed.toFixed(1)} m/s) at ${Math.round(spot.x)},${Math.round(spot.y)}: dragId ${view["dragId"]}, take ${view.take === null ? "null" : "set"}, locked ${view.locked}`;
        assert.equal(engine["seat"].mode, "follow", why);
        assert.equal(engine["seat"].carIndex, index, why);
        clicked++;
      }
      assert.ok(clicked >= 2, `at least two cars clear of each other on screen (saw ${clicked})`);
    });
  }

  it("when a press lands just off a far car's hull, then it takes that car, and a press nowhere near a car takes none", () => {
    // The opening shot pulled back to three times its distance: the cars are a few pixels across, as in the owner's wide shot.
    frameField();
    const camera = engine["camera"];
    const look = engine["view"].look;
    camera.position.sub(look).multiplyScalar(3).add(look);
    camera.far = 1000; // the real far plane (180 m) would cut the pulled-back field off
    camera.lookAt(look);
    frameCamera();
    const spots = engine["live"]().map((_, i) => screenSpot(i));
    const index = spots.findIndex((s) => s !== null);
    const spot = spots[index]!;
    // The nearest pixel to the car's centre, 6-20 px out, that crosses no hull (3% of the canvas width is 24 px).
    let off: { x: number; y: number } | null = null;
    for (let r = 6; r <= 20 && !off; r += 2) {
      for (let a = 0; a < 360 && !off; a += 15) {
        const x = spot.x + r * Math.cos((a * Math.PI) / 180);
        const y = spot.y + r * Math.sin((a * Math.PI) / 180);
        if (!onHull(x, y) && !spots.some((o, i) => i !== index && o && Math.hypot(o.x - x, o.y - y) < 24)) off = { x, y };
      }
    }
    assert.ok(off, "a pixel just off the hull exists");
    assert.equal(engine["carAt"](off.x, off.y), index, "a miss within 3% of the width follows the nearest car");
    let far: { x: number; y: number } | null = null;
    for (let x = 10; x < CANVAS_W && !far; x += 20) {
      for (let y = 10; y < CANVAS_H && !far; y += 20) {
        if (!onHull(x, y) && !spots.some((o) => o && Math.hypot(o.x - x, o.y - y) < 40)) far = { x, y };
      }
    }
    assert.ok(far, "a pixel clear of every car exists");
    assert.equal(engine["carAt"](far.x, far.y), -1, "a miss far from every car follows none");
  });
});
