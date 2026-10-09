import { hypot2, detSin, detCos } from "../kernel/physics-core.js";
import * as THREE from "three";
import { TYRE_R } from "../deform/deform-state.ts";
import { DOOR } from "./car-mesh.ts";
import { LIGHT_BAR_FOOT } from "./car-materials.ts";
import { activeGround, NO_FLOOR } from "../world/ground.ts";
import { MASS_SPECS } from "../kernel/rig-spec.ts";
import { flutterShell, layFlat, makeShell, poseShell, recentre, setPrimer, shellBox } from "./car-panels.ts";
import { carClass, CLASSES } from "./vehicle-classes.ts";
import { applyDents } from "./loose-dent.ts";
import { stepLoose } from "./loose-step.ts";
import { CarGlass } from "./car-glass-break.ts";
import {
  BUMPER_TEAR_MPS,
  type DetachPart,
  DOOR_AJAR,
  DOOR_DAMP,
  DOOR_INERTIA,
  DOOR_OPEN_MAX,
  DOOR_TEAR_MPS,
  type DoorHinge,
  HINGE_TEAR_J,
  type Lamp,
  type PartNetState,
  SLAM_TEAR_J,
  type WorldBounce,
} from "./car-core.ts";
import {
  DOOR_ACC_MAX,
  DOOR_DRY,
  DOOR_QUIET_S,
  DOOR_YAW_ACC_MAX,
  flapAmp,
  flapRate,
  flapWave,
  PANEL_FRAGILE_T,
  PANEL_SMUSH_MIN,
  swingAccel,
  windWear,
} from "./car-wear.ts";
import { partState, PART_SLOTS } from "./part-state.ts";

/** A door's drawn angle (rad) per unit of crash hinge value (`hingeT`): the jam that holds a door ajar. */
const DOOR_JAM = 1.45;
const _push = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _box = new THREE.Box3();
const _lampQ = new THREE.Quaternion();
const _doorW = new THREE.Vector3();
const _c = new THREE.Vector3();
/**
 * Glass against its frame's strain (`cageStrain`, m): the windshield and rear glass read their own cage, side glass its
 * door's. Peaks measured over the standard crashes: an unloaded pane reads ≤ 0.055 (the far door of a 30–50 km/h side hit),
 * a loaded frame 0.088–0.20 (the struck door of a 50 km/h side hit 0.088, the windshield of a 35 km/h wall hit 0.107), a
 * collapsed one 0.266–0.43 (the windshield of a 56 km/h wall hit 0.266). Any load cracks a pane; tempered side and rear
 * glass bursts once its frame has clearly moved, the laminated windshield only once its frame has collapsed. Each bound
 * sits about 0.012 clear of the strains on either side of it.
 */
const GLASS_CRACK = 0.063;
const GLASS_TEMPERED = 0.075;
const GLASS_LAMINATED = 0.25;

/** Police light bar: shears off once the roof mass under it sinks this far (m below its rest height; a
 *  56 km/h frontal sinks it ~0.07), or on any hit at or above this EBS (60 km/h, arcade: a big crash throws
 *  it). Guessed, tuned by eye. (The roof sensor's compression is no measure: a 20 km/h frontal reads 0.36.) */
const BAR_TEAR_SINK = 0.12;
const BAR_TEAR_MPS = 60 / 3.6;
export const ROOF_REST_Y = MASS_SPECS.find((m) => m.name === "roof")!.rest[1];
/**
 * Quarter panels and arch flares hinge by the crush under them, `(crush - on) / range`, and tear off once the hinge value
 * passes `PANEL_TEAR` on a hit this fast (EBS). Tuned on the walls: the rear wing sensor peaks
 * 0.06 / 0.23 / 0.47 m on a 30 % offset rear hit at 40 / 56 / 80 km/h, the front one 0.57 / 0.92 / 1.0 m on an offset front hit
 * and 0.29 / 0.78 m on the side wall at 40 / 56.
 */
const PANEL_HINGE = { quarter: { on: 0.05, range: 0.45 }, arch: { on: 0.15, range: 0.5 } } as const;
const PANEL_TEAR = 0.8;
const PANEL_TEAR_MPS = 50 / 3.6;
/** A panel's shell stands from this hinge value. */
const PANEL_OPEN = 0.03;
/** A torn part rests this high (m, its origin) over what it lies on; a torn sheet this high (its centre). At most `LIVE_SHELLS` of a car's torn shells are drawn: the oldest vanish (each is a draw). */
const PART_FLOOR = 0.12;
const PANEL_FLOOR = 0.03;
const LIVE_SHELLS = 2;
/** The light bar's tilt on its far mount at full load (rad). */
const BAR_ROLL = 0.5;
/** A bumper hung by one corner rolls about it this much at full hinge and full asymmetry (rad), and sags this far (m). */
const BUMPER_ROLL = 0.6;
const BUMPER_SAG = 0.06;
/** A hinged part below this hinge value is not worn by the wind (a shell hardly standing). */
const WEAR_MIN_T = 0.04;
/** A contact is fresh when the last was over `TOUCH_GAP` s ago and the next lands within `TOUCH_NOW` s. */
const TOUCH_GAP = 0.15;
const TOUCH_NOW = 0.03;
/** A part hinged or swung no further than this (rad, or the hinge value) is still within a shadow texel of its rest (4.7 cm). */
const FLUSH_HINGE = 0.02;

