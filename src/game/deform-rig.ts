import * as THREE from "three";
import { regionSoftness, regionCrushBands, type CrushBands } from "./physics-util.ts";
import { type ShapeCluster, type ShapeParticle, makeCluster } from "./shape-match.ts";
import {
  BEAM_SPECS,
  CAGES,
  MASS_SPECS,
  SENSORS,
  SHAPE_CLUSTERS,
  type BodyPartName,
  type CageSpec,
  type MassName,
  type SensorSpec,
} from "./rig-spec.ts";
import { DeformParticleHelper, DeformRigHelper } from "./deform-helper.ts";
import type { Hull } from "./hulls.ts";

/**
 * Burnout-style streamed deformation.
 *
 * Cages are 8-corner FFD volumes that shear, hinge, and accordion — not
 * rigid AABBs. Crumple-zone masses keep moving into the contact plane while
 * the passenger cell is what SAT actually separates.
 */

export type DeformMode = "shape" | "lattice";

/** Rearward engine travel (m, vs the cell, along the hit) that leaves the car undriveable.
 *  ESV 98S3P12: a rigid full-width barrier overloads the front above ~50 km/h
 *  and leaves the safety cell intact below that. With the slab stopping the
 *  nose (A1) the block is reached once the nose packs (ENGINE_PACK_GAP): about
 *  0.03 m at 35 km/h, 0.11 m at 56 km/h, 0.15 m at 64 km/h and 0.23 m at 80.
 *  A tail-first hit does not reach the block (it lives in the nose), so the
 *  same threshold stays driveable from the rear well past 80 km/h. */
export const ENGINE_KILL_TRAVEL = 0.15;

/** Per-body-style rig: cage boxes / sensor rests (by SENSORS index) that differ
 *  from the platform tables so the cages wrap that style's roof, glass and boot. */
export interface RigOverrides {
  cages?: Partial<Record<BodyPartName, Pick<CageSpec, "min" | "max">>>;
  sensors?: Partial<Record<number, SensorSpec["rest"]>>;
}
/** Depth (m) inside the chassisCell span's front/rear face over which non-cell skin weight blends back in. */
const CELL_FACE_BLEND = 0.3;
/** Largest non-cell skin weight at the span face (D1): the A-pillar foot still creases. */
const CELL_FACE_SHARE = 0.25;

