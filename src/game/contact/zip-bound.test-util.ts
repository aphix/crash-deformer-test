const ZIP_SPEED_SPAN = 3;
const ZIP_SKIN = 0.05;

/** The most (m) a car's centroid may move in one physics step of `step` s at the fastest speed it or a car that touched it had (m/s): a move past it is a zip, a teleport of centimetres. */
export function zipBound(fastestSpeed: number, step: number): number {
  return ZIP_SPEED_SPAN * fastestSpeed * step + ZIP_SKIN;
}
