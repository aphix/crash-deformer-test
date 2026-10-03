import * as THREE from "three";
import { StreamedDeformation } from "../deform/streamed-deform.ts";
import { TYRE_R } from "../deform/deform-state.ts";
import { computeNormalsFast } from "../deform/fast-normals.ts";
import { hypot2 } from "../deform/physics-util.ts";
import {
  DOOR,
  WHEEL_POS,
  makeBumperGeometry,
  makeChassisGeometry,
  makeDoorGeometry,
  makeHoodGeometry,
  makeTrunkGeometry,
  roofTopY,
} from "./car-mesh.ts";
import { makeRearGlass, makeRearSideGlass, makeSideGlass, makeWindshield } from "./car-glass.ts";
import {
  LIGHT_BAR_FOOT,
  LIGHT_BAR_LENS,
  makeDoorLining,
  makeGlassMaterial,
  makeGrille,
  makeInterior,
  makeLightBar,
  makeMirror,
  makePaintMaterial,
  makeSirenMaterial,
  makeTailTrim,
  makeTrimMaterial,
  type LampKind,
} from "./car-materials.ts";
import { CRUSH_HULLS, HULLS, type Hull } from "../deform/hulls.ts";
import { CAR_STYLES, type BodyStyle, type CarStyleId } from "./car-variants.ts";
import { anchorOnSkin, poseOnSkin, type GlowKind, type SkinAnchor } from "./lamp-lights.ts";

const _p = new THREE.Vector3();
const _inv = new THREE.Quaternion();
const _lampQ = new THREE.Quaternion();
const _lampE = new THREE.Euler();

/** Light bar seat on the roof (car z, m): over the front seats, behind the windshield header. */
const LIGHT_BAR_Z = -0.02;
/** Siren flash: red, then blue, each half of this period (s). */
const SIREN_PERIOD = 0.5;
/** Lit lens emissive gain past the bloom threshold; each stays under the ACES knee where it washes out
 *  (red to orange, as the tail lamps; blue to lavender, seen at 2.4). */
const SIREN_GAIN = { red: 1.3, blue: 1.5 } as const;

export interface CarPaint {
  body: number;
  accent: number;
  name: string;
}

export type WorldBounce = (pos: THREE.Vector3, vel: THREE.Vector3, r: number) => void;
type GlassBurst = (origin: THREE.Vector3, velocity: THREE.Vector3, count: number) => void;

/** G-key hull overlay: each 2D contact hull drawn as a box over this height band (m, display only). */
const HULL_Y0 = 0.18;
const HULL_Y1 = 0.72;
/** The box's 12 edges as corner pairs. Corner k sits at HULL_Y1 if k ≥ 4; round the ring, k & 3 is (x0,z0) (x1,z0) (x1,z1) (x0,z1). */
const BOX_EDGES = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];

/** Writes hull `h`'s box edges (BOX_EDGES.length × 3 floats) into `arr` from `o`; returns the end offset. */
function writeHullBox(arr: Float32Array, o: number, h: Hull): number {
  const x0 = h.cx - h.hx;
  const x1 = h.cx + h.hx;
  const z0 = h.cz - h.hz;
  const z1 = h.cz + h.hz;
  for (const k of BOX_EDGES) {
    const ring = k & 3;
    arr[o++] = ring === 1 || ring === 2 ? x1 : x0;
    arr[o++] = k < 4 ? HULL_Y0 : HULL_Y1;
    arr[o++] = ring >= 2 ? z1 : z0;
  }
  return o;
}

/** C1: only a side hit this hard (m/s EBS, 45 km/h) tears a door off; slower side hits spring it. */
export const DOOR_TEAR_MPS = 12.5;
/** C1: frontal and rear crush can jam a door ajar (hingeT), never swing it open. */
export const DOOR_AJAR = 0.2;
/** C2: below 30 km/h EBS a folded bumper stays on (IIHS low-speed bumper protocols). */
export const BUMPER_TEAR_MPS = 30 / 3.6;