function hash01(i: number, salt = 1): number {
  const s = Math.sin(i * 127.1 * salt + salt * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Most cluster weights a skin vertex keeps: the 4 nearest plus the cell-face share. */
export const SKIN_K = 5;
/** Most cage influences a skin vertex keeps (lattice skin / cluster-less fallback). */
export const INF_K = 4;
/** Parent masses per skin point (A5): the paint rides these particles. */
const RES_K = 4;
/** Parent slots: RES_K plus the cell-face share of the nearest non-cabin mass (D1). */
export const RES_SLOTS = 5;
/** IDW softening (m²) of the parent weights, 1/(d² + RES_SOFT). */
const RES_SOFT = 0.04;

interface Cage {
  spec: CageSpec;
  min: THREE.Vector3;
  max: THREE.Vector3;
  center: THREE.Vector3;
  restCorners: THREE.Vector3[];
  corners: THREE.Vector3[];
  size: THREE.Vector3;
  glass: boolean;
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
  /** Car-frame push (m) a squeezing face (press plates, `projectOutOfBox` when bidirectional) has given a planted
   *  hub: clampLocal pins it at rest + shove and pops it past WHEEL_DIAMETER. Pinned at rest, plates passed through the tyres. */
  shoveX: number;
  shoveZ: number;
  /** Permanent set (m) along the hit, from `baseX/baseZ`: crush this node can no longer spring back from. */
  crushSet: number;
  /** Planar displacement from rest (m, car frame) when the current hit started: earlier hits' damage.
   *  clampLocal caps only what this hit adds on top, so a later hit never springs an old dent back. */
  baseX: number;
  baseZ: number;
  bands: CrushBands;
  /** Name-class flags and region softness, resolved once so hot loops never string-match. */
  hub: boolean;
  bumper: boolean;
  rail: boolean;
  /** Bumper or wing: soft sheet metal that yields on sphere-sphere contact. */
  crumple: boolean;
  softness: number;
}

export interface Beam {
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

/** Masses the solver reads by role every step; resolved once in the constructor. */
type KeyMass = "cell" | "engineL" | "engineR" | "axleR" | "doorL" | "doorR" | "hubFL" | "hubFR" | "hubRL" | "hubRR" | "bumperFL" | "bumperFR" | "bumperRL" | "bumperRR";

/** Wrinkle noise per vertex, keyed on the lowest vertex index sharing its rest position so split seams stay shut. */
function wrinkleSeeds(restPos: Float32Array, vertexCount: number): Float64Array {
  const wrinkleSeed = new Float64Array(vertexCount);
  const firstAt = new Map<string, number>();
  for (let i = 0; i < vertexCount; i++) {
    const key = `${restPos[i * 3]},${restPos[i * 3 + 1]},${restPos[i * 3 + 2]}`;
    const first = firstAt.get(key);
    if (first === undefined) firstAt.set(key, i);
    wrinkleSeed[i] = hash01(first ?? i, 3) - 0.5;
  }
  return wrinkleSeed;
}

/** The rig's cages at rest (`rig.cages` boxes over the spec's). */
function makeCages(rig: RigOverrides): Cage[] {
  return CAGES.map((base) => {
    const box = rig.cages?.[base.name];
    const spec = box ? { ...base, ...box } : base;
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
      glass: spec.name.startsWith("glass"),
    };
  });
}

/** The rig's crush sensors at rest (`rig.sensors` rests over the spec's), each on its cage's index. */
function makeSensors(rig: RigOverrides, partIndex: Map<BodyPartName, number>): Sensor[] {
  return SENSORS.map((base, i) => {
    const rest = rig.sensors?.[i];
    const spec = rest ? { ...base, rest } : base;
    return {
      spec,
      rest: new THREE.Vector3(...spec.rest),
      pos: new THREE.Vector3(...spec.rest),
      partIndex: partIndex.get(spec.part) ?? 12,
      compression: -0,
      target: 0,
      delay: 0,
      fired: false,
    };
  });
}

/** The mass nodes at rest, in `MASS_SPECS` order; fills `nameIndex` (name → index). */
function makeMasses(nameIndex: Map<MassName, number>): MassNode[] {
  return MASS_SPECS.map((spec, i) => {
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
      shoveX: -0,
      shoveZ: -0,
      crushSet: -0,
      baseX: -0,
      baseZ: -0,
      bands: regionCrushBands(spec.name),
      hub: spec.name.startsWith("hub"),
      bumper: spec.name.startsWith("bumper"),
      rail: spec.name.startsWith("rail"),
      crumple: spec.name.startsWith("bumper") || spec.name.startsWith("wing"),
      softness: regionSoftness(spec.name),
    };
  });
}

/** The structure's beams at their rest lengths. */
function makeBeams(masses: readonly MassNode[], nameIndex: Map<MassName, number>): Beam[] {
  return BEAM_SPECS.map(([na, nb, kTen, yieldK, maxShorten]) => {
    const a = nameIndex.get(na)!;
    const b = nameIndex.get(nb)!;
    const rest = masses[a]!.rest.distanceTo(masses[b]!.rest);
    const restDir = masses[b]!.rest.clone().sub(masses[a]!.rest);
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
}

/**
 * Lattice skin (and the cluster-less fallback): up to INF_K cage influences per vertex, packed as the cage's
 * coefficient offset in `infCo` + (u, v, w, weight) in `infUvw`, the count in `infN`.
 */
function bindLattice(
  restPos: Float32Array,
  vertexCount: number,
  cages: readonly Cage[],
  infN: Uint8Array,
  infCo: Int32Array,
  infUvw: Float64Array,
): void {
  const skinsCage = cages.map((c) => !["doorLeft", "doorRight", "glassFront", "glassRear"].includes(c.spec.name));
  for (let i = 0; i < vertexCount; i++) {
    const x = restPos[i * 3]!;
    const y = restPos[i * 3 + 1]!;
    const z = restPos[i * 3 + 2]!;
    const list: Influence[] = [];
    for (let p = 0; p < cages.length; p++) {
      if (!skinsCage[p]) continue;
      const cage = cages[p]!;
      const u = (x - cage.min.x) / cage.size.x;
      const v = (y - cage.min.y) / cage.size.y;
      const w = (z - cage.min.z) / cage.size.z;
      const weight = axisWeight(u) * axisWeight(v) * axisWeight(w);
      if (weight > 0.02) list.push({ part: p, u, v, w, weight });
    }
    if (list.length === 0) {
      // Beyond every cage's reach (the tail skin past the boot cage): extrapolate the nearest cage
      // unclamped, exact at rest. Clamping into the cell box snapped it 1.6 m forward on the first skin.
      let best = 0;
      let bestD = Infinity;
      for (let p = 0; p < cages.length; p++) {
        if (!skinsCage[p]) continue;
        const c = cages[p]!;
        const d = Math.hypot(Math.max(c.min.x - x, 0, x - c.max.x), Math.max(c.min.y - y, 0, y - c.max.y), Math.max(c.min.z - z, 0, z - c.max.z));
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      const cage = cages[best]!;
      list.push({ part: best, u: (x - cage.min.x) / cage.size.x, v: (y - cage.min.y) / cage.size.y, w: (z - cage.min.z) / cage.size.z, weight: 1 });
    } else {
      list.sort((a, b) => b.weight - a.weight);
      if (list.length > INF_K) list.length = INF_K;
      let sum = 0;
      for (const inf of list) sum += inf.weight;
      for (const inf of list) inf.weight /= sum;
    }
    infN[i] = list.length;
    for (let k = 0; k < list.length; k++) {
      const inf = list[k]!;
      const s = i * INF_K + k;
      infCo[s] = inf.part * 24;
      infUvw[s * 4] = inf.u;
      infUvw[s * 4 + 1] = inf.v;
      infUvw[s * 4 + 2] = inf.w;
      infUvw[s * 4 + 3] = inf.weight;
    }
  }
}

function axisWeight(t: number): number {
  if (t < -0.18 || t > 1.18) return 0;
  if (t < 0) return 1 + t / 0.18;
  if (t > 1) return 1 - (t - 1) / 0.18;
  return 1;
}

/**
 * The soft body's state and build: every field, the constructor (cages, sensors, masses, beams, lattice and
 * cluster skin tables). Layers stack `DeformRig` → `DeformHit` → `DeformState` → `DeformContact` →
 * `DeformSolve` → `StreamedDeformation` (one class split by context; `StreamedDeformation` is the one anything
 * constructs).
 */
export abstract class DeformRig {
  readonly cageCount: number;
  readonly sensorCount: number;
  dirty = false;
  /** True after this frame's skin() — panels skip computeVertexNormals otherwise. */
  skinnedThisFrame = false;
  /** Owner's per-frame LoD verdict: the car is off-screen or tiny, so skip the vertex skin
   *  (the cage/shape solve still runs). */
  skinDeferred = false;
  /** A skin was skipped since the mesh was last written — `flushSkin` before the car is seen. */
  skinOwed = false;
  crushAmount = -0;
  impactLocal = new THREE.Vector3();
  impactInward = new THREE.Vector3(0, 0, -1);
  massActive = false;
  drivetrainAlive = true;
  /** Worst engine-block travel toward the cabin so far (m); only rises (updateDrivetrain). */
  engineTravel = 0;
  /** Block travel (m) that kills the drivetrain. Physics default ENGINE_KILL_TRAVEL (sourced); the
   *  handling model may raise it per car (arcade ↔ realistic) without changing how far the block moves. */
  killTravel = ENGINE_KILL_TRAVEL;
  /** Wear (Σ per-hit EBS², each capped at WEAR_HIT) that wrecks the drivetrain by itself; the engine's
   *  travel share adds to it. Infinite (off) unless the context arms it (a derby, `armKill`). */
  wreckEnergy = Infinity;
  /** Wear taken so far: every hit's EBS², capped at WEAR_HIT (beginCrush, rearmHit). */
  protected wear = -0;
  /** Both ends are crumple zones (car-compactor / two-wall squeeze). */
  bidirectional = false;
  /** Sticky until reset: this car was squeezed / deep-crushed, so `clampLocal` keeps those shape limits. */
  protected squeezeShape = false;
  protected deepShape = false;
  /** Masses resting on the face after the last projectOutOfBox call. */
  faceContacts = 0;
  /** Walls past both wheel midpoints: the cage and rails may yield. Reads false while `frameCrush` is off. */
  get deepCrush(): boolean {
    return this.squeezed && this.frameCrush;
  }
  set deepCrush(v: boolean) {
    this.squeezed = v;
  }
  private squeezed = false;
  /** A squeeze past both wheel midpoints may crush the frame (`deepCrush`). Off: the cell holds (race mode). */
  frameCrush = true;
  /** Wheels may separate (C4 corner hits, kerb launches, a face shoving the hub a wheel diameter). Off: never. */
  wheelsDetach = true;

  protected cages: Cage[];
  protected sensors: Sensor[];
  protected restPos: Float32Array;
  /** Per-vertex wrinkle phase noise in [−0.5, 0.5). */
  protected readonly wrinkleSeed: Float64Array;
  /** Cage influences per vertex (≤ INF_K): count, `cageCo` offset, (u, v, w, weight). */
  protected readonly infN: Uint8Array;
  protected readonly infCo: Int32Array;
  protected readonly infUvw: Float64Array;
  /** `cageCoeffs` of every cage (24 per cage), refreshed per skin. */
  protected readonly cageCo: Float64Array;
  protected vertexCount: number;
  protected elapsed = 0;
  protected lastContact = -10;
  protected crushing = false;
  protected impulse = -0;
  /** Equivalent barrier speed (m/s, −1 before any hit) of the current hit: the root-sum-square of every
   *  hit's EBS on the struck end. Crush energy grows with EBS² on a linear-stiffness end, so repeated hits
   *  on one end add stroke; spikes inside one contact never re-arm (`rearmHit`). */
  protected hitSpeed = -0;
  /** Σ EBS² per struck end (`struckEnd`: front, rear, left, right). */
  protected readonly endEbs2 = new Float64Array(4);
  /** `liveHulls` / `liveCrushHulls` output, rewritten by each call (a SAT pass allocated 10 hulls per car). */
  protected readonly hullBuf: Hull[] = Array.from({ length: 5 }, () => ({ cx: 0, cz: 0, hx: 0, hz: 0 }));
  protected readonly crushHullBuf: Hull[] = Array.from({ length: 5 }, () => ({ cx: 0, cz: 0, hx: 0, hz: 0 }));
  /** Ground under each dynamic mass before (`floorPre`) and after (`floorPost`, `gripPost`) its move (`sampleGround`). */
  protected readonly floorPre = new Float64Array(MASS_SPECS.length);
  protected readonly floorPost = new Float64Array(MASS_SPECS.length);
  protected readonly gripPost = new Float64Array(MASS_SPECS.length);
  /** `measurePose` output (pitch, yaw, roll, anchor world x/y/z and body x/z, floor, lowest hub). */
  protected readonly pose = new Float64Array(10);
  /** `yawMomentum`'s held angular momentum: [0] clampLocal's, [1] separateAlong's. */
  protected readonly spinHeld = new Float64Array(2);
  /** `measureStroke` output. */
  protected readonly strokeOut = new Float64Array(1);
  /** The current hit is a re-armed one (`rearmHit`), not the crash's first. */
  protected rearmed = false;
  /** `elapsed` of the last throttle input (`notifyPower`). */
  protected lastPower = -0;
  /** `elapsed` when the current hit began (beginCrush, rearmHit): the sliding-drag clock (`sinceHit`). */
  protected hitAt = -0;
  protected wrinkleAmp = -0;
  /** `slabTravel`'s low mark of `crumpleTravelCorner` this hit. */
  protected cornerLow = Infinity;
  protected helper: DeformRigHelper | null = null;
  protected particleHelper: DeformParticleHelper | null = null;
  /** World xyz shape-match goal per particle for the particle view; NaN = no pull last step. */
  protected goalView = new Float64Array(0);
  /** goalView while the particle view is visible, else null so the solver skips the copy. */
  protected goalOut: Float64Array | null = null;
  readonly masses: MassNode[];
  protected beams: Beam[];
  protected readonly at: Record<KeyMass, MassNode>;
  protected readonly byName: Map<string, MassNode>;
  /** Hub → mount spring pairs. */
  protected readonly suspension: readonly (readonly [MassNode, MassNode])[];
  protected readonly cageByPart: Map<BodyPartName, Cage>;
  protected _totalMass = 1;
  protected prevYaw = 0;
  /** Heading and sim time (`elapsed`) of the last yaw-rate sample in followGroup. */
  protected rateYaw = 0;
  protected rateAt = 0;
  /** Share (0–1) of the read pitch/roll the frame takes, and the sim time it was last eased at (followGroup). */
  protected lean = 1;
  protected leanAt = -Infinity;
  /** Hull push (m) taken at sim time `pushAt` (takePush). */
  protected pushUsed = 0;
  protected pushAt = -1;
  protected overlapFrame = false;
  /** Sim time (elapsed) of the last fed contact: the solver stays in contact mode CONTACT_HOLD past it. */
  protected contactAt = -Infinity;
  /** stepShapeMatch ran during the current / the previous structure step: the falling edge rebases the rests. */
  protected shapeRan = false;
  protected shapeWasLive = false;
  /** Body frame of the last syncShapeFromMasses: world = R_y(heading)·(local − bodyRestC) + bodyC. */
  protected bodyCos = 1;
  protected bodySin = 0;
  protected readonly bodyC = new THREE.Vector3();
  protected readonly bodyRestC = new THREE.Vector3();
  squash = 0.32;
  buckle = 0.45;
  mode: DeformMode = "shape";
  protected clusters: ShapeCluster[] = [];
  /** Per-cluster absorption (its owner cage's), fixed at build time. */
  protected clusterAbsorb = new Float64Array(0);
  protected clusterOwner: BodyPartName[] = [];
  protected shapeParticles: ShapeParticle[] = [];
  protected goalX = new Float64Array(0);
  protected goalY = new Float64Array(0);
  protected goalZ = new Float64Array(0);
  protected goalW = new Float64Array(0);
  /** Body-frame x/z of each particle when stepShapeMatch started (net-spin removal). */
  protected startX = new Float64Array(0);
  protected startZ = new Float64Array(0);
  /** World x/z of each mass at `holdTurn` (a position-only pass's net turn, undone by `undoTurn`). */
  protected turnX = new Float64Array(0);
  protected turnZ = new Float64Array(0);
  /** Cluster skin weights per vertex (≤ SKIN_K): count (0 = cage fallback), `clusterXf` offset, weight. */
  protected skinN = new Uint8Array(0);
  protected skinXf = new Int32Array(0);
  protected skinW = new Float64Array(0);
  /** Skin vertex → mass index of the hub that plants it (wheel arch, below 0.55 m), else −1. */
  protected skinHub = new Int32Array(0);
  /** Per cluster: skin map M (row-major 9), applied to a skin point's offset from its parent masses (A5). */
  protected clusterXf = new Float64Array(0);
  /** Cage corner ← cluster weights (rest-only, so built once): per corner [start, end) into `cornerXf`/`cornerW`, and Σw. */
  protected cornerStart = new Int32Array(0);
  protected cornerXf = new Int32Array(0);
  protected cornerW = new Float64Array(0);
  protected cornerWsum = new Float64Array(0);
  protected impulseW = new Float64Array(0);
  protected skinRest: { x: number; y: number; z: number }[] = [];
  protected skinLocal: { x: number; y: number; z: number }[] = [];
  protected skinMassN: number[] = [];
  /**
   * A5 skin anchors: per skin point (vertices, then cage corners) up to RES_SLOTS parent masses
   * (×3 offsets into `massPos`), their weights, and their weighted rest centroid; `massPos` is the
   * masses' local positions at the last bake.
   */
  protected resJ = new Int32Array(0);
  protected resW = new Float64Array(0);
  protected resC = new Float64Array(0);
  protected massPos = new Float64Array(0);
  /** Netplay: skin inputs as of the last bake (`bakeLocalSkin`), read by `readNetState`. Kept apart
   *  because the post-contact shape-rest rebase resets every cluster's `skinM` under a frozen skin. */
  protected netSkinXf = new Float64Array(0);
  protected readonly netImpact = new Float64Array(9);
  protected netPopped = 0;
  protected netFlags = 0;

  constructor(geometry: THREE.BufferGeometry, rig: RigOverrides = {}) {
    // Fields declared `-0` (here, and the masses' and sensors' in their literals) hold a double from
    // construction. A Smi field's first double write changes the maps: each race car's first crash,
    // first re-arm and first drive as a wreck deoptimised 60–100 physics functions mid-race, which then ran
    // unoptimised for seconds (RIG_ANALYSIS §6.12). The sentinels go on over the `-0`.
    this.hitSpeed = -1;
    this.lastPower = -10;
    const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
    this.vertexCount = pos.count;
    this.restPos = new Float32Array(pos.array as Float32Array);
    this.wrinkleSeed = wrinkleSeeds(this.restPos, this.vertexCount);

    this.cages = makeCages(rig);
    this.cageCount = this.cages.length;

    const partIndex = new Map<BodyPartName, number>();
    this.cages.forEach((c, i) => partIndex.set(c.spec.name, i));
    this.cageByPart = new Map(this.cages.map((c) => [c.spec.name, c]));

    this.sensors = makeSensors(rig, partIndex);
    this.sensorCount = this.sensors.length;

    const nameIndex = new Map<MassName, number>();
    this.masses = makeMasses(nameIndex);
    const cellNode = this.masses[nameIndex.get("cell") ?? 5]!;
    const node = (name: MassName): MassNode => {
      const i = nameIndex.get(name);
      return i === undefined ? cellNode : this.masses[i]!;
    };
    this.at = {
      cell: cellNode,
      engineL: node("engineL"),
      engineR: node("engineR"),
      axleR: node("axleR"),
      doorL: node("doorL"),
      doorR: node("doorR"),
      hubFL: node("hubFL"),
      hubFR: node("hubFR"),
      hubRL: node("hubRL"),
      hubRR: node("hubRR"),
      bumperFL: node("bumperFL"),
      bumperFR: node("bumperFR"),
      bumperRL: node("bumperRL"),
      bumperRR: node("bumperRR"),
    };
    this.byName = new Map(this.masses.map((m) => [m.name, m]));
    this.suspension = [
      [this.at.hubFL, this.at.engineL],
      [this.at.hubFR, this.at.engineR],
      [this.at.hubRL, this.at.axleR],
      [this.at.hubRR, this.at.axleR],
    ];
    this._totalMass = 0;
    for (const m of this.masses) this._totalMass += m.mass;
    this.impulseW = new Float64Array(this.masses.length);
    this.skinRest = this.masses.map((m) => m.rest);
    this.skinLocal = this.masses.map((m) => m.local);
    this.skinMassN = this.masses.map((m) => m.mass);
    this.beams = makeBeams(this.masses, nameIndex);

    // Lattice skin (and the cluster-less fallback): up to INF_K cage influences per vertex (`bindLattice`).
    this.infN = new Uint8Array(this.vertexCount);
    this.infCo = new Int32Array(this.vertexCount * INF_K);
    this.infUvw = new Float64Array(this.vertexCount * INF_K * 4);
    this.cageCo = new Float64Array(this.cages.length * 24);
    bindLattice(this.restPos, this.vertexCount, this.cages, this.infN, this.infCo, this.infUvw);

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
    this.startX = new Float64Array(this.masses.length);
    this.startZ = new Float64Array(this.masses.length);
    this.turnX = new Float64Array(this.masses.length);
    this.turnZ = new Float64Array(this.masses.length);
    this.clusters = SHAPE_CLUSTERS.map((spec) => makeCluster(this.shapeParticles, spec.masses.map((n) => nameIndex.get(n)!)));
    this.clusterOwner = SHAPE_CLUSTERS.map((spec) => spec.owner);
    this.clusterAbsorb = Float64Array.from(SHAPE_CLUSTERS, (spec) => this.cageByPart.get(spec.owner)!.spec.absorption);
    this.buildSkinWeights();
  }

  /**
   * Rest-only skin tables: cluster weights per vertex and per cage corner, the parent masses of
   * every skin point (A5), and the hub that plants each arch vertex.
   */
  private buildSkinWeights(): void {
    const n = this.vertexCount;
    const points = n + this.cages.length * 8;
    this.skinN = new Uint8Array(n);
    this.skinXf = new Int32Array(n * SKIN_K);
    this.skinW = new Float64Array(n * SKIN_K);
    this.skinHub = new Int32Array(n).fill(-1);
    this.resJ = new Int32Array(points * RES_SLOTS);
    this.resW = new Float64Array(points * RES_SLOTS);
    this.resC = new Float64Array(points * 3);
    this.massPos = new Float64Array(this.masses.length * 3);
    this.clusterXf = new Float64Array(this.clusters.length * 9);
    this.netSkinXf = new Float64Array(this.clusters.length * 9);
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
    // D1: skin in the cabin section (the chassisCell cage's z span, above its floor) follows only
    // the clusters that hold the cell mass, so A-pillar and footwell skin cannot ride the crushed
    // nose into the cabin. Within CELL_FACE_BLEND of the section's front or rear face up to
    // CELL_FACE_SHARE of the nearest other cluster blends back in, so the pillar foot still creases.
    const span = this.cageByPart.get("chassisCell")!;
    const cellMass = this.masses.indexOf(this.at.cell);
    const holdsCell = this.clusters.map((c) => c.idx.includes(cellMass));
    const inCell = (x: number, y: number, z: number): boolean => z >= span.min.z && z <= span.max.z && y >= span.min.y;
    // A5 parents: the RES_K nearest non-hub masses by 1/(d² + RES_SOFT), less the (RES_K+1)th's
    // weight so a parent fades out before it is swapped (no seam where the nearest set changes).
    // D1 again: a cabin point takes cabin masses only, plus the cell-face share of the nearest
    // other mass. resC is the parents' weighted rest centroid.
    const body = this.masses.flatMap((m, j) => (m.hub ? [] : [j]));
    const cabinBody = body.filter((j) => inCell(this.masses[j]!.rest.x, this.masses[j]!.rest.y, this.masses[j]!.rest.z));
    const outside = body.filter((j) => !cabinBody.includes(j));
    const near = (rx: number, ry: number, rz: number, set: number[]) =>
      set
        .map((j) => {
          const r = this.masses[j]!.rest;
          return { j, w: 1 / ((rx - r.x) ** 2 + (ry - r.y) ** 2 + (rz - r.z) ** 2 + RES_SOFT) };
        })
        .sort((a, b) => b.w - a.w);
    const parents = (rx: number, ry: number, rz: number, i: number): void => {
      const cabin = inCell(rx, ry, rz);
      const ds = near(rx, ry, rz, cabin ? cabinBody : body);
      const floor = ds.length > RES_K ? ds[RES_K]!.w : 0;
      ds.length = Math.min(ds.length, RES_K);
      let sum = 0;
      for (const d of ds) sum += d.w - floor;
      for (const d of ds) d.w = (d.w - floor) / sum;
      const face = Math.min(rz - span.min.z, span.max.z - rz);
      if (cabin && face < CELL_FACE_BLEND) {
        const share = CELL_FACE_SHARE * (1 - face / CELL_FACE_BLEND);
        for (const d of ds) d.w *= 1 - share;
        ds.push({ j: near(rx, ry, rz, outside)[0]!.j, w: share });
      }
      for (let k = 0; k < ds.length; k++) {
        const { j, w } = ds[k]!;
        const r = this.masses[j]!.rest;
        this.resJ[i * RES_SLOTS + k] = j * 3;
        this.resW[i * RES_SLOTS + k] = w;
        this.resC[i * 3] += r.x * w;
        this.resC[i * 3 + 1] += r.y * w;
        this.resC[i * 3 + 2] += r.z * w;
      }
    };
    for (let i = 0; i < n; i++) {
      const rx = this.restPos[i * 3]!;
      const ry = this.restPos[i * 3 + 1]!;
      const rz = this.restPos[i * 3 + 2]!;
      parents(rx, ry, rz, i);
      const cabin = inCell(rx, ry, rz);
      const scored: { ci: number; w: number }[] = [];
      let other = -1,
        otherW = 0;
      for (let ci = 0; ci < this.clusters.length; ci++) {
        const cm = cms[ci]!;
        const d = Math.hypot(rx - cm.x, ry - cm.y, rz - cm.z);
        if (d > 1.45) continue;
        if (ry > 1.02 && cm.y < 0.78) continue;
        const w = Math.exp(-d * 2.35);
        if (cabin && !holdsCell[ci]) {
          if (w > otherW) {
            other = ci;
            otherW = w;
          }
          continue;
        }
        scored.push({ ci, w });
      }
      scored.sort((a, b) => b.w - a.w);
      if (scored.length > 4) scored.length = 4;
      let sum = 0;
      for (const s of scored) sum += s.w;
      if (sum > 1e-8) for (const s of scored) s.w /= sum;
      const face = Math.min(rz - span.min.z, span.max.z - rz);
      if (cabin && other >= 0 && face < CELL_FACE_BLEND && scored.length > 0) {
        const share = CELL_FACE_SHARE * (1 - face / CELL_FACE_BLEND);
        for (const s of scored) s.w *= 1 - share;
        scored.push({ ci: other, w: share });
      }
      this.skinN[i] = scored.length;
      for (let k = 0; k < scored.length; k++) {
        this.skinXf[i * SKIN_K + k] = scored[k]!.ci * 9;
        this.skinW[i * SKIN_K + k] = scored[k]!.w;
      }
      if (ry < 0.55) {
        this.skinHub[i] = this.masses.findIndex((m) => m.hub && Math.hypot(rx - m.rest.x, rz - m.rest.z) <= 0.4);
      }
    }
    // Cage corners follow the clusters within 1.4 m of their rest position (`solveCagesFromShape`).
    const start: number[] = [0];
    const xf: number[] = [];
    const ws: number[] = [];
    this.cornerWsum = new Float64Array(this.cages.length * 8);
    for (let j = 0; j < this.cages.length * 8; j++) {
      const rest = this.cages[j >> 3]!.restCorners[j & 7]!;
      parents(rest.x, rest.y, rest.z, n + j);
      let wsum = 0;
      for (let ci = 0; ci < this.clusters.length; ci++) {
        const cm = cms[ci]!;
        const d = Math.hypot(rest.x - cm.x, rest.y - cm.y, rest.z - cm.z);
        if (d > 1.4) continue;
        const w = Math.exp(-d * 2.35);
        xf.push(ci * 9);
        ws.push(w);
        wsum += w;
      }
      start.push(xf.length);
      this.cornerWsum[j] = wsum;
    }
    this.cornerStart = Int32Array.from(start);
    this.cornerXf = Int32Array.from(xf);
    this.cornerW = Float64Array.from(ws);
  }
}
