import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applyDrive, DriverSeat, idleDrive, type SeatView } from "./car-drive.ts";
import { blankIntent, FEEL, gameKey, readIntent, shapeDrive } from "./drive-input.ts";
import { CHASE, DriveCam } from "../present/engine-camera.ts";
import { DeformableCar } from "./car.ts";

const H = 1 / 60;
const PAINT = { body: 0xc5c8ce, accent: 0x9aa0a8, name: "Titanium" };

/** Shaped output after holding `keys` for `seconds` at a fixed forward speed. */
function shaped(keys: string[], along: number, seconds: number) {
  const intent = readIntent(new Set(keys), null, blankIntent());
  const feel = { wheel: 0, gas: 0, brake: 0 };
  const out = idleDrive();
  for (let t = 0; t < seconds - 1e-9; t += 1 / 120) shapeDrive(intent, feel, along, 1 / 120, out);
  return { out, feel, intent };
}

type Rig = { car: DeformableCar; seat: DriverSeat; cam: THREE.PerspectiveCamera; rig: DriveCam };

function hold(r: Rig, keys: string[], seconds: number, rx = 0, ry = 0): void {
  const held = new Set(keys);
  for (let t = 0; t < seconds - 1e-9; t += H) {
    r.seat.sample(held, null);
    applyDrive(r.car, r.seat.input(r.car, H), H);
    r.car.group.position.x += r.car.velocity.x * H;
    r.car.group.position.z += r.car.velocity.z * H;
    r.car.refreshBasis();
    r.rig.update(r.cam, r.car, r.seat.view, H, rx, ry);
  }
  r.cam.updateMatrixWorld();
}

/** A driven car at `speed` (m/s, signed) with the camera settled behind it. */
function rigAt(view: SeatView, speed: number): Rig {
  const car = new DeformableCar(PAINT, new THREE.Scene());
  car.spawnFacing(0, 0, 0, speed);
  const seat = new DriverSeat();
  seat.focus(0);
  seat.mode = "drive";
  seat.view = view;
  const r = { car, seat, cam: new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 180), rig: new DriveCam() };
  hold(r, [speed >= 0 ? "KeyW" : "KeyS"], 1.5);
  return r;
}

/** Screen x (NDC, + = right) of a point in car space (+Z = nose). */
function screenX(r: Rig, x: number, y: number, z: number): number {
  return r.car.group.localToWorld(new THREE.Vector3(x, y, z)).project(r.cam).x;
}

function along(car: DeformableCar): number {
  return car.velocity.x * car.fwdFlat.x + car.velocity.z * car.fwdFlat.z;
}

describe("keyboard steering feel", () => {
  it("good: A winds the wheel LEFT (+) over ~0.25 s; D and the arrows mirror / alias it", () => {
    const lock = 1 / (1 + (5 / FEEL.steerFade) ** 2);
    const early = shaped(["KeyA"], 5, 0.1).out.steer;
    assert.ok(early > 0.2 && early < lock * 0.6, `0.1 s in: ${early}`);
    assert.ok(Math.abs(shaped(["KeyA"], 5, 0.4).out.steer - lock) < 1e-9);
    assert.ok(Math.abs(shaped(["KeyD"], 5, 0.4).out.steer + lock) < 1e-9);
    assert.equal(shaped(["ArrowLeft"], 5, 0.4).out.steer, shaped(["KeyA"], 5, 0.4).out.steer);
    assert.equal(shaped(["ArrowRight"], 5, 0.4).out.steer, shaped(["KeyD"], 5, 0.4).out.steer);
    assert.equal(shaped(["KeyA", "KeyD"], 5, 0.4).out.steer, 0);
  });

  it("good: letting go re-centres faster than the wheel winds on", () => {
    const { feel, intent } = shaped(["KeyA"], 5, 0.5);
    readIntent(new Set(), null, intent);
    const out = idleDrive();
    let t = 0;
    while (feel.wheel > 0 && t < 1) {
      shapeDrive(intent, feel, 5, 1 / 120, out);
      t += 1 / 120;
    }
    assert.ok(t < 0.2, `took ${t.toFixed(3)} s to centre`);
  });

  it("good: lock fades with speed but never below the floor; the handbrake keeps full lock", () => {
    const slow = shaped(["KeyA"], 5, 0.5).out.steer;
    const fast = shaped(["KeyA"], 18, 0.5).out.steer;
    const flat = shaped(["KeyA"], 40, 0.5).out.steer;
    assert.ok(fast < slow * 0.75, `slow ${slow} fast ${fast}`);
    assert.ok(Math.abs(flat - FEEL.steerMin) < 1e-9);
    assert.equal(shaped(["KeyA", "Space"], 18, 0.5).out.steer, 1);
  });

  it("good: no yaw at a standstill, and reverse steers like a real car (A backs the tail left: −yaw)", () => {
    assert.equal(shaped(["KeyA"], 0, 0.5).out.steer, 0);
    assert.ok(shaped(["KeyA"], 1, 0.5).out.steer > 0);
    assert.ok(shaped(["KeyA"], -1, 0.5).out.steer < 0);
    assert.ok(shaped(["KeyA"], -5, 0.5).out.steer < -0.8);
    assert.ok(shaped(["KeyD"], -5, 0.5).out.steer > 0.8);
  });
});

