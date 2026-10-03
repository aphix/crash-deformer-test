/**
 * Body styles on one shared platform (wheelbase, track, front clip, doors,
 * collision hulls and mass rig are identical). Styles differ only in the
 * greenhouse, rear glass, boot / bed and rear overhang shaping, plus the rig
 * cages that have to wrap those panels so skinning does not distort them.
 */
import type { RigOverrides } from "../deform/deform-rig.ts";

export type CarStyleId = "sedan" | "hatchback" | "wagon" | "coupe" | "pickup" | "police";

/** Spawn order: a 5+ car field shows every fleet style. Police spawn only on request (pursuit, HUD class). */
export const FLEET_STYLE_IDS: readonly CarStyleId[] = ["sedan", "hatchback", "wagon", "coupe", "pickup"];

/** Every body in netplay wire order (a snapshot sends the index): append only. */
export const CAR_STYLE_IDS: readonly CarStyleId[] = [...FLEET_STYLE_IDS, "police"];

/** One side-profile station (car space, +z forward). */
export interface ProfileStation {
  z: number;
  /** Half-width at the shoulder. */
  hw: number;
  /** Deck / beltline height. */
  yBelt: number;
  /** Roof height where `cabin` is 1. */
  yRoof: number;
  /** Roof half-width. */
  cabinHw: number;
  /** 0 = no greenhouse, 1 = full roof. */
  cabin: number;
}

/** [y, z] in car space. */
export type YZ = readonly [number, number];

export interface GlassQuad {
  base: YZ;
  top: YZ;
  wBase: number;
  wTop: number;
}

type BootSpec =
  /** Deck lid lofted on the profile from z0 to z1, hinged at origin. */
  | { kind: "lid"; z0: number; z1: number; origin: YZ }
  /** Vertical tail panel (hatch / tailgate) from y0 up to origin, hinged at its top edge. */
  | { kind: "tailgate"; y0: number; origin: YZ };

/** Paint a style fixes whatever the fleet paint (police black-and-white). */
interface Livery {
  body: number;
  doors: number;
  accent: number;
}

export interface BodyStyle {
  id: CarStyleId;
  /** Stations rear → front; z ≥ 0.82 is the shared front clip. */
  profile: readonly ProfileStation[];
  /** Roof panel [rear, front] z. */
  roofZ: readonly [number, number];
  windshieldTop: YZ;
  rearGlass: GlassQuad;
  /** Side glass behind the B-pillar: rear edge z at the belt and at the top. */
  quarter: { zRearBot: number; zRearTop: number };
  /** Extra pillar splitting the quarter glass (wagon C-pillar), or null. */
  midPillarZ: number | null;
  rearBulkhead: { z: number; yTop: number };
  /** Open floors visible through the glass: [zRear, zFront, floorY]. */
  tubs: readonly (readonly [number, number, number])[];
  /** Rear door shut line on four-door bodies, or null. */
  rearDoorSeam: number | null;
  boot: BootSpec;
  /**
   * Lamp seats [x, y] (m, right side; the left mirrors it) on the end panels: the head lamps on the nose, the tail lamps
   * on the tail panel, standing upright in its corners beside a tailgate. Each housing sits whole on the skin, clear of
   * the bumpers, grille and boot (`lamps.test.ts`).
   */
  lamps: { head: readonly [number, number]; tail: readonly [number, number] };
  rig: RigOverrides;
  /** Fixed paint, or none (the fleet paint). */
  livery?: Livery;
  /** Roof light bar with red / blue sirens (`DeformableCar.setSirens`). */
  lightBar?: boolean;
}

function st(z: number, hw: number, yBelt: number, yRoof = yBelt, cabinHw = 0.5, cabin = 0): ProfileStation {
  return { z, hw, yBelt, yRoof, cabinHw, cabin };
}

/** Cowl to nose: identical on every style (hood, fenders, lamps, windshield base). */
const FRONT_CLIP: readonly ProfileStation[] = [
  st(0.82, 0.87, 0.8, 1.05, 0.52, 0.4),
  st(1.18, 0.86, 0.775),
  st(1.58, 0.83, 0.72),
  st(1.9, 0.75, 0.64),
  st(2.11, 0.62, 0.54),
];

/** The front clip's head lamp seat: outboard of the grille, under the header panel, above the bumper. */
const HEAD_LAMP = [0.485, 0.485] as const;

const CABIN_TUB = [-0.7, 0.7, 0.3] as const;

