/**
 * The National Mall's larger landmarks as shapes and colliders (metres at scale 1, +Z forward at yaw 0): the U.S. Capitol, the
 * Capitol Reflecting Pool's wedge, the Grant Memorial, the Peace and Garfield Monuments, and the bronze figures and horsemen they
 * carry. `present/prefabs-mall.ts` draws them; `catalog.ts`'s `PREFABS` takes their colliders. Pure: no THREE.
 */
import { detCos, detSin, hypot2 } from "../kernel/physics-core.js";

/**
 * One solid of a prefab (metres at scale 1, +Z forward at yaw 0): a circle (`r`) or a box (`hx`, `hz`) about (`x`, `z`) (0 when
 * omitted), from `y0` (0) up to `y1` (the prefab's height). A box may be turned `yaw` (0) about its own centre, added to the
 * placement's: only on a solid prefab placed at one scale in plan (`sx` = `sz`). A placement scales plan by `sx`, `sz` and height by `sy`.
 */
export type Collider = ({ kind: "circle"; r: number } | { kind: "box"; hx: number; hz: number; yaw?: number }) & { x?: number; z?: number; y0?: number; y1?: number };

/** A box: half sizes, centre, foot and top (m), turned `yaw` (rad, 0: +Z forward) about its centre; `stone` a statue's marble, not its bronze. */
export type Brick = { hx: number; hz: number; x: number; z: number; y0: number; y1: number; yaw?: number; stone?: boolean };

/** A brick as the collider that is exactly it. */
export function brickCollider(b: Brick): Collider {
  return { kind: "box", hx: b.hx, hz: b.hz, x: b.x, z: b.z, y0: b.y0, y1: b.y1, yaw: b.yaw ?? 0 };
}

const stone = (hx: number, hz: number, x: number, z: number, y0: number, y1: number): Brick => ({ hx, hz, x, z, y0, y1, stone: true });

/**
 * A standing bronze figure (a man in a long coat, 2.4 m tall at scale `s`) facing +Z, his feet at (x, y0, z): legs, the coat,
 * arms at his sides, neck and head.
 */
export function figure(x: number, z: number, y0: number, s: number): Brick[] {
  return [
    { hx: 0.1 * s, hz: 0.12 * s, x: x - 0.12 * s, z, y0, y1: y0 + 1.05 * s },
    { hx: 0.1 * s, hz: 0.12 * s, x: x + 0.12 * s, z, y0, y1: y0 + 1.05 * s },
    { hx: 0.27 * s, hz: 0.17 * s, x, z, y0: y0 + 0.75 * s, y1: y0 + 1.8 * s },
    { hx: 0.07 * s, hz: 0.08 * s, x: x - 0.34 * s, z, y0: y0 + 1.1 * s, y1: y0 + 1.75 * s },
    { hx: 0.07 * s, hz: 0.08 * s, x: x + 0.34 * s, z, y0: y0 + 1.1 * s, y1: y0 + 1.75 * s },
    { hx: 0.06 * s, hz: 0.06 * s, x, z, y0: y0 + 1.8 * s, y1: y0 + 1.88 * s },
    { hx: 0.12 * s, hz: 0.13 * s, x, z, y0: y0 + 1.88 * s, y1: y0 + 2.15 * s },
  ];
}

/**
 * A bronze horseman (a 2.6 m horse at scale `s`) facing +Z, the hooves at (x, y0, z): the barrel, four legs, the neck rising to the
 * head, the tail; the rider's legs astride, his body and head.
 */
