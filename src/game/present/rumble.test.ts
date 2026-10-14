import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { GamepadInput, playRumble, type HapticSource, type Rumble } from "../vehicle/gamepad.ts";
import { LANDING } from "./landing.ts";
import { impactRumble, landingRumble, slideRumble } from "./rumble.ts";

const near = (a: number, b: number, msg: string): void => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
const fx = (): Rumble => ({ weak: 0, strong: 0, ms: 0 });

describe("given a hit's closing speed", () => {
  it("when it is under the camera's jolt floor (2 m/s), then there is no effect and `out` is untouched", () => {
    const out = fx();
    assert.equal(impactRumble(1.9, out), false);
    assert.deepEqual(out, { weak: 0, strong: 0, ms: 0 });
  });

  it("when it is 11 m/s, half way to a full hit (20 m/s), then the heavy motor runs at 0.5, the light at 0.7, for 240 ms", () => {
    const out = fx();
    assert.equal(impactRumble(11, out), true);
    near(out.strong, 0.5, "strong");
    near(out.weak, 0.7, "weak");
    near(out.ms, 240, "ms");
  });

  it("when it is 20 m/s or a 60 m/s pile-up, then both motors are full for 400 ms and no more", () => {
    for (const closing of [20, 60]) {
      const out = fx();
      impactRumble(closing, out);
      assert.deepEqual(out, { weak: 1, strong: 1, ms: 400 }, `${closing} m/s`);
    }
  });

  it("when two hits differ in speed, then the harder one is never weaker or shorter", () => {
    const a = fx();
    const b = fx();
    for (let s = 2.5; s < 25; s += 0.5) {
      impactRumble(s, a);
      impactRumble(s + 0.5, b);
      assert.ok(b.strong >= a.strong && b.weak >= a.weak && b.ms >= a.ms, `${s} → ${s + 0.5} m/s`);
    }
  });
});

describe("given a landing's fall speed", () => {
  it("when it falls just past the camera's landing floor, then it is a 0.3 / 0.3 thud for 120 ms, and 10 m/s past it a full 1 / 0.8 one for 380 ms", () => {
    const out = fx();
    landingRumble(LANDING.fall, out);
    assert.deepEqual([out.strong, out.weak, out.ms], [0.3, 0.3, 120]);
    landingRumble(LANDING.fall + 10, out);
    near(out.strong, 1, "strong");
    near(out.weak, 0.8, "weak");
    near(out.ms, 380, "ms");
    landingRumble(LANDING.fall + 50, out);
    near(out.strong, 1, "a longer fall adds nothing");
  });
});

describe("given a slide", () => {
  it("when it is under 0.3, then there is no effect, and above it a light buzz of the weak motor alone that grows to 0.25", () => {
    const out = fx();
    assert.equal(slideRumble(0.3, out), false);
    assert.equal(slideRumble(0, out), false);
    assert.equal(slideRumble(1, out), true);
    assert.deepEqual([out.strong, out.ms], [0, 150]);
    near(out.weak, 0.25, "full slide");
    slideRumble(0.65, out);
    near(out.weak, 0.1 + 0.15 * 0.5, "half way");
  });
});

describe("given a pad's haptic actuator", () => {
  it("when an effect is played, then the browser gets a dual-rumble with the magnitudes and the duration", () => {
    const calls: unknown[] = [];
    const actuator: HapticSource = {
      playEffect: (type, params) => {
        calls.push([type, { ...params }]);
        return Promise.resolve("complete");
      },
    };
    assert.equal(playRumble(actuator, { weak: 0.4, strong: 0.9, ms: 250 }), true);
    assert.deepEqual(calls, [["dual-rumble", { startDelay: 0, duration: 250, weakMagnitude: 0.4, strongMagnitude: 0.9 }]]);
  });

  it("when there is no actuator (no pad, or a browser without haptics), then nothing is sent and it does not throw", () => {
    assert.equal(playRumble(null, { weak: 1, strong: 1, ms: 100 }), false);
    assert.equal(playRumble(undefined, { weak: 1, strong: 1, ms: 100 }), false);
    assert.equal(playRumble({} as HapticSource, { weak: 1, strong: 1, ms: 100 }), false);
  });

  it("when the browser throws, or the effect's promise rejects (a pad pulled mid-effect), then it does not throw and leaves no unhandled rejection", async () => {
    const stray: unknown[] = [];
    const onStray = (e: unknown): void => void stray.push(e);
    process.on("unhandledRejection", onStray);
    try {
      assert.equal(playRumble({ playEffect: () => { throw new TypeError("dual-rumble unsupported"); } }, { weak: 1, strong: 1, ms: 100 }), false);
      assert.equal(playRumble({ playEffect: () => Promise.reject(new Error("gone")) }, { weak: 1, strong: 1, ms: 100 }), true);
      // One turn of the event loop: Node reports an unhandled rejection after the microtasks drain, so nothing longer is needed.
      await nextTurn();
      assert.deepEqual(stray, []);
    } finally {
      process.off("unhandledRejection", onStray);
    }
  });
});

describe("given the engine's gamepad reader", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const stub = (pads: unknown[]): void => {
    Object.defineProperty(globalThis, "navigator", { value: { getGamepads: () => pads }, configurable: true });
  };
  afterEach(() => {
    if (real) Object.defineProperty(globalThis, "navigator", real);
    else Reflect.deleteProperty(globalThis, "navigator");
  });

  const pad = (actuator: HapticSource | undefined) => ({
    index: 0,
    id: "Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)",
    connected: true,
    mapping: "standard",
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    vibrationActuator: actuator,
  });

  it("when no pad is connected, then rumble sends nothing", () => {
    stub([null, null]);
    const input = new GamepadInput();
    input.poll();
    assert.equal(input.rumble({ weak: 1, strong: 1, ms: 100 }), false);
  });

  it("when a pad with haptics is connected, then rumble plays on it, and once it is unplugged nothing is sent", () => {
    let played = 0;
    const actuator: HapticSource = { playEffect: () => (played++, Promise.resolve(null)) };
    stub([pad(actuator)]);
    const input = new GamepadInput();
    input.poll();
    assert.equal(input.rumble({ weak: 0.5, strong: 0.5, ms: 100 }), true);
    assert.equal(played, 1);
    stub([null]);
    input.poll();
    assert.equal(input.rumble({ weak: 0.5, strong: 0.5, ms: 100 }), false);
    assert.equal(played, 1);
  });

  it("when the pad has no haptics (Firefox), then rumble sends nothing", () => {
    stub([pad(undefined)]);
    const input = new GamepadInput();
    input.poll();
    assert.equal(input.rumble({ weak: 1, strong: 1, ms: 100 }), false);
  });
});