// Door hinge and mirror model (docs/DOOR_RIG.md). Sourced: FMVSS 206 hinge 11 kN longitudinal,
// latch/hinge 8.9 kN transverse. Guessed: masses, stop angle, plastic travel, mirror numbers.
/** Front-door assembly (kg), guessed inside the usual 20–30 kg. */
const DOOR_MASS = 25;
/** Thin slab about one edge, I = m·L²/3 (kg·m²). */
export const DOOR_INERTIA = (DOOR_MASS * DOOR.length * DOOR.length) / 3;
/** Check-strap stop (rad); 65–70° is typical. */
export const DOOR_OPEN_MAX = (68 * Math.PI) / 180;
/** Hinge energy past the stop that tears the door off (J): 11 kN at the pins is ~1.8 kN at the
 *  door through a ~6:1 strap lever, over ~0.12 m of plastic travel at the door (lever and travel guessed). */
export const HINGE_TEAR_J = 220;
/** One slam shut this hard tears the door off (J): 8.9 kN transverse over ~4 cm of striker and
 *  hinge crush (travel guessed). A hard hand slam is ~17 J. */
export const SLAM_TEAR_J = 360;
/** Hinge friction (1/s). */
export const DOOR_DAMP = 0.8;
/** The mirror folds about its base up to this (rad) before its stop loads. */
export const MIRROR_FOLD_MAX = (75 * Math.PI) / 180;
/** Energy the mirror's fold stop takes before the mirror snaps off (J), guessed. */
export const MIRROR_BREAK_J = 30;

/** Both ends struck within this (s) is a squeeze (`noteContactEnd`). */
export const END_WINDOW = 0.25;
/** A squeeze ends once contact has been quiet this long (s), the deform's re-arm quiet time. */
export const REARM_QUIET_S = 0.3;

/** A door's free swing; the crash rule's `hingeT` jams it open on top of this (C1). */
export interface DoorHinge {
  /** Open angle (rad, 0 = shut). */
  theta: number;
  /** Opening rate (rad/s, + opens). */
  omega: number;
  latched: boolean;
  /** Energy the hinges have taken at the stop (J); tears at `HINGE_TEAR_J`. */
  load: number;
  /** The door mirror's fold about its base: its `rotation.y` (rad). */
  mirrorFold: number;
}

/** Netplay state of a car's detachable parts, lamps and glass (docs/MULTIPLAYER.md), preallocated from `partNetSizes()`. */
export interface PartNetState {
  /** Per part: 1 detached, 2 folding, 4 its door swing is latched. */
  readonly flags: Uint8Array;
  /** Per part × 3: hingeT, swing theta (rad), swing mirrorFold (rad); 0 without a swing. */
  readonly hinge: Float32Array;
  /** Per part × 7: world position xyz and quaternion xyzw, while detached. */
  readonly pose: Float32Array;
  /** Bit i: lamp i intact. */
  lamps: number;
  /** 2 bits per pane: 0 intact, 1 cracked, 2 shattered. */
  glass: number;
  /** Bit i: wheel i is off its hub, loose in the world. */
  wheelLoose: number;
  /** Per wheel × 7: world position xyz and quaternion xyzw, while loose. */
  readonly wheels: Float32Array;
}

type GlassState = "intact" | "cracked" | "shattered";

/** Panes by place: doorL / doorR are the front side windows (they ride the doors, −x is the car's left). */
export type GlassName = "windshield" | "rear" | "doorL" | "doorR" | "quarterL" | "quarterR";

export interface GlassPane {
  name: GlassName;
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  restPos: THREE.Vector3;
  restVerts: Float32Array | null;
  state: GlassState;
  parts: ("roof" | "bonnet" | "boot" | "doorLeft" | "doorRight")[];
  skin: "glassFront" | "glassRear" | null;
}

