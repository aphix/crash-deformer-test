import * as THREE from "three";
import { leftoverCrumple, round4, vec3, applyGroundFriction, clampSpeed, CRASH, regionSoftness, crushGate, closingKeScale, regionCrushBands, forceTransfer, type CrushBands } from "./physics-util.ts";
import {
  type ShapeCluster,
  type ShapeParticle,
  makeCluster,
  rebuildAqqWeighted,
  matchCluster,
  applyPlasticity,
  resetCluster,
  matchSkinLocal,
  transformSkinPoint,
  transformSkinPointInto,
  stiffnessIters,
  goalAlpha,
  deformBeta,
  m3FrobeniusI,
} from "./shape-match.ts";

/**
 * Burnout-style streamed deformation.
 *
 * Cages are 8-corner FFD volumes that shear, hinge, and accordion — not
 * rigid AABBs. Crumple-zone masses keep moving into the contact plane while
 * the passenger cell is what SAT actually separates.
 */

export type DeformMode = "shape" | "lattice";

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

const CAGES: CageSpec[] = [
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
  { name: "chassisRear", min: [-0.58, 0.16, -1.76], max: [0.58, 0.5, -0.32], absorption: 0.3, maxCrush: 0.5, maxAngle: 0.48 },
  { name: "skirtLeft", min: [-0.9, 0.14, -1.32], max: [-0.54, 0.36, 1.32], absorption: 0.22, maxCrush: 0.42, maxAngle: 0.5 },
  { name: "skirtRight", min: [0.54, 0.14, -1.32], max: [0.9, 0.36, 1.32], absorption: 0.22, maxCrush: 0.42, maxAngle: 0.5 },
  { name: "glassFront", min: [-0.64, 0.68, 0.38], max: [0.64, 1.36, 1.16], absorption: 0.48, maxCrush: 0.32, maxAngle: 0.35 },
  { name: "glassRear", min: [-0.6, 0.68, -1.38], max: [0.6, 1.34, -0.58], absorption: 0.5, maxCrush: 0.28, maxAngle: 0.32 },
];

