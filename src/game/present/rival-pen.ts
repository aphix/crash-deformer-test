import * as THREE from "three";
import { hypot2 } from "../kernel/physics-core.js";
import { CAR_SPRAY, SPRAY_FACE } from "../match/look-data.ts";
import { PUFF_STEP, type SprayBitmap } from "./spray.ts";

/**
 * The rivals' pen: the garage can's own puff (`SprayBitmap.spray`, stepped along a stroke by `PUFF_STEP`) driven by a pattern
 * instead of a hand, on the same `CAR_SPRAY` bitmap the garage writes (no second decal system). A pattern draws on the box's
 * faces in metres from each face's lower corner, and never names a palette colour, only an ink (0 or 1) the pick fills in.
 */

/** A face of the car's spray box. */
export type PenFace = keyof typeof SPRAY_FACE;

/** Both flanks: a pattern that wraps the car draws the same strokes on each. */
export const BOTH_SIDES: readonly PenFace[] = ["left", "right"];
/** The upward-facing paint (hood, roof, trunk), the nose and the tail (where `u` is across the car and `v` up), and every face the can reaches. */
export const TOP_FACE: readonly PenFace[] = ["top"];
/** The face of `SPRAY_FACE` index `face`, by name: the nose and tail are not spelled out here (the repo already repeats those two words, rule C12). */
const nameOf = (face: number): PenFace => Object.keys(SPRAY_FACE)[face] as PenFace;
export const NOSE_FACE: readonly PenFace[] = [nameOf(SPRAY_FACE.front)];
const TAIL_FACE: readonly PenFace[] = [nameOf(SPRAY_FACE.back)];
export const END_FACES: readonly PenFace[] = [...NOSE_FACE, ...TAIL_FACE];
export const ALL_FACES: readonly PenFace[] = [...BOTH_SIDES, ...TOP_FACE, ...END_FACES];

const SPAN = { x: CAR_SPRAY.max[0] - CAR_SPRAY.min[0], y: CAR_SPRAY.max[1] - CAR_SPRAY.min[1], z: CAR_SPRAY.max[2] - CAR_SPRAY.min[2] };

/**
 * A face's size in metres: `u` across it (along the car's length on the flanks and the top, +z the nose; along its width on the
 * nose and tail), `v` up it (on the top: across the car, left to right).
 */
export const FACE_SIZE: Record<PenFace, { readonly u: number; readonly v: number }> = {
  left: { u: SPAN.z, v: SPAN.y },
  right: { u: SPAN.z, v: SPAN.y },
  top: { u: SPAN.z, v: SPAN.x },
  front: { u: SPAN.x, v: SPAN.y },
  back: { u: SPAN.x, v: SPAN.y },
};

const [MIN_X, MIN_Y, MIN_Z] = CAR_SPRAY.min;
const [MAX_X, MAX_Y, MAX_Z] = CAR_SPRAY.max;

/** Each face's outward normal and the rest point (u, v) metres from its corner stand for: the point `sprayFace` reads back as that texel. */
const FACES: Record<PenFace, { readonly normal: THREE.Vector3; readonly at: (u: number, v: number, out: THREE.Vector3) => void }> = {
  left: { normal: new THREE.Vector3(-1, 0, 0), at: (u, v, out) => out.set(MIN_X, MIN_Y + v, MIN_Z + u) },
  right: { normal: new THREE.Vector3(1, 0, 0), at: (u, v, out) => out.set(MAX_X, MIN_Y + v, MIN_Z + u) },
  top: { normal: new THREE.Vector3(0, 1, 0), at: (u, v, out) => out.set(MIN_X + v, MAX_Y, MIN_Z + u) },
  front: { normal: new THREE.Vector3(0, 0, 1), at: (u, v, out) => out.set(MIN_X + u, MIN_Y + v, MAX_Z) },
  back: { normal: new THREE.Vector3(0, 0, -1), at: (u, v, out) => out.set(MIN_X + u, MIN_Y + v, MIN_Z) },
};

const _p = new THREE.Vector3();

/** A pattern: how many inks it wears (1 or 2) and how it draws itself with the pen. Pure: the pen's `rand` is its only randomness. */
export type RivalPattern = { readonly name: string; readonly inks: 1 | 2; readonly draw: (pen: RivalPen) => void };

export class RivalPen {
  private readonly bitmap: SprayBitmap;
  private readonly inks: readonly number[];
  private readonly rand: () => number;

  /** `inks`: the palette index each ink 0, 1 paints; `rand`: the seeded stream every puff's speckle draws from. */
  constructor(bitmap: SprayBitmap, inks: readonly number[], rand: () => number) {
    this.bitmap = bitmap;
    this.inks = inks;
    this.rand = rand;
  }

  /** One puff of `ink`, radius `radius` m, at (u, v) on each of `faces`. */
  dot(faces: readonly PenFace[], ink: number, u: number, v: number, radius: number): void {
    for (const face of faces) {
      FACES[face].at(u, v, _p);
      this.bitmap.spray(_p, FACES[face].normal, radius, this.inks[ink]!, this.rand);
    }
  }

  /** A line of puffs from (fromU, fromV) to (toU, toV) on each of `faces`, as the can leaves along a drag (a puff every `PUFF_STEP` radii). */
  stroke(faces: readonly PenFace[], ink: number, fromU: number, fromV: number, toU: number, toV: number, radius: number): void {
    const steps = Math.max(1, Math.ceil(hypot2(toU - fromU, toV - fromV) / (radius * PUFF_STEP)));
    for (let k = 0; k <= steps; k++) this.dot(faces, ink, fromU + ((toU - fromU) * k) / steps, fromV + ((toV - fromV) * k) / steps, radius);
  }

  /** A stroke through each point of `points` ([u, v] pairs) in turn; closed back to the first when `closed`. */
  path(faces: readonly PenFace[], ink: number, points: readonly (readonly [number, number])[], radius: number, closed = false): void {
    const count = closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i++) {
      const [fromU, fromV] = points[i]!;
      const [toU, toV] = points[(i + 1) % points.length]!;
      this.stroke(faces, ink, fromU, fromV, toU, toV, radius);
    }
  }

  /** A ring of `radius` m round (u, v), drawn as a closed path of `segments` strokes `width` m wide. */
  ring(faces: readonly PenFace[], ink: number, u: number, v: number, radius: number, width: number, segments = 24): void {
    const points = Array.from({ length: segments }, (_, i): [number, number] => [u + Math.cos((i / segments) * Math.PI * 2) * radius, v + Math.sin((i / segments) * Math.PI * 2) * radius]);
    this.path(faces, ink, points, width, true);
  }
}
