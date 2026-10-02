/**
 * Static rig layout for the streamed deformation: FFD cages, crush sensors,
 * control-particle masses, lattice beams and the shape-match clusters.
 * Data only — StreamedDeformation builds its runtime state from these tables.
 */

export type BodyPartName =
  | "bumperFront"
  | "bumperRear"
  | "bonnet"
  | "boot"
  | "roof"
  | "doorLeft"
  | "doorRight"
  | "wingFL"
  | "wingFR"
  | "wingRL"
  | "wingRR"
  | "chassisFront"
  | "chassisCell"
  | "chassisRear"
  | "skirtLeft"
  | "skirtRight"
  | "glassFront"
  | "glassRear";

export interface CageSpec {
  name: BodyPartName;
  min: [number, number, number];
  max: [number, number, number];
  absorption: number;
  maxCrush: number;
  maxAngle: number;
}

export interface SensorSpec {
  rest: [number, number, number];
  radius: number;
  part: BodyPartName;
  absorption: number;
  maxCompression: number;
  neighbors: number[];
}

export const CAGES: CageSpec[] = [
  { name: "bumperFront", min: [-0.74, 0.16, 1.88], max: [0.74, 0.54, 2.16], absorption: 0.1, maxCrush: 0.95, maxAngle: 1.2 },
  { name: "bumperRear", min: [-0.72, 0.16, -2.14], max: [0.72, 0.52, -1.86], absorption: 0.12, maxCrush: 0.9, maxAngle: 1.1 },
  { name: "bonnet", min: [-0.78, 0.5, 0.72], max: [0.78, 0.78, 1.88], absorption: 0.16, maxCrush: 0.88, maxAngle: 1.05 },
  { name: "boot", min: [-0.76, 0.5, -1.86], max: [0.76, 0.8, -0.7], absorption: 0.18, maxCrush: 0.78, maxAngle: 0.95 },
  { name: "roof", min: [-0.58, 1.02, -0.7], max: [0.58, 1.34, 0.56], absorption: 0.52, maxCrush: 0.28, maxAngle: 0.32 },
  { name: "doorLeft", min: [-0.9, 0.22, -0.58], max: [-0.42, 1.04, 0.7], absorption: 0.22, maxCrush: 0.7, maxAngle: 1.15 },
  { name: "doorRight", min: [0.42, 0.22, -0.58], max: [0.9, 1.04, 0.7], absorption: 0.22, maxCrush: 0.7, maxAngle: 1.15 },
  { name: "wingFL", min: [-0.88, 0.16, 0.72], max: [-0.34, 0.68, 1.86], absorption: 0.14, maxCrush: 0.78, maxAngle: 0.95 },
  { name: "wingFR", min: [0.34, 0.16, 0.72], max: [0.88, 0.68, 1.86], absorption: 0.14, maxCrush: 0.78, maxAngle: 0.95 },
  { name: "wingRL", min: [-0.88, 0.16, -1.86], max: [-0.34, 0.68, -0.54], absorption: 0.16, maxCrush: 0.72, maxAngle: 0.85 },
  { name: "wingRR", min: [0.34, 0.16, -1.86], max: [0.88, 0.68, -0.54], absorption: 0.16, maxCrush: 0.72, maxAngle: 0.85 },
  { name: "chassisFront", min: [-0.58, 0.16, 0.42], max: [0.58, 0.5, 1.76], absorption: 0.28, maxCrush: 0.55, maxAngle: 0.55 },
  { name: "chassisCell", min: [-0.66, 0.2, -0.48], max: [0.66, 1.06, 0.64], absorption: 0.72, maxCrush: 0.16, maxAngle: 0.16 },
  { name: "chassisRear", min: [-0.58, 0.16, -1.76], max: [0.58, 0.5, -0.32], absorption: 0.3, maxCrush: 0.38, maxAngle: 0.48 },
  { name: "skirtLeft", min: [-0.9, 0.14, -1.32], max: [-0.54, 0.36, 1.32], absorption: 0.22, maxCrush: 0.42, maxAngle: 0.5 },
  { name: "skirtRight", min: [0.54, 0.14, -1.32], max: [0.9, 0.36, 1.32], absorption: 0.22, maxCrush: 0.42, maxAngle: 0.5 },
  { name: "glassFront", min: [-0.64, 0.68, 0.38], max: [0.64, 1.36, 1.16], absorption: 0.48, maxCrush: 0.32, maxAngle: 0.35 },
  { name: "glassRear", min: [-0.6, 0.68, -1.38], max: [0.6, 1.34, -0.58], absorption: 0.5, maxCrush: 0.28, maxAngle: 0.32 },
];

