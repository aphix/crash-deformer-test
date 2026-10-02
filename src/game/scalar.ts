/** Scalar helpers every context shares (kernel: no imports, no state). */

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
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Deterministic 0..1 per (id, k): the shader-style sin hash the AIs roll their dice with. */
export function hash01(id: number, k: number): number {
  const x = Math.sin(id * 127.1 + k * 311.7 + 17.13) * 43758.5453;
  return x - Math.floor(x);
}