/** Housing + lens on the body skin (never the bumper): breaks only from its own corner's crush. */
export interface Lamp {
  /** Its pose on the skin (`poseLamps`), in the car group; `LampBatch` draws the unit there. Named "lamp". */
  seat: THREE.Object3D;
  intact: boolean;
  kind: LampKind;
  side: number;
  /** That corner's bumper-end and wing sensors. */
  sensors: number[];
  anchor: SkinAnchor;
}

export interface DetachPart {
  name: string;
  object: THREE.Object3D;
  restPos: THREE.Vector3;
  restQuat: THREE.Quaternion;
  cage:
    | "bumperFront"
    | "bumperRear"
    | "bonnet"
    | "boot"
    | "roof"
    | "doorLeft"
    | "doorRight"
    | "wingFL"
    | "wingFR";
  attachL: number;
  attachR: number;
  /** "bar": the police light bar, skinned with the roof cage, no hinge motion. */
  hinge: "cowl" | "tail" | "two-point" | "door" | "bar";
  detached: boolean;
  folding: boolean;
  hingeT: number;
  velocity: THREE.Vector3;
  angular: THREE.Vector3;
  radius: number;
  /** Doors own their hinge; a mirror shares its door's. */
  swing: DoorHinge | null;
}

/** What `stepLoose` moves: a detached part, or a wheel off its hub. */
export interface LooseBody {
  object: THREE.Object3D;
  velocity: THREE.Vector3;
  angular: THREE.Vector3;
  radius: number;
}

/**
 * The car's state and build: every field, the constructor (body, panels, doors, bumpers, lamps, glass, parts,
 * hull overlay, wheels), the contact hulls, lamp and glass resets and the body frame. Layers stack `CarCore` →
 * `CarParts` → `DeformableCar` (one class split by context; `DeformableCar` is the one anything constructs).
 */
export abstract class CarCore {
  readonly group = new THREE.Group();
  readonly body: THREE.Mesh;
  readonly deform: StreamedDeformation;
  readonly paint: CarPaint;
  readonly style: BodyStyle;
  readonly wheels: THREE.Group[] = [];
  /** Per wheel: off its popped hub and loose in the world (`dropWheel`), with its own motion. */
  protected readonly looseWheels: (LooseBody & { loose: boolean })[] = [];
  readonly velocity = new THREE.Vector3();
  readonly angular = new THREE.Vector3();
  readonly forward = new THREE.Vector3(0, 0, 1);
  readonly right = new THREE.Vector3(1, 0, 0);
  readonly fwdFlat = new THREE.Vector3(0, 0, 1);
  readonly rightFlat = new THREE.Vector3(1, 0, 0);

  speed = 0;
  crashed = false;
  /**
   * Off the fleet disc and 2 m down (`CrashEngine.stepEdge`): a frozen copy of the car as it was (mesh, parts,
   * lamps) dropping ballistically at `velocity` with the constant spin `fallSpin`; no physics, contacts or skin.
   */
  falling = false;
  /** World angular velocity (rad/s) of the fake fall. */
  readonly fallSpin = new THREE.Vector3();
  /** Fell 20 m below the fleet disc and burst into smoke (`CrashEngine.setVaporized`): hidden and out of the sim until respawned. */
  vaporized = false;
  yaw = 0;
  roll = 0;
  pitch = 0;
  spawnSpeed = 0;
  /**
   * Last slice's drive (applyDrive writes it). spin / lock / slide are 0–1 wheel slip for tyre FX:
   * launch wheelspin, brake lock-up, sideways slide; `drift` is the drift assist's own state. `-0`: doubles
   * from construction, or each field's first fractional write mid-race deoptimised applyDrive for seconds.
   */
  readonly drive = { throttle: -0, steer: -0, brake: -0, ebrake: false, boost: false, spin: -0, lock: -0, slide: -0, drift: -0 };

