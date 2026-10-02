import * as THREE from "three";
import { StreamedDeformation, TYRE_R, type DeformNetState } from "./streamed-deform.ts";
import { computeNormalsFast } from "./fast-normals.ts";
import { applyGroundFriction, CRASH, round4 } from "./physics-util.ts";
import {
  CAR_HALF,
  DOOR,
  HULLS,
  CRUSH_HULLS,
  WHEEL_POS,
  getCrackMap,
  makeBumperGeometry,
  makeChassisGeometry,
  makeDoorGeometry,
  makeDoorLining,
  makeGlassMaterial,
  makeGrille,
  makeHoodGeometry,
  makeInterior,
  makeMirror,
  lampEmissiveMap,
  makeLampUnit,
  makePaintMaterial,
  makeRearGlass,
  makeRearSideGlass,
  makeSideGlass,
  makeTailTrim,
  makeTrimMaterial,
  makeTrunkGeometry,
  makeWindshield,
  type LampKind,
} from "./car-mesh.ts";
import { CAR_STYLES, type BodyStyle, type CarStyleId } from "./car-variants.ts";
import { anchorOnSkin, poseOnSkin, type SkinAnchor } from "./lamp-lights.ts";

export { CAR_HALF, DOOR, HULLS, CRUSH_HULLS, WHEEL_POS };
export type { Hull } from "./car-mesh.ts";

export interface CarPaint {
  body: number;
  accent: number;
  name: string;
}

export type WorldBounce = (pos: THREE.Vector3, vel: THREE.Vector3, r: number) => void;
export type GlassBurst = (origin: THREE.Vector3, velocity: THREE.Vector3, count: number) => void;

/** C1: only a side hit this hard (m/s EBS, 45 km/h) tears a door off; slower side hits spring it. */
const DOOR_TEAR_MPS = 12.5;
/** C1: frontal and rear crush can jam a door ajar (hingeT), never swing it open. */
const DOOR_AJAR = 0.2;
/** C2: below 30 km/h EBS a folded bumper stays on (IIHS low-speed bumper protocols). */
const BUMPER_TEAR_MPS = 30 / 3.6;

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
const DOOR_DAMP = 0.8;
/** The mirror folds about its base up to this (rad) before its stop loads. */
export const MIRROR_FOLD_MAX = (75 * Math.PI) / 180;
/** Energy the mirror's fold stop takes before the mirror snaps off (J), guessed. */
export const MIRROR_BREAK_J = 30;

/** Both ends struck within this (s) is a squeeze (`noteContactEnd`). */
const END_WINDOW = 0.25;
/** A squeeze ends once contact has been quiet this long (s), the deform's re-arm quiet time. */
const REARM_QUIET_S = 0.3;

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

interface GlassPane {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  restPos: THREE.Vector3;
  restVerts: Float32Array | null;
  state: GlassState;
  parts: ("roof" | "bonnet" | "boot" | "doorLeft" | "doorRight")[];
  skin: "glassFront" | "glassRear" | null;
}

/** Housing + lens on the body skin (never the bumper): breaks only from its own corner's crush. */
interface Lamp {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  intact: boolean;
  kind: LampKind;
  side: number;
  /** That corner's bumper-end and wing sensors. */
  sensors: number[];
  anchor: SkinAnchor;
}

interface DetachPart {
  name: string;
  object: THREE.Object3D;
  restPos: THREE.Vector3;
  restQuat: THREE.Quaternion;
  cage:
    | "bumperFront"
    | "bumperRear"
    | "bonnet"
    | "boot"
    | "doorLeft"
    | "doorRight"
    | "wingFL"
    | "wingFR";
  attachL: number;
  attachR: number;
  hinge: "cowl" | "tail" | "two-point" | "door";
  detached: boolean;
  folding: boolean;
  hingeT: number;
  velocity: THREE.Vector3;
  angular: THREE.Vector3;
  radius: number;
  /** Doors own their hinge; a mirror shares its door's. */
  swing: DoorHinge | null;
}

export class DeformableCar {
  readonly group = new THREE.Group();
  readonly body: THREE.Mesh;
  readonly deform: StreamedDeformation;
  readonly paint: CarPaint;
  readonly style: BodyStyle;
  readonly wheels: THREE.Group[] = [];
  /** Per wheel: off its popped hub and loose in the world (`dropWheel`), with its own motion. */
  private readonly looseWheels: (LooseBody & { loose: boolean })[] = [];
  readonly velocity = new THREE.Vector3();
  readonly angular = new THREE.Vector3();
  readonly forward = new THREE.Vector3(0, 0, 1);
  readonly right = new THREE.Vector3(1, 0, 0);
  readonly fwdFlat = new THREE.Vector3(0, 0, 1);
  readonly rightFlat = new THREE.Vector3(1, 0, 0);

