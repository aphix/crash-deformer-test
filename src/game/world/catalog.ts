/**
 * Data tables the track JSON refers to by id. Pure: no THREE, no DOM.
 * `prefabs.ts` builds the meshes and must cover every `PrefabId`.
 */
import { hypot2, detSin, detCos } from "../kernel/physics-core.js";
import { SURFACE } from "./constants.ts";

export const SURFACE_IDS = [SURFACE.asphalt, SURFACE.concrete, SURFACE.cobble, SURFACE.dirt, SURFACE.gravel, SURFACE.grass, SURFACE.sand] as const;
export type SurfaceId = (typeof SURFACE_IDS)[number];

export type Surface = {
  /** Steering authority and crashed-slide μ multiplier (1 = dry asphalt). */
  grip: number;
  /** Top-speed fraction while on it. */
  speed: number;
  /** Ground colour (sRGB hex) for the road / terrain mesh. */
  color: number;
};

export const SURFACES: Record<SurfaceId, Surface> = {
  asphalt: { grip: 1, speed: 1, color: 0x2b2d33 },
  concrete: { grip: 1, speed: 1, color: 0x8d8a84 },
  cobble: { grip: 0.85, speed: 0.92, color: 0x5d5a56 },
  dirt: { grip: 0.72, speed: 0.84, color: 0x6e5640 },
  gravel: { grip: 0.62, speed: 0.72, color: 0x8a7d68 },
  grass: { grip: 0.5, speed: 0.6, color: 0x3f5a34 },
  sand: { grip: 0.45, speed: 0.5, color: 0xc2ad84 },
};

export const PREFAB_IDS = [
  "cone",
  "tyre-stack",
  "hay-bale",
  "crate",
  "barrier-block",
  "rock",
  "tree",
  "building",
  "grandstand",
  "billboard",
  "lamp",
  "gantry",
  "monument",
  "stucco",
  "palm",
  "wall",
  "dumpster",
] as const;
export type PrefabId = (typeof PREFAB_IDS)[number];

/**
 * One solid of a prefab (metres at scale 1, +Z forward at yaw 0): a circle (`r`) or a box (`hx`, `hz`) about (`x`, `z`) (0 when
 * omitted), from `y0` (0) up to `y1` (the prefab's height). A box may be turned `yaw` (0) about its own centre, added to the
 * placement's: only on a solid prefab placed at one scale in plan (`sx` = `sz`). A placement scales plan by `sx`, `sz` and height by `sy`.
 */
type Collider = ({ kind: "circle"; r: number } | { kind: "box"; hx: number; hz: number; yaw?: number }) & { x?: number; z?: number; y0?: number; y1?: number };

/** A star plan's valley radius over its tip radius: the one number `present/prefabs.ts`'s `star` draws and `starPlan` bounds. */
export const STAR_INNER = 0.45;
/** Slices per metre of tip radius `starPlan` cuts each arm's tip triangle into: each stands off the drawn taper by half its width step (0.077 m worst measured). */
const STAR_SLICES = 1.5;

/**
 * A five-pointed star prism (tip radius `r`, one tip toward +z, as `present/prefabs.ts` draws it) from `y0` to `y1` as boxes, per
 * arm: one over the arm's share of the core (out to the line between the two valleys beside it), then the tip triangle in
 * `STAR_SLICES` per metre of `r` pieces along the arm, each as wide as the triangle is at its middle (as far under it at its near end as over it at its far end).
 */
function starPlan(r: number, y0: number, y1: number): Collider[] {
  const slices = Math.ceil(r * STAR_SLICES);
  const valley = r * STAR_INNER;
  const reach = valley * detCos(Math.PI / 5);
  const half = valley * detSin(Math.PI / 5);
  const out: Collider[] = [];
  for (let a = 0; a < 5; a++) {
    const yaw = (a * 2 * Math.PI) / 5;
    for (let i = -1; i < slices; i++) {
      const from = i < 0 ? 0 : reach + ((r - reach) * i) / slices;
      const to = i < 0 ? reach : reach + ((r - reach) * (i + 1)) / slices;
      const mid = (from + to) / 2;
      out.push({ kind: "box", hx: i < 0 ? half : (half * (r - mid)) / (r - reach), hz: (to - from) / 2, x: detSin(yaw) * mid, z: detCos(yaw) * mid, yaw, y0, y1 });
    }
  }
  return out;
}

