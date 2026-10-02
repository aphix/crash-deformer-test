import * as THREE from "three";
import { computeNormalsFast } from "./fast-normals.ts";
import { activeGround, NO_FLOOR } from "./ground.ts";
import { leftoverCrumple, round4, vec3, applyGroundFriction, clampSpeed, CRASH, regionSoftness, crushGate, closingKeScale, crushStroke, regionCrushBands, forceTransfer, satPushCap, type CrushBands } from "./physics-util.ts";
import {
  type ShapeCluster,
  type ShapeParticle,
  makeCluster,
  matchCluster,
  applyPlasticity,
  resetCluster,
  matchSkinLocal,
  stiffnessIters,
  goalAlpha,
  deformBeta,
} from "./shape-match.ts";
import { BEAM_SPECS, CAGES, MASS_SPECS, SENSORS, SHAPE_CLUSTERS, type BodyPartName, type CageSpec, type MassName, type SensorSpec } from "./rig-spec.ts";
import { DeformParticleHelper, DeformRigHelper } from "./deform-helper.ts";
import { CRUSH_HULLS, HULLS, type Hull } from "./car-mesh.ts";

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

/** Engine slack (m) a hit too slow to pack the nose still allows (mounts, not crush).
 *  This replaces the old first-hit ENGINE_LIGHT_CAP: the block's reach now
 *  follows the hit's own stroke, so car-car at 25 km/h each cannot grind it. */
const ENGINE_SLACK = 0.04;

/** Packed bumper-to-block-centre length (m): bumper beam and radiator crushed flat ahead of a
 *  0.36 m block. Nose crush past the 0.84 m rest gap minus this shoves the engine back. */
const ENGINE_PACK_GAP = 0.54;

/** How far (m) a single nose hit's dynamic crush peaks short of its stroke: single 48–54 km/h hits at
 *  squash 0.32 and 0.4 all peak the block at the stroke's reach (stroke − 0.30) minus 0.06 ± 0.01 m. */
const STROKE_SHORTFALL = 0.06;

/** Elastic part (m) of a crushed node's travel; the rest is permanent set. */
const SPRINGBACK = 0.08;
/** Physics slice (s) the per-call contact shares (feedOverlap nibble and inbound-speed kill) are tuned at. */
const CONTACT_REF_SLICE = 1 / 240;
/** A wreck takes a new hit only after this long (s) without contact: spikes inside one hit never re-arm. */
const REARM_QUIET = 0.3;
/** Smallest EBS (m/s, 10 km/h) that counts as a new hit on a wreck: the IIHS low-speed bumper test's
 *  6 mph full-width impact, where bumper systems start taking damage (research 12). The old 6 m/s
 *  (22 km/h) floor dropped every car-car hit under 43 km/h closing (each car's EBS is about half the
 *  closing), so a derby's dozens of 25–40 km/h rams added nothing and a 90 s match killed 0–2 cars. */
const REARM_EBS = 2.8;
/** C4: a wheel separates only on an off-centre hit this hard (m/s EBS, 54 km/h)… */
const HUB_POP_MPS = 15;
/** …once the struck corner has crushed to within this of the hub (m): tyre radius 0.32 plus a 0.10 m
 *  packed bumper beam. With the 0.72 m overhang the wheel is reached after 0.30 m of corner crush. */
const TYRE_REACH = 0.42;
/** Tyre (m): radius along the car (TYRE_REACH's 0.32) and half-width across it, for the faces' hub contact. */
export const TYRE_R = 0.32;
export const TYRE_HALF_W = 0.11;
/** A face that shoves a planted hub this far (m, one wheel diameter) off its rest tears the wheel off. */
const WHEEL_DIAMETER = 2 * TYRE_R;
/** Throttle input this recent (s) still counts as "under power" for the settle rule. */
const POWER_HOLD = 0.1;
/** Steel-on-steel sliding friction for car-car mass contacts (same μ as the hull contact in pair-contact). */
const SHEET_MU = 0.45;
/** Largest overlap (m) one car-car mass pair resolves per CONTACT_REF_SLICE (sphereHit). */
const SPHERE_STEP = 0.06;
/** Yaw-rate sanity guard (rad/s) on followGroup's measured heading change; a real wreck spins < 5. */
const YAW_RATE_GUARD = 12;
/** Shortest sim time (s) a yaw-rate sample spans. */
const YAW_RATE_SPAN = 1 / 60;
/** A mass this close (m) to a rigid face still counts as resting on it. */
const FACE_SKIN = 0.02;
/** A hub this close (m) above its 0.28 m ground floor still slides on the ground (dragGround). */
const GROUND_SKIN = 0.08;

/** Per-body-style rig: cage boxes / sensor rests (by SENSORS index) that differ
 *  from the platform tables so the cages wrap that style's roof, glass and boot. */
