import * as THREE from "three";
import { activeGround, NO_FLOOR } from "../world/ground.ts";
import { wrapPi } from "../kernel/scalar.ts";
import { easeFov } from "./engine-camera.ts";
import { CINE, CineCam, sightLine, solid, type Sight, type Subject } from "./spectate-cam.ts";

/**
 * The ride-along's shots (camera only; nothing here reaches the sim). A ride opens on the windshield: the eye stands
 * ahead of the thrown driver's car on its forward axis, up and out of every solid, and watches him come through the
 * glass. Then it follows him (behind or ahead of his travel, alternating per ride), and now and then the trackside
 * cinematic (`CineCam`: a fixed eye ahead of his travel) takes a turn. Every change of shot, cut to another dummy
 * and return from the user's own orbit eases from the pose the camera was left in (`BLEND_T`), so no frame jumps; a
 * cut to an eye more than `CUT_FAR` away (a dummy across the field) and the ride's first frame are cuts, not flights.
 * While the user holds the camera (`Framing.held`) the shots wait.
 */

/** Follow shot: metres ahead of or behind the head, out to the side and up. */
const BACK = 4.5;
const SIDE = 1.8;
const UP = 1.3;
/** Wall seconds: the windshield shot, the follow shot before a trackside turn, the trackside shot at most, and the ease between shots. */
const GLASS_T = 0.8;
const FOLLOW_T = 3.5;
const TRACK_T = 4;
/** An ease takes `BLEND_T` s, longer for a longer fly so the camera moves at most about `FLY_SPEED` m/s on average (to `BLEND_MAX` s). */
const BLEND_T = 0.9;
const FLY_SPEED = 12;
const BLEND_MAX = 3;
/** An eye further than this (m) from the camera's is cut to, not flown to. */
const CUT_FAR = 90;
/** The aim turns at most this fast (rad/s): a dummy passing under the eye would whip a free aim past 15 rad/s. */
const MAX_TURN = 4;
/** The follow frame turns at most this fast (rad/s) with the dummies' travel: a dummy leaving the group never swings the eye round the rest. */
const HEADING_RATE = 1.5;
/**
 * Windshield eye: ahead of the car by where the dummy will be when the slow-mo starts (`GLASS_LEAD` s of his throw
 * speed, the match phase's `THROW_ONSET`) plus `GLASS_STANDOFF` m, within `GLASS_REACH`; the nearer shares of that
 * and the heights over the ground (m) are tried in order, heights outermost.
 */
const GLASS_LEAD = 0.25;
const GLASS_STANDOFF = 6;
const GLASS_REACH = [7, 18] as const;
const GLASS_SHARE = [1, 0.8, 0.6] as const;
const GLASS_UP = [3, 4.5, 6.5] as const;
/** No spot clear: the nearest one is lifted by this much (m) until it is, at most this many times. */
const GLASS_LIFT = 1.5;
const GLASS_LIFTS = 8;

type RideShot = "glass" | "follow" | "trackside";
/** What a ride frame did: `none` no ride, `shot` the camera is placed, `held` the user's orbit has it (aim: `RideCam.look`). */
export type RideFrame = "none" | "shot" | "held";

/** One frame's framing, from the dummies: their heads' centre, spread (m) and mean flat velocity (`n` of them). */
type Framing = {
  c: THREE.Vector3;
  spread: number;
  n: number;
  vx: number;
  vz: number;
  /** Always behind and never trackside (the range: its signs read down the throw). */
  hold: boolean;
  /** The user's drag holds the camera (`ChaseCamera.rideHeld`). */
  held: boolean;
  /** This frame's dummy is a new pick: cut to it. */
  cut: boolean;
  /** The scene's lens (deg). */
  lens: number;
  /** The scene's solids, read only when a shot is picked. */
  sight: () => Sight;
};

const _p = new THREE.Vector3();

