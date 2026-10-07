import { PREFABS, type PrefabId } from "../world/catalog.ts";
import { STEP_UP, type Ground } from "../world/ground.ts";
import { propColliders, type Placed, type PropCollider } from "../world/placements.ts";
import { CAR_HALF } from "../vehicle/car.ts";
import type { CarType } from "./fleet.ts";

/**
 * The Lab: a giant garage workshop where the cars are toys on a workbench. The physics runs at the game's
 * own scale; only the set is giant: the bench top is the ground (y = 0), a pegboard stands on its back edge, and the
 * workshop floor lies a bench's height below. A layout is data (`LabItem[]`): cars, dummies, props and shelves at exact
 * poses, each held on the pegboard (`pin`: snapped to the peg grid, a bracket under it) or free under gravity.
 */

/** The set's scale: a 1:24 die-cast car is a full-size car, so every workshop thing is 24 times its real size. */
export const LAB_SCALE = 24;
/** Pegboard hole pitch (m): 1 inch at `LAB_SCALE`. Held items snap to it. */
export const PEG = 0.0254 * LAB_SCALE;
/** The pegboard: its face (z), half width and height (m): a 4 × 8 ft board on the bench's back edge. */
export const BOARD = { z: -8, halfW: 1.2 * LAB_SCALE, h: 1.2 * LAB_SCALE } as const;
/** The workbench top (the ground, y = 0): x from −`halfW` to `halfW`, z from the board's face to `front`. 12 × 3 ft. */
export const BENCH = { halfW: 1.8 * LAB_SCALE, front: BOARD.z + 0.9 * LAB_SCALE } as const;
/** The workshop floor (m): a 0.9 m bench's height below the top. A thing off the bench's edge falls to it. */
export const FLOOR = -0.9 * LAB_SCALE;
/** How far (m) a bracket reaches past the footprint it carries, and its plate's thickness. */
const BRACKET_LIP = 0.1;
export const BRACKET_T = 0.12;
/** The wall the board hangs on: deep enough behind its face that no slice of a 55 m/s throw crosses it (1/240 s: 0.23 m). */
const WALL_DEPTH = 2;
const WALL_TOP = 200;

/** A pose: the thing's ground point (a car's wheel plane, a prop's base, a dummy's torso centre), yaw (rad, +Z forward at 0), pitch and roll. */
export type LabPose = { x: number; y: number; z: number; yaw: number; pitch: number; roll: number };
/** `pin`: hung on the pegboard (snapped to the peg grid, a bracket under it); `free`: where it is put, under gravity. */
type LabHold = "pin" | "free";
/** The knockable and solid props the game already has (`PREFABS`): what the race's prop rule can hit. */
const LAB_PROPS = ["cone", "tyre-stack", "crate", "hay-bale", "barrier-block", "dumpster"] as const satisfies readonly PrefabId[];
type LabProp = (typeof LAB_PROPS)[number];
export type LabItem =
  | { kind: "car"; type: CarType; pose: LabPose; hold: LabHold }
  | { kind: "dummy"; pose: LabPose; hold: LabHold }
  | { kind: "prop"; prefab: LabProp; pose: LabPose; hold: LabHold }
  /** A static plank: `w` along x, `d` along z (m), its top at the pose's y. Never held: it is fixed where it is put. */
  | { kind: "shelf"; w: number; d: number; pose: LabPose };
export type LabLayout = readonly LabItem[];

export const LAB_PRESETS = ["pad", "wall", "cards", "glass"] as const;
export type LabPresetId = (typeof LAB_PRESETS)[number];

/** A surface a car or dummy can stand on besides the bench: x0..x1, z0..z1 at height `top`. */
export type LabSurface = { x0: number; x1: number; z0: number; z1: number; top: number };

const pose = (x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0): LabPose => ({ x, y, z, yaw, pitch, roll });
const SEDAN: CarType = { cls: "sedan", style: "sedan" };

