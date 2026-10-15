/**
 * Data tables the track JSON refers to by id. Pure: no THREE, no DOM.
 * `prefabs.ts` builds the meshes and must cover every `PrefabId`.
 */
import { hypot2, detSin, detCos } from "../kernel/physics-core.js";
import { PREFAB, SURFACE } from "./constants.ts";
import { brickCollider, bricksTop, CAPITOL, CAPITOL_POOL, CAPITOL_TOP, capitolPlan, capitolPool, FLAGPOLE, flagpolePlan, GARFIELD_MONUMENT, GRANT_MEMORIAL, PEACE_MONUMENT, type Brick, type Collider } from "./landmarks.ts";

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
  PREFAB.cone,
  PREFAB.tyreStack,
  PREFAB.hayBale,
  PREFAB.crate,
  PREFAB.barrierBlock,
  PREFAB.rock,
  PREFAB.tree,
  PREFAB.building,
  PREFAB.grandstand,
  PREFAB.billboard,
  PREFAB.lamp,
  PREFAB.gantry,
  PREFAB.monument,
  PREFAB.stucco,
  PREFAB.palm,
  PREFAB.wall,
  PREFAB.dumpster,
  PREFAB.obelisk,
  PREFAB.capitol,
  PREFAB.marble,
  PREFAB.whiteHouse,
  PREFAB.fountain,
  PREFAB.fence,
  PREFAB.pool,
  PREFAB.basin,
  PREFAB.lincoln,
  PREFAB.capitolPool,
  PREFAB.grantMemorial,
  PREFAB.peaceMonument,
  PREFAB.garfieldMonument,
  PREFAB.flagpole,
] as const;
export type PrefabId = (typeof PREFAB_IDS)[number];


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

/**
 * The Washington Monument (m): a square shaft of half side `foot` on the ground and `shoulder` at `shaft`, the pyramidion to `tip`.
 * The marble changes shade at `seam`, where building stopped for 23 years. `present/prefabs.ts` draws these, `obeliskPlan` bounds them.
 */
export const OBELISK = { foot: 8.4, shoulder: 5.25, seam: 46, shaft: 152, tip: 169 } as const;
/** Boxes the shaft above the seam is cut into, each as wide as the shaft at its foot. */
const OBELISK_SLICES = 5;

/** Half side (m) of the obelisk's shaft at height y. */
export function obeliskHalf(y: number): number {
  const { foot, shoulder, shaft } = OBELISK;
  return foot + ((shoulder - foot) * y) / shaft;
}

function obeliskPlan(): Collider[] {
  const { seam, shaft, tip, shoulder } = OBELISK;
  const cuts = [0, seam, ...Array.from({ length: OBELISK_SLICES }, (_, i) => seam + ((shaft - seam) * (i + 1)) / OBELISK_SLICES)];
  const out: Collider[] = cuts.slice(0, -1).map((y0, i) => ({ kind: "box", hx: obeliskHalf(y0), hz: obeliskHalf(y0), y0, y1: cuts[i + 1]! }));
  const mid = (shaft + tip) / 2;
  out.push({ kind: "box", hx: shoulder, hz: shoulder, y0: shaft, y1: mid }, { kind: "box", hx: shoulder / 2, hz: shoulder / 2, y0: mid, y1: tip });
  return out;
}

/** A box block of a building (m): half sizes, centre, foot and top. */
type Block = { hx: number; hz: number; x: number; z: number; y0: number; y1: number };

/** A plain marble block (m at scale 1): a footing course, the body, a projecting cornice, a parapet. Placements size it to a whole building. */
export const MARBLE = { footing: { half: 6.2, y1: 1 }, body: { half: 6, y1: 13 }, cornice: { half: 6.3, y1: 13.6 }, parapet: { half: 6, y1: 14 } } as const;

/** A round part (m): radius, centre, foot and top. */
type Drum = { r: number; x: number; z: number; y0: number; y1: number };

/** The South Portico's centre (m): the middle of the south front, where the oval rooms' bow stands out of the walls. */
const SOUTH_FRONT = 13;

