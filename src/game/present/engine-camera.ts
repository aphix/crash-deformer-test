import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { DRIVE, type DriverSeat, type SeatView } from "../vehicle/car-drive.ts";
import type { PadState } from "../vehicle/gamepad.ts";
import { DISC_RADIUS } from "../world/ground.ts";
import { wrapPiClosed } from "../kernel/scalar.ts";
import { CineCam, DutchCam, type Sight } from "./spectate-cam.ts";

/**
 * A followed (not driven) car's camera, cycled by View: the drive chase views, the trackside cinematic ("cine"),
 * the wheel-well dutch ("dutch") and the free orbit. A race opens on the chase, everything else on the orbit.
 */
export type SpecView = SeatView | "cine" | "dutch" | "orbit";
const SPEC_VIEWS: readonly SpecView[] = ["third", "far", "first", "cine", "dutch", "orbit"];

/** What the cinematic and dutch cams read from the scene, only when they pick a shot. */
export type SpecScene = { sight(): Sight; rivals(): readonly DeformableCar[] };

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _e = new THREE.Vector3();
const _t = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
/** `watchFall`: the eye stands this far (m) inside the fleet disc's rim, at shoulder height (m) over the disc. */
const FALL_EYE_IN = 1.5;
const FALL_EYE_Y = 1.5;

/** Mean position of the cars still on the disc (falling and vaporized ones skipped; zero for an empty fleet). */
export function centroid(out: THREE.Vector3, cars: readonly DeformableCar[]): THREE.Vector3 {
  out.set(0, 0, 0);
  let n = 0;
  for (const car of cars) {
    if (car.falling || car.vaporized) continue;
    out.add(car.group.position);
    n++;
  }
  return n === 0 ? out : out.multiplyScalar(1 / n);
}

/** Critically damped spring, exact for any dt: no overshoot, ~98% settled after 6/omega s. */
class Spring {
  x = 0;
  v = 0;

  step(target: number, omega: number, dt: number): number {
    const e = this.x - target;
    const t = (this.v + omega * e) * dt;
    const k = Math.exp(-omega * dt);
    this.v = (this.v - omega * t) * k;
    this.x = target + (e + t) * k;
    return this.x;
  }

  snap(x: number): void {
    this.x = x;
    this.v = 0;
  }
}

/** Vector critically damped spring; `v` is relative to whatever frame the caller carries `x` in. */
class Spring3 {
  readonly x = new THREE.Vector3();
  readonly v = new THREE.Vector3();

  step(target: THREE.Vector3, omega: number, dt: number): void {
    const k = Math.exp(-omega * dt);
    _e.subVectors(this.x, target);
    _t.copy(this.v).addScaledVector(_e, omega).multiplyScalar(dt);
    this.v.addScaledVector(_t, -omega).multiplyScalar(k);
    this.x.copy(target).addScaledVector(_e.add(_t), k);
  }

  snap(x: THREE.Vector3): void {
    this.x.copy(x);
    this.v.set(0, 0, 0);
  }
}

export const CHASE = {
  third: { dist: 6.2, height: 2.0, aimUp: 1.0 },
  far: { dist: 10, height: 3.3, aimUp: 1.15 },
  /** Hood-cam eye in car space: over the bonnet, ahead of the windshield (the tinted glass reads opaque from inside). */
  eye: { x: 0, y: 1.02, z: 1.15 },
  /** Spring stiffness (1/s); the chase moves with the car's travel, so these only shape lag on turns, looks and blends. */
  posOmega: 9,
  aimOmega: 14,
  headOmega: 7,
  eyeOmega: 24,
  /** Look offsets ease back behind the car `lookDelay` s after the last mouse drag; a released stick returns at once. */
  lookDelay: 0.8,
  lookOmega: 5,
  stickOmega: 11,
  /** Right stick full deflection looks this far round (rad). */
  stickYaw: 2.35,
  stickPitch: 0.5,
  /** Extra chase distance per m/s, and the aim lead along the nose (s of forward speed). */
  pullback: 0.05,
  ahead: 0.14,
  fov: 56,
  fovSpeed: 12,
  fovFirst: 72,
  /** Lowest camera height (m) so a looked-down chase never clips into the floor. */
  floor: 0.45,
  /** A frame-to-frame car jump past this (m) is a respawn: cut instead of swooping. */
  cut: 8,
};

