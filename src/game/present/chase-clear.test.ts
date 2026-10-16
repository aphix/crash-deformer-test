import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { DriverSeat } from "../vehicle/car-drive.ts";
import type { PadState } from "../vehicle/gamepad.ts";
import { DERBY_RADIUS } from "../scenes/derby-arena.ts";
import { DERBY_BOXES, DERBY_PROP, DERBY_TABLE_TOP, DerbyGround, type DerbyBox } from "../scenes/derby-ground.ts";
import { NO_FLOOR, setGround } from "../world/ground.ts";
import { placeProps } from "../world/placements.ts";
import { parseTrack } from "../world/track-schema.ts";
import { Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { ChaseCamera, type CarPicker } from "./engine-camera.ts";
import { CHASE } from "./drive-cam.ts";
import { ChaseSolids } from "./chase-solids.ts";
import { EyeClear } from "./eye-clear.ts";
import { carsBlock, CINE, occluder, raceSight, solid, type Sight } from "./spectate-cam.ts";
import { FRAME_HZ } from "../kernel/constants.ts";

const DT = 1 / FRAME_HZ;
/** A car's length: an eye pulled in closer than this swings round instead. */
const CAR_LENGTH = 4.44;
const NO_PICK: CarPicker = { at: () => -1, choose() {} };

function fakeCanvas(): HTMLCanvasElement {
  const target = new EventTarget() as unknown as HTMLCanvasElement; // the camera uses addEventListener, style and pointer capture only
  Object.assign(target, { style: {}, setPointerCapture: () => {}, releasePointerCapture: () => {} });
  return target;
}

function pointer(canvas: HTMLCanvasElement, type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number): void {
  canvas.dispatchEvent(Object.assign(new Event(type), { button: 0, pointerId: 1, clientX: x, clientY: y }));
}

function newCar(x: number, z: number, yaw: number): DeformableCar {
  const car = new DeformableCar({ body: 0x808080, accent: 0x404040, name: "car" }, new THREE.Scene());
  car.group.position.set(x, 0, z);
  car.fwdFlat.set(Math.sin(yaw), 0, Math.cos(yaw));
  return car;
}

/** The derby bowl as the engine's chase sight builds it (`ChaseSolids`): the floor, the rim, the free-standing prisms, and the cars in `rivals`. */
function bowlSight(rivals: readonly DeformableCar[], except: DeformableCar | null): Sight {
  return new ChaseSolids(() => {}).frame(null, true, rivals, except);
}

/** What the eye must clear, read from the scene's own data: every prism of the bowl (the ring wall too) and each rival's tight box. */
function exactSolids(sight: Sight): Sight {
  const boxes = DERBY_BOXES.map((b) => occluder(b.x, b.z, b.yaw, b.hx, b.hz, false, 0, b.height));
  for (const box of sight.cars ?? []) if (box.y0 !== Infinity) boxes.push(box);
  return { ...sight, cars: boxes };
}

/** True when `eye` is inside a solid of the bowl or has one on its line to `subject` (the last 1.5 m of it, the car's own, aside), or is outside the ring wall. */
function sightBlocked(exact: Sight, eye: THREE.Vector3, subject: THREE.Vector3): boolean {
  return carsBlock(exact, eye, subject) || Math.hypot(eye.x, eye.z) > DERBY_RADIUS;
}

type Drive = { it: string; x: number; z: number; yaw: number; speed: number; seconds: number; lookDown: number; rivals: readonly { x: number; z: number; yaw: number }[] };

/** The container the chase tests stand before: the first of the row against the wall (its long axis along the wall, its width radial). */
const CONTAINER = DERBY_BOXES.find((b) => b.kind === DERBY_PROP.container)!;
/** A rail of the chicane against the wall (its long axis along the wall, its width radial). */
const RAIL = DERBY_BOXES.find((b) => b.kind === DERBY_PROP.rail)!;
/** A car this far (m) in front of a prop's face: the eye `CHASE.third.dist` behind it is past the prop. */
const FACE_GAP = 2.58;
/** A stretch of the ring wall with no prop or ramp at it (degrees round from +z, between the east ramp and the tyre berm), and how far out (m) a car stands at it: nose to the wall, or driving off it with the eye outside. */
const BARE_WALL_DEGREES = 128;
const WALL_START_RADIUS = 37.16;
const WALL_NOSE_RADIUS = 36.68;

/** The point `radiusOut` m out along `degrees` round from +z, and the yaw facing the middle. */
function atWall(degrees: number, radiusOut: number): { x: number; z: number; yaw: number } {
  const bearing = degrees * (Math.PI / 180);
  return { x: Math.sin(bearing) * radiusOut, z: Math.cos(bearing) * radiusOut, yaw: bearing + Math.PI };
}

/** The point `gap` m in front of the face of `box` toward the middle (negative: behind its face), on the line from the middle through its centre, and the yaw facing the middle. */
function inFrontOf(box: DerbyBox, gap: number): { x: number; z: number; yaw: number } {
  const out = Math.hypot(box.x, box.z);
  const reach = out - box.hx - gap;
  return { x: (box.x / out) * reach, z: (box.z / out) * reach, yaw: Math.atan2(-box.x, -box.z) };
}

const beforeContainer = inFrontOf(CONTAINER, FACE_GAP);
const beforeRail = inFrontOf(RAIL, FACE_GAP);

/** A driver's chase camera whose lens starts where the rig would put it behind a car at (`x`, `z`) facing `yaw`, as a camera already following it is. */
function chaseRig(x: number, z: number, yaw: number, y = 0) {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 180);
  const seat = new DriverSeat();
  seat.mode = "drive";
  const view = new ChaseCamera(camera, fakeCanvas(), seat, { rx: 0, ry: 0 } as PadState, false, NO_PICK);
  camera.position.set(x - Math.sin(yaw) * CHASE.third.dist, y + CHASE.third.height, z - Math.cos(yaw) * CHASE.third.dist);
  return { camera, view };
}

