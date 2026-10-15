import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { placeProps, propColliders } from "./placements.ts";
import { LAUNCH_SPEED, rimReach, type Launch } from "./survival-rim.test-util.ts";
import { Track } from "./track.ts";
import { HAVANA } from "./tracks/havana.ts";

/**
 * Survival is a closed city (docs/SURVIVAL.md): there is nowhere to run to. The pack's side, that it catches a player who keeps running,
 * is `survival-pursuit.ai-long-run.ts` (pursuit in the closed arena) and `survival-bust.ai-long-run.ts` (the bust of a cornered player); that a player
 * who keeps running stays on the map is `survival-chase.ai-long-run.ts`'s. All three are the full-sanity suite's (`npm run test:ai-long-run`).
 */

const track = new Track(HAVANA);
/** The rim: the course file's own stucco blocks (the explicit props), one row on each side, edge to edge. */
const RIM = track.json.props.filter((p) => p.prefab === "stucco");

describe("given Havana's Survival course, a closed city with a ring of stucco blocks round it", () => {
  it("when a car-sized disc spreads from the player's start through the course's solids, then it cannot reach the edge of the world", (t) => {
    const placed = placeProps(track);
    // A car-sized disc drives under what starts over a car's roofline (1.36 m) above its prop's foot: a palm's crown.
    const solids = propColliders(placed).filter((c) => c.body === "solid" && c.base - placed[c.index]!.y < 1.38);
    const half = 1.1;
    const b = track.bounds;
    const x0 = Math.floor(b.minX - 40);
    const z0 = Math.floor(b.minZ - 40);
    const nx = Math.ceil(b.maxX + 40 - x0);
    const nz = Math.ceil(b.maxZ + 40 - z0);
    const blocked = (x: number, z: number): boolean => {
      for (const c of solids) {
        const ex = x - c.x;
        const ez = z - c.z;
        if (ex * ex + ez * ez > (c.r + half) ** 2) continue;
        if (c.kind === "circle") return true;
        const cos = Math.cos(c.yaw);
        const sin = Math.sin(c.yaw);
        if (Math.abs(ex * cos - ez * sin) < c.hx + half && Math.abs(ex * sin + ez * cos) < c.hz + half) return true;
      }
      return false;
    };
    const seen = new Uint8Array(nx * nz);
    const start = track.survival!.start;
    const queue: number[] = [Math.round(start.z - z0) * nx + Math.round(start.x - x0)];
    seen[queue[0]!] = 1;
    let edge = 0;
    for (let q = 0; q < queue.length; q++) {
      const c = queue[q]!;
      const i = c % nx;
      const j = (c - i) / nx;
      if (i === 0 || j === 0 || i === nx - 1 || j === nz - 1) edge++;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const u = i + di;
        const v = j + dj;
        if (u < 0 || v < 0 || u >= nx || v >= nz || seen[v * nx + u]) continue;
        seen[v * nx + u] = 1;
        if (!blocked(x0 + u, z0 + v)) queue.push(v * nx + u);
      }
    }
    t.diagnostic(`${queue.length} cells reachable from the start; ${edge} on the edge of the ${nx} x ${nz} m window`);
    assert.equal(edge, 0, `a car can drive from the start to the edge of the world (${edge} edge cells reached)`);
  });

  it("when a car at 60 m/s is aimed at a seam between two rim blocks, at a block's centre or at a corner, then it is stopped, so the rim has no gap", (t) => {
    const xs = RIM.map((p) => p.x);
    const zs = RIM.map((p) => p.z);
    // The blocks' inner faces (a block is 12 m, so its face is 6 m in from its centre).
    const east = Math.max(...xs) - 6;
    const south = Math.min(...zs) + 6;
    const north = Math.max(...zs) - 6;
    /** How far the car's centre is outside the faces (m): positive = through the rim. */
    const past = (x: number, z: number): number => Math.max(Math.abs(x) - east, south - z, z - north);
    /** The row of one side: where the blocks stand along it, sorted. */
    const row = (pick: (p: (typeof RIM)[number]) => boolean, along: "x" | "z"): number[] => RIM.filter(pick).map((p) => p[along]).sort((a, b) => a - b);
    const RUN = 45;
    const launches: Launch[] = [];
    const sides = [
      { name: "south", along: row((p) => p.z === Math.min(...zs), "x"), at: (a: number): Launch => ({ name: "", x: a, z: south + RUN, yaw: Math.PI }) },
      { name: "north", along: row((p) => p.z === Math.max(...zs), "x"), at: (a: number): Launch => ({ name: "", x: a, z: north - RUN, yaw: 0 }) },
      { name: "west", along: row((p) => p.x === Math.min(...xs), "z"), at: (a: number): Launch => ({ name: "", x: -east + RUN, z: a, yaw: -Math.PI / 2 }) },
      { name: "east", along: row((p) => p.x === Math.max(...xs), "z"), at: (a: number): Launch => ({ name: "", x: east - RUN, z: a, yaw: Math.PI / 2 }) },
    ];
    for (const s of sides) {
      const n = s.along.length;
      // Seams: between block k and k + 1, away from the corners (a launch has room to run in only from inside the streets).
      for (const [label, at] of [["first seam", (s.along[1]! + s.along[2]!) / 2], ["middle seam", (s.along[n >> 1]! + s.along[(n >> 1) + 1]!) / 2], ["last seam", (s.along[n - 3]! + s.along[n - 2]!) / 2], ["a block centre", s.along[(n / 3) | 0]!]] as const) {
        launches.push({ ...s.at(at), name: `${s.name} ${label}` });
      }
    }
    for (const [x, z, yaw, name] of [[east - RUN, south + RUN, (3 * Math.PI) / 4, "south-east"], [RUN - east, south + RUN, (-3 * Math.PI) / 4, "south-west"], [east - RUN, north - RUN, Math.PI / 4, "north-east"], [RUN - east, north - RUN, -Math.PI / 4, "north-west"]] as const) {
      launches.push({ name: `${name} corner`, x, z, yaw });
    }
    const reach = rimReach("havana", launches, past);
    const deepest = Math.max(...reach.map((r) => r.far));
    for (const r of reach) assert.ok(r.far < 0, `${r.name}: the car got ${r.far.toFixed(1)} m through the rim`);
    t.diagnostic(`${launches.length} launches at ${LAUNCH_SPEED} m/s; the car that got furthest stopped ${(-deepest).toFixed(1)} m inside the blocks' inner faces`);
  });
});
