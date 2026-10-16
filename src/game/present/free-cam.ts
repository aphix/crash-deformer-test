import * as THREE from "three";
import { hypot2 } from "../kernel/physics-core.js";
import { DERBY_RADIUS } from "../scenes/derby-arena.ts";
import { activeGround, DISC_RADIUS, NO_FLOOR } from "../world/ground.ts";

/** Radians of look per pixel of pointer drag (yaw, pitch): the orbit's and the free view's alike, so a drag turns the view the same on either. */
export const DRAG_YAW_PER_PX = 0.005;
export const DRAG_PITCH_PER_PX = 0.004;
/** The right stick's look rates (rad/s, yaw and pitch), for the orbit and the free view alike. */
export const PAD_YAW_RATE = 2.2;
export const PAD_PITCH_RATE = 1.4;

/**
 * The free view's knobs, all scaled from the scene's extent (`FreeExtent`) so a derby bowl of 38 m radius and a course
 * several kilometres long both fly well. "Guessed, then flown in the derby arena and the fleet disc" is their source.
 */
const FREE = {
  /** How far (as a multiple of the extent's radius) the eye may go from the scene's middle, sideways and up: 3 x the derby's 38 m radius is 114 m, high enough to hold the whole bowl and its berm in one frame at the 50 degree lens (measured over the derby in a browser: 95 m clipped the berm), inside the camera's 180 m far plane. */
  reach: 3,
  /** Cruise speed crosses the reach in this many seconds, clamped to `cruiseMin..cruiseMax` m/s (a walking pace in a rig scene up to a race car's top speed). */
  crossSeconds: 6,
  cruiseMin: 8,
  cruiseMax: 60,
  /** Shift multiplies the speed by this. */
  fast: 3,
  /** The wheel scales the speed by exp(-deltaY x this), within 1/`speedSpan` .. `speedSpan`. */
  wheelRate: 0.0015,
  speedSpan: 8,
  /** The eye stands at least this far (m) over the ground under it: a car's roof is 1.5 m, and 0.8 m is eight times the near plane. */
  clearance: 0.8,
  /** Pitch limit (rad): just short of straight up or down, where yaw and pitch turn into one axis. */
  pitchLimit: 1.5,
  /** A two-finger pan or pinch of this many pixels crosses the reach (a thumb's span across a phone is about 400 px). */
  sweepPx: 400,
};

/** The scene's footprint the free view scales from: its middle (x, z) and radius (m). */
type FreeExtent = { x: number; z: number; radius: number };

/** What the player holds this frame, each axis -1..1: forward / back and strafe along the look plane (the look's heading, level), rise up / down, the right stick's look, and the fast modifier. */
export type FreeInput = { forward: number; strafe: number; rise: number; lookX: number; lookY: number; fast: boolean };

export function blankFreeInput(): FreeInput {
  return { forward: 0, strafe: 0, rise: 0, lookX: 0, lookY: 0, fast: false };
}

type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number };

/** The scene's footprint into `out`: the course's bounds (its middle, half the diagonal) when one is raced, else the derby's bowl, else the fleet's disc. */
export function sceneExtent(out: FreeExtent, derby: boolean, course: Bounds | null): FreeExtent {
  if (course) {
    out.x = (course.minX + course.maxX) / 2;
    out.z = (course.minZ + course.maxZ) / 2;
    out.radius = hypot2(course.maxX - course.minX, course.maxZ - course.minZ) / 2;
    return out;
  }
  out.x = 0;
  out.z = 0;
  out.radius = derby ? DERBY_RADIUS : DISC_RADIUS;
  return out;
}

const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");

/**
 * The detached spectator eye: its own position, heading (yaw) and pitch, flown by keys, stick, drag and touch gestures, never
 * following a car. Camera only: it reads the ground and writes the camera, nothing in the sim.
 */
export class FreeCam {
  readonly eye = new THREE.Vector3();
  /** Heading (rad, three's: 0 looks down -z, positive turns left) and pitch (rad, positive looks up). */
  yaw = 0;
  pitch = 0;
  /** The scene's footprint, set by the engine each frame. */
  readonly extent: FreeExtent = { x: 0, z: 0, radius: DISC_RADIUS };
  /** The wheel's share of the cruise speed. */
  speedScale = 1;
  /** The eye has taken the camera's pose (`begin`) and flies from it. */
  begun = false;

