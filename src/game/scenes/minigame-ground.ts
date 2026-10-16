import type { DeformableCar } from "../vehicle/car.ts";
import type { EjectionWatch } from "../vehicle/ejection.ts";
import { Ground, STEP_UP } from "../world/ground.ts";
import { LONG_JUMP_INCLINE, MINIGAME_MODES, STATION_ANCHORS, STATION_HALF_WIDTH, type MinigameMode } from "./minigame-constants.ts";
import { LipThrow } from "./minigame-lip.ts";
import { floorHeightAt, stationBackX, stationFrontX, stationStartPose } from "./minigame-profile.ts";
import { RING_BACKSTOP, RING_BOARD_BOUNDS, RING_MESH_STEP, RING_RAIL_PROFILE, ringBoardMesh, ringHeightAt } from "./minigame-ring.ts";
import { RANGE } from "./range.ts";

/**
 * Plan spacing (m) of the nodes along a station's run: the coarsest at which the bilinear floor is within 2 mm of the analytic
 * one. The high jump's kicker bends most (0.4 per metre at the lip), and a cell's error is a cell squared times 0.05 there: 1.9 mm at 0.2 m.
 */
const GRID_CELL = 0.2;
/** The level pad reaches this far (m) from the origin each way: what a ragdoll's flat collider covers. */
const PAD_HALF_EXTENT = 1000;
/** Half the thickness (m) of the high jump's net wall: more than a part travels in one physics step at a throw's top speed. */
const NET_HALF_THICKNESS = 0.25;

/** Where the high jump's net hangs, station-local: its plane's x, half its width across the lane and its height above the pad. */
export type HighJumpNet = { netX: number; netHalfWidth: number; netHeight: number };

/** The world pose of a parked start: `y` is the ground's height there, what the engine sets before `layOnGround`. */
export type StationStart = { x: number; y: number; z: number; yaw: number };

/** The world rectangle (m) of all stations and their landings. */
export type MinigameBounds = { minX: number; maxX: number; minZ: number; maxZ: number };

/** Node rows laid evenly over `length` m at no more than `GRID_CELL` apart: how many and how far apart. */
function evenNodes(length: number, cell: number): { count: number; spacing: number } {
  const count = Math.ceil(length / cell) + 1;
  return { count, spacing: length / (count - 1) };
}

/** Station-local x where the floor's profile changes character, so a section's nodes land on it exactly: the pad's back, the long jump's level tail (exactly 0 from there on), the lip (a crease for the high jump and Ring Fling) and, past it, the back face's foot. */
function sectionEdges(mode: MinigameMode): number[] {
  if (mode === "longJump") return [stationBackX(mode), -LONG_JUMP_INCLINE.flatTail, 0];
  return [stationBackX(mode), 0, stationFrontX(mode)];
}

/** A triangle mesh over a `columns` x `rows` lattice of heights (row-major; columns along x, rows along z), its first vertex at world (originX, originZ), facing up. */
function latticeMesh(heights: Float32Array, columns: number, rows: number, originX: number, originZ: number, spacingX: number, spacingZ: number): { vertices: Float32Array; indices: Uint32Array } {
  const vertices = new Float32Array(columns * rows * 3);
  const indices = new Uint32Array((columns - 1) * (rows - 1) * 6);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      vertices.set([originX + column * spacingX, heights[row * columns + column]!, originZ + row * spacingZ], (row * columns + column) * 3);
    }
  }
  let writeAt = 0;
  for (let row = 0; row < rows - 1; row++) {
    for (let column = 0; column < columns - 1; column++) {
      const nearLeft = row * columns + column;
      const farLeft = nearLeft + columns;
      indices.set([nearLeft, farLeft, nearLeft + 1, nearLeft + 1, farLeft, farLeft + 1], writeAt);
      writeAt += 6;
    }
  }
  return { vertices, indices };
}

/**
 * The Range's physics ground while a minigame mode is active: the three stations side by side (each its anchor's world x, z, every
 * throw down +x). A level pad at y = 0 lies everywhere but under the stations' lanes (a lane's floor is below it in places, and a plane
 * under it would win), tiled around them; each lane is a height grid sampled from `floorHeightAt` (heights for the cars, not solid to the
 * dummy) and a triangle mesh of the same nodes (what the dummy meets, so he lands on the high jump's and Ring Fling's back faces).
 * The Ring Fling board is a height grid (the dummy's "on the ground" and settle read `heightAt`) and a mesh; the board's backstop and the
 * high jump's net are prisms.
 */