type PrefabSpec = {
  /**
   * solid: immovable, cars are pushed out (walls, rocks, buildings).
   * knock: flies off when hit and costs the car `mass`-weighted speed (cones, bales).
   * none: scenery only.
   */
  body: "solid" | "knock" | "none";
  /**
   * What a car, a dummy and a knocked prop meet: the union of the drawn pieces, each piece's plan bound over its own heights
   * (`world/collider-drawn.test.ts` holds every one to the drawn geometry). The first is the main piece (a trunk, a body);
   * a placement's pieces share its index, so a knock prop is knocked as one. None for scenery.
   */
  collider: readonly Collider[];
  /** Clearance (m at scale 1) the placement keeps from other roads and from the road's edge: kept apart from `collider` so a tighter collider never moves the course's props. */
  foot: number;
  /** Default size [w, h, d] (m); a placement's `size` overrides it. */
  size: [number, number, number];
  /** kg, for knock bodies. */
  mass: number;
  /** Share of a hit's crush energy the struck car takes (`ContactBox.hardness`): 1 when omitted, a rigid solid; `SOFT_WOOD` for a trunk that gives. */
  hardness?: number;
};

/**
 * Hardness of a living trunk (a tree, a palm): the share of the reduced-mass energy the car takes, the piston rig's calibrated
 * soft value (`scenes/piston-rig.test.ts`: the honeycomb at 0.5) taken because the palm-tree note (`.extraResearch/perplexity/
 * 2026-10-07-palm-tree-offcentre-impact.md`) gives no figure: it calls palms stiff fixed hazards that crack or snap at high energy,
 * the owner's rule is that wood damps more than metal and still crushes the car at speed.
 */
const SOFT_WOOD = 0.5;

/** Half the 0.44 m footing (m) the `wall` prefab's 0.4 m wall stands on. */
const WALL_FOOTING_HALF = 0.22;

