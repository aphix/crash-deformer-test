import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { hypot3 } from "../kernel/physics-core.js";
import { RideCam, type RideFrame } from "./ride-cam.ts";
import type { Sight } from "./spectate-cam.ts";
import { blendPose, type Doll } from "./ragdoll-body.ts";
import { SLOTS } from "./ragdoll-config.ts";

/** Seconds a dummy lies still before the ride lets go of him (`RideCam` places the shots). */
const CAM_STILL = 1.5;
/**
 * The dummies within this (m) of the primary one share its shot. At the widest it pulls back to about 15 m, where a
 * 1.7 m dummy still fills about 1/8 of the 50° frame's height.
 */
const CAM_NEAR = 6;
/** Torso speed (m/s) by which the watched car's driver wins the pick of the primary dummy. */
const CAM_TIE = 1;

const _q = new THREE.Quaternion();
const _r = new THREE.Vector3();

/** The ride-along camera over the dummies (`RagdollSystem` owns them): which one it frames, and the shot (`RideCam`). */
export class RideAlong {
  /** On from `follow` until every dummy out lies still. */
  riding = false;
  /** The car whose driver was thrown last: the ride opens on its windshield. */
  private exitCar = -1;
  /** His flat throw speed (m/s): how far ahead the windshield eye stands. */
  private exitSpeed = 0;
  /** The point he left the car from: the windshield eye must see it (`RideCam.begin`). */
  private readonly exitPane = new THREE.Vector3();
  /** The dummy slot the ride frames, -1 before its first pick. */
  private primary = -1;
  /** The framed dummies' heads, this frame. */
  private readonly heads = Array.from({ length: SLOTS }, () => new THREE.Vector3());
  readonly cam = new RideCam();

  /** A driver was thrown from car `car` at `at`, flat speed `speed`: the next ride opens on that windshield. */
  exit(car: number, speed: number, at: THREE.Vector3): void {
    this.exitCar = car;
    this.exitSpeed = speed;
    this.exitPane.copy(at);
  }

  /** A new run: no ride. */
  reset(): void {
    this.riding = false;
    this.cam.leave(null);
  }

  /**
   * Ride along with the dummies thrown: the camera opens on the windshield of the car the driver left, then frames
   * one dummy at a time (and any near it), cutting to the next one still moving as each comes to rest, until they all
   * lie still. A driver thrown while it rides, out of its shot (further than `CAM_NEAR` from the heads it frames), is the
   * moment now: it opens again on his windshield, framing him. `d`: the latest throw's dummy, in slot `slot`.
   */
  follow(d: Doll | undefined, slot: number, cars: readonly DeformableCar[]): void {
    const c = this.cam.framing.c;
    // Drivers thrown in the same frame (a head-on's two) open one ride: a far one counts once the ride has framed.
    const away = this.riding && !this.cam.fresh && d !== undefined && d.live && hypot3(d.cur[0]! - c.x, d.cur[1]! - c.y, d.cur[2]! - c.z) > CAM_NEAR;
    if (!this.riding || away) {
      this.cam.begin(cars[this.exitCar] ?? null, this.exitSpeed, this.exitPane);
      this.primary = away ? slot : -1;
    }
    this.riding = true;
  }

  /**
   * Place `camera` on the dummies being followed (`RideCam`'s shots): "none" when none is (the engine's own camera
   * runs), "held" when the user's orbit has the camera (`held`; the dummies are still tracked, no cut to another
   * while this one is out). It frames a primary dummy (the fastest still moving; the `watched` car's driver within
   * `CAM_TIE`) with any others within `CAM_NEAR` of it, and cuts to the next one once it lies still: drivers flung
   * far apart are each shown in turn, never all at once from a camera pulled back to fit them. `hold`: keep watching
   * once they lie still, always from behind (the range: its signs read down the throw, and it shows where its driver
   * came to rest). `lens`: the scene's lens (deg); `sight`: the scene's solids (the windshield and trackside eyes
   * stand clear of them). The dummies are drawn `alpha` of the way between their last two steps. `lead` (s, the minigames
   * pass it): the aim runs that much of the dummies' velocity ahead of their heads, so a fast climber stays framed (`RideCam`).
   */
  frame(dolls: readonly Doll[], alpha: number, camera: THREE.PerspectiveCamera, wallDt: number, hold: boolean, watched: number, held: boolean, lens: number, sight: () => Sight, lead = 0): RideFrame {
    if (!this.riding) return "none";
    const keep = hold || held;
    let cut = false;
    if (!this.framed(dolls[this.primary], keep)) {
      // The first pick, or a cut to the next dummy.
      cut = this.primary >= 0;
      let best = -Infinity;
      for (let s = 0; s < dolls.length; s++) {
        const d = dolls[s]!;
        if (!this.framed(d, keep)) continue;
        const score = hypot3(d.vel[0]!, d.vel[1]!, d.vel[2]!) + (d.car === watched ? CAM_TIE : 0);
        if (score <= best) continue;
        best = score;
        this.primary = s;
      }
      if (best === -Infinity) {
        this.riding = false;
        this.cam.leave(camera);
        return "none";
      }
    }
    const primaryDoll = dolls[this.primary]!;
    blendPose(primaryDoll.prev, primaryDoll.cur, 7, alpha, _r, _q);
    // The primary and every framed dummy near it: the centre of their heads, pulled back to fit their spread.
    let n = 0;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    const f = this.cam.framing;
    const c = f.c.set(0, 0, 0);
    for (const d of dolls) {
      if (!this.framed(d, keep)) continue;
      blendPose(d.prev, d.cur, 7, alpha, this.heads[n]!, _q);
      if (_r.distanceTo(this.heads[n]!) > CAM_NEAR) continue;
      c.add(this.heads[n]!);
      vx += d.vel[0]!;
      vy += d.vel[1]!;
      vz += d.vel[2]!;
      n++;
    }
    c.multiplyScalar(1 / n);
    let spread = 0;
    for (let k = 0; k < n; k++) spread = Math.max(spread, this.heads[k]!.distanceTo(c));
    f.spread = Math.min(spread, CAM_NEAR);
    f.n = n;
    f.vx = vx;
    f.vy = vy;
    f.vz = vz;
    f.hold = hold;
    f.held = held;
    f.cut = cut;
    f.lens = lens;
    f.sight = sight;
    f.lead = lead;
    return this.cam.update(camera, wallDt, f);
  }

  /** Is dummy `d` out and in the ride's shot: one it may frame, still moving, or (`hold`) anywhere out? */
  private framed(d: Doll | undefined, hold: boolean): d is Doll {
    return d !== undefined && d.live && d.rides && (hold || d.still <= CAM_STILL);
  }
}
