import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applyDrive, BOOST, DriverSeat, driftPay, idleDrive, type SeatView } from "./car-drive.ts";
import { blankIntent, FEEL, gameKey, readIntent, shapeDrive } from "./drive-input.ts";
import { CHASE, DriveCam } from "../present/drive-cam.ts";
import { DeformableCar } from "./car.ts";

const H = 1 / 60;
const PAINT = { body: 0xc5c8ce, accent: 0x9aa0a8, name: "Titanium" };

/** Shaped output after holding `keys` for `seconds` at a fixed forward speed. */
function shaped(keys: string[], along: number, seconds: number) {
  const intent = readIntent(new Set(keys), null, blankIntent());
  const feel = { wheel: 0, gas: 0, brake: 0, brakeHeld: 0, pulse: 0 };
  const out = idleDrive();
  for (let t = 0; t < seconds - 1e-9; t += 1 / 80) shapeDrive(intent, feel, along, 1 / 80, out);
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

describe("given a driver steering with the keyboard", () => {
  it("when A is held at 5 m/s, then the wheel winds left to the lock for that speed over about 0.25 s; D winds it right the same way, the arrow keys do what A and D do, and A with D together keeps it centred", () => {
    const lock = 1 / (1 + (5 / FEEL.steerFade) ** 2);
    const early = shaped(["KeyA"], 5, 0.1).out.steer;
    assert.ok(early > 0.2 && early < lock * 0.6, `0.1 s in: ${early}`);
    assert.ok(Math.abs(shaped(["KeyA"], 5, 0.4).out.steer - lock) < 1e-9);
    assert.ok(Math.abs(shaped(["KeyD"], 5, 0.4).out.steer + lock) < 1e-9);
    assert.equal(shaped(["ArrowLeft"], 5, 0.4).out.steer, shaped(["KeyA"], 5, 0.4).out.steer);
    assert.equal(shaped(["ArrowRight"], 5, 0.4).out.steer, shaped(["KeyD"], 5, 0.4).out.steer);
    assert.equal(shaped(["KeyA", "KeyD"], 5, 0.4).out.steer, 0);
  });

  it("when A is held to lock and D joins it for 0.3 s, then the wheel holds where it was, and releasing both centres it within 0.2 s", () => {
    const feel = { wheel: 0, gas: 0, brake: 0, brakeHeld: 0, pulse: 0 };
    const out = idleDrive();
    const run = (k: string[], s: number) => {
      const intent = readIntent(new Set(k), null, blankIntent());
      for (let t = 0; t < s - 1e-9; t += 1 / 80) shapeDrive(intent, feel, 5, 1 / 80, out);
    };
    run(["KeyA"], 0.4);
    const held = feel.wheel;
    assert.ok(held > 0.99);
    run(["KeyA", "KeyD"], 0.3);
    assert.ok(Math.abs(feel.wheel - held) < 1e-9, `wheel ${feel.wheel}`);
    run([], 0.2);
    assert.equal(feel.wheel, 0);
  });

  it("when the keys are released after A was held for 0.5 s at 5 m/s, then the wheel re-centres in under 0.2 s, faster than it wound on", () => {
    const { feel, intent } = shaped(["KeyA"], 5, 0.5);
    readIntent(new Set(), null, intent);
    const out = idleDrive();
    let t = 0;
    while (feel.wheel > 0 && t < 1) {
      shapeDrive(intent, feel, 5, 1 / 80, out);
      t += 1 / 80;
    }
    assert.ok(t < 0.2, `took ${t.toFixed(3)} s to centre`);
  });

  it("when A is held for 0.5 s at 5, 18 and 40 m/s, then the lock fades with speed but never below the minimum, and the handbrake keeps full lock", () => {
    const slow = shaped(["KeyA"], 5, 0.5).out.steer;
    const fast = shaped(["KeyA"], 18, 0.5).out.steer;
    const flat = shaped(["KeyA"], 40, 0.5).out.steer;
    assert.ok(fast < slow * 0.75, `slow ${slow} fast ${fast}`);
    assert.ok(Math.abs(flat - FEEL.steerMin) < 1e-9);
    assert.equal(shaped(["KeyA", "Space"], 18, 0.5).out.steer, 1);
  });

  it("when A or D is held for 0.5 s, then there is no steering at a standstill and in reverse the wheel turns the opposite way, as in a real car (A backs the tail left)", () => {
    assert.equal(shaped(["KeyA"], 0, 0.5).out.steer, 0);
    assert.ok(shaped(["KeyA"], 1, 0.5).out.steer > 0);
    assert.ok(shaped(["KeyA"], -1, 0.5).out.steer < 0);
    assert.ok(shaped(["KeyA"], -5, 0.5).out.steer < -0.8);
    assert.ok(shaped(["KeyD"], -5, 0.5).out.steer > 0.8);
  });
});

describe("given a driver using the keyboard pedals (brake, reverse, handbrake)", () => {
  it("when S is held at 10 m/s and again at 0.3 m/s, then it brakes the forward-rolling car and, once the car is stopped, reverses it", () => {
    const rolling = shaped(["KeyS"], 10, 0.3).out;
    assert.ok(rolling.brake > 0.99 && rolling.throttle === 0);
    const stopped = shaped(["KeyS"], 0.3, 0.3).out;
    assert.ok(stopped.throttle < -0.99 && stopped.brake === 0);
  });

  it("when W is held at −4 m/s (reversing) and again at −0.3 m/s, then it brakes the reversing car and, once the car is stopped, drives it forward", () => {
    const backing = shaped(["KeyW"], -4, 0.3).out;
    assert.ok(backing.brake > 0.99 && backing.throttle === 0);
    assert.ok(shaped(["KeyW"], -0.3, 0.3).out.throttle > 0.99);
  });

  it("when Space is held with W at 10 m/s, then the car gets the handbrake plus some service brake and no drive, and W alone does not apply the handbrake", () => {
    const out = shaped(["Space", "KeyW"], 10, 0.3).out;
    assert.equal(out.ebrake, true);
    assert.equal(out.throttle, 0);
    assert.equal(out.brake, FEEL.handbrakeBrake);
    assert.equal(shaped(["KeyW"], 10, 0.3).out.ebrake, false);
  });

  it("when the brake is tapped for 0.15 s with the wheel at lock at speed, then the handbrake is asked for after the release for a window set by the tap's length (under 0.12 s) and not 0.15 s later", () => {
    const keys = (k: string[]) => readIntent(new Set(k), null, blankIntent());
    const feel = { wheel: 0, gas: 0, brake: 0, brakeHeld: 0, pulse: 0 };
    const out = idleDrive();
    const run = (k: string[], s: number) => {
      const intent = keys(k);
      for (let t = 0; t < s - 1e-9; t += 1 / 80) shapeDrive(intent, feel, 15, 1 / 80, out);
    };
    run(["KeyW", "KeyA"], 0.4);
    run(["KeyW", "KeyA", "KeyS"], 0.15);
    assert.equal(out.ebrake, false);
    run(["KeyW", "KeyA"], 1 / 80);
    assert.equal(out.ebrake, true);
    run(["KeyW", "KeyA"], 0.15);
    assert.equal(out.ebrake, false);
  });

  it("when the brake is tapped with the wheel centred, or held for 0.5 s with the wheel at lock, then there is no handbrake pulse", () => {
    const centred = idleDrive();
    const feel = { wheel: 0, gas: 0, brake: 0, brakeHeld: 0, pulse: 0 };
    const drive = (k: string[], s: number, out = centred) => {
      const intent = readIntent(new Set(k), null, blankIntent());
      for (let t = 0; t < s - 1e-9; t += 1 / 80) {
        shapeDrive(intent, feel, 15, 1 / 80, out);
        assert.equal(out.ebrake, false);
      }
    };
    drive(["KeyW"], 0.4);
    drive(["KeyW", "KeyS"], 0.15);
    drive(["KeyW"], 0.3);
    feel.wheel = 0;
    drive(["KeyW", "KeyA"], 0.4);
    drive(["KeyW", "KeyA", "KeyS"], 0.5);
    drive(["KeyW", "KeyA"], 0.3);
  });

  it("when a stick-steered (analog wheel) driver at full lock at speed presses the brake for 0.15 s and lets go, then there is no handbrake pulse: the tap is a keyboard-steering request", () => {
    const intent = blankIntent();
    intent.analogWheel = true;
    intent.analogGas = true;
    intent.wheel = 1;
    const feel = { wheel: 0, gas: 0, brake: 0, brakeHeld: 0, pulse: 0 };
    const out = idleDrive();
    const run = (gas: number, brake: number, s: number) => {
      intent.gas = gas;
      intent.brake = brake;
      for (let t = 0; t < s - 1e-9; t += 1 / 80) {
        shapeDrive(intent, feel, 15, 1 / 80, out);
        assert.equal(out.ebrake, false, `handbrake pulsed with the wheel at ${feel.wheel.toFixed(2)}`);
      }
    };
    run(1, 0, 0.4);
    run(0, 1, 0.15);
    run(1, 0, 0.3);
  });

  it("when S is held from 10 m/s for 3 s, then the car stops after 0.3–0.7 s, never speeds up on the way, and backs up past 5 m/s without S being released", () => {
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

  it("when a 10 m/s car brakes fully in 1/30 s physics steps and again in 1/240 s steps, then it takes the same time to stop, to within one 1/30 s step", () => {
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

describe("given a DriverSeat (the player's control mode: watching the whole field, following one car, or driving it)", () => {
  it("when a car is clicked, W with Shift is pressed and Esc is pressed twice, then the click follows it, the pedal drives it with full throttle and boost, and Esc steps back to following and then to the whole field", () => {
    const s = new DriverSeat();
    s.focus(1);
    assert.equal(s.mode, "follow");
    assert.equal(s.sample(new Set(["KeyW", "ShiftLeft"]), null), true);
    assert.equal(s.mode, "drive");
    const car = new DeformableCar(PAINT, new THREE.Scene());
    car.spawnFacing(0, 0, 0, 0);
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

  it("when Esc is pressed while W is still held, then the seat stays out of driving until W is released and pressed again", () => {
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

  it("when Space is pressed while only watching a car, then it is not a request to drive", () => {
    const s = new DriverSeat();
    s.focus(0);
    assert.equal(s.sample(new Set(["Space"]), null), false);
    assert.equal(s.mode, "follow");
  });

  it("when Shift is held parked, then boost is not burnt; when Shift is held with W on a car under way, then boost drains by the thrust the car applies; and when a takedown adds boost, then it refills", () => {
    const parked = rigAt("third", 0);
    parked.seat.sample(new Set(["ShiftLeft"]), null);
    applyDrive(parked.car, parked.seat.input(parked.car, H), H);
    parked.seat.step(0.8);
    assert.equal(parked.seat.boost, 1, "Shift alone parked should not burn boost");
    const r = rigAt("third", 10);
    const held = new Set(["ShiftLeft", "KeyW"]);
    for (let t = 0; t < 0.8 - 1e-9; t += H) {
      r.seat.sample(held, null);
      applyDrive(r.car, r.seat.input(r.car, H), H);
      r.seat.step(H);
    }
    assert.ok(r.seat.boost < 0.6, `boost ${r.seat.boost}`);
    r.seat.addBoost(0.4);
    assert.ok(r.seat.boost > 0.7);
  });

  it("when the cycle control (LB/RB or Q/E) is pressed from the whole field, forwards and backwards, then it starts following the first or last car and wraps both ways, and keeps driving mode", () => {
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

  it("when the camera view is cycled three times, then it goes from chase to far chase to hood cam and back to chase", () => {
    const s = new DriverSeat();
    const seen = [s.view];
    for (let i = 0; i < 3; i++) {
      s.cycleView();
      seen.push(s.view);
    }
    assert.deepEqual(seen, ["third", "far", "first", "third"]);
  });
});

describe("given a driving camera, whose A and D keys must look like left and right to the player in every view", () => {
  for (const view of ["third", "far"] as const) {
    it(`when W with A or D is held in the ${view} chase view, then W+A swings the nose left on screen and W+D swings it right`, () => {
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

  it("when W with A or D is held in the hood cam, then W+A turns the view left, so a point dead ahead slides right on screen, and W+D mirrors it", () => {
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

  it("when the car reverses with S and A held, then the tail backs left on screen and the camera stays behind the car", () => {
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

describe("given a driving camera that is being looked around and cut", () => {
  it("when the mouse is dragged right, then the camera looks right and holds through the delay, then eases back behind the car without overshooting", () => {
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

  it("when the right stick is held left, then the camera looks left absolutely, and snaps back when it is released", () => {
    const r = rigAt("third", 8);
    hold(r, ["KeyW"], 0.6, -1, 0);
    assert.ok(r.rig.look > CHASE.stickYaw * 0.9, `stick left look ${r.rig.look}`);
    hold(r, ["KeyW"], 0.6);
    assert.ok(Math.abs(r.rig.look) < 0.05, `after release ${r.rig.look}`);
  });

  it("when the car respawns across the map, then the camera cuts to the new spot, under 9 m from the car, instead of swooping", () => {
    const r = rigAt("third", 8);
    r.car.spawnFacing(40, 40, 1, 0);
    hold(r, [], H);
    const d = r.cam.position.distanceTo(r.car.group.position);
    assert.ok(d < 9, `camera ${d.toFixed(1)} m from the car after the cut`);
  });
});

describe("given a keydown event the game must decide whether to take", () => {
  const key = (target: object | null, mods: { defaultPrevented?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {}) =>
    gameKey({ defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, ...mods, target: target as EventTarget | null });

  it("when an overlay has already consumed the keydown (Esc closing a popover), then it is not the game's", () => {
    assert.equal(key(null, { defaultPrevented: true }), false);
    assert.equal(key(null), true);
  });

  it("when Ctrl, Cmd or Alt is held, then the key stays the browser's (Ctrl+R reloads, Ctrl+C copies), while Shift is boost and stays the game's", () => {
    assert.equal(key(null, { ctrlKey: true }), false);
    assert.equal(key(null, { metaKey: true }), false);
    assert.equal(key(null, { altKey: true }), false);
    assert.equal(key(null, { shiftKey: true }), true);
    assert.equal(key({ tagName: "CANVAS" }), true);
  });

  it("when the key goes to a text, number, select or contentEditable control, then it keeps the key, while a focused range slider or button still drives", () => {
    assert.equal(key({ tagName: "TEXTAREA" }), false);
    assert.equal(key({ tagName: "INPUT", type: "text" }), false);
    assert.equal(key({ tagName: "INPUT", type: "number" }), false);
    assert.equal(key({ tagName: "SELECT" }), false);
    assert.equal(key({ tagName: "DIV", isContentEditable: true }), false);
    assert.equal(key({ tagName: "INPUT", type: "range" }), true);
    assert.equal(key({ tagName: "BUTTON" }), true);
  });
});

describe("given a driver who slides the car with the handbrake", () => {
  /** 30 m/s, a seat holding 0.3 boost: the handbrake pulse (`pulse`) starts the slide, A+W holds it 1.2 s, then lifting off every key ends it (W alone, hands off the wheel, holds the drift); `hit` strikes the car while it is held. */
  function slide(pulse: string[], hit: boolean): number {
    const r = rigAt("third", 30);
    r.seat.boost = 0.3;
    hold(r, pulse, 0.3);
    hold(r, pulse.length > 1 ? ["KeyW", "KeyA"] : ["KeyW"], 1.0);
    if (hit) {
      r.car.group.updateMatrixWorld(true);
      const at = r.car.group.position.clone().addScaledVector(r.car.forward, 2.05);
      at.y = 0.4;
      r.car.applyImpact(at, r.car.forward.clone().negate(), 3, 3);
    }
    hold(r, [], 1.5);
    return r.seat.boost;
  }

  it("when the slide ends with no contact near it, then the meter gains at least 0.15 over the same run without a slide", () => {
    const slid = slide(["Space", "KeyA"], false);
    const straight = slide(["KeyW"], false);
    assert.ok(slid >= straight + 0.15, `slid ${slid.toFixed(3)} straight ${straight.toFixed(3)}`);
  });

  it("when the A and Space keys are released with W held, then the drift is still held 1.5 s later, and S catches it", () => {
    const r = rigAt("third", 30);
    hold(r, ["Space", "KeyA"], 0.3);
    hold(r, ["KeyW", "KeyA"], 1.0);
    hold(r, ["KeyW"], 1.5);
    assert.ok(r.car.drive.drift > 0.5, `drift ${r.car.drive.drift.toFixed(2)} with hands off the wheel keys`);
    hold(r, ["KeyS"], 0.5);
    assert.ok(r.car.drive.drift < 0.05, `drift ${r.car.drive.drift.toFixed(2)} after braking`);
  });

  it("when a contact falls inside the slide's last 0.5 s, then it earns nothing", () => {
    const hit = slide(["Space", "KeyA"], true);
    assert.ok(hit <= 0.3 + 1e-9, `boost ${hit.toFixed(3)}`);
  });

  it("when the car slides, then the seat's drift view counts the seconds up from 0, stays clean, and pays out once when the slide ends: `driftPay` of the seconds it reached", () => {
    const r = rigAt("third", 30);
    r.seat.boost = 0.3;
    assert.deepEqual({ ...r.seat.drift }, { s: 0, clean: true, paid: 0 }, "before any slide");
    hold(r, ["Space", "KeyA"], 0.3);
    hold(r, ["KeyW", "KeyA"], 0.5);
    const early = r.seat.drift.s;
    hold(r, ["KeyW", "KeyA"], 0.5);
    const late = { ...r.seat.drift };
    assert.ok(early > 0.2 && late.s > early + 0.4, `${early.toFixed(2)} s then ${late.s.toFixed(2)} s`);
    assert.deepEqual([late.clean, late.paid], [true, 0], "clean, nothing paid yet");
    hold(r, [], 1.5);
    assert.equal(r.seat.drift.s, 0, "the slide ended");
    assert.equal(r.seat.drift.paid, 1, "one payout");
    assert.ok(r.seat.boost >= Math.min(1, 0.3 + driftPay(late.s)) - 1e-9, `boost ${r.seat.boost.toFixed(3)} after ${late.s.toFixed(2)} s`);
    assert.ok(r.seat.boost <= 0.3 + BOOST.drift * BOOST.driftCap + 1e-9, `boost ${r.seat.boost.toFixed(3)} past the cap`);
  });

  it("when a contact falls inside the slide, then the view reads dirty while it is fresh, and the slide ends with no payout", () => {
    const r = rigAt("third", 30);
    r.seat.boost = 0.3;
    hold(r, ["Space", "KeyA"], 0.3);
    hold(r, ["KeyW", "KeyA"], 1.0);
    assert.equal(r.seat.drift.clean, true, "clean before the contact");
    r.car.group.updateMatrixWorld(true);
    const at = r.car.group.position.clone().addScaledVector(r.car.forward, 2.05);
    at.y = 0.4;
    r.car.applyImpact(at, r.car.forward.clone().negate(), 3, 3);
    hold(r, ["KeyW", "KeyA"], H);
    assert.equal(r.seat.drift.clean, false, "a fresh contact");
    hold(r, ["KeyW"], 1.5);
    assert.equal(r.seat.drift.paid, 0, "no payout");
    assert.ok(r.seat.boost <= 0.3 + 1e-9, `boost ${r.seat.boost.toFixed(3)}`);
  });

  it("when slides of 1 s, 10 s and 0 s are paid, then the share is 0.12 per second up to 2.5 s", () => {
    assert.ok(Math.abs(driftPay(1) - 0.12) < 1e-12);
    assert.ok(Math.abs(driftPay(10) - 0.3) < 1e-12);
    assert.equal(driftPay(0), 0);
  });
});
