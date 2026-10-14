import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { DRIVE, type SeatView } from "../vehicle/car-drive.ts";
import { LOAD_FEEL } from "../vehicle/car-load.ts";
import { hypot2 } from "../kernel/physics-core.js";
import { wrapPiClosed } from "../kernel/scalar.ts";
import { LANDING, LandingWatch } from "./landing.ts";
import { Spring, Spring3, type Axes } from "./spring.ts";
import { activeGround, NO_FLOOR } from "../world/ground.ts";

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _e = new THREE.Vector3();
const _zeta: Axes = { lon: 1, lat: 1, up: 1 };

export const CHASE = {
  third: { dist: 6.2, height: 2.0, aimUp: 1.0 },
  far: { dist: 10, height: 3.3, aimUp: 1.15 },
  /** Hood-cam eye in car space: over the bonnet, ahead of the windshield (the tinted glass reads opaque from inside). */
  eye: { x: 0, y: 1.02, z: 1.15 },
  /**
   * Convergence (1/s): how hard the eye is pulled to its target, per axis of the car's frame (`Spring3.stepBasis`). The talk's
   * most important parameter (masterclass 29:30); it splits the spring per axis for "lots of sideways motion when turning, but
   * less forward and backward motion when accelerating and decelerating" (28:23): lateral looser than longitudinal. No numbers
   * in the talk: playtest.
   */
  pos: { lon: 9, lat: 5.5, up: 7 },
  /**
   * Momentum: the damping ratio per axis (< 1 carries the eye's velocity past its target: overshoot exp(-pi zeta / sqrt(1 - zeta^2))).
   * The talk's "momentum accelerates the camera in the direction it's already traveling" (masterclass 29:39), used where it names
   * it: the vertical axis, for a ride's bounce (playtest); the others stay critical.
   */
  zeta: { lon: 1, lat: 1, up: 0.75 },
  /** Damping: a cap (m/s) on the eye's speed relative to its target, the talk's "camera speed limit" slide (masterclass 29:44); 0 is off (playtest). */
  maxSpeed: 0,
  /** Spring stiffness (1/s) of the aim, the heading and the hood eye (playtest). */
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
  /** Extra chase distance per m/s (playtest). */
  pullback: 0.05,
  /**
   * The aim looks this far (s of velocity, m at most) ahead of the car: "velocity extrapolation on your look-ahead target ... to
   * look into turns and keep the player's focus near the center of the screen when turning" (masterclass 28:46). The defaults
   * equal the old heading lead (0.14 s of forward speed, 2.5 m): the same on a straight, following the velocity in a slide.
   */
  aheadVel: 0.14,
  aheadMax: 2.5,
  fov: 56,
  fovSpeed: 12,
  fovFirst: 72,
  /** Extra field of view (deg) at full slide (`drive.slide`): the drift talk's "changes the field of view to really accentuate the effect" (18:29), no number: playtest. */
  fovSlide: 4,
  /** Camera roll (deg) at full slide, toward the side the car slides: the drift talk's "it tilts" (18:29), no number; 0 is off (playtest). */
  driftTilt: 0,
  /** Clearance (m) the chase eye keeps over the ground under it (a ramp, a hill, the road after a landing's dip), so a looked-down chase never clips into the floor. */
  floor: 0.45,
  /** A frame-to-frame car jump past this (m) is a respawn: cut instead of swooping. */
  cut: 8,
  /** Taking a car up from a shot farther off than this (m) cuts to the chase shot: a swoop from the fleet's orbit to a course 400 m away showed after the fade. */
  blendRange: 40,
  /**
   * A landing (`LANDING`, masterclass 31:18): for `hold` s the eye's vertical spring runs at `zetaUp` so its momentum carries it below the target
   * ("reduce the damping so the momentum carries it further downwards", 31:39; "a large camera movement that doesn't obscure the
   * road ahead for long", 30:47; ratio and window: playtest), and the view wobbles in pitch and roll at `wobbleHz` (30 Hz, 31:23)
   * fading out over `hold` (the talk says 0.5 s, 31:27) at `wobble` deg (playtest); roll is `wobbleRoll` of the pitch.
   */
  landing: { zetaUp: 0.6, hold: 0.5, wobble: 0.8, wobbleHz: 30, wobbleRoll: 0.6 },
  /** Forward speed (m/s) from which the view looks into a slide and the aim follows the velocity. */
  followSpeed: 3,
  /** Impact shake strength: a multiple of the jolt's trauma (0 off); the first crash's kick scales with it too. The hood view shakes `shakeHood` of the chase views' amount (the eye sits in the car). */
  shake: 1,
  shakeHood: 0.4,
};

/**
 * The lowest a chase eye may stand (m) at (x, z): `CHASE.floor` over the surface there as the car's feet at height `y` see it
 * (so a deck overhead is no floor, a ramp or a hill is), or over y = 0 where the ground has none.
 */
