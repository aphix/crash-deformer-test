import { z } from "zod";
import { PREFAB_IDS, SURFACE_IDS } from "./catalog.ts";

/**
 * The track JSON format: the single source of truth for a course.
 * `parseTrack` validates and fills defaults; `docs/RACE_DESIGN.md` documents every field.
 */

const surface = z.enum(SURFACE_IDS);
const pair = z.tuple([z.number().min(0), z.number().min(0)]);

/** Omitted node fields inherit the previous node's value (node 0 takes `road`). */
const node = z.object({
  x: z.number(),
  z: z.number(),
  y: z.number().optional(),
  width: z.number().min(4).max(40).optional(),
  /** Degrees; > 0 raises the RIGHT edge (bank a left-hand turn's outside). Not inherited. */
  bank: z.number().min(-20).max(20).default(0),
  surface: surface.optional(),
  /** Runoff [left, right] (m) between road edge and wall. */
  runoff: pair.optional(),
  runoffSurface: surface.optional(),
  /** Wall present [left, right]; false opens the edge (shortcut mouths, side streets, open rally stages). */
  wall: z.tuple([z.boolean(), z.boolean()]).optional(),
  /** Bridge span from this node to the next: a deck at the road's own height, not stamped into the terrain, so another road can pass under it. */
  deck: z.boolean().optional(),
  /** Covered from this node to the next (drawn as a tunnel; no effect on driving). */
  tunnel: z.boolean().optional(),
});

const gateRef = z.object({ node: z.number().int().min(0), t: z.number().min(0).lt(1).default(0) });

const pathPoint = z.object({ x: z.number(), z: z.number(), y: z.number().optional() });

const shortcut = z.object({
  id: z.string().min(1),
  /** Main checkpoint the shortcut leaves after. */
  from: z.number().int().min(0),
  /** Main checkpoint it rejoins before (gates strictly between `from` and `to` are skipped). */
  to: z.number().int().min(0),
  width: z.number().min(3).max(20).default(7),
  surface: surface.default("dirt"),
  /** Open spline, entry first; a gate sits on every point. */
  path: z.array(pathPoint).min(2),
});

const lane = z.object({
  /** Lateral offset from the centreline (m, + = left of the path's direction). */
  offset: z.number(),
  /** +1 drives the path's direction, −1 against it. */
  dir: z.union([z.literal(1), z.literal(-1)]),
});

/** A side street for NPC traffic: it crosses or joins the race loop, so racers meet cross traffic. */
const route = z.object({
  id: z.string().min(1),
  /** Path points in order; an open street's ends should sit out of sight (cars despawn and respawn there). */
  path: z.array(pathPoint).min(2),
  loop: z.boolean().default(false),
  width: z.number().min(4).max(30).default(9),
  surface: surface.default("asphalt"),
  /** Cars on this street. */
  count: z.number().int().min(0).max(16),
  lanes: z.array(lane).min(1),
});

const placement = z.object({
  prefab: z.enum(PREFAB_IDS),
  x: z.number(),
  z: z.number(),
  /** Radians, prefab +Z forward. */
  yaw: z.number().default(0),
  scale: z.number().positive().default(1),
  size: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]).optional(),
});

const along = z.object({
  prefab: z.enum(PREFAB_IDS),
  /** Metres between copies along the centreline. */
  every: z.number().min(2),
  side: z.enum(["left", "right", "both"]).default("both"),
  /** Metres outside the wall line (road edge + runoff); negative = inside the runoff. */
  offset: z.number().default(1.5),
  fromNode: z.number().int().min(0).optional(),
  toNode: z.number().int().min(0).optional(),
  /** Repeat along this traffic route's centreline instead of the race loop (node range ignored). */
  route: z.string().optional(),
  scale: z.number().positive().default(1),
});

const scatter = z.object({
  prefab: z.enum(PREFAB_IDS),
  count: z.number().int().min(1).max(2000),
  /** Distance band from the wall line (m). */
  near: z.number().min(0).default(6),
  far: z.number().min(1).default(60),
  seed: z.number().int().default(1),
  scaleMin: z.number().positive().default(0.8),
  scaleMax: z.number().positive().default(1.25),
});

const hill = z.object({ x: z.number(), z: z.number(), radius: z.number().positive(), height: z.number() });

const TrackSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    blurb: z.string().default(""),
    /** Default lap count. */
    laps: z.number().int().min(1).max(9).default(3),
    road: z
      .object({
        width: z.number().min(4).max(40).default(14),
        surface: surface.default("asphalt"),
        runoff: pair.default([4, 4]),
        runoffSurface: surface.default("grass"),
        wall: z.tuple([z.boolean(), z.boolean()]).default([true, true]),
        wallHeight: z.number().positive().default(1.1),
      })
      .prefault({}),
    /** Closed loop in driving order. Node 0 is on the start/finish line. */
    nodes: z.array(node).min(4),
    /** Main gate chain in driving order; checkpoint 0 is the start/finish line at node 0. */
    checkpoints: z.array(gateRef).min(3),
    shortcuts: z.array(shortcut).default([]),
    grid: z
      .object({
        perRow: z.number().int().min(1).max(4).default(2),
        /** Row spacing (m). */
        spacing: z.number().min(5).default(8),
        /** Gap from the line to the front row (m). */
        back: z.number().min(2).default(6),
      })
      .prefault({}),
    props: z.array(placement).default([]),
    along: z.array(along).default([]),
    scatter: z.array(scatter).default([]),
    traffic: z
      .object({
        /** Cars on the race loop's own lanes. */
        count: z.number().int().min(0).max(16).default(0),
        /** Cruise speed (m/s). */
        speed: z.number().min(2).max(20).default(9),
        /** Race-loop lanes: offset from the centreline (m, + = left) and direction (+1 = race direction). */
        lanes: z.array(lane).default([]),
        /** Side streets with their own cars. */
        routes: z.array(route).default([]),
      })
      .optional(),
    environment: z
      .object({
        sky: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#12141a"),
        fog: z.number().min(0).max(0.05).default(0.0035),
        terrain: surface.default("grass"),
        hills: z.array(hill).default([]),
      })
      .prefault({}),
  })
  .superRefine((t, ctx) => {
    const n = t.nodes.length;
    const at = (g: { node: number; t: number }) => g.node + g.t;
    const c0 = t.checkpoints[0]!;
    if (c0.node !== 0 || c0.t !== 0) ctx.addIssue({ code: "custom", path: ["checkpoints", 0], message: "checkpoint 0 must be node 0, t 0" });
    t.checkpoints.forEach((g, i) => {
      if (g.node >= n) ctx.addIssue({ code: "custom", path: ["checkpoints", i, "node"], message: `node ${g.node} ≥ ${n} nodes` });
      if (i > 0 && at(g) <= at(t.checkpoints[i - 1]!)) {
        ctx.addIssue({ code: "custom", path: ["checkpoints", i], message: "checkpoints must run in driving order" });
      }
    });
    const m = t.checkpoints.length;
    const ids = new Set<string>();
    t.shortcuts.forEach((s, i) => {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["shortcuts", i, "id"], message: `duplicate id ${s.id}` });
      ids.add(s.id);
      if (s.from >= m || s.to >= m) ctx.addIssue({ code: "custom", path: ["shortcuts", i], message: "from/to must be checkpoint indices" });
      if ((s.to - s.from + m) % m < 2) {
        ctx.addIssue({ code: "custom", path: ["shortcuts", i], message: "a shortcut must skip at least one checkpoint" });
      }
      if (s.to !== 0 && s.to < s.from) {
        ctx.addIssue({ code: "custom", path: ["shortcuts", i], message: "a shortcut may not skip the start/finish line" });
      }
    });
    const tr = t.traffic;
    if (tr && tr.count > 0 && tr.lanes.length === 0) ctx.addIssue({ code: "custom", path: ["traffic", "lanes"], message: "loop traffic needs at least one lane" });
    const routeIds = new Set((tr?.routes ?? []).map((r) => r.id));
    t.along.forEach((a, i) => {
      if (a.route != null && !routeIds.has(a.route)) ctx.addIssue({ code: "custom", path: ["along", i, "route"], message: `no traffic route ${a.route}` });
    });
  });

/** Parsed track with defaults applied. */
export type TrackJson = z.output<typeof TrackSchema>;
/** What a hand-written track file may omit. */
export type TrackFile = z.input<typeof TrackSchema>;

/** Throws an Error listing every problem as `path: message`. */
export function parseTrack(json: unknown): TrackJson {
  const r = TrackSchema.safeParse(json);
  if (r.success) return r.data;
  const lines = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new Error(`invalid track: ${lines.join("; ")}`);
}