function horseman(x: number, z: number, y0: number, s: number): Brick[] {
  const legs = [-1, 1].flatMap((side) => [-1, 1].map((end): Brick => ({ hx: 0.09 * s, hz: 0.1 * s, x: x + side * 0.22 * s, z: z + end * 0.85 * s, y0, y1: y0 + 1.2 * s })));
  return [
    { hx: 0.36 * s, hz: 1.15 * s, x, z, y0: y0 + 1.15 * s, y1: y0 + 1.85 * s },
    ...legs,
    { hx: 0.2 * s, hz: 0.26 * s, x, z: z + 1.12 * s, y0: y0 + 1.6 * s, y1: y0 + 2.4 * s },
    { hx: 0.14 * s, hz: 0.38 * s, x, z: z + 1.45 * s, y0: y0 + 2.15 * s, y1: y0 + 2.5 * s },
    { hx: 0.06 * s, hz: 0.12 * s, x, z: z - 1.25 * s, y0: y0 + 1.2 * s, y1: y0 + 1.75 * s },
    { hx: 0.45 * s, hz: 0.22 * s, x, z: z + 0.1 * s, y0: y0 + 1.75 * s, y1: y0 + 2.1 * s },
    { hx: 0.22 * s, hz: 0.15 * s, x, z: z + 0.05 * s, y0: y0 + 2.1 * s, y1: y0 + 2.85 * s },
    { hx: 0.11 * s, hz: 0.12 * s, x, z: z + 0.05 * s, y0: y0 + 2.85 * s, y1: y0 + 3.12 * s },
  ];
}

/**
 * The Ulysses S. Grant Memorial (m, its front +Z: west down the Mall; its 77 x 22 m platform's long axis x, after the platform's
 * published 252 x 71 ft): two marble steps, the central pedestal with Grant mounted on it facing the Mall, the Cavalry group charging
 * on its base at the north end (-x) and the Artillery group (two horsemen and their gun) at the south (+x).
 */
export const GRANT_MEMORIAL: readonly Brick[] = [
  stone(38.5, 11, 0, 0, 0, 0.6),
  stone(37.5, 10, 0, 0, 0.6, 1.2),
  stone(3.5, 6, 0, 0, 1.2, 8.2),
  stone(3.8, 6.3, 0, 0, 8.2, 8.6),
  ...horseman(0, -0.3, 8.6, 1.9),
  stone(5, 4, -30, 0, 1.2, 2.4),
  ...[-33.2, -30, -26.8].flatMap((x, k) => horseman(x, 0.6 * (k - 1), 2.4, 1.05)),
  stone(5, 4, 30, 0, 1.2, 2.4),
  ...[28.8, 31.2].flatMap((x) => horseman(x, 0.9, 2.4, 1.05)),
  // The gun: its barrel and two wheels behind the team.
  { hx: 0.16, hz: 1.2, x: 30, z: -2.2, y0: 3.15, y1: 3.45 },
  ...[-1, 1].map((side): Brick => ({ hx: 0.06, hz: 0.55, x: 30 + side * 0.5, z: -2.4, y0: 2.4, y1: 3.5 })),
];

/** The Peace Monument (m) on Peace Circle: a stepped marble base, Peace facing +Z on its front step, the shaft, and Grief weeping on History's shoulder at its top. */
export const PEACE_MONUMENT: readonly Brick[] = [
  stone(4, 4, 0, 0, 0, 1.2),
  stone(3, 3, 0, 0, 1.2, 3),
  stone(1.7, 1.7, 0, 0, 3, 12),
  stone(2, 2, 0, 0, 12, 12.6),
  ...figure(0, 3.4, 1.2, 0.95),
  ...figure(-0.55, 0, 12.6, 1.1),
  ...figure(0.55, 0.15, 12.6, 1.05),
];

/** The Garfield Monument (m) on Garfield Circle: a marble pedestal and its cap, the president standing on it facing +Z. */
export const GARFIELD_MONUMENT: readonly Brick[] = [stone(2.4, 2.4, 0, 0, 0, 1), stone(1.7, 1.7, 0, 0, 1, 6.5), stone(1.95, 1.95, 0, 0, 6.5, 7), ...figure(0, 0, 7, 1.4)];

/**
 * One of the Washington Monument's 50 flagpoles (m): the pole, and the flag flying from its top along +X (off the pole by its
 * radius), as thick as its colliding box.
 */
export const FLAGPOLE = { r: 0.08, top: 10, flag: { length: 1.8, height: 1, thick: 0.04, stripes: 7 } } as const;

/** The flagpole's colliders: the pole, and the flag's box at the pole's top. */
export function flagpolePlan(): Collider[] {
  const { r, top, flag } = FLAGPOLE;
  return [
    { kind: "circle", r, y0: 0, y1: top },
    { kind: "box", hx: flag.length / 2, hz: flag.thick / 2, x: r + flag.length / 2, z: 0, y0: top - flag.height, y1: top },
  ];
}