describe("pedals: brake, reverse, handbrake", () => {
  it("good: S brakes a forward-rolling car, and reverses once it is stopped", () => {
    const rolling = shaped(["KeyS"], 10, 0.3).out;
    assert.ok(rolling.brake > 0.99 && rolling.throttle === 0);
    const stopped = shaped(["KeyS"], 0.3, 0.3).out;
    assert.ok(stopped.throttle < -0.99 && stopped.brake === 0);
  });

  it("good: W brakes a reversing car, and drives forward once it is stopped", () => {
    const backing = shaped(["KeyW"], -4, 0.3).out;
    assert.ok(backing.brake > 0.99 && backing.throttle === 0);
    assert.ok(shaped(["KeyW"], -0.3, 0.3).out.throttle > 0.99);
  });

  it("good: Space is the handbrake: ebrake plus some service brake, never drive", () => {
    const out = shaped(["Space", "KeyW"], 10, 0.3).out;
    assert.equal(out.ebrake, true);
    assert.equal(out.throttle, 0);
    assert.equal(out.brake, FEEL.handbrakeBrake);
    assert.equal(shaped(["KeyW"], 10, 0.3).out.ebrake, false);
  });

  it("good: holding S from 10 m/s stops the car, then backs it up without a release", () => {
    const r = rigAt("third", 10);
    r.car.spawnFacing(0, 0, 0, 10);
    const speeds: number[] = [];
    for (let t = 0; t < 3; t += H) {
      r.seat.sample(new Set(["KeyS"]), null);
      applyDrive(r.car, r.seat.input(r.car, H), H);
      speeds.push(along(r.car));
    }
    const stopAt = speeds.findIndex((v) => v <= 0) * H;
    assert.ok(stopAt > 0.3 && stopAt < 0.7, `stopped after ${stopAt.toFixed(2)} s`);
    for (let i = 1; i < speeds.length; i++) assert.ok(speeds[i]! <= speeds[i - 1]! + 1e-9, `sped up at ${i}`);
    assert.ok(speeds.at(-1)! < -5, `ended at ${speeds.at(-1)}`);
  });

  it("good: braking distance does not depend on the physics slice", () => {
    const stopTime = (h: number) => {
      const car = new DeformableCar(PAINT, new THREE.Scene());
      car.spawnFacing(0, 0, 0, 10);
      const input = { ...idleDrive(), brake: 1 };
      let t = 0;
      while (along(car) > 0 && t < 5) {
        applyDrive(car, input, h);
        t += h;
      }
      return t;
    };
    const coarse = stopTime(1 / 30);
    const fine = stopTime(1 / 240);
    assert.ok(Math.abs(coarse - fine) < 1 / 30 + 1e-9, `1/30: ${coarse} 1/240: ${fine}`);
  });
});

