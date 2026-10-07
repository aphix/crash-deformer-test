import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { labRig, leaveLab, runLab, throwAt, type LabRig } from "./engine-lab.test-util.ts";
import type { LabShot } from "./engine-lab.ts";
import { FLICK, LabFlick } from "./lab-flick.ts";
import { aimLabShot, LAB_FOV, LAB_SHOT } from "./lab-shot.ts";

/**
 * The Lab's flick (`LabFlick`), headless: a landscape 844 × 390 screen looking at the house of cards from a bearing off the
 * bench's long axis (side-on, oblique, or straight down it); a press and a swipe are client px with their times (ms), as the
 * canvas's pointer events give them. The swipe is read on the throw plane: the upright plane through the item holding the bench axis.
 * The last suite looks through the camera the Lab opens with on a 414 × 757 phone held upright (`LAB_SHOT.upright`).
 */

afterEach(leaveLab);

const SCREEN = { left: 0, top: 0, width: 844, height: 390 };
const PHONE_UPRIGHT = { left: 0, top: 0, width: 414, height: 757 };
const LOOK = new THREE.Vector3(-2, 2, 0);
const CAMERA_RADIUS = 28;
const CAMERA_PITCH = 0.12;
const SIDE_ON = 90;
const OBLIQUE = 35;
const DOWN_THE_BENCH = 0;
type Flick = { thing: number; velocity: THREE.Vector3 };
type Px = [number, number];

/** A 60° camera `degrees` off the bench's long axis (90: side-on, 0: straight down it from behind the thrower), at `CAMERA_RADIUS` from `LOOK`. */
function cameraAt(degrees: number): THREE.PerspectiveCamera {
  const yaw = -Math.PI / 2 + (degrees * Math.PI) / 180;
  const cam = new THREE.PerspectiveCamera(60, SCREEN.width / SCREEN.height, 0.1, 400);
  cam.position.set(
    LOOK.x + CAMERA_RADIUS * Math.sin(yaw) * Math.cos(CAMERA_PITCH),
    LOOK.y + CAMERA_RADIUS * Math.sin(CAMERA_PITCH),
    LOOK.z + CAMERA_RADIUS * Math.cos(yaw) * Math.cos(CAMERA_PITCH),
  );
  cam.lookAt(LOOK);
  cam.updateMatrixWorld(true);
  return cam;
}

type View = { r: LabRig; flick: LabFlick; flicks: Flick[]; px: (v: THREE.Vector3) => Px; thrower: Px; along: Px; up: Px };

/** A rig of `preset`, settled, seen through the camera `aim` makes for it on `screen`, and a flick on that screen; `along` and `up`: the thrower's metre along the bench and its metre up, in px on that screen. */
function viewThrough(preset: "cards" | "pad", aim: (r: LabRig) => THREE.PerspectiveCamera, screen: typeof SCREEN): View {
  const r = labRig(preset);
  runLab(r, 2);
  const cam = aim(r);
  const flicks: Flick[] = [];
  const flick = new LabFlick(cam, () => screen, r.lab, (thing, velocity) => flicks.push({ thing, velocity: velocity.clone() }));
  const px = (v: THREE.Vector3): Px => {
    const p = v.clone().project(cam);
    return [((p.x + 1) / 2) * screen.width, ((1 - p.y) / 2) * screen.height];
  };
  const centre = r.lab.centre(0, new THREE.Vector3());
  const thrower = px(centre);
  const along = px(centre.clone().add(new THREE.Vector3(1, 0, 0)));
  const up = px(centre.clone().add(new THREE.Vector3(0, 1, 0)));
  return { r, flick, flicks, px, thrower, along: [along[0] - thrower[0], along[1] - thrower[1]], up: [up[0] - thrower[0], up[1] - thrower[1]] };
}

/** The landscape screen, `preset` seen from `degrees` off the bench axis. */
function view(preset: "cards" | "pad", degrees: number): View {
  return viewThrough(preset, () => cameraAt(degrees), SCREEN);
}