/**
 * The White House at full size (m, −Z the north front, +Z the south): the walls on a ground course under a cornice and a roof
 * balustrade, a low hipped roof with four chimneys, the North Portico (a floor, 4 + 4 Ionic `northColumns`, an entablature and a
 * pediment), the South Portico (a bow, a terrace, a half ring of 6 columns, the Truman Balcony, an entablature and a balustrade),
 * the colonnades out to the West and East Wings, and the flag on the roof. `present/prefabs.ts` draws these, `whiteHousePlan` bounds them.
 */
export const WHITE_HOUSE = {
  footing: { hx: 25.8, hz: 13.3, x: 0, z: 0, y0: 0, y1: 1.2 },
  walls: { hx: 25.5, hz: SOUTH_FRONT, x: 0, z: 0, y0: 1.2, y1: 17 },
  cornice: { hx: 26, hz: 13.5, x: 0, z: 0, y0: 17, y1: 17.8 },
  balustrade: { hx: 25.5, hz: SOUTH_FRONT, x: 0, z: 0, y0: 17.8, y1: 18.9 },
  /** The hip roof: its eaves' half sides, and its flat top's share of them. */
  roof: { hx: 23.5, hz: 10.5, y0: 17.8, y1: 21.6, top: 0.4 },
  chimneys: [-9, 9].flatMap((x) => [-7.5, 7.5].map((z) => ({ hx: 0.7, hz: 1.5, x, z, y0: 19, y1: 23.2 }))),
  northFloor: { hx: 13.6, hz: 6.25, x: 0, z: -19.25, y0: 0, y1: 1.2 },
  northColumns: [
    ...[-9.6, -3.2, 3.2, 9.6].map((x) => ({ r: 0.65, x, z: -24.6, y0: 1.2, y1: 15.4 })),
    ...[-12.6, 12.6].flatMap((x) => [-20.4, -16.2].map((z) => ({ r: 0.65, x, z, y0: 1.2, y1: 15.4 }))),
  ] satisfies Drum[],
  northEntablature: { hx: 13.6, hz: 6.25, x: 0, z: -19.25, y0: 15.4, y1: 17 },
  /** The pediment over it: a gable as wide as the entablature, from its foot to its ridge. */
  pediment: { hx: 13.6, hz: 6.25, x: 0, z: -19.25, y0: 17, y1: 21 },
  bow: { r: 7.5, x: 0, z: SOUTH_FRONT, y0: 0, y1: 17 },
  southTerrace: { r: 12.4, x: 0, z: SOUTH_FRONT, y0: 0, y1: 1.2 },
  southColumns: [-75, -45, -15, 15, 45, 75].map((deg) => ({ r: 0.65, x: 11.2 * detSin((deg * Math.PI) / 180), z: SOUTH_FRONT + 11.2 * detCos((deg * Math.PI) / 180), y0: 1.2, y1: 15.4 })) satisfies Drum[],
  balcony: { r: 11.8, x: 0, z: SOUTH_FRONT, y0: 7.4, y1: 8.6 },
  southEntablature: { r: 12.2, x: 0, z: SOUTH_FRONT, y0: 15.4, y1: 17 },
  southBalustrade: { r: 11.8, x: 0, z: SOUTH_FRONT, y0: 17, y1: 18.2 },
  colonnades: [-43, 43].map((x) => ({ hx: 17.5, hz: 3.5, x, z: 7, y0: 0, y1: 5 })) satisfies Block[],
  wings: [-80.5, 80.5].map((x) => ({ hx: 20, hz: 16, x, z: 3, y0: 0, y1: 9 })) satisfies Block[],
  wingCornices: [-80.5, 80.5].map((x) => ({ hx: 20.4, hz: 16.4, x, z: 3, y0: 9, y1: 9.7 })) satisfies Block[],
  flag: { pole: { r: 0.12, x: 0, z: 0, y0: 21.6, y1: 31 }, fly: 4.2, drop: 2.4 },
} as const;