const SENSORS: SensorSpec[] = [
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

type MassName =
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

const MASS_SPECS: MassSpec[] = [
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
const BEAM_SPECS: [MassName, MassName, number, number, number][] = [
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

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _f = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _mat = new THREE.Matrix4();

function hash01(i: number, salt = 1): number {
  const s = Math.sin(i * 127.1 * salt + salt * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function trilinear(
  corners: THREE.Vector3[],
  u: number,
  v: number,
  w: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const c00x = corners[0]!.x + (corners[1]!.x - corners[0]!.x) * u;
  const c00y = corners[0]!.y + (corners[1]!.y - corners[0]!.y) * u;
  const c00z = corners[0]!.z + (corners[1]!.z - corners[0]!.z) * u;
  const c10x = corners[2]!.x + (corners[3]!.x - corners[2]!.x) * u;
  const c10y = corners[2]!.y + (corners[3]!.y - corners[2]!.y) * u;
  const c10z = corners[2]!.z + (corners[3]!.z - corners[2]!.z) * u;
  const c01x = corners[4]!.x + (corners[5]!.x - corners[4]!.x) * u;
  const c01y = corners[4]!.y + (corners[5]!.y - corners[4]!.y) * u;
  const c01z = corners[4]!.z + (corners[5]!.z - corners[4]!.z) * u;
  const c11x = corners[6]!.x + (corners[7]!.x - corners[6]!.x) * u;
  const c11y = corners[6]!.y + (corners[7]!.y - corners[6]!.y) * u;
  const c11z = corners[6]!.z + (corners[7]!.z - corners[6]!.z) * u;
  const c0x = c00x + (c10x - c00x) * v;
  const c0y = c00y + (c10y - c00y) * v;
  const c0z = c00z + (c10z - c00z) * v;
  const c1x = c01x + (c11x - c01x) * v;
  const c1y = c01y + (c11y - c01y) * v;
  const c1z = c01z + (c11z - c01z) * v;
  out.set(c0x + (c1x - c0x) * w, c0y + (c1y - c0y) * w, c0z + (c1z - c0z) * w);
  return out;
}

interface Cage {
  spec: CageSpec;
  min: THREE.Vector3;
  max: THREE.Vector3;
  center: THREE.Vector3;
  restCorners: THREE.Vector3[];
  corners: THREE.Vector3[];
  size: THREE.Vector3;
}

interface Sensor {
  spec: SensorSpec;
  rest: THREE.Vector3;
  pos: THREE.Vector3;
  partIndex: number;
  compression: number;
  target: number;
  delay: number;
  fired: boolean;
}

interface Influence {
  part: number;
  u: number;
  v: number;
  w: number;
  weight: number;
}

export interface MassNode {
  name: MassName;
  rest: THREE.Vector3;
  local: THREE.Vector3;
  world: THREE.Vector3;
  vel: THREE.Vector3;
  mass: number;
  radius: number;
  dynamic: boolean;
  clipping: boolean;
  popped: boolean;
  bands: CrushBands;
}

interface Beam {
  a: number;
  b: number;
  rest: number;
  plastic: number;
  minLen: number;
  kTen: number;
  yieldK: number;
  damp: number;
  alive: boolean;
  restDir: THREE.Vector3;
}

export class StreamedDeformation {
  readonly cageCount: number;
  readonly sensorCount: number;
  dirty = false;
  /** True after this frame's skin() — panels skip computeVertexNormals otherwise. */
  skinnedThisFrame = false;
  crushAmount = 0;
  impactLocal = new THREE.Vector3();
  impactInward = new THREE.Vector3(0, 0, -1);
  massActive = false;
  drivetrainAlive = true;
  /** Both ends are crumple zones (car-compactor / two-wall squeeze). */
  bidirectional = false;
  /** Walls past the wheel midpoint — cage/rails may yield. */
  deepCrush = false;

  private cages: Cage[];
  private sensors: Sensor[];
  private restPos: Float32Array;
  private influences: Influence[][];
  private vertexCount: number;
  private elapsed = 0;
  private lastContact = -10;
  private crushing = false;
  private impulse = 0;
  private wrinkleAmp = 0;
  private helper: THREE.Group | null = null;
  private helperLines: THREE.LineSegments | null = null;
  private helperLinePos: Float32Array | null = null;
  private helperSpheres: THREE.Mesh[] = [];
  private massHelperMeshes: THREE.Mesh[] = [];
  private beamHelperLines: THREE.LineSegments | null = null;
  private beamHelperPos: Float32Array | null = null;
  private beamHelperColor: Float32Array | null = null;
  private clusterHelperLines: THREE.LineSegments | null = null;
  private clusterHelperPos: Float32Array | null = null;
  private clusterHelperColor: Float32Array | null = null;
  readonly masses: MassNode[];
  private beams: Beam[];
  private cellIndex: number;
  private _totalMass = 1;
  private prevYaw = 0;
  private overlapFrame = false;
  squash = 0.4;
  buckle = 0.45;
  mode: DeformMode = "shape";
  private clusters: ShapeCluster[] = [];
  private shapeParticles: ShapeParticle[] = [];
  private goalX = new Float64Array(0);
  private goalY = new Float64Array(0);
  private goalZ = new Float64Array(0);
  private goalW = new Float64Array(0);
  private skinWeights: { ci: number; w: number }[][] = [];
  private impulseW = new Float64Array(0);
  private skinRest: { x: number; y: number; z: number }[] = [];
  private skinLocal: { x: number; y: number; z: number }[] = [];
  private skinMassN: number[] = [];

  constructor(geometry: THREE.BufferGeometry) {
    const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
    this.vertexCount = pos.count;
    this.restPos = new Float32Array(pos.array as Float32Array);

    this.cages = CAGES.map((spec) => {
      const min = new THREE.Vector3(...spec.min);
      const max = new THREE.Vector3(...spec.max);
      const restCorners: THREE.Vector3[] = [];
      const corners: THREE.Vector3[] = [];
      for (let iz = 0; iz < 2; iz++) {
        for (let iy = 0; iy < 2; iy++) {
          for (let ix = 0; ix < 2; ix++) {
            const p = new THREE.Vector3(ix ? max.x : min.x, iy ? max.y : min.y, iz ? max.z : min.z);
            restCorners.push(p);
            corners.push(p.clone());
          }
        }
      }
      return {
        spec,
        min,
        max,
        center: min.clone().add(max).multiplyScalar(0.5),
        restCorners,
        corners,
        size: max.clone().sub(min),
      };
    });
    this.cageCount = this.cages.length;

    const partIndex = new Map<BodyPartName, number>();
    this.cages.forEach((c, i) => partIndex.set(c.spec.name, i));

    this.sensors = SENSORS.map((spec) => ({
      spec,
      rest: new THREE.Vector3(...spec.rest),
      pos: new THREE.Vector3(...spec.rest),
      partIndex: partIndex.get(spec.part) ?? 12,
      compression: 0,
      target: 0,
      delay: 0,
      fired: false,
    }));
    this.sensorCount = this.sensors.length;

    const nameIndex = new Map<MassName, number>();
    this.masses = MASS_SPECS.map((spec, i) => {
      nameIndex.set(spec.name, i);
      const rest = new THREE.Vector3(...spec.rest);
      return {
        name: spec.name,
        rest,
        local: rest.clone(),
        world: rest.clone(),
        vel: new THREE.Vector3(),
        mass: spec.mass,
        radius: spec.radius,
        dynamic: false,
        clipping: false,
        popped: false,
        bands: regionCrushBands(spec.name),
      };
    });
    this.cellIndex = nameIndex.get("cell") ?? 5;
    this._totalMass = 0;
    for (const m of this.masses) this._totalMass += m.mass;
    this.impulseW = new Float64Array(this.masses.length);
    this.skinRest = this.masses.map((m) => m.rest);
    this.skinLocal = this.masses.map((m) => m.local);
    this.skinMassN = this.masses.map((m) => m.mass);
    this.beams = BEAM_SPECS.map(([na, nb, kTen, yieldK, maxShorten]) => {
      const a = nameIndex.get(na)!;
      const b = nameIndex.get(nb)!;
      const rest = this.masses[a]!.rest.distanceTo(this.masses[b]!.rest);
      const restDir = this.masses[b]!.rest.clone().sub(this.masses[a]!.rest);
      if (rest > 1e-6) restDir.multiplyScalar(1 / rest);
      return {
        a,
        b,
        rest,
        plastic: rest,
        minLen: Math.max(0.1, rest * (1 - maxShorten)),
        kTen,
        yieldK,
        damp: Math.sqrt(yieldK * 8),
        alive: true,
        restDir,
      };
    });

    this.influences = new Array(this.vertexCount);
    const cell = partIndex.get("chassisCell") ?? 12;
    for (let i = 0; i < this.vertexCount; i++) {
      const x = this.restPos[i * 3]!;
      const y = this.restPos[i * 3 + 1]!;
      const z = this.restPos[i * 3 + 2]!;
      const list: Influence[] = [];
      for (let p = 0; p < this.cages.length; p++) {
        const cage = this.cages[p]!;
        const name = cage.spec.name;
        if (name === "doorLeft" || name === "doorRight" || name === "glassFront" || name === "glassRear") continue;
        const u = (x - cage.min.x) / cage.size.x;
        const v = (y - cage.min.y) / cage.size.y;
        const w = (z - cage.min.z) / cage.size.z;
        const weight = axisWeight(u) * axisWeight(v) * axisWeight(w);
        if (weight > 0.02) list.push({ part: p, u, v, w, weight });
      }
      if (list.length === 0) {
        const cage = this.cages[cell]!;
        list.push({
          part: cell,
          u: THREE.MathUtils.clamp((x - cage.min.x) / cage.size.x, 0, 1),
          v: THREE.MathUtils.clamp((y - cage.min.y) / cage.size.y, 0, 1),
          w: THREE.MathUtils.clamp((z - cage.min.z) / cage.size.z, 0, 1),
          weight: 1,
        });
      } else {
        list.sort((a, b) => b.weight - a.weight);
        if (list.length > 4) list.length = 4;
        let sum = 0;
        for (const inf of list) sum += inf.weight;
        for (const inf of list) inf.weight /= sum;
      }
      this.influences[i] = list;
    }

    this.shapeParticles = this.masses.map((m) => ({
      x: m.rest.x,
      y: m.rest.y,
      z: m.rest.z,
      vx: 0,
      vy: 0,
      vz: 0,
      mass: m.mass,
    }));
    this.goalX = new Float64Array(this.masses.length);
    this.goalY = new Float64Array(this.masses.length);
    this.goalZ = new Float64Array(this.masses.length);
    this.goalW = new Float64Array(this.masses.length);
    this.clusters = [];
    for (const cage of this.cages) {
      const idx = this.cageClusterIndices(cage);
      if (idx.length < 3) continue;
      const left: number[] = [];
      const right: number[] = [];
      const mid: number[] = [];
      for (const i of idx) {
        const x = this.masses[i]!.rest.x;
        if (x < -0.12) left.push(i);
        else if (x > 0.12) right.push(i);
        else mid.push(i);
      }
      if (Math.abs(cage.center.x) < 0.18 && left.length >= 3 && right.length >= 3) {
        this.clusters.push(makeCluster(this.shapeParticles, left.concat(mid)));
        this.clusters.push(makeCluster(this.shapeParticles, right.concat(mid)));
      } else {
        this.clusters.push(makeCluster(this.shapeParticles, idx));
      }
    }
    const extra: MassName[][] = [
      ["bumperFL", "wingFL", "engineL", "railL"],
      ["bumperFR", "wingFR", "engineR", "railR"],
      ["bumperRL", "doorL", "tank", "axleR"],
      ["bumperRR", "doorR", "tank", "axleR"],
      ["doorL", "roof", "railL", "cell"],
      ["doorR", "roof", "railR", "cell"],
    ];
    for (const names of extra) {
      const idx = names.map((n) => nameIndex.get(n)!).filter((i) => i !== undefined);
      if (idx.length >= 3) this.clusters.push(makeCluster(this.shapeParticles, idx));
    }
    for (const c of this.clusters) rebuildAqqWeighted(c, this.shapeParticles);
    this.buildSkinWeights();
  }

  private buildSkinWeights(): void {
    this.skinWeights = new Array(this.vertexCount);
    const cms = this.clusters.map((c) => {
      let x = 0,
        y = 0,
        z = 0,
        m = 0;
      for (const i of c.idx) {
        const p = this.masses[i]!;
        x += p.rest.x * p.mass;
        y += p.rest.y * p.mass;
        z += p.rest.z * p.mass;
        m += p.mass;
      }
      m = Math.max(m, 1e-8);
      return { x: x / m, y: y / m, z: z / m };
    });
    for (let i = 0; i < this.vertexCount; i++) {
      const rx = this.restPos[i * 3]!;
      const ry = this.restPos[i * 3 + 1]!;
      const rz = this.restPos[i * 3 + 2]!;
      const scored: { ci: number; w: number }[] = [];
      for (let ci = 0; ci < this.clusters.length; ci++) {
        const cm = cms[ci]!;
        const d = Math.hypot(rx - cm.x, ry - cm.y, rz - cm.z);
        if (d > 1.45) continue;
        if (ry > 1.02 && cm.y < 0.78) continue;
        scored.push({ ci, w: Math.exp(-d * 2.35) });
      }
      scored.sort((a, b) => b.w - a.w);
      if (scored.length > 4) scored.length = 4;
      let sum = 0;
      for (const s of scored) sum += s.w;
      if (sum > 1e-8) for (const s of scored) s.w /= sum;
      this.skinWeights[i] = scored;
    }
  }

  private cageClusterIndices(cage: Cage): number[] {
    const pad = 0.16;
    const idx: number[] = [];
    const side = Math.abs(cage.center.x) > 0.2 ? Math.sign(cage.center.x) : 0;
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      if (m.name.startsWith("hub")) continue;
      const p = m.rest;
      if (side !== 0 && Math.sign(p.x) !== 0 && Math.sign(p.x) !== side) continue;
      if (
        p.x >= cage.min.x - pad &&
        p.x <= cage.max.x + pad &&
        p.y >= cage.min.y - pad &&
        p.y <= cage.max.y + pad &&
        p.z >= cage.min.z - pad &&
        p.z <= cage.max.z + pad
      ) {
        idx.push(i);
      }
    }
    if (idx.length < 3) {
      const scored = this.masses
        .map((m, i) => ({ i, d: m.rest.distanceTo(cage.center) }))
        .filter((s) => !this.masses[s.i]!.name.startsWith("hub"))
        .sort((a, b) => a.d - b.d);
      for (const s of scored) {
        if (s.d > 0.95) break;
        if (Math.abs(this.masses[s.i]!.rest.z - cage.center.z) > 1.05) continue;
        if (side !== 0 && Math.sign(this.masses[s.i]!.rest.x) !== side && Math.abs(this.masses[s.i]!.rest.x) > 0.12) continue;
        if (!idx.includes(s.i)) idx.push(s.i);
        if (idx.length >= 4) break;
      }
    }
    return idx;
  }

  reset(): void {
    this.elapsed = 0;
    this.lastContact = -10;
    this.crushing = false;
    this.impulse = 0;
    this.wrinkleAmp = 0;
    this.crushAmount = 0;
    this.dirty = false;
    this.massActive = false;
    this.drivetrainAlive = true;
    this.bidirectional = false;
    this.deepCrush = false;
    this.prevYaw = 0;
    this.overlapFrame = false;
    this.impactInward.set(0, 0, -1);
    this.impactLocal.set(0, 0.36, 2.1);
    for (const s of this.sensors) {
      s.compression = 0;
      s.target = 0;
      s.delay = 0;
      s.fired = false;
      s.pos.copy(s.rest);
    }
    for (const cage of this.cages) {
      for (let i = 0; i < 8; i++) cage.corners[i]!.copy(cage.restCorners[i]!);
    }
    for (const m of this.masses) {
      m.local.copy(m.rest);
      m.world.copy(m.rest);
      m.vel.set(0, 0, 0);
      m.dynamic = false;
      m.clipping = false;
      m.popped = false;
    }
    for (const b of this.beams) {
      b.plastic = b.rest;
      b.alive = true;
    }
    this.syncShapeFromMasses();
    for (const c of this.clusters) resetCluster(c, this.shapeParticles);
  }

  setMode(mode: DeformMode): void {
    this.mode = mode;
    this.syncHelperMode();
  }

  private captureShapeRest(): void {
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      const p = this.shapeParticles[i]!;
      p.x = m.world.x;
      p.y = m.world.y;
      p.z = m.world.z;
      p.vx = m.vel.x;
      p.vy = m.vel.y;
      p.vz = m.vel.z;
      p.mass = m.mass;
    }
    for (const c of this.clusters) resetCluster(c, this.shapeParticles);
  }

  private syncShapeFromMasses(): void {
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      const p = this.shapeParticles[i]!;
      p.x = m.world.x;
      p.y = m.world.y;
      p.z = m.world.z;
      p.vx = m.vel.x;
      p.vy = m.vel.y;
      p.vz = m.vel.z;
    }
  }

  private writeShapeToMasses(): void {
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      if (!m.dynamic) continue;
      if (m.name.startsWith("hub") && !m.popped && !this.deepCrush) continue;
      const p = this.shapeParticles[i]!;
      m.world.set(p.x, p.y, p.z);
      m.vel.set(p.vx, p.vy, p.vz);
      if (!Number.isFinite(m.world.x + m.world.y + m.world.z)) m.world.copy(m.rest);
      clampSpeed(m.vel);
    }
  }

  bindKinematic(group: THREE.Object3D, worldVel: THREE.Vector3, worldOmega: THREE.Vector3): void {
    group.updateMatrixWorld();
    const ox = group.position.x;
    const oz = group.position.z;
    for (const m of this.masses) {
      m.local.copy(m.rest);
      m.world.copy(m.rest).applyMatrix4(group.matrixWorld);
      m.vel.copy(worldVel);
      const rx = m.world.x - ox;
      const rz = m.world.z - oz;
      m.vel.x += -worldOmega.y * rz;
      m.vel.z += worldOmega.y * rx;
      m.dynamic = false;
    }
  }

  beginCrush(
    localPoint: THREE.Vector3,
    localInward: THREE.Vector3,
    impulse: number,
    group: THREE.Object3D,
    worldVel: THREE.Vector3,
    worldOmega: THREE.Vector3,
  ): void {
    this.impactLocal.copy(localPoint);
    this.impactInward.copy(localInward).normalize();
    this.impulse = THREE.MathUtils.clamp(impulse, 4, 70);
    this.crushing = true;
    this.massActive = true;
    this.elapsed = 0;
    this.lastContact = 0;
    this.wrinkleAmp = 0;
    this.dirty = true;
    this.bindKinematic(group, worldVel, worldOmega);
    for (const m of this.masses) m.dynamic = true;
    this.captureShapeRest();
    this.prevYaw = Math.atan2(Math.sin(group.rotation.y), Math.cos(group.rotation.y));
    this.snapImpactToNearestMass();
    for (const s of this.sensors) {
      s.target = 0;
      s.compression = 0;
      s.delay = 0;
      s.fired = false;
      s.pos.copy(s.rest);
    }
  }

  /** Mark that a collision is still happening so settle/cutDrive stay off. */
  notifyContact(): void {
    this.lastContact = this.elapsed;
  }

  quietTime(): number {
    return Math.max(0, this.elapsed - this.lastContact);
  }

  /** Enable lattice masses without starting the crash cinematic (speed-bump hop). */
  armMasses(group: THREE.Object3D, worldVel: THREE.Vector3, worldOmega: THREE.Vector3): void {
    if (this.massActive) return;
    this.massActive = true;
    this.bindKinematic(group, worldVel, worldOmega);
    for (const m of this.masses) m.dynamic = true;
    this.prevYaw = Math.atan2(Math.sin(group.rotation.y), Math.cos(group.rotation.y));
  }

  /** Pull impactLocal onto the nearest mass so L/R crush does not sit on the centerline. */
  private snapImpactToNearestMass(): void {
    // A true centerline hit must stay centered — snapping to bumperFL (first of
    // two equal distances) was turning every head-on into a left-corner crush.
    if (Math.abs(this.impactLocal.x) < 0.2) {
      let bestZ = this.impactLocal.z;
      let bestD = Infinity;
      for (const m of this.masses) {
        if (m.name === "cell" || m.name === "roof") continue;
        const dz = m.rest.z - this.impactLocal.z;
        const d = dz * dz + m.rest.x * m.rest.x * 0.15;
        if (d < bestD) {
          bestD = d;
          bestZ = m.rest.z;
        }
      }
      this.impactLocal.z = this.impactLocal.z * 0.28 + bestZ * 0.72;
      return;
    }
    let best: MassNode | null = null;
    let bestD = Infinity;
    const hitSide = Math.sign(this.impactLocal.x);
    for (const m of this.masses) {
      if (m.name === "cell" || m.name === "roof") continue;
      if (hitSide !== 0 && Math.sign(m.rest.x) !== 0 && Math.sign(m.rest.x) !== hitSide) continue;
      const dx = m.rest.x - this.impactLocal.x;
      const dz = m.rest.z - this.impactLocal.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    if (!best) return;
    this.impactLocal.x = this.impactLocal.x * 0.28 + best.rest.x * 0.72;
    this.impactLocal.z = this.impactLocal.z * 0.28 + best.rest.z * 0.72;
  }

  get totalMass(): number {
    return this._totalMass;
  }

  /** Stopping impulse lands on the crumple face so the rear keeps piling in. */
  applyImpulse(nx: number, ny: number, nz: number, j: number): void {
    if (!this.massActive || j === 0) return;
    const pass = this.frontTransfer();
    const masses = this.masses;
    const n = masses.length;
    const weights = this.impulseW;
    let wsum = 0;
    for (let i = 0; i < n; i++) {
      const m = masses[i]!;
      if (!m.dynamic) {
        weights[i] = 0;
        continue;
      }
      const face = this.impactWeight(m);
      const downstream = Math.max(0, 1 - this.crumpleWeight(m));
      // Face eats the hit; rear only sees the transferred fraction (0.1 / 0.5 / 0.62 / 1).
      const w = face + downstream * pass;
      weights[i] = w;
      wsum += w;
    }
    if (wsum < 1e-6) {
      // Graze / unknown contact: fall back to the crumple face as a whole.
      for (let i = 0; i < n; i++) {
        const m = masses[i]!;
        if (!m.dynamic) continue;
        const w = this.crumpleWeight(m);
        weights[i] = w;
        wsum += w;
      }
    }
    if (wsum < 1e-6) return;
    const invW = 1 / wsum;
    for (let i = 0; i < n; i++) {
      const m = masses[i]!;
      if (!m.dynamic) continue;
      const dv = (j * weights[i]! * invW) / m.mass;
      m.vel.x += nx * dv;
      m.vel.y += ny * dv;
      m.vel.z += nz * dv;
      clampSpeed(m.vel);
    }
  }

  kickNearest(worldPoint: THREE.Vector3, nx: number, ny: number, nz: number, j: number): void {
    if (!this.massActive || j === 0) return;
    let best: MassNode | null = null;
    let bestD = Infinity;
    for (const m of this.masses) {
      if (!m.dynamic) continue;
      const d = m.world.distanceToSquared(worldPoint);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    if (!best) return;
    best.vel.x += (nx * j) / best.mass;
    best.vel.y += (ny * j) / best.mass;
    best.vel.z += (nz * j) / best.mass;
  }

  kickNearestHub(worldPoint: THREE.Vector3, jUp: number): string | null {
    if (!this.massActive || jUp === 0) return null;
    let best: MassNode | null = null;
    let bestD = Infinity;
    for (const m of this.masses) {
      if (!m.dynamic || !m.name.startsWith("hub")) continue;
      const d = m.world.distanceToSquared(worldPoint);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    if (!best) {
      this.kickNearest(worldPoint, 0, 1, 0, jUp);
      return null;
    }
    best.vel.y += jUp / best.mass;
    if (jUp / best.mass > 0.9) this.popHub(best);
    return best.name;
  }

  hubPopped(name: MassName | string): boolean {
    const m = this.masses.find((n) => n.name === name);
    return !!m?.popped;
  }

  popHub(m: MassNode): void {
    m.popped = true;
  }

  massLocal(name: string): THREE.Vector3 {
    return this.massByName(name as MassName).local;
  }

  massWorld(name: string): THREE.Vector3 {
    return this.massByName(name as MassName).world;
  }

  /** Extra XZ drag once contact has ended — same Coulomb as the tires. */
  dragGround(dt: number, amount: number): void {
    if (!this.massActive || amount <= 0) return;
    const mu = CRASH.muSlide * (0.35 + amount * 1.25);
    for (const m of this.masses) {
      if (!m.dynamic) continue;
      applyGroundFriction(m.vel, dt, mu, true);
    }
  }

  cutDrive(dt: number): void {
    if (!this.massActive || this.drivetrainAlive) return;
    // Unpowered hubs only — cabin inertia keeps piling into the crumple.
    const k = Math.pow(0.55, Math.min(dt, 0.05));
    for (const m of this.masses) {
      if (!m.name.startsWith("hub")) continue;
      m.vel.x *= k;
      m.vel.z *= k;
    }
  }

  /** Engine/rails shifted enough that the drivetrain would be toast. */
  updateDrivetrain(): void {
    if (!this.drivetrainAlive || !this.massActive) return;
    const el = this.massByName("engineL");
    const er = this.massByName("engineR");
    const travel = Math.max(el.local.distanceTo(el.rest), er.local.distanceTo(er.rest));
    const bonnet = this.partCompression("bonnet");
    if (travel > 0.1 || bonnet > 0.28) this.drivetrainAlive = false;
  }

  private massByName(name: MassName): MassNode {
    for (const m of this.masses) if (m.name === name) return m;
    return this.masses[this.cellIndex]!;
  }

  /** How much of this mass belongs to the crumple zone facing the impact (0 = cell, 1 = bumper). */
  private crumpleWeight(m: MassNode): number {
    if (m.name === "cell" || m.name === "roof") return 0;
    if (m.name.startsWith("hub")) return 0;
    if (m.name.startsWith("bumper")) return 1;
    const along = -(m.rest.x * this.impactInward.x + m.rest.z * this.impactInward.z);
    let w = THREE.MathUtils.clamp(along / 1.55, 0, 1);
    if (
      (m.name === "doorL" || m.name === "doorR") &&
      Math.abs(this.impactInward.z) > Math.abs(this.impactInward.x)
    ) {
      w = Math.min(w, 0.15);
    }
    return w;
  }

  nodePacked(m: MassNode): boolean {
    const travel = m.local.distanceTo(m.rest);
    if (travel >= m.bands.max * 0.97) return true;
    const ix = this.impactInward.x;
    const iz = this.impactInward.z;
    const alongM = -(m.rest.x * ix + m.rest.z * iz);
    for (const beam of this.beams) {
      const a = this.masses[beam.a]!;
      const b = this.masses[beam.b]!;
      if (a !== m && b !== m) continue;
      const other = a === m ? b : a;
      const alongO = -(other.rest.x * ix + other.rest.z * iz);
      if (alongO >= alongM - 0.04) continue;
      if (!beam.alive) continue;
      const len = m.world.distanceTo(other.world);
      if (len <= beam.minLen + 0.03 || beam.plastic <= beam.minLen + 0.012) return true;
    }
    return false;
  }

  nodeTransfer(m: MassNode): number {
    return forceTransfer(m.local.distanceTo(m.rest), m.bands, this.nodePacked(m));
  }

  /** Weighted transfer of the crumple face currently taking the hit. */
  frontTransfer(): number {
    let sum = 0;
    let wsum = 0;
    for (const m of this.masses) {
      const w = this.impactWeight(m);
      if (w < 0.05) continue;
      sum += this.nodeTransfer(m) * w;
      wsum += w;
    }
    return wsum > 1e-6 ? sum / wsum : 0.1;
  }

  /** 1 at the hit corner, ~0 on the opposite side of the same axle. */
  private cornerWeight(m: MassNode): number {
    const hitX = this.impactLocal.x;
    if (Math.abs(hitX) < 0.2) return 1;
    const lat = Math.abs(m.rest.x - hitX);
    const hitSide = Math.sign(hitX);
    const nodeSide = Math.sign(m.rest.x);
    const opposite = nodeSide !== 0 && nodeSide !== hitSide;
    return Math.exp(-lat * (opposite ? 4.6 : 1.8)) * (opposite ? 0.06 : 1);
  }

  private impactWeight(m: MassNode): number {
    const far = m.rest.x * this.impactInward.x + m.rest.z * this.impactInward.z;
    if (!this.bidirectional && far > 0.18) return 0;
    return this.crumpleWeight(m) * this.cornerWeight(m);
  }

  private isCageBeam(beam: Beam): boolean {
    const a = this.masses[beam.a]!.name;
    const b = this.masses[beam.b]!.name;
    return (
      a === "cell" ||
      b === "cell" ||
      a === "roof" ||
      b === "roof" ||
      a === "railL" ||
      a === "railR" ||
      b === "railL" ||
      b === "railR"
    );
  }

  impulseAt(worldPoint: THREE.Vector3, worldNormal: THREE.Vector3, closing: number): void {
    if (!this.massActive) return;
    const seed = THREE.MathUtils.clamp(Math.abs(closing) * 0.0025 * this.squash, 0.01, 0.08);
    const kick = Math.abs(closing) * 0.45;
    const lift = Math.max(0.22, 0.82 - worldPoint.y) * Math.abs(closing) * 0.55;
    const passFront = this.frontTransfer();
    for (const m of this.masses) {
      const zone = this.impactWeight(m);
      if (zone < 0.04) continue;
      const d = m.world.distanceTo(worldPoint);
      const reach = m.radius * 2.8;
      if (d > reach) continue;
      const w = (1 - d / reach) ** 2 * zone;
      const pass = this.crumpleWeight(m) < 0.45 ? passFront : 1;
      const into = 1;
      m.world.addScaledVector(worldNormal, into * seed * w * (0.5 + zone) * pass);
      m.vel.addScaledVector(worldNormal, (into * kick * w * 12 * pass) / m.mass);
      if (m.rest.z < -0.2) m.vel.y += lift * w * 0.12 * pass;
      else if (m.rest.z > 0.6) m.vel.y += lift * w * 0.02 * pass;
      clampSpeed(m.vel);
    }
  }

  collideWith(other: StreamedDeformation): void {
    if (this.quietTime() > 0.22 && other.quietTime() > 0.22) return;
    const massesA = this.masses;
    const massesB = other.masses;
    const nA = massesA.length;
    const nB = massesB.length;
    for (let i = 0; i < nA; i++) massesA[i]!.clipping = false;
    for (let j = 0; j < nB; j++) massesB[j]!.clipping = false;
    for (let i = 0; i < nA; i++) {
      const a = massesA[i]!;
      const ax = a.world.x;
      const ay = a.world.y;
      const az = a.world.z;
      const ar = a.radius;
      for (let j = 0; j < nB; j++) {
        const b = massesB[j]!;
        const dx = b.world.x - ax;
        const dy = b.world.y - ay;
        const dz = b.world.z - az;
        const minD = ar + b.radius;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= minD * minD) continue;
        a.clipping = true;
        b.clipping = true;
        sphereHit(a, b);
      }
    }
  }

  stepStructure(dt: number): void {
    if (!this.massActive) return;
    this.elapsed += dt;
    const slices = Math.max(1, Math.min(4, Math.round(dt * 240)));
    const h = dt / slices;
    for (let s = 0; s < slices; s++) this.stepMassSlice(h);
    this.updateDrivetrain();
  }

  followGroup(group: THREE.Object3D, velocityOut: THREE.Vector3, angularOut: THREE.Vector3, dt: number): void {
    const cell = this.massByName("cell");
    const engL = this.massByName("engineL");
    const engR = this.massByName("engineR");
    const axle = this.massByName("axleR");
    const fx = (engL.world.x + engR.world.x) * 0.5 - axle.world.x;
    const fy = (engL.world.y + engR.world.y) * 0.5 - axle.world.y;
    const fz = (engL.world.z + engR.world.z) * 0.5 - axle.world.z;
    const yawLen = Math.hypot(fx, fz);
    const yaw = yawLen > 0.15 ? Math.atan2(fx, fz) : this.prevYaw;
    const pitch = THREE.MathUtils.clamp(Math.atan2(-fy, Math.max(yawLen, 0.15)), -0.2, 0.22);
    const roll = THREE.MathUtils.clamp((engR.world.y - engL.world.y) * 0.55, -0.5, 0.5);
    const yawSafe = Number.isFinite(yaw) ? yaw : this.prevYaw;
    const plant = !this.bidirectional && this.quietTime() > 0.2;
    let minHub = Infinity;
    for (const m of this.masses) if (m.name.startsWith("hub") && m.world.y < minHub) minHub = m.world.y;
    if (plant) {
      group.rotation.set(0, yawSafe, 0, "YXZ");
      group.updateMatrixWorld();
      let hubX = 0,
        hubZ = 0,
        hubM = 0,
        restx = 0,
        restz = 0;
      for (const m of this.masses) {
        if (!m.name.startsWith("hub")) continue;
        hubX += m.world.x * m.mass;
        hubZ += m.world.z * m.mass;
        restx += m.rest.x * m.mass;
        restz += m.rest.z * m.mass;
        hubM += m.mass;
      }
      if (hubM > 1e-8) {
        hubX /= hubM;
        hubZ /= hubM;
        restx /= hubM;
        restz /= hubM;
      } else {
        hubX = cell.world.x;
        hubZ = cell.world.z;
        restx = cell.rest.x;
        restz = cell.rest.z;
      }
      _a.set(restx, cell.rest.y, restz).applyQuaternion(group.quaternion);
      let gy = cell.world.y - _a.y;
      if (minHub > 0.5) gy = THREE.MathUtils.clamp(gy, 0, 0.12);
      else gy = THREE.MathUtils.clamp(gy, 0, 0.08);
      group.position.set(hubX - _a.x, gy, hubZ - _a.z);
      if (Number.isFinite(pitch + roll) && this.quietTime() < 0.35) group.rotation.set(pitch, yawSafe, roll, "YXZ");
      else group.rotation.set(0, yawSafe, 0, "YXZ");
    } else {
      if (!Number.isFinite(yawSafe + pitch + roll)) {
        group.rotation.set(0, this.prevYaw, 0, "YXZ");
      } else {
        group.rotation.set(pitch, yawSafe, roll, "YXZ");
      }
      group.updateMatrixWorld();
      _a.copy(cell.rest).applyQuaternion(group.quaternion);
      let gy = cell.world.y - _a.y;
      if (minHub > 0.5) gy = THREE.MathUtils.clamp(gy, 0, 0.12);
      else gy = THREE.MathUtils.clamp(gy, 0, 0.08);
      if (this.bidirectional) group.position.set(0, gy, 0);
      else group.position.set(cell.world.x - _a.x, gy, cell.world.z - _a.z);
    }
    group.updateMatrixWorld();

    let mx = 0,
      my = 0,
      mz = 0,
      mass = 0;
    for (const m of this.masses) {
      m.local.copy(m.world);
      group.worldToLocal(m.local);
      mx += m.vel.x * m.mass;
      my += m.vel.y * m.mass;
      mz += m.vel.z * m.mass;
      mass += m.mass;
    }
    this.clampLocal(group);
    let hx = 0,
      hy = 0,
      hz = 0,
      hm = 0;
    for (const m of this.masses) {
      if (!m.name.startsWith("hub")) continue;
      hx += m.vel.x * m.mass;
      hy += m.vel.y * m.mass;
      hz += m.vel.z * m.mass;
      hm += m.mass;
    }
    if (hm > 1e-6) {
      velocityOut.set(mx / mass, THREE.MathUtils.clamp(hy / hm, -3, 4), mz / mass);
    } else {
      velocityOut.set(mx / mass, 0, mz / mass);
    }
    clampSpeed(velocityOut, CRASH.maxMassMps);
    if (dt > 1e-5) {
      let dyaw = yawSafe - this.prevYaw;
      if (dyaw > Math.PI) dyaw -= Math.PI * 2;
      if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      const yawRate = THREE.MathUtils.clamp(dyaw / dt, -6, 6);
      angularOut.set(
        THREE.MathUtils.clamp(pitch * 0.4, -2, 2),
        Number.isFinite(yawRate) ? yawRate : 0,
        THREE.MathUtils.clamp(roll * 0.4, -2, 2),
      );
    }
    this.prevYaw = yawSafe;
  }

  /** Move the whole wreck, including planted hubs, so a bowl clip is not undone next frame. */
  translateMasses(dx: number, dz: number, dvx: number, dvz: number): void {
    for (const m of this.masses) {
      m.world.x += dx;
      m.world.z += dz;
      if (!m.dynamic) continue;
      m.vel.x += dvx;
      m.vel.z += dvz;
    }
  }

  /**
   * Push the passenger cell out of overlap. Crumple-zone masses stay on the
   * contact plane so the leftover penetration becomes plastic crush.
   */
  separateAlong(nx: number, ny: number, nz: number, amount: number): void {
    if (!this.massActive) return;
    for (const m of this.masses) {
      if (!m.dynamic) continue;
      const keep = 1 - this.crumpleWeight(m) * 0.88;
      m.world.x += nx * amount * keep;
      m.world.y += ny * amount * keep;
      m.world.z += nz * amount * keep;
    }
  }

  /** Kill incoming speed on the cabin only — crumple zones keep their inertia. */
  kickCore(nx: number, ny: number, nz: number, dv: number): void {
    if (!this.massActive || dv === 0) return;
    for (const m of this.masses) {
      if (!m.dynamic) continue;
      const w = 1 - this.crumpleWeight(m);
      if (w < 0.08) continue;
      m.vel.x += nx * dv * w;
      m.vel.y += ny * dv * w;
      m.vel.z += nz * dv * w;
    }
  }

  crumpleTravel(): number {
    const cell = this.massByName("cell");
    const nose = (this.massByName("bumperFL").local.z + this.massByName("bumperFR").local.z) * 0.5;
    const tail = (this.massByName("bumperRL").local.z + this.massByName("bumperRR").local.z) * 0.5;
    return Math.max(nose - cell.local.z - 0.36, cell.local.z - tail - 0.36, 0);
  }

  /** Remaining crumple on the most-crushed corner — SAT bounce uses this so an offset hit actually spends the zone. */
  crumpleTravelCorner(): number {
    const cell = this.massByName("cell");
    const fl = this.massByName("bumperFL").local.z - cell.local.z - 0.36;
    const fr = this.massByName("bumperFR").local.z - cell.local.z - 0.36;
    const rl = cell.local.z - this.massByName("bumperRL").local.z - 0.36;
    const rr = cell.local.z - this.massByName("bumperRR").local.z - 0.36;
    return Math.max(Math.min(fl, fr), Math.min(rl, rr), 0);
  }

  kickAlong(nx: number, ny: number, nz: number, dv: number): void {
    this.kickCore(nx, ny, nz, dv);
  }

  feedOverlap(worldPoint: THREE.Vector3, inward: THREE.Vector3, overlap: number, closing: number, dt = 1 / 60): number {
    if (!this.massActive) return closing;
    this.overlapFrame = true;
    const leftover = leftoverCrumple(this.crumpleTravel());
    const s = this.squash;
    const live = s < 0.03 ? 0 : 1;
    const ke = closingKeScale(closing);
    const absorbFrac = leftover * (0.5 + s * 0.42) * live;
    const eaten = Math.max(0, closing) * absorbFrac;
    const step = THREE.MathUtils.clamp(dt / (1 / 60), 0.35, 2.8);
    // Overlap becomes local crush. Amount tracks ½mv², never (overlap/dt) velocity.
    const crush = Math.min(Math.max(0, overlap) * (0.4 + s * 0.35) * ke, 0.06 + ke * 0.2) * Math.min(1, step) * live;
    if (crush < 1e-5 && eaten < 1e-5) return closing;
    this.impulse = Math.max(this.impulse, THREE.MathUtils.clamp(closing, 0, 70));

    const cell = this.massByName("cell");
    const nose = (this.massByName("bumperFL").local.z + this.massByName("bumperFR").local.z) * 0.5;
    const tail = (this.massByName("bumperRL").local.z + this.massByName("bumperRR").local.z) * 0.5;
    const noseLeft = Math.max(0, nose - cell.local.z - 0.38);
    const tailLeft = Math.max(0, cell.local.z - tail - 0.38);
    const bumperLeft = THREE.MathUtils.clamp(Math.max(noseLeft, tailLeft) / 1.45, 0, 1);
    const passFront = this.frontTransfer();

    for (const m of this.masses) {
      if (!m.dynamic) continue;
      if (m.name.startsWith("hub") && !m.popped && !this.deepCrush) continue;
      const zone = this.impactWeight(m);
      if (zone < 0.04) continue;
      const d = m.world.distanceTo(worldPoint);
      const reach = 1.05 + s * 0.35;
      if (d > reach) continue;
      const fall = (1 - d / reach) ** 2 * zone;
      const soft = regionSoftness(m.name);
      const gate = this.bidirectional ? 1 : crushGate(closing, soft) * live;
      if (gate < 1e-4) continue;
      const engine = m.name === "engineL" || m.name === "engineR";
      const engineGate = engine ? (bumperLeft > 0.55 ? 0.4 : 1) : 1;
      const pass = this.crumpleWeight(m) < 0.45 ? passFront : 1;
      const posNibble = crush * fall * gate * soft * engineGate * pass;
      m.world.addScaledVector(inward, posNibble);
      const vn = m.vel.dot(inward);
      // Plastic: kill inbound speed. Never add (crush/dt) — that rockets in slomo.
      if (vn < 0) m.vel.addScaledVector(inward, -vn * Math.min(1, fall * 0.85 + gate * 0.15));
    }
    return Math.max(0, closing - eaten);
  }

  applyImpact(localPoint: THREE.Vector3, localInward: THREE.Vector3, impulse: number): void {
    this.impactLocal.copy(localPoint);
    this.impactInward.copy(localInward).normalize();
    this.impulse = THREE.MathUtils.clamp(impulse, 4, 70);
    this.crushing = true;
    this.dirty = true;
  }

  update(simDt: number, geometry: THREE.BufferGeometry): void {
    this.skinnedThisFrame = false;
    if (this.crushing) {
      this.pullSensorsFromMasses(simDt);

      let maxC = 0;
      for (const s of this.sensors) if (s.compression > maxC) maxC = s.compression;
      this.crushAmount = maxC;
      this.wrinkleAmp = THREE.MathUtils.clamp(maxC * (0.2 + this.buckle * 0.5), 0, 0.18 + this.buckle * 0.5);

      if (this.mode === "shape") this.bakeLocalSkin();
      this.solveCages();
      this.skin(geometry);
      // Plastic leftover (maxC) is not "still crushing". Keep skinning while
      // masses are live or contact is fresh — otherwise we rewrite the mesh
      // from a jittering polar every frame (flicker) and pay computeVertexNormals
      // through the slomo→1× handoff (hitch).
      // Contact window only. Residual bounce / cluster breathing is not crush —
      // reskinning it every frame is the polar snap-back flicker.
      this.crushing = this.bidirectional || this.quietTime() < 0.28;
    }
    if (this.helper?.visible) this.updateHelper();
  }

  private anyMassMoving(): boolean {
    // World COM velocity is rigid slide, not crumple. Overlapping clusters
    // used to keep solving while the wreck translated, which walks the COM.
    let mx = 0,
      my = 0,
      mz = 0,
      msum = 0;
    for (let i = 0, n = this.masses.length; i < n; i++) {
      const m = this.masses[i]!;
      if (!m.dynamic) continue;
      mx += m.vel.x * m.mass;
      my += m.vel.y * m.mass;
      mz += m.vel.z * m.mass;
      msum += m.mass;
    }
    if (msum < 1e-8) return false;
    mx /= msum;
    my /= msum;
    mz /= msum;
    for (let i = 0, n = this.masses.length; i < n; i++) {
      const m = this.masses[i]!;
      if (!m.dynamic || m.name.startsWith("hub")) continue;
      const dx = m.vel.x - mx;
      const dy = m.vel.y - my;
      const dz = m.vel.z - mz;
      if (dx * dx + dy * dy + dz * dz > 0.09) return true;
    }
    return false;
  }

  liveHulls(frontDetached = false, rearDetached = false): { cx: number; cz: number; hx: number; hz: number }[] {
    void frontDetached;
    void rearDetached;
    const fallback = [
      { cx: -0.38, cz: 1.22, hx: 0.34, hz: 0.34 },
      { cx: 0.38, cz: 1.22, hx: 0.34, hz: 0.34 },
      { cx: 0, cz: 0.12, hx: 0.86, hz: 0.92 },
      { cx: -0.38, cz: -1.22, hx: 0.34, hz: 0.34 },
      { cx: 0.38, cz: -1.22, hx: 0.34, hz: 0.34 },
    ];
    const cell = this.massByName("cell");
    const engineL = this.massByName("engineL");
    const engineR = this.massByName("engineR");
    const doorL = this.massByName("doorL");
    const doorR = this.massByName("doorR");
    const axleR = this.massByName("axleR");
    const hubFL = this.massByName("hubFL");
    const hubFR = this.massByName("hubFR");
    const hubRL = this.massByName("hubRL");
    const hubRR = this.massByName("hubRR");

    const engineZ = (engineL.local.z + engineR.local.z) * 0.5;
    const zFront = engineZ + 0.36;
    const zFrontBack = engineZ - 0.12;
    const zRear = axleR.local.z - 0.36;
    const zRearFront = axleR.local.z + 0.12;
    const hzF = Math.max(0.12, (zFront - zFrontBack) * 0.5);
    const hzR = Math.max(0.12, (zRearFront - zRear) * 0.5);
    const midHx = THREE.MathUtils.clamp(
      Math.max(Math.abs(doorL.local.x), Math.abs(doorR.local.x)) + 0.02,
      0.48,
      0.8,
    );

    return this.sanitizeHulls(
      [
        {
          cx: (hubFL.local.x + engineL.local.x) * 0.5,
          cz: (zFront + zFrontBack) * 0.5,
          hx: 0.32,
          hz: hzF,
        },
        {
          cx: (hubFR.local.x + engineR.local.x) * 0.5,
          cz: (zFront + zFrontBack) * 0.5,
          hx: 0.32,
          hz: hzF,
        },
        {
          cx: cell.local.x,
          cz: (zFrontBack + zRearFront) * 0.5,
          hx: midHx,
          hz: Math.max(0.12, (zFrontBack - zRearFront) * 0.5),
        },
        {
          cx: (hubRL.local.x + axleR.local.x) * 0.5,
          cz: (zRear + zRearFront) * 0.5,
          hx: 0.32,
          hz: hzR,
        },
        {
          cx: (hubRR.local.x + axleR.local.x) * 0.5,
          cz: (zRear + zRearFront) * 0.5,
          hx: 0.32,
          hz: hzR,
        },
      ],
      fallback,
    );
  }

  liveCrushHulls(frontDetached = false, rearDetached = false): { cx: number; cz: number; hx: number; hz: number }[] {
    const fallback = [
      { cx: -0.42, cz: 1.72, hx: 0.36, hz: 0.5 },
      { cx: 0.42, cz: 1.72, hx: 0.36, hz: 0.5 },
      { cx: 0, cz: 0.12, hx: 0.86, hz: 0.92 },
      { cx: -0.42, cz: -1.6, hx: 0.36, hz: 0.58 },
      { cx: 0.42, cz: -1.6, hx: 0.36, hz: 0.58 },
    ];
    const fl = this.massByName("bumperFL");
    const fr = this.massByName("bumperFR");
    const rl = this.massByName("bumperRL");
    const rr = this.massByName("bumperRR");
    const cell = this.massByName("cell");
    const engineL = this.massByName("engineL");
    const engineR = this.massByName("engineR");
    const doorL = this.massByName("doorL");
    const doorR = this.massByName("doorR");
    const axleR = this.massByName("axleR");

    const engineZ = (engineL.local.z + engineR.local.z) * 0.5;
    const zFront = frontDetached ? engineZ + 0.34 : Math.max(fl.local.z, fr.local.z) + 0.12;
    const zFrontBack = Math.min(engineZ, zFront - 0.18);
    const zRear = rearDetached ? axleR.local.z - 0.28 : Math.min(rl.local.z, rr.local.z) - 0.12;
    const zRearFront = Math.max(axleR.local.z, zRear + 0.18);
    const hzF = Math.max(0.12, (zFront - zFrontBack) * 0.5);
    const hzR = Math.max(0.12, (zRearFront - zRear) * 0.5);
    const midHx = THREE.MathUtils.clamp(
      Math.max(Math.abs(doorL.local.x), Math.abs(doorR.local.x)) + 0.02,
      0.48,
      0.8,
    );

    return this.sanitizeHulls(
      [
        {
          cx: fl.local.x * 0.85,
          cz: (zFront + zFrontBack) * 0.5,
          hx: 0.34,
          hz: hzF,
        },
        {
          cx: fr.local.x * 0.85,
          cz: (zFront + zFrontBack) * 0.5,
          hx: 0.34,
          hz: hzF,
        },
        {
          cx: cell.local.x,
          cz: (zFrontBack + zRearFront) * 0.5,
          hx: midHx,
          hz: Math.max(0.12, (zFrontBack - zRearFront) * 0.5),
        },
        {
          cx: rl.local.x * 0.85,
          cz: (zRear + zRearFront) * 0.5,
          hx: 0.34,
          hz: hzR,
        },
        {
          cx: rr.local.x * 0.85,
          cz: (zRear + zRearFront) * 0.5,
          hx: 0.34,
          hz: hzR,
        },
      ],
      fallback,
    );
  }

  private sanitizeHulls(
    hulls: { cx: number; cz: number; hx: number; hz: number }[],
    fallback: { cx: number; cz: number; hx: number; hz: number }[],
  ): { cx: number; cz: number; hx: number; hz: number }[] {
    for (let i = 0; i < hulls.length; i++) {
      const h = hulls[i]!;
      if (!Number.isFinite(h.cx) || !Number.isFinite(h.cz) || !Number.isFinite(h.hx) || !Number.isFinite(h.hz)) {
        hulls[i] = fallback[i]!;
      }
    }
    return hulls;
  }

  skinPanel(geometry: THREE.BufferGeometry, rest: Float32Array, name: BodyPartName, origin: THREE.Vector3): void {
    const cage = this.cages.find((c) => c.spec.name === name);
    if (!cage) return;
    const attr = geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const sx = cage.size.x || 1;
    const sy = cage.size.y || 1;
    const sz = cage.size.z || 1;
    for (let i = 0; i < attr.count; i++) {
      const x = rest[i * 3]! + origin.x;
      const y = rest[i * 3 + 1]! + origin.y;
      const z = rest[i * 3 + 2]! + origin.z;
      const u = THREE.MathUtils.clamp((x - cage.min.x) / sx, -0.15, 1.15);
      const v = THREE.MathUtils.clamp((y - cage.min.y) / sy, -0.15, 1.15);
      const w = THREE.MathUtils.clamp((z - cage.min.z) / sz, -0.15, 1.15);
      trilinear(cage.corners, u, v, w, _d);
      arr[i * 3] = _d.x - origin.x;
      arr[i * 3 + 1] = _d.y - origin.y;
      arr[i * 3 + 2] = _d.z - origin.z;
    }
    attr.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  createHelper(parent: THREE.Object3D): THREE.Group {
    if (this.helper) return this.helper;
    const group = new THREE.Group();
    group.name = "deform-rig";
    const sphereGeo = new THREE.SphereGeometry(0.045, 10, 8);
    for (const s of this.sensors) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xb9c4d4,
        transparent: true,
        opacity: 0.7,
        depthTest: false,
      });
      const mesh = new THREE.Mesh(sphereGeo, mat);
      mesh.position.copy(s.rest);
      mesh.renderOrder = 3;
      group.add(mesh);
      this.helperSpheres.push(mesh);
    }
    const massGeo = new THREE.SphereGeometry(0.055, 10, 8);
    for (const m of this.masses) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xd4894a,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
      });
      const mesh = new THREE.Mesh(massGeo, mat);
      mesh.position.copy(m.local);
      mesh.renderOrder = 4;
      group.add(mesh);
      this.massHelperMeshes.push(mesh);
    }
    const linePos = new Float32Array(this.cages.length * 12 * 2 * 3);
    this.helperLinePos = linePos;
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
    const lineMat = new THREE.LineBasicMaterial({
      color: 0xd8d4cc,
      transparent: true,
      opacity: 0.35,
      depthTest: false,
    });
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    lines.renderOrder = 2;
    group.add(lines);
    this.helperLines = lines;
    const beamPos = new Float32Array(this.beams.length * 2 * 3);
    const beamColor = new Float32Array(this.beams.length * 2 * 3);
    this.beamHelperPos = beamPos;
    this.beamHelperColor = beamColor;
    const beamGeo = new THREE.BufferGeometry();
    beamGeo.setAttribute("position", new THREE.BufferAttribute(beamPos, 3));
    beamGeo.setAttribute("color", new THREE.BufferAttribute(beamColor, 3));
    const beamMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      depthTest: false,
    });
    const beamLines = new THREE.LineSegments(beamGeo, beamMat);
    beamLines.renderOrder = 3;
    group.add(beamLines);
    this.beamHelperLines = beamLines;
    let star = 0;
    for (const c of this.clusters) star += c.idx.length;
    const clusterPos = new Float32Array(Math.max(star, 1) * 2 * 3);
    const clusterCol = new Float32Array(Math.max(star, 1) * 2 * 3);
    this.clusterHelperPos = clusterPos;
    this.clusterHelperColor = clusterCol;
    const clusterGeo = new THREE.BufferGeometry();
    clusterGeo.setAttribute("position", new THREE.BufferAttribute(clusterPos, 3));
    clusterGeo.setAttribute("color", new THREE.BufferAttribute(clusterCol, 3));
    const clusterMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    });
    const clusterLines = new THREE.LineSegments(clusterGeo, clusterMat);
    clusterLines.renderOrder = 4;
    group.add(clusterLines);
    this.clusterHelperLines = clusterLines;
    this.helper = group;
    this.writeCageLines();
    this.writeBeamLines();
    this.writeClusterLines();
    this.syncHelperMode();
    parent.add(group);
    group.visible = false;
    return group;
  }

  setHelperVisible(v: boolean): void {
    if (this.helper) this.helper.visible = v;
    if (v) this.updateHelper();
  }

  disposeHelper(): void {
    if (!this.helper) return;
    this.helper.removeFromParent();
    this.helper.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        if (obj.material instanceof THREE.Material) obj.material.dispose();
      }
      if (obj instanceof THREE.LineSegments) {
        obj.geometry.dispose();
        if (obj.material instanceof THREE.Material) obj.material.dispose();
      }
    });
    this.helperSpheres[0]?.geometry.dispose();
    this.massHelperMeshes[0]?.geometry.dispose();
    this.helper = null;
    this.helperLines = null;
    this.helperSpheres = [];
    this.massHelperMeshes = [];
    this.beamHelperLines = null;
    this.beamHelperPos = null;
    this.beamHelperColor = null;
    this.clusterHelperLines = null;
    this.clusterHelperPos = null;
    this.clusterHelperColor = null;
  }

  get impulseValue(): number {
    return this.impulse;
  }

  get crushElapsed(): number {
    return this.elapsed;
  }

  partCompression(name: BodyPartName): number {
    let max = 0;
    for (const s of this.sensors) {
      if (this.cages[s.partIndex]?.spec.name === name && s.compression > max) max = s.compression;
    }
    return max;
  }

  sensorCompression(index: number): number {
    return this.sensors[index]?.compression ?? 0;
  }

  cageFrame(name: BodyPartName): { center: THREE.Vector3; quat: THREE.Quaternion; restCenter: THREE.Vector3 } | null {
    const cage = this.cages.find((c) => c.spec.name === name);
    if (!cage) return null;
    const center = new THREE.Vector3();
    const restCenter = cage.center.clone();
    for (const c of cage.corners) center.add(c);
    center.multiplyScalar(0.125);
    _a.copy(cage.corners[1]!).sub(cage.corners[0]!).normalize();
    _b.copy(cage.corners[2]!).sub(cage.corners[0]!);
    _c.copy(_a).cross(_b);
    if (_c.lengthSq() < 1e-8) _c.copy(cage.corners[4]!).sub(cage.corners[0]!);
    _c.normalize();
    _b.copy(_c).cross(_a).normalize();
    _mat.makeBasis(_a, _b, _c);
    const quat = new THREE.Quaternion().setFromRotationMatrix(_mat);
    return { center, quat, restCenter };
  }

  restoreRest(geometry: THREE.BufferGeometry): void {
    const attr = geometry.getAttribute("position") as THREE.BufferAttribute;
    (attr.array as Float32Array).set(this.restPos);
    attr.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  snapshot(): Record<string, unknown> {
    return {
      mode: this.mode,
      crush: round4(this.crushAmount),
      elapsed: round4(this.elapsed),
      quiet: round4(this.quietTime()),
      crushing: this.crushing,
      impulse: round4(this.impulse),
      massActive: this.massActive,
      drivetrainAlive: this.drivetrainAlive,
      squash: this.squash,
      buckle: this.buckle,
      impactInward: vec3(this.impactInward),
      impactLocal: vec3(this.impactLocal),
      masses: this.masses.map((m) => ({
        name: m.name,
        mass: m.mass,
        rest: vec3(m.rest),
        local: vec3(m.local),
        world: vec3(m.world),
        vel: vec3(m.vel),
        speed: round4(m.vel.length()),
        travel: round4(m.local.distanceTo(m.rest)),
        transfer: round4(this.nodeTransfer(m)),
        packed: this.nodePacked(m),
        popped: m.popped,
      })),
      beams: this.beams.map((beam) => {
        const a = this.masses[beam.a]!;
        const b = this.masses[beam.b]!;
        const len = a.world.distanceTo(b.world);
        return {
          a: a.name,
          b: b.name,
          rest: round4(beam.rest),
          plastic: round4(beam.plastic),
          minLen: round4(beam.minLen),
          alive: beam.alive,
          len: round4(len),
          strain: round4((len - beam.rest) / Math.max(beam.rest, 1e-4)),
        };
      }),
      sensors: this.sensors.map((s) => ({
        part: s.spec.part,
        compression: round4(s.compression),
      })),
      clusters: this.clusters.map((c) => ({
        n: c.idx.length,
        names: c.idx.map((i) => this.masses[i]!.name),
        cm: { x: round4(c.cmx), y: round4(c.cmy), z: round4(c.cmz) },
        plastic: round4(c.Sp[0]! + c.Sp[4]! + c.Sp[8]!),
      })),
    };
  }

  massMaxAbsZ(): number {
    let m = 0;
    for (const n of this.masses) {
      if (!n.dynamic) continue;
      m = Math.max(m, Math.abs(n.world.z) - n.radius * 0.72, Math.abs(n.local.z) - n.radius * 0.72);
    }
    return m;
  }

  cageMaxAbsZ(): number {
    let m = 0;
    for (const cage of this.cages) {
      for (const pt of cage.corners) m = Math.max(m, Math.abs(pt.z));
    }
    return m;
  }

  skinMaxAbsZ(geometry: THREE.BufferGeometry): number {
    const attr = geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    let m = 0;
    for (let i = 0; i < attr.count; i++) m = Math.max(m, Math.abs(arr[i * 3 + 2]!));
    return m;
  }

  private clampLocal(group: THREE.Object3D): void {
    const ix = this.impactInward.x;
    const iz = this.impactInward.z;
    const maxAway = 0.025 + this.squash * 0.04;
    const maxCrush = this.bidirectional ? 1.65 : 0.5 + this.squash * 1.15;
    for (const m of this.masses) {
      let dx = m.local.x - m.rest.x;
      let dy = m.local.y - m.rest.y;
      let dz = m.local.z - m.rest.z;
      const along = dx * ix + dz * iz;
      const side = m.rest.x * ix + m.rest.z * iz;
      if (!this.bidirectional && side > 0.12) {
        // Far side of the car: allow a little spring, never grow the shell.
        if (along > maxAway) {
          const extra = along - maxAway;
          m.local.x -= ix * extra;
          m.local.z -= iz * extra;
          dx = m.local.x - m.rest.x;
          dz = m.local.z - m.rest.z;
        }
        if (along < -maxAway * 2) {
          const extra = -along - maxAway * 2;
          m.local.x += ix * extra;
          m.local.z += iz * extra;
          dx = m.local.x - m.rest.x;
          dz = m.local.z - m.rest.z;
        }
      }
      const maxDy =
        m.name === "roof"
          ? this.deepCrush
            ? 0.28
            : 0.07
          : m.name.startsWith("hub")
            ? 0.07
            : m.name === "cell"
              ? this.deepCrush
                ? 0.22
                : 0.06
              : 0.11;
      dy = THREE.MathUtils.clamp(dy, -maxDy, maxDy * 1.25);
      const cw = this.bidirectional ? 1 : this.cornerWeight(m);
      const cap =
        m.name === "cell" || m.name === "roof"
          ? this.deepCrush
            ? 0.72
            : 0.12
          : m.name.startsWith("hub")
            ? this.bidirectional
              ? 0.95
              : 0.38
            : maxCrush * (0.38 + 0.72 * cw);
      const len = Math.hypot(dx, dz);
      if (len > cap) {
        const k = cap / len;
        dx *= k;
        dz *= k;
      }
      const latCap = this.bidirectional ? 0.55 : 0.04 + cw * 0.07;
      if (Math.abs(dx) > latCap) dx = Math.sign(dx) * latCap;
      if (m.name.startsWith("hub") && !this.deepCrush) {
        const popAt = m.radius * 0.5;
        const travel = Math.hypot(dx, dz);
        if (!m.popped && travel > popAt) m.popped = true;
        if (!m.popped) {
          dx = 0;
          dz = 0;
        }
      }
      m.local.set(m.rest.x + dx, m.rest.y + dy, m.rest.z + dz);
      if (this.bidirectional) {
        const lim = Math.abs(m.rest.z) + 0.04;
        if (Math.abs(m.local.z) > lim) m.local.z = Math.sign(m.local.z || m.rest.z) * lim;
        if (this.deepCrush && this.mode === "lattice" && m.name.startsWith("rail")) {
          if (m.local.distanceTo(m.rest) < 0.22) m.local.z = m.rest.z * 0.67;
        }
      }
      // Planted tires are the world pin. Projecting them through a pitched
      // group was ratcheting the wreck backward every followGroup.
      if (m.name.startsWith("hub") && !m.popped && !this.deepCrush && this.quietTime() > 0.2) continue;
      m.world.copy(m.local);
      group.localToWorld(m.world);
    }
  }

  private stepBeams(dt: number): void {
    for (const beam of this.beams) {
      if (!beam.alive) continue;
      const a = this.masses[beam.a]!;
      const b = this.masses[beam.b]!;
      _n.copy(b.world).sub(a.world);
      const len = _n.length();
      if (len < 1e-5) continue;
      if (len > beam.rest * 2.2) {
        beam.alive = false;
        continue;
      }
      _n.multiplyScalar(1 / len);
      const alongA = -(a.rest.x * this.impactInward.x + a.rest.z * this.impactInward.z);
      const alongB = -(b.rest.x * this.impactInward.x + b.rest.z * this.impactInward.z);
      const front = alongA >= alongB ? a : b;
      const outward = Math.abs(a.rest.z) >= Math.abs(b.rest.z) ? a : b;
      const pass = this.bidirectional ? this.nodeTransfer(outward) : this.nodeTransfer(front);
      const maxStretch = 1.12 + this.squash * 0.35;
      if (len > beam.rest * maxStretch) {
        const extra = len - beam.rest * maxStretch;
        const ima = a.dynamic ? 1 / a.mass : 0;
        const imb = b.dynamic ? 1 / b.mass : 0;
        const inv = ima + imb;
        if (inv > 1e-8) {
          if (a.dynamic) a.world.addScaledVector(_n, extra * (ima / inv));
          if (b.dynamic) b.world.addScaledVector(_n, -extra * (imb / inv));
        }
      }
      const relV = b.vel.dot(_n) - a.vel.dot(_n);
      const ext = len - beam.plastic;
      let f = 0;
      if (ext > 0) {
        f = beam.kTen * ext + beam.damp * relV;
      } else {
        f = (beam.yieldK * ext + beam.damp * relV) * pass;
        const sideA = a.rest.x * this.impactInward.x + a.rest.z * this.impactInward.z;
        const sideB = b.rest.x * this.impactInward.x + b.rest.z * this.impactInward.z;
        const farSide = !this.bidirectional && sideA > 0.12 && sideB > 0.12;
        if ((relV < 0 || this.bidirectional) && !farSide) {
          const minLen =
            this.deepCrush && this.isCageBeam(beam) ? Math.min(beam.minLen, beam.rest * 0.22) : beam.minLen;
          const shrink = -ext * Math.min(1, Math.max(dt * (this.deepCrush ? 14 : 8.5), 0.03 + this.squash * 0.06));
          beam.plastic = Math.max(minLen, beam.plastic - shrink);
        }
      }
      const ima = a.dynamic ? 1 / a.mass : 0;
      const imb = b.dynamic ? 1 / b.mass : 0;
      if (a.dynamic) a.vel.addScaledVector(_n, f * ima * dt);
      if (b.dynamic) b.vel.addScaledVector(_n, -f * imb * dt);
    }
  }

  private clusterBeta(ci: number, contacting: boolean): number {
    const absorb = ci < this.cages.length ? this.cages[ci]!.spec.absorption : 0.1;
    if (this.squash < 0.03) return 0.04;
    // Müller T = (1-β)R + βA. High β is jelly stretch. Bugbear/Rajala: metal
    // wants rotation + plastic rest update, not a linear squash of the whole cell.
    if (contacting) return THREE.MathUtils.lerp(0.18 + this.squash * 0.22, 0.03, THREE.MathUtils.clamp(absorb, 0, 1));
    return deformBeta(this.squash) * (1 - absorb * 0.5);
  }

  private stepShapeMatch(dt: number): void {
    this.syncShapeFromMasses();
    const contacting = this.overlapFrame || this.bidirectional;
    this.overlapFrame = false;
    let comX = 0,
      comY = 0,
      comZ = 0,
      comM = 0;
    for (let i = 0; i < this.shapeParticles.length; i++) {
      const hub = this.masses[i]!;
      if (hub.name.startsWith("hub") && !this.deepCrush) continue;
      const p = this.shapeParticles[i]!;
      comX += p.x * p.mass;
      comY += p.y * p.mass;
      comZ += p.z * p.mass;
      comM += p.mass;
    }
    comM = Math.max(comM, 1e-8);
    const alpha = contacting
      ? this.squash < 0.03
        ? 0.9
        : 0.32 + this.squash * 0.38
      : goalAlpha(this.squash);
    const iters = contacting ? 2 : stiffnessIters(this.squash);
    const ix = this.impactInward.x;
    const iz = this.impactInward.z;
    for (let k = 0; k < iters; k++) {
      this.goalX.fill(0);
      this.goalY.fill(0);
      this.goalZ.fill(0);
      this.goalW.fill(0);
      for (let ci = 0; ci < this.clusters.length; ci++) {
        const c = this.clusters[ci]!;
        matchCluster(c, this.shapeParticles, this.clusterBeta(ci, contacting));
        const cw = 1;
        for (let i = 0; i < c.idx.length; i++) {
          const pi = c.idx[i]!;
          const gx = c.M[0]! * c.qx[i]! + c.M[1]! * c.qy[i]! + c.M[2]! * c.qz[i]! + c.cmx;
          const gy = c.M[3]! * c.qx[i]! + c.M[4]! * c.qy[i]! + c.M[5]! * c.qz[i]! + c.cmy;
          const gz = c.M[6]! * c.qx[i]! + c.M[7]! * c.qy[i]! + c.M[8]! * c.qz[i]! + c.cmz;
          this.goalX[pi]! += gx * cw;
          this.goalY[pi]! += gy * cw;
          this.goalZ[pi]! += gz * cw;
          this.goalW[pi]! += cw;
        }
      }
      for (let i = 0; i < this.shapeParticles.length; i++) {
        const p = this.shapeParticles[i]!;
        const hub = this.masses[i]!;
        if (hub.name.startsWith("hub") && !this.deepCrush) continue;
        const w = this.goalW[i]!;
        if (w < 1e-6) continue;
        let gx = this.goalX[i]! / w;
        let gy = this.goalY[i]! / w;
        let gz = this.goalZ[i]! / w;
        if (!Number.isFinite(gx + gy + gz)) continue;
        if (this.bidirectional) {
          gy = p.y;
          // Plates already pin the bumpers; don't let shape-match shove them deeper.
          // Cabin / rails must still be allowed to yield once the plates pass the hubs.
          if (hub.name.startsWith("bumper") && Math.abs(gz) < Math.abs(p.z)) gz = p.z;
        } else {
          const along = (gx - p.x) * ix + (gz - p.z) * iz;
          if (along < 0) {
            gx -= ix * along;
            gz -= iz * along;
          }
        }
        const ax0 = alpha * (gx - p.x);
        const ay0 = alpha * (gy - p.y);
        const az0 = alpha * (gz - p.z);
        const step = Math.hypot(ax0, ay0, az0);
        const kStep = step > 0.14 ? 0.14 / step : 1;
        const ax = ax0 * kStep;
        const ay = ay0 * kStep;
        const az = az0 * kStep;
        p.x += ax;
        p.y += ay;
        p.z += az;
      }
    }
    if (!contacting) {
      let comX1 = 0,
        comY1 = 0,
        comZ1 = 0;
      for (let i = 0; i < this.shapeParticles.length; i++) {
        const hub = this.masses[i]!;
        if (hub.name.startsWith("hub") && !this.deepCrush) continue;
        const p = this.shapeParticles[i]!;
        comX1 += p.x * p.mass;
        comY1 += p.y * p.mass;
        comZ1 += p.z * p.mass;
      }
      const dx = (comX - comX1) / comM;
      const dy = (comY - comY1) / comM;
      const dz = (comZ - comZ1) / comM;
      if (dx * dx + dy * dy + dz * dz > 1e-16) {
        for (let i = 0; i < this.shapeParticles.length; i++) {
          const hub = this.masses[i]!;
          if (hub.name.startsWith("hub") && !this.deepCrush) continue;
          const p = this.shapeParticles[i]!;
          p.x += dx;
          p.y += dy;
          p.z += dz;
        }
      }
    }
    if (contacting) {
      for (const c of this.clusters) applyPlasticity(c, this.shapeParticles, dt, this.squash, true, this.buckle);
    }
    this.writeShapeToMasses();
  }

  /** Plates past the hubs: cabin must actually yield, not stay a rigid Müller cell. */
  private foldCabin(dt: number): void {
    const k = Math.min(1, dt * 3.6);
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      const p = this.shapeParticles[i];
      if (m.name === "cell") {
        const ty = m.rest.y - 0.22;
        const tz = m.rest.z * 0.25;
        m.world.y += (ty - m.world.y) * k;
        m.world.z += (tz - m.world.z) * k;
        m.local.y += (ty - m.local.y) * k;
        m.local.z += (tz - m.local.z) * k;
        if (p) {
          p.y = m.world.y;
          p.z = m.world.z;
        }
      } else if (m.name === "roof") {
        const ty = m.rest.y - 0.15;
        m.world.y += (ty - m.world.y) * k;
        m.local.y += (ty - m.local.y) * k;
        if (p) p.y = m.world.y;
      }
    }
  }

  private nudgeLatticeRails(dt: number): void {
    const k = Math.min(1, dt * 2.2);
    for (const m of this.masses) {
      if (!m.name.startsWith("rail")) continue;
      if (m.local.distanceTo(m.rest) >= 0.22) continue;
      const tz = m.rest.z * 0.68;
      m.world.z += (tz - m.world.z) * k;
      m.local.z += (tz - m.local.z) * k;
    }
  }

  private stepMassSlice(dt: number): void {
    const live = this.bidirectional || this.quietTime() < 0.35;
    if (this.mode === "shape") {
      if (live) this.stepShapeMatch(dt);
    } else this.stepBeams(dt);

    this.stepSuspension(dt);

    for (const m of this.masses) {
      if (!m.dynamic) continue;
      const hub = m.name.startsWith("hub");
      if (hub) m.vel.y -= 9.6 * dt;
      else if (m.vel.y < 0) m.vel.y *= Math.pow(0.12, dt);
      const quiet = this.quietTime();
      // During contact: almost no extra damping so crumple can run.
      // After the last collision, ease into rest over a few seconds.
      let rate = 0.988;
      if (quiet > 0.12) {
        const t = THREE.MathUtils.clamp((quiet - 0.12) / 1.8, 0, 1);
        const s = t * t * (3 - 2 * t);
        rate = THREE.MathUtils.lerp(0.96, 0.18, s);
      }
      m.vel.multiplyScalar(Math.pow(rate, dt));
      clampSpeed(m.vel);
      if (quiet > 2.4 && m.vel.lengthSq() < 0.08) m.vel.set(0, 0, 0);
      m.world.addScaledVector(m.vel, dt);
      if (!Number.isFinite(m.world.x + m.world.y + m.world.z)) {
        m.world.copy(m.rest);
        m.vel.set(0, 0, 0);
      }
      if (hub) {
        if (m.world.y < 0.28) {
          m.world.y = 0.28;
          if (m.vel.y < 0) m.vel.y = 0;
        }
        const mu = !this.drivetrainAlive
          ? CRASH.muSlide
          : leftoverCrumple(this.crumpleTravel()) > 0.28
            ? CRASH.muScuff
            : CRASH.muSlide;
        applyGroundFriction(m.vel, dt, mu, true);
      } else {
        if (m.world.y < 0.16) {
          m.world.y = 0.16;
          if (m.vel.y < 0) m.vel.y *= -0.22;
        }
        if (quiet > 0.12) {
          const grab = THREE.MathUtils.clamp((quiet - 0.12) / 0.45, 0, 1);
          applyGroundFriction(m.vel, dt, CRASH.muSlide * grab, true);
        } else if (m.world.y < 0.16) {
          applyGroundFriction(m.vel, dt, CRASH.muScuff, true);
        }
      }
      if (m.world.y > 3.4) {
        m.world.y = 3.4;
        m.vel.y = 0;
      }
      if (!hub && !this.bidirectional && m.world.y > 0.22) {
        m.vel.y = THREE.MathUtils.clamp(m.vel.y, -2.2, 3);
      }
    }
    if (!live && !this.bidirectional) {
      let mx = 0,
        mz = 0,
        msum = 0;
      for (const m of this.masses) {
        if (!m.dynamic) continue;
        mx += m.vel.x * m.mass;
        mz += m.vel.z * m.mass;
        msum += m.mass;
      }
      if (msum > 1e-8) {
        mx /= msum;
        mz /= msum;
        for (const m of this.masses) {
          if (!m.dynamic) continue;
          m.vel.x = mx;
          m.vel.z = mz;
        }
      }
    }
    if (this.bidirectional && this.deepCrush) {
      if (this.mode === "shape") this.foldCabin(dt);
      else this.nudgeLatticeRails(dt);
    }
  }

  private stepSuspension(dt: number): void {
    const pairs: [MassName, MassName][] = [
      ["hubFL", "engineL"],
      ["hubFR", "engineR"],
      ["hubRL", "axleR"],
      ["hubRR", "axleR"],
    ];
    const k = 11000;
    const c = 260;
    for (const [hubName, mountName] of pairs) {
      const hub = this.massByName(hubName);
      const mount = this.massByName(mountName);
      const restDy = hub.rest.y - mount.rest.y;
      const dy = hub.world.y - mount.world.y - restDy;
      const dv = hub.vel.y - mount.vel.y;
      const f = (-k * dy - c * dv) * dt;
      if (hub.dynamic) hub.vel.y += f / hub.mass;
      if (mount.dynamic) mount.vel.y -= f / mount.mass;
    }
  }

  private pullSensorsFromMasses(dt: number): void {
    const inward = this.impactInward;
    const cap = Math.max(0.022, dt * 24);
    for (const s of this.sensors) {
      const far = s.rest.x * inward.x + s.rest.z * inward.z;
      if (!this.bidirectional && far > 0.18) continue;
      const doorOnly = s.spec.part === "doorLeft" || s.spec.part === "doorRight";
      let best = 0;
      for (const m of this.masses) {
        if (doorOnly && m.name !== "doorL" && m.name !== "doorR") continue;
        const d = s.rest.distanceTo(m.rest);
        const reach = s.spec.radius * 2.2 + 0.22;
        if (d > reach) continue;
        const fall = (1 - d / reach) ** 2;
        _a.copy(m.local).sub(m.rest);
        const along = Math.max(0, -_a.dot(inward));
        const mag = _a.length();
        const strain = (along * 1.6 + mag * 0.7) / 0.2;
        const lat = Math.abs(s.rest.x - this.impactLocal.x);
        const hitSide = Math.sign(this.impactLocal.x);
        const sensorSide = Math.sign(s.rest.x);
        const opposite = hitSide !== 0 && sensorSide !== 0 && hitSide !== sensorSide;
        best = Math.max(best, strain * fall * Math.exp(-lat * (opposite ? 3.8 : 2.4)) * (opposite ? 0.15 : 1));
      }
      const next = THREE.MathUtils.clamp(best, 0, s.spec.maxCompression);
      if (next > s.compression) s.compression = Math.min(next, s.compression + cap);
      s.pos.copy(s.rest);
      let wsum = 0;
      _d.set(0, 0, 0);
      for (const m of this.masses) {
        const dist = s.rest.distanceTo(m.rest);
        if (dist > s.spec.radius * 2.4 + 0.3) continue;
        const w = Math.exp(-dist * 1.35);
        _e.copy(m.local).sub(m.rest);
        _d.addScaledVector(_e, w);
        wsum += w;
      }
      if (wsum > 1e-6) s.pos.addScaledVector(_d, 1 / wsum);
    }
  }

  private bakeLocalSkin(): void {
    for (let ci = 0; ci < this.clusters.length; ci++) {
      matchSkinLocal(this.clusters[ci]!, this.skinRest, this.skinLocal, this.skinMassN, this.clusterBeta(ci, this.crushing || this.bidirectional));
    }
  }

  private solveCagesFromShape(): void {
    for (const cage of this.cages) {
      for (let i = 0; i < 8; i++) {
        const rest = cage.restCorners[i]!;
        const corner = cage.corners[i]!;
        let px = 0,
          py = 0,
          pz = 0,
          wsum = 0;
        for (let ci = 0; ci < this.clusters.length; ci++) {
          const c = this.clusters[ci]!;
          const dx = rest.x - c.skinCm0x;
          const dy = rest.y - c.skinCm0y;
          const dz = rest.z - c.skinCm0z;
          const d = Math.hypot(dx, dy, dz);
          if (d > 1.4) continue;
          const w = Math.exp(-d * 2.35);
          const p = transformSkinPointInto(c, rest.x, rest.y, rest.z);
          px += p.x * w;
          py += p.y * w;
          pz += p.z * w;
          wsum += w;
        }
        if (wsum > 1e-6) corner.set(px / wsum, py / wsum, pz / wsum);
        else corner.copy(rest);
      }
    }
    this.capCageCorners();
    if (this.bidirectional) this.fitCagesToMasses();
  }

  private solveCages(): void {
    if (this.mode === "shape") {
      this.solveCagesFromShape();
      return;
    }
    const inward = this.impactInward;
    const ramp = THREE.MathUtils.clamp(this.elapsed / 0.08, 0.45, 1);

    for (const cage of this.cages) {
      for (let i = 0; i < 8; i++) {
        const rest = cage.restCorners[i]!;
        const corner = cage.corners[i]!;
        corner.copy(rest);
        let wsum = 0;
        _d.set(0, 0, 0);
        for (const m of this.masses) {
          if (m.name.startsWith("hub") && !m.popped) continue;
          const dist = rest.distanceTo(m.rest);
          if (dist > 1.15) continue;
          const w = Math.exp(-dist * 3.2);
          _e.copy(m.local).sub(m.rest);
          _d.addScaledVector(_e, w);
          wsum += w;
        }
        if (wsum > 1e-6) {
          const lid = cage.spec.name === "bonnet" || cage.spec.name === "boot" || cage.spec.name.startsWith("glass");
          // Follow live masses. A far-side 0.12 scale left rest-sized cages
          // sticking through walls / the other car.
          const scale = lid && !this.bidirectional ? 0.45 : 1;
          corner.addScaledVector(_d, scale / wsum);
        }
      }
    }

    if (!this.bidirectional) for (const s of this.sensors) {
      if (s.compression < 0.015) continue;
      const cage = this.cages[s.partIndex]!;
      const amount = s.compression * cage.spec.maxCrush * 0.95 * ramp;
      const hinge = cage.spec.maxAngle * s.compression * 0.95 * ramp;
      _axis.copy(inward).cross(_a.set(0, 1, 0));
      if (_axis.lengthSq() < 1e-6) _axis.set(1, 0, 0);
      _axis.normalize();
      _q.setFromAxisAngle(_axis, hinge);
      const pivot = _c.copy(cage.center).addScaledVector(inward, cage.size.length() * 0.28);
      for (let i = 0; i < 8; i++) {
        const rest = cage.restCorners[i]!;
        const corner = cage.corners[i]!;
        const dist = rest.distanceTo(s.rest);
        const fall = Math.exp(-dist * 1.35);
        const lat = Math.abs(rest.x - this.impactLocal.x);
        const hitSide = Math.sign(this.impactLocal.x);
        const restSide = Math.sign(rest.x);
        const opposite = hitSide !== 0 && restSide !== 0 && hitSide !== restSide;
        const cornerFall = fall * Math.exp(-lat * (opposite ? 3.6 : 2.2)) * (opposite ? 0.14 : 1);
        const lid = cage.spec.name === "bonnet" || cage.spec.name === "boot";
        if (lid) {
          const alongCage = cage.spec.name === "bonnet"
            ? (rest.z - cage.min.z) / Math.max(cage.size.z, 1e-4)
            : (cage.max.z - rest.z) / Math.max(cage.size.z, 1e-4);
          const pop = amount * cornerFall * Math.sin(THREE.MathUtils.clamp(alongCage, 0, 1) * Math.PI) * (0.45 + this.buckle * 0.9);
          corner.y += pop * 0.85;
          corner.x += Math.sign(rest.x || 1) * pop * 0.18;
          corner.z += inward.z * amount * cornerFall * alongCage * 0.25;
        } else if (rest.x * inward.x + rest.z * inward.z < 0.12) {
          corner.addScaledVector(inward, amount * cornerFall * this.squash);
        }
        _e.copy(rest).sub(cage.center);
        const along = _e.dot(inward);
        const crease = Math.sin(along * 9 + s.compression * 4) * s.compression * (lid ? 0.04 : 0.08) * cornerFall;
        if (lid) corner.y += Math.abs(crease) * 0.6;
        else corner.addScaledVector(inward, crease);
        const name = cage.spec.name;
        const keepFrame = name === "chassisCell" || name === "roof" || name === "chassisFront" || name === "chassisRear";
        if (!keepFrame) {
          _f.copy(corner).sub(pivot).applyQuaternion(_q).add(pivot);
          corner.lerp(_f, Math.min(1, fall * (lid ? 0.95 : 0.45)));
        }
      }
    }

    this.capCageCorners();
    if (this.bidirectional) this.fitCagesToMasses();
  }

  private capCageCorners(): void {
    let maxTravel = 0;
    for (const m of this.masses) maxTravel = Math.max(maxTravel, m.local.distanceTo(m.rest));
    for (const cage of this.cages) {
      const isCell = cage.spec.name === "chassisCell" || cage.spec.name === "roof";
      let cap: number;
      if (this.bidirectional) {
        cap = isCell && !this.deepCrush ? 0.16 : Math.max(2.2, maxTravel + 0.2);
      } else if (cage.spec.name === "chassisCell") cap = 0.1;
      else if (cage.spec.name === "roof") cap = 0.14;
      else if (cage.spec.name === "doorLeft" || cage.spec.name === "doorRight") cap = 0.28;
      else cap = Math.min(cage.spec.maxCrush * 0.9, 0.85);
      cap = Math.max(cap, maxTravel * 0.95);
      if (isCell && !this.deepCrush) cap = Math.min(cap, this.bidirectional ? 0.16 : 0.14);
      for (let i = 0; i < 8; i++) {
        const rest = cage.restCorners[i]!;
        const corner = cage.corners[i]!;
        const mag = corner.distanceTo(rest);
        if (mag > cap) corner.lerpVectors(rest, corner, cap / mag);
      }
    }
  }

  /** Cage boxes follow the live mass hull — whatever collision already resolved. */
  private fitCagesToMasses(): void {
    let minZ = Infinity,
      maxZ = -Infinity,
      minX = Infinity,
      maxX = -Infinity;
    for (const m of this.masses) {
      minZ = Math.min(minZ, m.local.z);
      maxZ = Math.max(maxZ, m.local.z);
      minX = Math.min(minX, m.local.x);
      maxX = Math.max(maxX, m.local.x);
    }
    const zPad = 0.1;
    const xPad = 0.16;
    for (const cage of this.cages) {
      for (const corner of cage.corners) {
        corner.z = THREE.MathUtils.clamp(corner.z, minZ - zPad, maxZ + zPad);
        corner.x = THREE.MathUtils.clamp(corner.x, minX - xPad, maxX + xPad);
      }
    }
  }

  private skin(geometry: THREE.BufferGeometry): void {
    const attr = geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const impact = this.impactLocal;
    const wrinkle = this.wrinkleAmp * Math.min(1, this.elapsed * 6);
    const b = this.buckle;
    const shape = this.mode === "shape";

    for (let i = 0; i < this.vertexCount; i++) {
      const rx = this.restPos[i * 3]!;
      const ry = this.restPos[i * 3 + 1]!;
      const rz = this.restPos[i * 3 + 2]!;
      let px = 0,
        py = 0,
        pz = 0;
      if (shape) {
        const ws = this.skinWeights[i]!;
        let wsum = 0;
        for (const inf of ws) {
          const p = transformSkinPointInto(this.clusters[inf.ci]!, rx, ry, rz);
          px += p.x * inf.w;
          py += p.y * inf.w;
          pz += p.z * inf.w;
          wsum += inf.w;
        }
        if (wsum < 1e-8) {
          const infs = this.influences[i]!;
          for (const inf of infs) {
            trilinear(this.cages[inf.part]!.corners, inf.u, inf.v, inf.w, _d);
            px += _d.x * inf.weight;
            py += _d.y * inf.weight;
            pz += _d.z * inf.weight;
          }
        }
      } else {
        const infs = this.influences[i]!;
        for (const inf of infs) {
          trilinear(this.cages[inf.part]!.corners, inf.u, inf.v, inf.w, _d);
          px += _d.x * inf.weight;
          py += _d.y * inf.weight;
          pz += _d.z * inf.weight;
        }
      }
      const bx = px,
        by = py,
        bz = pz;
      const dx = rx - impact.x;
      const dy = ry - impact.y;
      const dz = rz - impact.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < 0.82 && wrinkle > 0.02 && ry > 0.34) {
        const fall = Math.exp(-dist * 3.4);
        const n0 = hash01(i, 3) - 0.5;
        // Accordion folds along the crush axis (~12 cm wavelength), not a clay blob.
        // Wreckfest impact radius sweet spot is 0.3–0.5 m; 1.6 m wrinkled the whole nose.
        const wave = Math.sin(rz * 18 + n0 * 1.2);
        const amp = wrinkle * fall * 0.16 * (0.35 + b * 0.65);
        pz += wave * amp;
        py += Math.abs(wave) * amp * 0.28;
        px += Math.sign(rx || 1) * n0 * amp * 0.12;
      }
      const extra = Math.hypot(px - bx, py - by, pz - bz);
      const extraCap = 0.03 + b * 0.08;
      if (extra > extraCap) {
        const t = extraCap / extra;
        px = bx + (px - bx) * t;
        py = by + (py - by) * t;
        pz = bz + (pz - bz) * t;
      }
      const travel = Math.hypot(px - rx, py - ry, pz - rz);
      const cap = shape ? 1.35 : 2.2;
      if (travel > cap) {
        const t = cap / travel;
        px = rx + (px - rx) * t;
        py = ry + (py - ry) * t;
        pz = rz + (pz - rz) * t;
      }
      if (ry > 1.05 && !this.deepCrush) {
        py = THREE.MathUtils.clamp(py, ry - 0.1, ry + 0.08);
      }
      if (ry < 0.55) {
        for (const m of this.masses) {
          if (!m.name.startsWith("hub")) continue;
          const d = Math.hypot(rx - m.rest.x, rz - m.rest.z);
          if (d > 0.4) continue;
          const keep = m.popped ? 0.15 : 0.82;
          const hx = m.popped ? m.local.x : m.rest.x;
          const hz = m.popped ? m.local.z : m.rest.z;
          px = px * (1 - keep) + hx * keep;
          pz = pz * (1 - keep) + hz * keep;
          break;
        }
      }
      arr[i * 3] = px;
      arr[i * 3 + 1] = py;
      arr[i * 3 + 2] = pz;
    }
    attr.needsUpdate = true;
    geometry.computeVertexNormals();
    this.dirty = true;
    this.skinnedThisFrame = true;
  }

  private updateHelper(): void {
    if (!this.helper?.visible) return;
    for (let i = 0; i < this.sensors.length; i++) {
      const s = this.sensors[i]!;
      const mesh = this.helperSpheres[i];
      if (!mesh) continue;
      mesh.position.copy(s.pos);
      const c = s.compression;
      mesh.scale.setScalar(1 + c * 0.85);
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.color.setRGB(0.72 + c * 0.28, 0.75 - c * 0.45, 0.8 - c * 0.65);
    }
    for (let i = 0; i < this.masses.length; i++) {
      const mesh = this.massHelperMeshes[i];
      const m = this.masses[i];
      if (!mesh || !m) continue;
      mesh.position.copy(m.local);
      const mat = mesh.material as THREE.MeshBasicMaterial;
      const travel = m.local.distanceTo(m.rest);
      if (this.mode === "shape") mesh.scale.setScalar(1.55);
      else mesh.scale.setScalar(1);
      if (m.clipping) mat.color.setRGB(0.72, 0.22, 0.95);
      else if (travel > 0.08) mat.color.setRGB(0.95, 0.18 + travel * 0.2, 0.14);
      else if (this.mode === "shape") mat.color.setRGB(0.45, 0.85, 1);
      else mat.color.setRGB(0.83, 0.54, 0.29);
    }
    this.writeCageLines();
    this.writeBeamLines();
    this.writeClusterLines();
    this.syncHelperMode();
  }

  private syncHelperMode(): void {
    if (this.beamHelperLines) this.beamHelperLines.visible = this.mode === "lattice";
    if (this.clusterHelperLines) this.clusterHelperLines.visible = this.mode === "shape";
  }

  private writeClusterLines(): void {
    const pos = this.clusterHelperPos;
    const col = this.clusterHelperColor;
    if (!pos || !col || !this.clusterHelperLines) return;
    let o = 0;
    let c = 0;
    for (const cl of this.clusters) {
      const pe = m3FrobeniusI(cl.Sp);
      const r = 0.35 + Math.min(1, pe) * 0.6;
      const g = 0.75 - Math.min(1, pe) * 0.45;
      const b = 0.95;
      let cx = 0,
        cy = 0,
        cz = 0,
        w = 0;
      for (const pi of cl.idx) {
        const m = this.masses[pi]!;
        cx += m.local.x * m.mass;
        cy += m.local.y * m.mass;
        cz += m.local.z * m.mass;
        w += m.mass;
      }
      w = Math.max(w, 1e-6);
      cx /= w;
      cy /= w;
      cz /= w;
      for (const pi of cl.idx) {
        const m = this.masses[pi]!;
        pos[o++] = m.local.x;
        pos[o++] = m.local.y;
        pos[o++] = m.local.z;
        pos[o++] = cx;
        pos[o++] = cy;
        pos[o++] = cz;
        col[c++] = r;
        col[c++] = g;
        col[c++] = b;
        col[c++] = r;
        col[c++] = g;
        col[c++] = b;
      }
    }
    const attr = this.clusterHelperLines.geometry.getAttribute("position") as THREE.BufferAttribute;
    attr.needsUpdate = true;
    const cattr = this.clusterHelperLines.geometry.getAttribute("color") as THREE.BufferAttribute;
    cattr.needsUpdate = true;
  }

  private writeCageLines(): void {
    const pos = this.helperLinePos;
    if (!pos || !this.helperLines) return;
    const edges: [number, number][] = [
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
      [0, 2],
      [1, 3],
      [4, 6],
      [5, 7],
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7],
    ];
    let o = 0;
    for (const cage of this.cages) {
      for (const [a, b] of edges) {
        const pa = cage.corners[a]!;
        const pb = cage.corners[b]!;
        pos[o++] = pa.x;
        pos[o++] = pa.y;
        pos[o++] = pa.z;
        pos[o++] = pb.x;
        pos[o++] = pb.y;
        pos[o++] = pb.z;
      }
    }
    const attr = this.helperLines.geometry.getAttribute("position") as THREE.BufferAttribute;
    attr.needsUpdate = true;
  }

  private writeBeamLines(): void {
    const pos = this.beamHelperPos;
    const col = this.beamHelperColor;
    if (!pos || !col || !this.beamHelperLines) return;
    let o = 0;
    let c = 0;
    for (const beam of this.beams) {
      const a = this.masses[beam.a]!;
      const b = this.masses[beam.b]!;
      pos[o++] = a.local.x;
      pos[o++] = a.local.y;
      pos[o++] = a.local.z;
      pos[o++] = b.local.x;
      pos[o++] = b.local.y;
      pos[o++] = b.local.z;
      _n.copy(b.local).sub(a.local);
      const len = Math.max(_n.length(), 1e-5);
      const along = _n.x * beam.restDir.x + _n.y * beam.restDir.y + _n.z * beam.restDir.z;
      const strain = (along - beam.rest) / Math.max(beam.rest, 1e-4);
      const shear = Math.hypot(_n.x - beam.restDir.x * along, _n.y - beam.restDir.y * along, _n.z - beam.restDir.z * along) / Math.max(beam.rest, 1e-4);
      let r = 0.9,
        g = 0.9,
        bl = 0.88;
      if (a.clipping || b.clipping) {
        r = 0.72;
        g = 0.2;
        bl = 0.95;
      } else if (strain < -0.04) {
        const t = THREE.MathUtils.clamp(-strain / 0.35, 0, 1);
        r = 0.95;
        g = 0.12 + (1 - t) * 0.35;
        bl = 0.1;
      } else if (shear > 0.08) {
        const t = THREE.MathUtils.clamp(shear / 0.4, 0, 1);
        r = 0.98;
        g = 0.42 + (1 - t) * 0.2;
        bl = 0.08;
      } else if (strain > 0.06) {
        r = 0.45;
        g = 0.75;
        bl = 0.95;
      }
      col[c++] = r;
      col[c++] = g;
      col[c++] = bl;
      col[c++] = r;
      col[c++] = g;
      col[c++] = bl;
    }
    const attr = this.beamHelperLines.geometry.getAttribute("position") as THREE.BufferAttribute;
    attr.needsUpdate = true;
    const cattr = this.beamHelperLines.geometry.getAttribute("color") as THREE.BufferAttribute;
    cattr.needsUpdate = true;
  }
}

