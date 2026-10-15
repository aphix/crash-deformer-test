import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import "../kernel/rapier-node.test-util.ts";
import { HudStore } from "../hud/hud-store.ts";
import { setGround } from "../world/ground.ts";
import { DRIVE_KEYS } from "../vehicle/drive-input.ts";
import { CrashEngine } from "./engine.ts";
import { element, stubBrowser } from "./engine-headless.test-util.ts";
import { SCENE_KEY_BINDINGS, SEAT_KEYS } from "./engine-keys.ts";

const DRIVING_CODES: string[] = [...Object.values(DRIVE_KEYS).flat(), ...Object.values(SEAT_KEYS).flat()];
const SEAT_MODES = ["global", "follow", "drive"] as const;

describe("given the key tables the engine reads", () => {
  it("when the driving keys are listed, then the wheel, pedals, handbrake, boost, camera and reset are in the list", () => {
    for (const code of ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight", "Space", "ShiftLeft", "KeyV", "KeyR", "Escape", "Backquote"]) {
      assert.ok(DRIVING_CODES.includes(code), `${code} is a driving key`);
    }
  });

  for (const binding of SCENE_KEY_BINDINGS) {
    it(`when the ${binding.scene} key (${binding.label}) is set against the driving keys, then it is none of them`, () => {
      assert.equal(DRIVING_CODES.includes(binding.code), false, `${binding.code} drives and picks ${binding.scene}`);
      assert.equal(/^Digit/.test(binding.code), false, `${binding.code} is a rig's fire key`);
      assert.equal(SCENE_KEY_BINDINGS.filter((other) => other.code === binding.code).length, 1, `${binding.code} picks one scene`);
    });
  }
});

describe("given the real engine in the sandbox", () => {
  // One engine for the file: a second `CrashEngine` in the same process never resolves `ready`.
  let engine: CrashEngine;
  const press = (code: string): void => {
    engine["onKey"](Object.assign(new Event("keydown"), { code, repeat: false, ctrlKey: false, metaKey: false, altKey: false }) as KeyboardEvent);
  };
  const seatAs = (mode: (typeof SEAT_MODES)[number]): void => {
    engine["seat"].mode = mode;
    engine["seat"].carIndex = mode === "global" ? -1 : 0;
    engine["keys"].clear();
    engine["sceneFade"].pending = null;
  };
  before(async () => {
    stubBrowser();
    engine = new CrashEngine(element(), new HudStore(), element());
    Object.assign(engine["renderer"], { render() {}, compile() {}, compileAsync: () => Promise.resolve() });
    await engine.ready;
  });
  after(() => {
    engine.dispose();
    setGround(null);
  });

  const driveCases = SEAT_MODES.flatMap((mode) => Object.values(DRIVE_KEYS).flat().map((code) => ({ it: `when ${code} is pressed with the seat in ${mode}, then no scene is picked`, mode, code })));
  for (const testCase of driveCases) {
    it(testCase.it, () => {
      seatAs(testCase.mode);
      press(testCase.code);
      assert.equal(engine["sceneFade"].pending, null, "the scene is not switched");
    });
  }

  const sceneCases = SEAT_MODES.flatMap((mode) => SCENE_KEY_BINDINGS.map((binding) => ({ it: `when ${binding.label} is pressed with the seat in ${mode}, then ${binding.scene} is picked`, mode, code: binding.code, expectedScene: binding.scene })));
  for (const testCase of sceneCases) {
    it(testCase.it, () => {
      seatAs(testCase.mode);
      press(testCase.code);
      assert.equal(engine["sceneFade"].pending, testCase.expectedScene, "the picked scene");
    });
  }
});