  protected world: THREE.Scene;
  protected onGlass: GlassBurst | null;
  protected bodyMat: THREE.MeshPhysicalMaterial;
  protected wheelSpin = 0;
  protected glassPanes: GlassPane[] = [];
  protected parts: DetachPart[] = [];
  /** [left, right] door and mirror parts, also listed in `parts`. */
  protected doorParts: DetachPart[] = [];
  protected mirrorParts: DetachPart[] = [];
  /** Seconds since the [front, rear] end was last struck (`noteContactEnd`). */
  protected readonly endAgo = new Float64Array([9, 9]);
  /** Smallest striker reach (m from centre along the length) since the squeeze began. */
  protected endReach = Infinity;
  protected endSqueeze = false;
  readonly lamps: Lamp[] = [];
  protected hullHelper: THREE.LineSegments | null = null;
  private bumperF: THREE.Group;
  private bumperR: THREE.Group;
  protected hood: THREE.Mesh;
  protected trunk: THREE.Mesh;
  protected doorL: THREE.Group;
  protected doorR: THREE.Group;
  protected doorMeshL: THREE.Mesh;
  protected doorMeshR: THREE.Mesh;
  protected hoodRest: Float32Array;
  protected trunkRest: Float32Array;
  protected doorLRest: Float32Array;
  protected doorRRest: Float32Array;
  protected hoodOrigin: THREE.Vector3;
  protected trunkOrigin: THREE.Vector3;
  protected interior: THREE.Mesh;
  private mirrorL: THREE.Mesh;
  private mirrorR: THREE.Mesh;
  /** Police roof light bar (skinned with the roof cage), its part, rest shape and seat; null on other styles. */
  protected lightBar: THREE.Mesh | null = null;
  protected lightBarPart: DetachPart | null = null;
  protected lightBarRest: Float32Array | null = null;
  protected readonly lightBarOrigin = new THREE.Vector3();
  private sirenMat: THREE.MeshStandardMaterial | null = null;
  private sirensOn = false;
  /** Lens lit this frame: 0 none, 1 red, 2 blue. */
  private sirenLit = 0;