/** The camera the Lab opens with on an upright screen (`LAB_SHOT.upright`), placed on its orbit about the look point as the orbit rig places it. */
function openingCameraUpright(r: LabRig): THREE.PerspectiveCamera {
  const shot = LAB_SHOT.upright;
  const look = new THREE.Vector3();
  const bearing = aimLabShot(r.lab.centre(0, new THREE.Vector3()), r.lab.focus, shot, false, look);
  const cam = new THREE.PerspectiveCamera(LAB_FOV, PHONE_UPRIGHT.width / PHONE_UPRIGHT.height, 0.1, 400);
  cam.position.set(
    look.x + Math.sin(bearing) * shot.radius * Math.cos(shot.pitch),
    look.y + shot.radius * Math.sin(shot.pitch),
    look.z + Math.cos(bearing) * shot.radius * Math.cos(shot.pitch),
  );
  cam.lookAt(look);
  cam.updateMatrixWorld(true);
  return cam;
}

/** A swipe from (x0, y0) to (x1, y1) over `ms` in 8 ms steps (a 120 Hz screen), released there; false when the press was not taken. */
function swipe(flick: LabFlick, [x0, y0]: Px, [x1, y1]: Px, ms: number): boolean {
  if (!flick.down(x0, y0, 0)) return false;
  for (let t = 8; t < ms; t += 8) flick.move({ clientX: x0 + ((x1 - x0) * t) / ms, clientY: y0 + ((y1 - y0) * t) / ms, timeStamp: t });
  flick.up(x1, y1, ms, false);
  return true;
}

/** Where a swipe that moves the finger `alongM` m along the bench and `upM` m up on the throw plane, from the thrower, ends on this screen. */
function planeEnd(v: View, alongM: number, upM: number): Px {
  return [v.thrower[0] + alongM * v.along[0] + upM * v.up[0], v.thrower[1] + alongM * v.along[1] + upM * v.up[1]];
}

/** A swipe from the thrower at `speed` m/s along `degrees` over the bench axis on its throw plane, for `ms`. */
function planeSwipe(v: View, speed: number, degrees: number, ms: number): void {
  const metres = (speed * ms) / 1000;
  const a = (degrees * Math.PI) / 180;
  const end = planeEnd(v, metres * Math.cos(a), metres * Math.sin(a));
  assert.ok(Math.hypot(end[0] - v.thrower[0], end[1] - v.thrower[1]) > FLICK.tapPx, "the test's swipe is no longer than a tap");
  assert.ok(swipe(v.flick, v.thrower, end, ms), "the press on the thrower was left to the camera");
}

/** The x (m) where a launched car comes back down to the height it left from (NaN: it never did). */
function landingX(shot: LabShot): number {
  let apex = 0;
  for (let k = 1; k < shot.pathN; k++) if (shot.path[k * 3 + 1]! > shot.path[apex * 3 + 1]!) apex = k;
  for (let k = apex + 1; k < shot.pathN; k++) if (shot.path[k * 3 + 1]! <= shot.path[1]! + 0.02) return shot.path[k * 3]!;
  return NaN;
}

