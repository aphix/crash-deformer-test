import * as THREE from "three";

export const LAB_FOV = 60;

/**
 * The Lab's opening orbit, low over the bench at toy height through a wider lens (`LAB_FOV`, deg): the bench, the board and
 * the tools on it loom over the set. Upright screens look over the thrower's shoulder down the throw from `turn` rad off
 * straight behind (`toFocus`: the look point that far from the thrower to the set's middle), so the set runs up the screen's
 * length and leans across it: the bench's axis reads about 45° off the screen's up, so a swipe toward the targets and a swipe
 * straight up are two different throws, as they are on a wide screen; wide ones look across the bench from its front at the
 * set's middle, the thrower on the left, the targets on the right and the pegboard behind, from just far enough back that
 * every item of the set and `fit` m to spare fits the width, the look point `lift` m over the set so the set sits low on the
 * screen with the tools on the board above it, but never so high that the thrower sits more than `low` of the half height
 * below the middle (a dummy lying on the bench dropped under the dock and the set panel). A wide screen `shortPx` CSS px tall
 * or less (a phone on its side) has its dock and set panel along the bottom: there the look point is the set's own height, so
 * the thrower and the set sit mid-screen, clear of both.
 */
export const LAB_SHOT = {
  upright: { toFocus: 0.8, turn: 0.2, radius: 21, pitch: 0.22, lift: 0 },
  wide: { toFocus: 1, turn: Math.PI / 2, fit: 3.2, pitch: 0.12, lift: 3.5, low: 0.35, shortPx: 500 },
};

/**
 * Aims the orbit at `shot`: the point its camera looks at, into `look` (`shot.toFocus` of the way from the thrower to the set's
 * middle, `shot.lift` over it, 0 when `flat`), and the camera's bearing (rad, the orbit's angle): straight behind the thrower
 * looking at the set's middle, turned `shot.turn`.
 */
export function aimLabShot(thrower: THREE.Vector3, setMiddle: THREE.Vector3, shot: { toFocus: number; lift: number; turn: number }, flat: boolean, look: THREE.Vector3): number {
  look.lerpVectors(thrower, setMiddle, shot.toFocus).setY(setMiddle.y + (flat ? 0 : shot.lift));
  return Math.atan2(thrower.x - setMiddle.x, thrower.z - setMiddle.z) + shot.turn;
}
