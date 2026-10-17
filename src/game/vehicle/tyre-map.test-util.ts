import type * as THREE from "three";
import { TYRE_MAP_HEIGHT, TYRE_MAP_WIDTH } from "./car-materials.ts";

/** A texel whose normal leans less than this (the sine of its tilt) from (0, 0, 1) is flat: one 8-bit step is 0.004. */
export const FLAT_DEVIATION = 0.01;
/** The weakest sidewall relief that shows: about 6 degrees of tilt. */
export const SIDEWALL_RELIEF_MIN = 0.1;
export const BYTES_PER_TEXEL = 4;

export const mapBytes = (texture: THREE.DataTexture): Uint8Array => texture.image.data as Uint8Array;

/** The decoded normal of one texel. */
export function normalAt(bytes: Uint8Array, column: number, row: number): [number, number, number] {
  const at = (row * TYRE_MAP_WIDTH + column) * BYTES_PER_TEXEL;
  return [(bytes[at]! / 255) * 2 - 1, (bytes[at + 1]! / 255) * 2 - 1, (bytes[at + 2]! / 255) * 2 - 1];
}

/** The sine of the tilt of the texel's normal from (0, 0, 1). */
export function deviationAt(bytes: Uint8Array, column: number, row: number): number {
  const [x, y] = normalAt(bytes, column, row);
  return Math.hypot(x, y);
}

/** The strongest tilt over a block of rows, all columns. */
export function strongestDeviation(bytes: Uint8Array, firstRow: number, lastRow: number): number {
  let strongest = 0;
  for (let row = firstRow; row <= lastRow; row++) {
    for (let column = 0; column < TYRE_MAP_WIDTH; column++) strongest = Math.max(strongest, deviationAt(bytes, column, row));
  }
  return strongest;
}

/** The strongest tilt over every texel a linear fetch at `v` blends: the two rows whose centres straddle it (clamped to the map). */
export function strongestDeviationSampledAt(bytes: Uint8Array, v: number): number {
  const lowerRow = Math.floor(v * TYRE_MAP_HEIGHT - 0.5);
  return strongestDeviation(bytes, Math.max(0, lowerRow), Math.min(TYRE_MAP_HEIGHT - 1, lowerRow + 1));
}