export class RideCam {
  shot: RideShot = "follow";
  /** The aim, eased toward the dummies' heads; the orbit looks at it while the user holds the camera. */
  readonly look = new THREE.Vector3();
  readonly framing: Framing = { c: new THREE.Vector3(), spread: 0, n: 1, vx: 0, vz: 0, hold: false, held: false, cut: false, lens: 50, sight: () => ({ ground: activeGround(), path: null, wallTop: 0, rim: Infinity, occ: [] }) };
  /** The shot's eye (smoothed for the follow shot, fixed for the others). */
  private readonly pos = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  /** Flat travel direction of the dummies, kept while they are slow. */
  private readonly dir = new THREE.Vector3(0, 0, 1);
  /** Ahead (1) or behind (-1), alternating per ride. */
  private side = -1;
  private age = 0;
  private fresh = false;
  private resume = false;
  /** The ease from `from` to the shot: 0 at a change, 1 when done, over `blendT` s. */
  private blend = 1;
  private blendT = BLEND_T;
  private readonly from = new THREE.Vector3();
  private readonly fromQ = new THREE.Quaternion();
  /** The aim's orientation, turned toward the look-at at most `MAX_TURN` rad/s (a dummy flying past the eye cannot whip it). */
  private readonly aimQ = new THREE.Quaternion();
  private snap = true;
  private readonly exitAt = new THREE.Vector3();
  private readonly exitFwd = new THREE.Vector3();
  private reach = 0;
  /** Bearing (rad, atan2(x, z)) of `dir`. */
  private heading = 0;
  private readonly cine = new CineCam();
  private readonly probe = new THREE.PerspectiveCamera();
  private readonly subject: Subject = { group: { position: new THREE.Vector3() }, velocity: new THREE.Vector3(), fwdFlat: this.dir };

  /** A ride starts. `car`: the thrown driver's car and `speed` his flat throw speed (the windshield shot, ahead of it on its forward axis); null: straight to the follow shot. */
  begin(car: Pick<Subject, "group" | "fwdFlat"> | null, speed: number): void {
    this.side = -this.side;
    this.fresh = true;
    this.resume = false;
    if (car) {
      this.exitAt.copy(car.group.position);
      this.reach = THREE.MathUtils.clamp(speed * GLASS_LEAD + GLASS_STANDOFF, GLASS_REACH[0], GLASS_REACH[1]);
      this.exitFwd.copy(car.fwdFlat).setY(0).normalize();
      this.dir.copy(this.exitFwd);
      this.heading = Math.atan2(this.exitFwd.x, this.exitFwd.z);
    }
    this.shot = car ? "glass" : "follow";
  }

