import type { DeformableCar } from "../vehicle/car.ts";
import { propContact, type PropHits } from "../contact/prop-contact.ts";
import { detCos, detSin, PART_FAMILY } from "../kernel/physics-core.js";
import { SURFACE_IDS } from "../world/catalog.ts";
import { SURFACE } from "../world/constants.ts";
import { Ground } from "../world/ground.ts";
import { raisePlateaus, type Plateau } from "../world/terrain.ts";
import { DERBY_ARENA } from "./constants.ts";

/**
 * The derby arena's ground (the Havana plateau mechanism, `world/terrain.ts`): one 1 m grid patch holds every rise, so the middle
 * table-top, the four jumps, the pit and the scrap hump ARE the ground a tyre or a ragdoll meets, one surface query. Only what
 * stands on it is a prism of the same store: the ring wall, the containers, the K-rails, the crash pads and the tyre berms. A prism
 * never touches a rise (a flat box beside a heightfield ramp answers a false wall, measured), and every prism's top is a floor
 * through the one query. Floor and plateau tops are asphalt and concrete (grip 1 both): handling is unchanged.
 */

/** What a prism of the arena is, for the art (`derby-arena.ts` draws each kind from its box). */
export const DERBY_PROP = { wall: "wall", container: "container", rail: PART_FAMILY.rail, pad: "pad", tyres: "tyres" } as const;
export type DerbyPropKind = (typeof DERBY_PROP)[keyof typeof DERBY_PROP];

/** A flat prism of the arena: its plan box (centre, yaw, half extents) and height over the floor. `yaw`: local z is (sin yaw, cos yaw). */
export type DerbyBox = { kind: DerbyPropKind; x: number; z: number; yaw: number; hx: number; hz: number; height: number };

const { radius, wallThickness, wallHeight, wallPieces, wallMitre, gridHalf } = DERBY_ARENA;

/**
 * The rises, axis-aligned (`plateauHeight` has no yaw): a flat top at `height`, each side a plane over `run` (-x, +x, -z, +z), crest
 * and foot rounded over `round` m (a crest of 1.5 m or more keeps a hull's penetration under a centimetre, measured).
 * A jump has a long run on the side cars enter by (grade 0.25) and a short one on its lip; they pinwheel round the table-top so
 * every launch line runs along a lane and none points at the wall.
 */
const JUMP_HEIGHT = 1.5;
const JUMP_ENTRY = 7;
const JUMP_LIP = 2;
const JUMP_SIDE = 2.5;
const JUMP_ROUND = 1.5;
const JUMP_CREST = 1;
const JUMP_HALF_WIDTH = 2.5;
const JUMP_X = 15;
const JUMP_Z = 14;
/**
 * How far (m) each jump stands in from (`JUMP_X`, `JUMP_Z`) along the axis cars enter it by, where its long entry run reaches out:
 * the ground reads its 1 m nodes bilinearly, so a rise node raises the floor up to √2 m beyond it, and at 0 a jump's foot (29.73 m
 * out) stood within that of the spawn ring's inner edge (30.58 m: a 27-car field's corner 1.4 mm up it).
 */
const JUMP_PULL = 0.5;

const concrete = SURFACE.concrete;

export const DERBY_PLATEAUS: readonly Plateau[] = [
  // The table-top: 9 x 9 m flat top, 1.8 m up, on grade 0.26 sides.
  { x: 0, z: 0, halfX: 4.5, halfZ: 4.5, height: 1.8, run: [7, 7, 7, 7], round: 1.5, top: concrete },
  // North-east: enter from the wall side (+z), launch toward -z.
  { x: JUMP_X, z: JUMP_Z - JUMP_PULL, halfX: JUMP_HALF_WIDTH, halfZ: JUMP_CREST, height: JUMP_HEIGHT, run: [JUMP_SIDE, JUMP_SIDE, JUMP_LIP, JUMP_ENTRY], round: JUMP_ROUND, top: concrete },
  // South-east: enter from +x, launch toward -x.
  { x: JUMP_X - JUMP_PULL, z: -JUMP_Z, halfX: JUMP_CREST, halfZ: JUMP_HALF_WIDTH, height: JUMP_HEIGHT, run: [JUMP_LIP, JUMP_ENTRY, JUMP_SIDE, JUMP_SIDE], round: JUMP_ROUND, top: concrete },
  // South-west: enter from -z, launch toward +z.
  { x: -JUMP_X, z: -JUMP_Z + JUMP_PULL, halfX: JUMP_HALF_WIDTH, halfZ: JUMP_CREST, height: JUMP_HEIGHT, run: [JUMP_SIDE, JUMP_SIDE, JUMP_ENTRY, JUMP_LIP], round: JUMP_ROUND, top: concrete },
  // North-west: enter from -x, launch toward +x.
  { x: -JUMP_X + JUMP_PULL, z: JUMP_Z, halfX: JUMP_CREST, halfZ: JUMP_HALF_WIDTH, height: JUMP_HEIGHT, run: [JUMP_ENTRY, JUMP_LIP, JUMP_SIDE, JUMP_SIDE], round: JUMP_ROUND, top: concrete },
  // The pit plateau, west: a flat 8 x 6 m top 1 m up, its outer foot a grid cell's reach inside the spawn ring (at -21 its node at
  // x = -29 stood 29.27 m out).
  { x: -20.5, z: 0, halfX: 4, halfZ: 3, height: 1, run: [3, 3, 3, 3], round: 1.5, top: concrete },
  // The scrap hump, south: low cover, 0.8 m up.
  { x: 0, z: -21, halfX: 2.5, halfZ: 2.5, height: 0.8, run: [3, 3, 3, 3], round: 1.5, top: concrete },
];