/**
 * Chase / far chase / hood-cam rig for a driven car. Heading follows the car's
 * body (not its velocity, so reversing never swings the camera round), on a
 * critically damped spring for the swing-out on turns and to absorb yaw jolts
 * in a crash; position and aim move with the car's travel and spring onto their
 * offsets, so the car never trails at speed or jitters against the camera.
 */
export class DriveCam {
  private readonly pos = new Spring3();
  private readonly aim = new Spring3();
  private readonly heading = new Spring();
  private readonly lookYaw = new Spring();
  private readonly lookPitch = new Spring();
  private idle = 10;
  private returnOmega: number = CHASE.lookOmega;
  /** The look offset came from a drag (not the stick), so a spectator's `keep` holds it. */
  private dragged = false;
  private car: DeformableCar | null = null;
  private readonly lastCarPos = new THREE.Vector3();

  /** Look offset from behind the car (rad, + = looking left). */
  get look(): number {
    return this.lookYaw.x;
  }

  /** Mouse drag (px): drag right looks right, drag down looks down; eases back after `lookDelay` unless `update` keeps it. */
  nudge(dx: number, dy: number): void {
    this.lookYaw.snap(wrapPiClosed(this.lookYaw.x - dx * 0.005));
    this.lookPitch.snap(THREE.MathUtils.clamp(this.lookPitch.x + dy * 0.004, -0.35, 0.9));
    this.idle = 0;
    this.returnOmega = CHASE.lookOmega;
    this.dragged = true;
  }

  /** Stop tracking; the next `update` blends in from wherever the camera is. */
  release(): boolean {
    const was = this.car !== null;
    this.car = null;
    return was;
  }

  /** `rx`/`ry`: right stick after deadzone, DOM signs (+x right, +y down). `keep`: a dragged look offset stays put (spectating). */
  update(camera: THREE.PerspectiveCamera, car: DeformableCar, view: SeatView, dt: number, rx: number, ry: number, keep = false): void {
    const p = car.group.position;
    const fwd = car.fwdFlat;
    const vel = car.velocity;
    const along = vel.x * fwd.x + vel.z * fwd.z;
    let yawT = Math.atan2(fwd.x, fwd.z);
    if (along > 3 && view !== "first") {
      // Look a little into a slide.
      yawT += THREE.MathUtils.clamp(wrapPiClosed(Math.atan2(vel.x, vel.z) - yawT), -0.5, 0.5) * 0.4;
    }

    const enter = this.car !== car;
    const cut = enter || this.lastCarPos.distanceToSquared(p) > CHASE.cut * CHASE.cut;
    // The car's actual travel this frame (exact on arcs and uneven frames, unlike velocity × dt).
    const moveX = p.x - this.lastCarPos.x;
    const moveZ = p.z - this.lastCarPos.z;
    this.car = car;
    this.lastCarPos.copy(p);
    if (cut) this.heading.snap(yawT);
    else this.heading.step(this.heading.x + wrapPiClosed(yawT - this.heading.x), view === "first" ? CHASE.eyeOmega : CHASE.headOmega, dt);

    if (rx !== 0 || ry !== 0) {
      this.lookYaw.step(-rx * CHASE.stickYaw, CHASE.stickOmega, dt);
      this.lookPitch.step(ry * CHASE.stickPitch, CHASE.stickOmega, dt);
      this.idle = CHASE.lookDelay;
      this.returnOmega = CHASE.stickOmega;
      this.dragged = false;
    } else {
      this.idle += dt;
      if (this.idle > CHASE.lookDelay && !(keep && this.dragged)) {
        this.lookYaw.step(0, this.returnOmega, dt);
        this.lookPitch.step(0, this.returnOmega, dt);
      }
    }

    const yaw = this.heading.x + this.lookYaw.x;
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);
    if (view === "first") {
      const eye = car.group.localToWorld(_v.set(CHASE.eye.x, CHASE.eye.y, CHASE.eye.z));
      const pt = this.lookPitch.x + 0.05;
      const cp = Math.cos(pt);
      _w.set(eye.x + sy * cp * 10, eye.y - Math.sin(pt) * 10, eye.z + cy * cp * 10);
      this.pos.snap(eye);
      this.aim.snap(_w);
    } else {
      const c = view === "far" ? CHASE.far : CHASE.third;
      const dist = c.dist + Math.min(Math.abs(along), 30) * CHASE.pullback;
      const r = Math.hypot(dist, c.height);
      const elev = THREE.MathUtils.clamp(Math.atan2(c.height, dist) + this.lookPitch.x, 0.02, 1.25);
      const flat = r * Math.cos(elev);
      _v.set(p.x - sy * flat, p.y + r * Math.sin(elev), p.z - cy * flat);
      const lead = THREE.MathUtils.clamp(along * CHASE.ahead, -0.5, 2.5);
      _w.set(p.x + fwd.x * lead, p.y + c.aimUp, p.z + fwd.z * lead);
      if (enter) {
        // Blend in from the current shot (orbit, another car, or the hood cam).
        this.pos.snap(camera.position);
        camera.getWorldDirection(_e);
        this.aim.snap(_e.multiplyScalar(camera.position.distanceTo(p)).add(camera.position));
      } else if (cut) {
        this.pos.snap(_v);
        this.aim.snap(_w);
      } else {
        this.pos.x.x += moveX;
        this.pos.x.z += moveZ;
        this.aim.x.x += moveX;
        this.aim.x.z += moveZ;
      }
      this.pos.step(_v, CHASE.posOmega, dt);
      this.aim.step(_w, CHASE.aimOmega, dt);
      if (this.pos.x.y < CHASE.floor) {
        this.pos.x.y = CHASE.floor;
        if (this.pos.v.y < 0) this.pos.v.y = 0;
      }
    }
    camera.position.copy(this.pos.x);
    camera.lookAt(this.aim.x);