export interface RigOverrides {
  cages?: Partial<Record<BodyPartName, Pick<CageSpec, "min" | "max">>>;
  sensors?: Partial<Record<number, SensorSpec["rest"]>>;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _panelCo = new Float64Array(24);
const _e = new THREE.Vector3();
const _f = new THREE.Vector3();
const _n = new THREE.Vector3();
/** sphereHit's sliding (tangential) relative velocity. */
const _t = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _mat = new THREE.Matrix4();
/** followGroup's world→local: one invert per call, not one per mass (Object3D.worldToLocal). */
const _toLocal = new THREE.Matrix4();
/** writeShapeToMasses' body → world scratch. */
const _bodyOut = new Float64Array(3);
/** Slice rate the shape-match pulls (goalAlpha, contact alpha) and the step cap were tuned at. */
const SHAPE_REF_HZ = 240;
/** Largest goal step per SHAPE_REF_HZ slice (m): a 33.6 m/s pull limit. */
const SHAPE_MAX_STEP = 0.14;
/** Sim seconds a fed contact keeps the solver in contact mode: two 60 Hz frames. With one, the free
 *  solver (4 passes at α 0.64 at squash 0.32) closed a 100 km/h head-on's remaining shape gap in the
 *  slice after the tyres stopped both cars: bumpers 0.056 m with every mass at rest (limit 0.050). */
const CONTACT_HOLD = 2 / 60;
/** Sim seconds the frame's tilt takes to level out on planting, or to come back on a new hit (followGroup):
 *  0.1 s, CR8's eased level-out (64 km/h head-on roof 0.61× its per-slice 3·v·h + 5 cm limit). */
const LEVEL_TIME = 0.1;
/** Depth (m) inside the chassisCell span's front/rear face over which non-cell skin weight blends back in. */
const CELL_FACE_BLEND = 0.3;
/** Largest non-cell skin weight at the span face (D1): the A-pillar foot still creases. */
const CELL_FACE_SHARE = 0.25;

function hash01(i: number, salt = 1): number {
  const s = Math.sin(i * 127.1 * salt + salt * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Most cluster weights a skin vertex keeps: the 4 nearest plus the cell-face share. */
const SKIN_K = 5;
/** Most cage influences a skin vertex keeps (lattice skin / cluster-less fallback). */
const INF_K = 4;
/** Parent masses per skin point (A5): the paint rides these particles. */
const RES_K = 4;
/** Parent slots: RES_K plus the cell-face share of the nearest non-cabin mass (D1). */
const RES_SLOTS = 5;
/** IDW softening (m²) of the parent weights, 1/(d² + RES_SOFT). */
const RES_SOFT = 0.04;
/**
 * Strain share (β) of the cluster map a skin point's offset from its parent masses takes; the
 * rotation is taken whole. At 1 the strain between the particles extrapolates past them: paint
 * 0.1 m outboard of a pushed door went 8% deeper than the door (piston `right`), at 0.65 within 1%.
 */
const SKIN_STRAIN = 0.65;

/**
 * The trilinear cage map as a polynomial in (u, v, w): 8 coefficients per axis at `out[o + axis * 8]`
 * (A, Bu, Bv, Bw, Euv, Euw, Evw, H). Corner bits: 0 = u (x), 1 = v (y), 2 = w (z).
 */
function cageCoeffs(c: THREE.Vector3[], out: Float64Array, o: number): void {
  for (let a = 0; a < 3; a++, o += 8) {
    const c0 = c[0]!.getComponent(a);
    const c1 = c[1]!.getComponent(a);
    const c2 = c[2]!.getComponent(a);
    const c3 = c[3]!.getComponent(a);
    const c4 = c[4]!.getComponent(a);
    const c5 = c[5]!.getComponent(a);
    const c6 = c[6]!.getComponent(a);
    const c7 = c[7]!.getComponent(a);
    out[o] = c0;
    out[o + 1] = c1 - c0;
    out[o + 2] = c2 - c0;
    out[o + 3] = c4 - c0;
    out[o + 4] = c3 - c2 - c1 + c0;
    out[o + 5] = c5 - c4 - c1 + c0;
    out[o + 6] = c6 - c4 - c2 + c0;
    out[o + 7] = c7 - c6 - c5 + c4 - c3 + c2 + c1 - c0;
  }
}

/** One axis of the trilinear cage map at (u, v, w) from `cageCoeffs` (`o` = that axis' first coefficient). */
function cageAxis(co: Float64Array, o: number, u: number, v: number, w: number): number {
  return co[o]! + u * co[o + 1]! + v * (co[o + 2]! + u * co[o + 4]!) + w * (co[o + 3]! + u * co[o + 5]! + v * (co[o + 6]! + u * co[o + 7]!));
}

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

/** Masses the solver reads by role every step; resolved once in the constructor. */
type KeyMass = "cell" | "engineL" | "engineR" | "axleR" | "doorL" | "doorR" | "hubFL" | "hubFR" | "hubRL" | "hubRR" | "bumperFL" | "bumperFR" | "bumperRL" | "bumperRR";

/** Netplay state of one car's deformation (docs/MULTIPLAYER.md), preallocated from `netSizes()`. */
export interface DeformNetState {
  /** masses × 3: each control particle's current body-frame position (the hulls read these). */
  readonly local: Float32Array;
  /** masses × 3: the particles as of the last skin bake (`massPos`). */
  readonly skinPos: Float32Array;
  /** clusters × 9: each shape cluster's skin map `skinM` at the last bake, row-major. */
  readonly skinXf: Float32Array;
  /** sensors: compression (m). */
  readonly sensor: Float32Array;
  /** 9: impactLocal xyz, impactInward xyz, wrinkle amplitude (ramp applied), buckle, squash. */
  readonly impact: Float32Array;
  /** Bit i: masses[i] popped now (hubs are 16–19); wheels follow these. */
  popped: number;
  /** Bit i: masses[i] popped at the last bake; the skin's wheel arches follow these. */
  skinPopped: number;
  /** 1 massActive, 2 drivetrainAlive (now); 4 deepCrush, 8 bidirectional, 16 lattice mode (at the last bake). */
  flags: number;
  /** Rearward engine-block travel (m) and the travel that kills it (class × realism): `drivetrainHealth`. */
  engineTravel: number;
  killTravel: number;
}

export class StreamedDeformation {
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
  crushAmount = 0;
  impactLocal = new THREE.Vector3();
  impactInward = new THREE.Vector3(0, 0, -1);
  massActive = false;
  drivetrainAlive = true;
  /** Worst engine-block travel toward the cabin so far (m); only rises (updateDrivetrain). */
  engineTravel = 0;
  /** Block travel (m) that kills the drivetrain. Physics default ENGINE_KILL_TRAVEL (sourced); the
   *  handling model may raise it per car (arcade ↔ realistic) without changing how far the block moves. */
  killTravel = ENGINE_KILL_TRAVEL;
  /** Both ends are crumple zones (car-compactor / two-wall squeeze). */
  bidirectional = false;
  /** Sticky until reset: this car was squeezed / deep-crushed, so `clampLocal` keeps those shape limits. */
  private squeezeShape = false;
  private deepShape = false;
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

  private cages: Cage[];
  private sensors: Sensor[];
  private restPos: Float32Array;
  /** Per-vertex wrinkle phase noise in [−0.5, 0.5). */
  private readonly wrinkleSeed: Float64Array;
  /** Cage influences per vertex (≤ INF_K): count, `cageCo` offset, (u, v, w, weight). */
  private readonly infN: Uint8Array;
  private readonly infCo: Int32Array;
  private readonly infUvw: Float64Array;
  /** `cageCoeffs` of every cage (24 per cage), refreshed per skin. */
  private readonly cageCo: Float64Array;
  private vertexCount: number;
  private elapsed = 0;
  private lastContact = -10;
  private crushing = false;
  private impulse = 0;
  /** Equivalent barrier speed (m/s, −1 before any hit) of the current hit: the root-sum-square of every
   *  hit's EBS on the struck end. Crush energy grows with EBS² on a linear-stiffness end, so repeated hits
   *  on one end add stroke; spikes inside one contact never re-arm (`rearmHit`). */
  private hitSpeed = -1;
  /** Σ EBS² per struck end (`struckEnd`: front, rear, left, right). */
  private readonly endEbs2 = new Float64Array(4);
  /** The current hit is a re-armed one (`rearmHit`), not the crash's first. */
  private rearmed = false;
  /** `elapsed` of the last throttle input (`notifyPower`). */
  private lastPower = -10;
  /** `elapsed` when the current hit began (beginCrush, rearmHit): the sliding-drag clock (`sinceHit`). */
  private hitAt = 0;
  private wrinkleAmp = 0;
  private helper: DeformRigHelper | null = null;
  private particleHelper: DeformParticleHelper | null = null;
  /** World xyz shape-match goal per particle for the particle view; NaN = no pull last step. */
  private goalView = new Float64Array(0);
  /** goalView while the particle view is visible, else null so the solver skips the copy. */
  private goalOut: Float64Array | null = null;
  readonly masses: MassNode[];
  private beams: Beam[];
  private readonly at: Record<KeyMass, MassNode>;
  private readonly byName: Map<string, MassNode>;
  /** Hub → mount spring pairs. */
  private readonly suspension: readonly (readonly [MassNode, MassNode])[];
  private readonly cageByPart: Map<BodyPartName, Cage>;
  private _totalMass = 1;
  private prevYaw = 0;
  /** Heading and sim time (`elapsed`) of the last yaw-rate sample in followGroup. */
  private rateYaw = 0;
  private rateAt = 0;
  /** Share (0–1) of the read pitch/roll the frame takes, and the sim time it was last eased at (followGroup). */
  private lean = 1;
  private leanAt = -Infinity;
  /** Hull push (m) taken at sim time `pushAt` (takePush). */
  private pushUsed = 0;
  private pushAt = -1;
  private overlapFrame = false;
  /** Sim time (elapsed) of the last fed contact: the solver stays in contact mode CONTACT_HOLD past it. */
  private contactAt = -Infinity;
  /** stepShapeMatch ran during the current / the previous structure step: the falling edge rebases the rests. */
  private shapeRan = false;
  private shapeWasLive = false;
  /** Body frame of the last syncShapeFromMasses: world = R_y(heading)·(local − bodyRestC) + bodyC. */
  private bodyCos = 1;
  private bodySin = 0;
  private readonly bodyC = new THREE.Vector3();
  private readonly bodyRestC = new THREE.Vector3();
  squash = 0.32;
  buckle = 0.45;
  mode: DeformMode = "shape";
  private clusters: ShapeCluster[] = [];
  /** Per-cluster absorption (its owner cage's), fixed at build time. */
  private clusterAbsorb = new Float64Array(0);
  private clusterOwner: BodyPartName[] = [];
  private shapeParticles: ShapeParticle[] = [];
  private goalX = new Float64Array(0);
  private goalY = new Float64Array(0);
  private goalZ = new Float64Array(0);
  private goalW = new Float64Array(0);
  /** Body-frame x/z of each particle when stepShapeMatch started (net-spin removal). */
  private startX = new Float64Array(0);
  private startZ = new Float64Array(0);
  /** Cluster skin weights per vertex (≤ SKIN_K): count (0 = cage fallback), `clusterXf` offset, weight. */
  private skinN = new Uint8Array(0);
  private skinXf = new Int32Array(0);
  private skinW = new Float64Array(0);
  /** Skin vertex → mass index of the hub that plants it (wheel arch, below 0.55 m), else −1. */
  private skinHub = new Int32Array(0);
  /** Per cluster: skin map M (row-major 9), applied to a skin point's offset from its parent masses (A5). */
  private clusterXf = new Float64Array(0);
  /** Cage corner ← cluster weights (rest-only, so built once): per corner [start, end) into `cornerXf`/`cornerW`, and Σw. */
  private cornerStart = new Int32Array(0);
  private cornerXf = new Int32Array(0);
  private cornerW = new Float64Array(0);
  private cornerWsum = new Float64Array(0);
  private impulseW = new Float64Array(0);
  private skinRest: { x: number; y: number; z: number }[] = [];
  private skinLocal: { x: number; y: number; z: number }[] = [];
  private skinMassN: number[] = [];
  /**
   * A5 skin anchors: per skin point (vertices, then cage corners) up to RES_SLOTS parent masses
   * (×3 offsets into `massPos`), their weights, and their weighted rest centroid; `massPos` is the
   * masses' local positions at the last bake.
   */
  private resJ = new Int32Array(0);
  private resW = new Float64Array(0);
  private resC = new Float64Array(0);
  private massPos = new Float64Array(0);
  /** Netplay: skin inputs as of the last bake (`bakeLocalSkin`), read by `readNetState`. Kept apart
   *  because the post-contact shape-rest rebase resets every cluster's `skinM` under a frozen skin. */
  private netSkinXf = new Float64Array(0);
  private readonly netImpact = new Float64Array(9);
  private netPopped = 0;
  private netFlags = 0;

  constructor(geometry: THREE.BufferGeometry, rig: RigOverrides = {}) {
    const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
    this.vertexCount = pos.count;
    this.restPos = new Float32Array(pos.array as Float32Array);
    // Wrinkle noise per vertex, keyed on the lowest vertex index sharing its rest position so split seams stay shut.
    this.wrinkleSeed = new Float64Array(this.vertexCount);
    const firstAt = new Map<string, number>();
    for (let i = 0; i < this.vertexCount; i++) {
      const key = `${this.restPos[i * 3]},${this.restPos[i * 3 + 1]},${this.restPos[i * 3 + 2]}`;
      const first = firstAt.get(key);
      if (first === undefined) firstAt.set(key, i);
      this.wrinkleSeed[i] = hash01(first ?? i, 3) - 0.5;
    }

    this.cages = CAGES.map((base) => {
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
    this.cageCount = this.cages.length;

    const partIndex = new Map<BodyPartName, number>();
    this.cages.forEach((c, i) => partIndex.set(c.spec.name, i));
    this.cageByPart = new Map(this.cages.map((c) => [c.spec.name, c]));

    this.sensors = SENSORS.map((base, i) => {
      const rest = rig.sensors?.[i];
      const spec = rest ? { ...base, rest } : base;
      return {
        spec,
        rest: new THREE.Vector3(...spec.rest),
        pos: new THREE.Vector3(...spec.rest),
        partIndex: partIndex.get(spec.part) ?? 12,
        compression: 0,
        target: 0,
        delay: 0,
        fired: false,
      };
    });
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
        shoveX: 0,
        shoveZ: 0,
        crushSet: 0,
        baseX: 0,
        baseZ: 0,
        bands: regionCrushBands(spec.name),
        hub: spec.name.startsWith("hub"),
        bumper: spec.name.startsWith("bumper"),
        rail: spec.name.startsWith("rail"),
        crumple: spec.name.startsWith("bumper") || spec.name.startsWith("wing"),
        softness: regionSoftness(spec.name),
      };
    });
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

    // Lattice skin (and the cluster-less fallback): up to INF_K cage influences per vertex, packed as
    // the cage's coefficient offset in `cageCo` + (u, v, w, weight).
    this.infN = new Uint8Array(this.vertexCount);
    this.infCo = new Int32Array(this.vertexCount * INF_K);
    this.infUvw = new Float64Array(this.vertexCount * INF_K * 4);
    this.cageCo = new Float64Array(this.cages.length * 24);
    const skinsCage = this.cages.map((c) => !["doorLeft", "doorRight", "glassFront", "glassRear"].includes(c.spec.name));
    for (let i = 0; i < this.vertexCount; i++) {
      const x = this.restPos[i * 3]!;
      const y = this.restPos[i * 3 + 1]!;
      const z = this.restPos[i * 3 + 2]!;
      const list: Influence[] = [];
      for (let p = 0; p < this.cages.length; p++) {
        if (!skinsCage[p]) continue;
        const cage = this.cages[p]!;
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
        for (let p = 0; p < this.cages.length; p++) {
          if (!skinsCage[p]) continue;
          const c = this.cages[p]!;
          const d = Math.hypot(Math.max(c.min.x - x, 0, x - c.max.x), Math.max(c.min.y - y, 0, y - c.max.y), Math.max(c.min.z - z, 0, z - c.max.z));
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
        const cage = this.cages[best]!;
        list.push({ part: best, u: (x - cage.min.x) / cage.size.x, v: (y - cage.min.y) / cage.size.y, w: (z - cage.min.z) / cage.size.z, weight: 1 });
      } else {
        list.sort((a, b) => b.weight - a.weight);
        if (list.length > INF_K) list.length = INF_K;
        let sum = 0;
        for (const inf of list) sum += inf.weight;
        for (const inf of list) inf.weight /= sum;
      }
      this.infN[i] = list.length;
      for (let k = 0; k < list.length; k++) {
        const inf = list[k]!;
        const s = i * INF_K + k;
        this.infCo[s] = inf.part * 24;
        this.infUvw[s * 4] = inf.u;
        this.infUvw[s * 4 + 1] = inf.v;
        this.infUvw[s * 4 + 2] = inf.w;
        this.infUvw[s * 4 + 3] = inf.weight;
      }
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
    this.startX = new Float64Array(this.masses.length);
    this.startZ = new Float64Array(this.masses.length);
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

  reset(): void {
    this.elapsed = 0;
    this.lastContact = -10;
    this.crushing = false;
    this.impulse = 0;
    this.hitSpeed = -1;
    this.endEbs2.fill(0);
    this.rearmed = false;
    this.lastPower = -10;
    this.wrinkleAmp = 0;
    this.crushAmount = 0;
    this.dirty = false;
    this.massActive = false;
    this.goalView.fill(NaN);
    this.drivetrainAlive = true;
    this.engineTravel = 0;
    this.bidirectional = false;
    this.deepCrush = false;
    this.squeezeShape = false;
    this.deepShape = false;
    this.prevYaw = 0;
    this.rateYaw = 0;
    this.rateAt = 0;
    this.leanAt = -Infinity;
    this.overlapFrame = false;
    this.contactAt = -Infinity;
    this.shapeWasLive = false;
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
      m.shoveX = 0;
      m.shoveZ = 0;
    }
    for (const b of this.beams) {
      b.plastic = b.rest;
      b.alive = true;
    }
    this.captureShapeRest();
  }

  setMode(mode: DeformMode): void {
    this.mode = mode;
    this.helper?.syncMode();
  }

  /** Shape-match rest = the car-local rest pose; plastic state and warm starts cleared. */
  private captureShapeRest(): void {
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      const p = this.shapeParticles[i]!;
      p.x = m.rest.x;
      p.y = m.rest.y;
      p.z = m.rest.z;
      p.mass = m.mass;
    }
    for (const c of this.clusters) resetCluster(c, this.shapeParticles);
  }

  /** Shape-match rest = the current body-frame shape: Sp folds into the rest and resets to I. */
  private rebaseShapeRest(): void {
    this.syncShapeFromMasses();
    for (const c of this.clusters) resetCluster(c, this.shapeParticles);
  }

  /**
   * Shape particles in the car body frame: the masses' world positions turned by the best
   * heading fit (bodyCos/bodySin about world up, through bodyC) of the shape-matched masses
   * onto their rest, so rest, plastic Sp, goals and the impact half-space all share car-local
   * axes at any heading. Up stays world up; pitch and roll are left to the clusters' R.
   */
  private syncShapeFromMasses(): void {
    let cx = 0,
      cy = 0,
      cz = 0,
      rx = 0,
      ry = 0,
      rz = 0,
      ms = 0;
    for (const m of this.masses) {
      if (m.hub && !this.deepCrush) continue;
      cx += m.world.x * m.mass;
      cy += m.world.y * m.mass;
      cz += m.world.z * m.mass;
      rx += m.rest.x * m.mass;
      ry += m.rest.y * m.mass;
      rz += m.rest.z * m.mass;
      ms += m.mass;
    }
    ms = Math.max(ms, 1e-8);
    cx /= ms;
    cy /= ms;
    cz /= ms;
    rx /= ms;
    ry /= ms;
    rz /= ms;
    // max_θ tr(R_y(θ)ᵀ Σ m (x − c)(r − r_c)ᵀ) has the closed form θ = atan2(A02 − A20, A00 + A22).
    let sc = 0,
      ss = 0;
    for (const m of this.masses) {
      if (m.hub && !this.deepCrush) continue;
      const x = (m.world.x - cx) * m.mass,
        z = (m.world.z - cz) * m.mass;
      const u = m.rest.x - rx,
        w = m.rest.z - rz;
      sc += x * u + z * w;
      ss += x * w - z * u;
    }
    const len = Math.hypot(sc, ss);
    const c = len > 1e-9 ? sc / len : 1;
    const s = len > 1e-9 ? ss / len : 0;
    this.bodyCos = c;
    this.bodySin = s;
    this.bodyC.set(cx, cy, cz);
    this.bodyRestC.set(rx, ry, rz);
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      const p = this.shapeParticles[i]!;
      const x = m.world.x - cx,
        z = m.world.z - cz;
      p.x = c * x - s * z + rx;
      p.y = m.world.y - cy + ry;
      p.z = s * x + c * z + rz;
    }
  }

  /** Body-frame point → world, into `out` at offset `o` (inverse of syncShapeFromMasses). */
  private bodyToWorld(x: number, y: number, z: number, out: Float64Array, o: number): void {
    const dx = x - this.bodyRestC.x,
      dz = z - this.bodyRestC.z;
    out[o] = this.bodyCos * dx + this.bodySin * dz + this.bodyC.x;
    out[o + 1] = y - this.bodyRestC.y + this.bodyC.y;
    out[o + 2] = this.bodyCos * dz - this.bodySin * dx + this.bodyC.z;
  }

  private writeShapeToMasses(): void {
    const w = _bodyOut;
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      if (!m.dynamic) continue;
      if (m.hub && !m.popped && !this.deepCrush) continue;
      const p = this.shapeParticles[i]!;
      this.bodyToWorld(p.x, p.y, p.z, w, 0);
      m.world.set(w[0]!, w[1]!, w[2]!);
      if (!Number.isFinite(m.world.x + m.world.y + m.world.z)) m.world.copy(m.rest);
      clampSpeed(m.vel);
    }
  }

  bindKinematic(group: THREE.Object3D, worldVel: THREE.Vector3, worldOmega: THREE.Vector3): void {
    group.updateWorldMatrix(false, false);
    const ox = group.position.x;
    const oz = group.position.z;
    for (const m of this.masses) {
      m.local.copy(m.rest);
      m.world.copy(m.rest).applyMatrix4(group.matrixWorld);
      m.vel.copy(worldVel);
      // v = ω × r with ω = (0, ωy, 0): yaw integrates as rotation.y += ωy·dt.
      const rx = m.world.x - ox;
      const rz = m.world.z - oz;
      m.vel.x += worldOmega.y * rz;
      m.vel.z -= worldOmega.y * rx;
      m.dynamic = false;
      m.crushSet = 0;
      m.baseX = 0;
      m.baseZ = 0;
    }
  }

  /** `impulse` drives FX and glass; `ebs` (equivalent barrier speed, m/s) sizes the crush. */
  beginCrush(
    localPoint: THREE.Vector3,
    localInward: THREE.Vector3,
    impulse: number,
    ebs: number,
    group: THREE.Object3D,
    worldVel: THREE.Vector3,
    worldOmega: THREE.Vector3,
  ): void {
    this.impactLocal.copy(localPoint);
    this.impactInward.copy(localInward).normalize();
    const clamped = THREE.MathUtils.clamp(impulse, 4, 70);
    if (this.hitSpeed < 0) {
      this.hitSpeed = THREE.MathUtils.clamp(ebs, 0, 70);
      this.endEbs2[this.struckEnd()] = this.hitSpeed * this.hitSpeed;
    }
    this.impulse = clamped;
    this.crushing = true;
    this.massActive = true;
    this.elapsed = 0;
    this.lastContact = 0;
    this.hitAt = 0;
    this.wrinkleAmp = 0;
    this.dirty = true;
    this.bindKinematic(group, worldVel, worldOmega);
    for (const m of this.masses) m.dynamic = true;
    this.captureShapeRest();
    this.prevYaw = Math.atan2(Math.sin(group.rotation.y), Math.cos(group.rotation.y));
    this.rateYaw = this.prevYaw;
    this.rateAt = 0;
    this.leanAt = -Infinity;
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

  /**
   * A fresh contact on a wreck: after REARM_QUIET without contact, a hit of at least REARM_EBS takes
   * over the hit frame and adds its EBS² to the struck end, so repeated hard hits keep crushing (and
   * can reach the engine block) instead of reusing the first hit's stroke. False when the contact
   * belongs to the current hit or is too soft.
   */
  rearmHit(localPoint: THREE.Vector3, localInward: THREE.Vector3, impulse: number, ebs: number): boolean {
    if (!this.massActive || this.bidirectional || ebs < REARM_EBS || this.quietTime() < REARM_QUIET) return false;
    this.impactLocal.copy(localPoint);
    this.impactInward.copy(localInward).normalize();
    this.snapImpactToNearestMass();
    const end = this.struckEnd();
    const e = Math.min(ebs, 70);
    this.endEbs2[end] = this.endEbs2[end]! + e * e;
    this.hitSpeed = Math.min(70, Math.sqrt(this.endEbs2[end]!));
    this.rearmed = true;
    this.impulse = THREE.MathUtils.clamp(impulse, 4, 70);
    this.crushing = true;
    this.dirty = true;
    this.lastContact = this.elapsed;
    this.hitAt = this.elapsed;
    // Base = damage as the body frame sees it. A quiet wreck's group sits on its planted hubs, so
    // `local` here carries the cell's offset from them (up to its 0.12 m cap). The contact solve that
    // follows anchors the group on the cell, so a base taken raw pinned the cell 0.1 m off its own
    // anchor: every clampLocal moved it there, the next followGroup moved the group after it, and
    // derby wrecks crawled along the bowl rim at 30–90 m/s with no velocity behind it.
    const cell = this.at.cell;
    const cx = cell.local.x - cell.rest.x;
    const cz = cell.local.z - cell.rest.z;
    for (const m of this.masses) {
      m.baseX = m.local.x - m.rest.x - cx;
      m.baseZ = m.local.z - m.rest.z - cz;
      m.crushSet = 0;
    }
    return true;
  }

  /** End the current hit came in through: 0 front, 1 rear, 2 left (−x), 3 right (+x). */
  private struckEnd(): number {
    const ix = this.impactInward.x;
    const iz = this.impactInward.z;
    if (Math.abs(ix) > Math.abs(iz)) return ix > 0 ? 2 : 3;
    return iz < 0 ? 0 : 1;
  }

  /** Throttle held this step (applyDrive): a wreck under power is not parked by the settle rule. */
  notifyPower(): void {
    this.lastPower = this.elapsed;
  }

  /** Enable lattice masses without starting the crash cinematic (speed-bump hop). */
  armMasses(group: THREE.Object3D, worldVel: THREE.Vector3, worldOmega: THREE.Vector3): void {
    if (this.massActive) return;
    this.massActive = true;
    this.bindKinematic(group, worldVel, worldOmega);
    for (const m of this.masses) m.dynamic = true;
    this.prevYaw = Math.atan2(Math.sin(group.rotation.y), Math.cos(group.rotation.y));
    this.rateYaw = this.prevYaw;
    this.rateAt = this.elapsed;
    this.leanAt = -Infinity;
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

  /**
   * Stopping impulse lands on the crumple face so the rear keeps piling in. The rear's transferred
   * share moves it as one body (equal Δv, momentum ∝ mass): spread per node it gave a 26 kg hub ten
   * times the cell's Δv, the pinned hubs and the clamped nose hid it, and the cell kept ~8 m/s into
   * the stopped car until the hubs planted and let it run 0.12 m up the nose (slow motion only).
   */
  applyImpulse(nx: number, ny: number, nz: number, j: number): void {
    if (!this.massActive || j === 0) return;
    const pass = this.frontTransfer();
    const masses = this.masses;
    const n = masses.length;
    const weights = this.impulseW;
    let wsum = 0;
    let down = 0;
    let downMass = 0;
    for (let i = 0; i < n; i++) {
      const m = masses[i]!;
      if (!m.dynamic) {
        weights[i] = 0;
        continue;
      }
      const face = this.impactWeight(m);
      const downstream = Math.max(0, 1 - this.crumpleWeight(m)) * pass;
      // Face eats the hit; rear only sees the transferred fraction (0.1 / 0.5 / 0.62 / 1).
      weights[i] = face;
      wsum += face + downstream;
      down += downstream;
      downMass += downstream * m.mass;
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
    const downDv = downMass > 1e-9 ? (j * down * invW) / downMass : 0;
    for (let i = 0; i < n; i++) {
      const m = masses[i]!;
      if (!m.dynamic) continue;
      const dv = (j * weights[i]! * invW) / m.mass + (downMass > 1e-9 ? Math.max(0, 1 - this.crumpleWeight(m)) * pass * downDv : 0);
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
      if (!m.dynamic || !m.hub) continue;
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

  hubPopped(name: string): boolean {
    return !!this.byName.get(name)?.popped;
  }

  popHub(m: MassNode): void {
    if (this.wheelsDetach) m.popped = true;
  }

  /**
   * A rigid face moved planted hub `m` by (dx, dz) in world: keep it as the hub's shove (car frame), the
   * pin clampLocal holds it at. Without detachable wheels the shove stops at a wheel diameter.
   */
  shoveHub(m: MassNode, dx: number, dz: number): void {
    const gc = Math.cos(this.prevYaw);
    const gs = Math.sin(this.prevYaw);
    m.shoveX += dx * gc - dz * gs;
    m.shoveZ += dx * gs + dz * gc;
    const len = Math.hypot(m.shoveX, m.shoveZ);
    if (!this.wheelsDetach && len > WHEEL_DIAMETER) {
      m.shoveX *= WHEEL_DIAMETER / len;
      m.shoveZ *= WHEEL_DIAMETER / len;
    }
  }

  massLocal(name: string): THREE.Vector3 {
    return this.massByName(name).local;
  }

  massWorld(name: string): THREE.Vector3 {
    return this.massByName(name).world;
  }

  massVel(name: string): THREE.Vector3 {
    return this.massByName(name).vel;
  }

  /** Sliding-wreck XZ drag (same Coulomb as the tyres) on every mass, while the wreck is on the ground. */
  dragGround(dt: number, amount: number): void {
    if (!this.massActive || amount <= 0) return;
    // Airborne (no hub within GROUND_SKIN of its 0.28 m floor over the ground): nothing to slide on.
    const ground = activeGround();
    let low = Infinity;
    let grip = 1;
    for (const m of this.masses) {
      if (!m.hub || !m.dynamic) continue;
      const lift = m.world.y - ground.heightAt(m.world.x, m.world.z, m.world.y);
      if (lift >= low) continue;
      low = lift;
      grip = ground.frictionAt(m.world.x, m.world.z, m.world.y);
    }
    if (low > 0.28 + GROUND_SKIN) return;
    const mu = CRASH.muSlide * (0.35 + amount * 1.25) * grip;
    for (const m of this.masses) {
      if (!m.dynamic) continue;
      applyGroundFriction(m.vel, dt, mu, true);
    }
  }

  /** Sim seconds since the current hit began (beginCrush or a re-armed hit); car contact does not reset it. */
  sinceHit(): number {
    return this.elapsed - this.hitAt;
  }

  /** Throttle input within POWER_HOLD: the car is driven, not a sliding wreck. */
  get powered(): boolean {
    return this.elapsed - this.lastPower < POWER_HOLD;
  }

  cutDrive(dt: number): void {
    if (!this.massActive || this.drivetrainAlive) return;
    // Unpowered hubs only — cabin inertia keeps piling into the crumple.
    const k = Math.pow(0.55, Math.min(dt, 0.05));
    for (const m of this.masses) {
      if (!m.hub) continue;
      m.vel.x *= k;
      m.vel.z *= k;
    }
  }

  /**
   * Engine pushed back toward the cell along the hit; forward stretch is not a
   * dead block. `local` is already the cell frame (followGroup places the group
   * on the cell); the cell's own capped wobble in that frame is not block travel.
   */
  updateDrivetrain(): void {
    if (!this.drivetrainAlive || !this.massActive) return;
    const el = this.at.engineL;
    const er = this.at.engineR;
    // Only the block's travel along the car toward the cabin packs it into the firewall (measured along
    // the hit, a 45° corner counted the nose's sideways shove and killed at 52 km/h, below the
    // front-middle's 56). It counts whatever the current hit's direction: a side or rear hit on a nose an
    // earlier hit had packed returned early or measured the other way, and derby cars ran 0.25 m back alive.
    let travel = Math.max(el.rest.z - el.local.z, er.rest.z - er.local.z);
    // A rear hit has to cross the cabin to get here: its push along the hit counts too, so the same travel
    // kills a nose around 50 km/h and a tail much later. A side hit shoves the block sideways only.
    if (this.impactInward.z > Math.abs(this.impactInward.x)) travel = Math.max(travel, el.local.z - el.rest.z, er.local.z - er.rest.z);
    // A nose hit moves the block as far as one hit at the nose's energy-equivalent speed (Σ EBS², rearmHit)
    // reaches: the stroke past the crumple, less a single hit's dynamic shortfall. A first hit counts its
    // geometric peak up to that, which kept single-hit kills monotone (0.4: 49.5 km/h peaked 0.155 m and
    // died, 50 km/h 0.139 m lived). A re-armed hit counts it outright: its own peak rides the packed nose's
    // springback and the clip, so three 35 km/h hits killed on the 4th at squash 0.32 (0.128 m at 60 km/h
    // equivalent) and on the 2nd at 0.4 (0.154 m at 49 km/h).
    if (this.hitSpeed >= 0 && -this.impactInward.z > Math.abs(this.impactInward.x)) {
      const crumple = Math.min(this.at.bumperFL.rest.z, this.at.bumperFR.rest.z) - Math.max(el.rest.z, er.rest.z) - ENGINE_PACK_GAP;
      const energy = this.hitStroke() - crumple - STROKE_SHORTFALL;
      travel = this.rearmed ? energy : Math.min(travel, energy);
    }
    if (travel > this.engineTravel) this.engineTravel = travel;
    if (travel > this.killTravel) this.drivetrainAlive = false;
  }

  /** 0–1 drivability of the engine block: 1 untouched, 0 dead (graded damage for the handling model). */
  get drivetrainHealth(): number {
    return this.drivetrainAlive ? THREE.MathUtils.clamp(1 - this.engineTravel / this.killTravel, 0, 1) : 0;
  }

  /** Wheels still on their hubs (0–4). */
  get wheelsOn(): number {
    return (this.at.hubFL.popped ? 0 : 1) + (this.at.hubFR.popped ? 0 : 1) + (this.at.hubRL.popped ? 0 : 1) + (this.at.hubRR.popped ? 0 : 1);
  }

  private massByName(name: string): MassNode {
    return this.byName.get(name) ?? this.at.cell;
  }

  /** How much of this mass belongs to the crumple zone facing the impact (0 = cell, 1 = bumper). */
  private crumpleWeight(m: MassNode): number {
    if (m.name === "cell" || m.name === "roof") return 0;
    if (m.hub) return 0;
    if (m.bumper) return 1;
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

  /** Sphere contact between two cars' masses for one physics slice of `dt` seconds. */
  collideWith(other: StreamedDeformation, dt: number): void {
    if (this.quietTime() > 0.22 && other.quietTime() > 0.22) return;
    const massesA = this.masses;
    const massesB = other.masses;
    const nA = massesA.length;
    const nB = massesB.length;
    const slice = dt / CONTACT_REF_SLICE;
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
        sphereHit(a, b, slice);
      }
    }
  }

  stepStructure(dt: number): void {
    if (!this.massActive) return;
    // Contact fed since the last call: latched in sim time so every slice of this call, and
    // every sub-call of a split frame, solves the same contact.
    if (this.overlapFrame) {
      this.overlapFrame = false;
      this.contactAt = this.elapsed;
    }
    this.elapsed += dt;
    const slices = Math.max(1, Math.min(4, Math.round(dt * 240)));
    const h = dt / slices;
    this.shapeRan = false;
    for (let s = 0; s < slices; s++) this.stepMassSlice(h);
    // The solver window closed this step: the shape the contacts left becomes every cluster's
    // rest (Sp folded in), so a later hit cannot spring earlier damage back. Nothing restores that
    // shape any more, so a body mass's vertical bounce relative to the others would drift on until
    // damped and freeze in as sag: the 40 km/h parity hit's block sank 63 mm under a car's nose but
    // 45 mm under the piston, whose contact (and so window) ran 0.12 s longer. The body moves as one.
    if (this.shapeWasLive && !this.shapeRan) {
      this.rebaseShapeRest();
      let vy = 0;
      let mass = 0;
      for (const m of this.masses) {
        if (!m.dynamic || m.hub) continue;
        vy += m.vel.y * m.mass;
        mass += m.mass;
      }
      if (mass > 0) for (const m of this.masses) if (m.dynamic && !m.hub) m.vel.y = vy / mass;
    }
    this.shapeWasLive = this.shapeRan;
    this.updateDrivetrain();
  }

  followGroup(group: THREE.Object3D, velocityOut: THREE.Vector3, angularOut: THREE.Vector3, dt: number): void {
    const cell = this.at.cell;
    const engL = this.at.engineL;
    const engR = this.at.engineR;
    const axle = this.at.axleR;
    // Heading: the engine mid → axleR axis in world, minus the same axis's angle in the body frame
    // the masses were last clamped into (`local`), seen under the pitch and roll the frame is about to
    // take (YXZ: world = yaw · pitch · roll · local). Reading it against a fixed +z assumed that axis
    // never tilts in the body; an asymmetric crush holds it tilted there, so every call turned the
    // frame by the tilt and clampLocal wrote the turn back into world — up to ~1 rad per frame at a
    // dozen calls per frame (the "wreck spins on the spot" defect). Leaving the frame's own pitch and
    // roll out did the same with the tilt's yaw coupling (dump16 replay: Khaki 11.7 → 7.3 rad/s).
    const fx = (engL.world.x + engR.world.x) * 0.5 - axle.world.x;
    const fy = (engL.world.y + engR.world.y) * 0.5 - axle.world.y;
    const fz = (engL.world.z + engR.world.z) * 0.5 - axle.world.z;
    const yawLen = Math.hypot(fx, fz);
    // Pitch and roll stay absolute and clamped: they are re-read each call, never accumulated.
    const plant = !this.bidirectional && this.quietTime() > 0.2;
    // A planted wreck levels out from 0.35 s quiet and a hit tilts it back, each eased over LEVEL_TIME of
    // sim time. Either switch in one call swung every mass through the tilt: a stopped 64 km/h head-on's
    // roof jumped 0.127 m in one slice (pitch −0.2 → 0), and a parked derby wreck nudged back into play
    // 0.069 m (pitch 0 → −0.08, derby seed 1, c6 at 27.12 s).
    const ease = (this.elapsed - this.leanAt) / LEVEL_TIME;
    this.leanAt = this.elapsed;
    this.lean += THREE.MathUtils.clamp((plant && this.quietTime() >= 0.35 ? 0 : 1) - this.lean, -ease, ease);
    const pitch = THREE.MathUtils.clamp(Math.atan2(-fy, Math.max(yawLen, 0.15)), -0.2, 0.22) * this.lean;
    const roll = THREE.MathUtils.clamp((engR.world.y - engL.world.y) * 0.55, -0.5, 0.5) * this.lean;
    const tilt = Number.isFinite(pitch + roll);
    const cp = Math.cos(tilt ? pitch : 0);
    const sp = Math.sin(tilt ? pitch : 0);
    const cr = Math.cos(tilt ? roll : 0);
    const sr = Math.sin(tilt ? roll : 0);
    const ax = (engL.local.x + engR.local.x) * 0.5 - axle.local.x;
    const ay = (engL.local.y + engR.local.y) * 0.5 - axle.local.y;
    const az = (engL.local.z + engR.local.z) * 0.5 - axle.local.z;
    const bx = ax * cr - ay * sr;
    const bz = (ax * sr + ay * cr) * sp + az * cp;
    const yaw = yawLen > 0.15 && Math.hypot(bx, bz) > 0.15 ? Math.atan2(fx, fz) - Math.atan2(bx, bz) : this.prevYaw;
    const yawSafe = Number.isFinite(yaw) ? Math.atan2(Math.sin(yaw), Math.cos(yaw)) : this.prevYaw;
    let minHub = Infinity;
    for (const m of this.masses) if (m.hub && m.world.y < minHub) minHub = m.world.y;
    if (tilt) group.rotation.set(pitch, yawSafe, roll, "YXZ");
    else group.rotation.set(0, yawSafe, 0, "YXZ");
    // Anchor: a planted wreck on its hubs, a live one on its cell — each at the world point where the
    // last clamp held it in the body (`local`), under the rotation the masses are about to be clamped
    // in. Anchoring on rest, or under a yaw-only frame, jumped the group (and every pinned hub) by the
    // cell's up-to-cap offset or by tilt × height at each plant switch, inside one dt = 0 call.
    let wx = cell.world.x,
      wy = cell.world.y,
      wz = cell.world.z,
      lx = cell.local.x,
      lz = cell.local.z;
    if (plant) {
      let hubM = 0,
        hx = 0,
        hy = 0,
        hz = 0,
        hlx = 0,
        hlz = 0;
      for (const m of this.masses) {
        if (!m.hub || m.popped) continue;
        hx += m.world.x * m.mass;
        hy += m.world.y * m.mass;
        hz += m.world.z * m.mass;
        hlx += m.local.x * m.mass;
        hlz += m.local.z * m.mass;
        hubM += m.mass;
      }
      if (hubM > 1e-8) {
        wx = hx / hubM;
        wy = hy / hubM;
        wz = hz / hubM;
        lx = hlx / hubM;
        lz = hlz / hubM;
      }
    }
    let gy = plant ? cell.world.y - cell.rest.y : cell.world.y - _a.set(cell.local.x, cell.rest.y, cell.local.z).applyQuaternion(group.quaternion).y;
    // The ground under the anchor (a course's hill or bridge deck; 0 on the flat pad; past the fleet
    // disc's rim none: the group follows the anchor down).
    const floor = activeGround().heightAt(wx, wz, wy);
    if (floor !== NO_FLOOR) {
      if (minHub - floor > 0.5) gy = THREE.MathUtils.clamp(gy, floor, floor + 0.12);
      else gy = THREE.MathUtils.clamp(gy, floor, floor + 0.08);
    }
    // The group's height clamp must not leak into the anchor's held x/z through the tilt (a ratchet):
    // solve the anchor's local y for that height so its x/z stay exactly held.
    _a.set(lx, 0, lz).applyQuaternion(group.quaternion);
    _b.set(0, 1, 0).applyQuaternion(group.quaternion);
    _a.addScaledVector(_b, (wy - gy - _a.y) / _b.y);
    // A squeeze anchors on the cell too. Pinning the group at the world origin read a free car's travel
    // as crush: the caps (cell 0.12–0.72 m) held the cell near the origin while the shoved car moved on,
    // and fire("all")'s bumperFR sprang 0.50 → 0.02 m in the 0.25 s after the heads left.
    group.position.set(wx - _a.x, gy, wz - _a.z);
    group.updateWorldMatrix(false, false);
    _toLocal.copy(group.matrixWorld).invert();

    let mx = 0,
      mz = 0,
      mass = 0;
    for (const m of this.masses) {
      m.local.copy(m.world).applyMatrix4(_toLocal);
      mx += m.vel.x * m.mass;
      mz += m.vel.z * m.mass;
      mass += m.mass;
    }
    this.clampLocal(group);
    let hy = 0,
      hm = 0;
    for (const m of this.masses) {
      if (!m.hub) continue;
      hy += m.vel.y * m.mass;
      hm += m.mass;
    }
    if (hm > 1e-6) {
      velocityOut.set(mx / mass, THREE.MathUtils.clamp(hy / hm, -3, 4), mz / mass);
    } else {
      velocityOut.set(mx / mass, 0, mz / mass);
    }
    clampSpeed(velocityOut, CRASH.maxMassMps);
    const span = this.elapsed - this.rateAt;
    if (dt > 1e-5 && span >= YAW_RATE_SPAN) {
      // Heading change over at least a frame of sim time, so the SAT passes (dt = 0), the two pose
      // syncs of one slice and contact jitter inside a frame are not divided by a 1/240 s slice.
      // The clamp is only a guard against a bad fit.
      let dyaw = yawSafe - this.rateYaw;
      if (dyaw > Math.PI) dyaw -= Math.PI * 2;
      if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      const yawRate = THREE.MathUtils.clamp(dyaw / span, -YAW_RATE_GUARD, YAW_RATE_GUARD);
      angularOut.set(
        THREE.MathUtils.clamp(pitch * 0.4, -2, 2),
        Number.isFinite(yawRate) ? yawRate : 0,
        THREE.MathUtils.clamp(roll * 0.4, -2, 2),
      );
      this.rateYaw = yawSafe;
      this.rateAt = this.elapsed;
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
   * Crush length (m) this hit takes out of the struck end, from its
   * equivalent barrier speed: the crumple corner on a frontal, the door band
   * on a side hit, and (B4) the frontal stroke scaled by the chassisRear /
   * chassisFront cage ratio on a rear hit — softer, shorter tail.
   */
  hitStroke(): number {
    const ix = this.impactInward.x;
    const iz = this.impactInward.z;
    const stroke = Math.min((0.5 + this.squash * 1.15) * 1.1, crushStroke(Math.max(0, this.hitSpeed), this.squash));
    if (Math.abs(ix) > Math.abs(iz)) return Math.min(this.at.doorL.bands.max, stroke);
    if (iz <= 0) return stroke;
    return stroke * (this.cageByPart.get("chassisRear")!.spec.maxCrush / this.cageByPart.get("chassisFront")!.spec.maxCrush);
  }

  /** Share of hitStroke the struck end has crushed so far (0 untouched, 1 spent). */
  strokeUsed(): number {
    const cell = this.at.cell;
    const rest =
      this.impactInward.z > 0
        ? cell.rest.z - Math.max(this.at.bumperRL.rest.z, this.at.bumperRR.rest.z)
        : Math.min(this.at.bumperFL.rest.z, this.at.bumperFR.rest.z) - cell.rest.z;
    return (rest - 0.36 - this.crumpleTravelCorner()) / Math.max(1e-3, this.hitStroke());
  }

  /**
   * Crush force from a face moving at `refVn` along its outward normal
   * (nx, nz): impulse `j` (N·s) comes off the masses still moving into it, as
   * one equal Δv, never past the face's speed. Relative motion is kept, so the
   * cabin keeps piling into the stopped nose. Returns the momentum taken (N·s).
   */
  brakeInbound(nx: number, nz: number, j: number, refVn = 0): number {
    if (!this.massActive || j <= 0) return 0;
    let moving = 0;
    for (const m of this.masses) {
      if (m.dynamic && m.vel.x * nx + m.vel.z * nz < refVn) moving += m.mass;
    }
    if (moving < 1e-6) return 0;
    const dv = j / moving;
    let taken = 0;
    for (const m of this.masses) {
      if (!m.dynamic) continue;
      const vn = m.vel.x * nx + m.vel.z * nz - refVn;
      if (vn >= 0) continue;
      const cut = Math.min(-vn, dv);
      m.vel.x += nx * cut;
      m.vel.z += nz * cut;
      taken += cut * m.mass;
    }
    return taken;
  }

  /**
   * Rigid slab at mass level: a mass whose half-radius sphere is inside the
   * box (centre cx/cz, half extents hx/hz, rotated by yaw) goes back out
   * through the nearer of the car-side face or an end face and loses its
   * inbound speed there. Planted hubs are the world pin and stay put on a one-sided
   * hit (the car moves away from the face); squeezed (`bidirectional`) the car
   * cannot, so the face meets the tyre and shoves the hub (`shoveHub`).
   * Returns the momentum taken out (N·s) for the caller to hand to the slab.
   */
  projectOutOfBox(cx: number, cz: number, hx: number, hz: number, yaw: number): number {
    if (!this.massActive) return 0;
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const cell = this.at.cell;
    const side = (cell.world.x - cx) * rx + (cell.world.z - cz) * rz >= 0 ? 1 : -1;
    // Group yaw from the last followGroup: keeps `local` (and so crumpleTravelCorner,
    // which the slab clip reads) in step with the projected world positions.
    const gc = Math.cos(this.prevYaw);
    const gs = Math.sin(this.prevYaw);
    let removed = 0;
    let moved = false;
    this.faceContacts = 0;
    for (const m of this.masses) {
      const planted = m.hub && !m.popped;
      // Planted hubs pin the wreck on a one-sided hit; a squeeze (`bidirectional`) or a face past the wheel
      // centres (`deepCrush`) meets the tyres.
      if (!m.dynamic || (planted && !this.bidirectional && !this.deepCrush)) continue;
      const ox = m.world.x - cx;
      const oz = m.world.z - cz;
      let r = m.radius * 0.5;
      let rEnd = r;
      if (planted) {
        // The face meets the tyre: its tread (TYRE_R) along the car, its sidewall across it.
        r = Math.hypot(TYRE_HALF_W * (rx * gc - rz * gs), TYRE_R * (rx * gs + rz * gc));
        rEnd = Math.hypot(TYRE_HALF_W * (fx * gc - fz * gs), TYRE_R * (fx * gs + fz * gc));
      }
      const lz = ox * fx + oz * fz;
      const penX = hx + r - (ox * rx + oz * rz) * side;
      const penZ = hz + rEnd - Math.abs(lz);
      if (penZ > 0 && penX > -FACE_SKIN) this.faceContacts++;
      if (penX <= 0 || penZ <= 0) continue;
      let nx: number;
      let nz: number;
      let pen: number;
      if (penX <= penZ) {
        nx = rx * side;
        nz = rz * side;
        pen = penX;
      } else {
        const end = lz >= 0 ? 1 : -1;
        nx = fx * end;
        nz = fz * end;
        pen = penZ;
      }
      const dx = nx * pen;
      const dz = nz * pen;
      m.world.x += dx;
      m.world.z += dz;
      m.local.x += dx * gc - dz * gs;
      m.local.z += dx * gs + dz * gc;
      moved = true;
      if (planted && !this.deepCrush) this.shoveHub(m, dx, dz);
      const vn = m.vel.x * nx + m.vel.z * nz;
      if (vn < 0) {
        m.vel.x -= nx * vn;
        m.vel.z -= nz * vn;
        removed -= vn * m.mass;
      }
    }
    // A wreck resting on the face: the face moved its bumpers after this call's clamp, so the packed nose
    // shoves the block with it (clampLocal's pack rule, within the hit's reach). Without it a dead wreck sat
    // at 0.476 m nose gap after 52 + 35 km/h. Not while the cell still drives in: the face's transient push
    // reached the block and killed it in single 35–50 km/h hits.
    const into = -(cell.vel.x * rx + cell.vel.z * rz) * side;
    if (moved && into < 0.3 && !this.bidirectional && this.hitSpeed >= 0 && -this.impactInward.z > Math.abs(this.impactInward.x)) {
      const front = Math.min(this.at.bumperFL.local.z, this.at.bumperFR.local.z) - ENGINE_PACK_GAP;
      const crumple = Math.min(this.at.bumperFL.rest.z, this.at.bumperFR.rest.z) - Math.max(this.at.engineL.rest.z, this.at.engineR.rest.z) - ENGINE_PACK_GAP;
      const reach = Math.max(ENGINE_SLACK, this.hitStroke() - crumple);
      for (const m of [this.at.engineL, this.at.engineR]) {
        const back = Math.min(m.local.z - front, m.local.z - (m.rest.z - reach));
        if (back <= 0) continue;
        m.local.z -= back;
        m.world.x -= gs * back;
        m.world.z -= gc * back;
      }
    }
    return removed;
  }

  /**
   * Hull push (m) this car may still take now, out of `amount`: one slice's pairs and SAT passes share
   * one `satPushCap(dt)` — three passes each pushing a full cap moved a wedged wreck 0.11 m in 6 ms.
   */
  takePush(amount: number, dt: number): number {
    if (this.pushAt !== this.elapsed) {
      this.pushAt = this.elapsed;
      this.pushUsed = 0;
    }
    const ok = Math.max(0, Math.min(amount, satPushCap(dt) - this.pushUsed));
    this.pushUsed += ok;
    return ok;
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
    const cell = this.at.cell;
    const nose = (this.at.bumperFL.local.z + this.at.bumperFR.local.z) * 0.5;
    const tail = (this.at.bumperRL.local.z + this.at.bumperRR.local.z) * 0.5;
    return Math.max(nose - cell.local.z - 0.36, cell.local.z - tail - 0.36, 0);
  }

  /**
   * Remaining crumple on the most-crushed corner of the struck end — SAT
   * bounce and the slab clip use this so a hit actually spends the zone.
   * (Taking the max over both ends read the untouched end on every hit.)
   * Both ends are measured from the car origin, not the cell (which sits
   * `cell.rest.z` ahead of it): from the cell a mint tail read 0.12 m longer
   * than a mint nose, the slab clip saw a full zone until 0.26 m of tail
   * crush and stopped a 50 km/h reverse hit at 0.23 m.
   */
  crumpleTravelCorner(): number {
    const cell = this.at.cell;
    if (this.impactInward.z > 0) {
      const lag = 0.36 + 2 * cell.rest.z;
      const rl = cell.local.z - this.at.bumperRL.local.z - lag;
      const rr = cell.local.z - this.at.bumperRR.local.z - lag;
      return Math.max(Math.min(rl, rr), 0);
    }
    const fl = this.at.bumperFL.local.z - cell.local.z - 0.36;
    const fr = this.at.bumperFR.local.z - cell.local.z - 0.36;
    return Math.max(Math.min(fl, fr), 0);
  }

  kickAlong(nx: number, ny: number, nz: number, dv: number): void {
    this.kickCore(nx, ny, nz, dv);
  }

  /**
   * Contact crush from a face pressing in along `inward`. `refVn` is the face's speed along `inward`: a
   * fixed slab's 0, or a car-car pair's common velocity, so the struck car's contact masses are driven
   * to it (its side crushes) rather than the bullet's nose stopping dead against a car that gets no momentum.
   */
  feedOverlap(worldPoint: THREE.Vector3, inward: THREE.Vector3, overlap: number, closing: number, dt = 1 / 60, refVn = 0): number {
    if (!this.massActive) return closing;
    this.overlapFrame = true;
    const leftover = leftoverCrumple(this.crumpleTravel());
    const s = this.squash;
    const live = s < 0.03 ? 0 : 1;
    const ke = closingKeScale(closing);
    const absorbFrac = leftover * (0.5 + s * 0.42) * live;
    const eaten = Math.max(0, closing) * absorbFrac;
    // Per-call shares are tuned at the engine's 1/240 s slice; scale them to the slice actually
    // taken so slow motion (1/1875 s slices, 8× the calls per sim second) crushes the same.
    const slice = dt / CONTACT_REF_SLICE;
    // Overlap becomes local crush. Amount tracks ½mv², never (overlap/dt) velocity.
    const crush = Math.min(Math.max(0, overlap) * (0.4 + s * 0.35) * ke, 0.06 + ke * 0.2) * Math.min(1, 0.35 * slice) * live;
    if (crush < 1e-5 && eaten < 1e-5) return closing;
    this.impulse = Math.max(this.impulse, THREE.MathUtils.clamp(closing, 0, 70));

    const cell = this.at.cell;
    const nose = (this.at.bumperFL.local.z + this.at.bumperFR.local.z) * 0.5;
    const tail = (this.at.bumperRL.local.z + this.at.bumperRR.local.z) * 0.5;
    const noseLeft = Math.max(0, nose - cell.local.z - 0.38);
    const tailLeft = Math.max(0, cell.local.z - tail - 0.38);
    const bumperLeft = THREE.MathUtils.clamp(Math.max(noseLeft, tailLeft) / 1.45, 0, 1);
    const passFront = this.frontTransfer();

    for (const m of this.masses) {
      if (!m.dynamic) continue;
      if (m.hub && !m.popped && !this.deepCrush) continue;
      const zone = this.impactWeight(m);
      if (zone < 0.04) continue;
      const d = m.world.distanceTo(worldPoint);
      const reach = 1.05 + s * 0.35;
      if (d > reach) continue;
      const fall = (1 - d / reach) ** 2 * zone;
      const soft = m.softness;
      const gate = this.bidirectional ? 1 : crushGate(closing, soft) * live;
      if (gate < 1e-4) continue;
      const engine = m.name === "engineL" || m.name === "engineR";
      const engineGate = engine ? (bumperLeft > 0.55 ? 0.4 : 1) : 1;
      const pass = this.crumpleWeight(m) < 0.45 ? passFront : 1;
      const posNibble = crush * fall * gate * soft * engineGate * pass;
      m.world.addScaledVector(inward, posNibble);
      const vn = m.vel.dot(inward) - refVn;
      // Plastic: kill inbound speed relative to the face. Never add (crush/dt) — that rockets in slomo.
      if (vn < 0) m.vel.addScaledVector(inward, -vn * (1 - Math.pow(1 - Math.min(1, fall * 0.85 + gate * 0.15), slice)));
    }
    return Math.max(0, closing - eaten);
  }

  applyImpact(localPoint: THREE.Vector3, localInward: THREE.Vector3, impulse: number): void {
    this.impactLocal.copy(localPoint);
    this.impactInward.copy(localInward).normalize();
    const clamped = THREE.MathUtils.clamp(impulse, 4, 70);
    if (this.hitSpeed < 0) this.hitSpeed = clamped;
    this.impulse = clamped;
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

      this.bakeLocalSkin();
      this.solveCages();
      if (this.skinDeferred) this.skinOwed = true;
      else this.flushSkin(geometry, true);
      // Plastic leftover (maxC) is not "still crushing". Keep skinning while
      // masses are live or contact is fresh — otherwise we rewrite the mesh
      // from a jittering polar every frame (flicker) and pay computeVertexNormals
      // through the slomo→1× handoff (hitch).
      // Contact window only. Residual bounce / cluster breathing is not crush —
      // reskinning it every frame is the polar snap-back flicker.
      this.crushing = this.bidirectional || this.quietTime() < 0.28;
      // Window closed with a deferred skin: write it now, from this frame's solve — the pose an
      // always-skinned car freezes on. Later state drifts (cm), so a late catch-up would not match.
      if (!this.crushing && this.skinOwed) this.flushSkin(geometry);
    }
    this.helper?.update();
    this.particleHelper?.update();
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
      if (!m.dynamic || m.hub) continue;
      const dx = m.vel.x - mx;
      const dy = m.vel.y - my;
      const dz = m.vel.z - mz;
      if (dx * dx + dy * dy + dz * dz > 0.09) return true;
    }
    return false;
  }

  liveHulls(frontDetached = false, rearDetached = false): Hull[] {
    void frontDetached;
    void rearDetached;
    const cell = this.at.cell;
    const engineL = this.at.engineL;
    const engineR = this.at.engineR;
    const doorL = this.at.doorL;
    const doorR = this.at.doorR;
    const axleR = this.at.axleR;
    const hubFL = this.at.hubFL;
    const hubFR = this.at.hubFR;
    const hubRL = this.at.hubRL;
    const hubRR = this.at.hubRR;

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
      HULLS,
    );
  }

  liveCrushHulls(frontDetached = false, rearDetached = false): Hull[] {
    const fl = this.at.bumperFL;
    const fr = this.at.bumperFR;
    const rl = this.at.bumperRL;
    const rr = this.at.bumperRR;
    const cell = this.at.cell;
    const engineL = this.at.engineL;
    const engineR = this.at.engineR;
    const doorL = this.at.doorL;
    const doorR = this.at.doorR;
    const axleR = this.at.axleR;

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
      CRUSH_HULLS,
    );
  }

  /** Non-finite live hulls fall back to the rest hull (shared, never mutated by callers). */
  private sanitizeHulls(hulls: Hull[], fallback: readonly Hull[]): Hull[] {
    for (let i = 0; i < hulls.length; i++) {
      const h = hulls[i]!;
      if (!Number.isFinite(h.cx) || !Number.isFinite(h.cz) || !Number.isFinite(h.hx) || !Number.isFinite(h.hz)) {
        hulls[i] = fallback[i]!;
      }
    }
    return hulls;
  }

  skinPanel(geometry: THREE.BufferGeometry, rest: Float32Array, name: BodyPartName, origin: THREE.Vector3): void {
    const cage = this.cageByPart.get(name);
    if (!cage) return;
    const attr = geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const co = _panelCo;
    cageCoeffs(cage.corners, co, 0);
    co[0]! -= origin.x;
    co[8]! -= origin.y;
    co[16]! -= origin.z;
    const isx = 1 / (cage.size.x || 1);
    const isy = 1 / (cage.size.y || 1);
    const isz = 1 / (cage.size.z || 1);
    const ox = origin.x - cage.min.x;
    const oy = origin.y - cage.min.y;
    const oz = origin.z - cage.min.z;
    for (let r = 0; r < attr.count * 3; r += 3) {
      const u = THREE.MathUtils.clamp((rest[r]! + ox) * isx, -0.15, 1.15);
      const v = THREE.MathUtils.clamp((rest[r + 1]! + oy) * isy, -0.15, 1.15);
      const w = THREE.MathUtils.clamp((rest[r + 2]! + oz) * isz, -0.15, 1.15);
      arr[r] = cageAxis(co, 0, u, v, w);
      arr[r + 1] = cageAxis(co, 8, u, v, w);
      arr[r + 2] = cageAxis(co, 16, u, v, w);
    }
    attr.needsUpdate = true;
    computeNormalsFast(geometry);
  }

  createHelper(parent: THREE.Object3D): void {
    this.helper ??= new DeformRigHelper(parent, {
      cages: this.cages,
      sensors: this.sensors,
      masses: this.masses,
      beams: this.beams,
      clusters: this.clusters,
      mode: () => this.mode,
    });
    if (!this.particleHelper) {
      this.goalView = new Float64Array(this.masses.length * 3).fill(NaN);
      this.particleHelper = new DeformParticleHelper(parent, { particles: this.masses, goals: this.goalView });
    }
  }

  setHelperVisible(v: boolean): void {
    this.helper?.setVisible(v);
  }

  setParticlesVisible(v: boolean): void {
    this.goalOut = v && this.particleHelper ? this.goalView : null;
    if (!v) this.goalView.fill(NaN);
    this.particleHelper?.setVisible(v);
  }

  disposeHelper(): void {
    this.helper?.dispose();
    this.helper = null;
    this.particleHelper?.dispose();
    this.particleHelper = null;
    this.goalOut = null;
  }

  get impulseValue(): number {
    return this.impulse;
  }

  /** Equivalent barrier speed of the hit that started this crash (m/s, −1 before any hit). */
  get hitSpeedValue(): number {
    return this.hitSpeed;
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
    const cage = this.cageByPart.get(name);
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

  /** Write the current cage pose into the mesh if a skin is owed (or `force`). Returns true if it skinned. */
  flushSkin(geometry: THREE.BufferGeometry, force = false): boolean {
    if (!force && !this.skinOwed) return false;
    this.skinOwed = false;
    this.skin(geometry);
    return true;
  }

  restoreRest(geometry: THREE.BufferGeometry): void {
    const attr = geometry.getAttribute("position") as THREE.BufferAttribute;
    (attr.array as Float32Array).set(this.restPos);
    attr.needsUpdate = true;
    computeNormalsFast(geometry);
    this.skinOwed = false;
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
      clusters: this.clusters.map((c, ci) => ({
        owner: this.clusterOwner[ci]!,
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
    // A squeeze's relaxed shape limits stay until reset: clamping a squeezed shape back to the one-ended
    // limits when the squeeze ended popped the dents out (fire("all"): bumperFL 0.49 → 0.30 m in 1 s).
    // Only the squeeze's rules (origin pin, no planting, no re-arm) end with it.
    if (this.bidirectional) this.squeezeShape = true;
    if (this.deepCrush) this.deepShape = true;
    const squeeze = this.squeezeShape;
    const deep = this.deepShape;
    const maxCrush = squeeze ? 1.65 : 0.5 + this.squash * 1.15;
    // B1/B3/B4: a hit only crushes as far as its stroke reaches (armMasses has no hit).
    const stroke = this.hitSpeed >= 0 ? this.hitStroke() : Infinity;
    const sideHit = Math.abs(ix) > Math.abs(iz);
    const spin = this.yawMomentum();
    for (const m of this.masses) {
      let dx = m.local.x - m.rest.x;
      let dy = m.local.y - m.rest.y;
      let dz = m.local.z - m.rest.z;
      // Earlier hits' damage stays put: the far-side spring and the crush/lateral caps below
      // measure only what the current hit adds on top of it.
      const bx = squeeze ? 0 : m.baseX;
      const bz = squeeze ? 0 : m.baseZ;
      const base = bx * ix + bz * iz;
      const along = dx * ix + dz * iz - base;
      const side = m.rest.x * ix + m.rest.z * iz;
      if (!squeeze && side > 0.12) {
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
          ? deep
            ? 0.28
            : 0.07
          : m.hub
            ? 0.07
            : m.name === "cell"
              ? deep
                ? 0.22
                : 0.06
              : 0.11;
      dy = THREE.MathUtils.clamp(dy, -maxDy, maxDy * 1.25);
      const cw = squeeze ? 1 : this.cornerWeight(m);
      const latCap = squeeze ? 0.55 : 0.04 + cw * 0.07;
      if (squeeze || m.hub) {
        // A hub keeps at least the shove a face gave it, popped or not.
        const shove = m.hub ? Math.hypot(m.shoveX, m.shoveZ) : 0;
        const cap = m.name === "cell" || m.name === "roof" ? (deep ? 0.72 : 0.12) : m.hub ? Math.max(squeeze ? 0.95 : 0.38, shove) : maxCrush;
        const len = Math.hypot(dx, dz);
        if (len > cap) {
          const k = cap / len;
          dx *= k;
          dz *= k;
        }
        if (Math.abs(dx) > Math.max(latCap, Math.abs(m.shoveX))) dx = Math.sign(dx) * Math.max(latCap, Math.abs(m.shoveX));
        if (squeeze && !m.hub && m.name !== "cell") {
          // A squeezed shape keeps its set like a one-ended hit's: only the last SPRINGBACK of a
          // particle's distance change to the cell (shortened or bowed out) is elastic. Shape matching
          // and the cabin fold sprang fire("all")'s bumpers 0.10–0.46 m back out once the heads left.
          const c = this.at.cell;
          const rx = m.rest.x + dx - c.local.x;
          const ry = m.rest.y + dy - c.local.y;
          const rz = m.rest.z + dz - c.local.z;
          const len = Math.hypot(rx, ry, rz);
          const restLen = m.rest.distanceTo(c.rest);
          const dev = restLen - len;
          const set = m.crushSet;
          if (Math.abs(dev) - SPRINGBACK > Math.abs(set)) m.crushSet = dev - Math.sign(dev) * SPRINGBACK;
          // A bowed-out set holds only out of contact: a face still pressing may push the panel back in.
          else if (len > 1e-6 && (set > 0 ? dev < set : dev > set && this.quietTime() > 0.025)) {
            const k = (restLen - set) / len;
            dx = c.local.x + rx * k - m.rest.x;
            dy = c.local.y + ry * k - m.rest.y;
            dz = c.local.z + rz * k - m.rest.z;
          }
        }
      } else {
        // Hit frame: crush runs along impactInward, the rest of the planar travel is lateral. The
        // stroke is the struck end's total (rearmHit), so a node already crushed along it gets less.
        const cabin = m.name === "cell" || m.name === "roof";
        let cap = cabin ? (deep ? 0.72 : 0.12) : Math.min(maxCrush * (0.38 + 0.72 * cw), stroke);
        if (sideHit && (m.name === "doorL" || m.name === "doorR")) cap = Math.min(cap, m.bands.max);
        cap = Math.max(0, cap - Math.max(0, base));
        dx -= bx;
        dz -= bz;
        let along = dx * ix + dz * iz;
        let px = dx - along * ix;
        let pz = dz - along * iz;
        along = THREE.MathUtils.clamp(along, -cap, cap);
        if (!cabin && this.hitSpeed >= 0) {
          // Sheet metal keeps its set: only the last SPRINGBACK of crush is elastic.
          if (along - SPRINGBACK > m.crushSet) m.crushSet = along - SPRINGBACK;
          else if (along < m.crushSet) along = m.crushSet;
        }
        const perp = Math.hypot(px, pz);
        if (perp > latCap) {
          const k = latCap / perp;
          px *= k;
          pz *= k;
        }
        dx = along * ix + px + bx;
        dz = along * iz + pz + bz;
      }
      if ((m.name === "engineL" || m.name === "engineR") && !squeeze && !sideHit && iz < 0) {
        // The mounts hold the block (ENGINE_SLACK past earlier hits' set) until the crushed nose packs
        // against it; the packed nose then shoves it back, as far as this hit's stroke reaches. A
        // floor at the stroke's reach let a 43 km/h hit creep the block 0.045 m with 0.58 m of nose left.
        const nose = Math.min(this.at.bumperFL.local.z, this.at.bumperFR.local.z);
        const pushed = nose - ENGINE_PACK_GAP - m.rest.z;
        const reach = Math.max(ENGINE_SLACK, stroke - (Math.min(this.at.bumperFL.rest.z, this.at.bumperFR.rest.z) - m.rest.z - ENGINE_PACK_GAP));
        const floor = Math.max(-reach, Math.min(Math.min(0, bz) - ENGINE_SLACK, pushed));
        if (dz < floor) dz = floor;
        if (dz > pushed) dz = pushed;
      }
      if (m.hub && !deep) {
        if (!m.popped && this.hitSpeed >= HUB_POP_MPS && !sideHit && Math.abs(this.impactLocal.x) >= 0.2 && cw > 0.6) {
          // C4: wheels leave where real cars lose them — a hard off-centre (small overlap) hit whose
          // struck corner has crushed through the overhang onto the tyre. A full-width hit loads
          // the rails and leaves the wheels on, however hard.
          const front = m.rest.z > 0;
          const left = m.rest.x < 0;
          const corner = front ? (left ? this.at.bumperFL : this.at.bumperFR) : left ? this.at.bumperRL : this.at.bumperRR;
          const crushed = (corner.local.x - corner.rest.x) * ix + (corner.local.z - corner.rest.z) * iz;
          if (front === iz < 0 && crushed >= Math.abs(corner.rest.z - m.rest.z) - TYRE_REACH) this.popHub(m);
        }
        if (!m.popped && Math.hypot(m.shoveX, m.shoveZ) > WHEEL_DIAMETER) this.popHub(m);
        if (!m.popped) {
          dx = m.shoveX;
          dz = m.shoveZ;
        }
      }
      m.local.set(m.rest.x + dx, m.rest.y + dy, m.rest.z + dz);
      if (squeeze) {
        const lim = Math.abs(m.rest.z) + 0.04;
        if (Math.abs(m.local.z) > lim) m.local.z = Math.sign(m.local.z || m.rest.z) * lim;
        if (this.deepCrush && this.mode === "lattice" && m.rail) {
          if (m.local.distanceTo(m.rest) < 0.22) m.local.z = m.rest.z * 0.67;
        }
      }
      // Planted tires are the world pin. Projecting them through a pitched
      // group was ratcheting the wreck backward every followGroup.
      if (m.hub && !m.popped && !this.deepCrush && this.quietTime() > 0.2) continue;
      m.world.copy(m.local);
      group.localToWorld(m.world);
    }
    // The clamp moves positions only: writing back a crushing body (its front masses slower than its
    // rear) changed Σ m r × v, spin from nowhere (dump16 replay: clampLocal put +8.7 rad/s of L/I into
    // Khaki, −8.6 into Bronze). Hand back the angular momentum the masses had, as a rigid turn.
    this.yawMomentum(spin);
    // A car on no wheels is out, like a dead engine.
    if (this.at.hubFL.popped && this.at.hubFR.popped && this.at.hubRL.popped && this.at.hubRR.popped) this.drivetrainAlive = false;
  }

  /** The masses' angular momentum about their centroid (y), or, given `target`, a rigid turn added to
   *  every mass's velocity that sets it to `target`. */
  private yawMomentum(target = NaN): number {
    let mass = 0,
      cx = 0,
      cz = 0;
    for (const m of this.masses) {
      cx += m.world.x * m.mass;
      cz += m.world.z * m.mass;
      mass += m.mass;
    }
    cx /= mass;
    cz /= mass;
    let l = 0,
      inertia = 0;
    for (const m of this.masses) {
      const rx = m.world.x - cx;
      const rz = m.world.z - cz;
      l += m.mass * (rz * m.vel.x - rx * m.vel.z);
      inertia += m.mass * (rx * rx + rz * rz);
    }
    if (Number.isNaN(target) || inertia < 1e-9) return l;
    const w = (target - l) / inertia;
    for (const m of this.masses) {
      m.vel.x += w * (m.world.z - cz);
      m.vel.z -= w * (m.world.x - cx);
    }
    return target;
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
    const absorb = this.clusterAbsorb[ci]!;
    if (this.squash < 0.03) return 0.04;
    // Müller T = (1-β)R + βA. High β is jelly stretch. Bugbear/Rajala: metal
    // wants rotation + plastic rest update, not a linear squash of the whole cell.
    if (contacting) return THREE.MathUtils.lerp(0.18 + this.squash * 0.22, 0.03, THREE.MathUtils.clamp(absorb, 0, 1));
    return deformBeta(this.squash) * (1 - absorb * 0.5);
  }

  private stepShapeMatch(dt: number): void {
    this.syncShapeFromMasses();
    this.shapeRan = true;
    const contacting = this.bidirectional || this.elapsed - this.contactAt <= CONTACT_HOLD;
    let comX = 0,
      comY = 0,
      comZ = 0,
      comM = 0;
    for (let i = 0; i < this.shapeParticles.length; i++) {
      const hub = this.masses[i]!;
      if (hub.hub && !this.deepCrush) continue;
      const p = this.shapeParticles[i]!;
      comX += p.x * p.mass;
      comY += p.y * p.mass;
      comZ += p.z * p.mass;
      comM += p.mass;
    }
    comM = Math.max(comM, 1e-8);
    for (let i = 0; i < this.shapeParticles.length; i++) {
      this.startX[i] = this.shapeParticles[i]!.x;
      this.startZ[i] = this.shapeParticles[i]!.z;
    }
    const alphaRef = contacting
      ? this.squash < 0.03
        ? 0.9
        : 0.32 + this.squash * 0.38
      : goalAlpha(this.squash);
    const iters = contacting ? 2 : stiffnessIters(this.squash);
    // alphaRef is the per-iteration pull at the SHAPE_REF_HZ slice: as a time constant
    // (x += (1 − e^{−h/τ})(g − x), XPBD's first-order form) the pull per sim second holds
    // at any slice length, so slow-mo and refresh rate leave the stiffness alone.
    const alpha = 1 - Math.pow(1 - alphaRef, dt * SHAPE_REF_HZ);
    const maxStep = SHAPE_MAX_STEP * dt * SHAPE_REF_HZ;
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
      const out = k === iters - 1 ? this.goalOut : null;
      out?.fill(NaN);
      for (let i = 0; i < this.shapeParticles.length; i++) {
        const p = this.shapeParticles[i]!;
        const hub = this.masses[i]!;
        if (hub.hub && !this.deepCrush) continue;
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
          if (hub.bumper && Math.abs(gz) < Math.abs(p.z)) gz = p.z;
        } else {
          const along = (gx - p.x) * ix + (gz - p.z) * iz;
          if (along < 0) {
            gx -= ix * along;
            gz -= iz * along;
          }
        }
        if (out) this.bodyToWorld(gx, gy, gz, out, i * 3);
        const ax0 = alpha * (gx - p.x);
        const ay0 = alpha * (gy - p.y);
        const az0 = alpha * (gz - p.z);
        const step = Math.hypot(ax0, ay0, az0);
        const kStep = step > maxStep ? maxStep / step : 1;
        const ax = ax0 * kStep;
        const ay = ay0 * kStep;
        const az = az0 * kStep;
        p.x += ax;
        p.y += ay;
        p.z += az;
      }
    }
    // Internal goals exert no net torque: remove the correction's spin about up (no hub, wheel
    // or ground restores yaw, so overlapping plastic rests would otherwise turn the wreck).
    const cx = comX / comM,
      cz = comZ / comM;
    let spin = 0,
      inertia = 0;
    for (let i = 0; i < this.shapeParticles.length; i++) {
      if (this.masses[i]!.hub && !this.deepCrush) continue;
      const p = this.shapeParticles[i]!;
      const rx = this.startX[i]! - cx,
        rz = this.startZ[i]! - cz;
      spin += p.mass * (rz * (p.x - this.startX[i]!) - rx * (p.z - this.startZ[i]!));
      inertia += p.mass * (rx * rx + rz * rz);
    }
    const w = inertia > 1e-8 ? spin / inertia : 0;
    if (Math.abs(w) > 1e-12) {
      for (let i = 0; i < this.shapeParticles.length; i++) {
        if (this.masses[i]!.hub && !this.deepCrush) continue;
        const p = this.shapeParticles[i]!;
        p.x -= w * (this.startZ[i]! - cz);
        p.z += w * (this.startX[i]! - cx);
      }
    }
    if (!contacting) {
      let comX1 = 0,
        comY1 = 0,
        comZ1 = 0;
      for (let i = 0; i < this.shapeParticles.length; i++) {
        const hub = this.masses[i]!;
        if (hub.hub && !this.deepCrush) continue;
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
          if (hub.hub && !this.deepCrush) continue;
          const p = this.shapeParticles[i]!;
          p.x += dx;
          p.y += dy;
          p.z += dz;
        }
      }
    }
    if (contacting) {
      for (const c of this.clusters) applyPlasticity(c, this.shapeParticles, dt, this.squash, this.buckle);
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
      if (!m.rail) continue;
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
      else this.goalOut?.fill(NaN);
    } else {
      this.goalOut?.fill(NaN);
      this.stepBeams(dt);
    }

    this.stepSuspension(dt);

    // A car under power is driven, not a quiet wreck: the settle rule below must not park it.
    const powered = this.elapsed - this.lastPower < POWER_HOLD;
    // A course's ground (hills, bridge decks; 0 and grip 1 on the flat pad), read per mass on its own layer.
    const ground = activeGround();
    for (const m of this.masses) {
      if (!m.dynamic) continue;
      // Past the fleet disc's rim: gravity alike on every mass and no ground rules, so the car falls whole.
      if (ground.heightAt(m.world.x, m.world.z, m.world.y) === NO_FLOOR) {
        m.vel.y -= 9.6 * dt;
        clampSpeed(m.vel);
        m.world.addScaledVector(m.vel, dt);
        continue;
      }
      const hub = m.hub;
      if (hub) m.vel.y -= 9.6 * dt;
      else if (m.vel.y < 0) m.vel.y *= Math.pow(0.12, dt);
      const quiet = this.quietTime();
      // During contact: almost no extra damping so crumple can run.
      // After the last collision, ease into rest over a few seconds.
      let rate = 0.988;
      if (!this.drivetrainAlive && quiet > 0.12) {
        const t = THREE.MathUtils.clamp((quiet - 0.12) / 1.8, 0, 1);
        const s = t * t * (3 - 2 * t);
        rate = THREE.MathUtils.lerp(0.96, 0.18, s);
      }
      m.vel.multiplyScalar(Math.pow(rate, dt));
      clampSpeed(m.vel);
      if (quiet > 2.4 && !powered && m.vel.lengthSq() < 0.08) m.vel.set(0, 0, 0);
      m.world.addScaledVector(m.vel, dt);
      if (!Number.isFinite(m.world.x + m.world.y + m.world.z)) {
        m.world.copy(m.rest);
        m.vel.set(0, 0, 0);
      }
      const floor = ground.heightAt(m.world.x, m.world.z, m.world.y);
      // This step carried it past the rim: no ground rules either (`floor + k` is -Infinity).
      if (floor === NO_FLOOR) continue;
      const grip = ground.frictionAt(m.world.x, m.world.z, m.world.y);
      if (hub) {
        if (m.world.y < floor + 0.28) {
          m.world.y = floor + 0.28;
          if (m.vel.y < 0) m.vel.y = 0;
        }
        const mu = !this.drivetrainAlive
          ? CRASH.muSlide
          : leftoverCrumple(this.crumpleTravel()) > 0.28
            ? CRASH.muScuff
            : CRASH.muSlide;
        applyGroundFriction(m.vel, dt, mu * grip, true);
      } else {
        if (m.world.y < floor + 0.16) {
          m.world.y = floor + 0.16;
          if (m.vel.y < 0) m.vel.y *= -0.22;
        }
        if (quiet > 0.12) {
          const grab = THREE.MathUtils.clamp((quiet - 0.12) / 0.45, 0, 1);
          applyGroundFriction(m.vel, dt, CRASH.muSlide * grab * grip, true);
        } else if (m.world.y < floor + 0.16) {
          applyGroundFriction(m.vel, dt, CRASH.muScuff * grip, true);
        }
      }
      if (m.world.y > floor + 3.4) {
        m.world.y = floor + 3.4;
        m.vel.y = 0;
      }
      if (!hub && !this.bidirectional && m.world.y > floor + 0.22) {
        m.vel.y = THREE.MathUtils.clamp(m.vel.y, -2.2, 3);
      }
    }
    this.holdEngineBlock();
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

  /** A3: the block is one casting — engineL/engineR keep their rest spacing and share their
   *  velocity along it (mass-weighted), whatever the crumple does around them. */
  private holdEngineBlock(): void {
    const a = this.at.engineL;
    const b = this.at.engineR;
    const wa = a.dynamic ? 1 / a.mass : 0;
    const wb = b.dynamic ? 1 / b.mass : 0;
    const w = wa + wb;
    if (w < 1e-8) return;
    const dx = b.world.x - a.world.x;
    const dy = b.world.y - a.world.y;
    const dz = b.world.z - a.world.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    const nx = dx / len;
    const ny = dy / len;
    const nz = dz / len;
    const err = (len - a.rest.distanceTo(b.rest)) / w;
    a.world.x += nx * err * wa;
    a.world.y += ny * err * wa;
    a.world.z += nz * err * wa;
    b.world.x -= nx * err * wb;
    b.world.y -= ny * err * wb;
    b.world.z -= nz * err * wb;
    const rel = ((b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny + (b.vel.z - a.vel.z) * nz) / w;
    a.vel.x += nx * rel * wa;
    a.vel.y += ny * rel * wa;
    a.vel.z += nz * rel * wa;
    b.vel.x -= nx * rel * wb;
    b.vel.y -= ny * rel * wb;
    b.vel.z -= nz * rel * wb;
  }

  private stepSuspension(dt: number): void {
    const k = 11000;
    const c = 260;
    for (const [hub, mount] of this.suspension) {
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

  /**
   * Skin (A5) = a skin point's parent masses where they are now, plus the blend of its clusters'
   * least-squares maps of rest onto the current local particles (SKIN_STRAIN of the strain,
   * plastic Sp composed in) on its short offset from those parents. The paint rides the
   * particles, so a dent is as deep as they went; the clusters add the region's rotation and
   * strain. The masses' positions are captured here, so a deferred skin flushes this solve's pose
   * (lattice mode captures only the positions: netplay re-solves its cages from them).
   */
  private bakeLocalSkin(): void {
    if (this.mode === "shape") for (const c of this.clusters) matchSkinLocal(c, this.skinRest, this.skinLocal, this.skinMassN, SKIN_STRAIN);
    const pos = this.massPos;
    for (let j = 0, r = 0; j < this.masses.length; j++, r += 3) {
      const p = this.masses[j]!.local;
      pos[r] = p.x;
      pos[r + 1] = p.y;
      pos[r + 2] = p.z;
    }
    for (let c = 0; c < this.clusters.length; c++) this.netSkinXf.set(this.clusters[c]!.skinM, c * 9);
    const im = this.netImpact;
    this.impactLocal.toArray(im, 0);
    this.impactInward.toArray(im, 3);
    im[6] = this.wrinkleAmp * Math.min(1, this.elapsed * 6);
    im[7] = this.buckle;
    im[8] = this.squash;
    let popped = 0;
    for (let i = 0; i < this.masses.length; i++) if (this.masses[i]!.popped) popped |= 1 << i;
    this.netPopped = popped;
    this.netFlags = (this.deepCrush ? 4 : 0) | (this.bidirectional ? 8 : 0) | (this.mode === "lattice" ? 16 : 0);
  }

  /** `clusterXf` ← each cluster's skin map M (row-major 9). */
  private refreshClusterXf(): void {
    const X = this.clusterXf;
    for (let ci = 0, o = 0; ci < this.clusters.length; ci++, o += 9) X.set(this.clusters[ci]!.skinM, o);
  }

  private solveCagesFromShape(): void {
    this.refreshClusterXf();
    const X = this.clusterXf;
    const n = this.vertexCount;
    const pos = this.massPos;
    for (let j = 0; j < this.cages.length * 8; j++) {
      const cage = this.cages[j >> 3]!;
      const rest = cage.restCorners[j & 7]!;
      const wsum = this.cornerWsum[j]!;
      // A5, as a skin vertex: parents' positions + the cluster maps on the offset from them.
      const dx = rest.x - this.resC[(n + j) * 3]!;
      const dy = rest.y - this.resC[(n + j) * 3 + 1]!;
      const dz = rest.z - this.resC[(n + j) * 3 + 2]!;
      let px = dx,
        py = dy,
        pz = dz;
      if (wsum > 1e-6) {
        px = py = pz = 0;
        for (let k = this.cornerStart[j]!, e = this.cornerStart[j + 1]!; k < e; k++) {
          const o = this.cornerXf[k]!;
          const w = this.cornerW[k]! / wsum;
          px += (X[o]! * dx + X[o + 1]! * dy + X[o + 2]! * dz) * w;
          py += (X[o + 3]! * dx + X[o + 4]! * dy + X[o + 5]! * dz) * w;
          pz += (X[o + 6]! * dx + X[o + 7]! * dy + X[o + 8]! * dz) * w;
        }
      }
      for (let k = (n + j) * RES_SLOTS, e = k + RES_SLOTS; k < e; k++) {
        const m = this.resJ[k]!;
        const w = this.resW[k]!;
        px += pos[m]! * w;
        py += pos[m + 1]! * w;
        pz += pos[m + 2]! * w;
      }
      cage.corners[j & 7]!.set(px, py, pz);
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
          if (m.hub && !m.popped) continue;
          const dist = rest.distanceTo(m.rest);
          if (dist > 1.15) continue;
          const w = Math.exp(-dist * 3.2);
          _e.copy(m.local).sub(m.rest);
          _d.addScaledVector(_e, w);
          wsum += w;
        }
        if (wsum > 1e-6) {
          const lid = cage.spec.name === "bonnet" || cage.spec.name === "boot" || cage.glass;
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
    const rest = this.restPos;
    const shape = this.mode === "shape";
    if (shape) this.refreshClusterXf();
    const X = this.clusterXf;
    const co = this.cageCo;
    for (let p = 0; p < this.cages.length; p++) cageCoeffs(this.cages[p]!.corners, co, p * 24);
    const sN = this.skinN;
    const sXf = this.skinXf;
    const sW = this.skinW;
    const iN = this.infN;
    const iCo = this.infCo;
    const iUvw = this.infUvw;
    const rJ = this.resJ;
    const rW = this.resW;
    const rC = this.resC;
    const pos = this.massPos;
    const ix = this.impactLocal.x;
    const iy = this.impactLocal.y;
    const iz = this.impactLocal.z;
    const wrinkle = this.wrinkleAmp * Math.min(1, this.elapsed * 6);
    const wrinkles = wrinkle > 0.02;
    const b = this.buckle;
    const ampK = wrinkle * 0.16 * (0.35 + b * 0.65);
    const extraCap = 0.03 + b * 0.08;
    const cap = shape ? 1.35 : 2.2;
    const roofClamp = !this.deepCrush;

    for (let i = 0, r = 0; i < this.vertexCount; i++, r += 3) {
      const rx = rest[r]!;
      const ry = rest[r + 1]!;
      const rz = rest[r + 2]!;
      let px = 0,
        py = 0,
        pz = 0;
      const n = shape ? sN[i]! : 0;
      if (n > 0) {
        // A5: parents' positions + the blended cluster map on the offset from their rest centroid.
        const dx = rx - rC[r]!;
        const dy = ry - rC[r + 1]!;
        const dz = rz - rC[r + 2]!;
        for (let k = i * SKIN_K, e = k + n; k < e; k++) {
          const o = sXf[k]!;
          const w = sW[k]!;
          px += (X[o]! * dx + X[o + 1]! * dy + X[o + 2]! * dz) * w;
          py += (X[o + 3]! * dx + X[o + 4]! * dy + X[o + 5]! * dz) * w;
          pz += (X[o + 6]! * dx + X[o + 7]! * dy + X[o + 8]! * dz) * w;
        }
        for (let k = i * RES_SLOTS, e = k + RES_SLOTS; k < e; k++) {
          const j = rJ[k]!;
          const w = rW[k]!;
          px += pos[j]! * w;
          py += pos[j + 1]! * w;
          pz += pos[j + 2]! * w;
        }
      } else {
        for (let k = i * INF_K, e = k + iN[i]!; k < e; k++) {
          const o = iCo[k]!;
          const u = iUvw[k * 4]!;
          const v = iUvw[k * 4 + 1]!;
          const w = iUvw[k * 4 + 2]!;
          const wt = iUvw[k * 4 + 3]!;
          px += cageAxis(co, o, u, v, w) * wt;
          py += cageAxis(co, o + 8, u, v, w) * wt;
          pz += cageAxis(co, o + 16, u, v, w) * wt;
        }
      }
      if (wrinkles && ry > 0.34) {
        const dx = rx - ix;
        const dy = ry - iy;
        const dz = rz - iz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 0.82 * 0.82) {
          const n0 = this.wrinkleSeed[i]!;
          // Accordion folds along the crush axis (~12 cm wavelength), not a clay blob.
          // Wreckfest impact radius sweet spot is 0.3–0.5 m; 1.6 m wrinkled the whole nose.
          const wave = Math.sin(rz * 18 + n0 * 1.2);
          const amp = ampK * Math.exp(-Math.sqrt(d2) * 3.4);
          let ox = Math.sign(rx || 1) * n0 * amp * 0.12;
          let oy = Math.abs(wave) * amp * 0.28;
          let oz = wave * amp;
          const extra = Math.sqrt(ox * ox + oy * oy + oz * oz);
          if (extra > extraCap) {
            const t = extraCap / extra;
            ox *= t;
            oy *= t;
            oz *= t;
          }
          px += ox;
          py += oy;
          pz += oz;
        }
      }
      const tx = px - rx;
      const ty = py - ry;
      const tz = pz - rz;
      const travel2 = tx * tx + ty * ty + tz * tz;
      if (travel2 > cap * cap) {
        const t = cap / Math.sqrt(travel2);
        px = rx + tx * t;
        py = ry + ty * t;
        pz = rz + tz * t;
      }
      if (roofClamp && ry > 1.05) py = THREE.MathUtils.clamp(py, ry - 0.1, ry + 0.08);
      const h = this.skinHub[i]!;
      if (h >= 0) {
        // Wheel arch: plant the paint at its rest offset from the hub (the hub's rest while the wheel
        // is on). Blending onto the hub centre folded every arch vertex ~0.34 m in, even on a tap.
        const m = this.masses[h]!;
        const keep = m.popped ? 0.15 : 0.82;
        const hx = m.popped ? rx + m.local.x - m.rest.x : rx;
        const hz = m.popped ? rz + m.local.z - m.rest.z : rz;
        px = px * (1 - keep) + hx * keep;
        pz = pz * (1 - keep) + hz * keep;
      }
      arr[i * 3] = px;
      arr[i * 3 + 1] = py;
      arr[i * 3 + 2] = pz;
    }
    attr.needsUpdate = true;
    computeNormalsFast(geometry);
    this.dirty = true;
    this.skinnedThisFrame = true;
  }

  /** Netplay: array sizes for a `DeformNetState` (fixed by the rig). */
  netSizes(): { masses: number; clusters: number; sensors: number } {
    return { masses: this.masses.length, clusters: this.clusters.length, sensors: this.sensors.length };
  }

  /** Netplay host: the skin inputs as of the last bake, plus the current particles (the hulls) and flags. */
  readNetState(out: DeformNetState): void {
    let popped = 0;
    for (let i = 0, r = 0; i < this.masses.length; i++, r += 3) {
      const m = this.masses[i]!;
      out.local[r] = m.local.x;
      out.local[r + 1] = m.local.y;
      out.local[r + 2] = m.local.z;
      if (m.popped) popped |= 1 << i;
    }
    out.popped = popped;
    out.skinPos.set(this.massPos);
    out.skinXf.set(this.netSkinXf);
    for (let s = 0; s < this.sensors.length; s++) out.sensor[s] = this.sensors[s]!.compression;
    out.impact.set(this.netImpact);
    out.skinPopped = this.netPopped;
    out.flags = (this.massActive ? 1 : 0) | (this.drivetrainAlive ? 2 : 0) | this.netFlags;
    out.engineTravel = this.engineTravel;
    out.killTravel = this.killTravel;
  }

  /**
   * Netplay client: take the host's state and re-skin from it. No physics: the cages and skin are
   * solved from the baked inputs exactly as the host's last skin was, then `local` is set to the
   * host's current particles (the hulls) and `world` follows `group`. Allocation-free.
   */
  writeNetState(src: DeformNetState, group: THREE.Object3D, geometry: THREE.BufferGeometry): void {
    const f = src.flags;
    this.massActive = (f & 1) !== 0;
    this.drivetrainAlive = (f & 2) !== 0;
    this.engineTravel = src.engineTravel;
    this.killTravel = src.killTravel;
    this.deepCrush = (f & 4) !== 0;
    this.bidirectional = (f & 8) !== 0;
    this.mode = (f & 16) !== 0 ? "lattice" : "shape";
    const im = src.impact;
    this.impactLocal.set(im[0]!, im[1]!, im[2]!);
    this.impactInward.set(im[3]!, im[4]!, im[5]!);
    this.wrinkleAmp = im[6]!;
    this.buckle = im[7]!;
    this.squash = im[8]!;
    // Saturates the wrinkle and lattice ramps: the host's value already carries its ramp.
    this.elapsed = Math.max(this.elapsed, 1);
    let maxC = 0;
    for (let s = 0; s < this.sensors.length; s++) {
      const c = src.sensor[s]!;
      this.sensors[s]!.compression = c;
      if (c > maxC) maxC = c;
    }
    this.crushAmount = maxC;
    this.massPos.set(src.skinPos);
    for (let c = 0; c < this.clusters.length; c++) {
      const m = this.clusters[c]!.skinM;
      for (let k = 0, o = c * 9; k < 9; k++) m[k] = src.skinXf[o + k]!;
    }
    for (let i = 0, r = 0; i < this.masses.length; i++, r += 3) {
      const m = this.masses[i]!;
      m.local.set(src.skinPos[r]!, src.skinPos[r + 1]!, src.skinPos[r + 2]!);
      m.popped = (src.skinPopped & (1 << i)) !== 0;
    }
    // Skinned now, LoD or not: a deferred flush would read the hubs after they move on below.
    this.solveCages();
    this.flushSkin(geometry, true);
    this.skinOwed = false;
    group.updateWorldMatrix(false, false);
    for (let i = 0, r = 0; i < this.masses.length; i++, r += 3) {
      const m = this.masses[i]!;
      m.local.set(src.local[r]!, src.local[r + 1]!, src.local[r + 2]!);
      m.popped = (src.popped & (1 << i)) !== 0;
      m.world.copy(m.local).applyMatrix4(group.matrixWorld);
      m.vel.set(0, 0, 0);
    }
  }
}

/** `slice` is the call's slice over CONTACT_REF_SLICE: the overlap and inbound shares are per-slice rates. */
function sphereHit(a: MassNode, b: MassNode, slice: number): void {
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
  const crumple = a.crumple || b.crumple;
  const tA = forceTransfer(a.local.distanceTo(a.rest), a.bands, a.local.distanceTo(a.rest) >= a.bands.max * 0.97);
  const tB = forceTransfer(b.local.distanceTo(b.rest), b.bands, b.local.distanceTo(b.rest) >= b.bands.max * 0.97);
  const t = Math.min(tA, tB);
  // A rigid pair (cell on cell) resolves at most SPHERE_STEP per reference slice: in one call it resolved
  // a 0.15 m overlap and jumped the struck cell 0.15 m in 4.5 ms (a derby zip); the rest goes over the
  // next slices. Crumple pairs already take a per-slice share.
  const overlap = crumple ? (minD - dist) * (1 - Math.pow(1 - Math.max(0.28, t), slice)) : Math.min(minD - dist, SPHERE_STEP * slice);
  if (a.dynamic) a.world.addScaledVector(_n, -overlap * (ima / inv));
  if (b.dynamic) b.world.addScaledVector(_n, overlap * (imb / inv));
  const rel = b.vel.dot(_n) - a.vel.dot(_n);
  if (rel < 0) {
    const e = crumple ? (t >= 0.97 ? 0.08 : 0) : 0.18;
    const absorb = 1 - Math.pow(1 - (crumple ? Math.max(0.12, t) : 0.55), slice);
    const j = (-(1 + e) * rel * absorb) / inv;
    // Coulomb friction: sheet metal scraping past sheet metal takes at most μ·j off the sliding velocity.
    _t.copy(b.vel).sub(a.vel).addScaledVector(_n, -rel);
    const slide = _t.length();
    const jt = slide > 1e-6 ? Math.min(slide / inv, SHEET_MU * j) / slide : 0;
    if (a.dynamic) a.vel.addScaledVector(_n, -j * ima).addScaledVector(_t, jt * ima);
    if (b.dynamic) b.vel.addScaledVector(_n, j * imb).addScaledVector(_t, -jt * imb);
  }
}

function axisWeight(t: number): number {
  if (t < -0.18 || t > 1.18) return 0;
  if (t < 0) return 1 + t / 0.18;
  if (t > 1) return 1 - (t - 1) / 0.18;
  return 1;
}