const CONTAINER = { hx: 1.22, hz: 3.05, height: 2.4 };
/** Half the width of a guard-rail box (m), across its length. */
const RAIL_HALF_WIDTH = 0.6;
const RAIL = { hx: RAIL_HALF_WIDTH, hz: 1.83, height: 1.8 };
const PAD = { hx: 1, hz: 1, height: 1.8 };
const TYRES = { hx: 0.8, hz: 1.9, height: 1.5, pieces: 3, arcs: [20, 140, 255] as const, step: 6 };
const DEGREES = Math.PI / 180;

function box(kind: DerbyPropKind, x: number, z: number, yaw: number, size: { hx: number; hz: number; height: number }): DerbyBox {
  return { kind, x, z, yaw, hx: size.hx, hz: size.hz, height: size.height };
}

/** The ring wall: `wallPieces` boxes about the middle, each mitred `wallMitre` m into the next, inner faces `radius` m out. */
function wallBoxes(): DerbyBox[] {
  const centre = radius + wallThickness / 2;
  const hz = centre * Math.tan(Math.PI / wallPieces) + wallMitre;
  return Array.from({ length: wallPieces }, (_, k) => {
    const angle = (2 * Math.PI * k) / wallPieces;
    return box(DERBY_PROP.wall, detSin(angle) * centre, detCos(angle) * centre, angle + Math.PI / 2, { hx: wallThickness / 2, hz, height: wallHeight });
  });
}

/** Tyre berms against the wall: arcs of boxes whose outer faces meet the wall's inner face. */
function tyreBoxes(): DerbyBox[] {
  const centre = radius - TYRES.hx;
  return TYRES.arcs.flatMap((arcDegrees) =>
    Array.from({ length: TYRES.pieces }, (_, k) => {
      const angle = (arcDegrees + (k - (TYRES.pieces - 1) / 2) * TYRES.step) * DEGREES;
      return box(DERBY_PROP.tyres, detSin(angle) * centre, detCos(angle) * centre, angle + Math.PI / 2, TYRES);
    }),
  );
}

export const DERBY_BOXES: readonly DerbyBox[] = [
  ...wallBoxes(),
  ...tyreBoxes(),
  // Container berm, north: two boxes in an L with a 5 m gap between them.
  box(DERBY_PROP.container, -6, 22.5, 0, CONTAINER),
  box(DERBY_PROP.container, 3.5, 24.2, Math.PI / 2, CONTAINER),
  // Barrier chicane, east: three barriers along z, alternate lanes 4.3 m wide.
  box(DERBY_PROP.rail, 21, 5, 0, RAIL),
  box(DERBY_PROP.rail, 26.5, 0, 0, RAIL),
  box(DERBY_PROP.rail, 21, -5, 0, RAIL),
  // Crash pads, north-west of the containers.
  box(DERBY_PROP.pad, -13, 23.8, 0, PAD),
  box(DERBY_PROP.pad, -10.6, 23.8, 0, PAD),
];

/** The prisms that stand free on the floor (containers, rails, pads), not the wall and the berms against it: what a spawn must not face (`layoutDerby`). */
export const DERBY_FREE_PROPS: readonly DerbyBox[] = DERBY_BOXES.filter((b) => b.kind !== DERBY_PROP.wall && b.kind !== DERBY_PROP.tyres);

/** Grid nodes along a side: the grid reaches `gridHalf` m each way from the middle. */
const NODES = 2 * gridHalf + 1;
const FLOOR = SURFACE_IDS.indexOf(SURFACE.asphalt);

export class DerbyGround extends Ground {
  /** The baked grid, row-major along x: node (i, j) is at world (i - gridHalf, j - gridHalf). The floor mesh reads the same nodes. */
  readonly heights = new Float32Array(NODES * NODES);
  readonly surfaces = new Uint8Array(NODES * NODES).fill(FLOOR);
  /** Per prism (its index in `DERBY_BOXES` is its collider id): a knocked prop, none here, kept for the one contact rule. */
  private readonly knocked = new Uint8Array(DERBY_BOXES.length);

  constructor() {
    super();
    raisePlateaus(DERBY_PLATEAUS, this.heights, this.surfaces, -gridHalf, -gridHalf, NODES, 1);
    this.addGrid({
      nu: NODES,
      nv: NODES,
      step: 1,
      stepV: 1,
      u0: 0,
      v0: 0,
      heights: this.heights,
      ox: -gridHalf,
      oy: 0,
      oz: -gridHalf,
      reach: Infinity,
      surface: -1,
      surfs: this.surfaces,
      outside: { surface: FLOOR, hills: new Float64Array(0) },
      unbounded: true,
    });
    for (const [id, b] of DERBY_BOXES.entries()) this.addPrism({ x: b.x, z: b.z, yaw: b.yaw, hx: b.hx, hz: b.hz, base: 0, top: b.height, id });
    this.seal();
  }

  /** The world's end-of-slice hook for a car in the arena: its footprint against the prisms (the rises are the ground, the point query's). */
  contact(car: DeformableCar, index: number, hits: PropHits, dt: number): void {
    propContact(car, index, this, this.knocked, hits, dt);
  }
}
