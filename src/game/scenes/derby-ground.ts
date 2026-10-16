import type { DeformableCar } from "../vehicle/car.ts";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { propContact, type PropHits } from "../contact/prop-contact.ts";
import { detAtan2, detCos, detSin, hypot2, PART_FAMILY } from "../kernel/physics-core.js";
import { SURFACE_IDS } from "../world/catalog.ts";
import { SURFACE } from "../world/constants.ts";
import { Ground } from "../world/ground.ts";
import { raisePlateaus, type Plateau } from "../world/terrain.ts";
import { DERBY_ARENA } from "./constants.ts";

/**
 * The derby arena's ground (the Havana plateau mechanism, `world/terrain.ts`): one 1 m grid patch holds every rise, so the middle
 * table-top, the four bowl ramps at the wall, the pit and the scrap hump ARE the ground a tyre or a ragdoll meets, one surface query. Only what
 * stands on it is a prism of the same store: the ring wall, the containers, the K-rails, the crash pads and the tyre berms. A prism
 * never touches a rise (a flat box beside a heightfield ramp answers a false wall, measured), and every prism's top is a floor
 * through the one query. Floor and plateau tops are asphalt and concrete (grip 1 both): handling is unchanged.
 */

/** What a prism of the arena is, for the art (`derby-arena.ts` draws each kind from its box). */
export const DERBY_PROP = { wall: "wall", container: "container", rail: PART_FAMILY.rail, pad: "pad", tyres: "tyres" } as const;
export type DerbyPropKind = (typeof DERBY_PROP)[keyof typeof DERBY_PROP];

/** A flat prism of the arena: its plan box (centre, yaw, half extents) and height over the floor. `yaw`: local z is (sin yaw, cos yaw). */
export type DerbyBox = { kind: DerbyPropKind; x: number; z: number; yaw: number; hx: number; hz: number; height: number };

const { radius, wallThickness, wallHeight, wallPieces, wallMitre, gridHalf, spawnInset } = DERBY_ARENA;

/**
 * The rises, axis-aligned (`plateauHeight` has no yaw): a flat top at `height`, each side a plane over `run` (-x, +x, -z, +z), crest
 * and foot rounded over `round` m (a crest of 1.5 m or more keeps a hull's penetration under a centimetre, measured).
 * The four ramps are the design's bowl ramps: each stands at the wall with its high end toward it, a long run (grade about 0.2) down
 * to the open middle and a short lip run on the wall side, so the middle stays free of rises.
 */
const RAMP_HALF_WIDTH = 2.5;
/** Run (m) of a ramp's two side planes (narrower than before, so the footprint costs the spawn ring less arc). */
const RAMP_SIDE = 1.5;
const RAMP_CREST = 1;
const RAMP_LIP = 2;
const RAMP_ROUND = 1.5;
/** Design: flat tops stand at least this far (m) inside the wall. */
const WALL_SETBACK = 4;

const concrete = SURFACE.concrete;

/** A bowl ramp: where it is, which way it rises (unit step toward the wall), and its design long run (m) and height (m). */
export type DerbyRamp = { name: string; plateau: Plateau; toward: { x: number; z: number }; lateral: number; length: number; height: number };

/** Distance (m) from the middle to the crest's centre of a ramp `lateral` m off the middle line: its flat top ends `WALL_SETBACK` m inside the wall. */
function rampCentre(lateral: number): number {
  const cornerOffset = Math.abs(lateral) + RAMP_HALF_WIDTH + RAMP_SIDE;
  return Math.sqrt(radius * radius - cornerOffset * cornerOffset) - WALL_SETBACK - RAMP_CREST;
}

function ramp(name: string, toward: { x: number; z: number }, lateral: number, length: number, height: number): DerbyRamp {
  const risesAlongX = toward.x !== 0;
  const centre = rampCentre(lateral);
  // run: -x, +x, -z, +z. The sides run `RAMP_SIDE`; along the axis the wall side is the lip and the middle side the long run.
  const run: Plateau["run"] = [RAMP_SIDE, RAMP_SIDE, RAMP_SIDE, RAMP_SIDE];
  const wallIndex = risesAlongX ? (toward.x > 0 ? 1 : 0) : toward.z > 0 ? 3 : 2;
  run[wallIndex] = RAMP_LIP;
  run[wallIndex ^ 1] = length;
  const plateau: Plateau = {
    x: risesAlongX ? toward.x * centre : lateral,
    z: risesAlongX ? lateral : toward.z * centre,
    halfX: risesAlongX ? RAMP_CREST : RAMP_HALF_WIDTH,
    halfZ: risesAlongX ? RAMP_HALF_WIDTH : RAMP_CREST,
    height,
    run,
    round: RAMP_ROUND,
    top: concrete,
  };
  return { name, plateau, toward, lateral, length, height };
}