    const fov =
      view === "first" ? CHASE.fovFirst : CHASE.fov + CHASE.fovSpeed * Math.min(1.4, Math.max(0, along) / DRIVE.maxFwd);
    easeFov(camera, fov, dt);
  }
}

function easeFov(camera: THREE.PerspectiveCamera, fov: number, dt: number): void {
  const d = fov - camera.fov;
  if (Math.abs(d) < 0.01) return;
  camera.fov += d * (1 - Math.exp(-3 * dt));
  camera.updateProjectionMatrix();
}

/**
 * Orbit / chase / first-person rig over the shared PerspectiveCamera, plus canvas pointer input:
 * left-drag orbits (or looks round the driven or spectated car), wheel zooms, a short tap picks via `onClick`.
 * The right stick orbits too (looks round while driving or spectating).
 */
export class ChaseCamera {
  /** Smoothed-toward eye position. */
  readonly pos = new THREE.Vector3(10, 6, 16);
  /** Look-at target; the engine aims it each frame before `orbit`. */
  readonly look = new THREE.Vector3();
  /** Screen-shake energy, decays in the engine tick. */
  trauma = 0;
  /** User dragged or zoomed since the last reset; cinematics stop re-aiming. */
  userFramed = false;
  readonly drive = new DriveCam();
  readonly cine = new CineCam();
  readonly dutch = new DutchCam();
  /** The followed car's cam; null = the scene's own (`specView`). */
  spec: SpecView | null = null;
  /** What framed the last frame, so a drag knows what to move: the orbit, a chase rig's look, or nothing (cine, dutch). */
  private rig: "orbit" | "chase" | "fixed" = "orbit";
  private readonly baseFov: number;
  private angle = 0;
  private radius = 14;
  private pitch = 0.4;
  private dragging = false;
  private lookDragging = false;
  /** Watching a car fall off the fleet disc (`watchFall`): the eye it settles at and the eased aim. */
  private fallWatch = false;
  private readonly fallEye = new THREE.Vector3();
  private readonly fallAim = new THREE.Vector3();
  private pointerTravel = 0;
  private lastX = 0;
  private lastY = 0;
  private readonly approachSide = new THREE.Vector3(1, 0, 0);

  readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly seat: DriverSeat;
  private readonly pad: PadState;
  private readonly reduceMotion: boolean;
  private readonly onClick: (clientX: number, clientY: number) => void;

  constructor(
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
    seat: DriverSeat,
    pad: PadState,
    reduceMotion: boolean,
    onClick: (clientX: number, clientY: number) => void,
  ) {
    this.camera = camera;
    this.canvas = canvas;
    this.seat = seat;
    this.pad = pad;
    this.reduceMotion = reduceMotion;
    this.onClick = onClick;
    camera.position.copy(this.pos);
    this.baseFov = camera.fov;
  }