function eyeFloor(x: number, z: number, y: number): number {
  const g = activeGround().heightAt(x, z, y);
  return (g === NO_FLOOR ? 0 : g) + CHASE.floor;
}

/** The debug panel's groups: the talk's three tuning parameters (masterclass 29:27), then what else the chase tunes. */
type ChaseGroup = "Convergence" | "Momentum" | "Damping" | "Look-ahead" | "Slide" | "Landing" | "Impact";

/** A chase knob's id is its HUD field, its settings entry and its share-URL key: `cam.` plus the `CHASE` path. */
export type ChaseKnobId =
  | "cam.pos.lon" | "cam.pos.lat" | "cam.pos.up"
  | "cam.zeta.lon" | "cam.zeta.lat" | "cam.zeta.up"
  | "cam.maxSpeed" | "cam.aheadVel" | "cam.aheadMax"
  | "cam.fovSlide" | "cam.driftTilt" | "cam.driftLean"
  | "cam.landing.fall" | "cam.landing.zetaUp" | "cam.landing.hold" | "cam.landing.wobble" | "cam.landing.wobbleHz"
  | "cam.shake" | "cam.shiftKick";

type ChaseKnob = {
  id: ChaseKnobId;
  group: ChaseGroup;
  label: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (value: number) => void;
};

function knob(group: ChaseGroup, id: ChaseKnobId, label: string, min: number, max: number, step: number, get: () => number, set: (value: number) => void): ChaseKnob {
  return { id, group, label, min, max, step, get, set };
}

/** Every `CHASE` value the debug panel tunes live. The ranges keep the eye above `floor` and the car in view. `knob-defaults.test.ts` pins a row per `ChaseKnobId`. */
export const CHASE_KNOBS: readonly ChaseKnob[] = [
  knob("Convergence", "cam.pos.lon", "Forward", 3, 14, 0.1, () => CHASE.pos.lon, (v) => void (CHASE.pos.lon = v)),
  knob("Convergence", "cam.pos.lat", "Lateral", 2, 12, 0.1, () => CHASE.pos.lat, (v) => void (CHASE.pos.lat = v)),
  knob("Convergence", "cam.pos.up", "Vertical", 3, 12, 0.1, () => CHASE.pos.up, (v) => void (CHASE.pos.up = v)),
  knob("Momentum", "cam.zeta.lon", "Forward", 0.3, 1, 0.01, () => CHASE.zeta.lon, (v) => void (CHASE.zeta.lon = v)),
  knob("Momentum", "cam.zeta.lat", "Lateral", 0.3, 1, 0.01, () => CHASE.zeta.lat, (v) => void (CHASE.zeta.lat = v)),
  knob("Momentum", "cam.zeta.up", "Vertical", 0.3, 1, 0.01, () => CHASE.zeta.up, (v) => void (CHASE.zeta.up = v)),
  knob("Damping", "cam.maxSpeed", "Max speed (0 off)", 0, 40, 0.5, () => CHASE.maxSpeed, (v) => void (CHASE.maxSpeed = v)),
  knob("Look-ahead", "cam.aheadVel", "Seconds", 0, 0.5, 0.01, () => CHASE.aheadVel, (v) => void (CHASE.aheadVel = v)),
  knob("Look-ahead", "cam.aheadMax", "Max (m)", 0, 12, 0.1, () => CHASE.aheadMax, (v) => void (CHASE.aheadMax = v)),
  knob("Slide", "cam.fovSlide", "FOV (deg)", 0, 10, 0.1, () => CHASE.fovSlide, (v) => void (CHASE.fovSlide = v)),
  knob("Slide", "cam.driftTilt", "Tilt (deg)", 0, 4, 0.1, () => CHASE.driftTilt, (v) => void (CHASE.driftTilt = v)),
  knob("Slide", "cam.driftLean", "Drift lean", 0, 1.2, 0.01, () => LOAD_FEEL.driftLean, (v) => void (LOAD_FEEL.driftLean = v)),
  knob("Landing", "cam.landing.fall", "Fall (m/s)", 2, 12, 0.1, () => LANDING.fall, (v) => void (LANDING.fall = v)),
  knob("Landing", "cam.landing.zetaUp", "Bounce", 0.2, 1, 0.01, () => CHASE.landing.zetaUp, (v) => void (CHASE.landing.zetaUp = v)),
  knob("Landing", "cam.landing.hold", "Window (s)", 0.1, 1.5, 0.05, () => CHASE.landing.hold, (v) => void (CHASE.landing.hold = v)),
  knob("Landing", "cam.landing.wobble", "Wobble (deg)", 0, 2, 0.05, () => CHASE.landing.wobble, (v) => void (CHASE.landing.wobble = v)),
  knob("Landing", "cam.landing.wobbleHz", "Wobble (Hz)", 10, 40, 1, () => CHASE.landing.wobbleHz, (v) => void (CHASE.landing.wobbleHz = v)),
  knob("Impact", "cam.shake", "Shake strength", 0, 2, 0.05, () => CHASE.shake, (v) => void (CHASE.shake = v)),
  knob("Impact", "cam.shiftKick", "Gear-change kick", 0, 3, 0.05, () => LOAD_FEEL.shiftKick, (v) => void (LOAD_FEEL.shiftKick = v)),
];