describe("given the house of cards on the bench, its thrower swiped on the throw plane", () => {
  const launchCases = [
    { it: "when it is swiped 20° over the bench axis at 20 m/s on the plane, seen side-on, then it leaves 20° over the bench axis at 20 m/s", degrees: SIDE_ON, swipeDegrees: 20, speed: 20 },
    { it: "when it is swiped 70° over the bench axis at 20 m/s on the plane, seen side-on, then it leaves 70° over the bench axis at 20 m/s", degrees: SIDE_ON, swipeDegrees: 70, speed: 20 },
    { it: "when it is swiped 30° under the bench axis at 20 m/s on the plane, seen side-on, then it leaves 30° under the bench axis at 20 m/s", degrees: SIDE_ON, swipeDegrees: -30, speed: 20 },
    { it: "when it is swiped 20° over the bench axis at 20 m/s on the plane, seen obliquely, then it leaves 20° over the bench axis at 20 m/s", degrees: OBLIQUE, swipeDegrees: 20, speed: 20 },
    { it: "when it is swiped 70° over the bench axis at 20 m/s on the plane, seen obliquely, then it leaves 70° over the bench axis at 20 m/s", degrees: OBLIQUE, swipeDegrees: 70, speed: 20 },
    { it: "when it is swiped 30° under the bench axis at 20 m/s on the plane, seen obliquely, then it leaves 30° under the bench axis at 20 m/s", degrees: OBLIQUE, swipeDegrees: -30, speed: 20 },
  ] as const;
  for (const testCase of launchCases) {
    it(testCase.it, () => {
      const v = view("cards", testCase.degrees);
      planeSwipe(v, testCase.speed, testCase.swipeDegrees, 200);
      assert.equal(v.flicks.length, 1, "flicks");
      const a = (testCase.swipeDegrees * Math.PI) / 180;
      const out = v.flicks[0]!.velocity;
      assert.ok(Math.abs(out.x - testCase.speed * Math.cos(a)) < 1e-6, `along the bench ${out.x.toFixed(4)} m/s`);
      assert.ok(Math.abs(out.y - testCase.speed * Math.sin(a)) < 1e-6, `up ${out.y.toFixed(4)} m/s`);
      assert.equal(out.z, 0, "across the bench");
    });
  }

  it("when it is swiped sideways and toward the camera, seen obliquely, then it leaves with no velocity across the bench and stays on its line", () => {
    const v = view("cards", OBLIQUE);
    const centre = v.r.lab.centre(0, new THREE.Vector3());
    const towardCamera = v.px(centre.clone().add(new THREE.Vector3(0, 0, 3)));
    assert.ok(Math.hypot(towardCamera[0] - v.thrower[0], towardCamera[1] - v.thrower[1]) > FLICK.tapPx, "the test's swipe is no longer than a tap");
    assert.ok(swipe(v.flick, v.thrower, towardCamera, 200), "the press on the thrower was left to the camera");
    assert.equal(v.flicks.length, 1, "flicks");
    assert.equal(v.flicks[0]!.velocity.z, 0, "across the bench");
    v.r.lab.launch(0, v.flicks[0]!.velocity);
    runLab(v.r, 1);
    const after = v.r.lab.centre(0, new THREE.Vector3());
    assert.ok(after.distanceTo(centre) > 0.5, "it never left");
    assert.ok(Math.abs(after.z - centre.z) < 1e-6, `it moved ${(after.z - centre.z).toFixed(4)} m across the bench`);
  });

  const reachCases = [
    { it: "when it is swiped, seen side-on, at the angle and speed a lob to the top card needs, then it knocks all three cars of the house off their places", degrees: SIDE_ON },
    { it: "when it is swiped, seen obliquely, at the angle and speed a lob to the top card needs, then it knocks all three cars of the house off their places", degrees: OBLIQUE },
  ] as const;
  for (const testCase of reachCases) {
    it(testCase.it, () => {
      const scratch = labRig("cards");
      runLab(scratch, 2);
      const lob = throwAt(scratch, 0, 3, 30).launch;
      const v = view("cards", testCase.degrees);
      planeSwipe(v, Math.hypot(lob.x, lob.y), (Math.atan2(lob.y, lob.x) * 180) / Math.PI, 200);
      assert.equal(v.flicks.length, 1, "flicks");
      const shot = v.r.lab.launch(v.flicks[0]!.thing, v.flicks[0]!.velocity);
      runLab(v.r, 4);
      assert.notEqual(shot.contactS, null, "the flicked car never met the stack");
      assert.deepEqual([...shot.fell].sort(), [1, 2, 3]);
    });
  }

  const slowerCases = [
    { it: "when the same swipe 40° over the bench axis runs at 8 m/s instead of 16 m/s, seen side-on, then the car comes down nearer", degrees: SIDE_ON },
    { it: "when the same swipe 40° over the bench axis runs at 8 m/s instead of 16 m/s, seen obliquely, then the car comes down nearer", degrees: OBLIQUE },
  ] as const;
  for (const testCase of slowerCases) {
    it(testCase.it, () => {
      const landings: number[] = [];
      for (const speed of [8, 16]) {
        const v = view("pad", testCase.degrees);
        planeSwipe(v, speed, 40, 200);
        assert.equal(v.flicks.length, 1, `flicks at ${speed} m/s`);
        const shot = v.r.lab.launch(v.flicks[0]!.thing, v.flicks[0]!.velocity);
        runLab(v.r, 4);
        landings.push(landingX(shot));
      }
      assert.ok(landings[0]! < landings[1]!, `slow landed at x = ${landings[0]!.toFixed(2)} m, fast at x = ${landings[1]!.toFixed(2)} m`);
    });
  }

  it("when a swipe is shorter than a tap, then nothing leaves, and when a few px longer on the same screen, then it does", () => {
    const v = view("cards", SIDE_ON);
    const [x, y] = v.thrower;
    swipe(v.flick, v.thrower, [x + FLICK.tapPx - 2, y], 80);
    assert.equal(v.flicks.length, 0, "flicks from the short swipe");
    swipe(v.flick, v.thrower, [x + FLICK.tapPx + 2, y], 80);
    assert.equal(v.flicks.length, 1, "flicks from the longer swipe");
  });

  it("when the camera looks straight down the bench, then a swipe past a tap throws nothing, and from the side it does", () => {
    const along = view("cards", DOWN_THE_BENCH);
    assert.ok(swipe(along.flick, along.thrower, [along.thrower[0] + 30, along.thrower[1] - 60], 120), "the press on the thrower was left to the camera");
    assert.equal(along.flicks.length, 0, "flicks looking down the bench");
    const side = view("cards", SIDE_ON);
    assert.ok(swipe(side.flick, side.thrower, [side.thrower[0] + 30, side.thrower[1] - 60], 120), "the press on the thrower was left to the camera");
    assert.equal(side.flicks.length, 1, "flicks seen side-on");
  });

  it("when a swipe's moves of its last 112 ms reach the page together in one late event, then it leaves as fast as when they came one by one", () => {
    const v = view("cards", OBLIQUE);
    const [x0, y0] = v.thrower;
    const [x1, y1] = planeEnd(v, 4, 1);
    const ms = 240;
    const at = (t: number) => ({ clientX: x0 + ((x1 - x0) * t) / ms, clientY: y0 + ((y1 - y0) * t) / ms, timeStamp: t });
    // Moves every 8 ms to 232 ms, and the release 8 ms later where the last move left the finger (as a pointerup reports it).
    const last = at(ms - 8);
    v.flick.down(x0, y0, 0);
    for (let t = 8; t < ms; t += 8) v.flick.move(at(t));
    v.flick.up(last.clientX, last.clientY, ms, false);
    v.flick.down(x0, y0, 0);
    for (let t = 8; t < ms - 112; t += 8) v.flick.move(at(t));
    // The browser held the rest back (a long frame): one pointermove at the last of them carries them all.
    const held = Array.from({ length: 14 }, (_, i) => at(ms - 112 + 8 * i));
    v.flick.move({ ...last, getCoalescedEvents: () => held });
    v.flick.up(last.clientX, last.clientY, ms, false);
    assert.equal(v.flicks.length, 2);
    const [oneByOne, together] = [v.flicks[0]!.velocity, v.flicks[1]!.velocity];
    assert.equal(together.x, oneByOne.x, `along the bench: one by one ${oneByOne.x.toFixed(2)} m/s, held back ${together.x.toFixed(2)} m/s`);
    assert.equal(together.y, oneByOne.y, `up: one by one ${oneByOne.y.toFixed(2)} m/s, held back ${together.y.toFixed(2)} m/s`);
  });

  it("when a swipe is faster than the cap, then it leaves at the cap in the swipe's direction", () => {
    const v = view("cards", SIDE_ON);
    planeSwipe(v, 3 * FLICK.max, 25, 120);
    const out = v.flicks[0]!.velocity;
    assert.ok(Math.abs(Math.hypot(out.x, out.y) - FLICK.max) < 1e-6, `speed ${Math.hypot(out.x, out.y).toFixed(3)} m/s`);
    assert.ok(Math.abs(Math.atan2(out.y, out.x) - (25 * Math.PI) / 180) < 1e-6, `angle ${((Math.atan2(out.y, out.x) * 180) / Math.PI).toFixed(3)}°`);
  });

  it("when a finger presses the empty sky above the board and swipes, then the press is left to the camera", () => {
    const v = view("cards", SIDE_ON);
    assert.equal(swipe(v.flick, [SCREEN.width / 2, 5], [SCREEN.width / 2, 300], 120), false);
    assert.equal(v.flicks.length, 0);
  });

  it("when the system takes the pointer mid-swipe, then nothing is flicked", () => {
    const v = view("cards", SIDE_ON);
    const [x1, y1] = planeEnd(v, 4, 1);
    v.flick.down(v.thrower[0], v.thrower[1], 0);
    v.flick.move({ clientX: (v.thrower[0] + x1) / 2, clientY: (v.thrower[1] + y1) / 2, timeStamp: 60 });
    v.flick.up(x1, y1, 120, true);
    assert.equal(v.flicks.length, 0);
  });
});