  speed = 0;
  crashed = false;
  yaw = 0;
  roll = 0;
  pitch = 0;
  spawnSpeed = 0;
  /**
   * Last slice's drive (applyDrive writes it). spin / lock / slide are 0–1 wheel slip for tyre FX:
   * launch wheelspin, brake lock-up, sideways slide; `drift` is the drift assist's own state.
   */
  readonly drive = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false, spin: 0, lock: 0, slide: 0, drift: 0 };

  private world: THREE.Scene;
  private onGlass: GlassBurst | null;
  private bodyMat: THREE.MeshPhysicalMaterial;
  private wheelSpin = 0;
  private glassPanes: GlassPane[] = [];
  private parts: DetachPart[] = [];
  /** [left, right] door and mirror parts, also listed in `parts`. */
  private doorParts: DetachPart[] = [];
  private mirrorParts: DetachPart[] = [];
  /** Seconds since the [front, rear] end was last struck (`noteContactEnd`). */
  private readonly endAgo = new Float64Array([9, 9]);
  /** Smallest striker reach (m from centre along the length) since the squeeze began. */
  private endReach = Infinity;
  private endSqueeze = false;
  private lamps: Lamp[] = [];
  private hullHelper: THREE.LineSegments | null = null;
  private bumperF: THREE.Group;
  private bumperR: THREE.Group;
  private hood: THREE.Mesh;
  private trunk: THREE.Mesh;
  private doorL: THREE.Group;
  private doorR: THREE.Group;
  private doorMeshL: THREE.Mesh;
  private doorMeshR: THREE.Mesh;
  private hoodRest: Float32Array;
  private trunkRest: Float32Array;
  private doorLRest: Float32Array;
  private doorRRest: Float32Array;
  private hoodOrigin: THREE.Vector3;
  private trunkOrigin: THREE.Vector3;
  private interior: THREE.Mesh;
  private mirrorL: THREE.Mesh;
  private mirrorR: THREE.Mesh;

  constructor(paint: CarPaint, world: THREE.Scene, onGlass: GlassBurst | null = null, style: CarStyleId = "sedan") {
    this.paint = paint;
    this.style = CAR_STYLES[style];
    this.world = world;
    this.onGlass = onGlass;
    this.group.name = paint.name;

    this.bodyMat = makePaintMaterial(paint.body);
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

    this.doorL = new THREE.Group();
    this.doorR = new THREE.Group();
    this.doorL.position.set(-DOOR.hingeX, DOOR.hingeY, DOOR.hingeZ);
    this.doorR.position.set(DOOR.hingeX, DOOR.hingeY, DOOR.hingeZ);
    this.doorMeshL = new THREE.Mesh(makeDoorGeometry(-1), this.bodyMat);
    this.doorMeshL.position.set(0, 0, -0.28);
    this.doorMeshL.castShadow = true;
    this.doorMeshR = new THREE.Mesh(makeDoorGeometry(1), this.bodyMat);
    this.doorMeshR.position.set(0, 0, -0.28);
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

    this.bumperF = this.makeBumper(true, paint);
    this.bumperR = this.makeBumper(false, paint);
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

  private restoreRest(geo: THREE.BufferGeometry, rest: Float32Array): void {
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    (pos.array as Float32Array).set(rest);
    pos.needsUpdate = true;
    computeNormalsFast(geo);
  }

  private makeBumper(front: boolean, paint: CarPaint): THREE.Group {
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(makeBumperGeometry(front), makeTrimMaterial(paint.accent));
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

  /** Head lamps on the nose cap's top corners, tails on the tail cap's, both just above the bumper so
   *  they sit flush on the skin with the bumper gone. Each rides three nearby skin vertices. */
  private addLamps(): void {
    for (const kind of ["head", "tail"] as const) {
      const head = kind === "head";
      for (const side of [-1, 1]) {
        const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.25, emissiveMap: lampEmissiveMap() });
        const mesh = new THREE.Mesh(makeLampUnit(kind), mat);
        this.group.add(mesh);
        _p.set(side * (head ? 0.48 : 0.52), head ? 0.505 : 0.51, head ? 2.11 : -2.11);
        this.lamps.push({
          mesh,
          mat,
          intact: true,
          kind,
          side,
          sensors: head ? (side < 0 ? [1, 4] : [2, 5]) : side < 0 ? [16, 10] : [17, 11],
          anchor: anchorOnSkin(this.body.geometry, _p, head ? _lampQ.identity() : _lampQ.set(0, 1, 0, 0)),
        });
      }
    }
    this.resetLamps();
  }

  private addGlass(): void {
    const addPane = (
      mesh: THREE.Mesh,
      parent: THREE.Object3D,
      parts: GlassPane["parts"],
      skin: GlassPane["skin"] = null,
    ) => {
      mesh.renderOrder = 2;
      parent.add(mesh);
      this.glassPanes.push({
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
    addPane(new THREE.Mesh(makeWindshield(style), glassMat.clone()), this.group, ["roof", "bonnet"], "glassFront");
    addPane(new THREE.Mesh(makeRearGlass(style), glassMat.clone()), this.group, ["roof", "boot"], "glassRear");
    const sideL = new THREE.Mesh(makeSideGlass(-1, style), glassMat.clone());
    sideL.position.set(0.02, 0.52, -0.28);
    addPane(sideL, this.doorL, ["doorLeft", "roof"]);
    const sideR = new THREE.Mesh(makeSideGlass(1, style), glassMat.clone());
    sideR.position.set(-0.02, 0.52, -0.28);
    addPane(sideR, this.doorR, ["doorRight", "roof"]);
    addPane(new THREE.Mesh(makeRearSideGlass(-1, style), glassMat.clone()), this.group, ["roof", "doorLeft"]);
    addPane(new THREE.Mesh(makeRearSideGlass(1, style), glassMat.clone()), this.group, ["roof", "doorRight"]);
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
  }

  private buildHullHelper(): void {
    const pos: number[] = [];
    for (const h of HULLS) {
      const y0 = 0.18;
      const y1 = 0.72;
      const x0 = h.cx - h.hx;
      const x1 = h.cx + h.hx;
      const z0 = h.cz - h.hz;
      const z1 = h.cz + h.hz;
      const c = [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x0, y1, z1],
      ];
      const edges: [number, number][] = [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
        [4, 5],
        [5, 6],
        [6, 7],
        [7, 4],
        [0, 4],
        [1, 5],
        [2, 6],
        [3, 7],
      ];
      for (const [a, b] of edges) {
        pos.push(...c[a]!, ...c[b]!);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
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

  private updateHullHelper(): void {
    if (!this.hullHelper) return;
    const attr = this.hullHelper.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    let o = 0;
    for (const h of this.hulls()) {
      const y0 = 0.18;
      const y1 = 0.72;
      const x0 = h.cx - h.hx;
      const x1 = h.cx + h.hx;
      const z0 = h.cz - h.hz;
      const z1 = h.cz + h.hz;
      const c = [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x0, y1, z1],
      ];
      const edges: [number, number][] = [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
        [4, 5],
        [5, 6],
        [6, 7],
        [7, 4],
        [0, 4],
        [1, 5],
        [2, 6],
        [3, 7],
      ];
      for (const [a, b] of edges) {
        const pa = c[a]!;
        const pb = c[b]!;
        arr[o++] = pa[0]!;
        arr[o++] = pa[1]!;
        arr[o++] = pa[2]!;
        arr[o++] = pb[0]!;
        arr[o++] = pb[1]!;
        arr[o++] = pb[2]!;
      }
    }
    attr.needsUpdate = true;
  }

  hulls() {
    if (!this.deform.massActive) return HULLS;
    const frontOff = this.parts.some((p) => p.name === "bumperF" && p.detached);
    const rearOff = this.parts.some((p) => p.name === "bumperR" && p.detached);
    return this.deform.liveHulls(frontOff, rearOff);
  }

  crushHulls() {
    if (!this.deform.massActive) return CRUSH_HULLS;
    const frontOff = this.parts.some((p) => p.name === "bumperF" && p.detached);
    const rearOff = this.parts.some((p) => p.name === "bumperR" && p.detached);
    return this.deform.liveCrushHulls(frontOff, rearOff);
  }

  spawn(x: number, z: number, speed: number): void {
    this.resetVisual();
    this.group.position.set(x, 0, z);
    this.group.lookAt(0, 0, 0);
    this.refreshBasis();
    this.yaw = Math.atan2(this.forward.x, this.forward.z);
    this.group.rotation.set(0, this.yaw, 0, "YXZ");
    this.roll = 0;
    this.pitch = 0;
    this.speed = speed;
    this.spawnSpeed = speed;
    this.crashed = false;
    this.angular.set(0, 0, 0);
    this.refreshBasis();
    this.velocity.copy(this.forward).multiplyScalar(speed);
    this.deform.bindKinematic(this.group, this.velocity, this.angular);
    this.resetLamps();
  }

  spawnFacing(x: number, z: number, yaw: number, speed: number): void {
    this.resetVisual();
    this.yaw = yaw;
    this.group.position.set(x, 0, z);
    this.group.rotation.set(0, yaw, 0, "YXZ");
    this.roll = 0;
    this.pitch = 0;
    this.speed = speed;
    this.spawnSpeed = speed;
    this.crashed = false;
    this.angular.set(0, 0, 0);
    this.refreshBasis();
    this.velocity.copy(this.fwdFlat).multiplyScalar(speed);
    this.deform.bindKinematic(this.group, this.velocity, this.angular);
    this.resetLamps();
    this.setHighlight(false);
  }

  setHighlight(on: boolean): void {
    if (on) {
      this.bodyMat.emissive.setHex(0xffe08a);
      this.bodyMat.emissiveIntensity = 0.55;
    } else {
      this.bodyMat.emissive.setHex(0x000000);
      this.bodyMat.emissiveIntensity = 0;
    }
    this.bodyMat.needsUpdate = true;
  }

  resetVisual(): void {
    this.deform.reset();
    this.deform.restoreRest(this.body.geometry);
    this.restoreRest(this.hood.geometry, this.hoodRest);
    this.restoreRest(this.trunk.geometry, this.trunkRest);
    this.restoreRest(this.doorMeshL.geometry, this.doorLRest);
    this.restoreRest(this.doorMeshR.geometry, this.doorRRest);
    this.wheelSpin = 0;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      const loose = this.looseWheels[i]!;
      if (loose.loose) {
        this.world.remove(w);
        this.group.add(w);
        loose.loose = false;
        loose.velocity.set(0, 0, 0);
        loose.angular.set(0, 0, 0);
      }
      const rest = WHEEL_POS[i]!;
      w.position.set(rest[0], rest[1], rest[2]);
      w.rotation.set(0, 0, 0);
      w.visible = true;
    }
    this.bodyMat.roughness = 0.42;
    this.setHighlight(false);
    this.group.rotation.set(0, 0, 0);
    this.interior.scale.set(1, 1, 1);
    this.interior.position.set(0, 0, 0);

    this.endAgo.fill(9);
    this.endReach = Infinity;
    this.endSqueeze = false;
    for (const p of this.parts) {
      if (p.detached) {
        this.world.remove(p.object);
        if (p.name === "mirrorL") this.doorL.add(p.object);
        else if (p.name === "mirrorR") this.doorR.add(p.object);
        else this.group.add(p.object);
      }
      p.detached = false;
      p.folding = false;
      p.hingeT = 0;
      if (p.swing) {
        p.swing.theta = 0;
        p.swing.omega = 0;
        p.swing.latched = true;
        p.swing.load = 0;
        p.swing.mirrorFold = 0;
      }
      p.object.position.copy(p.restPos);
      p.object.quaternion.copy(p.restQuat);
      p.object.rotation.set(0, 0, 0);
      p.object.scale.set(1, 1, 1);
      p.object.visible = true;
      p.velocity.set(0, 0, 0);
      p.angular.set(0, 0, 0);
    }
    for (const g of this.glassPanes) {
      g.state = "intact";
      g.mesh.visible = true;
      g.mesh.position.copy(g.restPos);
      if (g.restVerts) this.restoreRest(g.mesh.geometry, g.restVerts);
      g.mat.opacity = 0.78;
      g.mat.map = null;
      g.mat.roughness = 0.06;
      g.mat.needsUpdate = true;
    }
    this.resetLamps();
  }

  /** Relight every lamp and re-seat it on the (rest) skin. */
  private resetLamps(): void {
    for (const lamp of this.lamps) {
      lamp.intact = true;
      lamp.mat.color.setHex(0xffffff);
      lamp.mat.emissive.setHex(lamp.kind === "head" ? 0xf4f1e8 : 0xe01018);
      // Tail stays below ACES's bright-red-to-yellow knee so the lens reads red under its own glow.
      lamp.mat.emissiveIntensity = lamp.kind === "head" ? 1.15 : 1.1;
    }
    this.poseLamps();
  }

  /** Seat each lamp on the skinned body; after every skin write (4 anchors, no allocation). */
  private poseLamps(): void {
    const pos = (this.body.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    for (const l of this.lamps) poseOnSkin(l.anchor, pos, l.mesh.position, l.mesh.quaternion);
  }

  get lampCount(): number {
    return this.lamps.length;
  }

  /** Writes lamp `i`'s world seat on the skin and outward axis; returns its kind, or null once broken. */
  lampWorld(i: number, pos: THREE.Vector3, dir: THREE.Vector3): LampKind | null {
    const l = this.lamps[i]!;
    dir.set(0, 0, 1).applyQuaternion(l.mesh.quaternion).applyQuaternion(this.group.quaternion);
    pos.copy(l.mesh.position).applyQuaternion(this.group.quaternion).add(this.group.position);
    return l.intact ? l.kind : null;
  }

  /** Group matrix only: children are refreshed once per frame by the renderer. Recursing the
   * ~60-node car subtree here was ~40% of frame CPU at 10+ cars. */
  refreshBasis(): void {
    this.group.updateWorldMatrix(false, false);
    this.forward.set(0, 0, 1).applyQuaternion(this.group.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(this.group.quaternion);
    const fl = Math.hypot(this.forward.x, this.forward.z);
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

  /**
   * `impulse` is the closing speed (FX, glass); `ebs` the equivalent barrier speed that sizes the crush.
   * The first hit starts the crash; on a wreck a fresh, hard enough contact re-arms a new hit (`rearmHit`).
   */
  applyImpact(worldPoint: THREE.Vector3, worldInward: THREE.Vector3, impulse: number, ebs: number): void {
    const localP = this.worldToLocalPoint(worldPoint, _p);
    _in.copy(worldInward);
    _in.y = 0;
    _v.copy(this.group.position).sub(worldPoint);
    _v.y = 0;
    if (_v.lengthSq() > 1e-8) {
      _v.normalize();
      if (_in.dot(_v) < 0) _in.negate();
    }
    const localN = this.worldToLocalDir(_in, _n);
    const rough = Math.min(0.82, 0.42 + impulse * 0.012);
    if (this.crashed && this.deform.massActive) {
      if (!this.deform.rearmHit(localP, localN, impulse, ebs)) return;
      this.bodyMat.roughness = Math.max(this.bodyMat.roughness, rough);
    } else {
      this.crashed = true;
      this.deform.beginCrush(localP, localN, impulse, ebs, this.group, this.velocity, this.angular);
      this.bodyMat.roughness = rough;
    }
    this.deform.impulseAt(worldPoint, _in, impulse);
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

  syncPose(dt: number): void {
    this.deform.followGroup(this.group, this.velocity, this.angular, dt);
    this.yaw = this.group.rotation.y;
    this.roll = this.group.rotation.z;
    this.pitch = this.group.rotation.x;
    this.refreshBasis();
  }

  afterContacts(dt: number, bounce?: WorldBounce): void {
    this.endAgo[0] += dt;
    this.endAgo[1] += dt;
    const d = this.deform;
    // The squeeze lasts while both ends are still being struck; after it a hit is an ordinary
    // one-ended hit again (and may re-arm), and a settled wreck may plant.
    if (this.endSqueeze && Math.max(this.endAgo[0]!, this.endAgo[1]!) > END_WINDOW) {
      this.endSqueeze = false;
      d.bidirectional = false;
      d.deepCrush = false;
    }
    if (this.endReach < Infinity && d.quietTime() > REARM_QUIET_S && Math.min(this.endAgo[0]!, this.endAgo[1]!) > END_WINDOW) this.endReach = Infinity;
    if (!this.doorParts[0]!.swing!.latched || !this.doorParts[1]!.swing!.latched) this.swingDoors(dt);
    if (!d.massActive) return;
    this.nudgeWheels(dt);
    this.stepLooseParts(dt, bounce);
  }

  /**
   * Shared crash rule for every contact path (car-car, press, pistons; docs/CONTACT_PARITY.md):
   * `end` (+1 front, −1 rear) is being struck, the striker's face `reach` m from the car's centre
   * along its length. Both ends struck within `END_WINDOW` is a squeeze: both ends become crumple
   * zones (`bidirectional`), and once a face is inboard of the wheel centres the cage may yield
   * (`deepCrush`). Both clear when the contact has been quiet for `REARM_QUIET_S`.
   */
  noteContactEnd(end: 1 | -1, reach: number): void {
    this.endAgo[end > 0 ? 0 : 1] = 0;
    this.endReach = Math.min(this.endReach, reach);
    if (this.endAgo[0]! < END_WINDOW && this.endAgo[1]! < END_WINDOW) {
      this.endSqueeze = true;
      this.deform.bidirectional = true;
    }
    if (this.endSqueeze && this.endReach < WHEEL_POS[0]![2]) this.deform.deepCrush = true;
  }

  snapshot(): Record<string, unknown> {
    return {
      name: this.paint.name,
      crashed: this.crashed,
      pos: { x: round4(this.group.position.x), y: round4(this.group.position.y), z: round4(this.group.position.z) },
      vel: { x: round4(this.velocity.x), y: round4(this.velocity.y), z: round4(this.velocity.z) },
      speed: round4(this.velocity.length()),
      angular: { x: round4(this.angular.x), y: round4(this.angular.y), z: round4(this.angular.z) },
      yaw: round4(this.yaw),
      pitch: round4(this.pitch),
      roll: round4(this.roll),
      spawnSpeed: round4(this.spawnSpeed),
      deform: this.deform.snapshot(),
      parts: this.parts.map((p) => ({
        name: p.name,
        detached: p.detached,
        folding: p.folding,
        hingeT: round4(p.hingeT),
        pos: { x: round4(p.object.position.x), y: round4(p.object.position.y), z: round4(p.object.position.z) },
        vel: { x: round4(p.velocity.x), y: round4(p.velocity.y), z: round4(p.velocity.z) },
      })),
      lamps: this.lamps.map((l) => ({
        kind: l.kind,
        side: l.side,
        intact: l.intact,
        on: l.intact && l.mat.emissiveIntensity > 0.05,
      })),
      glass: this.glassPanes.map((g) => g.state),
    };
  }

  step(dt: number): void {
    this.integrate(dt);
    this.updateDeform(dt);
  }

  integrate(dt: number): void {
    if (this.deform.massActive) {
      this.syncPose(dt);
      this.nudgeWheels(dt);
      this.stepLooseParts(dt);
      return;
    }
    if (!this.crashed) {
      this.velocity.y -= 9.6 * dt;
      this.group.position.addScaledVector(this.velocity, dt);
      this.wheelSpin += (this.speed / 0.32) * dt;
      for (const w of this.wheels) w.rotation.x = this.wheelSpin;
      this.deform.bindKinematic(this.group, this.velocity, this.angular);
    } else {
      this.velocity.y -= 9.6 * dt;
      this.velocity.x *= Math.pow(0.28, dt);
      this.velocity.z *= Math.pow(0.28, dt);
      this.angular.multiplyScalar(Math.pow(0.45, dt));
      this.group.position.addScaledVector(this.velocity, dt);
      this.yaw += this.angular.y * dt;
      this.roll = THREE.MathUtils.damp(this.roll, this.angular.z * 0.15, 4, dt);
      this.pitch = THREE.MathUtils.damp(this.pitch, this.angular.x * 0.12, 4, dt);
      this.group.rotation.set(this.pitch, this.yaw, this.roll, "YXZ");
      const v = this.velocity.length();
      this.wheelSpin += (v / 0.32) * dt;
      for (const w of this.wheels) w.rotation.x = this.wheelSpin;
    }
    if (this.group.position.y < 0) {
      this.group.position.y = 0;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }
    this.refreshBasis();
    this.stepLooseParts(dt);
  }

  updateDeform(dt: number): void {
    this.deform.update(dt, this.body.geometry);
    // LoD gate lifted (back on screen / large again): catch the mesh up to the cages first.
    if (!this.deform.skinDeferred) this.deform.flushSkin(this.body.geometry);
    if (this.deform.skinnedThisFrame) this.poseLamps();
    if (this.crashed) {
      if (this.deform.skinnedThisFrame) this.skinPanels();
      this.syncAttachedParts(dt);
      this.followGlass();
      this.evaluateBreakage(this.deform.impulseValue, dt);
    }
    if (this.deform.massActive) this.fitInterior();
    if (this.hullHelper?.visible) this.updateHullHelper();
  }

  /** LoD catch-up once the camera has moved: write a deferred dent before this car is drawn. */
  flushDeferredSkin(): void {
    this.deform.skinDeferred = false;
    if (!this.deform.flushSkin(this.body.geometry)) return;
    this.poseLamps();
    if (this.crashed) this.skinPanels();
  }

  /** Bonnet, boot lid and the skinned glass follow the body skin. */
  private skinPanels(): void {
    let hood = true;
    let trunk = true;
    for (const p of this.parts) {
      if (!p.detached) continue;
      if (p.name === "hood") hood = false;
      else if (p.name === "trunk") trunk = false;
    }
    if (hood) this.deform.skinPanel(this.hood.geometry, this.hoodRest, "bonnet", this.hoodOrigin);
    if (trunk) this.deform.skinPanel(this.trunk.geometry, this.trunkRest, "boot", this.trunkOrigin);
    for (const g of this.glassPanes) {
      if (!g.skin || !g.restVerts || g.state === "shattered") continue;
      this.deform.skinPanel(g.mesh.geometry, g.restVerts, g.skin, _zero);
    }
  }

  /** `drop`: a popped hub throws its wheel (host); a netplay client takes loose wheels from snapshots. */
  private nudgeWheels(dt: number, drop = true): void {
    const v = this.velocity.length();
    if (!this.deform.drivetrainAlive) {
      this.wheelSpin *= Math.pow(0.45, dt);
      this.wheelSpin += (v / 0.32) * dt * 0.2;
    } else {
      const drive = this.crashed && this.deform.crushElapsed > 0.05 ? 0.35 : 1;
      this.wheelSpin += (v / 0.32) * dt * drive;
    }
    const hubs = ["hubFL", "hubFR", "hubRL", "hubRR"] as const;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      if (this.looseWheels[i]!.loose) continue;
      const rest = WHEEL_POS[i]!;
      w.rotation.x = this.wheelSpin;
      if (!this.deform.massActive) {
        w.position.set(rest[0], rest[1], rest[2]);
        continue;
      }
      const hub = this.deform.massLocal(hubs[i]!);
      const popped = this.deform.hubPopped(hubs[i]!);
      if (!popped) {
        // Follows its hub along the car too: a face's shove, or a squeeze past the hubs, moves it off rest.
        w.position.set(hub.x, THREE.MathUtils.clamp(hub.y, 0.16, 0.55), hub.z);
        w.visible = true;
        continue;
      }
      if (drop) this.dropWheel(i, hubs[i]!);
    }
  }

  setRigVisible(v: boolean): void {
    this.deform.setHelperVisible(v);
    if (this.hullHelper) this.hullHelper.visible = v;
    if (v) this.updateHullHelper();
  }

  dispose(): void {
    this.deform.disposeHelper();
    for (const p of this.parts) {
      p.object.removeFromParent();
    }
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) if (!m.userData.shared) m.dispose();
      }
      if (obj instanceof THREE.Light) obj.dispose();
    });
  }

  private syncAttachedParts(dt: number): void {
    const ix = this.deform.impactInward.x;
    const iz = this.deform.impactInward.z;
    for (const p of this.parts) {
      if (p.detached) continue;
      const left = this.deform.sensorCompression(p.attachL);
      const right = this.deform.sensorCompression(p.attachR);
      const crush = Math.max(left, right, this.deform.partCompression(p.cage));
      const local = Math.min(left, right);
      const onHit = this.partOnHit(p);

      let target = 0;
      if (p.name.startsWith("mirror")) {
        // C3: the mirror folds with the door skin under it (sensors 6/7 and 4/5), on its own side only.
        if (onHit) target = THREE.MathUtils.clamp((Math.max(left, right) - 0.04) / 0.3, 0, 1);
      } else if (p.hinge === "door") {
        const open = THREE.MathUtils.clamp((Math.max(local, crush) - 0.08) / 0.5, 0, 1);
        const endOn = !this.deform.bidirectional && Math.abs(ix) <= Math.abs(iz);
        if (onHit) target = open;
        else if (endOn && (crush > 0.16 || local > 0.12)) target = Math.min(open, DOOR_AJAR);
      } else if (onHit) {
        if (p.hinge === "two-point") target = THREE.MathUtils.clamp((crush - 0.04) / 0.55, 0, 1);
        else if (p.hinge === "cowl") target = THREE.MathUtils.clamp((crush - 0.1) / 0.6, 0, 1);
        else if (p.hinge === "tail") target = THREE.MathUtils.clamp((crush - 0.1) / 0.6, 0, 1);
      }
      p.hingeT = Math.max(p.hingeT, Math.min(target, p.hingeT + Math.max(dt * 3.2, 0.012)));
      this.posePart(p);
    }
  }

  /** Rest pose plus the hinge value `hingeT` (crash) and, on doors and mirrors, the free swing. */
  private posePart(p: DetachPart): void {
    const t = p.hingeT;
    p.object.position.copy(p.restPos);
    p.object.quaternion.copy(p.restQuat);
    p.object.scale.set(1, 1, 1);

    if (p.hinge === "two-point") {
      if (p.name.startsWith("bumper")) {
        p.folding = t > 0.04;
        const fl = this.deform.massLocal(p.name === "bumperF" ? "bumperFL" : "bumperRL");
        const fr = this.deform.massLocal(p.name === "bumperF" ? "bumperFR" : "bumperRR");
        p.object.position.set((fl.x + fr.x) * 0.5, (fl.y + fr.y) * 0.5, (fl.z + fr.z) * 0.5);
        const span = Math.abs(fl.z - (p.name === "bumperF" ? 2.06 : -2.06));
        p.object.scale.set(1 + t * 0.04, Math.max(0.45, 1 - t * 0.28), Math.max(0.18, 1 - span * 0.45));
      } else {
        p.folding = t > 0.08;
        const side = p.name === "mirrorL" ? -1 : 1;
        p.object.rotation.z += side * t * 1.4;
        p.object.rotation.y = p.swing!.mirrorFold;
        p.object.position.y -= t * 0.12;
        p.object.position.x += side * t * 0.18;
      }
    } else if (p.hinge === "cowl") {
      p.folding = t > 0.06;
      p.object.position.z -= t * 0.08;
      p.object.position.y += t * 0.26;
      p.object.rotation.x = -t * 0.5;
    } else if (p.hinge === "tail") {
      p.folding = t > 0.06;
      p.object.position.z += t * 0.08;
      p.object.position.y += t * 0.22;
      p.object.rotation.x = t * 0.5;
    } else if (p.hinge === "door") {
      p.folding = t > 0.08;
      const sign = p.name === "doorL" ? -1 : 1;
      p.object.rotation.y = -sign * Math.max(t * 1.45, p.swing!.theta);
      p.object.position.x += sign * t * 0.06;
      p.object.updateWorldMatrix(true, false);
      _box.setFromObject(p.object);
      if (_box.min.y < 0.04) p.object.position.y += 0.04 - _box.min.y;
    }
  }

  /** Door hinge state; `side` −1 is the left door, +1 the right. */
  doorHinge(side: number): DoorHinge {
    return this.doorParts[side < 0 ? 0 : 1]!.swing!;
  }

  /** Whether a door or mirror has left the car; a mirror rides off on its torn door. */
  partOff(name: "doorL" | "doorR" | "mirrorL" | "mirrorR"): boolean {
    const i = name.endsWith("L") ? 0 : 1;
    const door = this.doorParts[i]!.detached;
    return name.startsWith("door") ? door : door || this.mirrorParts[i]!.detached;
  }

  /** Unlatch a door and leave it at rest `theta` open (rad, up to the stop); 0 shuts and latches it. */
  setDoorOpen(side: number, theta: number): void {
    const p = this.doorParts[side < 0 ? 0 : 1]!;
    if (p.detached) return;
    const h = p.swing!;
    h.theta = THREE.MathUtils.clamp(theta, 0, DOOR_OPEN_MAX);
    h.omega = 0;
    h.latched = h.theta === 0;
    this.posePart(p);
  }

  /**
   * The check strap takes `energy` (J) past the stop. Once the total passes `HINGE_TEAR_J` the
   * door tears off with `push` (car-space m/s on top of the car's velocity). Returns whether it did.
   */
  loadDoorStop(side: number, energy: number, push: THREE.Vector3): boolean {
    const p = this.doorParts[side < 0 ? 0 : 1]!;
    if (p.detached) return false;
    p.swing!.load += energy;
    if (p.swing!.load < HINGE_TEAR_J) return false;
    this.detachPart(p, 0, push);
    return true;
  }

  /** Fold a mirror about its base (rad, its `rotation.y` in door space). */
  setMirrorFold(side: number, angle: number): void {
    const m = this.mirrorParts[side < 0 ? 0 : 1]!;
    if (m.detached) return;
    m.swing!.mirrorFold = angle;
    this.posePart(m);
  }

  /** Snap a mirror off its door with `push` (car-space m/s). */
  breakMirror(side: number, push: THREE.Vector3): void {
    this.detachPart(this.mirrorParts[side < 0 ? 0 : 1]!, 0, push);
  }

  /** Free door swing: hinge friction, then the check-strap stop, or the latch / slam overload at 0. */
  swingDoors(dt: number): void {
    for (let i = 0; i < 2; i++) {
      const p = this.doorParts[i]!;
      if (p.detached) continue;
      const h = p.swing!;
      const sign = i === 0 ? -1 : 1;
      if (!h.latched) {
        h.theta += h.omega * dt;
        h.omega *= Math.exp(-DOOR_DAMP * dt);
        if (h.theta >= DOOR_OPEN_MAX && h.omega > 0) {
          h.theta = DOOR_OPEN_MAX;
          // The trailing edge's velocity is what the strap stops.
          _push.set(sign * Math.cos(h.theta), 0, Math.sin(h.theta)).multiplyScalar(h.omega * DOOR.length);
          const e = 0.5 * DOOR_INERTIA * h.omega * h.omega;
          // The strap's detent holds it on the stop.
          h.omega = 0;
          if (this.loadDoorStop(sign, e, _push)) continue;
        } else if (h.theta <= 0 && h.omega < 0) {
          h.theta = 0;
          if (0.5 * DOOR_INERTIA * h.omega * h.omega >= SLAM_TEAR_J) {
            // Wrenched out of its hinges against the frame: it leaves outward and rearward at its
            // centre's swing speed.
            _push.set(sign * 1.2, 0.6, 0.5 * DOOR.length * h.omega);
            this.detachPart(p, 0, _push);
            continue;
          }
          h.theta = 0;
          h.omega = 0;
          h.latched = true;
        }
      }
      this.posePart(p);
      const m = this.mirrorParts[i]!;
      if (!m.detached) this.posePart(m);
    }
  }

  private fitInterior(): void {
    if (!this.deform.massActive) {
      this.interior.scale.set(1, 1, 1);
      this.interior.position.set(0, 0, 0);
      return;
    }
    const l = this.deform.massLocal("doorL");
    const r = this.deform.massLocal("doorR");
    const cell = this.deform.massLocal("cell");
    const span = Math.max(0.35, r.x - l.x);
    this.interior.scale.x = THREE.MathUtils.clamp(span / 1.56, 0.32, 1);
    this.interior.position.x = (l.x + r.x) * 0.5;
    this.interior.position.z = cell.z * 0.35;
    this.interior.position.y = THREE.MathUtils.clamp(cell.y - 0.55, -0.08, 0.1);
  }

  private followGlass(): void {
    const inward = this.deform.impactInward;
    for (const g of this.glassPanes) {
      if (g.state === "shattered" || g.skin) continue;
      const onDoor = g.parts.includes("doorLeft") || g.parts.includes("doorRight");
      if (onDoor) continue;
      let nearby = 0;
      for (const part of g.parts) nearby = Math.max(nearby, this.deform.partCompression(part));
      g.mesh.position.copy(g.restPos);
      if (nearby < 0.02) continue;
      g.mesh.position.x += inward.x * nearby * 0.32;
      g.mesh.position.y += inward.y * nearby * 0.12 - nearby * 0.08;
      g.mesh.position.z += inward.z * nearby * 0.32;
    }
  }

  /** Whether the current hit loads this part. Doors and the mirrors on them (C1/C3) take a hit only
   *  from their own side; every other part must sit on the struck end. */
  private partOnHit(p: DetachPart): boolean {
    const ix = this.deform.impactInward.x;
    const iz = this.deform.impactInward.z;
    if (this.deform.bidirectional) return Math.abs(p.restPos.z) > 0.8 || Math.abs(p.restPos.x) > 0.5;
    const side = p.cage === "doorLeft" ? -1 : p.cage === "doorRight" ? 1 : 0;
    if (side !== 0) return Math.abs(ix) > Math.abs(iz) && Math.sign(ix) === -side;
    return -(p.restPos.x * ix + p.restPos.z * iz) > 0.12;
  }

  private evaluateBreakage(impulse: number, _dt: number): void {
    void _dt;
    for (const g of this.glassPanes) {
      if (g.state === "shattered") continue;
      let nearby = 0;
      for (const part of g.parts) nearby = Math.max(nearby, this.deform.partCompression(part));
      if (g.state === "intact" && nearby > 0.45 && this.deform.crushElapsed > 0.12) {
        g.state = "cracked";
        g.mat.map = getCrackMap();
        g.mat.opacity = 0.55;
        g.mat.roughness = 0.32;
        g.mat.needsUpdate = true;
      }
      if (
        (nearby > 0.7 && this.deform.crushElapsed > 0.2) ||
        (nearby > 0.55 && impulse > 40 && this.deform.crushElapsed > 0.16)
      ) {
        this.shatterGlass(g);
      }
    }

    const ebs = this.deform.hitSpeedValue;
    for (const p of this.parts) {
      if (p.detached) continue;
      if (this.deform.bidirectional && p.hinge !== "door" && p.hinge !== "two-point") continue;
      if (!this.partOnHit(p)) continue;
      let should = false;
      if (p.name.startsWith("mirror")) should = p.hingeT > 0.5;
      else if (p.name.startsWith("bumper")) should = p.hingeT > 0.7 && ebs >= BUMPER_TEAR_MPS;
      else if (p.hinge === "cowl" || p.hinge === "tail") should = p.hingeT > 0.78;
      else if (p.hinge === "door") should = p.hingeT > 0.58 && (this.deform.bidirectional || ebs >= DOOR_TEAR_MPS);
      if (should) this.detachPart(p, impulse);
    }

    for (const lamp of this.lamps) {
      if (!lamp.intact) continue;
      let crush = 0;
      for (const s of lamp.sensors) crush = Math.max(crush, this.deform.sensorCompression(s));
      if (crush > 0.18 && this.deform.crushElapsed > 0.02) this.breakLamp(lamp);
    }
  }

  private breakLamp(lamp: Lamp): void {
    lamp.intact = false;
    lamp.mat.color.setHex(0x5a5c60);
    lamp.mat.emissive.setHex(0x1a1b1c);
    lamp.mat.emissiveIntensity = 0.12;
  }

  /** Hand a part to the world. `push` (car-space m/s on top of the car's velocity) replaces the
   *  crash launch: outward from the body by `impulse`, popped up by `hingeT`. */
  private detachPart(p: DetachPart, impulse: number, push?: THREE.Vector3): void {
    if (p.detached) return;
    p.detached = true;
    this.group.updateMatrixWorld();
    const wpos = new THREE.Vector3();
    const wquat = new THREE.Quaternion();
    p.object.getWorldPosition(wpos);
    p.object.getWorldQuaternion(wquat);
    this.group.remove(p.object);
    this.world.add(p.object);
    p.object.position.copy(wpos);
    p.object.quaternion.copy(wquat);
    if (push) {
      p.velocity.copy(push).applyQuaternion(this.group.quaternion).add(this.velocity);
    } else {
      _p.copy(wpos).sub(this.group.position).setY(0);
      if (_p.lengthSq() < 1e-6) _p.set(p.restPos.x, 0, p.restPos.z).applyQuaternion(this.group.quaternion);
      _p.normalize();
      p.velocity.copy(this.velocity);
      p.velocity.addScaledVector(_p, 2.2 + Math.min(5, impulse * 0.06));
      p.velocity.y += 2.1 + p.hingeT * 1.2;
      p.object.position.addScaledVector(_p, 0.14);
      p.object.position.y += 0.08;
    }
    p.angular.set(
      (Math.random() - 0.5) * 6,
      (Math.random() - 0.5) * 5,
      (Math.random() - 0.5) * 6,
    );
    if (p.hinge === "door") p.angular.y += (p.name === "doorL" ? -1 : 1) * (3.2 + p.hingeT * 2.4);
    else if (p.hinge === "cowl") p.angular.x -= 3.4;
    else if (p.hinge === "tail") p.angular.x += 3.4;
  }

  private shatterGlass(g: GlassPane): void {
    g.state = "shattered";
    g.mesh.visible = false;
    this.group.updateMatrixWorld();
    const origin = new THREE.Vector3();
    g.mesh.getWorldPosition(origin);
    origin.y += 0.12;
    const vel = this.pointVelocity(origin, new THREE.Vector3());
    vel.y += 1.5 + Math.abs(this.angular.x) * 2;
    this.onGlass?.(origin, vel, 56);
  }

  private stepLooseParts(dt: number, bounce?: WorldBounce): void {
    for (const p of this.parts) if (p.detached) stepLoose(p, dt, 0.12, bounce);
    for (const w of this.looseWheels) if (w.loose) stepLoose(w, dt, TYRE_R, bounce);
  }

  /** A popped hub's wheel leaves the car: a world object launched at the hub's speed, out and up. */
  private dropWheel(i: number, hub: string): void {
    const w = this.looseWheels[i]!;
    w.loose = true;
    this.group.updateMatrixWorld();
    w.object.getWorldQuaternion(_lampQ);
    this.group.remove(w.object);
    this.world.add(w.object);
    w.object.position.copy(this.deform.massWorld(hub));
    w.object.position.y = Math.max(TYRE_R, w.object.position.y);
    w.object.quaternion.copy(_lampQ);
    _p.copy(w.object.position).sub(this.group.position).setY(0);
    if (_p.lengthSq() > 1e-6) _p.normalize();
    w.velocity.copy(this.deform.massVel(hub)).addScaledVector(_p, 1.2);
    w.velocity.y = Math.max(w.velocity.y, 0) + 1;
    // Rolls on about its axle (the car's x) at the hub's ground speed.
    _n.set(1, 0, 0).applyQuaternion(this.group.quaternion);
    w.angular.copy(_n).multiplyScalar(Math.hypot(w.velocity.x, w.velocity.z) / TYRE_R);
  }

  /** Netplay: array sizes for a `PartNetState`. */
  partNetSizes(): { parts: number; lamps: number; glass: number; wheels: number } {
    return { parts: this.parts.length, lamps: this.lamps.length, glass: this.glassPanes.length, wheels: this.wheels.length };
  }

  /** Netplay host: part, lamp and glass state, and each loose part's world pose. */
  readPartNetState(out: PartNetState): void {
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i]!;
      const s = p.swing;
      out.flags[i] = (p.detached ? 1 : 0) | (p.folding ? 2 : 0) | (s?.latched ? 4 : 0);
      out.hinge[i * 3] = p.hingeT;
      out.hinge[i * 3 + 1] = s ? s.theta : 0;
      out.hinge[i * 3 + 2] = s ? s.mirrorFold : 0;
      if (!p.detached) continue;
      p.object.position.toArray(out.pose, i * 7);
      p.object.quaternion.toArray(out.pose, i * 7 + 3);
    }
    let lamps = 0;
    for (let i = 0; i < this.lamps.length; i++) if (this.lamps[i]!.intact) lamps |= 1 << i;
    let glass = 0;
    for (let i = 0; i < this.glassPanes.length; i++) {
      const s = this.glassPanes[i]!.state;
      glass |= (s === "cracked" ? 1 : s === "shattered" ? 2 : 0) << (i * 2);
    }
    out.lamps = lamps;
    out.glass = glass;
    let wheels = 0;
    for (let i = 0; i < this.wheels.length; i++) {
      if (!this.looseWheels[i]!.loose) continue;
      wheels |= 1 << i;
      this.wheels[i]!.position.toArray(out.wheels, i * 7);
      this.wheels[i]!.quaternion.toArray(out.wheels, i * 7 + 3);
    }
    out.wheelLoose = wheels;
  }

  /**
   * Netplay client: take the host's deform and part state with no physics, breakage, launch or FX,
   * so the skin, hulls, parts, lamps and glass match the host's. Set the pose first.
   */
  writeNetState(deform: DeformNetState, parts: PartNetState): void {
    this.deform.writeNetState(deform, this.group, this.body.geometry);
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i]!;
      const f = parts.flags[i]!;
      const loose = (f & 1) !== 0;
      if (loose !== p.detached) {
        p.object.removeFromParent();
        if (loose) this.world.add(p.object);
        else if (p.name === "mirrorL") this.doorL.add(p.object);
        else if (p.name === "mirrorR") this.doorR.add(p.object);
        else this.group.add(p.object);
        p.detached = loose;
      }
      p.folding = (f & 2) !== 0;
      p.hingeT = parts.hinge[i * 3]!;
      if (p.swing) {
        p.swing.theta = parts.hinge[i * 3 + 1]!;
        p.swing.mirrorFold = parts.hinge[i * 3 + 2]!;
        p.swing.latched = (f & 4) !== 0;
        p.swing.omega = 0;
      }
      if (!loose) continue;
      p.object.position.fromArray(parts.pose, i * 7);
      p.object.quaternion.fromArray(parts.pose, i * 7 + 3);
    }
    // Mirrors pose on their door, which shares their swing: every swing is set before any pose.
    for (const p of this.parts) if (!p.detached) this.posePart(p);

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      const lw = this.looseWheels[i]!;
      const loose = ((parts.wheelLoose >> i) & 1) !== 0;
      if (loose !== lw.loose) {
        // Back under the class hub group (assignClass), where resetVisual's re-dress puts it.
        if (loose) this.world.add(w);
        else (this.group.getObjectByName("classHubs") ?? this.group).add(w);
        lw.loose = loose;
        lw.velocity.set(0, 0, 0);
        lw.angular.set(0, 0, 0);
      }
      if (!loose) continue;
      w.position.fromArray(parts.wheels, i * 7);
      w.quaternion.fromArray(parts.wheels, i * 7 + 3);
      w.visible = true;
    }

    let relight = false;
    for (let i = 0; i < this.lamps.length; i++) if ((parts.lamps >> i) & 1 && !this.lamps[i]!.intact) relight = true;
    if (relight) this.resetLamps();
    for (let i = 0; i < this.lamps.length; i++) if (!((parts.lamps >> i) & 1) && this.lamps[i]!.intact) this.breakLamp(this.lamps[i]!);

    for (let i = 0; i < this.glassPanes.length; i++) {
      const g = this.glassPanes[i]!;
      const want = (parts.glass >> (i * 2)) & 3;
      const have = g.state === "intact" ? 0 : g.state === "cracked" ? 1 : 2;
      if (want === have) continue;
      if (want < have) {
        g.state = "intact";
        g.mesh.visible = true;
        g.mesh.position.copy(g.restPos);
        if (g.restVerts) this.restoreRest(g.mesh.geometry, g.restVerts);
        g.mat.opacity = 0.78;
        g.mat.map = null;
        g.mat.roughness = 0.06;
        g.mat.needsUpdate = true;
      }
      if (want >= 1 && g.state === "intact") {
        g.state = "cracked";
        g.mat.map = getCrackMap();
        g.mat.opacity = 0.55;
        g.mat.roughness = 0.32;
        g.mat.needsUpdate = true;
      }
      if (want === 2) {
        g.state = "shattered";
        g.mesh.visible = false;
      }
    }

    if (this.deform.skinnedThisFrame) {
      this.poseLamps();
      this.skinPanels();
    }
    this.followGlass();
    this.fitInterior();
    if (this.hullHelper?.visible) this.updateHullHelper();
  }

  /** Netplay client, every frame: wheels spin and ride their hubs as `afterContacts` does on the host. */
  netFrame(dt: number): void {
    this.nudgeWheels(dt, false);
  }
}