  constructor(paint: CarPaint, world: THREE.Scene, onGlass: GlassBurst | null = null, style: CarStyleId = "sedan") {
    this.paint = paint;
    this.style = CAR_STYLES[style];
    this.world = world;
    this.onGlass = onGlass;
    this.group.name = paint.name;

    // A livery (police) fixes the paint: black body and bumpers, white doors.
    const livery = this.style.livery;
    this.bodyMat = makePaintMaterial(livery?.body ?? paint.body);
    const doorMat = livery ? makePaintMaterial(livery.doors) : this.bodyMat;
    const bodyGeo = makeChassisGeometry(this.style);
    this.body = new THREE.Mesh(bodyGeo, this.bodyMat);
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    this.group.add(this.body);
    this.deform = new StreamedDeformation(bodyGeo, this.style.rig);
    this.deform.createHelper(this.group);

    this.interior = makeInterior();
    this.group.add(this.interior);

    this.hood = new THREE.Mesh(makeHoodGeometry(this.style), this.bodyMat);
    this.hood.castShadow = true;
    this.hood.position.set(0, 0.7, 0.74);
    this.group.add(this.hood);
    this.trunk = new THREE.Mesh(makeTrunkGeometry(this.style), this.bodyMat);
    this.trunk.castShadow = true;
    this.trunk.position.set(0, this.style.boot.origin[0], this.style.boot.origin[1]);
    this.group.add(this.trunk);
    if (this.style.lightBar) {
      this.sirenMat = makeSirenMaterial();
      this.lightBar = new THREE.Mesh(makeLightBar(), this.sirenMat);
      this.lightBar.name = "lightBar";
      this.lightBar.castShadow = true;
      // Feet soles on the roof's dome where they stand, not the crown between them (that sank them 0.5–2.3 cm).
      this.lightBar.position.set(0, roofTopY(LIGHT_BAR_FOOT.x, LIGHT_BAR_Z, this.style) - LIGHT_BAR_FOOT.sole, LIGHT_BAR_Z);
      this.lightBarOrigin.copy(this.lightBar.position);
      this.group.add(this.lightBar);
      this.lightBarRest = this.copyRest(this.lightBar.geometry);
    }

    this.doorL = new THREE.Group();
    this.doorR = new THREE.Group();
    this.doorL.position.set(-DOOR.hingeX, DOOR.hingeY, DOOR.hingeZ);
    this.doorR.position.set(DOOR.hingeX, DOOR.hingeY, DOOR.hingeZ);
    this.doorMeshL = new THREE.Mesh(makeDoorGeometry(-1, this.style), doorMat);
    this.doorMeshL.position.set(0, 0, DOOR.skinZ);
    this.doorMeshL.castShadow = true;
    this.doorMeshR = new THREE.Mesh(makeDoorGeometry(1, this.style), doorMat);
    this.doorMeshR.position.set(0, 0, DOOR.skinZ);
    this.doorMeshR.castShadow = true;
    this.doorL.add(this.doorMeshL);
    this.doorR.add(this.doorMeshR);
    this.doorL.add(makeDoorLining(-1));
    this.doorR.add(makeDoorLining(1));
    this.group.add(this.doorL, this.doorR);

    this.hoodRest = this.copyRest(this.hood.geometry);
    this.trunkRest = this.copyRest(this.trunk.geometry);
    this.doorLRest = this.copyRest(this.doorMeshL.geometry);
    this.doorRRest = this.copyRest(this.doorMeshR.geometry);
    this.hoodOrigin = this.hood.position.clone();
    this.trunkOrigin = this.trunk.position.clone();

    this.bumperF = this.makeBumper(true, livery?.accent ?? paint.accent);
    this.bumperR = this.makeBumper(false, livery?.accent ?? paint.accent);
    this.group.add(this.bumperF, this.bumperR);
    this.addLamps();

    this.mirrorL = makeMirror(-1);
    this.mirrorL.position.set(-DOOR.mirrorX, DOOR.mirrorY, 0);
    this.doorL.add(this.mirrorL);
    this.mirrorR = makeMirror(1);
    this.mirrorR.position.set(DOOR.mirrorX, DOOR.mirrorY, 0);
    this.doorR.add(this.mirrorR);

    this.addGlass();
    this.registerParts();
    this.buildHullHelper();

    // Transforms only: the engine's WheelBatch draws every car's wheels in one instanced call.
    for (const [x, y, z] of WHEEL_POS) {
      const w = new THREE.Group();
      w.position.set(x, y, z);
      this.group.add(w);
      this.wheels.push(w);
      this.looseWheels.push({ object: w, velocity: new THREE.Vector3(), angular: new THREE.Vector3(), radius: TYRE_R, loose: false });
    }
    this.group.castShadow = true;
  }

  private copyRest(geo: THREE.BufferGeometry): Float32Array {
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    return new Float32Array(pos.array as Float32Array);
  }

  protected restoreRest(geo: THREE.BufferGeometry, rest: Float32Array): void {
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    (pos.array as Float32Array).set(rest);
    pos.needsUpdate = true;
    computeNormalsFast(geo);
  }

  private makeBumper(front: boolean, accent: number): THREE.Group {
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(makeBumperGeometry(front), makeTrimMaterial(accent));
    mesh.castShadow = true;
    g.add(mesh);
    if (!front) g.add(makeTailTrim());
    g.position.set(0, 0.33, front ? 2.06 : -2.06);
    if (front) {
      const grille = makeGrille();
      grille.position.set(0, 0.1, 0.06);
      g.add(grille);
    }
    return g;
  }