export const SENSORS: SensorSpec[] = [
  { rest: [0, 0.36, 2.08], radius: 0.42, part: "bumperFront", absorption: 0.08, maxCompression: 1, neighbors: [1, 2, 3] },
  { rest: [-0.62, 0.36, 1.96], radius: 0.36, part: "bumperFront", absorption: 0.1, maxCompression: 1, neighbors: [0, 4] },
  { rest: [0.62, 0.36, 1.96], radius: 0.36, part: "bumperFront", absorption: 0.1, maxCompression: 1, neighbors: [0, 5] },
  { rest: [0, 0.66, 1.42], radius: 0.4, part: "bonnet", absorption: 0.14, maxCompression: 1, neighbors: [0, 12] },
  { rest: [-0.72, 0.44, 1.32], radius: 0.36, part: "wingFL", absorption: 0.12, maxCompression: 1, neighbors: [1, 6] },
  { rest: [0.72, 0.44, 1.32], radius: 0.36, part: "wingFR", absorption: 0.12, maxCompression: 1, neighbors: [2, 7] },
  { rest: [-0.86, 0.56, 0.26], radius: 0.4, part: "doorLeft", absorption: 0.18, maxCompression: 1, neighbors: [4, 8, 14] },
  { rest: [0.86, 0.56, 0.26], radius: 0.4, part: "doorRight", absorption: 0.18, maxCompression: 1, neighbors: [5, 9, 15] },
  { rest: [-0.86, 0.4, -0.52], radius: 0.36, part: "doorLeft", absorption: 0.2, maxCompression: 0.95, neighbors: [6, 10] },
  { rest: [0.86, 0.4, -0.52], radius: 0.36, part: "doorRight", absorption: 0.2, maxCompression: 0.95, neighbors: [7, 11] },
  { rest: [-0.72, 0.44, -1.32], radius: 0.36, part: "wingRL", absorption: 0.14, maxCompression: 1, neighbors: [8, 13] },
  { rest: [0.72, 0.44, -1.32], radius: 0.36, part: "wingRR", absorption: 0.14, maxCompression: 1, neighbors: [9, 13] },
  { rest: [0, 1.2, 0.06], radius: 0.42, part: "roof", absorption: 0.48, maxCompression: 0.65, neighbors: [3, 19] },
  { rest: [0, 0.38, -2.08], radius: 0.42, part: "bumperRear", absorption: 0.12, maxCompression: 1, neighbors: [16, 17, 18] },
  { rest: [-0.8, 0.26, 0], radius: 0.32, part: "skirtLeft", absorption: 0.18, maxCompression: 0.9, neighbors: [6, 8] },
  { rest: [0.8, 0.26, 0], radius: 0.32, part: "skirtRight", absorption: 0.18, maxCompression: 0.9, neighbors: [7, 9] },
  { rest: [-0.64, 0.36, -1.96], radius: 0.36, part: "bumperRear", absorption: 0.12, maxCompression: 1, neighbors: [13, 10] },
  { rest: [0.64, 0.36, -1.96], radius: 0.36, part: "bumperRear", absorption: 0.12, maxCompression: 1, neighbors: [13, 11] },
  { rest: [0, 0.68, -1.38], radius: 0.4, part: "boot", absorption: 0.16, maxCompression: 0.95, neighbors: [13, 12] },
  { rest: [0, 0.6, 0.04], radius: 0.5, part: "chassisCell", absorption: 0.62, maxCompression: 0.45, neighbors: [12, 3, 18] },
];