function whiteHousePlan(): Collider[] {
  const w = WHITE_HOUSE;
  const box = (b: Block): Collider => ({ kind: "box", ...b });
  const circle = (d: Drum): Collider => ({ kind: "circle", ...d });
  const { pole, fly, drop } = w.flag;
  return [
    ...[w.footing, w.walls, w.cornice, w.balustrade, w.northFloor, w.northEntablature, w.pediment].map(box),
    { kind: "box", hx: w.roof.hx, hz: w.roof.hz, y0: w.roof.y0, y1: w.roof.y1 },
    ...w.chimneys.map(box),
    ...w.northColumns.map(circle),
    ...[w.bow, w.southTerrace, w.balcony, w.southEntablature, w.southBalustrade, ...w.southColumns].map(circle),
    ...[...w.colonnades, ...w.wings, ...w.wingCornices].map(box),
    circle(pole),
    { kind: "box", hx: fly / 2, hz: 0.05, x: pole.r + fly / 2, y0: pole.y1 - drop, y1: pole.y1 },
  ];
}

/**
 * A reflecting pool (m at scale 1, stretched to its place by `size`): a stone kerb `rim` wide round water standing a centimetre over
 * it, so the surface reads brim-full like the Mall's pools. `basin` is the round one (the WWII Memorial's Rainbow Pool), placed at one scale.
 */
export const POOL = { half: [50, 10] as const, rim: 1.5, y1: 0.5, brim: 0.01 } as const;
export const BASIN = { r: 27.5, rim: 2, y1: 0.5 } as const;

/** A box from `y0` to `y1`, half `hx` by `hz`, centred on (`x`, `z`) (0 where absent). */
export type Slab = { readonly hx: number; readonly hz: number; readonly y0: number; readonly y1: number; readonly x?: number; readonly z?: number };

/**
 * A flight of `count` steps (m) up the local +Z front: step k rises `rise` above the last and is `run` shallower, all from `back`
 * (the face the flight climbs to) toward `back + count * run`, `hx` to a side. Each step is one box from `y0` (the flight's foot)
 * up to its own top, so the boxes nest and the drawn flight and its colliders are the same boxes.
 */
function flight(hx: number, back: number, y0: number, count: number, rise: number, run: number): Slab[] {
  const out: Slab[] = [];
  for (let k = 0; k < count; k++) {
    const depth = (count - k) * run;
    out.push({ hx, hz: depth / 2, y0, y1: y0 + (k + 1) * rise, z: back + depth / 2 });
  }
  return out;
}

/**
 * The Lincoln Memorial (m, its front, the east colonnade, toward +Z), after the building: a granite `terrace` 5 m over the circle
 * road and the grand `stair` of 20 steps down its front to the Reflecting Pool, between `cheeks` (a high block with a brazier on
 * its `bowl`, a low one to the foot); on the terrace the three great steps of the `crepidoma`, the central `upper` flight through
 * them and the `stylobate`; a peristyle of 36 Doric `columns` (12 to a long side, 8 to an end, tapered, a `capital` of echinus and
 * abacus) round the `cella`, whose walls stand `wall` thick and leave the east front open `door` wide on the chamber and the
 * seated Lincoln on his pedestal (`statue`); the entablature as `architrave`, `frieze` (a panel over each column for the 36
 * states of 1865) and `cornice`; the attic (48 festoons for the states of 1922) under its own cornice, and the raised roof.
 * `present/prefabs.ts` draws these. The colliders take everything a car can reach (the terrace, the stair and its cheeks) as drawn
 * and box the rest, all of it above a car.
 */