const SEDAN: BodyStyle = {
  id: "sedan",
  profile: [
    st(-2.11, 0.64, 0.66),
    st(-1.92, 0.79, 0.76),
    st(-1.58, 0.86, 0.8),
    st(-1.18, 0.88, 0.81, 0.88, 0.56, 0.2),
    st(-0.78, 0.89, 0.815, 1.28, 0.6, 1),
    st(-0.18, 0.89, 0.82, 1.34, 0.62, 1),
    st(0.42, 0.88, 0.81, 1.3, 0.6, 1),
    ...FRONT_CLIP,
  ],
  roofZ: [-0.82, 0.58],
  windshieldTop: [1.26, 0.49],
  rearGlass: { base: [0.81, -1.16], top: [1.23, -0.76], wBase: 1.36, wTop: 0.98 },
  quarter: { zRearBot: -0.86, zRearTop: -0.7 },
  midPillarZ: null,
  rearBulkhead: { z: -0.72, yTop: 0.84 },
  tubs: [CABIN_TUB],
  rearDoorSeam: -0.62,
  boot: { kind: "lid", z0: -0.66, z1: -1.98, origin: [0.74, -0.72] },
  lamps: { head: HEAD_LAMP, tail: [0.47, 0.56] },
  rig: {},
};

/** Boot sensor (SENSORS[18]) follows the tail panel on hatch / tailgate bodies. */
const BOOT_SENSOR = 18;

const HATCHBACK: BodyStyle = {
  id: "hatchback",
  profile: [
    st(-2.11, 0.74, 0.84),
    st(-1.92, 0.83, 0.855),
    st(-1.62, 0.875, 0.845, 1.0, 0.52, 0.3),
    st(-1.36, 0.88, 0.835, 1.29, 0.58, 1),
    st(-0.78, 0.89, 0.82, 1.34, 0.6, 1),
    st(-0.18, 0.89, 0.82, 1.36, 0.62, 1),
    st(0.42, 0.88, 0.81, 1.31, 0.6, 1),
    ...FRONT_CLIP,
  ],
  roofZ: [-1.32, 0.58],
  windshieldTop: [1.27, 0.49],
  rearGlass: { base: [0.87, -1.84], top: [1.27, -1.33], wBase: 1.34, wTop: 1.04 },
  quarter: { zRearBot: -1.36, zRearTop: -1.12 },
  midPillarZ: null,
  rearBulkhead: { z: -0.72, yTop: 0.8 },
  tubs: [[-1.82, 0.7, 0.3]],
  rearDoorSeam: -0.62,
  boot: { kind: "tailgate", y0: 0.46, origin: [0.83, -2.115] },
  lamps: { head: HEAD_LAMP, tail: [0.675, 0.645] },
  rig: {
    cages: {
      roof: { min: [-0.58, 1.02, -1.36], max: [0.58, 1.36, 0.56] },
      glassRear: { min: [-0.66, 0.8, -1.92], max: [0.66, 1.32, -1.26] },
      boot: { min: [-0.76, 0.42, -2.18], max: [0.76, 0.9, -1.72] },
    },
    sensors: { [BOOT_SENSOR]: [0, 0.66, -1.98] },
  },
};

const WAGON: BodyStyle = {
  id: "wagon",
  profile: [
    st(-2.11, 0.76, 0.88),
    st(-1.96, 0.84, 0.89, 1.22, 0.55, 0.6),
    st(-1.66, 0.875, 0.86, 1.32, 0.58, 1),
    st(-1.18, 0.885, 0.84, 1.33, 0.59, 1),
    st(-0.78, 0.89, 0.825, 1.34, 0.6, 1),
    st(-0.18, 0.89, 0.82, 1.35, 0.62, 1),
    st(0.42, 0.88, 0.81, 1.31, 0.6, 1),
    ...FRONT_CLIP,
  ],
  roofZ: [-1.68, 0.58],
  windshieldTop: [1.27, 0.49],
  rearGlass: { base: [0.9, -1.99], top: [1.28, -1.7], wBase: 1.36, wTop: 1.12 },
  quarter: { zRearBot: -1.62, zRearTop: -1.52 },
  midPillarZ: -0.66,
  rearBulkhead: { z: -0.72, yTop: 0.8 },
  tubs: [[-1.96, 0.7, 0.3]],
  rearDoorSeam: -0.62,
  boot: { kind: "tailgate", y0: 0.46, origin: [0.87, -2.115] },
  lamps: { head: HEAD_LAMP, tail: [0.7, 0.68] },
  rig: {
    cages: {
      roof: { min: [-0.6, 1.02, -1.72], max: [0.6, 1.36, 0.56] },
      glassRear: { min: [-0.68, 0.84, -2.08], max: [0.68, 1.32, -1.62] },
      boot: { min: [-0.78, 0.42, -2.18], max: [0.78, 0.94, -1.76] },
    },
    sensors: { [BOOT_SENSOR]: [0, 0.68, -1.98] },
  },
};