/** The height (m) of the bowl's table-top plateau, over its whole flat top. */
const TABLE_TOP = DERBY_TABLE_TOP.height;
/** The car stands still this long (s) before a drive sets off, so the chase eye settles first. */
const HOLD = 1.5;

/** Every frame of a car driven straight along `drive` (kinematically, at 60 Hz), followed by one chase camera that keeps clear (`keep`) or none. */
function follow(drive: Drive, keep: boolean) {
  const rivals = drive.rivals.map((r) => newCar(r.x, r.z, r.yaw));
  const car = newCar(drive.x, drive.z, drive.yaw);
  const sight = bowlSight(rivals, car);
  const exact = exactSolids(sight);
  const { camera, view } = chaseRig(drive.x, drive.z, drive.yaw);
  view.drive.nudge(0, -drive.lookDown);
  const sx = Math.sin(drive.yaw);
  const cz = Math.cos(drive.yaw);
  const eyes: THREE.Vector3[] = [];
  const subject = new THREE.Vector3();
  let blocked = 0;
  for (let f = 0; f < (HOLD + drive.seconds) / DT; f++) {
    const moving = f * DT >= HOLD;
    const t = moving ? f * DT - HOLD : 0;
    car.group.position.set(drive.x + sx * drive.speed * t, 0, drive.z + cz * drive.speed * t);
    car.velocity.set(moving ? sx * drive.speed : 0, 0, moving ? cz * drive.speed : 0);
    view.frameDrive(car, keep ? sight : null, DT, false);
    subject.set(car.group.position.x, car.group.position.y + CHASE.third.aimUp, car.group.position.z);
    if (sightBlocked(exact, camera.position, subject)) blocked++;
    eyes.push(camera.position.clone());
  }
  return { blocked, eyes };
}

