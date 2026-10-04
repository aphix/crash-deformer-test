import * as THREE from "three";
import type { CrushBands } from "./physics-util.ts";
import type { ShapeCluster, ShapeParticle } from "./shape-match.ts";
import {
  MASS_SPECS,
  SHAPE_CLUSTERS,
  type BodyPartName,
  type CageSpec,
  type MassName,
  type SensorSpec,
} from "../kernel/rig-spec.ts";
import { DeformParticleHelper, DeformRigHelper } from "./deform-helper.ts";
import type { Hull } from "./hulls.ts";
import { bindLattice, buildRunStructures, INF_K, restoreInto, runTemplate, wrinkleSeeds } from "./deform-build.ts";
import { FACES, faceFollow } from "./load-crush.ts";

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

/** Most cluster weights a skin vertex keeps: the 4 nearest plus the cell-face share. */
export const SKIN_K = 5;
/** Parent masses per skin point (A5): the paint rides these particles. */
const RES_K = 4;
/** Parent slots: RES_K plus the cell-face share of the nearest non-cabin mass (D1). */
export const RES_SLOTS = 5;
/** IDW softening (m²) of the parent weights, 1/(d² + RES_SOFT). */
const RES_SOFT = 0.04;

export interface Cage {
  spec: CageSpec;
  min: THREE.Vector3;
  max: THREE.Vector3;
  center: THREE.Vector3;
  restCorners: THREE.Vector3[];
  corners: THREE.Vector3[];
  size: THREE.Vector3;
  glass: boolean;
}

export interface Sensor {
  spec: SensorSpec;
  rest: THREE.Vector3;
  pos: THREE.Vector3;
  partIndex: number;
  compression: number;
  target: number;
  delay: number;
  fired: boolean;
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
  /** The crush has moved since the skin's solve (cluster fit, cage corners) last ran: `solveSkin` runs it. */
  protected skinDue = false;
  /** The crush window closed since the mesh was last written: a deferred skin is written once anyway. */
  protected skinFinal = false;
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
  /** `floorPost` sampled since the masses last armed (`measurePose` reads the hubs' floors from it). */
  protected floorsFresh = false;
  /** `measurePose` output (pitch, yaw, roll, anchor world x/y/z and body x/z, floor, lowest hub, 1 when every hub is
   *  on its ground, the ground that holds the body up, then the pitch and roll (rad) of the plane under its hubs, at any
   *  lean (the frame lies on it once levelled; `stepSuspension` tilts its rest offsets by it); 1 when planted on level ground). */
  protected readonly pose = new Float64Array(15);
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
  /** The body's middle is above its ground band (followGroup): no wheel holds it, its masses fly. */
  aloft = false;
  /** The frame's height at sim time `frameAt` (followGroup's last timed call) and its measured climb (m/s). */
  protected frameY = 0;
  protected frameAt = 0;
  protected frameVy = 0;
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
  /**
   * Load crush (load-crush.ts): each face's crush depth (m), the depth already baked into the masses (`bakeLoadCrush`),
   * how much each mass follows each face (rest-only), and a changed-since-the-skin-read mark. Typed arrays, not scalar
   * fields, so the solver-state layout (`simState`) stays what it was.
   */
  readonly crush = new Float64Array(FACES);
  protected readonly crushBaked = new Float64Array(FACES);
  protected readonly loadW: Float64Array;
  protected readonly loadDirty = new Uint8Array(1);
  /** The style's rig overrides, kept (a shared reference) for `rebuildRunStructures`. */
  private readonly rig: RigOverrides;