/** A cheek block's plan (m): its width, half its length, its centre out to the side of the grand stair. */
const CHEEK = { width: 5, hz: 5, x: 19.5 } as const;
const GRAND_STAIR = { hx: 17, back: 30, count: 20, rise: 0.25, run: 1 } as const;
export const LINCOLN = {
  terrace: { hx: 40, hz: 30, y0: 0, y1: 5 },
  stair: flight(GRAND_STAIR.hx, GRAND_STAIR.back, 0, GRAND_STAIR.count, GRAND_STAIR.rise, GRAND_STAIR.run),
  cheeks: [
    { hx: CHEEK.width / 2, hz: CHEEK.hz, x: CHEEK.x, y0: 0, y1: 6, z: 35 },
    { hx: CHEEK.width / 2, hz: CHEEK.hz, x: CHEEK.x, y0: 0, y1: 2.6, z: 45 },
  ],
  bowl: { r: 0.9, foot: 0.45, y0: 6, y1: 7.3, z: 37 },
  crepidoma: [
    { hx: 34, hz: 24, y0: 5, y1: 6.2 },
    { hx: 32.5, hz: 22.5, y0: 6.2, y1: 7.4 },
    { hx: 31, hz: 21, y0: 7.4, y1: 8.6 },
  ],
  upper: flight(12, 18.5, 5, 16, 0.3, 0.4),
  stylobate: { hx: 29, hz: 18.5, y0: 8.6, y1: 9.8 },
  columns: { r0: 1.13, r1: 0.92, alongX: 12, alongZ: 8, hx: 27.6, hz: 17.1, y0: 9.8, y1: 23.2 },
  capital: { echinus: 0.5, abacus: 0.4, flare: 1.22, half: 1.3 },
  cella: { hx: 22, hz: 12, wall: 1.2, door: 6.5, y0: 9.8, y1: 23.2 },
  statue: { pedestal: { hx: 2.6, hz: 2.7, y0: 9.8, y1: 13, z: -5 } },
  architrave: { hx: 28.9, hz: 18.4, y0: 23.2, y1: 24.6 },
  frieze: { hx: 28.7, hz: 18.2, y0: 24.6, y1: 26.2 },
  cornice: { hx: 29.4, hz: 18.9, y0: 26.2, y1: 27 },
  attic: { hx: 26, hz: 15.5, y0: 27, y1: 32 },
  festoon: { w: 1.3, h: 1.2, proud: 0.2, y: 29.6, alongX: 16, alongZ: 8 },
  atticCornice: { hx: 26.4, hz: 15.9, y0: 32, y1: 32.6 },
  roof: { hx: 22, hz: 12, y0: 32.6, y1: 33.6 },
} as const;

/** How far (m) the memorial reaches to its front: the grand stair's foot. */
const LINCOLN_REACH = GRAND_STAIR.back + GRAND_STAIR.count * GRAND_STAIR.run;

/** The peristyle's column centres (x, z): evenly round the rectangle `hx` by `hz`, `alongX` to a long side, `alongZ` to an end, the corners shared. */
export function lincolnColumns(): [number, number][] {
  const { alongX, alongZ, hx, hz } = LINCOLN.columns;
  const out: [number, number][] = [];
  for (let i = 0; i < alongX; i++) for (const z of [-hz, hz]) out.push([-hx + (2 * hx * i) / (alongX - 1), z]);
  for (let i = 1; i < alongZ - 1; i++) for (const x of [-hx, hx]) out.push([x, -hz + (2 * hz * i) / (alongZ - 1)]);
  return out;
}

/** The Lincoln Memorial's colliders: the terrace, the stair and its cheeks as drawn; boxes round the building above them. */
function lincolnPlan(): Collider[] {
  const L = LINCOLN;
  const slab = (b: Slab): Collider => ({ kind: "box", hx: b.hx, hz: b.hz, y0: b.y0, y1: b.y1, x: b.x ?? 0, z: b.z ?? 0 });
  return [
    slab(L.terrace),
    ...L.stair.map(slab),
    ...L.cheeks.flatMap((c) => [slab(c), slab({ ...c, x: -c.x! })]),
    ...[1, -1].map((s) => slab({ hx: L.bowl.r, hz: L.bowl.r, y0: L.bowl.y0, y1: L.bowl.y1, x: s * L.cheeks[0].x, z: L.bowl.z })),
    ...L.crepidoma.map(slab),
    ...L.upper.map(slab),
    slab(L.stylobate),
    // The peristyle, the cella and the statue inside it, as one box between the stylobate and the entablature.
    slab({ hx: L.stylobate.hx, hz: L.stylobate.hz, y0: L.columns.y0, y1: L.columns.y1 }),
    slab({ hx: L.cornice.hx, hz: L.cornice.hz, y0: L.architrave.y0, y1: L.cornice.y1 }),
    slab({ hx: L.atticCornice.hx, hz: L.atticCornice.hz, y0: L.attic.y0, y1: L.atticCornice.y1 }),
    slab(L.roof),
  ];
}

