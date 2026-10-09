import { bodyTopY } from "../vehicle/car-mesh.ts";
import { CAR_STYLES } from "../vehicle/car-variants.ts";
import { UNDERSIDE } from "../vehicle/car-suspension.ts";
import { hypot2, detSin, detCos } from "../kernel/physics-core.js";
import { PREFABS, type PrefabId } from "../world/catalog.ts";
import { Ground, STEP_UP } from "../world/ground.ts";
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
/** The pegboard's thickness and its stand-off from the wall (m): ¼ in hardboard on ¾ in furring. */
export const BOARD_T = 0.00635 * LAB_SCALE;
const STANDOFF = 0.019 * LAB_SCALE;
/** The garage around the bench (m): its side walls stand `ROOM_HALF_W` either side of the bench's middle (an 8.3 m garage), all its walls `ROOM_H` high from the floor. */
export const ROOM_HALF_W = 100;
export const ROOM_H = 140;
/** The garage's back wall (z): behind the pegboard and its stand-off. */
export const LAB_BACK = BOARD.z - BOARD_T - STANDOFF;
/** How deep (m) a wall is behind its face: enough that no slice of a 55 m/s throw crosses it (1/240 s: 0.23 m). */
const WALL_DEPTH = 2;

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
  const c = Math.abs(detCos(item.pose.yaw));
  const s = Math.abs(detSin(item.pose.yaw));
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
 * The Lab's ground (`Ground`): the bench top at 0 inside its edges, the floor `FLOOR` under everything, and the brackets and
 * shelves over both. Like a bridge deck, a surface counts for a body only when it is at most `STEP_UP` above it, so a car
 * on the bench under a shelf sees the bench. Grip as dry asphalt everywhere (`FLAT_GROUND`'s). Heights only: the Lab's own
 * solids (the ragdoll's bench and floor, `setSolids`) carry it for a body that collides by shape.
 */
class LabGround extends Ground {
  constructor(surfaces: readonly LabSurface[]) {
    super();
    this.setSolid(this.addPlane(FLOOR, -1e7, 1e7, -1e7, 1e7, Infinity), false);
    this.setSolid(this.addPlane(0, -BENCH.halfW, BENCH.halfW, BOARD.z, BENCH.front, STEP_UP), false);
    for (const s of surfaces) this.setSolid(this.addPlane(s.top, s.x0, s.x1, s.z0, s.z1, STEP_UP), false);
  }
}

export function labGround(surfaces: readonly LabSurface[]): Ground {
  return new LabGround(surfaces);
}

/** The props of a layout as the race places them (`Placed`), held ones on their brackets; `items[k]` is the layout index of `placed[k]`. */
export function labPlaced(layout: LabLayout): { placed: Placed[]; items: number[] } {
  const props = [...layout.entries()].flatMap(([k, item]) => (item.kind === "prop" ? [{ k, item, p: heldPose(item) }] : []));
  const placed = props.map(({ item, p }): Placed => ({ prefab: item.prefab, x: p.x, y: p.y, z: p.z, yaw: p.yaw, sx: 1, sy: 1, sz: 1 }));
  return { placed, items: props.map(({ k }) => k) };
}

/** A solid wall slab of the room for `labColliders`: centre (x, z), half extents, from `base` to `top` (m); each is a piece of the one wall (never knocked). */
function roomSlab(index: number, x: number, z: number, hx: number, hz: number, base: number, top: number): PropCollider {
  return { index, prefab: "wall", body: "solid", x, z, yaw: 0, kind: "box", r: hypot2(hx, hz), hx, hz, mass: 0, base, top, ends: 3 };
}

/**
 * What a car hits in the Lab besides other cars: the props (the race's colliders, `propColliders`) and the room as `lab-art.ts`
 * draws it (indices from `placed.length`, never knocked): the pegboard's face over the board, the garage's back wall behind it
 * (`LAB_BACK`) and its two side walls, each a solid `WALL_DEPTH` deep behind its face.
 */
export function labColliders(placed: readonly Placed[]): PropCollider[] {
  const n = placed.length;
  const d = WALL_DEPTH / 2;
  return [
    ...propColliders(placed),
    roomSlab(n, 0, BOARD.z - d, BOARD.halfW, d, 0, BOARD.h),
    roomSlab(n + 1, 0, LAB_BACK - d, ROOM_HALF_W, d, FLOOR, FLOOR + ROOM_H),
    roomSlab(n + 2, ROOM_HALF_W + d, LAB_BACK + ROOM_HALF_W, d, ROOM_HALF_W, FLOOR, FLOOR + ROOM_H),
    roomSlab(n + 3, -ROOM_HALF_W - d, LAB_BACK + ROOM_HALF_W, d, ROOM_HALF_W, FLOOR, FLOOR + ROOM_H),
  ];
}

/**
 * The house of cards: two sedans nose to tail `CARDS_GAP` m apart, a third lying along them across the gap, on both roofs.
 * Measured headless (lab probe, 10–20 s): gaps of 0.05–0.25 m stand (0.96 mm of plan movement after the first second);
 * 0.3 m creeps 2.5 mm, 0.4 m slides apart after about 5 s, 0.8 m drops the top car at once; side by side with a car across
 * them, the top car wedges the two apart within a second. A fourth car on top creeps 10–14 mm.
 */
const CARDS_X = 10;
const CARDS_GAP = 0.2;
/** The nose and tail keel points of a car's underside: car-local z and height over its origin (`UNDERSIDE`). */
const [, NOSE_KEEL_Z, NOSE_KEEL_H] = UNDERSIDE[0]!;
const [, TAIL_KEEL_Z, TAIL_KEEL_H] = UNDERSIDE[4]!;
/** A base car under the top car's weight rides bottomed: its nose keel on the ground, pitched nose-up by the rear tyres at their stops (rad, measured on the lab's cards). */
const BASE_PITCH = -0.00239;
const BASE_RIDE = -NOSE_KEEL_H * detCos(BASE_PITCH) + NOSE_KEEL_Z * detSin(BASE_PITCH);

/** The top car's height and pitch with its two keel ends on the base cars' roofs as drawn (`bodyTopY`), the base cars at `BASE_RIDE`. */
function onRoofs(): { y: number; pitch: number } {
  const reach = CAR_HALF.z + CARDS_GAP / 2;
  const noseLocalZ = NOSE_KEEL_Z - reach;
  const tailLocalZ = TAIL_KEEL_Z + reach;
  const noseRoof = BASE_RIDE + bodyTopY(0, noseLocalZ, CAR_STYLES.sedan) - noseLocalZ * detSin(BASE_PITCH);
  const tailRoof = BASE_RIDE + bodyTopY(0, tailLocalZ, CAR_STYLES.sedan) - tailLocalZ * detSin(BASE_PITCH);
  let pitch = 0;
  for (let i = 0; i < 4; i++) pitch = Math.asin(((NOSE_KEEL_H - TAIL_KEEL_H) * detCos(pitch) + tailRoof - noseRoof) / (NOSE_KEEL_Z - TAIL_KEEL_Z));
  return { y: noseRoof - NOSE_KEEL_H * detCos(pitch) + NOSE_KEEL_Z * detSin(pitch), pitch };
}
const ON_ROOFS = onRoofs();

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
    { kind: "car", type: SEDAN, pose: pose(CARDS_X - CAR_HALF.z - CARDS_GAP / 2, BASE_RIDE, 0, Math.PI / 2, BASE_PITCH), hold: "free" },
    { kind: "car", type: SEDAN, pose: pose(CARDS_X + CAR_HALF.z + CARDS_GAP / 2, BASE_RIDE, 0, Math.PI / 2, BASE_PITCH), hold: "free" },
    { kind: "car", type: SEDAN, pose: pose(CARDS_X, ON_ROOFS.y, 0, Math.PI / 2, ON_ROOFS.pitch), hold: "free" },
  ],
  glass: [
    { kind: "dummy", pose: pose(0, 1, BOARD.z + CAR_HALF.x + BRACKET_LIP, Math.PI / 2), hold: "free" },
    { kind: "car", type: SEDAN, pose: pose(10, 4 * PEG, 0, -Math.PI / 2), hold: "pin" },
  ],
};