describe("driver seat", () => {
  it("good: click follows, a pedal drives (W + Shift boosts), Esc steps back", () => {
    const s = new DriverSeat();
    s.focus(1);
    assert.equal(s.mode, "follow");
    assert.equal(s.sample(new Set(["KeyW", "ShiftLeft"]), null), true);
    assert.equal(s.mode, "drive");
    const car = { velocity: new THREE.Vector3(), fwdFlat: new THREE.Vector3(0, 0, 1) };
    let input = s.input(car, H);
    for (let t = 0; t < 0.3; t += H) input = s.input(car, H);
    assert.equal(input.throttle, 1);
    assert.equal(input.boost, true);
    s.esc();
    assert.equal(s.mode, "follow");
    s.esc();
    assert.equal(s.mode, "global");
    assert.equal(s.carIndex, -1);
  });

  it("good: Esc while still holding W stays out of the seat until W is pressed again", () => {
    const s = new DriverSeat();
    s.focus(0);
    const w = new Set(["KeyW"]);
    assert.equal(s.sample(w, null), true);
    s.esc();
    assert.equal(s.sample(w, null), false);
    assert.equal(s.mode, "follow");
    s.sample(new Set(), null);
    assert.equal(s.sample(w, null), true);
    assert.equal(s.mode, "drive");
  });

  it("good: Space while watching is not a request to drive", () => {
    const s = new DriverSeat();
    s.focus(0);
    assert.equal(s.sample(new Set(["Space"]), null), false);
    assert.equal(s.mode, "follow");
  });

  it("good: boost drains only while boosting under gas, and refills on a takedown", () => {
    const s = new DriverSeat();
    s.focus(0);
    s.mode = "drive";
    s.sample(new Set(["ShiftLeft"]), null);
    s.step(0.8);
    assert.equal(s.boost, 1, "Shift alone parked should not burn boost");
    s.sample(new Set(["ShiftLeft", "KeyW"]), null);
    s.step(0.8);
    assert.ok(s.boost < 0.6, `boost ${s.boost}`);
    s.addBoost(0.4);
    assert.ok(s.boost > 0.7);
  });

  it("good: LB/RB (Q/E) cycling wraps both ways and starts following from the whole field", () => {
    const s = new DriverSeat();
    s.cycle(1, 3);
    assert.deepEqual([s.mode, s.carIndex], ["follow", 0]);
    s.cycle(-1, 3);
    assert.equal(s.carIndex, 2);
    s.cycle(1, 3);
    assert.equal(s.carIndex, 0);
    const back = new DriverSeat();
    back.cycle(-1, 3);
    assert.equal(back.carIndex, 2);
    back.mode = "drive";
    back.cycle(1, 3);
    assert.deepEqual([back.mode, back.carIndex], ["drive", 0]);
  });

  it("good: views cycle chase → far chase → hood cam → chase", () => {
    const s = new DriverSeat();
    const seen = [s.view];
    for (let i = 0; i < 3; i++) {
      s.cycleView();
      seen.push(s.view);
    }
    assert.deepEqual(seen, ["third", "far", "first", "third"]);
  });
});

describe("drive camera: A/D is player-visible left/right in every view", () => {
  for (const view of ["third", "far"] as const) {
    it(`good: ${view} chase — W+A swings the nose LEFT on screen, W+D RIGHT`, () => {
      for (const [key, sign] of [
        ["KeyA", -1],
        ["KeyD", 1],
      ] as const) {
        const r = rigAt(view, 10);
        const before = screenX(r, 0, 0.6, 2.2) - screenX(r, 0, 0.6, 0);
        assert.ok(Math.abs(before) < 0.01, `${view} not settled behind: ${before}`);
        hold(r, ["KeyW", key], 0.6);
        const after = screenX(r, 0, 0.6, 2.2) - screenX(r, 0, 0.6, 0);
        assert.ok(sign * after > 0.02, `${view} ${key}: nose screen dx ${after.toFixed(3)}`);
      }
    });
  }

  it("good: hood cam — W+A turns the view LEFT (a point dead ahead slides right), W+D mirrors", () => {
    for (const [key, sign] of [
      ["KeyA", 1],
      ["KeyD", -1],
    ] as const) {
      const r = rigAt("first", 10);
      const ahead = r.car.group.localToWorld(new THREE.Vector3(CHASE.eye.x, CHASE.eye.y, 60));
      const before = ahead.clone().project(r.cam).x;
      assert.ok(Math.abs(before) < 0.02, `hood cam not looking ahead: ${before}`);
      hold(r, ["KeyW", key], 0.6);
      const after = ahead.clone().project(r.cam).x;
      assert.ok(sign * after > 0.1, `${key}: far point x ${after.toFixed(3)}`);
    }
  });

  it("good: reversing with A backs the tail LEFT on screen and the camera stays behind the car", () => {
    const r = rigAt("third", -5);
    assert.ok(along(r.car) < -3);
    const before = screenX(r, 0, 0.6, -2.2) - screenX(r, 0, 0.6, 0);
    assert.ok(Math.abs(before) < 0.01, `not settled: ${before}`);
    hold(r, ["KeyS", "KeyA"], 0.8);
    assert.ok(along(r.car) < -1, "stopped reversing");
    const tail = screenX(r, 0, 0.6, -2.2) - screenX(r, 0, 0.6, 0);
    assert.ok(tail < -0.02, `tail screen dx ${tail.toFixed(3)}`);
    const toCar = r.car.group.position.clone().sub(r.cam.position);
    assert.ok(toCar.dot(r.car.fwdFlat) > 3, "camera swung in front of a reversing car");
  });
});

