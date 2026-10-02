import type { TrackFile } from "./track-schema.ts";

/** The race and track suites' test course: an 8-node loop round a 120 × 160 m box, a checkpoint every other node. */
export const square = (extra: Partial<TrackFile> = {}): TrackFile => ({
  id: "square",
  name: "Square",
  road: { width: 10, runoff: [2, 2] },
  nodes: [
    { x: 0, z: 0 },
    { x: 0, z: 60 },
    { x: 0, z: 120 },
    { x: 60, z: 140 },
    { x: 120, z: 120 },
    { x: 120, z: 60 },
    { x: 120, z: 0 },
    { x: 60, z: -20 },
  ],
  checkpoints: [{ node: 0 }, { node: 2 }, { node: 4 }, { node: 6 }],
  ...extra,
});