  /** Turn `dir` toward the dummies' travel (kept while they are slow), at most `HEADING_RATE`; `snap`: at once. */
  private turn(f: Framing, dt: number, snap: boolean): void {
    if (Math.hypot(f.vx, f.vz) <= 0.5 * f.n) return;
    const d = wrapPi(Math.atan2(f.vx, f.vz) - this.heading);
    const max = HEADING_RATE * dt;
    this.heading += snap ? d : THREE.MathUtils.clamp(d, -max, max);
    this.dir.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  /** Place `camera` for this frame's framing (the user's orbit has it when `f.held`). */
  update(camera: THREE.PerspectiveCamera, dt: number, f: Framing): RideFrame {
    this.turn(f, dt, this.fresh || f.cut);
    if (this.fresh) {
      // The ride's first frame is a cut (to the windshield).
      this.fresh = false;
      this.enter(f, this.shot);
      this.blend = 1;
    } else if (f.cut) {
      this.change(camera, f, "follow");
    }
    this.look.lerp(f.c, 1 - Math.exp(-12 * dt));
    if (f.held) {
      this.resume = true;
      return "held";
    }
    if (this.resume) {
      // The dummies moved on while the user held the camera: ease from his view to the shot as it stands now.
      this.resume = false;
      this.snap = true;
      if (this.shot === "follow") this.followEye(this.pos, f);
      this.startBlend(camera);
    }
    this.age += dt;
    this.rotate(camera, dt, f);
    this.place(camera, dt, f);
    return "shot";
  }

  /** Ease from the camera's pose to the shot's (`pos`, already set), unless it is across the field. */
  private startBlend(camera: THREE.PerspectiveCamera): void {
    this.from.copy(camera.position);
    this.fromQ.copy(camera.quaternion);
    const fly = this.from.distanceTo(this.pos);
    this.blend = fly > CUT_FAR ? 1 : 0;
    this.blendT = THREE.MathUtils.clamp(fly / FLY_SPEED, BLEND_T, BLEND_MAX);
  }

  /** Cut to `shot`, easing from where the camera is (unless the user holds it: the return from the orbit eases then). */
  private change(camera: THREE.PerspectiveCamera, f: Framing, shot: RideShot): void {
    this.enter(f, shot);
    if (!f.held) this.startBlend(camera);
  }

  private enter(f: Framing, shot: RideShot): void {
    this.shot = shot;
    this.age = 0;
    this.look.copy(f.c);
    this.snap = true;
    if (shot === "glass") this.pickGlass(f);
    else if (shot === "follow") {
      this.followEye(this.pos, f);
      this.cine.reset();
    } else this.pos.copy(this.eye);
  }

  /** The shot rotation: windshield, then follow, with a trackside turn after each follow (not in a `hold`). */
  private rotate(camera: THREE.PerspectiveCamera, dt: number, f: Framing): void {
    if (this.shot === "glass") {
      if (this.age > GLASS_T) this.change(camera, f, "follow");
      return;
    }
    if (f.hold) return;
    if (this.shot === "follow") {
      if (this.age > FOLLOW_T && this.track(f, dt)) {
        this.eye.copy(this.cine.eye);
        this.change(camera, f, "trackside");
      }
      return;
    }
    // The cine cam picked another spot (the dummy passed the eye, or the shot ran out): back to following.
    if (!this.track(f, dt) || this.age > TRACK_T || !this.cine.eye.equals(this.eye)) this.change(camera, f, "follow");
  }

  /** Step the trackside cam on the dummies; false while it has no clear spot. */
  private track(f: Framing, dt: number): boolean {
    this.subject.group.position.set(f.c.x, f.c.y - CINE.aimUp, f.c.z);
    this.subject.velocity.set(f.vx / f.n, 0, f.vz / f.n);
    return this.cine.update(this.probe, this.subject, f.sight, dt);
  }

  private place(camera: THREE.PerspectiveCamera, dt: number, f: Framing): void {
    if (this.shot === "follow") this.pos.lerp(this.followEye(_p, f), 1 - Math.exp(-5 * dt));
    camera.position.copy(this.pos);
    camera.lookAt(this.look);
    if (this.snap) this.aimQ.copy(camera.quaternion);
    else this.aimQ.rotateTowards(camera.quaternion, MAX_TURN * dt);
    this.snap = false;
    camera.quaternion.copy(this.aimQ);
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / this.blendT);
      const b = this.blend;
      const w = b * b * b * (b * (b * 6 - 15) + 10);
      camera.position.lerpVectors(this.from, this.pos, w);
      camera.quaternion.slerpQuaternions(this.fromQ, this.aimQ, w);
    }
    easeFov(camera, this.shot === "trackside" ? this.probe.fov : f.lens, dt);
  }

  /** The follow shot's eye: ahead of or behind the heads' travel, to the side and up, over the ground. */
  private followEye(out: THREE.Vector3, f: Framing): THREE.Vector3 {
    const back = (BACK + f.spread * 1.6) * (f.hold ? -1 : this.side);
    const side = SIDE + f.spread * 0.5;
    const d = this.dir;
    out.set(f.c.x + d.x * back - d.z * side, f.c.y + UP + f.spread * 0.4, f.c.z + d.z * back + d.x * side);
    const ground = activeGround().heightAt(out.x, out.z);
    if (Number.isFinite(ground)) out.y = Math.max(out.y, ground + 0.6);
    return out;
  }

  /** The windshield eye: the first spot ahead of the car on its forward axis that stands clear and sees the heads. */
  private pickGlass(f: Framing): void {
    const s = f.sight();
    const at = this.exitAt;
    const fwd = this.exitFwd;
    for (const up of GLASS_UP) {
      for (const share of GLASS_SHARE) {
        const ahead = this.reach * share;
        const x = at.x + fwd.x * ahead;
        const z = at.z + fwd.z * ahead;
        const g = s.ground.heightAt(x, z, at.y + 1);
        if (g === NO_FLOOR) continue;
        const y = g + up;
        if (solid(s, x, y, z, CINE.pad) || sightLine(s, x, y, z, f.c.x, f.c.y, f.c.z) < 0) continue;
        this.pos.set(x, y, z);
        return;
      }
    }
    // Nothing clear: the nearest spot, lifted out of whatever holds it.
    const x = at.x + fwd.x * this.reach * GLASS_SHARE[2];
    const z = at.z + fwd.z * this.reach * GLASS_SHARE[2];
    const g = s.ground.heightAt(x, z, at.y + 1);
    let y = Math.max(at.y, Number.isFinite(g) ? g : at.y) + GLASS_UP[2];
    for (let i = 0; i < GLASS_LIFTS && solid(s, x, y, z, CINE.pad); i++) y += GLASS_LIFT;
    this.pos.set(x, y, z);
  }
}