export type MassName =
  | "bumperFL"
  | "bumperFR"
  | "engineL"
  | "engineR"
  | "railL"
  | "railR"
  | "cell"
  | "doorL"
  | "doorR"
  | "roof"
  | "tank"
  | "axleR"
  | "bumperRL"
  | "bumperRR"
  | "wingFL"
  | "wingFR"
  | "hubFL"
  | "hubFR"
  | "hubRL"
  | "hubRR";

interface MassSpec {
  name: MassName;
  rest: [number, number, number];
  mass: number;
  radius: number;
}

export const MASS_SPECS: MassSpec[] = [
  { name: "bumperFL", rest: [-0.52, 0.38, 2.06], mass: 9, radius: 0.28 },
  { name: "bumperFR", rest: [0.52, 0.38, 2.06], mass: 9, radius: 0.28 },
  { name: "engineL", rest: [-0.3, 0.44, 1.22], mass: 88, radius: 0.36 },
  { name: "engineR", rest: [0.3, 0.44, 1.22], mass: 88, radius: 0.36 },
  { name: "railL", rest: [-0.52, 0.38, 0.68], mass: 30, radius: 0.26 },
  { name: "railR", rest: [0.52, 0.38, 0.68], mass: 30, radius: 0.26 },
  { name: "cell", rest: [0, 0.55, 0.06], mass: 260, radius: 0.5 },
  { name: "doorL", rest: [-0.78, 0.56, 0.08], mass: 22, radius: 0.3 },
  { name: "doorR", rest: [0.78, 0.56, 0.08], mass: 22, radius: 0.3 },
  { name: "roof", rest: [0, 1.18, 0.02], mass: 32, radius: 0.36 },
  { name: "tank", rest: [0, 0.4, -0.88], mass: 48, radius: 0.32 },
  { name: "axleR", rest: [0, 0.36, -1.4], mass: 64, radius: 0.32 },
  { name: "bumperRL", rest: [-0.52, 0.36, -2.06], mass: 8, radius: 0.26 },
  { name: "bumperRR", rest: [0.52, 0.36, -2.06], mass: 8, radius: 0.26 },
  { name: "wingFL", rest: [-0.68, 0.4, 1.28], mass: 18, radius: 0.26 },
  { name: "wingFR", rest: [0.68, 0.4, 1.28], mass: 18, radius: 0.26 },
  { name: "hubFL", rest: [-0.74, 0.32, 1.34], mass: 26, radius: 0.28 },
  { name: "hubFR", rest: [0.74, 0.32, 1.34], mass: 26, radius: 0.28 },
  { name: "hubRL", rest: [-0.74, 0.32, -1.34], mass: 26, radius: 0.28 },
  { name: "hubRR", rest: [0.74, 0.32, -1.34], mass: 26, radius: 0.28 },
];

