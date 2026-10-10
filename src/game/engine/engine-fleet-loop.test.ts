import { describe, it } from "node:test";
import assert from "node:assert/strict";
import "../kernel/rapier-node.test-util.ts";
import { HudStore, INITIAL_HUD } from "../hud/hud-store.ts";
import { FLEET_EMPTY_S } from "../scenes/fleet.ts";
import { setGround } from "../world/ground.ts";
import { CrashEngine } from "./engine.ts";

/**
 * The real `CrashEngine`, headless: its canvas, WebGL context, 2d contexts, `window` and `document` are inert stand-ins (every call
 * answers, nothing draws); the sim, the scene and the loop rules are the engine's own. `getParameter` answers a string that also reads as
 * the number 16, so three's version check and its numeric limits both take it.
 */
const ctx2d: object = new Proxy(function () {}, { get: () => () => ctx2d, apply: () => ctx2d });
const GL_ANSWERS: Record<string, () => unknown> = {
  getParameter: () => Object.assign(new String("WebGL 2.0"), { valueOf: () => 16 }),
  getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
  getContextAttributes: () => ({ alpha: false, antialias: false }),
  getSupportedExtensions: () => [],
  getExtension: () => null,
  getShaderInfoLog: () => "",
  getProgramInfoLog: () => "",
  getProgramParameter: () => 0,
};
const GL_CONSTANTS = new Map<string, number>();
const gl: object = new Proxy(function () {}, {
  get: (_t, k) => {
    if (typeof k !== "string") return undefined;
    // Upper-case names are GL constants: each its own number (three compares them to pick a draw mode, a format).
    if (k === k.toUpperCase()) return GL_CONSTANTS.get(k) ?? (GL_CONSTANTS.set(k, GL_CONSTANTS.size + 1), GL_CONSTANTS.size);
    return GL_ANSWERS[k] ?? (k.startsWith("create") ? () => ({}) : () => 1);
  },
  apply: () => 1,
});
const element = (): HTMLCanvasElement & HTMLElement =>
  ({
    style: {},
    width: 0,
    height: 0,
    clientWidth: 800,
    clientHeight: 600,
    getContext: (kind: string) => (kind === "2d" ? ctx2d : gl),
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    appendChild() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    parentElement: null,
  }) as unknown as HTMLCanvasElement & HTMLElement;

function stubBrowser(): void {
  Object.assign(globalThis, {
    devicePixelRatio: 1,
    innerWidth: 800,
    innerHeight: 600,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    location: { search: "", hash: "", href: "http://x/", origin: "http://x" },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { createElement: element, addEventListener() {}, removeEventListener() {}, body: element(), documentElement: element() },
  });
  (globalThis as { window?: unknown }).window = globalThis;
}

const FRAME = 1 / 60;

describe("given the real engine on Fleet's default settings, every car driving straight out from the centre on its own bearing", () => {
  it("when the last car has left the disc, then the loop resets the scene within FLEET_EMPTY_S + 1 s", async (t) => {
    stubBrowser();
    const hud = new HudStore();
    const engine = new CrashEngine(element(), hud, element());
    // Nothing draws: the renderer's draw entry points do nothing (the sim steps the same).
    Object.assign(engine["renderer"], { render() {}, compile() {}, compileAsync: () => Promise.resolve() });
    try {
      await engine.ready;
      assert.equal(hud.get().carCount, INITIAL_HUD.carCount, "the HUD starts on its default car count");
      assert.equal(INITIAL_HUD.carCount, 5, "Fleet's default is 5 cars");
      const cars = engine["live"]();
      assert.equal(cars.length, 5, "the default Fleet runs 5 cars");
      assert.ok(engine["looping"], "the default Fleet loops");
      // No car meets another: five bearings out from the centre, each at 20 m/s along it.
      for (const [k, car] of cars.entries()) {
        const a = (k / cars.length) * 2 * Math.PI;
        car.spawnFacing(Math.sin(a) * 10, Math.cos(a) * 10, a, 0);
        car.velocity.set(Math.sin(a) * 20, 0, Math.cos(a) * 20);
        car.speed = 20;
        car.spawnSpeed = 20;
      }
      const gen = engine["clearGen"]();
      let lastLeft = -1;
      let resetAt = -1;
      for (let frame = 0; frame < 20 * 60 && resetAt < 0; frame++) {
        const before = engine["elapsedWall"];
        engine.advance(FRAME, { frameDt: FRAME });
        const vaporAt = engine["vaporAt"];
        if (cars.every((c) => c.vaporized)) lastLeft = Math.max(...vaporAt.map((t) => t ?? 0));
        if (engine["clearGen"]() !== gen) resetAt = before + FRAME;
      }
      assert.ok(lastLeft >= 0, "every car left the disc");
      assert.ok(resetAt >= 0, "the scene never reset");
      const delay = resetAt - lastLeft;
      t.diagnostic(`reset ${delay.toFixed(3)} s after the last car left (FLEET_EMPTY_S ${FLEET_EMPTY_S})`);
      assert.ok(delay >= FLEET_EMPTY_S - FRAME, `reset ${delay.toFixed(3)} s after the last car left: before the disc had been empty ${FLEET_EMPTY_S} s`);
      assert.ok(delay <= FLEET_EMPTY_S + 1, `reset ${delay.toFixed(3)} s after the last car left, over ${FLEET_EMPTY_S + 1} s`);
    } finally {
      engine.dispose();
      setGround(null);
    }
  });
});