  /** Head lamps on the nose, tails on the tail panel (upright in its corners beside a tailgate), at the body's own
   *  seats (`BodyStyle.lamps`), so each sits flush on the skin with the bumper gone. Each rides three nearby skin vertices. */
  private addLamps(): void {
    const { profile, lamps, boot } = this.style;
    for (const kind of ["head", "tail"] as const) {
      const head = kind === "head";
      const [x, y] = lamps[kind];
      const z = head ? profile[profile.length - 1]!.z : profile[0]!.z;
      _lampQ.setFromEuler(_lampE.set(0, head ? 0 : Math.PI, !head && boot.kind === "tailgate" ? Math.PI / 2 : 0));
      for (const side of [-1, 1]) {
        const seat = new THREE.Object3D();
        seat.name = "lamp";
        this.group.add(seat);
        _p.set(side * x, y, z);
        this.lamps.push({
          seat,
          intact: true,
          kind,
          side,
          sensors: head ? (side < 0 ? [1, 4] : [2, 5]) : side < 0 ? [16, 10] : [17, 11],
          anchor: anchorOnSkin(this.body.geometry, _p, _lampQ),
        });
      }
    }
    this.resetLamps();
  }

  private addGlass(): void {
    const addPane = (
      name: GlassName,
      mesh: THREE.Mesh,
      parent: THREE.Object3D,
      parts: GlassPane["parts"],
      skin: GlassPane["skin"] = null,
    ) => {
      mesh.renderOrder = 2;
      parent.add(mesh);
      this.glassPanes.push({
        name,
        mesh,
        mat: mesh.material as THREE.MeshPhysicalMaterial,
        restPos: mesh.position.clone(),
        restVerts: skin ? this.copyRest(mesh.geometry) : null,
        state: "intact",
        parts,
        skin,
      });
    };
    const glassMat = makeGlassMaterial();
    const style = this.style;
    addPane("windshield", new THREE.Mesh(makeWindshield(style), glassMat.clone()), this.group, ["roof", "bonnet"], "glassFront");
    addPane("rear", new THREE.Mesh(makeRearGlass(style), glassMat.clone()), this.group, ["roof", "boot"], "glassRear");
    const sideL = new THREE.Mesh(makeSideGlass(-1, style), glassMat.clone());
    sideL.position.set(0.02, 0.52, -0.28);
    addPane("doorL", sideL, this.doorL, ["doorLeft", "roof"]);
    const sideR = new THREE.Mesh(makeSideGlass(1, style), glassMat.clone());
    sideR.position.set(-0.02, 0.52, -0.28);
    addPane("doorR", sideR, this.doorR, ["doorRight", "roof"]);
    addPane("quarterL", new THREE.Mesh(makeRearSideGlass(-1, style), glassMat.clone()), this.group, ["roof", "doorLeft"]);
    addPane("quarterR", new THREE.Mesh(makeRearSideGlass(1, style), glassMat.clone()), this.group, ["roof", "doorRight"]);
  }

