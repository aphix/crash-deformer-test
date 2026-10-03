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

describe("the orbit keeps clear of lamp posts", () => {
  /** An orbit round (3, 0.7, 0) on `posts`, its eye lowered to 1.8 m (level with the posts' lower half) by a held stick. */
  function lowOrbit(posts: readonly { intact: boolean; group: { visible: boolean; position: THREE.Vector3 } }[]) {
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 180);
    camera.position.set(4, 2, 6);
    const seat = new DriverSeat();
    seat.mode = "global";
    const pad = { rx: 0, ry: -1 } as PadState;
    const view = new ChaseCamera(camera, fakeCanvas(), seat, pad, false, () => {});
    view.look.set(3, 0.7, 0);
    view.posts = posts;
    for (let f = 0; f < 120; f++) view.orbit(DT, 0, false);
    pad.ry = 0;
    return { camera, view };
  }

  it("good: round a whole turn the eye stays 3 m from every post of the 16 m ring, in steps within twice the plain orbit's", () => {
    const ring = Array.from({ length: 6 }, (_, i) => ({ intact: true, group: { visible: true, position: new THREE.Vector3(Math.sin((i / 6) * Math.PI * 2) * 16, 0, Math.cos((i / 6) * Math.PI * 2) * 16) } }));
    const spin = 0.32;
    const turn = (posts: typeof ring): { near: number; step: number } => {
      const { camera, view } = lowOrbit(posts);
      for (let f = 0; f < 120; f++) view.orbit(DT, spin, false);
      let near = Infinity;
      let step = 0;
      const last = camera.position.clone();
      for (let f = 0; f < Math.round((2 * Math.PI) / spin / DT); f++) {
        view.orbit(DT, spin, false);
        step = Math.max(step, last.distanceTo(camera.position));
        last.copy(camera.position);
        for (const p of ring) near = Math.min(near, Math.hypot(camera.position.x - p.group.position.x, camera.position.z - p.group.position.z, Math.max(0, camera.position.y - 5.3)));
      }
      return { near, step };
    };
    const plain = turn([]);
    assert.ok(plain.near < 1, `the plain orbit passes ${plain.near.toFixed(2)} m from a post (the test needs one close)`);
    const pushed = turn(ring);
    assert.ok(pushed.near >= 3, `eye ${pushed.near.toFixed(2)} m from a post`);
    assert.ok(pushed.step <= 2 * plain.step, `step ${pushed.step.toFixed(3)} m a frame against ${plain.step.toFixed(3)} m plain`);
  });

  it("good: only a standing, visible post pushes the eye", () => {
    const post = { intact: true, group: { visible: true, position: new THREE.Vector3() } };
    const { camera, view } = lowOrbit([]);
    const settle = (): void => {
      for (let f = 0; f < 300; f++) view.orbit(DT, 0, false);
    };
    settle();
    const rest = camera.position.clone();
    view.posts = [post];
    // A post 1.5 m beside the resting eye.
    post.group.position.set(rest.x + 1.5, 0, rest.z);
    settle();
    assert.ok(camera.position.distanceTo(rest) > 1, "a post beside the eye leaves it where it was");
    post.group.visible = false;
    settle();
    assert.ok(camera.position.distanceTo(rest) < 0.01, "a hidden post still pushes");
    post.group.visible = true;
    settle();
    assert.ok(camera.position.distanceTo(rest) > 1, "the post is back and does not push");
    post.intact = false;
    settle();
    assert.ok(camera.position.distanceTo(rest) < 0.01, "a knocked-over post still pushes");
  });
});