/** Plan half extents (x, z) of an item at its yaw (the box around its turned footprint). */
function footprint(item: LabItem): { hx: number; hz: number } {
  let ax: number;
  let az: number;
  if (item.kind === "car") {
    ax = CAR_HALF.x;
    az = CAR_HALF.z;
  } else if (item.kind === "prop") {
    const s = PREFABS[item.prefab].size;
    ax = s[0] / 2;
    az = s[2] / 2;
  } else if (item.kind === "shelf") {
    return { hx: item.w / 2, hz: item.d / 2 };
  } else {
    // A dummy hangs by his collar: shoulders across, chest deep.
    ax = 0.3;
    az = 0.15;
  }
  const c = Math.abs(Math.cos(item.pose.yaw));
  const s = Math.abs(Math.sin(item.pose.yaw));
  return { hx: ax * c + az * s, hz: ax * s + az * c };
}

/**
 * Where a held item hangs: x and y on the nearest peg hole, its back against the board's face. A free item or a shelf
 * stays where it was put.
 */
export function heldPose(item: LabItem): LabPose {
  const p = item.pose;
  if (item.kind === "shelf" || item.hold === "free") return p;
  const { hz } = footprint(item);
  return { ...p, x: Math.round(p.x / PEG) * PEG, y: Math.max(PEG, Math.round(p.y / PEG) * PEG), z: BOARD.z + hz + BRACKET_LIP };
}

/** Every surface of a layout: its shelves, and a bracket under each held car and prop (their footprint plus `BRACKET_LIP`). */
export function labSurfaces(layout: LabLayout): LabSurface[] {
  return layout
    .filter((item) => item.kind === "shelf" || (item.kind !== "dummy" && item.hold === "pin"))
    .map((item) => {
      const p = heldPose(item);
      const { hx, hz } = footprint(item);
      const lip = item.kind === "shelf" ? 0 : BRACKET_LIP;
      return { x0: p.x - hx - lip, x1: p.x + hx + lip, z0: p.z - hz - lip, z1: p.z + hz + lip, top: p.y };
    });
}

/**
 * The Lab's ground (`Ground`): the bench top at 0 inside its edges, the floor `FLOOR` past them, and the brackets and
 * shelves over both. Like a bridge deck, a surface counts for a body only when it is at most `STEP_UP` above it, so a car
 * on the bench under a shelf sees the bench. Grip as dry asphalt everywhere (`FLAT_GROUND`'s).
 */
export function labGround(surfaces: readonly LabSurface[]): Ground {
  const n = surfaces.length;
  const box = new Float64Array(n * 5);
  for (let i = 0; i < n; i++) {
    const s = surfaces[i]!;
    box[i * 5] = s.x0;
    box[i * 5 + 1] = s.x1;
    box[i * 5 + 2] = s.z0;
    box[i * 5 + 3] = s.z1;
    box[i * 5 + 4] = s.top;
  }
  const heightAt = (x: number, z: number, y?: number): number => {
    const reach = y === undefined ? Infinity : y + STEP_UP;
    let best = x >= -BENCH.halfW && x <= BENCH.halfW && z >= BOARD.z && z <= BENCH.front && reach >= 0 ? 0 : FLOOR;
    for (let i = 0; i < n; i++) {
      const o = i * 5;
      const top = box[o + 4]!;
      if (top <= best || top > reach || x < box[o]! || x > box[o + 1]! || z < box[o + 2]! || z > box[o + 3]!) continue;
      best = top;
    }
    return best;
  };
  return {
    heightAt,
    normalAt: (_x, _z, out) => {
      out.x = 0;
      out.y = 1;
      out.z = 0;
      return out;
    },
    frictionAt: () => 1,
    surfaceAt: () => "asphalt",
  };
}

/** The props of a layout as the race places them (`Placed`), held ones on their brackets; `items[k]` is the layout index of `placed[k]`. */
export function labPlaced(layout: LabLayout): { placed: Placed[]; items: number[] } {
  const props = [...layout.entries()].flatMap(([k, item]) => (item.kind === "prop" ? [{ k, item, p: heldPose(item) }] : []));
  const placed = props.map(({ item, p }): Placed => ({ prefab: item.prefab, x: p.x, y: p.y, z: p.z, yaw: p.yaw, sx: 1, sy: 1, sz: 1 }));
  return { placed, items: props.map(({ k }) => k) };
}