/** Rectangular crumple boxes at the nose and tail — no diagonal truss. */
export const BEAM_SPECS: [MassName, MassName, number, number, number][] = [
  ["bumperFL", "bumperFR", 700, 1400, 0.75],
  ["bumperFL", "wingFL", 2000, 4200, 0.92],
  ["bumperFR", "wingFR", 2000, 4200, 0.92],
  ["wingFL", "engineL", 3800, 8000, 0.78],
  ["wingFR", "engineR", 3800, 8000, 0.78],
  ["engineL", "engineR", 42000, 90000, 0.14],
  ["engineL", "railL", 7000, 14000, 0.78],
  ["engineR", "railR", 7000, 14000, 0.78],
  ["railL", "cell", 14000, 28000, 0.38],
  ["railR", "cell", 14000, 28000, 0.38],
  ["engineL", "cell", 3500, 8000, 0.78],
  ["engineR", "cell", 3500, 8000, 0.78],
  ["cell", "doorL", 7000, 14000, 0.5],
  ["cell", "doorR", 7000, 14000, 0.5],
  ["railL", "doorL", 5000, 11000, 0.48],
  ["railR", "doorR", 5000, 11000, 0.48],
  ["cell", "roof", 42000, 98000, 0.14],
  ["doorL", "roof", 6000, 12000, 0.32],
  ["doorR", "roof", 6000, 12000, 0.32],
  ["cell", "tank", 28000, 70000, 0.22],
  ["tank", "axleR", 9000, 18000, 0.5],
  ["doorL", "tank", 4500, 9000, 0.4],
  ["doorR", "tank", 4500, 9000, 0.4],
  ["wingFL", "railL", 4000, 9000, 0.55],
  ["wingFR", "railR", 4000, 9000, 0.55],
  ["railL", "railR", 25000, 56000, 0.18],
  ["doorL", "doorR", 8000, 40000, 0.12],
  ["roof", "engineL", 8000, 18000, 0.16],
  ["roof", "engineR", 8000, 18000, 0.16],
  ["bumperRL", "bumperRR", 700, 1400, 0.75],
  ["bumperRL", "hubRL", 1800, 4000, 0.9],
  ["bumperRR", "hubRR", 1800, 4000, 0.9],
  ["hubFL", "wingFL", 9000, 20000, 0.22],
  ["hubFL", "engineL", 7000, 16000, 0.26],
  ["hubFL", "railL", 5000, 12000, 0.22],
  ["hubFR", "wingFR", 9000, 20000, 0.22],
  ["hubFR", "engineR", 7000, 16000, 0.26],
  ["hubFR", "railR", 5000, 12000, 0.22],
  ["hubFL", "hubFR", 16000, 36000, 0.1],
  ["hubRL", "axleR", 8000, 18000, 0.24],
  ["hubRR", "axleR", 8000, 18000, 0.24],
  ["hubRL", "tank", 5000, 12000, 0.26],
  ["hubRR", "tank", 5000, 12000, 0.26],
  ["hubRL", "hubRR", 16000, 36000, 0.1],
  ["hubRL", "doorL", 9000, 20000, 0.2],
  ["hubRR", "doorR", 9000, 20000, 0.2],
];

/** One shape-match cluster: its member masses and the cage whose `absorption` sets its stiffness. */
interface ShapeClusterSpec {
  owner: BodyPartName;
  masses: readonly MassName[];
}

/**
 * Shape-match clusters, listed in mirrored left/right pairs (centre clusters are
 * symmetric sets), with no two clusters sharing a mass set. Hubs are never members.
 * Every cluster is mass-only data: body styles share it whatever their cage overrides.
 */
export const SHAPE_CLUSTERS: readonly ShapeClusterSpec[] = [
  { owner: "bumperFront", masses: ["bumperFL", "bumperFR", "engineL", "engineR"] },
  { owner: "bumperRear", masses: ["bumperRL", "bumperRR", "axleR"] },
  { owner: "bonnet", masses: ["engineL", "railL", "wingFL"] },
  { owner: "bonnet", masses: ["engineR", "railR", "wingFR"] },
  { owner: "doorLeft", masses: ["railL", "doorL", "cell", "roof"] },
  { owner: "doorRight", masses: ["railR", "doorR", "cell", "roof"] },
  { owner: "wingRL", masses: ["axleR", "tank", "bumperRL"] },
  { owner: "wingRR", masses: ["axleR", "tank", "bumperRR"] },
  { owner: "chassisCell", masses: ["railL", "railR", "cell", "doorL", "doorR", "roof"] },
  { owner: "skirtLeft", masses: ["railL", "wingFL", "doorL", "cell"] },
  { owner: "skirtRight", masses: ["railR", "wingFR", "doorR", "cell"] },
  { owner: "glassFront", masses: ["roof", "engineL", "engineR", "railL", "railR"] },
  // Corners: tie each bumper to its wing, engine and rail, and each tail corner to the cabin side.
  { owner: "wingFL", masses: ["bumperFL", "wingFL", "engineL", "railL"] },
  { owner: "wingFR", masses: ["bumperFR", "wingFR", "engineR", "railR"] },
  { owner: "wingRL", masses: ["bumperRL", "doorL", "tank", "axleR"] },
  { owner: "wingRR", masses: ["bumperRR", "doorR", "tank", "axleR"] },
];