/** A part or wheel off the car: gravity, tumble, the world's walls, a floor at `floor` (m) and asphalt. */
function stepLoose(p: LooseBody, dt: number, floor: number, bounce?: WorldBounce): void {
  p.velocity.y -= 9.6 * dt;
  p.object.position.addScaledVector(p.velocity, dt);
  const spin = p.angular.length();
  if (spin > 1e-5) {
    _n.copy(p.angular).multiplyScalar(1 / spin);
    _qSpin.setFromAxisAngle(_n, spin * dt);
    p.object.quaternion.premultiply(_qSpin);
  }
  p.angular.multiplyScalar(Math.pow(0.72, dt));
  bounce?.(p.object.position, p.velocity, Math.min(0.22, p.radius * 0.45));
  if (p.object.position.y < floor) {
    p.object.position.y = floor;
    if (p.velocity.y < 0) p.velocity.y *= -0.28;
  }
  if (p.object.position.y <= floor + GROUND_BAND) {
    // Sliding on asphalt: Coulomb friction per second, and the spin dies with the slide. The
    // band keeps the millimetre hops of the bounce in contact at any frame rate.
    const slide = Math.hypot(p.velocity.x, p.velocity.z);
    applyGroundFriction(p.velocity, dt, CRASH.muSlide, true);
    p.angular.multiplyScalar(slide > 1e-5 ? Math.hypot(p.velocity.x, p.velocity.z) / slide : 0);
  }
}

/** What `stepLoose` moves: a detached part, or a wheel off its hub. */
interface LooseBody {
  object: THREE.Object3D;
  velocity: THREE.Vector3;
  angular: THREE.Vector3;
  radius: number;
}

const _qSpin = new THREE.Quaternion();
const _push = new THREE.Vector3();
/** Height above its rest (m) at which a loose part still slides on the ground. */
const GROUND_BAND = 0.005;
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _v = new THREE.Vector3();
const _in = new THREE.Vector3();
const _inv = new THREE.Quaternion();
const _zero = new THREE.Vector3();
const _box = new THREE.Box3();
const _lampQ = new THREE.Quaternion();