/** Every chase knob's live value by id (the HUD fields and share-state keys). The cast holds: `CHASE_KNOBS` has a row per id (pinned by test). */
export function chaseValues(): Record<ChaseKnobId, number> {
  const out = {} as Record<ChaseKnobId, number>;
  for (let i = 0; i < CHASE_KNOBS.length; i++) out[CHASE_KNOBS[i]!.id] = CHASE_KNOBS[i]!.get();
  return out;
}

/** The knobs' values at module load, before anything mutates `CHASE` or `LOAD_FEEL`: the defaults of `INITIAL_HUD`, the settings and the share URL. */
export const CHASE_DEFAULTS = chaseValues();

/**
 * Camera ride (visual): a small share of the followed car's drawn body heave and pitch (`Suspension`): a squat at launch or a
 * landing drops the eye and tilts it up, a dive lifts and tips it down. A chase eye sits behind the body's pivot (nose up sinks it
 * `lever` m per rad), the hood cam ahead of it (rises). Soft-bounded under `drop` m and `maxTilt` rad, eased at `omega`/s.
 */
const RIDE = { heave: 0.5, lever: 0.8, tilt: 0.25, drop: 0.04, maxTilt: (0.6 * Math.PI) / 180, omega: 12 };

/**
 * Chase / far chase / hood-cam rig for a driven car. Heading follows the car's body (not its velocity, so reversing never swings
 * the camera round) on a critically damped spring; the eye springs onto its offset per axis of the car's frame (`CHASE.pos`,
 * `CHASE.zeta`), the aim onto the velocity's look-ahead.
 */
export class DriveCam {
  private readonly pos = new Spring3();
  private readonly aim = new Spring3();
  private readonly heading = new Spring();
  private readonly lookYaw = new Spring();
  private readonly lookPitch = new Spring();
  /** Camera ride on (`RIDE`): the engine sets it from the FX tier and reduced motion before each frame's rig. */
  ride = false;
  /** Reduced motion: every axis stays critically damped and a landing does not wobble the view. */
  reduceMotion = false;
  /** The landing detector (`LANDING`) and the seconds left of a landing's wobble (`CHASE.landing`). */
  private readonly land = new LandingWatch();
  private landS = 0;
  /** The fall speed (m/s) of the landing the last `update` saw, 0 once the engine has taken it (the pad's rumble reads the same landing as the camera). */
  landFall = 0;
  private readonly rideY = new Spring();
  private readonly rideTilt = new Spring();
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

  /** Lift `camera`'s eye to `eyeFloor` where it stands (the chase views, after anything that moved it): the push-out, a pull toward a ramp's face. */
  keepAbove(camera: THREE.PerspectiveCamera, car: DeformableCar): void {
    const f = eyeFloor(camera.position.x, camera.position.z, car.group.position.y);
    if (camera.position.y < f) camera.position.y = f;
  }