  attach(): void {
    this.canvas.style.touchAction = "none";
    this.canvas.style.cursor = "grab";
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  detach(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
  }

  /** Orbit bearing (rad, atan2(x, z) about `look`, unwrapped); auto-rotate increases it. */
  get bearing(): number {
    return this.angle;
  }

  /** Snap to the opening shot: a fixed solo-rig angle (`soloAngle`), or broadside to the fleet's approach line. */
  frameReset(compactor: boolean, cars: readonly DeformableCar[], soloAngle = 0.85): void {
    this.userFramed = false;
    this.trauma = 0;
    if (compactor) {
      this.look.set(0, 0.55, 0);
      this.radius = 9.4;
      this.pitch = 0.44;
      this.angle = soloAngle;
      const cp = Math.cos(this.pitch);
      this.pos.set(
        Math.sin(this.angle) * this.radius * cp,
        this.look.y + this.radius * Math.sin(this.pitch),
        Math.cos(this.angle) * this.radius * cp,
      );
    } else {
      if (cars.length >= 2) {
        _w.copy(cars[1]!.group.position).sub(cars[0]!.group.position).normalize();
      } else {
        _w.copy(cars[0]?.forward ?? _w.set(0, 0, 1));
      }
      this.approachSide.crossVectors(_w, _up).normalize();
      if (this.approachSide.lengthSq() < 0.1) this.approachSide.set(1, 0, 0);
      this.placeApproach(cars);
    }
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    this.adoptPose();
  }

  /** Impact hit: shake, and unless the user framed the shot, orbit from where the camera is now. */
  kick(carCount: number): void {
    this.trauma = this.reduceMotion ? 0 : 0.85;
    if (!this.userFramed) {
      this.angle = Math.atan2(this.camera.position.x - this.look.x, this.camera.position.z - this.look.z);
      this.radius = THREE.MathUtils.clamp(this.radius + Math.max(0, carCount - 2) * 0.4, 8, 22);
    }
  }

  /** Ease toward the orbit around `look`; `spinRate` rad/s auto-rotates unless dragging or reduced motion. */
  orbit(wallDt: number, spinRate: number, shake: boolean): void {
    this.fallWatch = false;
    // Leaving the driver's seat or a fixed spectator cam: keep orbiting from where the camera was (from the wheel
    // cam's 2 m, at a normal orbit's distance and height).
    const fixed = this.rig === "fixed";
    if (this.drive.release() || fixed) this.adoptPose();
    if (fixed) {
      this.radius = Math.max(this.radius, 9);
      this.pitch = Math.max(this.pitch, 0.3);
    }
    this.rig = "orbit";
    const rx = this.pad.rx;
    const ry = this.pad.ry;
    const padTurn = rx !== 0 || ry !== 0;
    if (padTurn) {
      this.angle -= rx * 2.2 * wallDt;
      this.pitch = THREE.MathUtils.clamp(this.pitch + ry * 1.4 * wallDt, 0.08, 1.22);
      this.userFramed = true;
    }
    if (spinRate > 0 && !this.dragging && !padTurn && !this.reduceMotion) this.angle += spinRate * wallDt;

    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    this.pos.set(
      this.look.x + Math.sin(this.angle) * this.radius * cp,
      this.look.y + this.radius * sp,
      this.look.z + Math.cos(this.angle) * this.radius * cp,
    );

    const k = 1 - Math.exp((this.dragging || padTurn ? -18 : -5.5) * wallDt);
    this.camera.position.lerp(this.pos, k);
    this.camera.lookAt(this.look);
    if (shake) this.shake();
    easeFov(this.camera, this.baseFov, wallDt);
  }

  /** Chase, far chase or hood-cam view of the driven car; mouse drag / right stick look round it. */
  frameDrive(car: DeformableCar, wallDt: number, shake: boolean): void {
    this.fallWatch = false;
    this.rig = "chase";
    this.drive.update(this.camera, car, this.seat.view, wallDt, this.pad.rx, this.pad.ry);
    if (shake && this.seat.view !== "first") this.shake();
  }

  /** The followed car's cam: `spec`, else in a race (`chase`) the seat's chase view, elsewhere the orbit. */
  specView(chase: boolean): SpecView {
    return this.spec ?? (chase ? this.seat.view : "orbit");
  }

  /** View while following: the next spectator cam. */
  cycleSpec(chase: boolean): void {
    this.spec = SPEC_VIEWS[(SPEC_VIEWS.indexOf(this.specView(chase)) + 1) % SPEC_VIEWS.length]!;
    this.cine.reset();
  }

  /**
   * Frame a followed (not driven) car with `view`. The chase views keep a dragged look offset (a spectator framed it
   * on purpose and has no road to watch); the cinematic keeps the chase until it finds a clear spot. False for the
   * orbit: the caller aims `look` and orbits.
   */
  frameSpectate(car: DeformableCar, view: SpecView, scene: SpecScene, wallDt: number, shake: boolean): boolean {
    if (view === "orbit") return false;
    this.fallWatch = false;
    if (view === "dutch" || (view === "cine" && this.cine.update(this.camera, car, scene.sight, wallDt))) {
      if (view === "dutch") this.dutch.update(this.camera, car, scene.rivals, wallDt);
      this.drive.release();
      this.rig = "fixed";
      return true;
    }
    const chase = view === "cine" ? "third" : view;
    this.rig = "chase";
    this.drive.update(this.camera, car, chase, wallDt, this.pad.rx, this.pad.ry, true);
    if (shake && chase !== "first") this.shake();
    return true;
  }

  /**
   * A followed car off the fleet disc's rim: the eye eases to shoulder height just inside the rim on the car's
   * bearing and stays there, the aim eases onto the car and keeps it centred as it drops; `hold` (vaporized)
   * keeps the last aim. The chase is released, so a respawn blends back in.
   */
  watchFall(car: DeformableCar, wallDt: number, hold: boolean): void {
    const p = car.group.position;
    if (!this.fallWatch) {
      this.fallWatch = true;
      this.drive.release();
      const a = Math.atan2(p.x, p.z);
      const r = DISC_RADIUS - FALL_EYE_IN;
      this.fallEye.set(Math.sin(a) * r, FALL_EYE_Y, Math.cos(a) * r);
      this.camera.getWorldDirection(this.fallAim).multiplyScalar(this.camera.position.distanceTo(p)).add(this.camera.position);
    }
    if (!hold) this.fallAim.lerp(p, 1 - Math.exp(-8 * wallDt));
    this.camera.position.lerp(this.fallEye, 1 - Math.exp(-3 * wallDt));
    this.camera.lookAt(this.fallAim);
    easeFov(this.camera, this.baseFov, wallDt);
  }

  private shake(): void {
    if (this.trauma <= 0) return;
    const s = this.trauma * this.trauma;
    const t = performance.now() * 0.017;
    this.camera.position.x += Math.sin(t * 37.1) * s * 0.28;
    this.camera.position.y += Math.cos(t * 29.4) * s * 0.18;
    this.camera.rotateZ(Math.sin(t * 21.2) * s * 0.025);
  }

  /** Orbit angle / radius / pitch from the camera's current place around `look`. */
  private adoptPose(): void {
    const dx = this.camera.position.x - this.look.x;
    const dy = this.camera.position.y - this.look.y;
    const dz = this.camera.position.z - this.look.z;
    this.angle = Math.atan2(dx, dz);
    this.radius = THREE.MathUtils.clamp(Math.hypot(dx, dy, dz), 4.2, 32);
    this.pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(dy / this.radius, -0.99, 0.99)), 0.08, 1.22);
  }

  private placeApproach(cars: readonly DeformableCar[]): void {
    const mid = centroid(_v, cars);
    mid.y = 0.6;
    if (cars.length >= 2) {
      _w.copy(cars[1]!.group.position).sub(cars[0]!.group.position);
    } else {
      _w.copy(cars[0]?.forward ?? _w.set(0, 0, 1));
    }
    const dist = Math.max(_w.length(), 4);
    if (_w.lengthSq() > 1e-8) _w.normalize();
    else _w.set(0, 0, 1);
    const pull = THREE.MathUtils.lerp(16, 11, THREE.MathUtils.clamp(1 - dist / 28, 0, 1)) + Math.max(0, cars.length - 2) * 0.55;
    this.pos
      .copy(mid)
      .addScaledVector(this.approachSide, pull)
      .addScaledVector(_up, 5.2)
      .addScaledVector(_w, -1.4);
    this.look.copy(mid);
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.pointerTravel = 0;
    this.lookDragging = this.rig === "chase";
    this.dragging = this.seat.mode !== "drive";
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.dragging) this.userFramed = true;
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = "grabbing";
  };

  private onPointerMove = (e: PointerEvent): void => {
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.pointerTravel += Math.hypot(dx, dy);
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.lookDragging) {
      this.drive.nudge(dx, dy);
      return;
    }
    if (!this.dragging) return;
    this.angle -= dx * 0.005;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, 0.08, 1.22);
  };

  private onPointerUp = (e: PointerEvent): void => {
    const click = this.pointerTravel < 8;
    this.dragging = false;
    this.lookDragging = false;
    this.canvas.style.cursor = "grab";
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (click) this.onClick(e.clientX, e.clientY);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const scale = Math.exp(e.deltaY * 0.00115);
    this.radius = THREE.MathUtils.clamp(this.radius * scale, 4.2, 32);
    this.userFramed = true;
  };
}