/** A lawn fountain (m): a stone basin with its water, a pedestal, the jet and the spray falling round it. */
export const FOUNTAIN = { basin: { r: 6, y1: 0.72 }, water: { r: 5.5, y0: 0.6 }, pedestal: { r: 1.1, y1: 1.6 }, jet: { r: 0.3, y1: 6.6 }, spray: { r: 1.8, y0: 4.6 } } as const;

/** One 10 m length of iron fence (m, along x): a stone kerb, the railings as one dark panel, a post at each end. */
export const FENCE = { kerb: { hx: 5, hz: 0.3, y1: 0.6 }, rails: { hx: 5, hz: 0.05, y1: 2.2 }, post: { half: 0.15, x: 4.85, y1: 2.5 } } as const;

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

/** A monument of bricks (`landmarks.ts`): solid, its colliders the bricks themselves, bounded by its farthest brick. */
function monumentSpec(bricks: readonly Brick[]): PrefabSpec {
  const hx = Math.max(...bricks.map((b) => Math.abs(b.x) + b.hx));
  const hz = Math.max(...bricks.map((b) => Math.abs(b.z) + b.hz));
  return { body: "solid", collider: bricks.map(brickCollider), foot: hypot2(hx, hz), size: [2 * hx, bricksTop(bricks), 2 * hz], mass: 0 };
}

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
  [PREFAB.tyreStack]: { body: "knock", collider: [{ kind: "circle", r: 0.375 }], foot: 0.4, size: [0.75, 1, 0.75], mass: 60 },
  [PREFAB.hayBale]: { body: "knock", collider: [{ kind: "box", hx: 0.6, hz: 0.45 }], foot: 0.75, size: [1.2, 0.9, 0.9], mass: 180 },
  crate: { body: "knock", collider: [{ kind: "box", hx: 0.5, hz: 0.5 }], foot: Math.SQRT1_2, size: [1, 1, 1], mass: 30 },
  [PREFAB.barrierBlock]: {
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
  // The National Mall course's landmarks and its museum blocks.
  obelisk: { body: "solid", collider: obeliskPlan(), foot: OBELISK.foot * Math.SQRT2, size: [OBELISK.foot * 2, OBELISK.tip, OBELISK.foot * 2], mass: 0 },
  // To the foot of the west front's stair, the farthest corner from the middle.
  capitol: { body: "solid", collider: capitolPlan(), foot: hypot2(CAPITOL.blocks[0].hx + CAPITOL.westStair.count * CAPITOL.westStair.run, CAPITOL.blocks[0].hz), size: [120, CAPITOL_TOP, 240], mass: 0 },
  [PREFAB.capitolPool]: {
    body: "solid",
    collider: capitolPool().rim.map(brickCollider),
    foot: hypot2(CAPITOL_POOL.halfLength + CAPITOL_POOL.westBulge, CAPITOL_POOL.westHalf),
    size: [2 * (CAPITOL_POOL.halfLength + CAPITOL_POOL.westBulge), CAPITOL_POOL.y1, 2 * CAPITOL_POOL.westHalf],
    mass: 0,
  },
  [PREFAB.grantMemorial]: monumentSpec(GRANT_MEMORIAL),
  [PREFAB.peaceMonument]: monumentSpec(PEACE_MONUMENT),
  [PREFAB.garfieldMonument]: monumentSpec(GARFIELD_MONUMENT),
  [PREFAB.flagpole]: {
    body: "solid",
    collider: flagpolePlan(),
    foot: FLAGPOLE.r + FLAGPOLE.flag.length,
    size: [2 * (FLAGPOLE.r + FLAGPOLE.flag.length), FLAGPOLE.top, 2 * (FLAGPOLE.r + FLAGPOLE.flag.length)],
    mass: 0,
  },
  marble: {
    body: "solid",
    collider: [
      { kind: "box", hx: MARBLE.footing.half, hz: MARBLE.footing.half, y1: MARBLE.footing.y1 },
      { kind: "box", hx: MARBLE.body.half, hz: MARBLE.body.half, y0: MARBLE.footing.y1, y1: MARBLE.body.y1 },
      { kind: "box", hx: MARBLE.cornice.half, hz: MARBLE.cornice.half, y0: MARBLE.body.y1, y1: MARBLE.cornice.y1 },
      { kind: "box", hx: MARBLE.parapet.half, hz: MARBLE.parapet.half, y0: MARBLE.cornice.y1, y1: MARBLE.parapet.y1 },
    ],
    foot: hypot2(MARBLE.cornice.half, MARBLE.cornice.half),
    size: [MARBLE.cornice.half * 2, MARBLE.parapet.y1, MARBLE.cornice.half * 2],
    mass: 0,
  },
  [PREFAB.whiteHouse]: {
    body: "solid",
    collider: whiteHousePlan(),
    foot: hypot2(100.5, 25.4),
    size: [201, WHITE_HOUSE.flag.pole.y1, 50.9],
    mass: 0,
  },
  fountain: {
    body: "solid",
    collider: [
      { kind: "circle", r: FOUNTAIN.basin.r, y1: FOUNTAIN.basin.y1 },
      { kind: "circle", r: FOUNTAIN.pedestal.r, y0: FOUNTAIN.basin.y1, y1: FOUNTAIN.pedestal.y1 },
      { kind: "circle", r: FOUNTAIN.jet.r, y0: FOUNTAIN.pedestal.y1, y1: FOUNTAIN.jet.y1 },
      { kind: "circle", r: FOUNTAIN.spray.r, y0: FOUNTAIN.spray.y0, y1: FOUNTAIN.jet.y1 },
    ],
    foot: FOUNTAIN.basin.r,
    size: [FOUNTAIN.basin.r * 2, FOUNTAIN.jet.y1, FOUNTAIN.basin.r * 2],
    mass: 0,
  },
  [PREFAB.pool]: {
    body: "solid",
    collider: [{ kind: "box", hx: POOL.half[0], hz: POOL.half[1], y1: POOL.y1 }],
    foot: hypot2(POOL.half[0], POOL.half[1]),
    size: [POOL.half[0] * 2, POOL.y1, POOL.half[1] * 2],
    mass: 0,
  },
  basin: { body: "solid", collider: [{ kind: "circle", r: BASIN.r, y1: BASIN.y1 }], foot: BASIN.r, size: [BASIN.r * 2, BASIN.y1, BASIN.r * 2], mass: 0 },
  lincoln: {
    body: "solid",
    collider: lincolnPlan(),
    // The terrace's corners and the stair's foot bound it: half its depth is the stair's reach to the front.
    foot: Math.max(hypot2(LINCOLN.terrace.hx, LINCOLN.terrace.hz), hypot2(GRAND_STAIR.hx, LINCOLN_REACH)),
    size: [LINCOLN.terrace.hx * 2, LINCOLN.roof.y1, LINCOLN_REACH * 2],
    mass: 0,
  },
  fence: {
    body: "solid",
    collider: [
      { kind: "box", hx: FENCE.kerb.hx, hz: FENCE.kerb.hz, y1: FENCE.kerb.y1 },
      { kind: "box", hx: FENCE.rails.hx, hz: FENCE.rails.hz, y0: FENCE.kerb.y1, y1: FENCE.rails.y1 },
      ...[-1, 1].map((s): Collider => ({ kind: "box", hx: FENCE.post.half, hz: FENCE.post.half, x: s * FENCE.post.x, y0: FENCE.kerb.y1, y1: FENCE.post.y1 })),
    ],
    foot: hypot2(FENCE.kerb.hx, FENCE.kerb.hz),
    size: [FENCE.kerb.hx * 2, FENCE.post.y1, FENCE.kerb.hz * 2],
    mass: 0,
  },
};