export class MinigameGround extends Ground {
  /** World x of the far face of the Ring Fling backstop or the net, whichever stands further out. */
  private readonly farthestStructureX: number;

  constructor(options: { highJump: HighJumpNet }) {
    super();
    this.farthestStructureX = Math.max(
      STATION_ANCHORS.ringFling.x + RING_BOARD_BOUNDS.maxX + RING_BACKSTOP.distancePastBoard + RING_BACKSTOP.thickness,
      STATION_ANCHORS.highJump.x + options.highJump.netX + NET_HALF_THICKNESS,
    );
    this.addPads();
    for (const mode of MINIGAME_MODES) this.addStation(mode);
    this.addRingBoard();
    this.addRingBackstop();
    this.addHighJumpNet(options.highJump);
    this.seal();
  }

  /** The level pad around the stations: a plane per gap between lanes, and before and past each lane (the landing, the dummy's sand). */
  private addPads(): void {
    const lanes = [...MINIGAME_MODES]
      .sort((first, second) => STATION_ANCHORS[first].z - STATION_ANCHORS[second].z)
      .map((mode) => ({ mode, low: STATION_ANCHORS[mode].z - STATION_HALF_WIDTH, high: STATION_ANCHORS[mode].z + STATION_HALF_WIDTH }));
    let bandStart = -PAD_HALF_EXTENT;
    for (const lane of lanes) {
      this.addPlane(0, -PAD_HALF_EXTENT, PAD_HALF_EXTENT, bandStart, lane.low, Infinity);
      this.addPlane(0, -PAD_HALF_EXTENT, STATION_ANCHORS[lane.mode].x + stationBackX(lane.mode), lane.low, lane.high, Infinity);
      this.addPlane(0, STATION_ANCHORS[lane.mode].x + stationFrontX(lane.mode), PAD_HALF_EXTENT, lane.low, lane.high, Infinity);
      bandStart = lane.high;
    }
    this.addPlane(0, -PAD_HALF_EXTENT, PAD_HALF_EXTENT, bandStart, PAD_HALF_EXTENT, Infinity);
  }

  /** One non-solid height grid over the world rectangle from (originX, originZ), `lengthX` by `lengthZ`, its nodes no further apart than `cellX` along x and `cellZ` along z, each the height at its offset from the origin; returns the nodes, for a mesh. */
  private addHeightGrid(originX: number, originZ: number, lengthX: number, lengthZ: number, cellX: number, cellZ: number, heightAt: (offsetX: number, offsetZ: number) => number): { heights: Float32Array; columns: number; rows: number; spacingX: number; spacingZ: number } {
    const alongX = evenNodes(lengthX, cellX);
    const alongZ = evenNodes(lengthZ, cellZ);
    const heights = new Float32Array(alongX.count * alongZ.count);
    for (let row = 0; row < alongZ.count; row++) {
      for (let column = 0; column < alongX.count; column++) heights[row * alongX.count + column] = heightAt(column * alongX.spacing, row * alongZ.spacing);
    }
    const grid = this.addGrid({ nu: alongX.count, nv: alongZ.count, step: alongX.spacing, stepV: alongZ.spacing, u0: 0, v0: 0, heights, ox: originX, oy: 0, oz: originZ, reach: STEP_UP });
    this.setSolid(grid, false);
    return { heights, columns: alongX.count, rows: alongZ.count, spacingX: alongX.spacing, spacingZ: alongZ.spacing };
  }

  /** A station's floor from the back of its pad to where it meets the landing, one grid and mesh per section between `sectionEdges`. */
  private addStation(mode: MinigameMode): void {
    const anchor = STATION_ANCHORS[mode];
    const edges = sectionEdges(mode);
    for (let edge = 0; edge + 1 < edges.length; edge++) {
      const section = { from: edges[edge]!, to: edges[edge + 1]! };
      // The floor does not vary across the lane, so two node rows (the lane's edges) are exact in z.
      const nodes = this.addHeightGrid(anchor.x + section.from, anchor.z - STATION_HALF_WIDTH, section.to - section.from, 2 * STATION_HALF_WIDTH, GRID_CELL, 2 * STATION_HALF_WIDTH, (offsetX, offsetZ) => floorHeightAt(mode, section.from + offsetX, offsetZ - STATION_HALF_WIDTH));
      this.meshes.push(latticeMesh(nodes.heights, nodes.columns, nodes.rows, anchor.x + section.from, anchor.z - STATION_HALF_WIDTH, nodes.spacingX, nodes.spacingZ));
    }
  }

