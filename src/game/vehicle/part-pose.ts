import { detCos, detSin } from "../kernel/physics-core.js";
import type { DetachPart } from "./car-core.ts";
import { LIGHT_BAR_FOOT } from "./car-materials.ts";

/** The light bar's tilt on its far mount at full load (rad). */
const BAR_ROLL = 0.5;

/**
 * Where a hinged lid (`cowl` hood, `tail` boot) or the light bar (`bar`, tilting on its far mount, the struck side dropping with `inwardX`'s
 * sign) stands at hinge value `t = p.hingeT` (from rest, which turns nothing): position x, y, z then quaternion x, y, z, w into `out` at `o`.
 * The one pose the drawn mesh (`CarParts.posePart`) and the car's cage (`CageRig`) both take, from the part's state alone.
 */
export function hingePose(p: DetachPart, inwardX: number, out: Float64Array, o: number): void {
  const t = p.hingeT;
  let x = p.restPos.x;
  let y = p.restPos.y;
  let z = p.restPos.z;
  const bar = p.hinge === "bar";
  let turn: number;
  if (p.hinge === "cowl") {
    z -= t * 0.08;
    y += t * 0.26;
    turn = -t * 0.5;
  } else if (p.hinge === "tail") {
    z += t * 0.08;
    y += t * 0.22;
    turn = t * 0.5;
  } else {
    const dir = inwardX < 0 ? -1 : 1;
    turn = dir * t * BAR_ROLL;
    const px = dir * LIGHT_BAR_FOOT.x;
    x += px * (1 - detCos(turn));
    y -= px * detSin(turn);
  }
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = z;
  // The lids turn about x, the bar about z.
  out[o + 3] = bar ? 0 : detSin(turn / 2);
  out[o + 4] = 0;
  out[o + 5] = bar ? detSin(turn / 2) : 0;
  out[o + 6] = detCos(turn / 2);
}

/** The masses the cabin interior is placed by (`interiorPose`'s `lx`/`rx`, then `cy`/`cz`). */
export const INTERIOR_MASSES = ["doorL", "doorR", "cell"] as const;

/**
 * Where the interior mesh stands once the cabin is crushed, from the door masses' x (`lx`, `rx`) and the cell mass's y and z (`cy`,
 * `cz`), as its x scale then its x, y, z position into `out`. The one placement the drawn mesh (`CarParts.fitInterior`) and the
 * car's cage (`CageRig`: the interior is what shows through a gone pane) both take.
 */
export function interiorPose(lx: number, rx: number, cy: number, cz: number, out: Float64Array): void {
  out[0] = Math.max(0.32, Math.min(1, Math.max(0.35, rx - lx) / 1.56));
  out[1] = (lx + rx) * 0.5;
  out[2] = Math.max(-0.08, Math.min(0.1, cy - 0.55));
  out[3] = cz * 0.35;
}