/**
 * What a car hits in the Lab besides other cars: the props (the race's colliders, `propColliders`) and the wall the
 * pegboard hangs on, a solid `WALL_DEPTH` deep behind the board's face (index `placed.length`: it is never knocked).
 */
export function labColliders(placed: readonly Placed[]): PropCollider[] {
  const hz = WALL_DEPTH / 2;
  const hx = BENCH.halfW;
  return [...propColliders(placed), { index: placed.length, prefab: "wall", body: "solid", x: 0, z: BOARD.z - hz, yaw: 0, kind: "box", r: Math.hypot(hx, hz), hx, hz, mass: 0, top: WALL_TOP }];
}

/**
 * The house of cards: two sedans nose to tail `CARDS_GAP` m apart, a third lying along them across the gap, on both roofs.
 * Measured headless (lab probe, 10–20 s): gaps of 0.05–0.25 m stand (0.96 mm of plan movement after the first second);
 * 0.3 m creeps 2.5 mm, 0.4 m slides apart after about 5 s, 0.8 m drops the top car at once; side by side with a car across
 * them, the top car wedges the two apart within a second. A fourth car on top creeps 10–14 mm.
 */
const CARDS_X = 10;
const CARDS_GAP = 0.2;
/** Height (m) of a sedan's origin lying on two sedans' roofs, as measured at rest (lab probe: 1.191, the roofs' 1.17 m of `vehicle/stack-crush.test.ts` plus the belly's ride). */
const ON_ROOF = 1.191;

/** A throw lane's start: a sedan on the bench left of the targets, facing them (+x). */
const THROWER = pose(-14, 0, 0, Math.PI / 2);

/**
 * The presets. `pad`: the empty bench and a car to throw. `wall`: a row of the game's props across the bench, more on the
 * pegboard's brackets above it. `cards`: the house of cards of cars. `glass`: a dummy on the bench, and a car held on a stand
 * bracket with its windscreen facing him. The first item is where the opening shot looks from: never the car against the board.
 */
export const LAB_LAYOUTS: Readonly<Record<LabPresetId, LabLayout>> = {
  pad: [{ kind: "car", type: SEDAN, pose: THROWER, hold: "free" }],
  wall: [
    { kind: "car", type: SEDAN, pose: THROWER, hold: "free" },
    ...(["crate", "tyre-stack", "hay-bale", "crate", "tyre-stack", "crate", "hay-bale"] as const).map((prefab, i): LabItem => ({ kind: "prop", prefab, pose: pose(10, 0, -3 + i * 1.3), hold: "free" })),
    { kind: "prop", prefab: "barrier-block", pose: pose(10, 0, -5.2), hold: "free" },
    { kind: "prop", prefab: "barrier-block", pose: pose(10, 0, 6.8), hold: "free" },
    ...[-2, 0, 2, 4].map((x, i): LabItem => ({ kind: "prop", prefab: i % 2 ? "cone" : "crate", pose: pose(8 + x * PEG * 2, 6 * PEG, 0), hold: "pin" })),
  ],
  cards: [
    { kind: "car", type: SEDAN, pose: THROWER, hold: "free" },
    { kind: "car", type: SEDAN, pose: pose(CARDS_X - CAR_HALF.z - CARDS_GAP / 2, 0, 0, Math.PI / 2), hold: "free" },
    { kind: "car", type: SEDAN, pose: pose(CARDS_X + CAR_HALF.z + CARDS_GAP / 2, 0, 0, Math.PI / 2), hold: "free" },
    { kind: "car", type: SEDAN, pose: pose(CARDS_X, ON_ROOF, 0, Math.PI / 2), hold: "free" },
  ],
  glass: [
    { kind: "dummy", pose: pose(0, 1, BOARD.z + CAR_HALF.x + BRACKET_LIP, Math.PI / 2), hold: "free" },
    { kind: "car", type: SEDAN, pose: pose(10, 4 * PEG, 0, -Math.PI / 2), hold: "pin" },
  ],
};
