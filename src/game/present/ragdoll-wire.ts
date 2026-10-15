import type { TrackJson } from "../world/track-schema.ts";
import type { CarStyleId } from "../vehicle/car-variants.ts";
import { PARTS } from "./ragdoll-body.ts";

/**
 * What the main thread and the dummies' world (a Web Worker, `ragdoll-worker.ts`) say to each other. The world's answer to
 * frame `n` that the sim cares about (a pane a torso struck, the cars it wants fitted) is held until the main thread posts
 * frame `n + LAG`, and the sim does not run a frame before that answer is in (`RagdollRemote.behind`): the sim hears of it
 * at the same step whatever the worker's speed.
 */
export const LAG = 2;
/** The cars' wanted-fit test looks this many frames of travel further out than a proxy's own, so a fit asked for arrives before the car is touched. */
export const FIT_AHEAD = LAG + 2;

/** A frame's car record, floats: the group's pose, its class body's pose in it, its velocity, speed, flags, glass state. */
export const CAR_FLOATS = 20;
export const CAR_POSITION = 0;
export const CAR_QUATERNION = 3;
export const CAR_LIFT_POSITION = 7;
export const CAR_LIFT_QUATERNION = 10;
export const CAR_VELOCITY = 14;
export const CAR_SPEED = 17;
export const CAR_FLAGS = 18;
export const CAR_GLASS = 19;
export const FLAG_FALLING = 1;
export const FLAG_VAPORIZED = 2;
export const FLAG_LIFT = 4;

/** A dummy's record in a result, floats: a header, then each part's pose before the last step and after it. */
export const DOLL_LIVE = 0;
export const DOLL_RIDES = 1;
export const DOLL_CAR = 2;
export const DOLL_STILL = 3;
export const DOLL_SETTLED = 4;
export const DOLL_VELOCITY = 5;
export const DOLL_HEADER = 8;
export const DOLL_FLOATS = DOLL_HEADER + 2 * PARTS.length * 7;
/** A knocked prop's pose in a result: its index, the art's base position and rotation. */
export const PROP_FLOATS = 8;

type Triple = readonly [number, number, number];
type Quad = readonly [number, number, number, number];

interface ThrowMessage {
  type: "throw";
  id: number;
  car: number;
  position: Triple;
  rotation: Quad;
  velocity: Triple;
  spin: Triple;
  cop: boolean;
  rides: boolean;
  purse: boolean;
  lookSeed: number;
}

/** A car's cage as the dummies' world fits a proxy to it (`CageView`), sent when it changes. */
export interface CageMessage {
  type: "cage";
  slot: number;
  /** Which car is in the slot: a new one gets a new world-side car. */
  car: number;
  style: CarStyleId;
  classLift: number;
  serial: number;
  top: Float32Array;
  covered: Uint8Array;
  plan: Float32Array;
  planBox: Float64Array;
  heightMax: number;
  nu: number;
  nv: number;
  u0: number;
  v0: number;
  step: number;
}

interface FrameMessage {
  type: "frame";
  seq: number;
  epoch: number;
  dt: number;
  authority: boolean;
  sandbox: boolean;
  lookSeed: number;
  count: number;
  cars: Float64Array;
}

export type ToWorker =
  | { type: "course"; json: TrackJson }
  | { type: "reset"; epoch: number }
  | { type: "knock"; prop: number; car: number; vx: number; vy: number; vz: number }
  | ThrowMessage
  | CageMessage
  | FrameMessage;

/** A pane of car `car` a torso struck (`GLASS_NAMES` index `pane`). */
export interface GlassHit {
  car: number;
  pane: number;
}

export interface ResultMessage {
  type: "result";
  seq: number;
  epoch: number;
  /** `SLOTS` dummy records. */
  dolls: Float32Array;
  alpha: number;
  lastSlot: number;
  purses: Float32Array;
  /** Knocked props placed this frame (`PROP_FLOATS` each), after the reset if `propsReset`. */
  props: Float32Array;
  propsReset: boolean;
  spawned: { id: number; slot: number }[];
  hits: GlassHit[];
  /** Per car, 1 when a dummy, purse thing or knocked prop may reach it within `FIT_AHEAD` frames: the cars the main thread sends cages of. */
  wanted: Uint8Array;
  /** Anything is out: a dummy, a purse thing or a knocked prop. */
  active: boolean;
  /** The wall ms of the `world.step()` calls since the last result. */
  stepMs: Float64Array;
  colliders: number;
  bodies: number;
}

export type FromWorker = { type: "ready" } | { type: "failed"; message: string } | ResultMessage;
