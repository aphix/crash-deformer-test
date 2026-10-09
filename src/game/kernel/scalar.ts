import { detCos, detSin } from "./physics-core.js";

/** Scalar helpers every context shares (kernel: imports only physics-core; `once` memoizes a constant, nothing here holds state). */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Angle wrapped into [-π, π) by floor (not the atan2 form: the two differ in the last bits). */
export function wrapPi(a: number): number {
  return a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
}

/** Angle wrapped into (-π, π] by atan2 (the camera and piston-orbit form). */
export function wrapPiClosed(a: number): number {
  return Math.atan2(detSin(a), detCos(a));
}

/** Deterministic 0..1 per (id, k): the shader-style sin hash the AIs roll their dice with. */
export function hash01(id: number, k: number): number {
  const x = detSin(id * 127.1 + k * 311.7 + 17.13) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * `make()` on the first call, that same value after: a lazily built shared constant (a texture, a material, a
 * table) that never changes once made, so a second engine or a test sharing it inherits nothing.
 */
export function once<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}