/** The tallest point (m) of a set of bricks. */
export function bricksTop(bricks: readonly Brick[]): number {
  return Math.max(...bricks.map((b) => b.y1));
}

/**
 * The Capitol Reflecting Pool (m, +X east toward the Capitol): the wedge the NPS describes, its longer west end convex and its
 * shorter east end concave (here 150 m end to end, 230 m across the west end and 140 m across the east, about the published 6
 * acres), a stone `rim` round water standing `brim` over it. The west end bows `westBulge` m out of the pool, the east `eastBulge` m into
 * it, each over `endSegments` sides.
 */
export const CAPITOL_POOL = { halfLength: 75, westHalf: 115, eastHalf: 70, westBulge: 12, eastBulge: 10, endSegments: 10, rim: 1.5, y1: 0.5, brim: 0.01 } as const;

/** The pool's outline (x, z), counter-clockwise on a north-up map (+z south): the west end north to south, then the east end south to north. */
function poolOutline(): [number, number][] {
  const { halfLength, westHalf, eastHalf, westBulge, eastBulge, endSegments } = CAPITOL_POOL;
  const out: [number, number][] = [];
  for (let k = 0; k <= endSegments; k++) {
    const t = -1 + (2 * k) / endSegments;
    out.push([-halfLength - westBulge * (1 - t * t), t * westHalf]);
  }
  for (let k = 0; k <= endSegments; k++) {
    const t = 1 - (2 * k) / endSegments;
    out.push([halfLength - eastBulge * (1 - t * t), t * eastHalf]);
  }
  return out;
}

/** The pool's outline moved `inset` m in (each side along its inward normal, each corner where its two sides' lines meet). */
function insetOutline(outline: readonly [number, number][], inset: number): [number, number][] {
  const n = outline.length;
  const normal = (k: number): [number, number, number, number] => {
    const [ax, az] = outline[k]!;
    const [bx, bz] = outline[(k + 1) % n]!;
    const len = hypot2(bx - ax, bz - az);
    // Going round this way, the inside lies at (uz, -ux) of each side's direction (ux, uz): east of the west end, run north to south.
    return [(bx - ax) / len, (bz - az) / len, (bz - az) / len, -(bx - ax) / len];
  };
  return outline.map(([x, z], k): [number, number] => {
    const [, , px, pz] = normal((k - 1 + n) % n);
    const [, , qx, qz] = normal(k);
    const mx = px + qx;
    const mz = pz + qz;
    const scale = inset / ((mx * qx + mz * qz) || 1);
    return [x + mx * scale, z + mz * scale];
  });
}

/** The pool's stone rim, a brick along each side of its outline (outer face on the outline, lengthened half a rim each way to close the corners), and its water's outline. */
export function capitolPool(): { rim: Brick[]; water: [number, number][] } {
  const { rim, y1 } = CAPITOL_POOL;
  const outline = poolOutline();
  const n = outline.length;
  const bricks: Brick[] = [];
  for (let k = 0; k < n; k++) {
    const [ax, az] = outline[k]!;
    const [bx, bz] = outline[(k + 1) % n]!;
    const len = hypot2(bx - ax, bz - az);
    const ux = (bx - ax) / len;
    const uz = (bz - az) / len;
    bricks.push({ hx: rim / 2, hz: len / 2 + rim / 2, x: (ax + bx) / 2 + uz * (rim / 2), z: (az + bz) / 2 - ux * (rim / 2), y0: 0, y1, yaw: Math.atan2(ux, uz) });
  }
  return { rim: bricks, water: insetOutline(outline, rim) };
}

/** A box block of the Capitol (m, front +X: the east front): half sizes, centre, foot and top. */
type Block = { hx: number; hz: number; x: number; z: number; y0: number; y1: number };

/** A row of columns (m): `count` evenly from `from` to `to` along z at `x` (or along x at `z`, `alongX`), radius `r`, foot and top. */
type Colonnade = { count: number; from: number; to: number; at: number; alongX: boolean; r: number; y0: number; y1: number };

/** A pediment (m): the triangle's base `half` across (along z) at `y0`, its peak `rise` over it, its depth from `x0` to `x1`. */
type Pediment = { half: number; z: number; x0: number; x1: number; y0: number; rise: number };