function sphereHit(a: MassNode, b: MassNode): void {
  _n.copy(b.world).sub(a.world);
  const dist = _n.length();
  const minD = a.radius + b.radius;
  if (dist >= minD || dist < 1e-6) return;
  _n.y *= 0.18;
  const nl = _n.length();
  if (nl < 1e-6) return;
  _n.multiplyScalar(1 / nl);
  const ima = a.dynamic ? 1 / a.mass : 0;
  const imb = b.dynamic ? 1 / b.mass : 0;
  const inv = ima + imb;
  if (inv < 1e-8) return;
  const crumple =
    a.name.startsWith("bumper") ||
    b.name.startsWith("bumper") ||
    a.name.startsWith("wing") ||
    b.name.startsWith("wing");
  const tA = forceTransfer(a.local.distanceTo(a.rest), a.bands, a.local.distanceTo(a.rest) >= a.bands.max * 0.97);
  const tB = forceTransfer(b.local.distanceTo(b.rest), b.bands, b.local.distanceTo(b.rest) >= b.bands.max * 0.97);
  const t = Math.min(tA, tB);
  const overlap = (minD - dist) * (crumple ? Math.max(0.28, t) : 1);
  if (a.dynamic) a.world.addScaledVector(_n, -overlap * (ima / inv));
  if (b.dynamic) b.world.addScaledVector(_n, overlap * (imb / inv));
  const rel = b.vel.dot(_n) - a.vel.dot(_n);
  if (rel < 0) {
    const e = crumple ? (t >= 0.97 ? 0.08 : 0) : 0.18;
    const absorb = crumple ? Math.max(0.12, t) : 0.55;
    const j = (-(1 + e) * rel * absorb) / inv;
    if (a.dynamic) a.vel.addScaledVector(_n, -j * ima);
    if (b.dynamic) b.vel.addScaledVector(_n, j * imb);
  }
}

function axisWeight(t: number): number {
  if (t < -0.18 || t > 1.18) return 0;
  if (t < 0) return 1 + t / 0.18;
  if (t > 1) return 1 - (t - 1) / 0.18;
  return 1;
}
