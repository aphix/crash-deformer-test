import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { applyDrive, DriverSeat, idleDrive, type DriveInput, type SeatView } from "../vehicle/car-drive.ts";
import type { PadState } from "../vehicle/gamepad.ts";
import { assignClass } from "../vehicle/vehicle-classes.ts";
import { paint } from "../vehicle/test-support.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";
import { FLAT_GROUND, Ground, setGround } from "../world/ground.ts";
import { Spring, Spring3 } from "./spring.ts";
import { CHASE, DriveCam } from "./drive-cam.ts";
import { LANDING } from "./landing.ts";
import { ChaseCamera, RIDE_PAUSE, type SpecScene } from "./engine-camera.ts";
import { occluder, solid, type Sight } from "./spectate-cam.ts";

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

describe("given the ride-along camera following a thrown driver's dummy", () => {
  it("when the player drags in the driver's seat, then the eye orbits the dummy, and the drag does not count as framing the shot, so the next throw still rides", () => {
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

  it("when a drag goes far past the limits in the global view, then the eye stops at the orbit's pitch range, above the ground, however far the drag goes", () => {
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

describe("given the ride-along's automatic cuts and a drag on its camera", () => {
  it("when the player drags, taps and starts a new ride, then cuts are held during the drag and for the ride pause after it, a tap holds nothing, and a new ride starts free", () => {
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

describe("given the orbit camera around a ring of lamp posts", () => {
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

  it("when the orbit goes a whole turn at a low eye height, then the eye stays 3 m from every post of the 16 m ring, in steps within twice the plain orbit's", () => {
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

  it("when a post stands 1.5 m beside the resting eye, then only a standing, visible post pushes the eye: a hidden or knocked-over one does not", () => {
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

describe("given the derby's orbit round a car 4 m from the bowl's 38 m wall", () => {
  it("when the orbit goes a whole turn, then the eye stays 2 m inside the wall, so the wall never stands between it and the car", () => {
    const turn = (rim: number): number => {
      const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 180);
      const seat = new DriverSeat();
      seat.mode = "global";
      const view = new ChaseCamera(camera, fakeCanvas(), seat, { rx: 0, ry: 0 } as PadState, false, () => {});
      view.rim = rim;
      view.look.set(34, 0.7, 0);
      camera.position.set(30, 6, 0);
      const spin = 0.32;
      let far = 0;
      for (let f = 0; f < 120 + Math.round((2 * Math.PI) / spin / DT); f++) {
        view.orbit(DT, spin, false);
        if (f >= 120) far = Math.max(far, Math.hypot(camera.position.x, camera.position.z));
      }
      return far;
    };
    const plain = turn(Infinity);
    assert.ok(plain > 38, `the plain orbit reaches ${plain.toFixed(2)} m from the middle (the test needs it past the wall)`);
    const kept = turn(38);
    assert.ok(kept <= 36 + 1e-9, `eye ${kept.toFixed(2)} m from the middle`);
  });
});

describe("given the chase eye drifting toward a wall along the course", () => {
  it("when the eye drifts into the wall's clearance at 60 and 240 Hz, then it is pulled in smoothly, not by whole metres", (t) => {
    // A wall along z with its face at x = 3. The car drives along z, drifting toward it, nose turned off it: the chase eye sits on the wall's side.
    const wall: Sight = { ground: FLAT_GROUND, path: null, wallTop: 0, rim: Infinity, occ: [occluder(53, 0, 0, 50, 2000, false, 0, 30)] };
    const car = new DeformableCar({ body: 0x808080, accent: 0x404040, name: "car" }, new THREE.Scene());
    const eyes = (hz: number, fixed: Sight | null): THREE.Vector3[] => {
      const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 180);
      const seat = new DriverSeat();
      seat.mode = "follow";
      const view = new ChaseCamera(camera, fakeCanvas(), seat, { rx: 0, ry: 0 } as PadState, false, () => {});
      const scene: SpecScene = { sight: () => wall, rivals: () => [], fixed: () => fixed, cut: (c) => c };
      const out: THREE.Vector3[] = [];
      for (let n = 0; n < 16 * hz; n++) {
        const t = n / hz;
        car.group.position.set(0.2 + 0.1 * t, 0, 20 * t);
        car.velocity.set(0.1, 0, 20);
        car.fwdFlat.set(-Math.sin(0.35), 0, Math.cos(0.35));
        view.frameSpectate(car, "third", scene, 1 / hz, false);
        out.push(camera.position.clone());
      }
      return out;
    };
    for (const hz of [60, 240]) {
      const free = eyes(hz, null);
      const held = eyes(hz, wall);
      let pushed = 0;
      let step = 0;
      let at = 0;
      let last = new THREE.Vector3();
      for (let n = 0; n < free.length; n++) {
        // What the wall moved the eye by this frame, and how much of it is new (the rig's own blend-in settles in 2 s).
        const d = held[n]!.clone().sub(free[n]!);
        pushed = Math.max(pushed, d.length());
        if (n > 2 * hz && d.distanceTo(last) > step) {
          step = d.distanceTo(last);
          at = n / hz;
        }
        last = d;
      }
      t.diagnostic(`${hz} Hz: the wall pushed the eye up to ${pushed.toFixed(2)} m, by at most ${step.toFixed(4)} m a frame`);
      assert.ok(pushed > 1, `${hz} Hz: the wall pushed the eye ${pushed.toFixed(2)} m (the test needs it to reach in)`);
      assert.ok(step < 0.1, `${hz} Hz: the pull-in moved the eye ${step.toFixed(3)} m in one frame, at ${at.toFixed(2)} s`);
    }
  });
});

describe("given a spectator camera taking a car up from another shot", () => {
  const enter = (carZ: number): { first: number; moved: number } => {
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 180);
    camera.position.set(4, 2, 6);
    camera.lookAt(0, 1, 0);
    const seat = new DriverSeat();
    seat.mode = "drive";
    const view = new ChaseCamera(camera, fakeCanvas(), seat, { rx: 0, ry: 0 } as PadState, false, () => {});
    const car = new DeformableCar({ body: 0x808080, accent: 0x404040, name: "car" }, new THREE.Scene());
    car.group.position.set(0, 0, carZ);
    car.fwdFlat.set(0, 0, 1);
    const from = camera.position.clone();
    view.frameDrive(car, null, DT, false);
    return { first: camera.position.distanceTo(car.group.position), moved: camera.position.distanceTo(from) };
  };

  it("when the previous shot is within the blend range of the car, then the eye blends in and has hardly moved on the first frame", () => {
    const r = enter(CHASE.blendRange - 10);
    assert.ok(r.moved < 2, `the eye moved ${r.moved.toFixed(2)} m on the first frame`);
  });

  it("when the previous shot is farther off than the blend range, then the camera cuts to the chase shot, with no swoop across the map after a scene change", () => {
    const r = enter(426);
    assert.ok(r.first < 15, `the eye is ${r.first.toFixed(1)} m from the car on the first frame`);
  });
});

describe("given the chase camera on a car driven by its own drive", () => {
  const H = 1 / 240;

  /** A sedan from `v0` under `input` for `seconds`, stepped as the engine does, followed by one rig at 240 Hz and one at 60 Hz. */
  function followed(v0: number, input: (car: DeformableCar) => Partial<DriveInput>, seconds: number) {
    setGround(null);
    const car = new DeformableCar(paint(), new THREE.Scene());
    assignClass(car, "sedan");
    car.spawnFacing(0, 0, 0, v0);
    const w = newWorld([car], null);
    const rigs = [new DriveCam(), new DriveCam()];
    const cams = [new THREE.PerspectiveCamera(56, 16 / 9, 0.1, 180), new THREE.PerspectiveCamera(56, 16 / 9, 0.1, 180)];
    for (let i = 0, n = Math.round(seconds / H); i < n; i++) {
      applyDrive(car, { ...idleDrive(), ...input(car) }, H);
      stepWorld(w, H);
      rigs[0]!.update(cams[0]!, car, "third", H, 0, 0);
      if (i % 4 === 3) rigs[1]!.update(cams[1]!, car, "third", 4 * H, 0, 0);
    }
    for (const cam of cams) cam.updateMatrixWorld();
    return { car, rigs, fine: cams[0]!, coarse: cams[1]! };
  }

  /** The car's sideways distance (m) from the camera's centre line, + = the car is to the camera's right. */
  function offCentre(cam: THREE.PerspectiveCamera, car: DeformableCar): number {
    const f = cam.getWorldDirection(new THREE.Vector3());
    const l = Math.hypot(f.x, f.z);
    return ((car.group.position.x - cam.position.x) * f.z - (car.group.position.z - cam.position.z) * f.x) / l;
  }

  it("when the car holds 20 m/s straight for 3 s, then the eye sits the chase offset behind it and 60 and 240 Hz agree", () => {
    const r = followed(20, (car) => ({ throttle: Math.min(1, Math.max(0, 0.3 + (20 - car.speed) * 0.5)) }), 3);
    const p = r.car.group.position;
    const dist = CHASE.third.dist + Math.min(r.car.speed, 30) * CHASE.pullback;
    const gap = Math.hypot(r.fine.position.x - (p.x - r.car.fwdFlat.x * dist), r.fine.position.y - (p.y + CHASE.third.height), r.fine.position.z - (p.z - r.car.fwdFlat.z * dist));
    assert.ok(gap < 0.02, `the eye is ${(gap * 100).toFixed(1)} cm off the chase offset`);
    const rates = r.fine.position.distanceTo(r.coarse.position);
    assert.ok(rates < 0.01, `60 and 240 Hz eyes are ${(rates * 100).toFixed(2)} cm apart`);
  });

  it("when the car holds a 15 m/s turn at steer 0.5 for 2 s, then it sits off the camera's centre line, the same at 60 and 240 Hz", () => {
    const r = followed(15, (car) => ({ throttle: Math.min(1, Math.max(0, 0.3 + (15 - car.speed) * 0.5)), steer: 0.5 }), 2);
    const fine = Math.abs(offCentre(r.fine, r.car));
    const coarse = Math.abs(offCentre(r.coarse, r.car));
    assert.ok(fine >= 0.55, `the car is ${fine.toFixed(2)} m off the camera's centre line`);
    assert.ok(Math.abs(fine - coarse) <= 0.05 * fine, `60 Hz ${coarse.toFixed(3)} m, 240 Hz ${fine.toFixed(3)} m`);
  });

  it("when the car slides 40 degrees off its heading at 12 m/s, then the aim leads along its velocity, not its nose", () => {
    const car = new DeformableCar(paint(), new THREE.Scene());
    assignClass(car, "sedan");
    car.spawnFacing(0, 0, 0, 0);
    const heading = (40 * Math.PI) / 180;
    car.velocity.set(Math.sin(heading) * 12, 0, Math.cos(heading) * 12);
    const rig = new DriveCam();
    const cam = new THREE.PerspectiveCamera(56, 16 / 9, 0.1, 180);
    for (let t = 0; t < 3; t += DT) rig.update(cam, car, "third", DT, 0, 0);
    const aim = rig["aim"].x;
    const p = car.group.position;
    const off = (Math.atan2(aim.x - p.x, aim.z - p.z) * 180) / Math.PI;
    assert.ok(Math.abs(off - 40) < 1, `the aim leads ${off.toFixed(1)} degrees round, the velocity 40`);
    const lead = Math.hypot(aim.x - p.x, aim.z - p.z);
    assert.ok(Math.abs(lead - 12 * CHASE.aheadVel) < 0.05, `the aim leads ${lead.toFixed(2)} m`);
  });

  /** The eye over a fall from 3.2 m at 8 m/s after 0.4 s in the air: how far it dips below where it settles, its height 1.5 s after touchdown against that, the view's roll and its pitch. */
  function landing(h: number, reduceMotion: boolean) {
    const car = new DeformableCar(paint(), new THREE.Scene());
    assignClass(car, "sedan");
    car.spawnFacing(0, 0, 0, 0);
    const ground = car.group.position.y;
    car.group.position.y = ground + 3.2;
    const rig = new DriveCam();
    rig.reduceMotion = reduceMotion;
    const cam = new THREE.PerspectiveCamera(56, 16 / 9, 0.1, 180);
    const fwd = new THREE.Vector3();
    const step = () => {
      rig.update(cam, car, "third", h, 0, 0);
      cam.updateMatrixWorld();
    };
    for (let t = 0; t < 3; t += h) step();
    car.airborne = true;
    car.velocity.y = -8;
    for (let t = 0; t < 0.4 - 1e-9; t += h) {
      car.group.position.y -= 8 * h;
      step();
    }
    car.group.position.y = ground;
    car.airborne = false;
    car.wheelsDown = 15;
    car.velocity.y = 0;
    const settled = ground + CHASE.third.height;
    let low = Infinity;
    let roll = 0;
    const pitch: number[] = [];
    let after = 0;
    for (let t = 0; t < 1.5 - 1e-9; t += h) {
      step();
      low = Math.min(low, cam.position.y);
      roll = Math.max(roll, Math.abs(Math.asin(cam.matrixWorld.elements[1]!)));
      pitch.push(cam.getWorldDirection(fwd).y);
      after = cam.position.y;
    }
    return { dip: settled - low, off: Math.abs(after - settled), roll, pitch, fall: rig.landFall };
  }

  it("when the car lands on four wheels after 0.4 s falling at 8 m/s, then the eye dips under its settled height and is back within 1 cm by 1.5 s", () => {
    for (const h of [1 / 60, H]) {
      const l = landing(h, false);
      assert.ok(l.dip >= 0.03, `at ${Math.round(1 / h)} Hz the eye dipped ${(l.dip * 100).toFixed(1)} cm`);
      assert.ok(l.off < 0.01, `at ${Math.round(1 / h)} Hz the eye was ${(l.off * 100).toFixed(1)} cm off its settled height after 1.5 s`);
    }
  });

  it("when the car lands after a fall at 8 m/s, then the camera's landing carries the fall speed for the pad's rumble, and a fall under the landing floor carries none", () => {
    assert.ok(Math.abs(landing(H, false).fall - 8) < 1e-9);
    const was = LANDING.fall;
    LANDING.fall = 9;
    try {
      assert.equal(landing(H, false).fall, 0);
    } finally {
      LANDING.fall = was;
    }
  });

  it("when the car lands, then the view wobbles in pitch and roll for the landing's window", () => {
    const l = landing(H, false);
    const was = CHASE.landing.wobble;
    CHASE.landing.wobble = 0;
    const still = landing(H, false);
    CHASE.landing.wobble = was;
    let pitch = 0;
    for (let i = 0; i < l.pitch.length; i++) pitch = Math.max(pitch, Math.abs(l.pitch[i]! - still.pitch[i]!));
    assert.ok(pitch > 0.005, `the pitch moved ${pitch.toFixed(4)} against a still landing`);
    assert.ok(l.roll > 0.005, `the roll reached ${l.roll.toFixed(4)} rad`);
    assert.ok(still.roll < 1e-6, `a still landing rolled ${still.roll}`);
  });

  it("when motion is reduced, then the landing neither dips the eye past 1 cm nor wobbles the view", () => {
    const l = landing(H, true);
    assert.ok(l.dip <= 0.01, `the eye dipped ${(l.dip * 100).toFixed(1)} cm`);
    assert.ok(l.roll < 1e-6, `the view rolled ${l.roll} rad`);
  });
});

describe("given the chase eye's springs", () => {
  it("when an underdamped spring runs at 60 and 240 Hz, then it overshoots its target by the damping ratio's share and lands in the same place", () => {
    const zeta = 0.45;
    const rates = [1 / 60, 1 / 240].map((h) => {
      const s = new Spring();
      s.x = 1;
      let peak = 0;
      for (let t = 0; t < 1 - 1e-9; t += h) peak = Math.max(peak, -s.stepDamped(0, 7, zeta, h));
      return { x: s.x, peak };
    });
    const overshoot = Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta));
    assert.ok(Math.abs(rates[1]!.peak - overshoot) < 0.01, `overshoot ${rates[1]!.peak.toFixed(3)}, expected ${overshoot.toFixed(3)}`);
    assert.ok(Math.abs(rates[0]!.x - rates[1]!.x) < 1e-9, `60 Hz ${rates[0]!.x}, 240 Hz ${rates[1]!.x}`);
  });

  it("when a speed cap is set, then the eye's speed relative to its target never passes it", () => {
    const s = new Spring3();
    const target = new THREE.Vector3(0, 0, 10);
    const axes = { lon: 9, lat: 5.5, up: 7 };
    const calm = { lon: 1, lat: 1, up: 1 };
    let fastest = 0;
    for (let t = 0; t < 2; t += DT) {
      s.stepBasis(target, axes, calm, 3, DT, 0, 1);
      fastest = Math.max(fastest, s.v.length());
    }
    assert.ok(fastest <= 3 + 1e-9, `the eye reached ${fastest.toFixed(2)} m/s`);
  });
});

describe("given the chase camera and a hit on the car it follows", () => {
  const make = (reduceMotion = false) => {
    const seat = new DriverSeat();
    seat.mode = "drive";
    const camera = new THREE.PerspectiveCamera(56, 16 / 9, 0.1, 180);
    const view = new ChaseCamera(camera, fakeCanvas(), seat, { rx: 0, ry: 0 } as PadState, reduceMotion, () => {});
    return { seat, camera, view };
  };
  /** How far one frame of `trauma` moves the eye of a settled car in the seat's `view` (the clock held, so the shake's phase is the same in every call). */
  const shaken = (view: SeatView, trauma: number): number => {
    const { seat, camera, view: cam } = make();
    seat.view = view;
    const car = new DeformableCar(paint(), new THREE.Scene());
    assignClass(car, "sedan");
    car.spawnFacing(0, 0, 0, 0);
    for (let t = 0; t < 3; t += DT) cam.frameDrive(car, null, DT, true);
    const rest = camera.position.clone();
    cam.trauma = trauma;
    cam.frameDrive(car, null, DT, true);
    return camera.position.distanceTo(rest);
  };

  it("when the car is hit at 1, 4, 15 and 40 m/s, then a nudge adds nothing, a hard hit raises trauma by a straight ramp from 2 to 20 m/s, and trauma never passes 1", () => {
    const { view } = make();
    view.jolt(1);
    assert.equal(view.trauma, 0, "1 m/s");
    view.jolt(4);
    assert.ok(Math.abs(view.trauma - (4 - 2) / 18) < 1e-12, `4 m/s ${view.trauma}`);
    view.trauma = 0;
    view.jolt(15);
    assert.ok(Math.abs(view.trauma - 13 / 18) < 1e-12, `15 m/s ${view.trauma}`);
    view.jolt(40);
    assert.equal(view.trauma, 1, "40 m/s on top of that");
  });

  it("when a pile grinds on the car with a 10 m/s hit every frame for a second, then the shake holds that one hit's level instead of climbing to full", () => {
    const { view } = make();
    for (let f = 0; f < 60; f++) view.jolt(10);
    assert.ok(Math.abs(view.trauma - 8 / 18) < 1e-12, `trauma ${view.trauma} after 60 hits`);
  });

  it("when the eye's sideways shake is sampled every millisecond for a second, then it swings at most 12 times a second (a jolt, not a strobing flicker)", (t) => {
    let ms = 0;
    t.mock.method(performance, "now", () => ms);
    const { camera, view, look } = rig("global");
    view.look.copy(look);
    for (let f = 0; f < 120; f++) view.orbit(DT, 0, false);
    const rest = camera.position.clone();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    let crossings = 0;
    let prev = 0;
    for (ms = 0; ms < 1000; ms++) {
      camera.position.copy(rest);
      view.trauma = 1;
      view.orbit(0, 0, true);
      const side = camera.position.clone().sub(rest).dot(right);
      if (ms > 0 && Math.sign(side) !== Math.sign(prev) && side !== 0) crossings++;
      prev = side;
    }
    assert.ok(crossings <= 24, `${crossings} sign changes in 1 s (${crossings / 2} Hz)`);
  });

  it("when the orbit shakes, then the eye moves across the view and never along it, so the road far ahead holds still", (t) => {
    t.mock.method(performance, "now", () => 5000);
    const frame = (trauma: number) => {
      const { camera, view, look } = rig("global");
      view.look.copy(look);
      for (let f = 0; f < 120; f++) view.orbit(DT, 0, false);
      view.trauma = trauma;
      view.orbit(DT, 0, true);
      return { at: camera.position.clone(), dir: camera.getWorldDirection(new THREE.Vector3()) };
    };
    const calm = frame(0);
    const shaken = frame(0.7);
    const d = shaken.at.clone().sub(calm.at);
    assert.ok(d.length() > 0.02, `the eye moved ${d.length().toFixed(3)} m`);
    assert.ok(Math.abs(d.dot(calm.dir)) < 1e-9, `${d.dot(calm.dir)} m of it along the view`);
  });

  it("when the strength knob is 0, or motion is reduced, then a hit and the first crash's kick add no shake", () => {
    const was = CHASE.shake;
    CHASE.shake = 0;
    try {
      const { view } = make();
      view.jolt(30);
      view.kick(2);
      assert.equal(view.trauma, 0, "knob 0");
    } finally {
      CHASE.shake = was;
    }
    const calm = make(true).view;
    calm.jolt(30);
    calm.kick(2);
    assert.equal(calm.trauma, 0, "reduced motion");
    const half = make().view;
    CHASE.shake = 0.5;
    try {
      half.jolt(20);
      assert.equal(half.trauma, 0.5, "knob 0.5 halves a full hit");
    } finally {
      CHASE.shake = was;
    }
  });

  it("when the shake runs in the chase, far chase and hood views, then each moves the eye, and the hood by CHASE.shakeHood of the chase's amount", (t) => {
    t.mock.method(performance, "now", () => 5000);
    const chase = shaken("third", 0.7);
    const far = shaken("far", 0.7);
    const hood = shaken("first", 0.7);
    assert.ok(chase > 0.02 && far > 0.02, `chase ${chase.toFixed(3)} m, far ${far.toFixed(3)} m`);
    assert.ok(hood > 0.01 && Math.abs(hood / chase - CHASE.shakeHood) < 0.02, `hood ${hood.toFixed(3)} m is ${(hood / chase).toFixed(3)} of the chase's`);
    const calm = shaken("third", 0);
    assert.ok(calm < chase / 20, `no trauma moves the settled eye ${calm.toFixed(4)} m against the shake's ${chase.toFixed(3)} m`);
  });
});

describe("given the driven car's chase and far chase eye beside a course wall and under rising ground", () => {
  const make = (view: SeatView) => {
    const seat = new DriverSeat();
    seat.mode = "drive";
    seat.view = view;
    const camera = new THREE.PerspectiveCamera(56, 16 / 9, 0.1, 180);
    const cam = new ChaseCamera(camera, fakeCanvas(), seat, { rx: 0, ry: 0 } as PadState, false, () => {});
    const car = new DeformableCar(paint(), new THREE.Scene());
    assignClass(car, "sedan");
    car.spawnFacing(0, 0, 0, 0);
    return { camera, cam, car };
  };

  it("when the car stands nose turned off a wall and the eye behind it would be inside the wall, then the eye ends up outside the wall's clearance, and inside it without the sight", () => {
    // A wall along z with its face at x = 3; the eye of a car turned 0.5 rad off it sits at x ~ 3 (the chase) or ~ 4.8 (the far chase).
    const wall: Sight = { ground: FLAT_GROUND, path: null, wallTop: 0, rim: Infinity, occ: [occluder(53, 0, 0, 50, 2000, false, 0, 30)] };
    for (const view of ["third", "far"] as const) {
      const free = make(view);
      const held = make(view);
      for (const r of [free, held]) r.car.fwdFlat.set(-Math.sin(0.5), 0, Math.cos(0.5));
      for (let n = 0; n < 180; n++) {
        free.cam.frameDrive(free.car, null, DT, false);
        held.cam.frameDrive(held.car, wall, DT, false);
      }
      const f = free.camera.position;
      const h = held.camera.position;
      assert.ok(solid(wall, f.x, f.y, f.z, 0.5), `${view}: the unguarded eye at x ${f.x.toFixed(2)} m is not in the wall (the test needs it inside)`);
      assert.ok(!solid(wall, h.x, h.y, h.z, 0.5), `${view}: the eye at x ${h.x.toFixed(2)} m, y ${h.y.toFixed(2)} m stands inside the wall's clearance`);
    }
  });

  it("when the ground rises behind the car above the chase height, then the eye stays CHASE.floor above the ground under it on every frame", () => {
    // A hill face behind the car: 0.5 m up per metre toward -z, so the eye 6 m behind would sit 3 m up in the rock at the chase's 2 m.
    const hill = new Ground();
    hill.addFace(-50, -50, 0, 100, 100, 25, 25, -25, -25, Infinity);
    setGround(hill);
    try {
      for (const view of ["third", "far"] as const) {
        const { camera, cam, car } = make(view);
        let worst = Infinity;
        for (let n = 0; n < 180; n++) {
          cam.frameDrive(car, null, DT, false);
          const p = camera.position;
          worst = Math.min(worst, p.y - hill.heightAt(p.x, p.z, car.group.position.y));
        }
        assert.ok(worst >= CHASE.floor - 1e-6, `${view}: the eye came ${worst.toFixed(2)} m over the ground (clearance ${CHASE.floor} m)`);
      }
    } finally {
      setGround(null);
    }
  });
});