/** Design table 4.2: lateral offsets (m) are the probe's; lengths and heights are the design's (14/13/15/13 m, 2.8/2.5/3.0/2.5 m). */
export const DERBY_RAMPS: readonly DerbyRamp[] = [
  ramp("north", { x: 0, z: 1 }, 12, 14, 2.8),
  ramp("east", { x: 1, z: 0 }, -8, 13, 2.5),
  ramp("south", { x: 0, z: -1 }, 4, 15, 3),
  ramp("west", { x: -1, z: 0 }, -16, 13, 2.5),
];

/** The table-top: 12 x 12 m flat top, 2.2 m up, on grade 0.26 sides (the one rise that stands in the bowl's middle half: it is the design's central plateau). */
export const DERBY_TABLE_TOP: Plateau = { x: -9, z: 5, halfX: 6, halfZ: 6, height: 2.2, run: [8.5, 8.5, 8.5, 8.5], round: 1.5, top: concrete };

export const DERBY_PLATEAUS: readonly Plateau[] = [
  ...DERBY_RAMPS.map((entry) => entry.plateau),
  DERBY_TABLE_TOP,
  // The pit plateau: a flat 10 x 8 m top, 1 m up.
  { x: 15, z: 6, halfX: 5, halfZ: 4, height: 1, run: [3, 3, 3, 3], round: 1.5, top: concrete },
  // The scrap hump: low cover, 0.8 m up.
  { x: 11, z: -10, halfX: 2.5, halfZ: 2.5, height: 0.8, run: [3, 3, 3, 3], round: 1.5, top: concrete },
];

/** How far outside a prop's box (m) a spawned hull's corner must stay. */
export const SPAWN_CLEARANCE = 1;
/** Radial half-width (m) of the band round the spawn ring in which a spawned hull stands: its half-length and the clearance. */
const SPAWN_BAND = CAR_HALF.z + SPAWN_CLEARANCE;
const SPAWN_RING = radius - spawnInset;
/**
 * A prop whose nearest point to the middle is this far (m) out stands behind every spawned hull (its rear corners) and its clearance:
 * no car starts facing it, so `layoutDerby` need not skip its bearings. The rows of props against the wall are set this far out, plus a margin.
 */
const BEHIND_HULLS = hypot2(SPAWN_RING + CAR_HALF.z, CAR_HALF.x) + SPAWN_CLEARANCE;
const BEHIND_MARGIN = 0.05;
const BEHIND_RING = BEHIND_HULLS + BEHIND_MARGIN;

/** Container footprint (design 1.8-2.4 m high: the two heights alternate along a row). */
const CONTAINER = { hx: 1.22, hz: 3.05 };
const CONTAINER_HEIGHTS = [2.4, 1.8, 2.4, 1.8];
/** Half the width of a guard-rail box (m), across its length. */
const RAIL_HALF_WIDTH = 0.6;
const RAIL = { hx: RAIL_HALF_WIDTH, hz: 1.83, height: 1.8 };
/** Today's lane between facing rails (m): a monster truck's width with room. */
const RAIL_LANE = 4.3;
const PAD = { hx: 1, hz: 1 };
const PAD_HEIGHTS = [1.8, 1.8];
/** Tyre berms (design 1.5-2.0 m high: the two heights alternate piece by piece). */
const TYRES = { hx: 0.8, hz: 1.9, heights: [1.5, 2], pieces: 3, arcs: [52, 150, 205] as const, step: 6 };
/** Gap (m) between neighbours of a row against the wall. */
const ROW_GAP = 0.1;
const DEGREES = Math.PI / 180;

type PropSize = { hx: number; hz: number; height: number };

function box(kind: DerbyPropKind, x: number, z: number, yaw: number, size: PropSize): DerbyBox {
  return { kind, x, z, yaw, hx: size.hx, hz: size.hz, height: size.height };
}

/** A box `distance` m out along `bearing` (rad from +z toward +x), `lateral` m clockwise of that line, its long axis `turn` rad from the radial. */
function polar(kind: DerbyPropKind, bearing: number, distance: number, lateral: number, turn: number, size: PropSize): DerbyBox {
  const sin = detSin(bearing);
  const cos = detCos(bearing);
  return box(kind, sin * distance + cos * lateral, cos * distance - sin * lateral, bearing + turn, size);
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
  return TYRES.arcs.flatMap((arcDegrees, arc) =>
    Array.from({ length: TYRES.pieces }, (_, k) => {
      const angle = (arcDegrees + (k - (TYRES.pieces - 1) / 2) * TYRES.step) * DEGREES;
      const height = TYRES.heights[(arc * TYRES.pieces + k) % TYRES.heights.length]!;
      return polar(DERBY_PROP.tyres, angle, centre, 0, Math.PI / 2, { hx: TYRES.hx, hz: TYRES.hz, height });
    }),
  );
}

