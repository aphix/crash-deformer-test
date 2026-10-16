import { detAtan2 } from "../kernel/physics-core.js";
import { wrapPi } from "../kernel/scalar.ts";
import { blankPoint, blankProjection, projectPath, type Track } from "./track.ts";

/**
 * Where one shortcut leaves the main loop and where it rejoins it: the arc length (m) of each along the loop, the shortcut's
 * heading (rad, `atan2(x, z)`, +Z at 0, + toward the left of travel) on its first and last segment, and the turn (rad, + left) a driver
 * makes at each: from the loop's heading onto the shortcut at the mouth, from the shortcut's end heading onto the loop's at the rejoin.
 */
type Junction = { mouthS: number; exitS: number; mouthYaw: number; exitYaw: number; mouthTurn: number; exitTurn: number };

/** The `Junction` of every shortcut of `track`, in `track.shortcuts` order. Read by the race AI (how hard to brake for it) and the chevron signs. */
export function junctionsOf(track: Track): Junction[] {
  const proj = blankProjection();
  const pt = blankPoint();
  return track.shortcuts.map((shortcut) => {
    const path = shortcut.path;
    const last = path.count - 1;
    const mouthS = projectPath(track.path, path.x[0]!, path.z[0]!, -1, proj).s;
    const exitS = projectPath(track.path, path.x[last]!, path.z[last]!, -1, proj).s;
    const mouthYaw = detAtan2(path.x[1]! - path.x[0]!, path.z[1]! - path.z[0]!);
    const exitYaw = detAtan2(path.x[last]! - path.x[last - 1]!, path.z[last]! - path.z[last - 1]!);
    const onMouth = track.pointAt(mouthS, pt);
    const mouthTurn = wrapPi(mouthYaw - detAtan2(onMouth.tx, onMouth.tz));
    const onExit = track.pointAt(exitS, pt);
    const exitTurn = wrapPi(detAtan2(onExit.tx, onExit.tz) - exitYaw);
    return { mouthS, exitS, mouthYaw, exitYaw, mouthTurn, exitTurn };
  });
}