export const PREFABS: Record<PrefabId, PrefabSpec> = {
  cone: {
    body: "knock",
    collider: [
      { kind: "circle", r: 0.165, y0: 0.04, y1: 0.37 },
      { kind: "circle", r: 0.101, y0: 0.37, y1: 0.7 },
      { kind: "box", hx: 0.2, hz: 0.2, y1: 0.04 },
    ],
    foot: 0.28,
    size: [0.4, 0.7, 0.4],
    mass: 4,
  },
  "tyre-stack": { body: "knock", collider: [{ kind: "circle", r: 0.375 }], foot: 0.4, size: [0.75, 1, 0.75], mass: 60 },
  "hay-bale": { body: "knock", collider: [{ kind: "box", hx: 0.6, hz: 0.45 }], foot: 0.75, size: [1.2, 0.9, 0.9], mass: 180 },
  crate: { body: "knock", collider: [{ kind: "box", hx: 0.5, hz: 0.5 }], foot: Math.SQRT1_2, size: [1, 1, 1], mass: 30 },
  "barrier-block": {
    body: "solid",
    collider: [
      { kind: "box", hx: 0.32, hz: 1, y1: 0.33 },
      { kind: "box", hx: 0.226, hz: 1, y0: 0.33, y1: 0.55 },
      { kind: "box", hx: 0.158, hz: 1, y0: 0.55 },
    ],
    foot: hypot2(0.32, 1),
    size: [0.64, 0.81, 2],
    mass: 0,
  },
  // An icosphere dome with its foot 0.25 m under the ground: four rings, each as wide as the dome at its foot.
  rock: {
    body: "solid",
    collider: [
      { kind: "circle", r: 1.22, y1: 0.5 },
      { kind: "circle", r: 1.26, y0: 0.5, y1: 1.1 },
      { kind: "circle", r: 1.1, y0: 1.1, y1: 1.3 },
      { kind: "circle", r: 0.9, y0: 1.3 },
    ],
    foot: 1.1,
    size: [2.4, 1.6, 2.2],
    mass: 0,
  },
  tree: {
    body: "solid",
    // The trunk, then the crown's two hexagonal cones (6 sides, circumradius 1.6 and 1.05) in steps from the wide foot of the
    // first up: each step's circle is halfway between its cone's corners at the step's foot and its flats at the step's top, so it
    // stands as far inside the corners as off the flats (the top step, above the car's reach, round the second cone's corners).
    collider: [
      { kind: "circle", r: 0.24, y1: 1.4 },
      { kind: "circle", r: 1.383, y0: 1.4, y1: 2 },
      { kind: "circle", r: 1.128, y0: 2, y1: 2.7 },
      { kind: "circle", r: 1.05, y0: 2.7, y1: 7 },
    ],
    foot: 0.35,
    size: [3.2, 7, 3.2],
    mass: 0,
    hardness: SOFT_WOOD,
  },
  building: { body: "solid", collider: [{ kind: "box", hx: 5.95, hz: 5.95 }], foot: hypot2(6, 6), size: [12, 14, 12], mass: 0 },
  grandstand: {
    body: "solid",
    collider: [
      // The five terraces, each a step and the row of seats on it, front (+x) to back; the back wall, the roof and the four front posts.
      ...[0, 1, 2, 3, 4].flatMap((i): Collider[] => {
        const top = 0.6 + 0.8 * i;
        const x = 3.5 - (i + 0.5) * 1.2;
        return [
          { kind: "box", hx: 0.6, hz: 14.8, x, y1: top },
          { kind: "box", hx: 0.225, hz: 14.5, x: x - 0.25, y0: top, y1: top + 0.4 },
        ];
      }),
      { kind: "box", hx: 0.5, hz: 15, x: -3, y1: 5.75 },
      { kind: "box", hx: 3.05, hz: 15, x: -0.45, y0: 5.75, y1: 6 },
      ...[-14, -4.7, 4.7, 14].map((z): Collider => ({ kind: "box", hx: 0.1, hz: 0.1, x: 2.4, z, y0: 0.6, y1: 5.75 })),
    ],
    foot: hypot2(3.5, 15),
    size: [7, 6, 30],
    mass: 0,
  },
  billboard: {
    body: "solid",
    // The two posts and the panel on them: a car goes between the posts and under the panel.
    collider: [
      { kind: "box", hx: 0.075, hz: 0.075, z: -2.2, y1: 2.1 },
      { kind: "box", hx: 0.075, hz: 0.075, z: 2.2, y1: 2.1 },
      { kind: "box", hx: 0.15, hz: 3, y0: 2, y1: 4.5 },
    ],
    foot: hypot2(0.2, 3),
    size: [0.4, 4.5, 6],
    mass: 0,
  },
  lamp: {
    body: "solid",
    collider: [
      { kind: "circle", r: 0.085 },
      { kind: "box", hx: 0.093, hz: 0.212, x: 0.127, y0: 4.315 },
    ],
    foot: 0.14,
    size: [0.3, 4.4, 0.3],
    mass: 0,
  },
  gantry: { body: "none", collider: [], foot: 0, size: [1, 6, 1], mass: 0 },
  // The Havana course: a stepped star-plan tower, pastel flat-roofed blocks (the building's shape), palms, stucco walls (long axis +Z), a dumpster (long axis +X).
  monument: {
    body: "solid",
    // The star-plan steps (`starPlan`: boxes per arm stepped down its taper, more where the arm is longer), then the five-sided spire as three circles round its vertices.
    collider: [
      ...starPlan(6.2, 0, 1.4),
      ...starPlan(5.7, 1.4, 4.2),
      ...starPlan(5.1, 4.2, 9),
      ...starPlan(4.5, 9, 15),
      ...starPlan(3.9, 15, 22),
      ...starPlan(3.3, 22, 30),
      ...starPlan(2.8, 30, 38),
      ...starPlan(2.3, 38, 45),
      ...starPlan(1.8, 45, 50),
      { kind: "circle", r: 0.8, y0: 50, y1: 51.5 },
      { kind: "circle", r: 0.56, y0: 51.5, y1: 53.2 },
      { kind: "circle", r: 0.29, y0: 53.2 },
    ],
    foot: 5.8,
    size: [13, 55, 13],
    mass: 0,
  },
  stucco: { body: "solid", collider: [{ kind: "box", hx: 5.95, hz: 5.95 }], foot: hypot2(6, 6), size: [12, 14, 12], mass: 0 },
  palm: {
    body: "solid",
    // The leaning trunk (lean 0.08 rad: its axis moves 0.08 m east per metre up, 0.27 m wide at the foot, 0.15 m at the top) as three drums
    // each bounding its slice, then the crown of fronds, a disc round the trunk's top reaching 3.09 m.
    collider: [
      { kind: "circle", r: 0.36, x: 0.089, y1: 2.72 },
      { kind: "circle", r: 0.32, x: 0.307, y0: 2.72, y1: 5.45 },
      { kind: "circle", r: 0.23, x: 0.47, y0: 5.45, y1: 6.5 },
      { kind: "circle", r: 3.1, x: 0.655, y0: 6.49, y1: 8.2 },
    ],
    foot: 0.3,
    size: [4.4, 8.5, 4.4],
    mass: 0,
    hardness: SOFT_WOOD,
  },
  wall: {
    body: "solid",
    // The 0.44 m footing and the 0.4 m wall on it, then the 0.6 m cap.
    collider: [
      { kind: "box", hx: WALL_FOOTING_HALF, hz: 5.01, y1: 3 },
      { kind: "box", hx: 0.3, hz: 5, y0: 3, y1: 3.2 },
    ],
    foot: hypot2(0.3, 5),
    size: [0.6, 3.2, 10],
    mass: 0,
  },
  dumpster: { body: "solid", collider: [{ kind: "box", hx: 1, hz: 0.62 }], foot: hypot2(1, 0.62), size: [2, 1.4, 1.25], mass: 0 },
};
