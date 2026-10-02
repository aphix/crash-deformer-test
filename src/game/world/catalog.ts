/**
 * Data tables the track JSON refers to by id. Pure: no THREE, no DOM.
 * `prefabs.ts` builds the meshes and must cover every `PrefabId`.
 */

export const SURFACE_IDS = ["asphalt", "concrete", "cobble", "dirt", "gravel", "grass", "sand"] as const;
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
] as const;
export type PrefabId = (typeof PREFAB_IDS)[number];

/** Prefab-local footprint (metres, +Z forward at yaw 0), scaled by the placement. */
type Collider = { kind: "circle"; r: number } | { kind: "box"; hx: number; hz: number };

type PrefabSpec = {
  /**
   * solid: immovable, cars are pushed out (walls, rocks, buildings).
   * knock: flies off when hit and costs the car `mass`-weighted speed (cones, bales).
   * none: scenery only.
   */
  body: "solid" | "knock" | "none";
  collider: Collider | null;
  /** Default size [w, h, d] (m); a placement's `size` overrides it. */
  size: [number, number, number];
  /** kg, for knock bodies. */
  mass: number;
};

export const PREFABS: Record<PrefabId, PrefabSpec> = {
  cone: { body: "knock", collider: { kind: "circle", r: 0.28 }, size: [0.4, 0.7, 0.4], mass: 4 },
  "tyre-stack": { body: "knock", collider: { kind: "circle", r: 0.4 }, size: [0.75, 1, 0.75], mass: 60 },
  "hay-bale": { body: "knock", collider: { kind: "box", hx: 0.6, hz: 0.45 }, size: [1.2, 0.9, 0.9], mass: 180 },
  crate: { body: "knock", collider: { kind: "box", hx: 0.5, hz: 0.5 }, size: [1, 1, 1], mass: 30 },
  "barrier-block": { body: "solid", collider: { kind: "box", hx: 0.32, hz: 1 }, size: [0.64, 0.81, 2], mass: 0 },
  rock: { body: "solid", collider: { kind: "circle", r: 1.1 }, size: [2.4, 1.6, 2.2], mass: 0 },
  tree: { body: "solid", collider: { kind: "circle", r: 0.35 }, size: [3.2, 7, 3.2], mass: 0 },
  building: { body: "solid", collider: { kind: "box", hx: 6, hz: 6 }, size: [12, 14, 12], mass: 0 },
  grandstand: { body: "solid", collider: { kind: "box", hx: 3.5, hz: 15 }, size: [7, 6, 30], mass: 0 },
  billboard: { body: "solid", collider: { kind: "box", hx: 0.2, hz: 3 }, size: [0.4, 4.5, 6], mass: 0 },
  lamp: { body: "solid", collider: { kind: "circle", r: 0.14 }, size: [0.3, 4.4, 0.3], mass: 0 },
  gantry: { body: "none", collider: null, size: [1, 6, 1], mass: 0 },
};