  /** Take the camera's pose as the starting eye and heading, so entering the view cuts nothing. */
  begin(camera: THREE.PerspectiveCamera): void {
    camera.getWorldDirection(_dir);
    this.eye.copy(camera.position);
    this.yaw = Math.atan2(-_dir.x, -_dir.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(_dir.y, -1, 1));
    this.speedScale = 1;
    this.begun = true;
  }

  get reach(): number {
    return this.extent.radius * FREE.reach;
  }

  /** Cruise speed (m/s) before the wheel's scale and Shift. */
  get cruise(): number {
    return THREE.MathUtils.clamp(this.reach / FREE.crossSeconds, FREE.cruiseMin, FREE.cruiseMax);
  }

  /** A pointer drag or mouse-look movement of (`dx`, `dy`) px: right turns right, down looks down. */
  lookBy(dx: number, dy: number): void {
    this.yaw -= dx * DRAG_YAW_PER_PX;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * DRAG_PITCH_PER_PX, -FREE.pitchLimit, FREE.pitchLimit);
  }

  /** The wheel: up speeds the flight, down slows it. */
  speedBy(deltaY: number): void {
    this.speedScale = THREE.MathUtils.clamp(this.speedScale * Math.exp(-deltaY * FREE.wheelRate), 1 / FREE.speedSpan, FREE.speedSpan);
  }

  /** A two-finger drag of (`dx`, `dy`) px: the view slides with the fingers (the eye goes the other way). */
  panBy(dx: number, dy: number): void {
    const metres = this.reach / FREE.sweepPx;
    this.basis();
    this.eye.addScaledVector(_right, -dx * metres).addScaledVector(_up, dy * metres);
  }

  /** A pinch that widens by `px`: the eye goes forward along the view, closing by `px` goes back. */
  dollyBy(px: number): void {
    this.basis();
    this.eye.addScaledVector(_dir, (px * this.reach) / FREE.sweepPx);
  }

  /** The view's forward, right and up into the scratch vectors. */
  private basis(): void {
    _euler.set(this.pitch, this.yaw, 0);
    _dir.set(0, 0, -1).applyEuler(_euler);
    _right.set(1, 0, 0).applyEuler(_euler);
    _up.crossVectors(_right, _dir);
  }

  /** One frame: fly by `input` for `wallDt` s, keep the eye inside the reach and over the ground, and put it on `camera`. */
  step(camera: THREE.PerspectiveCamera, input: FreeInput, wallDt: number): void {
    this.yaw -= input.lookX * PAD_YAW_RATE * wallDt;
    this.pitch = THREE.MathUtils.clamp(this.pitch - input.lookY * PAD_PITCH_RATE * wallDt, -FREE.pitchLimit, FREE.pitchLimit);
    const speed = this.cruise * this.speedScale * (input.fast ? FREE.fast : 1);
    // Two keys at once (W and D) fly no faster than one.
    const across = hypot2(input.forward, input.strafe);
    const share = across > 1 ? 1 / across : 1;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const along = input.forward * share * speed * wallDt;
    const aside = input.strafe * share * speed * wallDt;
    this.eye.x += -sin * along + cos * aside;
    this.eye.z += -cos * along - sin * aside;
    this.eye.y += input.rise * speed * wallDt;
    this.keepInBounds();
    camera.position.copy(this.eye);
    _euler.set(this.pitch, this.yaw, 0);
    camera.quaternion.setFromEuler(_euler);
  }

  /** The eye inside the reach of the scene's middle (sideways and up) and `clearance` over the ground under it (the floor is y 0 where there is none). */
  private keepInBounds(): void {
    const e = this.eye;
    const reach = this.reach;
    const out = hypot2(e.x - this.extent.x, e.z - this.extent.z);
    if (out > reach) {
      e.x = this.extent.x + ((e.x - this.extent.x) * reach) / out;
      e.z = this.extent.z + ((e.z - this.extent.z) * reach) / out;
    }
    const ground = activeGround().heightAt(e.x, e.z, e.y);
    const floor = (ground === NO_FLOOR ? 0 : ground) + FREE.clearance;
    e.y = Math.max(floor, Math.min(e.y, Math.max(reach, floor)));
  }
}
