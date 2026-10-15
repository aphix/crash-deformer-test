import * as THREE from "three";
import type { PropCollider } from "../world/placements.ts";
import { blankProjection, projectPath, type Track } from "../world/track.ts";
import { levelAt } from "../world/track-sections.ts";
import { CINE } from "./spectate-cam.ts";

/**
 * Oracle for the trackside eye, independent of `solid`: the cars' own collision footprints (props, `propContact`), each piece over its own
 * heights, the wall's 0.6 m body on the wall line (`wallColliders`' pieces), and the ground.
 */
function blocked(track: Track, cols: readonly PropCollider[], x: number, y: number, z: number): string | null {
  const ground = track.ground();
  if (y <= ground.heightAt(x, z, y)) return "under the ground";
  for (const c of cols) {
    if (y < c.base || y > c.top) continue;
    const ex = x - c.x;
    const ez = z - c.z;
    const cos = Math.cos(c.yaw);
    const sin = Math.sin(c.yaw);
    const inside = c.kind === "circle" ? ex * ex + ez * ez < c.r * c.r : Math.abs(ex * cos - ez * sin) < c.hx && Math.abs(ex * sin + ez * cos) < c.hz;
    if (inside) return `in ${c.prefab} #${c.index}`;
  }
  const path = track.path;
  const pr = projectPath(path, x, z, -1, blankProjection());
  const left = pr.lateral > 0;
  const over = Math.abs(pr.lateral) - path.half[pr.k]! - (left ? path.runL[pr.k]! : path.runR[pr.k]!);
  if ((left ? path.wallL[pr.k] : path.wallR[pr.k]) && over > 0 && over < 0.6 && y < levelAt(path, pr.k, pr.lateral) + track.json.road.wallHeight) return "in the wall";
  return null;
}

/** What the oracle finds wrong with a camera at `e` filming the car at `p`: inside a solid, a blocked sight line (10 cm steps up to the car's `stop` margin), or a solid within 1.9 m flat (a spot may stand beside a bank, so not the ground). */
export function eyeProblems(track: Track, cols: readonly PropCollider[], e: THREE.Vector3, p: THREE.Vector3): string[] {
  const bad: string[] = [];
  const at = blocked(track, cols, e.x, e.y, e.z);
  if (at) bad.push(`eye (${e.x.toFixed(1)}, ${e.y.toFixed(1)}, ${e.z.toFixed(1)}) ${at}`);
  const len = e.distanceTo(p);
  for (let d = 0.1; d < len - CINE.stop; d += 0.1) {
    const f = d / len;
    const why = blocked(track, cols, e.x + (p.x - e.x) * f, e.y + (p.y + CINE.aimUp - e.y) * f, e.z + (p.z - e.z) * f);
    if (why) {
      bad.push(`sight line ${why} at ${d.toFixed(1)} m of ${len.toFixed(1)}`);
      break;
    }
  }
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6;
    const why = blocked(track, cols, e.x + 1.9 * Math.cos(a), e.y, e.z + 1.9 * Math.sin(a));
    if (why && why !== "under the ground") bad.push(`${why} within 1.9 m of the eye`);
  }
  return bad;
}