  private registerParts(): void {
    const add = (
      name: string,
      object: THREE.Object3D,
      cage: DetachPart["cage"],
      attachL: number,
      attachR: number,
      hinge: DetachPart["hinge"],
      radius: number,
      swing: DoorHinge | null = null,
    ): DetachPart => {
      const p: DetachPart = {
        name,
        object,
        restPos: object.position.clone(),
        restQuat: object.quaternion.clone(),
        cage,
        attachL,
        attachR,
        hinge,
        detached: false,
        folding: false,
        hingeT: 0,
        velocity: new THREE.Vector3(),
        angular: new THREE.Vector3(),
        radius,
        swing,
      };
      this.parts.push(p);
      return p;
    };
    add("bumperF", this.bumperF, "bumperFront", 1, 2, "two-point", 0.42);
    add("bumperR", this.bumperR, "bumperRear", 16, 17, "two-point", 0.4);
    add("hood", this.hood, "bonnet", 3, 3, "cowl", 0.5);
    add("trunk", this.trunk, "boot", 18, 18, "tail", 0.48);
    const doorL = add("doorL", this.doorL, "doorLeft", 6, 6, "door", 0.4, { theta: 0, omega: 0, latched: true, load: 0, mirrorFold: 0 });
    const doorR = add("doorR", this.doorR, "doorRight", 7, 7, "door", 0.4, { theta: 0, omega: 0, latched: true, load: 0, mirrorFold: 0 });
    this.doorParts = [doorL, doorR];
    this.mirrorParts = [
      add("mirrorL", this.mirrorL, "doorLeft", 6, 4, "two-point", 0.1, doorL.swing),
      add("mirrorR", this.mirrorR, "doorRight", 7, 5, "two-point", 0.1, doorR.swing),
    ];
    // Last, so every style's other parts keep their indices (netplay, tests). Roof sensor 12 on both ends.
    if (this.lightBar) this.lightBarPart = add("lightBar", this.lightBar, "roof", 12, 12, "bar", 0.3);
  }