describe("given the house of cards seen on a 414 × 757 phone held upright, as the Lab opens", () => {
  const screenSwipeMs = 120;
  const screenSwipeSpeedPx = 600;
  const minDegreesOffUp = 30;

  /** The unit screen direction from the thrower to the roof car of the stack. */
  function towardStack(v: View): Px {
    const roof = v.px(v.r.lab.centre(3, new THREE.Vector3()));
    const length = Math.hypot(roof[0] - v.thrower[0], roof[1] - v.thrower[1]);
    return [(roof[0] - v.thrower[0]) / length, (roof[1] - v.thrower[1]) / length];
  }

  it("when the stack is looked for on the screen, then it lies at least 30° off straight up from the thrower, so a throw toward it is a diagonal swipe", () => {
    const v = viewThrough("cards", openingCameraUpright, PHONE_UPRIGHT);
    const direction = towardStack(v);
    const degreesOffUp = (Math.atan2(direction[0], -direction[1]) * 180) / Math.PI;
    assert.ok(degreesOffUp >= minDegreesOffUp, `the stack reads ${degreesOffUp.toFixed(1)}° off straight up`);
  });

  it("when the thrower is swiped straight toward the stack on the screen, then it leaves along the bench toward the stack at the swipe's own velocity on the throw plane, lifted by the swipe's upward part and never across the bench", () => {
    const v = viewThrough("cards", openingCameraUpright, PHONE_UPRIGHT);
    const direction = towardStack(v);
    const distancePx = (screenSwipeSpeedPx * screenSwipeMs) / 1000;
    const end: Px = [v.thrower[0] + direction[0] * distancePx, v.thrower[1] + direction[1] * distancePx];
    assert.ok(swipe(v.flick, v.thrower, end, screenSwipeMs), "the press on the thrower was left to the camera");
    assert.equal(v.flicks.length, 1, "flicks");
    assert.equal(v.flicks[0]!.thing, 0, "the flicked item is the thrower");
    const out = v.flicks[0]!.velocity;
    assert.ok(out.x > 0, `along the bench toward the stack ${out.x.toFixed(3)} m/s`);
    assert.ok(out.y > 0 && out.y < out.x, `lifted by the upward part of the swipe, still a throw and not a lob: up ${out.y.toFixed(3)} m/s over along ${out.x.toFixed(3)} m/s`);
    assert.equal(out.z, 0, "across the bench");
    const screenX = out.x * v.along[0] + out.y * v.up[0];
    const screenY = out.x * v.along[1] + out.y * v.up[1];
    assert.ok(Math.abs(screenX - direction[0] * screenSwipeSpeedPx) < 1e-6, `the launch on the screen x ${screenX.toFixed(3)} px/s, the swipe's ${(direction[0] * screenSwipeSpeedPx).toFixed(3)} px/s`);
    assert.ok(Math.abs(screenY - direction[1] * screenSwipeSpeedPx) < 1e-6, `the launch on the screen y ${screenY.toFixed(3)} px/s, the swipe's ${(direction[1] * screenSwipeSpeedPx).toFixed(3)} px/s`);
  });
});