describe("drive camera look and cuts", () => {
  it("good: mouse look holds through the delay, then eases back behind the car without overshoot", () => {
    const r = rigAt("third", 8);
    r.rig.nudge(120, 0);
    const looked = r.rig.look;
    assert.ok(looked < -0.5, "drag right should look right");
    hold(r, ["KeyW"], CHASE.lookDelay - 0.1);
    assert.equal(r.rig.look, looked);
    let max = -Infinity;
    for (let i = 0; i < 150; i++) {
      hold(r, ["KeyW"], H);
      max = Math.max(max, r.rig.look);
    }
    assert.ok(Math.abs(r.rig.look) < 0.03, `still looking ${r.rig.look}`);
    assert.ok(max <= 1e-6, `overshot to ${max}`);
  });

  it("good: right stick looks round absolutely (left = left) and snaps back on release", () => {
    const r = rigAt("third", 8);
    hold(r, ["KeyW"], 0.6, -1, 0);
    assert.ok(r.rig.look > CHASE.stickYaw * 0.9, `stick left look ${r.rig.look}`);
    hold(r, ["KeyW"], 0.6);
    assert.ok(Math.abs(r.rig.look) < 0.05, `after release ${r.rig.look}`);
  });

  it("good: a respawn across the map cuts to the new spot instead of swooping", () => {
    const r = rigAt("third", 8);
    r.car.spawnFacing(40, 40, 1, 0);
    hold(r, [], H);
    const d = r.cam.position.distanceTo(r.car.group.position);
    assert.ok(d < 9, `camera ${d.toFixed(1)} m from the car after the cut`);
  });
});

describe("which keydowns the game takes", () => {
  const key = (target: object | null, mods: { defaultPrevented?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {}) =>
    gameKey({ defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, ...mods, target: target as EventTarget | null });

  it("good: a keydown an overlay already consumed (Esc closing a popover) is not the game's", () => {
    assert.equal(key(null, { defaultPrevented: true }), false);
    assert.equal(key(null), true);
  });

  it("good: Ctrl, Cmd and Alt chords stay the browser's (Ctrl+R reloads, Ctrl+C copies); Shift is boost and stays ours", () => {
    assert.equal(key(null, { ctrlKey: true }), false);
    assert.equal(key(null, { metaKey: true }), false);
    assert.equal(key(null, { altKey: true }), false);
    assert.equal(key(null, { shiftKey: true }), true);
    assert.equal(key({ tagName: "CANVAS" }), true);
  });

  it("good: text, select and contentEditable controls keep their keys; a focused range slider still drives", () => {
    assert.equal(key({ tagName: "TEXTAREA" }), false);
    assert.equal(key({ tagName: "INPUT", type: "text" }), false);
    assert.equal(key({ tagName: "INPUT", type: "number" }), false);
    assert.equal(key({ tagName: "SELECT" }), false);
    assert.equal(key({ tagName: "DIV", isContentEditable: true }), false);
    assert.equal(key({ tagName: "INPUT", type: "range" }), true);
    assert.equal(key({ tagName: "BUTTON" }), true);
  });
});
