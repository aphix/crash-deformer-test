import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DriverSeat } from "../vehicle/car-drive.ts";
import type { PadState } from "../vehicle/gamepad.ts";
import { ChaseCamera, RIDE_PAUSE } from "./engine-camera.ts";

const DT = 1 / 60;

/** A canvas that is just an event target: the camera only listens and captures pointers. */
function fakeCanvas(): HTMLCanvasElement {
  const t = new EventTarget() as unknown as HTMLCanvasElement; // the camera uses addEventListener, style and pointer capture only
  Object.assign(t, { style: {}, setPointerCapture: () => {}, releasePointerCapture: () => {} });
  return t;
}

function pointer(canvas: HTMLCanvasElement, type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number): void {
  canvas.dispatchEvent(Object.assign(new Event(type), { button: 0, pointerId: 1, clientX: x, clientY: y }));
}

function rig(mode: "drive" | "global" = "drive") {
  const canvas = fakeCanvas();
  const seat = new DriverSeat();
  seat.mode = mode;
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 180);
  camera.position.set(4, 2, 6);
  const view = new ChaseCamera(camera, canvas, seat, { rx: 0, ry: 0 } as PadState, false, () => {});
  view.attach();
  const look = new THREE.Vector3(0, 1, 0);
  return { canvas, camera, view, look };
}

describe("a drag orbits the ride-along around the dummy", () => {
  it("good: even in the driver's seat, and it does not count as framing the shot (the next throw still rides)", () => {
    const { canvas, camera, view, look } = rig("drive");
    view.frameRide(look);
    pointer(canvas, "pointerdown", 100, 100);
    pointer(canvas, "pointermove", 60, 100);
    view.frameRide(look);
    view.orbit(DT, 0, false);
    const off = camera.position.clone().sub(look);
    assert.equal(view.userFramed, false);
    // 40 px left turns the bearing by 0.2 rad about the dummy: the eye moves round it, not away from it.
    assert.ok(Math.abs(Math.atan2(off.x, off.z) - Math.atan2(4, 6)) > 0.01, "the eye turned about the dummy");
  });

  it("bad: a drag far past the limits stops at the orbit's pitch range, above the ground, however far it goes", () => {
    const { canvas, camera, view, look } = rig("global");
    view.frameRide(look);
    pointer(canvas, "pointerdown", 100, 100);
    for (const dy of [4000, -8000]) {
      pointer(canvas, "pointermove", 100, 100 + dy);
      for (let f = 0; f < 240; f++) view.orbit(DT, 0, false);
      const off = camera.position.clone().sub(look);
      const elev = Math.asin(off.y / off.length());
      assert.ok(elev >= 0.079 && elev <= 1.221, `elevation ${elev.toFixed(3)} rad`);
      assert.ok(off.y + look.y > 0, "above the ground");
      pointer(canvas, "pointermove", 100, 100);
    }
    pointer(canvas, "pointerup", 100, 100);
  });
});

describe("the ride's automatic cuts wait for the drag and RIDE_PAUSE after it", () => {
  it("good: held while a drag is under way and for RIDE_PAUSE s after, then released; a tap holds nothing; a new ride starts free", () => {
    const { canvas, view, look } = rig("global");
    const held = (on = true): boolean => view.rideHeld(on, DT);
    view.frameRide(look);
    assert.equal(held(), false, "no drag yet");
    pointer(canvas, "pointerdown", 100, 100);
    assert.equal(held(), false, "a pointer that has not moved is a click so far");
    pointer(canvas, "pointermove", 140, 100);
    for (let f = 0; f < 600; f++) assert.equal(held(), true, "held for as long as the drag lasts");
    pointer(canvas, "pointerup", 140, 100);
    let heldFor = 0;
    while (held()) heldFor += DT;
    assert.ok(Math.abs(heldFor - RIDE_PAUSE) < 2 * DT, `held ${heldFor.toFixed(2)} s after the drag, want ${RIDE_PAUSE}`);
    pointer(canvas, "pointerdown", 100, 100);
    pointer(canvas, "pointerup", 100, 100);
    assert.equal(held(), false, "a tap");
    // A drag that ended just before the ride stopped must not hold the next ride.
    pointer(canvas, "pointerdown", 100, 100);
    pointer(canvas, "pointermove", 140, 100);
    held();
    pointer(canvas, "pointerup", 140, 100);
    assert.equal(held(), true);
    assert.equal(held(false), false, "the ride ended");
    assert.equal(held(), false, "the next ride is free");
  });
});
