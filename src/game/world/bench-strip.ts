import type { PrefabId } from "./catalog.ts";

/** One kind of static prop along the strip's left, `count` copies spread evenly over the straight. */
export interface StripProp {
  prefab: PrefabId;
  count: number;
}

/** What `?bench=strip` asks for (`benchPlan` in `engine/engine-bench-plan.ts`). */
export interface StripSpec {
  /** The straight's length (m): out to the far U-turn. */
  length: number;
  /** Props along the race lane's left, one row per kind; none: off. */
  props: StripProp[];
  /** NPC cars on their own road beside the lane, on the right: `lanes` 1 (one direction) or 2 (one each way); null: off. */
  traffic: { lanes: 1 | 2; count: number } | null;
}

/** The loop's turn radius (m) and the road + runoff half width where the race lane's wall stands. */
const TURN_R = 130;
const WALL_X = 7 + 4;
/** A prop row sits this far outside the wall; each further kind a row beyond (buildings are 12 m wide). */
const PROP_OFFSET = 16;
const ROW_GAP = 14;

/**
 * The benchmark strip: one straight race lane that is always on, a row of static props along its left and a separate NPC
 * traffic road along its right, each switchable with its own counts. Bench only: it is built when `?bench=strip` asks and
 * handed to the race field (`RaceField.loadBenchCourse`), so it is in neither `TRACKS` (the race menu, the all-courses test
 * sweeps) nor `OFF_MENU`. The loop closes the way any course does: the racers run out the straight, turn at its far end
 * (a U-turn of radius 130 m) and come back down a return leg 260 m over, to the start line again. A bench window is sized
 * to end before the leader reaches the turn, so it measures the straight alone.
 */
export function stripCourse(spec: StripSpec): unknown {
  const L = spec.length;
  const R = TURN_R;
  const nodes: { x: number; z: number }[] = [];
  // Straight up x = 0 from the start line, a node every 400 m.
  for (let z = 0; z <= L + 1e-6; z += 400) nodes.push({ x: 0, z: Math.min(z, L) });
  if (nodes[nodes.length - 1]!.z < L) nodes.push({ x: 0, z: L });
  const endNode = nodes.length - 1;
  const round = (v: number): number => Math.round(v * 100) / 100;
  // The far U-turn to the left (+x), then the return leg down x = 2R.
  for (const deg of [150, 120, 90, 60, 30]) nodes.push({ x: round(R + R * Math.cos((deg * Math.PI) / 180)), z: round(L + R * Math.sin((deg * Math.PI) / 180)) });
  for (let z = L; z >= -300 - 1e-6; z -= 400) nodes.push({ x: 2 * R, z: Math.max(z, -300) });
  if (nodes[nodes.length - 1]!.z > -300) nodes.push({ x: 2 * R, z: -300 });
  // The near U-turn back to x = 0, then a 300 m straight into the start line (the grid sits there).
  for (const deg of [-30, -60, -90, -120, -150]) nodes.push({ x: round(R + R * Math.cos((deg * Math.PI) / 180)), z: round(-300 + R * Math.sin((deg * Math.PI) / 180)) });
  nodes.push({ x: 0, z: -300 }, { x: 0, z: -150 });
  const midUp = Math.floor(endNode / 2);
  const returnMid = nodes.findIndex((n) => n.x === 2 * R && n.z <= L / 2);
  const checkpoints = [{ node: 0 }, { node: midUp }, { node: endNode }, { node: returnMid }];

  const along = spec.props
    .filter((p) => p.count > 0)
    .map((p, row) => ({
      prefab: p.prefab,
      every: p.count > 1 ? L / (p.count - 1) : 2 * L,
      side: "left" as const,
      offset: PROP_OFFSET + row * ROW_GAP,
      scale: 1,
      fromNode: 0,
      toNode: endNode,
    }));

  const routes: unknown[] = [];
  const t = spec.traffic;
  if (t && t.count > 0) {
    // 12 m outside the race lane's wall, so no car meets the other road's cars.
    const x = -(WALL_X + 12 + 4.5);
    routes.push({
      id: "bench-road",
      path: [
        { x, z: -400 },
        { x, z: L / 2 },
        { x, z: L + 400 },
      ],
      width: 9,
      count: Math.min(16, t.count),
      lanes: t.lanes === 2 ? [{ offset: -2.3, dir: 1 }, { offset: 2.3, dir: -1 }] : [{ offset: 0, dir: 1 }],
    });
  }

  return {
    id: "bench",
    name: "Bench strip",
    blurb: "Benchmark: a straight lane, a props row and a traffic road.",
    laps: 1,
    road: { width: 14, surface: "asphalt", runoff: [4, 4], runoffSurface: "grass", wall: [true, true], wallHeight: 1.1 },
    nodes,
    checkpoints,
    grid: { perRow: 2, spacing: 9, back: 8 },
    props: [],
    along,
    scatter: [],
    traffic: { count: 0, speed: 9, lanes: [], routes },
    environment: { sky: "#9db3c7", fog: 0.0028, terrain: "grass", hills: [] },
  };
}