/**
 * A row of boxes of one footprint against the wall, long axis along it, centred on `centreDegrees`, one per height: the inner face
 * `BEHIND_RING` out (the outer face may stand a little into the wall's thickness), neighbours `ROW_GAP` m apart at their inner faces.
 */
function wallRow(kind: DerbyPropKind, centreDegrees: number, size: { hx: number; hz: number }, heights: readonly number[]): DerbyBox[] {
  const step = 2 * detAtan2(size.hz + ROW_GAP / 2, BEHIND_RING);
  return heights.map((height, k) => polar(kind, centreDegrees * DEGREES + (k - (heights.length - 1) / 2) * step, BEHIND_RING + size.hx, 0, Math.PI / 2, { ...size, height }));
}

/** The rail gate: two rails, a lane apart, their long axes along the radial, `GATE_DISTANCE` m out at `GATE_DEGREES` (next to the east ramp's bearings). */
const GATE_DEGREES = 123.5;
const GATE_DISTANCE = 34;
function railGate(): DerbyBox[] {
  const offset = RAIL_LANE / 2 + RAIL.hx;
  return [-1, 1].map((side) => polar(DERBY_PROP.rail, GATE_DEGREES * DEGREES, GATE_DISTANCE, side * offset, 0, RAIL));
}

export const DERBY_BOXES: readonly DerbyBox[] = [
  ...wallBoxes(),
  ...tyreBoxes(),
  // Container berm in the north-west: four boxes side by side against the wall, tall and short alternating.
  ...wallRow(DERBY_PROP.container, 312, CONTAINER, CONTAINER_HEIGHTS),
  // Crash pads at either end of the containers.
  ...wallRow(DERBY_PROP.pad, 264, PAD, PAD_HEIGHTS),
  ...wallRow(DERBY_PROP.pad, 349, PAD, PAD_HEIGHTS),
  // K-rails: a gate with a lane of `RAIL_LANE`, and a pair along the wall.
  ...railGate(),
  ...wallRow(DERBY_PROP.rail, 85, RAIL, [RAIL.height, RAIL.height]),
];

/** A prism's plan box alone (centre, yaw, half extents): what `layoutDerby` blocks bearings with. */
export type SpawnBox = { x: number; z: number; yaw: number; hx: number; hz: number };

/** Distance (m) from the middle to the nearest point of a box. */
function nearestReach(b: SpawnBox): number {
  const across = b.z * detSin(b.yaw) - b.x * detCos(b.yaw);
  const along = -b.x * detSin(b.yaw) - b.z * detCos(b.yaw);
  return hypot2(Math.max(0, Math.abs(across) - b.hx), Math.max(0, Math.abs(along) - b.hz));
}

/**
 * A slot faces the middle, so its hull's inner end stands `CAR_HALF.z` nearer the middle than the slot and over a ramp where the slot
 * itself is not: a ramp spoils the slots whose lateral offset on the ring is its own times about this (measured: 1.10 keeps every
 * ramp's spoiled bearings inside the arc its box blocks, where the plain ring/(ring - CAR_HALF.z) = 1.07 leaves the west ramp's low end out).
 */
const RING_LATERAL_SCALE = 1.1;
/** Half-width (m) of a ramp's box across its axis: the least that blocks every spoiled bearing with 0.3 degrees to spare (the footprint's 5.5 m costs the ring 6 degrees more). */
const SPAWN_BLOCK_ACROSS = 5;

/**
 * A ramp's plan box in the spawn ring's band: `SPAWN_BLOCK_ACROSS` either side of the ramp's line on the ring, the band along the
 * ramp's axis (the ring's reach at that offset, plus or minus the band). `layoutDerby` widens it by the car's half length and skips
 * every bearing it blocks, so no slot starts on or in front of a ramp.
 */
function spawnBlock(entry: DerbyRamp): SpawnBox {
  const ringLateral = entry.lateral * RING_LATERAL_SCALE;
  const ringAlong = Math.sqrt(SPAWN_RING * SPAWN_RING - ringLateral * ringLateral);
  const risesAlongX = entry.toward.x !== 0;
  return {
    x: risesAlongX ? entry.toward.x * ringAlong : ringLateral,
    z: risesAlongX ? ringLateral : entry.toward.z * ringAlong,
    yaw: 0,
    hx: risesAlongX ? SPAWN_BAND : SPAWN_BLOCK_ACROSS,
    hz: risesAlongX ? SPAWN_BLOCK_ACROSS : SPAWN_BAND,
  };
}

/**
 * What a spawn must not face (`layoutDerby`): the prisms a hull on the ring can face (every prop but the wall and those standing
 * behind the hulls: the berms and rows against the wall), and one band box per ramp.
 */
export const DERBY_FREE_PROPS: readonly SpawnBox[] = [
  ...DERBY_BOXES.filter((b) => b.kind !== DERBY_PROP.wall && nearestReach(b) < BEHIND_HULLS),
  ...DERBY_RAMPS.map(spawnBlock),
];

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
