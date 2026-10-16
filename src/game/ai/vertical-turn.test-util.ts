import * as THREE from "three";

/** The heading rate (rad/s) above which a car is judged spinning (the derby heat's spin bars). */
export const SPIN_RATE_BAR = 5;

const delta = new THREE.Quaternion();

/**
 * How far (rad) the world turned about the vertical going from orientation `from` to `to` (one step apart): the vertical part of
 * the rotation vector between them. A car pitched or rolled far off level (airborne, tumbling) has no heading in Euler angles:
 * its yaw angle swings 2-3 times the turn it truly makes about the vertical (a car nose-up at 70° read 7 rad/s on 3.7).
 */
export function verticalTurn(from: THREE.Quaternion, to: THREE.Quaternion): number {
  delta.copy(from).invert().premultiply(to);
  if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
  const vectorLength = Math.hypot(delta.x, delta.y, delta.z);
  if (vectorLength < 1e-12) return 0;
  return (2 * Math.atan2(vectorLength, delta.w) * delta.y) / vectorLength;
}