describe("given the chase camera on a car driven through the derby bowl", () => {
  before(() => setGround(new DerbyGround()));
  after(() => setGround(null));

  const drives: Drive[] = [
    { it: "away from the red container, whose face the eye starts behind", ...beforeContainer, speed: 8, seconds: 6, lookDown: 0, rivals: [] },
    { it: "away from the rail chicane, with a rail between the eye and the car", ...beforeRail, speed: 8, seconds: 1.2, lookDown: 0, rivals: [] },
    { it: "away from the ring wall, with the eye starting outside it", ...atWall(BARE_WALL_DEGREES, WALL_START_RADIUS), speed: 6, seconds: 4, lookDown: 0, rivals: [] },
    { it: "with the eye low and another car right behind it", x: 0, z: 0, yaw: 0, speed: 3, seconds: 3, lookDown: 200, rivals: [{ x: 0, z: -4.5, yaw: 0 }] },
  ];

  for (const drive of drives) {
    it(`when it is driven ${drive.it}, then the eye is never inside a solid, outside the wall or behind one, and without the keeper it is`, () => {
      const kept = follow(drive, true);
      const bare = follow(drive, false);
      assert.equal(kept.blocked, 0, `frames with the car hidden or the eye in a solid, kept (of ${kept.eyes.length})`);
      assert.ok(bare.blocked > 10, `frames with the car hidden or the eye in a solid, bare: ${bare.blocked} (the drive must put a solid in the way)`);
    });
  }

  it("when it is driven in circles on the table-top, then the eye is exactly where the bare rig puts it, frame for frame", () => {
    const rivals = [newCar(28, -18, 0)];
    const run = (keep: boolean): THREE.Vector3[] => {
      const car = newCar(DERBY_TABLE_TOP.x, DERBY_TABLE_TOP.z, Math.PI / 2);
      const sight = bowlSight(rivals, car);
      const { camera, view } = chaseRig(DERBY_TABLE_TOP.x, DERBY_TABLE_TOP.z, Math.PI / 2, TABLE_TOP);
      const eyes: THREE.Vector3[] = [];
      for (let f = 0; f < 600; f++) {
        const angle = f * DT * 1.2;
        car.group.position.set(DERBY_TABLE_TOP.x + 2.5 * Math.sin(angle), TABLE_TOP, DERBY_TABLE_TOP.z + 2.5 * Math.cos(angle));
        car.fwdFlat.set(Math.cos(angle), 0, -Math.sin(angle));
        car.velocity.copy(car.fwdFlat).multiplyScalar(3);
        view.frameDrive(car, keep ? sight : null, DT, false);
        eyes.push(camera.position.clone());
      }
      return eyes;
    };
    const kept = run(true);
    const bare = run(false);
    let worst = 0;
    for (let f = 0; f < kept.length; f++) worst = Math.max(worst, kept[f]!.distanceTo(bare[f]!));
    assert.equal(worst, 0, "largest distance (m) between the kept eye and the bare rig's over 600 frames");
  });

  it("when the car stands against a container's face with its chase eye behind inside it, then the eye swings round to a clear side at least a car's length out", () => {
    const rival = { ...inFrontOf(CONTAINER, 2.38) };
    const rivalCar = newCar(rival.x, rival.z, rival.yaw);
    const sight = bowlSight([], rivalCar);
    const exact = exactSolids(sight);
    const ahead = inFrontOf(CONTAINER, 1.08);
    const subject = new THREE.Vector3(ahead.x, CHASE.third.aimUp, ahead.z);
    const behind = inFrontOf(CONTAINER, -5.32);
    const rig = new THREE.Vector3(behind.x, 2.4, behind.z);
    const eye = rig.clone();
    new EyeClear().apply(sight, sight.cars!, subject, eye, Infinity);
    assert.equal(sightBlocked(exact, eye, subject), false, "eye hidden or inside a solid");
    assert.ok(eye.distanceTo(subject) >= CAR_LENGTH - 0.05, `eye ${eye.distanceTo(subject).toFixed(2)} m from the car`);
    assert.ok(Math.abs(Math.atan2(eye.x - subject.x, eye.z - subject.z) - Math.atan2(rig.x - subject.x, rig.z - subject.z)) > 0.1, "the eye turned round the car");
  });

  it("when the orbit looks at a car 2.4 m from a container's face from low and the far side of it, then the orbit's eye keeps the car in sight", () => {
    const orbit = (keep: boolean): number => {
      const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 180);
      const seat = new DriverSeat();
      seat.mode = "global";
      const canvas = fakeCanvas();
      const view = new ChaseCamera(camera, canvas, seat, { rx: 0, ry: 0 } as PadState, false, NO_PICK);
      view.attach();
      const lookAt = inFrontOf(CONTAINER, 2.58);
      const lensAt = inFrontOf(CONTAINER, -10.02);
      view.look.set(lookAt.x, 0.7, lookAt.z);
      camera.position.set(lensAt.x, 2, lensAt.z);
      pointer(canvas, "pointerdown", 100, 100);
      pointer(canvas, "pointermove", 100, -4000);
      const sight = bowlSight([], null);
      const exact = exactSolids(sight);
      let blocked = 0;
      for (let f = 0; f < 300; f++) {
        view.orbit(DT, 0, false, keep ? sight : null);
        if (sightBlocked(exact, camera.position, view.look)) blocked++;
      }
      return blocked;
    };
    assert.equal(orbit(true), 0, "orbit frames with the car hidden or the eye in a solid, kept");
    assert.ok(orbit(false) > 10, "orbit frames with the car hidden or the eye in a solid, bare (the orbit must put a solid in the way)");
  });

  it("when the rear view is held on a car nose to the ring wall, then the eye ahead of the car stays inside the wall with the car in sight, and outside it without the keeper", () => {
    const rear = (keep: boolean): boolean => {
      const nose = atWall(BARE_WALL_DEGREES, WALL_NOSE_RADIUS);
      const car = newCar(nose.x, nose.z, nose.yaw + Math.PI);
      const sight = bowlSight([], car);
      const { camera, view } = chaseRig(nose.x, nose.z, nose.yaw + Math.PI);
      view.lookBack(car, keep ? sight : null, DT);
      const subject = new THREE.Vector3(nose.x, CHASE.third.aimUp, nose.z);
      return sightBlocked(exactSolids(sight), camera.position, subject);
    };
    assert.equal(rear(true), false, "the rear view's eye hidden from the car or in a solid, kept");
    assert.equal(rear(false), true, "the rear view's eye hidden from the car or in a solid, bare (the wall must be in the way)");
  });
});