  constructor(geometry: THREE.BufferGeometry, rig: RigOverrides = {}) {
    this.rig = rig;
    const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
    this.vertexCount = pos.count;
    this.restPos = new Float32Array(pos.array as Float32Array);
    this.wrinkleSeed = wrinkleSeeds(this.restPos, this.vertexCount);

    const nameIndex = new Map<MassName, number>();
    const built = buildRunStructures(rig, nameIndex);
    this.cages = built.cages;
    this.cageCount = this.cages.length;

    this.cageByPart = new Map(this.cages.map((c) => [c.spec.name, c]));

    this.sensors = built.sensors;
    this.sensorCount = this.sensors.length;

    this.masses = built.masses;
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
    this.beams = built.beams;

    // Lattice skin (and the cluster-less fallback): up to INF_K cage influences per vertex (`bindLattice`).
    this.infN = new Uint8Array(this.vertexCount);
    this.infCo = new Int32Array(this.vertexCount * INF_K);
    this.infUvw = new Float64Array(this.vertexCount * INF_K * 4);
    this.cageCo = new Float64Array(this.cages.length * 24);
    bindLattice(this.restPos, this.vertexCount, this.cages, this.infN, this.infCo, this.infUvw);

    this.shapeParticles = built.shapeParticles;
    this.goalX = new Float64Array(this.masses.length);
    this.goalY = new Float64Array(this.masses.length);
    this.goalZ = new Float64Array(this.masses.length);
    this.goalW = new Float64Array(this.masses.length);
    this.startX = new Float64Array(this.masses.length);
    this.startZ = new Float64Array(this.masses.length);
    this.turnX = new Float64Array(this.masses.length);
    this.turnZ = new Float64Array(this.masses.length);
    this.clusters = built.clusters;
    this.clusterOwner = SHAPE_CLUSTERS.map((spec) => spec.owner);
    this.clusterAbsorb = Float64Array.from(SHAPE_CLUSTERS, (spec) => this.cageByPart.get(spec.owner)!.spec.absorption);
    this.loadW = new Float64Array(this.masses.length * FACES);
    this.masses.forEach((m, i) => {
      if (m.hub) return;
      for (let f = 0; f < FACES; f++) this.loadW[i * FACES + f] = faceFollow(f, m.rest.x, m.rest.y, m.rest.z);
    });
    this.buildSkinWeights();
    this.initRunState();
  }

  /** The per-run structures back to as built, in place: copied from the rig's shared template (`runTemplate`). */
  protected rebuildRunStructures(): void {
    restoreInto(this as unknown as Record<string, unknown>, runTemplate(this.rig));
  }

  /**
   * Every per-run scalar, vector and buffer to its construction value: the constructor's last step, and `reset`'s
   * with `rebuildRunStructures`, so a reset car runs exactly like a fresh one (a race replayed on the same cars,
   * netplay). Settings (`squash`, `buckle`, `mode`, `killTravel`, `wreckEnergy`, `frameCrush`, `wheelsDetach`),
   * helpers and the rest-only tables stay.
   * Fields declared `-0` (here, and the masses' and sensors' in their literals) hold a double from construction.
   * A Smi field's first double write changes the maps: each race car's first crash, first re-arm and first drive
   * as a wreck deoptimised 60–100 physics functions mid-race, which then ran unoptimised for seconds
   * (RIG_ANALYSIS §6.12). The declarations keep those `-0`s; the sentinels below go on over them.
   */
  protected initRunState(): void {
    this.dirty = false;
    this.skinnedThisFrame = false;
    this.skinDeferred = false;
    this.skinOwed = false;
    this.skinDue = false;
    this.skinFinal = false;
    this.crushAmount = -0;
    this.impactLocal.set(0, 0, 0);
    this.impactInward.set(0, 0, -1);
    this.massActive = false;
    this.drivetrainAlive = true;
    this.engineTravel = 0;
    this.wear = -0;
    this.bidirectional = false;
    this.squeezeShape = false;
    this.deepShape = false;
    this.faceContacts = 0;
    this.squeezed = false;
    this.elapsed = 0;
    this.lastContact = -10;
    this.crushing = false;
    this.impulse = -0;
    this.hitSpeed = -1;
    this.rearmed = false;
    this.lastPower = -10;
    this.hitAt = -0;
    this.wrinkleAmp = -0;
    this.cornerLow = Infinity;
    this.prevYaw = 0;
    this.rateYaw = 0;
    this.rateAt = 0;
    this.lean = 1;
    this.leanAt = -Infinity;
    this.aloft = false;
    this.floorsFresh = false;
    this.frameY = 0;
    this.frameAt = 0;
    this.frameVy = 0;
    this.pushUsed = 0;
    this.pushAt = -1;
    this.overlapFrame = false;
    this.contactAt = -Infinity;
    this.shapeRan = false;
    this.shapeWasLive = false;
    this.bodyCos = 1;
    this.bodySin = 0;
    this.bodyC.set(0, 0, 0);
    this.bodyRestC.set(0, 0, 0);
    this.netPopped = 0;
    this.netFlags = 0;
    this.crush.fill(0);
    this.crushBaked.fill(0);
    this.loadDirty.fill(0);
    for (const h of this.hullBuf) h.cx = h.cz = h.hx = h.hz = 0;
    for (const h of this.crushHullBuf) h.cx = h.cz = h.hx = h.hz = 0;
    for (const b of [this.endEbs2, this.cageCo, this.floorPre, this.floorPost, this.gripPost, this.pose, this.spinHeld, this.strokeOut]) b.fill(0);
    for (const b of [this.goalX, this.goalY, this.goalZ, this.goalW, this.startX, this.startZ, this.turnX, this.turnZ, this.impulseW]) b.fill(0);
    for (const b of [this.massPos, this.clusterXf, this.netSkinXf, this.netImpact]) b.fill(0);
    this.goalView.fill(NaN);
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