  /** The Ring Fling board: heights for the "on the ground" reads and the same board as a mesh for the dummy, shifted to the station's anchor. */
  private addRingBoard(): void {
    const anchor = STATION_ANCHORS.ringFling;
    const bounds = RING_BOARD_BOUNDS;
    this.addHeightGrid(anchor.x + bounds.minX, anchor.z + bounds.minZ, bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ, RING_MESH_STEP, RING_MESH_STEP, (offsetX, offsetZ) => ringHeightAt(bounds.minX + offsetX, bounds.minZ + offsetZ));
    const board = ringBoardMesh(RING_MESH_STEP);
    for (let at = 0; at < board.vertices.length; at += 3) {
      board.vertices[at]! += anchor.x;
      board.vertices[at + 2]! += anchor.z;
    }
    this.meshes.push(board);
  }

  /** The slab behind the board, front face `distancePastBoard` past it, as wide as the art draws it (the board plus the rim's height to each side). */
  private addRingBackstop(): void {
    const anchor = STATION_ANCHORS.ringFling;
    const halfWidth = (RING_BOARD_BOUNDS.maxZ - RING_BOARD_BOUNDS.minZ) / 2 + RING_RAIL_PROFILE.height;
    const frontFaceX = RING_BOARD_BOUNDS.maxX + RING_BACKSTOP.distancePastBoard;
    this.addPrism({
      x: anchor.x + frontFaceX + RING_BACKSTOP.thickness / 2,
      z: anchor.z + (RING_BOARD_BOUNDS.minZ + RING_BOARD_BOUNDS.maxZ) / 2,
      yaw: 0,
      hx: RING_BACKSTOP.thickness / 2,
      hz: halfWidth,
      base: 0,
      top: RING_BACKSTOP.height,
      id: 0,
    });
  }

  /** The net: a thin tall wall across the lane at `netX`, so a flying dummy stops at it and slides down. */
  private addHighJumpNet(net: HighJumpNet): void {
    const anchor = STATION_ANCHORS.highJump;
    this.addPrism({ x: anchor.x + net.netX, z: anchor.z, yaw: 0, hx: NET_HALF_THICKNESS, hz: net.netHalfWidth, base: 0, top: net.netHeight, id: 1 });
  }

  /** The per-car, per-slice function the engine assigns to `world.collide`: the lip throws of the high jump and Ring Fling (the long jump's barrier throws by a hit). */
  collideHook(cars: readonly DeformableCar[], ejection: EjectionWatch): (car: DeformableCar, index: number) => void {
    const highJumpLip = new LipThrow("highJump", cars, ejection);
    const ringFlingLip = new LipThrow("ringFling", cars, ejection);
    return (car, index) => {
      highJumpLip.collide(car, index);
      ringFlingLip.collide(car, index);
    };
  }

  /** Where the car of `mode` parks: set `group.position.y` to `y` (this ground's height there), then `layOnGround`, then `parked`. */
  stationStart(mode: MinigameMode): StationStart {
    const anchor = STATION_ANCHORS[mode];
    const pose = stationStartPose(mode);
    const x = anchor.x + pose.x;
    const z = anchor.z + pose.z;
    return { x, y: this.heightAt(x, z), z, yaw: pose.yaw };
  }

  /** The world rectangle of every station's lane and landing: what the free camera may roam. */
  minigameBounds(): MinigameBounds {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const mode of MINIGAME_MODES) {
      const anchor = STATION_ANCHORS[mode];
      minX = Math.min(minX, anchor.x + stationBackX(mode));
      maxX = Math.max(maxX, anchor.x + RANGE.length, this.farthestStructureX);
      minZ = Math.min(minZ, anchor.z - STATION_HALF_WIDTH);
      maxZ = Math.max(maxZ, anchor.z + STATION_HALF_WIDTH);
    }
    return { minX, maxX, minZ, maxZ };
  }
}