/**
 * The U.S. Capitol at about 0.9 scale (m, front +X: the east front; the west front faces the Mall): a terrace with the west front's
 * central stair down from it, the central block, the Senate and House wings, the east portico; the colonnades (the east portico's,
 * the wings' east porticos', the west front's loggia and the wings' west fronts), each under its entablature, the three east
 * pediments, roof balustrades and two floors of windows; then the dome's drum (an attic ring, a colonnade of `columns` round an inner
 * drum, an entablature), the dome (an ellipsoid of `rings` latitude rings from `spring` to `crown`, `ribs` standing on it), and the
 * lantern in its ring of columns under the Statue of Freedom. `present/prefabs-mall.ts` draws these, `capitolPlan` bounds them.
 */
export const CAPITOL = {
  blocks: [
    { hx: 60, hz: 120, x: 0, z: 0, y0: 0, y1: 4 },
    { hx: 35, hz: 55, x: 0, z: 0, y0: 4, y1: 30 },
    { hx: 30, hz: 30, x: 0, z: -85, y0: 4, y1: 26 },
    { hx: 30, hz: 30, x: 0, z: 85, y0: 4, y1: 26 },
    { hx: 6, hz: 25, x: 41, z: 0, y0: 4, y1: 24 },
  ] satisfies Block[],
  /** The west front's central stair: `count` steps of `rise` and `run` from the terrace's edge down toward the Mall, `half` across. */
  westStair: { half: 12, count: 8, rise: 0.5, run: 1 },
  colonnades: [
    { count: 12, from: -21, to: 21, at: 49.5, alongX: false, r: 0.8, y0: 4, y1: 21 },
    { count: 8, from: -97, to: -73, at: 32.6, alongX: false, r: 0.7, y0: 4, y1: 20 },
    { count: 8, from: 73, to: 97, at: 32.6, alongX: false, r: 0.7, y0: 4, y1: 20 },
    { count: 10, from: -18, to: 18, at: -37.4, alongX: false, r: 0.75, y0: 4, y1: 22 },
    { count: 11, from: -110, to: -60, at: -32.4, alongX: false, r: 0.6, y0: 4, y1: 21 },
    { count: 11, from: 60, to: 110, at: -32.4, alongX: false, r: 0.6, y0: 4, y1: 21 },
  ] satisfies Colonnade[],
  /** Each colonnade's entablature and the bounds its columns stand in (the colonnades' order). */
  entablatures: [
    { hx: 9.5, hz: 23, x: 41.5, z: 0, y0: 21, y1: 24 },
    { hx: 2.7, hz: 14, x: 32, z: -85, y0: 20, y1: 22.5 },
    { hx: 2.7, hz: 14, x: 32, z: 85, y0: 20, y1: 22.5 },
    { hx: 2.4, hz: 20, x: -37, z: 0, y0: 22, y1: 24 },
    { hx: 2.4, hz: 26, x: -32, z: -85, y0: 21, y1: 23 },
    { hx: 2.4, hz: 26, x: -32, z: 85, y0: 21, y1: 23 },
  ] satisfies Block[],
  pediments: [
    { half: 23, z: 0, x0: 32, x1: 51, y0: 24, rise: 6.5 },
    { half: 14, z: -85, x0: 29.4, x1: 34.6, y0: 22.5, rise: 4.2 },
    { half: 14, z: 85, x0: 29.4, x1: 34.6, y0: 22.5, rise: 4.2 },
  ] satisfies Pediment[],
  /** A roof balustrade's height (m) and thickness, set this far in from its block's edge. */
  balustrade: { height: 1.2, thick: 0.6, inset: 0.6 },
  /** The window floors (each a pane's foot and top, m) and a pane's width; panes every `bay` m, standing `proud` out of the wall. */
  windows: { floors: [[8, 12], [15, 19.5]] as readonly (readonly [number, number])[], width: 1.6, bay: 4.4, proud: 0.025 },
  attic: { r: 26, y0: 30, y1: 36 },
  columns: { count: 36, ring: 24, r: 0.9, y0: 36, y1: 48 },
  drum: { r: 21, y0: 36, y1: 51 },
  entablature: { r: 25.5, y0: 48, y1: 51 },
  dome: { r: 20, spring: 51, crown: 74, rings: 12, ribs: 36, rib: 0.45, ribOut: 0.15 },
  lantern: { r: 3.2, y0: 74, y1: 82, spire: 86, columns: 12, ring: 3.6, columnR: 0.25 },
  /** The Statue of Freedom on the lantern: the figure's scale (2.4 m at 1). */
  freedom: { scale: 2.2 },
} as const;