/** Fastback two-door: lower roof, long sail, short deck. Fits the sedan rig as is. */
const COUPE: BodyStyle = {
  id: "coupe",
  profile: [
    st(-2.11, 0.66, 0.7),
    st(-1.92, 0.81, 0.78),
    st(-1.58, 0.89, 0.8),
    st(-1.3, 0.9, 0.81, 0.86, 0.5, 0.1),
    st(-0.78, 0.9, 0.82, 1.15, 0.57, 1),
    st(-0.18, 0.89, 0.81, 1.25, 0.6, 1),
    st(0.42, 0.88, 0.81, 1.22, 0.58, 1),
    ...FRONT_CLIP,
  ],
  roofZ: [-0.66, 0.5],
  windshieldTop: [1.19, 0.44],
  rearGlass: { base: [0.84, -1.34], top: [1.17, -0.68], wBase: 1.3, wTop: 0.92 },
  quarter: { zRearBot: -0.66, zRearTop: -0.5 },
  midPillarZ: null,
  rearBulkhead: { z: -0.72, yTop: 0.82 },
  tubs: [CABIN_TUB],
  rearDoorSeam: null,
  boot: { kind: "lid", z0: -1.34, z1: -1.98, origin: [0.8, -1.34] },
  lamps: { head: HEAD_LAMP, tail: [0.5, 0.58] },
  rig: {},
};

/** Single cab + open bed; the trunk part is the tailgate. */
const PICKUP: BodyStyle = {
  id: "pickup",
  profile: [
    st(-2.11, 0.86, 0.92),
    st(-1.58, 0.885, 0.92),
    st(-0.9, 0.89, 0.92),
    st(-0.68, 0.89, 0.835, 1.25, 0.6, 1),
    st(-0.18, 0.89, 0.82, 1.34, 0.62, 1),
    st(0.42, 0.88, 0.81, 1.3, 0.6, 1),
    ...FRONT_CLIP,
  ],
  roofZ: [-0.7, 0.58],
  windshieldTop: [1.26, 0.49],
  rearGlass: { base: [0.91, -0.71], top: [1.24, -0.67], wBase: 1.3, wTop: 1.1 },
  quarter: { zRearBot: -0.56, zRearTop: -0.54 },
  midPillarZ: null,
  rearBulkhead: { z: -0.735, yTop: 0.91 },
  tubs: [CABIN_TUB, [-2.05, -0.8, 0.52]],
  rearDoorSeam: null,
  boot: { kind: "tailgate", y0: 0.44, origin: [0.915, -2.12] },
  lamps: { head: HEAD_LAMP, tail: [0.79, 0.72] },
  rig: {
    cages: {
      roof: { min: [-0.58, 1.02, -0.72], max: [0.58, 1.36, 0.56] },
      glassRear: { min: [-0.66, 0.84, -0.8], max: [0.66, 1.3, -0.6] },
      boot: { min: [-0.78, 0.38, -2.18], max: [0.78, 0.96, -1.8] },
    },
    sensors: { [BOOT_SENSOR]: [0, 0.7, -1.98] },
  },
};

/**
 * Sedan shell in black-and-white with a roof light bar. The roof cage reaches over the bar, so the
 * bar skins with the roof (`skinPanel`) instead of clamping flat at the cage top.
 */
const POLICE: BodyStyle = {
  ...SEDAN,
  id: "police",
  livery: { body: 0x0c0d0f, doors: 0xeef0f2, accent: 0x16171a },
  lightBar: true,
  rig: { cages: { roof: { min: [-0.58, 1.02, -0.7], max: [0.58, 1.52, 0.56] } } },
};

export const CAR_STYLES: Readonly<Record<CarStyleId, BodyStyle>> = {
  sedan: SEDAN,
  hatchback: HATCHBACK,
  wagon: WAGON,
  coupe: COUPE,
  pickup: PICKUP,
  police: POLICE,
};