/** The hinge value above which a part counts as folding (hung open, crushed, flapping), by hinge kind. */
function foldAt(p: DetachPart): number {
  if (p.hinge === "two-point") return p.bumper ? 0.04 : 0.08;
  if (p.hinge === "cowl" || p.hinge === "tail") return 0.06;
  if (p.hinge === "door") return 0.08;
  if (p.hinge === "bar") return 0.05;
  return p.region ? PANEL_OPEN : Infinity;
}

/** Back on the camera's layer 0 (`traverse` callback, one function for every tear). */
function showOnCamera(o: THREE.Object3D): void {
  o.layers.enable(0);
}

/**
 * Detachable parts: attached-part posing, door hinges and mirrors, glass following, breakage and detaching,
 * loose parts and wheels, and their netplay state.
 */
export abstract class CarParts extends CarGlass {
  /** The car's torn shells, oldest first. */
  private readonly liveShells: DetachPart[] = [];
  /** The flap clock (rad) turns with speed and shakes every hinged panel and bumper (`flapAngle`). Cosmetic: no rule reads it. */
  flapClock = 0;
  flapSpeed = 0;
  /** Seconds since the last contact, as of the last frame: tells a fresh touch from a continuing one (`evaluateBreakage`). */
  quietPrev = 0;
  /** The car's velocity (x, z) and yaw rate at the last door-swing sample: their change is the pendulum's drive. */
  readonly motion = new Float64Array(3);
  /** Pendulum drive, car frame: acceleration right, acceleration forward (m/s²), yaw rate (rad/s), yaw acceleration (rad/s²). */
  readonly swingDrive = new Float64Array(4);
  /**
   * Once a frame, with the skin: the hood, boot lid, doors and bumpers cast into the sun's shadow map (one draw each) only
   * when the car has been hit or a part has hinged, swung or come off. Until then they lie on the body's shell and the
   * body's shadow is theirs to within a texel row at the bumpers (`flush-casters.test.ts` measures it).
   */
  protected settleCasters(): void {
    let flush = !this.crashed;
    for (let i = 0; i < this.parts.length && flush; i++) {
      const p = this.parts[i]!;
      flush = !p.detached && p.hingeT <= FLUSH_HINGE && (p.swing === null || p.swing.theta <= FLUSH_HINGE);
    }
    for (let i = 0; i < this.flushCasters.length; i++) this.flushCasters[i]!.castShadow = !flush;
  }

  protected syncAttachedParts(dt: number): void {
    this.advanceFlap(dt);
    const ix = this.deform.impactInward.x;
    const iz = this.deform.impactInward.z;
    const parts = this.parts;
    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi]!;
      if (p.detached) continue;
      const left = this.deform.sensorCompression(p.attachL);
      const right = this.deform.sensorCompression(p.attachR);
      const crush = Math.max(left, right, this.deform.partCompression(p.cage));
      const local = Math.min(left, right);
      const onHit = this.partOnHit(p);