/** The dome's collider steps reach this far (m) past its surface: its ribs stand `ribOut` proud of it. */
const DOME_OUT = CAPITOL.dome.ribOut + 0.05;
/** Latitude rings of the dome per collider step: each step's circle is the dome at the step's foot, a ring the drawn dome passes through. */
const DOME_RINGS_PER_STEP = 3;

/** Height and radius (m) of the dome's latitude ring `k` (0 the crown, `rings` the spring line). */
export function domeRing(k: number): { y: number; r: number } {
  const { r, spring, crown, rings } = CAPITOL.dome;
  const polar = (k * Math.PI) / 2 / rings;
  return { y: spring + (crown - spring) * detCos(polar), r: r * detSin(polar) };
}

/** The west front's stair: step k rises `rise` over the one below it and is `run` shorter, all from the terrace's edge westward. */
export function capitolWestStair(): Block[] {
  const { half, count, rise, run } = CAPITOL.westStair;
  const edge = -CAPITOL.blocks[0]!.hx;
  return Array.from({ length: count }, (_, k): Block => {
    const depth = (count - k) * run;
    return { hx: depth / 2, hz: half, x: edge - depth / 2, z: 0, y0: 0, y1: CAPITOL.blocks[0]!.y1 - (count - 1 - k) * rise };
  });
}

/** The roof balustrades: four edge walls on each of the central block and the wings, on their roofs. */
export function capitolBalustrades(): Block[] {
  const { height, thick, inset } = CAPITOL.balustrade;
  return CAPITOL.blocks.slice(1, 4).flatMap((b): Block[] => {
    const hx = b.hx - inset;
    const hz = b.hz - inset;
    const y0 = b.y1;
    const y1 = b.y1 + height;
    return [
      { hx, hz: thick / 2, x: b.x, z: b.z - hz, y0, y1 },
      { hx, hz: thick / 2, x: b.x, z: b.z + hz, y0, y1 },
      { hx: thick / 2, hz, x: b.x - hx, z: b.z, y0, y1 },
      { hx: thick / 2, hz, x: b.x + hx, z: b.z, y0, y1 },
    ];
  });
}

/** The top of the Statue of Freedom (m): the prefab's height. */
export const CAPITOL_TOP = CAPITOL.lantern.spire + 2.4 * CAPITOL.freedom.scale;

export function capitolPlan(): Collider[] {
  const { blocks, entablatures, pediments, attic, entablature, dome, lantern } = CAPITOL;
  const box = (b: Block): Collider => ({ kind: "box", ...b });
  const out: Collider[] = [...blocks, ...capitolWestStair(), ...capitolBalustrades()].map(box);
  // A colonnade and its entablature in one box from the terrace up (the columns stand in it), a pediment in the box round it.
  for (const e of entablatures) out.push(box({ ...e, y0: CAPITOL.blocks[0]!.y1 }));
  for (const p of pediments) out.push(box({ hx: (p.x1 - p.x0) / 2, hz: p.half, x: (p.x0 + p.x1) / 2, z: p.z, y0: p.y0, y1: p.y0 + p.rise }));
  out.push({ kind: "circle", r: attic.r, y0: attic.y0, y1: attic.y1 }, { kind: "circle", r: entablature.r, y0: attic.y1, y1: entablature.y1 });
  for (let k = dome.rings; k > 0; k -= DOME_RINGS_PER_STEP) {
    const foot = domeRing(k);
    out.push({ kind: "circle", r: foot.r + DOME_OUT, y0: foot.y, y1: domeRing(Math.max(0, k - DOME_RINGS_PER_STEP)).y + DOME_OUT });
  }
  out.push({ kind: "circle", r: lantern.ring + lantern.columnR, y0: lantern.y0, y1: lantern.spire });
  out.push({ kind: "circle", r: 0.5 * CAPITOL.freedom.scale, y0: lantern.spire, y1: CAPITOL_TOP });
  return out;
}