  private buildHullHelper(): void {
    const pos = new Float32Array(HULLS.length * BOX_EDGES.length * 3);
    let o = 0;
    for (const h of HULLS) o = writeHullBox(pos, o, h);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0x8aa0b4,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
    });
    this.hullHelper = new THREE.LineSegments(geo, mat);
    this.hullHelper.renderOrder = 4;
    this.hullHelper.visible = false;
    this.group.add(this.hullHelper);
  }

  protected updateHullHelper(): void {
    if (!this.hullHelper) return;
    const attr = this.hullHelper.geometry.getAttribute("position") as THREE.BufferAttribute;
    let o = 0;
    for (const h of this.hulls()) o = writeHullBox(attr.array as Float32Array, o, h);
    attr.needsUpdate = true;
  }

  hulls() {
    if (!this.deform.massActive) return HULLS;
    return this.deform.liveHulls();
  }

  crushHulls() {
    if (!this.deform.massActive) return CRUSH_HULLS;
    return this.deform.liveCrushHulls(this.bumperOff("bumperF"), this.bumperOff("bumperR"));
  }

  /** A loop, not `parts.some(…)`: the hull getters run per SAT pass and allocated two closures each. */
  private bumperOff(name: "bumperF" | "bumperR"): boolean {
    for (let i = 0; i < this.parts.length; i++) if (this.parts[i]!.name === name && this.parts[i]!.detached) return true;
    return false;
  }

  /** Back to an intact, clear pane on its rest seat and shape. */
  protected resetGlass(g: GlassPane): void {
    g.state = "intact";
    g.mesh.visible = true;
    g.mesh.position.copy(g.restPos);
    if (g.restVerts) this.restoreRest(g.mesh.geometry, g.restVerts);
    g.mat.opacity = 0.78;
    g.mat.map = null;
    g.mat.roughness = 0.06;
    g.mat.needsUpdate = true;
  }

  /** Relight every lamp and re-seat it on the (rest) skin. */
  protected resetLamps(): void {
    for (const lamp of this.lamps) lamp.intact = true;
    this.poseLamps();
  }

  /** Seat each lamp on the skinned body; after every skin write (4 anchors, no allocation). */
  protected poseLamps(): void {
    const pos = (this.body.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    for (const l of this.lamps) poseOnSkin(l.anchor, pos, l.seat.position, l.seat.quaternion);
  }

  get lampCount(): number {
    return this.lamps.length + (this.lightBar ? LIGHT_BAR_LENS.length : 0);
  }

  /** Writes lamp `i`'s world seat on the skin and outward axis; returns its kind, or null once broken.
   *  Past the body lamps come the light bar's sirens, red then blue: lit only while flashing.
   *  Both go through the full parent chain: a class lift (truck, monster) raises the lamps with the body. */
  lampWorld(i: number, pos: THREE.Vector3, dir: THREE.Vector3): GlowKind | null {
    const l = this.lamps[i];
    if (!l) return this.sirenWorld(i - this.lamps.length, pos, dir);
    l.seat.updateWorldMatrix(true, false);
    pos.setFromMatrixPosition(l.seat.matrixWorld);
    dir.setFromMatrixColumn(l.seat.matrixWorld, 2).normalize();
    return l.intact ? l.kind : null;
  }

  /** Siren `k` (0 red, 1 blue) when lit on an attached bar: its lens centre on the skinned bar, axis up. */
  private sirenWorld(k: number, pos: THREE.Vector3, dir: THREE.Vector3): GlowKind | null {
    const bar = this.lightBar;
    if (!bar || this.lightBarPart!.detached || this.sirenLit !== k + 1) return null;
    const [first, count] = LIGHT_BAR_LENS[k]!;
    const a = bar.geometry.getAttribute("position");
    pos.set(0, 0, 0);
    for (let v = first; v < first + count; v++) {
      pos.x += a.getX(v);
      pos.y += a.getY(v);
      pos.z += a.getZ(v);
    }
    bar.updateWorldMatrix(true, false);
    pos.multiplyScalar(1 / count).applyMatrix4(bar.matrixWorld);
    dir.setFromMatrixColumn(bar.matrixWorld, 1).normalize();
    return k === 0 ? "red" : "blue";
  }

  /** Police: sirens on or off (a no-op on a car without a light bar). */
  setSirens(on: boolean): void {
    this.sirensOn = on && this.lightBar !== null;
    if (!this.sirensOn) this.lightSiren(0);
  }

  get sirens(): boolean {
    return this.sirensOn;
  }

  /** Once a frame (`LampLights.update`): red for the first half of `SIREN_PERIOD`, blue for the second;
   *  dark once the bar is torn off. */
  flashSirens(now: number): void {
    if (!this.sirensOn) return;
    this.lightSiren(this.lightBarPart!.detached ? 0 : now % SIREN_PERIOD < SIREN_PERIOD / 2 ? 1 : 2);
  }

  /** The bar's emissive colour picks its lit lens (see `makeSirenMaterial`). */
  private lightSiren(lit: number): void {
    this.sirenLit = lit;
    this.sirenMat?.emissive.setRGB(lit === 1 ? SIREN_GAIN.red : 0, 0, lit === 2 ? SIREN_GAIN.blue : 0);
  }

  /** Group matrix only: children are refreshed once per frame by the renderer. Recursing the
   * ~60-node car subtree here was ~40% of frame CPU at 10+ cars. */
  refreshBasis(): void {
    this.group.updateWorldMatrix(false, false);
    this.forward.set(0, 0, 1).applyQuaternion(this.group.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(this.group.quaternion);
    const fl = hypot2(this.forward.x, this.forward.z);
    if (fl > 1e-6) this.fwdFlat.set(this.forward.x / fl, 0, this.forward.z / fl);
    else this.fwdFlat.set(0, 0, 1);
    this.rightFlat.set(this.fwdFlat.z, 0, -this.fwdFlat.x);
  }

  worldToLocalPoint(world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return this.group.worldToLocal(out.copy(world));
  }

  worldToLocalDir(world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    this.group.updateWorldMatrix(false, false);
    const inv = _inv.copy(this.group.quaternion).invert();
    return out.copy(world).applyQuaternion(inv).normalize();
  }

  /** Velocity of a world point riding the body: v + ω × r about the yaw axis, the way `integrate`
   *  turns `angular.y` into `rotation.y` (pitch and roll here are eased poses, not rates). */
  pointVelocity(world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const w = this.angular.y;
    return out.set(
      this.velocity.x + w * (world.z - this.group.position.z),
      this.velocity.y,
      this.velocity.z - w * (world.x - this.group.position.x),
    );
  }
}