      let target = 0;
      if (p.mirror) {
        // C3: the mirror folds with the door skin under it (sensors 6/7 and 4/5), on its own side only.
        if (onHit) target = THREE.MathUtils.clamp((Math.max(left, right) - 0.04) / 0.3, 0, 1);
      } else if (p.hinge === "door") {
        const open = THREE.MathUtils.clamp((Math.max(local, crush) - 0.08) / 0.5, 0, 1);
        const endOn = !this.deform.bidirectional && Math.abs(ix) <= Math.abs(iz);
        if (onHit) target = open;
        else if (endOn && (crush > 0.16 || local > 0.12)) target = Math.min(open, DOOR_AJAR);
      } else if (p.hinge === "bar") {
        target = Math.min(this.barLoad(), 0.95);
      } else if (onHit) {
        if (p.hinge === "two-point") target = THREE.MathUtils.clamp((crush - 0.04) / 0.55, 0, 1);
        else if (p.hinge === "cowl") target = THREE.MathUtils.clamp((crush - 0.1) / 0.6, 0, 1);
        else if (p.hinge === "tail") target = THREE.MathUtils.clamp((crush - 0.1) / 0.6, 0, 1);
        else if (p.region) target = THREE.MathUtils.clamp((crush - PANEL_HINGE[p.region.kind].on) / PANEL_HINGE[p.region.kind].range, 0, 1);
      }
      p.hingeT = Math.min(p.hingeMax, Math.max(p.hingeT, Math.min(target, p.hingeT + Math.max(dt * 3.2, 0.012))));
      // `folding` is read by the net state and the recorder's keyframes at every step, so it is set here, not in the frame's pose.
      p.folding = p.hingeT > foldAt(p);
      if (p.hinge === "door" && onHit) this.springDoor(p);
    }
    this.partsDirty = true;
  }

  /**
   * Set when `syncAttachedParts` moved a part's state; `poseParts` (once per rendered frame, from `updateSkin`) writes the
   * poses. A pose is presentation only and a step is 1/240 s: writing it every step cost 10 % of a crowded crash race.
   */
  protected partsDirty = false;

  /** Every attached part posed from its current state, if a step moved any (`updateSkin`, before lamps, panels and glass follow). */
  protected poseParts(): void {
    if (!this.partsDirty) return;
    this.partsDirty = false;
    // A car reset since the step that set the flag has its parts back at rest: nothing to pose.
    if (!this.crashed) return;
    const parts = this.parts;
    for (let pi = 0; pi < parts.length; pi++) if (!parts[pi]!.detached) this.posePart(parts[pi]!);
  }

  /** Rest pose plus the hinge value `hingeT` (crash) and, on doors and mirrors, the free swing. */
  protected posePart(p: DetachPart): void {
    const t = p.hingeT;
    p.folding = t > foldAt(p);
    p.object.position.copy(p.restPos);
    p.object.quaternion.copy(p.restQuat);
    p.object.scale.set(1, 1, 1);

    if (p.hinge === "two-point") {
      if (p.bumper) {
        const fl = this.deform.massLocal(p.name === "bumperF" ? "bumperFL" : "bumperRL");
        const fr = this.deform.massLocal(p.name === "bumperF" ? "bumperFR" : "bumperRR");
        p.object.position.set((fl.x + fr.x) * 0.5, (fl.y + fr.y) * 0.5, (fl.z + fr.z) * 0.5);
        const span = Math.abs(fl.z - (p.name === "bumperF" ? 2.06 : -2.06));
        p.object.scale.set(1 + t * 0.04, Math.max(0.45, 1 - t * 0.28), Math.max(0.18, 1 - span * 0.45));
        // Hangs by the corner that took less: rolls about it, the struck end drops.
        const left = this.deform.sensorCompression(p.attachL);
        const right = this.deform.sensorCompression(p.attachR);
        const asym = THREE.MathUtils.clamp((left - right) / Math.max(left, right, 0.05), -1, 1);
        const roll = t * BUMPER_ROLL * asym + (asym < 0 ? -1 : 1) * this.flapAngle(p);
        const px = (asym < 0 ? -0.6 : 0.6) * p.object.scale.x;
        p.object.rotation.z = roll;
        p.object.position.x += px * (1 - detCos(roll));
        p.object.position.y -= px * detSin(roll) + t * BUMPER_SAG;
      } else {
        const side = p.name === "mirrorL" ? -1 : 1;
        p.object.rotation.z += side * t * 1.4;
        p.object.rotation.y = p.swing!.mirrorFold;
        p.object.position.y -= t * 0.12;
        p.object.position.x += side * t * 0.18;
      }
    } else if (p.hinge === "cowl") {
      p.object.position.z -= t * 0.08;
      p.object.position.y += t * 0.26;
      p.object.rotation.x = -t * 0.5;
    } else if (p.hinge === "tail") {
      p.object.position.z += t * 0.08;
      p.object.position.y += t * 0.22;
      p.object.rotation.x = t * 0.5;
    } else if (p.hinge === "door") {
      const sign = p.name === "doorL" ? -1 : 1;
      p.object.rotation.y = -sign * Math.max(t * DOOR_JAM, p.swing!.theta);
      p.object.position.x += sign * t * 0.06;
      p.object.updateWorldMatrix(true, false);
      _box.setFromObject(p.object);
      // Keep the door's bottom off the ground under it (not where there is none: off the fleet disc's rim).
      const g = p.object.getWorldPosition(_doorW);
      const gy = activeGround().heightAt(g.x, g.z, g.y);
      if (gy !== NO_FLOOR && _box.min.y < gy + 0.04) p.object.position.y += gy + 0.04 - _box.min.y;
    } else if (p.hinge === "bar") {
      // Tilts on its far mount, the struck side dropping.
      const dir = this.deform.impactInward.x < 0 ? -1 : 1;
      const roll = dir * t * BAR_ROLL;
      const px = dir * LIGHT_BAR_FOOT.x;
      p.object.rotation.z = roll;
      p.object.position.x += px * (1 - detCos(roll));
      p.object.position.y -= px * detSin(roll);
    } else if (p.region) {
      if (p.folding) {
        if (!p.open || p.hingeT !== p.posed) this.shellPose(p);
        const a = this.flapAngle(p);
        if (a > 0) flutterShell(p.region, p.object, a);
      } else if (p.open) this.closePanel(p);
    }
  }

  /** Door hinge state; `side` −1 is the left door, +1 the right. */
  doorHinge(side: number): DoorHinge {
    return this.doorParts[side < 0 ? 0 : 1]!.swing!;
  }

  /** Whether a door, mirror or quarter panel has left the car; a mirror rides off on its torn door. */
  partOff(name: "doorL" | "doorR" | "mirrorL" | "mirrorR" | "quarterL" | "quarterR"): boolean {
    const i = name.endsWith("L") ? 0 : 1;
    if (name.startsWith("quarter")) return this.quarterParts[i]!.detached;
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
    this.sampleMotion();
    this.posePart(p);
  }

  /** The angle (rad) door `side` is drawn open at: the free swing, or the crash's jam when that holds it further out; 0 once it is off. */
  doorAngle(side: number): number {
    const p = this.doorParts[side < 0 ? 0 : 1]!;
    return p.detached ? 0 : Math.max(p.hingeT * DOOR_JAM, p.swing!.theta);
  }

  /**
   * A fixed solid shuts door `side` to `angle` (rad) at closing rate `rate` (rad/s): the door swings in to it, latching at 0, and
   * a slam past `SLAM_TEAR_J` wrenches it off (`closeDoor`). A door the crash jammed open past `angle` cannot shut: the solid
   * tears it off. True if it tore off.
   */
  shutDoor(side: number, angle: number, rate: number): boolean {
    const p = this.doorParts[side < 0 ? 0 : 1]!;
    if (p.detached) return false;
    if (p.hingeT * DOOR_JAM > angle) {
      this.detachPart(p, 0, _push.set(side * 1.2, 0.6, 0));
      return true;
    }
    p.swing!.omega = -rate;
    const tore = this.closeDoor(p, side, angle);
    if (!tore) this.posePart(p);
    return tore;
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

  /**
   * Free door swing: the car's acceleration drives the pendulum (`swingAccel`), hinge friction damps it, and it ends on the
   * check-strap stop, on the crash jam (`hingeT`) or in the latch (`closeDoor`: the ram's shut scene and the car's own swing alike).
   */
  swingDoors(dt: number): void {
    this.sampleDrive(dt);
    const d = this.swingDrive;
    for (let i = 0; i < 2; i++) {
      const p = this.doorParts[i]!;
      if (p.detached) continue;
      const h = p.swing!;
      const sign = i === 0 ? -1 : 1;
      if (!h.latched) {
        // A door the crash jammed open never shuts past its jam.
        const jam = Math.min(p.hingeT * DOOR_JAM, DOOR_OPEN_MAX);
        h.omega += swingAccel(sign, h.theta, d[0]!, d[1]!, d[2]!, d[3]!) * dt;
        const dry = DOOR_DRY * dt;
        h.omega = Math.abs(h.omega) <= dry ? 0 : h.omega - Math.sign(h.omega) * dry;
        h.theta += h.omega * dt;
        h.omega *= Math.exp(-DOOR_DAMP * dt);
        if (h.theta >= DOOR_OPEN_MAX && h.omega > 0) {
          h.theta = DOOR_OPEN_MAX;
          // The trailing edge's velocity is what the strap stops.
          _push.set(sign * detCos(h.theta), 0, detSin(h.theta)).multiplyScalar(h.omega * DOOR.length);
          const e = 0.5 * DOOR_INERTIA * h.omega * h.omega;
          // The strap's detent holds it on the stop.
          h.omega = 0;
          if (this.loadDoorStop(sign, e, _push)) continue;
        } else if (h.theta <= jam && h.omega < 0) {
          if (this.closeDoor(p, sign, jam)) continue;
        } else if (h.theta < jam) h.theta = jam;
      }
      this.posePart(p);
      const m = this.mirrorParts[i]!;
      if (!m.detached) this.posePart(m);
    }
  }

  /**
   * A door swung into its frame at closing rate ω < 0: the latch takes it at `jam` 0 (a crash jam above stops it there), or past
   * `SLAM_TEAR_J` it is wrenched off. True if it tore off.
   */
  private closeDoor(p: DetachPart, sign: number, jam: number): boolean {
    const h = p.swing!;
    h.theta = jam;
    if (0.5 * DOOR_INERTIA * h.omega * h.omega >= SLAM_TEAR_J) {
      // Wrenched out of its hinges against the frame: it leaves outward and rearward at its centre's swing speed.
      _push.set(sign * 1.2, 0.6, 0.5 * DOOR.length * h.omega);
      this.detachPart(p, 0, _push);
      return true;
    }
    h.omega = 0;
    h.latched = jam === 0;
    return false;
  }

  /** A door a side hit has opened past `DOOR_AJAR` is off its latch: it hangs at least as far open as the crash jam (`hingeT`) and swings with the car. */
  private springDoor(p: DetachPart): void {
    const h = p.swing!;
    if (h.latched) {
      if (p.hingeT <= DOOR_AJAR) return;
      h.latched = false;
      h.omega = 0;
      this.sampleMotion();
    }
    h.theta = Math.max(h.theta, Math.min(p.hingeT * DOOR_JAM, DOOR_OPEN_MAX));
  }

  /** Remember the car's velocity and yaw rate: the next `sampleDrive` reads their change as acceleration. Call after setting either by hand. */
  sampleMotion(): void {
    this.motion[0] = this.velocity.x;
    this.motion[1] = this.velocity.z;
    this.motion[2] = this.angular.y;
  }

  /** The car-frame acceleration since the last sample, capped (`DOOR_ACC_MAX`), into `swingDrive`; zero while the car is in contact (the crash rules own that moment). */
  private sampleDrive(dt: number): void {
    const m = this.motion;
    const inv = dt > 0 ? 1 / dt : 0;
    const ax = (this.velocity.x - m[0]!) * inv;
    const az = (this.velocity.z - m[1]!) * inv;
    const d = this.swingDrive;
    const free = this.deform.quietTime() > DOOR_QUIET_S;
    d[0] = free ? THREE.MathUtils.clamp(ax * this.rightFlat.x + az * this.rightFlat.z, -DOOR_ACC_MAX, DOOR_ACC_MAX) : 0;
    d[1] = free ? THREE.MathUtils.clamp(ax * this.fwdFlat.x + az * this.fwdFlat.z, -DOOR_ACC_MAX, DOOR_ACC_MAX) : 0;
    d[2] = free ? this.angular.y : 0;
    d[3] = free ? THREE.MathUtils.clamp((this.angular.y - m[2]!) * inv, -DOOR_YAW_ACC_MAX, DOOR_YAW_ACC_MAX) : 0;
    this.sampleMotion();
  }

  /** The flap clock turns with the car's ground speed. */
  private advanceFlap(dt: number): void {
    this.flapSpeed = hypot2(this.velocity.x, this.velocity.z);
    this.flapClock += flapRate(this.flapSpeed) * dt;
  }

  /** A fresh car's flutter, contact timing and door motion sample (`resetVisual`): a reused car replays as a new one. */
  protected resetWear(): void {
    this.flapClock = 0;
    this.flapSpeed = 0;
    this.quietPrev = 0;
    this.sampleMotion();
  }

  /** The contact timing and door motion sample of a car whose state was just written (`writeNetState`): the next frame reads them as a continuing one. */
  protected restoreWear(): void {
    this.quietPrev = this.deform.quietTime();
    this.sampleMotion();
  }

  /** Flutter of `p` now (rad, ≥ 0): 0 at rest and for a part not hinged; each part beats at its own phase (its rest spot's). */
  private flapAngle(p: DetachPart): number {
    const a = flapAmp(this.flapSpeed, p.hingeT);
    return a > 0 ? a * flapWave(this.flapClock + p.restPos.x * 13.1 + p.restPos.z * 7.7) : 0;
  }

  /** Netplay client, every frame: the flap clock turns with the car's speed and hinged panels and bumpers are re-posed with it. */
  flutterParts(dt: number): void {
    this.advanceFlap(dt);
    const parts = this.parts;
    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi]!;
      if (p.folding && !p.detached && (p.region || p.bumper)) this.posePart(p);
    }
  }

  /** The quarter panel on `side` (−1 left, +1 right), on the car or not. */
  quarterPanel(side: number): DetachPart {
    return this.quarterParts[side < 0 ? 0 : 1]!;
  }

  /**
   * A striker moves the quarter panel to hinge value `t`: pushed back onto the body it stays dented (`hingeMax`, and never
   * flat: `PANEL_SMUSH_MIN`), pushed out it opens up to full hinge.
   */
  bendPanel(side: number, t: number): void {
    const p = this.quarterPanel(side);
    if (p.detached) return;
    const to = THREE.MathUtils.clamp(t, Math.min(PANEL_SMUSH_MIN, p.hingeT), 1);
    if (to < p.hingeT) p.hingeMax = to;
    p.hingeT = to;
    this.posePart(p);
  }

  /** Hinge a quarter panel to `t` with no crash (the Doors scene's start), whole again. */
  setPanelOpen(side: number, t: number): void {
    const p = this.quarterPanel(side);
    if (p.detached) return;
    p.hingeMax = 1;
    p.fatigue = 0;
    p.hingeT = THREE.MathUtils.clamp(t, 0, 1);
    this.posePart(p);
  }

  /** A striker tears the quarter panel off with `push` (car-space m/s on top of the car's velocity). */
  ripPanel(side: number, push: THREE.Vector3): void {
    this.detachPart(this.quarterPanel(side), 0, push);
  }

  protected fitInterior(): void {
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

  /** Whether any pane could still crack or shatter: its rule reads the cages' strain, so the steps solve the cages for it. */
  protected glassLeft(): boolean {
    for (let k = 0; k < this.glassPanes.length; k++) if (this.glassPanes[k]!.state !== "shattered") return true;
    return false;
  }

  /** Once a frame on a crashed car (`updateSkin`, after the skin): the parts' poses a step left pending are written first, door glass rides its door. */
  protected followGlass(): void {
    this.poseParts();
    const inward = this.deform.impactInward;
    for (let k = 0; k < this.glassPanes.length; k++) {
      const g = this.glassPanes[k]!;
      if (g.state === "shattered" || g.skin) continue;
      const onDoor = g.parts.includes("doorLeft") || g.parts.includes("doorRight");
      if (onDoor) continue;
      let nearby = 0;
      for (let q = 0; q < g.parts.length; q++) nearby = Math.max(nearby, this.deform.partCompression(g.parts[q]!));
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

  protected evaluateBreakage(impulse: number, dt: number): void {
    for (let k = 0; k < this.glassPanes.length; k++) {
      const g = this.glassPanes[k]!;
      if (g.state === "shattered") continue;
      const strain = this.deform.cageStrain(g.skin ?? (g.parts.includes("doorLeft") ? "doorLeft" : "doorRight"));
      if (g.state === "intact" && strain > GLASS_CRACK) this.crackGlass(g);
      if (strain > (g.skin === "glassFront" ? GLASS_LAMINATED : GLASS_TEMPERED)) this.shatterGlass(g);
    }

    const ebs = this.deform.hitSpeedValue;
    // Contact resumed after a pause is a fresh touch (a wall, a car, a prop: whatever feeds `notifyContact`).
    const quiet = this.deform.quietTime();
    const touched = quiet < TOUCH_NOW && this.quietPrev > TOUCH_GAP;
    this.quietPrev = quiet;
    const parts = this.parts;
    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi]!;
      if (p.detached) continue;
      if (p.hinge === "bar") {
        const sink = ROOF_REST_Y - this.deform.massLocal("roof").y;
        if (sink > BAR_TEAR_SINK || (ebs >= BAR_TEAR_MPS && this.deform.crushElapsed > 0.05)) this.detachPart(p, impulse);
        continue;
      }
      if ((p.region || p.bumper) && this.wornOff(p, dt, touched)) {
        this.detachPart(p, impulse);
        continue;
      }
      if (this.deform.bidirectional && p.hinge !== "door" && p.hinge !== "two-point") continue;
      if (!this.partOnHit(p)) continue;
      let should = false;
      if (p.mirror) should = p.hingeT > 0.5;
      else if (p.bumper) should = p.hingeT > 0.7 && ebs >= BUMPER_TEAR_MPS;
      else if (p.hinge === "cowl" || p.hinge === "tail") should = p.hingeT > 0.78;
      else if (p.hinge === "door") should = p.hingeT > 0.58 && (this.deform.bidirectional || ebs >= DOOR_TEAR_MPS);
      else if (p.region) should = p.hingeT > PANEL_TEAR && ebs >= PANEL_TEAR_MPS;
      if (should) this.detachPart(p, impulse);
    }

    for (let k = 0; k < this.lamps.length; k++) {
      const lamp = this.lamps[k]!;
      if (!lamp.intact) continue;
      let crush = 0;
      for (let q = 0; q < lamp.sensors.length; q++) crush = Math.max(crush, this.deform.sensorCompression(lamp.sensors[q]!));
      if (crush > 0.18 && this.deform.crushElapsed > 0.02) this.breakLamp(lamp);
    }
  }

  /**
   * What a hinged panel or bumper takes between hits (docs/PANEL_FLAP.md): a stretched (`PANEL_FRAGILE_T`) quarter panel or arch
   * flare goes on a fresh contact, a quarter panel also on a scrape of the ground (an arch flare's box includes the sill, which the body
   * sinks to the road on its own); a bumper never on contact timing (its hulls shape the crash, a replay could not reproduce it); any
   * hinged part goes in sustained speed (`windWear`). True once it is off.
   */
  private wornOff(p: DetachPart, dt: number, touched: boolean): boolean {
    if (p.hingeT <= WEAR_MIN_T) {
      p.fatigue = 0;
      return false;
    }
    if (p.hingeT >= PANEL_FRAGILE_T && p.region !== null && (touched || (p.hinge === "quarter" && this.scrapes(p)))) return true;
    p.fatigue = Math.max(0, p.fatigue + windWear(this.flapSpeed, p.hingeT) * dt);
    return p.fatigue >= 1;
  }

  /**
   * Whether the part's box reaches the ground under it. The panel's shell on the body's rest skin, bent to its hinge value,
   * carried by the car's pose: sim state only. The drawn shell (its skin's solve, the suspension's heave, its flutter) depends
   * on how often and where the car is drawn, and the replay of a crash drew at other times than the live sim did.
   */
  private scrapes(p: DetachPart): boolean {
    const lift = CLASSES[carClass(this)].lift; // the drawn body rides on the class's lift (`Car.ride`); the panel with it
    shellBox(p.region!, this.deform.restSkin, p.hingeT, this.group.position, this.group.quaternion, lift, _box).getCenter(_doorW);
    const g = activeGround().heightAt(_doorW.x, _doorW.z, _doorW.y);
    return g !== NO_FLOOR && _box.min.y < g;
  }

  /** Out for good until the next reset; `LampBatch` draws it dark. */
  protected breakLamp(lamp: Lamp): void {
    lamp.intact = false;
  }

  /** Hand a part to the world. `push` (car-space m/s on top of the car's velocity) replaces the
   *  crash launch: outward from the body by `impulse`, popped up by `hingeT`. */
  protected detachPart(p: DetachPart, impulse: number, push?: THREE.Vector3): void {
    if (p.detached) return;
    // The part leaves in the pose its state gives now, not the last frame's (poses are written once a frame, `poseParts`; a door
    // torn off by `swingDoors` finds none pending).
    this.posePart(p);
    p.detached = true;
    this.group.updateMatrixWorld();
    const wpos = new THREE.Vector3();
    const wquat = new THREE.Quaternion();
    if (p.region) this.openPanel(p);
    p.object.getWorldPosition(wpos);
    p.object.getWorldQuaternion(wquat);
    if (p.region) {
      // The shell tumbles about its middle, not the rest origin.
      recentre((p.object as THREE.Mesh).geometry, _c);
      wpos.add(_c.applyQuaternion(wquat));
    }
    this.group.remove(p.object);
    this.world.add(p.object);
    // Loose, the part is the world's, not the car's: the distance detail's cuts (`CarDetail`) took its meshes off the camera while it was on the car.
    p.object.traverse(showOnCamera);
    if (p.region) this.trackShell(p);
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
    // A fixed hash of the part and the hit, not Math.random: a replay throws it the same way, so its dents land the same.
    const hash = (k: number): number => {
      const s = detSin((this.parts.indexOf(p) + 1) * 12.9898 + k * 78.233 + impulse * 0.37) * 43758.5453;
      return s - Math.floor(s) - 0.5;
    };
    p.angular.set(hash(1) * 6, hash(2) * 5, hash(3) * 6);
    if (p.hinge === "door") p.angular.y += (p.name === "doorL" ? -1 : 1) * (3.2 + p.hingeT * 2.4);
    else if (p.hinge === "cowl") p.angular.x -= 3.4;
    else if (p.hinge === "tail") p.angular.x += 3.4;
  }

  /** 0 to 1 and over: how near the roof's sinking, or a hit this fast, is to shearing the light bar's mounts (`evaluateBreakage` tears it at 1). */
  private barLoad(): number {
    return Math.max((ROOF_REST_Y - this.deform.massLocal("roof").y) / BAR_TEAR_SINK, this.deform.hitSpeedValue / BAR_TEAR_MPS);
  }

  /** A panel's shell, built if need be and bent to its hinge value on the current skin. */
  protected shellPose(p: DetachPart): void {
    this.openPanel(p);
    poseShell(p.region!, (p.object as THREE.Mesh).geometry, this.body.geometry, p.hingeT, detSin(this.deform.crushElapsed * 22));
    p.posed = p.hingeT;
  }

  /** Netplay client: the host tore this panel off. Its shell as it hung (on this client's skin), centred as the host's is; the host's pose follows. */
  protected tearPanel(p: DetachPart): void {
    this.shellPose(p);
    recentre((p.object as THREE.Mesh).geometry, _c);
    this.trackShell(p);
  }

  /** A torn shell counts against the car's cap: past `LIVE_SHELLS` the oldest stops being drawn. */
  private trackShell(p: DetachPart): void {
    this.liveShells.push(p);
    if (this.liveShells.length > LIVE_SHELLS) this.liveShells.shift()!.object.visible = false;
  }

  /** First hinge or tear: the panel's shell joins the car (in the body's own frame: class lift, suspension pose) and its patch of body turns to primer. */
  protected openPanel(p: DetachPart): void {
    if (p.open) return;
    p.open = true;
    const mesh = p.object as THREE.Mesh;
    if (!mesh.geometry.getAttribute("position")) mesh.geometry = makeShell(p.region!, this.body.geometry);
    setPrimer(p.region!, this.body.geometry, true);
    this.body.parent!.add(mesh);
  }

  /** The panel is back on the car (reset): the shell leaves the scene and the body is paint again. */
  protected closePanel(p: DetachPart): void {
    p.open = false;
    p.object.visible = true;
    p.object.removeFromParent();
    const at = this.liveShells.indexOf(p);
    if (at >= 0) this.liveShells.splice(at, 1);
    setPrimer(p.region!, this.body.geometry, false);
  }

  /** This car's torn parts and popped wheels (`stepLoose`): they land on the ground and the other cars' tops, never this car's (`slot`). */
  protected stepLooseParts(dt: number, slot: number, bounce?: WorldBounce): void {
    for (let k = 0; k < this.parts.length; k++) {
      const p = this.parts[k]!;
      // A torn shell past `LIVE_SHELLS` is hidden for good (until the reset): nothing to see, nothing to move.
      if (!p.detached || !p.object.visible) continue;
      const clearance = stepLoose(p, dt, p.region ? PANEL_FLOOR : PART_FLOOR, slot, bounce, p.dent);
      if (p.region && clearance < 0.3) layFlat(p.object, dt);
      applyDents(p.dent, p.object);
    }
    for (let k = 0; k < this.looseWheels.length; k++) if (this.looseWheels[k]!.loose) stepLoose(this.looseWheels[k]!, dt, TYRE_R, slot, bounce);
  }

  /** Into `out` from index `n` on: the objects this car has put in the world instead of on its group, torn parts and popped wheels (`stepLooseParts` moves them). Returns the count past the last one written. */
  freeObjects(out: THREE.Object3D[], n: number): number {
    for (let k = 0; k < this.parts.length; k++) if (this.parts[k]!.detached && this.parts[k]!.object.visible) out[n++] = this.parts[k]!.object;
    for (let k = 0; k < this.looseWheels.length; k++) if (this.looseWheels[k]!.loose) out[n++] = this.looseWheels[k]!.object;
    return n;
  }

  /** A popped hub's wheel leaves the car: a world object launched at the hub's speed, out and up. */
  protected dropWheel(i: number, hub: string): void {
    const w = this.looseWheels[i]!;
    w.loose = true;
    this.group.updateMatrixWorld();
    w.object.getWorldQuaternion(_lampQ);
    this.group.remove(w.object);
    this.world.add(w.object);
    w.object.position.copy(this.deform.massWorld(hub));
    w.object.quaternion.copy(_lampQ);
    _p.copy(w.object.position).sub(this.group.position).setY(0);
    if (_p.lengthSq() > 1e-6) _p.normalize();
    w.velocity.copy(this.deform.massVel(hub)).addScaledVector(_p, 1.2);
    w.velocity.y = Math.max(w.velocity.y, 0) + 1;
    // Rolls on about its axle (the car's x) at the hub's ground speed.
    _n.set(1, 0, 0).applyQuaternion(this.group.quaternion);
    w.angular.copy(_n).multiplyScalar(hypot2(w.velocity.x, w.velocity.z) / TYRE_R);
  }

  /** Netplay: array sizes for a `PartNetState`; parts are `PART_SLOTS` on every style (one shared layout). */
  partNetSizes(): { parts: number; lamps: number; glass: number; wheels: number } {
    return { parts: PART_SLOTS, lamps: this.lamps.length, glass: this.glassPanes.length, wheels: this.wheels.length };
  }

  /** Netplay host: part, lamp and glass state, and each loose part's world pose. */
  readPartNetState(out: PartNetState): void {
    out.flags.fill(0, this.parts.length);
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i]!;
      const s = p.swing;
      out.flags[i] = (p.detached ? 1 : 0) | (p.folding ? 2 : 0) | (s?.latched ? 4 : 0);
      out.hinge[i * 3] = p.hingeT;
      // Parts with no swing leave slots 1 and 2 free: they carry the host's wind wear and dent cap (`1 − hingeMax`, so 0 is "uncapped"
      // and old data reads as before), which a headless replay re-simulating from a keyframe needs to tear the same parts at the same time.
      out.hinge[i * 3 + 1] = s ? s.theta : p.fatigue;
      out.hinge[i * 3 + 2] = s ? s.mirrorFold : 1 - p.hingeMax;
      if (!p.detached) continue;
      p.object.position.toArray(out.pose, i * 7);
      p.object.quaternion.toArray(out.pose, i * 7 + 3);
    }
    let lamps = 0;
    for (let i = 0; i < this.lamps.length; i++) if (this.lamps[i]!.intact) lamps |= 1 << i;
    out.lamps = lamps;
    out.glass = this.glassBits();
    let wheels = 0;
    for (let i = 0; i < this.wheels.length; i++) {
      if (!this.looseWheels[i]!.loose) continue;
      wheels |= 1 << i;
      this.wheels[i]!.position.toArray(out.wheels, i * 7);
      this.wheels[i]!.quaternion.toArray(out.wheels, i * 7 + 3);
    }
    out.wheelLoose = wheels;
  }

  /** A part is off the car (a torn mirror, panel or bumper): its net state rides a highlight keyframe even if the car is no wreck. */
  hasLoosePart(): boolean {
    for (let i = 0; i < this.parts.length; i++) if (this.parts[i]!.detached) return true;
    return false;
  }

  /** The parts' sim state as doubles (`part-state.ts`): the replay keyframe's. */
  partState(buf: Float64Array, write: boolean): void {
    partState(this, this.parts, buf, write);
  }

}
