import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import type { DriverSeat, SeatView } from "../vehicle/car-drive.ts";
import type { PadState } from "../vehicle/gamepad.ts";
import { DISC_RADIUS } from "../world/ground.ts";
import { hypot2, hypot3 } from "../kernel/physics-core.js";
import { AutoCam, type AutoScene } from "./auto-cam.ts";
import { CHASE, DriveCam, easeFov } from "./drive-cam.ts";
import { CineCam, DutchCam, EyePull, type Sight } from "./spectate-cam.ts";

/** A followed (not driven) car's camera, cycled by View: the drive chase views, the trackside cinematic, the wheel-well dutch, the free orbit and Auto (`AutoCam` run live). A race opens on the chase, everything else on the orbit. */
export type SpecView = SeatView | "cine" | "dutch" | "orbit" | "auto";
const SPEC_VIEWS: readonly SpecView[] = ["third", "far", "first", "cine", "dutch", "orbit", "auto"];

/** What the spectator cams read from the scene: `rivals` and `sight` when they pick a shot, `fixed` per frame (the course's own cached solids, no cars; null off a race) for the chase views' push-out, the driver's too. */
export type SpecScene = AutoScene & { rivals(): readonly DeformableCar[]; fixed(): Sight | null };

/** A lamp post the orbit keeps clear of: it stands from its base up `POST_TOP` m and is thin, so the eye's distance to its axis is what counts. */
type Post = { intact: boolean; group: { visible: boolean; position: THREE.Vector3 } };
/** The orbit's target keeps this far (m) from a post's axis; the eye lags the target and cuts the bend short (0.1 m at the idle spin of 0.32 rad/s, measured), so 3.15 holds it 3 m clear. */
const POST_CLEAR = 3.15;
const POST_TOP = 5.3;
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
/** `watchFall`: the eye stands this far (m) inside the fleet disc's rim, at shoulder height (m) over the disc. */
const FALL_EYE_IN = 1.5;
const FALL_EYE_Y = 1.5;
/** The orbit's eye keeps this far (m) inside `ChaseCamera.rim`, the derby bowl's wall. */
const RIM_EYE_IN = 2;
/** The derby's opening shot (`placeBowl`): the eye this far (m) from the pack toward the bowl's middle and up over the floor, about 48° down. */
const BOWL_EYE_BACK = 20;
const BOWL_EYE_UP = 22;
/** Seconds after a drag ends that the ride-along's automatic cuts keep waiting. */
export const RIDE_PAUSE = 2.5;
/** A pointer that travels less (px) than this is a click, not a drag. */
const CLICK_PX = 8;
const CURSOR_GRAB = "grab";

/** Mean position of the cars still on the disc (falling and vaporized ones skipped; zero for an empty fleet). */
export function centroid(out: THREE.Vector3, cars: readonly DeformableCar[]): THREE.Vector3 {
  out.set(0, 0, 0);
  let n = 0;
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i]!;
    if (car.falling || car.vaporized) continue;
    out.add(car.group.position);
    n++;
  }
  return n === 0 ? out : out.multiplyScalar(1 / n);
}

/** A hit's closing speed (m/s) to shake: none under `from` (a nudge), full at `full` (a head-on at speed). */
const JOLT = { from: 2, full: 20 };
/** The shake's three axes (across, up, roll) in rad/s: 9.1, 7.3 and 5.7 Hz, out of step so the motion never repeats on a beat. */
const SHAKE_RAD_S = [2 * Math.PI * 9.1, 2 * Math.PI * 7.3, 2 * Math.PI * 5.7] as const;
/** Trauma lost per wall second: a full jolt is gone in a third of a second (drawn as trauma squared, it reads as a short burst). */
export const SHAKE_DECAY_PER_S = 3.2;

/** An orbit shot (`frameReset`): look point (x and z 0 unless given), distance and pitch. The one-car rigs' is `SOLO_SHOT`. */
type OrbitShot = { lookY: number; radius: number; pitch: number; lookX?: number; lookZ?: number };
const SOLO_SHOT: OrbitShot = { lookY: 0.55, radius: 9.4, pitch: 0.44 };