  /** `rx`/`ry`: right stick after deadzone, DOM signs (+x right, +y down). `keep`: a dragged look offset stays put (spectating). */
  update(camera: THREE.PerspectiveCamera, car: DeformableCar, view: SeatView, dt: number, rx: number, ry: number, keep = false): void {
    const p = car.group.position;
    const fwd = car.fwdFlat;
    const vel = car.velocity;
    const along = vel.x * fwd.x + vel.z * fwd.z;
    let yawT = Math.atan2(fwd.x, fwd.z);
    if (along > CHASE.followSpeed && view !== "first") {
      yawT += THREE.MathUtils.clamp(wrapPiClosed(Math.atan2(vel.x, vel.z) - yawT), -0.5, 0.5) * 0.4;
    }

    const enter = this.car !== car;
    const cut = enter || this.lastCarPos.distanceToSquared(p) > CHASE.cut * CHASE.cut;
    // The car's actual travel this frame (exact on arcs and uneven frames, unlike velocity × dt).
    const moveX = p.x - this.lastCarPos.x;
    const moveZ = p.z - this.lastCarPos.z;
    this.car = car;
    this.lastCarPos.copy(p);
    if (cut) {
      this.land.reset();
      this.landS = 0;
    }
    const fall = this.land.step(car, dt);
    if (fall > 0) {
      this.landS = CHASE.landing.hold;
      this.landFall = fall;
    }
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
      const r = hypot2(dist, c.height);
      const elev = THREE.MathUtils.clamp(Math.atan2(c.height, dist) + this.lookPitch.x, 0.02, 1.25);
      const flat = r * Math.cos(elev);
      _v.set(p.x - sy * flat, p.y + r * Math.sin(elev), p.z - cy * flat);
      const lead = THREE.MathUtils.clamp(along * CHASE.aheadVel, -0.5, CHASE.aheadMax);
      let lx = fwd.x * lead;
      let lz = fwd.z * lead;
      if (along > CHASE.followSpeed) {
        lx = vel.x * CHASE.aheadVel;
        lz = vel.z * CHASE.aheadVel;
        const l = hypot2(lx, lz);
        if (l > CHASE.aheadMax) {
          lx *= CHASE.aheadMax / l;
          lz *= CHASE.aheadMax / l;
        }
      }
      _w.set(p.x + lx, p.y + c.aimUp, p.z + lz);
      if (enter && camera.position.distanceToSquared(p) <= CHASE.blendRange * CHASE.blendRange) {
        // Blend in from the current shot (orbit, another car, or the hood cam); a shot that far off (a scene change) is a cut.
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
      const calm = this.reduceMotion;
      _zeta.lon = calm ? 1 : CHASE.zeta.lon;
      _zeta.lat = calm ? 1 : CHASE.zeta.lat;
      _zeta.up = calm ? 1 : this.landS > 0 ? CHASE.landing.zetaUp : CHASE.zeta.up;
      this.pos.stepBasis(_v, CHASE.pos, _zeta, CHASE.maxSpeed, dt, fwd.x, fwd.z);
      this.aim.step(_w, CHASE.aimOmega, dt);
      const floor = eyeFloor(this.pos.x.x, this.pos.x.z, p.y);
      if (this.pos.x.y < floor) {
        this.pos.x.y = floor;
        if (this.pos.v.y < 0) this.pos.v.y = 0;
      }
    }
    camera.position.copy(this.pos.x);
    camera.lookAt(this.aim.x);

    this.rideStep(camera, car, view, dt);
    if (view !== "first") this.landingWobble(camera);
    if (view !== "first" && CHASE.driftTilt !== 0) {
      const side = Math.sign(vel.x * fwd.z - vel.z * fwd.x);
      camera.rotateZ(-side * car.drive.slide * CHASE.driftTilt * THREE.MathUtils.DEG2RAD);
    }
    this.landS = Math.max(0, this.landS - dt);
    const fov =
      view === "first"
        ? CHASE.fovFirst
        : CHASE.fov + CHASE.fovSpeed * Math.min(1.4, Math.max(0, along) / DRIVE.maxFwd) + CHASE.fovSlide * car.drive.slide;
    easeFov(camera, fov, dt);
  }

  /** A landing's wobble: pitch and roll at `wobbleHz`, fading out linearly over `hold` s of the landing's own clock (not the wall's). */
  private landingWobble(camera: THREE.PerspectiveCamera): void {
    if (this.landS <= 0 || this.reduceMotion) return;
    const l = CHASE.landing;
    const a = (l.wobble * THREE.MathUtils.DEG2RAD * this.landS) / l.hold;
    const phase = 2 * Math.PI * l.wobbleHz * (l.hold - this.landS);
    camera.rotateX(a * Math.sin(phase));
    camera.rotateZ(l.wobbleRoll * a * Math.cos(phase));
  }

  /** The ride over this frame's chase or hood shot (eased out by a look offset: that framing is the player's own). */
  private rideStep(camera: THREE.PerspectiveCamera, car: DeformableCar, view: SeatView, dt: number): void {
    if (!this.ride) {
      this.rideY.snap(0);
      this.rideTilt.snap(0);
      return;
    }
    const s = car.suspension;
    const fade = Math.max(0, 1 - 20 * hypot2(this.lookYaw.x, this.lookPitch.x));
    const y = RIDE.heave * s.heave + (view === "first" ? RIDE.lever : -RIDE.lever) * s.pitch;
    camera.position.y += this.rideY.step(RIDE.drop * Math.tanh(y / RIDE.drop) * fade, RIDE.omega, dt);
    camera.rotateX(this.rideTilt.step(RIDE.maxTilt * Math.tanh((RIDE.tilt * s.pitch) / RIDE.maxTilt) * fade, RIDE.omega, dt));
  }
}

/** Ease the lens toward `fov` (deg), re-projecting only while it still moves. */
export function easeFov(camera: THREE.PerspectiveCamera, fov: number, dt: number): void {
  const d = fov - camera.fov;
  if (Math.abs(d) < 0.01) return;
  camera.fov += d * (1 - Math.exp(-3 * dt));
  camera.updateProjectionMatrix();
}