describe("given the chase camera on a car 2 m outside a tall prop or building of each course, driving away from it", () => {
  /** Props at least this tall (m) are tried, `PER_COURSE` of them spread over the course's list, from two sides each. */
  const TALL = 3;
  const PER_COURSE = 12;
  const TURNS = [0, Math.PI];
  const SPEED = 8;
  /** True when `eye` is inside a solid of the course, or a solid stands on its line to `subject` (all but the last 1.5 m of it, the car's own), checked every 0.25 m with no clearance. */
  const courseBlocked = (sight: Sight, eye: THREE.Vector3, subject: THREE.Vector3): boolean => {
    if (solid(sight, eye.x, eye.y, eye.z, 0)) return true;
    const length = eye.distanceTo(subject);
    for (let d = 0.25; d < length - 1.5; d += 0.25) {
      const share = d / length;
      if (solid(sight, eye.x + (subject.x - eye.x) * share, eye.y + (subject.y - eye.y) * share, eye.z + (subject.z - eye.z) * share, 0)) return true;
    }
    return false;
  };

  it("when it sets off from each, then the eye is never inside a solid and never has one between it and the car, and without the keeper it is", () => {
    let bareTotal = 0;
    let tried = 0;
    for (const json of TRACKS) {
      const track = new Track(parseTrack(json));
      const sight = raceSight(track, placeProps(track));
      const tall = sight.occ.filter((o) => o.y1 - o.y0 >= TALL);
      setGround(track.ground());
      try {
        for (let i = 0; i < tall.length; i += Math.max(1, Math.floor(tall.length / PER_COURSE))) {
          const prop = tall[i]!;
          for (const turn of TURNS) {
            const reach = (prop.circle ? prop.hx : Math.hypot(prop.hx, prop.hz)) + 2;
            const x = prop.x + Math.cos(turn) * reach;
            const z = prop.z + Math.sin(turn) * reach;
            const ground = sight.ground.heightAt(x, z, prop.y1 + 2);
            if (ground === NO_FLOOR) continue;
            const yaw = Math.atan2(Math.cos(turn), Math.sin(turn));
            const outcome = [true, false].map((keep) => {
              const car = newCar(x, z, yaw);
              car.group.position.y = ground;
              const { camera, view } = chaseRig(x, z, yaw, ground);
              const subject = new THREE.Vector3();
              let blocked = 0;
              for (let f = 0; f < 2 / DT; f++) {
                const t = Math.max(0, f * DT - 1);
                car.group.position.set(x + Math.sin(yaw) * SPEED * t, ground, z + Math.cos(yaw) * SPEED * t);
                subject.set(car.group.position.x, car.group.position.y + CHASE.third.aimUp, car.group.position.z);
                // The drive ends where the car itself would be inside a wall or a prop: no camera can see a car through its own wall.
                if (solid(sight, subject.x, subject.y, subject.z, CINE.pad)) break;
                car.velocity.set(f * DT >= 1 ? Math.sin(yaw) * SPEED : 0, 0, f * DT >= 1 ? Math.cos(yaw) * SPEED : 0);
                view.frameDrive(car, keep ? sight : null, DT, false);
                if (f >= 30 && courseBlocked(sight, camera.position, subject)) blocked++;
              }
              return blocked;
            });
            tried++;
            assert.equal(outcome[0], 0, `${track.id} prop ${i}, turn ${turn.toFixed(2)}: frames with the eye in a solid or the car hidden, kept`);
            bareTotal += outcome[1]!;
          }
        }
      } finally {
        setGround(null);
      }
    }
    assert.ok(tried > 50, `placements tried over every course: ${tried}`);
    assert.ok(bareTotal > 100, `frames with the eye in a solid or the car hidden, bare, over every course: ${bareTotal} (the placements must put solids in the way)`);
  });
});
