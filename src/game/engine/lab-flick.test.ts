import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { labRig, leaveLab, runLab, type LabRig } from "./engine-lab.test-util.ts";
import { FREE, WALL } from "./engine-lab.ts";
import { LabFlick } from "./lab-flick.ts";

/**
 * The Lab's flick on a phone (`LabFlick`), headless: a 390 × 844 portrait screen looking over the thrower's shoulder at the house
 * of cards; a press and a swipe are client px with their times (ms), as the canvas's pointer events give them.
 */

afterEach(leaveLab);

const SCREEN = { left: 0, top: 0, width: 390, height: 844 };
type Flick = { thing: number; target: number; dx: number; dz: number; speed: number };

/** The cards rig, settled, with a camera 9 m behind and 4 m over the thrower looking at the top card, and a flick on that screen. */
function phone(): { r: LabRig; flick: LabFlick; flicks: Flick[]; px: (v: THREE.Vector3) => [number, number] } {
  const r = labRig("cards");
  runLab(r, 2);
  const cam = new THREE.PerspectiveCamera(50, SCREEN.width / SCREEN.height, 0.1, 400);
  const thrower = r.lab.centre(0, new THREE.Vector3());
  cam.position.set(thrower.x - 9, thrower.y + 4, thrower.z);
  cam.lookAt(r.lab.centre(3, new THREE.Vector3()));
  cam.updateMatrixWorld(true);
  const flicks: Flick[] = [];
  const flick = new LabFlick(cam, () => SCREEN, r.lab, (thing, target, dx, dz, speed) => flicks.push({ thing, target, dx, dz, speed }));
  const px = (v: THREE.Vector3): [number, number] => {
    const p = v.clone().project(cam);
    return [((p.x + 1) / 2) * SCREEN.width, ((1 - p.y) / 2) * SCREEN.height];
  };
  return { r, flick, flicks, px };
}

/** A swipe from (x0, y0) to (x1, y1) over `ms` in 8 ms steps (a 120 Hz screen), released there; false when the press was not taken. */
function swipe(flick: LabFlick, [x0, y0]: [number, number], [x1, y1]: [number, number], ms: number): boolean {
  if (!flick.down(x0, y0, 0)) return false;
  for (let t = 8; t < ms; t += 8) flick.move(x0 + ((x1 - x0) * t) / ms, y0 + ((y1 - y0) * t) / ms, t);
  flick.up(x1, y1, ms, false);
  return true;
}

/** (x, y) turned `deg` degrees about (cx, cy) on the screen. */
function turned([cx, cy]: [number, number], [x, y]: [number, number], deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)];
}

describe("given the house of cards on a phone held upright, the thrower nearest the camera", () => {
  it("when a finger presses the thrower and swipes quickly to the top card, then the thrower is flicked at the top card and knocks all three off their places", () => {
    const { r, flick, flicks, px } = phone();
    assert.ok(swipe(flick, px(r.lab.centre(0, new THREE.Vector3())), px(r.lab.centre(3, new THREE.Vector3())), 120), "the press on the thrower was left to the camera");
    assert.equal(flicks.length, 1);
    const f = flicks[0]!;
    assert.deepEqual([f.thing, f.target], [0, 3]);
    const shot = r.lab.flick(f.thing, f.target, f.dx, f.dz, f.speed);
    runLab(r, 4);
    assert.notEqual(shot.contactS, null, "the flicked car never met the stack");
    assert.deepEqual([...shot.fell].sort(), [1, 2, 3]);
  });

  const aimCases = [
    { it: "when the swipe runs 5° off the line to the top card on screen, away from the cars under it, then it aims at the top card", off: 5, want: 3 },
    { it: "when the swipe runs 25° off the line to the top card on screen, away from the cars under it, then it aims at nothing and flies free", off: 25, want: FREE },
  ] as const;
  for (const testCase of aimCases) {
    it(testCase.it, () => {
      const { r, flick, flicks, px } = phone();
      const from = px(r.lab.centre(0, new THREE.Vector3()));
      const top = px(r.lab.centre(3, new THREE.Vector3()));
      const near = px(r.lab.centre(1, new THREE.Vector3()));
      // The side of the line the near bottom car lies on (screen y points down): turn the other way.
      const side = Math.sign((top[0] - from[0]) * (near[1] - from[1]) - (top[1] - from[1]) * (near[0] - from[0]));
      swipe(flick, from, turned(from, top, -side * testCase.off), 120);
      assert.equal(flicks[0]?.target, testCase.want);
    });
  }

  it("when the swipe runs from the thrower to the pegboard straight behind it, then it aims at the pegboard", () => {
    const { r, flick, flicks, px } = phone();
    const from = r.lab.centre(0, new THREE.Vector3());
    swipe(flick, px(from), px(r.lab.targetPoint(0, WALL, new THREE.Vector3())), 120);
    assert.equal(flicks[0]?.target, WALL);
  });

  const speedCases = [
    { it: "when the same swipe takes 400 ms, then it leaves slower than when it takes 120 ms", slow: 400, fast: 120 },
    { it: "when the same swipe takes 240 ms, then it leaves slower than when it takes 60 ms", slow: 240, fast: 60 },
  ] as const;
  for (const testCase of speedCases) {
    it(testCase.it, () => {
      const { r, flick, flicks, px } = phone();
      const from = px(r.lab.centre(0, new THREE.Vector3()));
      const to = px(r.lab.centre(3, new THREE.Vector3()));
      swipe(flick, from, to, testCase.slow);
      swipe(flick, from, to, testCase.fast);
      assert.equal(flicks.length, 2);
      assert.ok(flicks[0]!.speed < flicks[1]!.speed, `slow ${flicks[0]!.speed.toFixed(1)} m/s, fast ${flicks[1]!.speed.toFixed(1)} m/s`);
    });
  }

  it("when a finger only taps the thrower, then nothing is flicked", () => {
    const { r, flick, flicks, px } = phone();
    const [x, y] = px(r.lab.centre(0, new THREE.Vector3()));
    swipe(flick, [x, y], [x + 4, y - 4], 80);
    assert.equal(flicks.length, 0);
  });

  it("when a finger presses the empty sky above the board and swipes, then the press is left to the camera", () => {
    const { flick, flicks } = phone();
    assert.equal(swipe(flick, [SCREEN.width / 2, 20], [SCREEN.width / 2, 300], 120), false);
    assert.equal(flicks.length, 0);
  });

  it("when the system takes the pointer mid-swipe, then nothing is flicked", () => {
    const { r, flick, flicks, px } = phone();
    const [x0, y0] = px(r.lab.centre(0, new THREE.Vector3()));
    const [x1, y1] = px(r.lab.centre(3, new THREE.Vector3()));
    flick.down(x0, y0, 0);
    flick.move((x0 + x1) / 2, (y0 + y1) / 2, 60);
    flick.up(x1, y1, 120, true);
    assert.equal(flicks.length, 0);
  });
});