/**
 * Orbit / chase / first-person rig over the shared PerspectiveCamera, plus canvas pointer input:
 * left-drag orbits (or looks round the driven or spectated car), wheel or a two-finger pinch zooms, a short tap picks via `onClick`.
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
  /** Rear-view hold, set by the input poll every frame (Backquote, R3, the touch button). */
  rear = false;
  /** Pointer lock (mouse look) held: set by the engine; clicks are off and the orbit follows fast and never auto-spins. */
  locked = false;
  readonly drive = new DriveCam();
  readonly cine = new CineCam();
  readonly dutch = new DutchCam();
  readonly auto = new AutoCam();
  /** The scene's lamp posts (the engine sets the array once; it fills as the world builds). */
  posts: readonly Post[] = [];
  /** The bowl's wall (m from the middle, the derby's) the orbit's eye stays inside, so the wall never stands between it and the cars; Infinity elsewhere. */
  rim = Infinity;
  /** The followed car's cam; null = the scene's own (`specView`). */
  spec: SpecView | null = null;
  /** What framed the last frame, so a drag knows what to move: the orbit, a chase rig's look, or nothing (cine, dutch). */
  private rig: "orbit" | "chase" | "fixed" = "orbit";
  private readonly baseFov: number;
  /** The scene's own lens (deg), when it is not the camera's `baseFov` (the Lab's wider one). */
  private sceneFov: number | null = null;
  /** The ride-along (a thrown driver's camera) holds the camera: a drag orbits it, whatever the seat. */
  private ride = false;
  /** Seconds since the last ride drag ended (Infinity: none this ride). */
  private rideIdle = Infinity;
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
  /** `lookBack` parks the rigs' own shot here and `unflip` puts it back, so the rigs never see the rear view. */
  private flipped = false;
  /** The chase eye's pull-in past the course's solids (`pushOut`). */
  private readonly pull = new EyePull();
  private readonly rigPos = new THREE.Vector3();
  private readonly rigQuat = new THREE.Quaternion();
  /** Canvas pointers: the drag's id, and a second finger that pinch-zooms (`pinchDist` px from the first). */
  private dragId = -1;
  private pinchId = -1;
  private pinchX = 0;
  private pinchY = 0;
  private pinchDist = 0;
  /**
   * A scene that takes presses from the drag (the Lab's flick): `down` (client px, `t` ms) claims a press or leaves it to the
   * camera; a claimed press's moves (the `pointermove` itself, with the moves coalesced into it) and its release (`cancel`: the
   * system took the pointer) go to it, never the orbit or a pick.
   */
  take: { down(x: number, y: number, t: number): boolean; move(e: PointerEvent): void; up(x: number, y: number, t: number, cancel: boolean): void } | null = null;
  private taking = false;

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
    this.drive.reduceMotion = reduceMotion;
    this.onClick = onClick;
    camera.position.copy(this.pos);
    this.baseFov = camera.fov;
  }

  attach(): void {
    this.canvas.style.touchAction = "none";
    this.canvas.style.cursor = CURSOR_GRAB;
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

  /** The scene's own lens (deg): what the orbit, a fall watch and the ride-along ease back to. */
  get lens(): number {
    return this.sceneFov ?? this.baseFov;
  }

  /** Set the scene's lens (null: the camera's own) and cut to it: called on a scene switch, under its fade. */
  setLens(fov: number | null): void {
    this.sceneFov = fov;
    this.camera.fov = this.lens;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Per frame while a ride-along may hold the camera (`on`): whether the user holds it, a drag under way (a click
   * is not one) or ended less than `RIDE_PAUSE` s ago. The ride's automatic cuts wait while it is true, then pick up
   * from the user's view.
   */
  rideHeld(on: boolean, wallDt: number): boolean {
    this.rideIdle = !on ? Infinity : this.dragging && this.pointerTravel >= CLICK_PX ? 0 : this.rideIdle + wallDt;
    return this.rideIdle < RIDE_PAUSE;
  }

  /**
   * The ride-along frames this frame (`look`: its aim) or not (null). Framed, a drag turns the orbit around `look`,
   * the same yaw and pitch limits as anywhere, and does not count as framing the shot (the next throw still rides).
   */
  frameRide(look: THREE.Vector3 | null): void {
    this.ride = look !== null;
    if (!look) return;
    this.rig = "orbit";
    this.fallWatch = false;
    this.look.copy(look);
  }

  /** Snap to the opening shot: a fixed solo-rig angle (`soloAngle`) and `shot`, or broadside to the fleet's approach line. */
  frameReset(compactor: boolean, cars: readonly DeformableCar[], soloAngle = 0.85, shot = SOLO_SHOT): void {
    this.userFramed = false;
    this.trauma = 0;
    // This snap replaces any shot `lookBack` parked.
    this.flipped = false;
    if (compactor) {
      this.look.set(shot.lookX ?? 0, shot.lookY, shot.lookZ ?? 0);
      this.radius = shot.radius;
      this.pitch = shot.pitch;
      this.angle = soloAngle;
      const cp = Math.cos(this.pitch);
      this.pos.set(
        this.look.x + Math.sin(this.angle) * this.radius * cp,
        this.look.y + this.radius * Math.sin(this.pitch),
        this.look.z + Math.cos(this.angle) * this.radius * cp,
      );
    } else {
      if (cars.length >= 2) {
        _w.copy(cars[1]!.group.position).sub(cars[0]!.group.position).normalize();
      } else {
        _w.copy(cars[0]?.forward ?? _w.set(0, 0, 1));
      }
      this.approachSide.crossVectors(_w, _up).normalize();
      if (this.approachSide.lengthSq() < 0.1) this.approachSide.set(1, 0, 0);
      if (this.rim === Infinity) this.placeApproach(cars);
      else this.placeBowl(cars);
    }
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    this.adoptPose();
  }

  /** Impact hit: shake, and unless the user framed the shot, orbit from where the camera is now. */
  kick(carCount: number): void {
    this.trauma = this.reduceMotion ? 0 : Math.min(1, 0.85 * CHASE.shake);
    if (!this.userFramed) {
      this.angle = Math.atan2(this.camera.position.x - this.look.x, this.camera.position.z - this.look.z);
      this.radius = THREE.MathUtils.clamp(this.radius + Math.max(0, carCount - 2) * 0.4, 8, 22);
    }
  }

  /**
   * A hit on the followed car: `speed` m/s of velocity change raises the shake to its own level (the orbit is not re-aimed), none under
   * `JOLT.from`, full (before `CHASE.shake`) at `JOLT.full`, a straight ramp between (trauma squared draws, so a tap is a nudge). Hits never
   * stack: a pile grinding on the car every frame holds one hit's shake, it does not pin it at full. No shake in reduced motion.
   */
  jolt(speed: number): void {
    if (this.reduceMotion) return;
    const t = THREE.MathUtils.clamp((speed - JOLT.from) / (JOLT.full - JOLT.from), 0, 1);
    this.trauma = Math.max(this.trauma, Math.min(1, CHASE.shake * t));
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
    if (spinRate > 0 && !this.dragging && !this.locked && !padTurn && !this.reduceMotion) this.angle += spinRate * wallDt;

    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    this.pos.set(
      this.look.x + Math.sin(this.angle) * this.radius * cp,
      this.look.y + this.radius * sp,
      this.look.z + Math.cos(this.angle) * this.radius * cp,
    );
    this.pushFromPosts();
    this.keepInRim();

    const k = 1 - Math.exp((this.dragging || this.locked || padTurn ? -18 : -5.5) * wallDt);
    this.camera.position.lerp(this.pos, k);
    this.camera.lookAt(this.look);
    if (shake) this.shake(1);
    easeFov(this.camera, this.lens, wallDt);
  }

  /**
   * The orbit's target (`pos`) bends along its own radius round each lamp post so the eye keeps `POST_CLEAR` m from the post's
   * axis (less over its top). One smooth swell, easing out over 3 × `POST_CLEAR` m of orbit either side, so a pass has no kink.
   * It goes inward (the post behind the eye, out of the shot) unless the post's circle lies more than a quarter of the
   * clearance inside the orbit's: then outward. No allocation.
   */
  private pushFromPosts(): void {
    const p = this.pos;
    const ex = p.x - this.look.x;
    const ez = p.z - this.look.z;
    const R = hypot2(ex, ez);
    if (R < 1e-3) return;
    const ux = ex / R;
    const uz = ez / R;
    const posts = this.posts;
    for (let k = 0; k < posts.length; k++) {
      const post = posts[k]!;
      if (!post.intact || !post.group.visible) continue;
      const q = post.group.position;
      const h = Math.max(0, p.y - q.y - POST_TOP);
      if (h >= POST_CLEAR) continue;
      const c = Math.sqrt(POST_CLEAR * POST_CLEAR - h * h);
      // The post from `look`: along the eye's radius (on the eye's side) and across it.
      const px = q.x - this.look.x;
      const pz = q.z - this.look.z;
      const s = px * uz - pz * ux;
      if (px * ux + pz * uz <= 0 || Math.abs(s) >= 3 * c) continue;
      const swell = 1 - (s * s) / (9 * c * c);
      // How far the post's circle lies beyond the orbit's (negative: inside it), and the shift that clears it on the chosen side.
      const gap = hypot2(px, pz) - R;
      const shift = gap >= -c / 4 ? -Math.max(0, c - gap) : Math.max(0, c + gap);
      p.x += ux * shift * swell * swell;
      p.z += uz * shift * swell * swell;
    }
  }

  /**
   * Chase, far chase or hood-cam view of the driven car; mouse drag / right stick look round it. `fixed`: the course's
   * solids (null off a race), which the chase views keep out of (`keepClear`).
   */
  frameDrive(car: DeformableCar, fixed: Sight | null, wallDt: number, shake: boolean): void {
    this.fallWatch = false;
    this.rig = "chase";
    const view = this.seat.view;
    this.drive.update(this.camera, car, view, wallDt, this.pad.rx, this.pad.ry);
    this.keepClear(car, view, fixed, wallDt);
    if (shake) this.shake(view === "first" ? CHASE.shakeHood : 1);
  }

  /** The followed car's cam: `spec`, else in a race (`chase`) the seat's chase view, elsewhere the orbit. */
  specView(chase: boolean): SpecView {
    return this.spec ?? (chase ? this.seat.view : "orbit");
  }

  /** View while following: the next spectator cam. */
  cycleSpec(chase: boolean): void {
    this.spec = SPEC_VIEWS[(SPEC_VIEWS.indexOf(this.specView(chase)) + 1) % SPEC_VIEWS.length]!;
    this.cine.reset();
    this.auto.reset();
    this.pull.reset();
  }

  /**
   * Frame a followed (not driven) car with `view`. The chase views keep a dragged look offset (a spectator framed it
   * on purpose and has no road to watch); the cinematic keeps the chase until it finds a clear spot. False for the
   * orbit: the caller aims `look` and orbits.
   */
  frameSpectate(car: DeformableCar, view: SpecView, scene: SpecScene, wallDt: number, shake: boolean): boolean {
    if (view === "orbit") return false;
    this.fallWatch = false;
    if (view === "auto") {
      this.auto.update(this.camera, car, scene, wallDt);
      this.drive.release();
      this.rig = "fixed";
      return true;
    }
    if (view === "dutch" || (view === "cine" && this.cine.update(this.camera, car, scene.sight, wallDt))) {
      if (view === "dutch") this.dutch.update(this.camera, car, scene.rivals, wallDt);
      this.drive.release();
      this.rig = "fixed";
      return true;
    }
    const chase = view === "cine" ? "third" : view;
    this.rig = "chase";
    this.drive.update(this.camera, car, chase, wallDt, this.pad.rx, this.pad.ry, true);
    this.keepClear(car, chase, scene.fixed(), wallDt);
    if (shake) this.shake(chase === "first" ? CHASE.shakeHood : 1);
    return true;
  }

  /**
   * A chase eye inside a course solid (a street corner, a wall, a tunnel's rock) is pulled in along the view (`EyePull`): at
   * once as the solid closes on it, eased back out once the way is clear. One solid test per frame while it is clear and
   * nothing is being eased out. Then it is lifted to `CHASE.floor` over the ground under it, so a ramp or a landing's dip
   * never takes it under the road. The rig's own spring is untouched. The orbit and the hood cam are not pushed. `s` null
   * (off a race): no course solids, the floor only.
   */
  private keepClear(car: DeformableCar, view: SeatView, s: Sight | null, dt: number): void {
    if (view === "first") {
      this.pull.reset();
      return;
    }
    if (s) this.pull.apply(s, this.camera.position, this.camera.getWorldDirection(_v), dt);
    else this.pull.reset();
    this.drive.keepAbove(this.camera, car);
  }

  /**
   * Rear view: the chase offset mirrored ahead of `car`, looking back past it, snapped (no spring). The rigs'
   * shot is parked for `unflip`, so a release shows it again on the next frame.
   */
  lookBack(car: DeformableCar): void {
    this.rigPos.copy(this.camera.position);
    this.rigQuat.copy(this.camera.quaternion);
    this.flipped = true;
    const p = car.group.position;
    const f = car.fwdFlat;
    const c = this.seat.view === "far" ? CHASE.far : CHASE.third;
    this.camera.position.set(p.x + f.x * c.dist, p.y + c.height, p.z + f.z * c.dist);
    this.camera.lookAt(p.x - f.x * c.dist, p.y + c.aimUp, p.z - f.z * c.dist);
  }

  /** Undo last frame's `lookBack`; call before the rigs run. */
  unflip(): void {
    if (!this.flipped) return;
    this.flipped = false;
    this.camera.position.copy(this.rigPos);
    this.camera.quaternion.copy(this.rigQuat);
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
    easeFov(this.camera, this.lens, wallDt);
  }

  /** Apply the screen shake: `scale` 1 in the chase views, `CHASE.shakeHood` in the hood view. */
  private shake(scale: number): void {
    if (this.trauma <= 0) return;
    const s = this.trauma * this.trauma * scale;
    // Seconds: the shake runs at 6-9 Hz, a readable jolt (it ran near 100 Hz, which beat against the frame rate as a strobing flicker).
    const t = performance.now() / 1000;
    // Across the view (the Battlefront 2 "orbit" shake, masterclass 40:05): the car near the eye shakes, the road far ahead holds still, and a hit never pulses the eye toward or away from the car.
    this.camera.translateX(Math.sin(t * SHAKE_RAD_S[0]) * s * 0.14);
    this.camera.translateY(Math.cos(t * SHAKE_RAD_S[1]) * s * 0.09);
    this.camera.rotateZ(Math.sin(t * SHAKE_RAD_S[2]) * s * 0.01);
  }

  /** Orbit angle / radius / pitch from the camera's current place around `look`. */
  private adoptPose(): void {
    const dx = this.camera.position.x - this.look.x;
    const dy = this.camera.position.y - this.look.y;
    const dz = this.camera.position.z - this.look.z;
    this.angle = Math.atan2(dx, dz);
    this.radius = THREE.MathUtils.clamp(hypot3(dx, dy, dz), 4.2, 32);
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

  /** The derby's opening shot: high on the bowl's middle side of the pack, looking down and out at it, the bowl's floor around it. */
  private placeBowl(cars: readonly DeformableCar[]): void {
    const mid = centroid(_v, cars);
    mid.y = 0.6;
    const r = hypot2(mid.x, mid.z);
    if (r > 1) _w.set(mid.x / r, 0, mid.z / r);
    else _w.copy(this.approachSide);
    this.pos.copy(mid).addScaledVector(_w, -BOWL_EYE_BACK).addScaledVector(_up, BOWL_EYE_UP);
    this.look.copy(mid);
    this.keepInRim();
  }

  /** An eye past `rim` comes in to `RIM_EYE_IN` short of it toward the middle, at its height: inside the round wall, its line to anything inside clears it. */
  private keepInRim(): void {
    const r = hypot2(this.pos.x, this.pos.z);
    const max = this.rim - RIM_EYE_IN;
    if (r <= max) return;
    this.pos.x *= max / r;
    this.pos.z *= max / r;
  }

  private onPointerDown = (e: PointerEvent): void => {
    // Mouse look has no clicks: a press must not pick a car at the frozen pointer.
    if (e.button !== 0 || this.locked) return;
    // A second finger on the canvas pinch-zooms (the touch wheel); it never orbits or picks.
    if (this.dragId !== -1) {
      if (this.pinchId !== -1 || this.taking) return;
      this.pinchId = e.pointerId;
      this.pinchX = e.clientX;
      this.pinchY = e.clientY;
      this.pinchDist = hypot2(this.lastX - e.clientX, this.lastY - e.clientY);
      this.pointerTravel = Infinity;
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (this.take?.down(e.clientX, e.clientY, e.timeStamp)) {
      this.dragId = e.pointerId;
      this.taking = true;
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    this.dragId = e.pointerId;
    this.pointerTravel = 0;
    this.lookDragging = this.rig === "chase";
    this.dragging = this.ride || this.seat.mode !== "drive";
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.ride) this.adoptPose();
    else if (this.dragging) this.userFramed = true;
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = "grabbing";
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId === this.pinchId) {
      this.pinchX = e.clientX;
      this.pinchY = e.clientY;
      this.pinch();
      return;
    }
    if (e.pointerId !== this.dragId) return;
    if (this.taking) {
      this.take?.move(e);
      return;
    }
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.pointerTravel += hypot2(dx, dy);
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.pinchId !== -1) {
      this.pinch();
      return;
    }
    if (this.lookDragging) {
      this.drive.nudge(dx, dy);
      return;
    }
    if (this.dragging) this.orbitBy(dx, dy);
  };

  /** Drag right turns the orbit right, drag down tips it over (same limits for a drag and for mouse look). */
  private orbitBy(dx: number, dy: number): void {
    this.angle -= dx * 0.005;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, 0.08, 1.22);
  }

  /**
   * Pointer-lock mouse look: raw movement does what a held drag does (the chase look offset, or the orbit
   * round a car in the other seats), with no button down. Not on the ride-along, which keeps its own shot.
   */
  lookBy(dx: number, dy: number): void {
    if (this.rig === "chase") this.drive.nudge(dx, dy);
    else if (this.rig === "orbit" && this.seat.mode !== "drive" && !this.ride) {
      this.orbitBy(dx, dy);
      this.userFramed = true;
    }
  }

  /** Two fingers apart zoom in, together zoom out, on the wheel's radius range. */
  private pinch(): void {
    const d = hypot2(this.lastX - this.pinchX, this.lastY - this.pinchY);
    if (this.pinchDist > 0 && d > 0) this.radius = THREE.MathUtils.clamp((this.radius * this.pinchDist) / d, 4.2, 32);
    this.pinchDist = d;
    this.userFramed = true;
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId === this.pinchId) {
      this.pinchId = -1;
      return;
    }
    if (e.pointerId !== this.dragId) return;
    this.dragId = -1;
    this.pinchId = -1;
    const click = this.pointerTravel < CLICK_PX;
    this.dragging = false;
    this.lookDragging = false;
    this.canvas.style.cursor = CURSOR_GRAB;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (this.taking) {
      this.taking = false;
      this.take?.up(e.clientX, e.clientY, e.timeStamp, e.type === "pointercancel");
    } else if (click) this.onClick(e.clientX, e.clientY);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const scale = Math.exp(e.deltaY * 0.00115);
    this.radius = THREE.MathUtils.clamp(this.radius * scale, 4.2, 32);
    this.userFramed = true;
  };
}
