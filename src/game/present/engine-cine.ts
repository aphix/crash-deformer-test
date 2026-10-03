import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { DRIVE } from "../vehicle/car-drive.ts";
import type { ChaseCamera } from "./engine-camera.ts";
import { TireSmokeSystem, type GlassDotSystem, type SparkSystem } from "./engine-fx.ts";
import { SkidMarks } from "./engine-marks.ts";
import { PostFX, type FxTier } from "./engine-post.ts";

/** Mark-map edge (texels) per tier: 2048 over the 96 m sandbox is 4.7 cm a texel. */
const MARK_RES: Record<FxTier, number> = { off: 0, minimal: 1024, low: 1024, high: 2048 };

/** Per-frame speed change (m/s) of one car that counts as a hit, and where it is full strength. */
const HIT_DV = 4.5;
const HIT_FULL = 14;
/** Hit-stop: wall seconds of near-freeze on the driven car's big hits, and the sim rate during it. */
const HIT_STOP = 0.09;
const HIT_STOP_SCALE = 0.05;

/** Crash cam: cut times (wall s after the first impact) for the three replay angles, then hand back. */
const CUTS = [1.3, 2.9, 4.5, 6.1] as const;
/** Wall s after the impact when the crash cam hands the camera back (`direct` false again). */
export const CRASH_CAM_END = CUTS[3];

const DUST = new THREE.Color(0.78, 0.64, 0.46);
const TURF = new THREE.Color(0.5, 0.58, 0.36);

const _v = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
/** Tyre smoke rises free; it never bounces. */
const NO_BOUNCE = (): void => {};

type FxRefs = { sparks: SparkSystem; glass: GlassDotSystem };

/**
 * Cinematic director: the quality tier, the post chain, the tyre-mark map and every effect that only reads
 * sim state: impact punch (shake, FOV kick, flash, chromatic split), hit-stop on the driven car's big hits,
 * the Burnout-style crash cam (three cut angles in slow-mo, letterboxed), boost radial blur, tyre smoke
 * and hub-scrape sparks from wheel slip. Reduced motion: no shake, flash, punch, blur or camera moves.
 */
export class Cinematics {
  readonly post: PostFX;
  readonly marks: SkidMarks;
  /** Thin wide tyre smoke, separate from the dense crash plumes. */
  readonly tyreSmoke: TireSmokeSystem;
  private tierNow: FxTier = "off";
  private readonly renderer: THREE.WebGLRenderer;
  private readonly view: ChaseCamera;
  private readonly fx: FxRefs;
  private readonly reduceMotion: boolean;
  private readonly pvx: Float32Array;
  private readonly pvz: Float32Array;
  private readonly hitCool: Float32Array;
  private readonly smokeAcc: Float32Array;
  private readonly sparkAcc: Float32Array;
  private havePrev = false;
  private hitStop = 0;
  private flash = 0;
  private punch = 0;
  /** Wall seconds into the crash cam; < 0 when it is not running. */
  private camT = -1;
  private readonly camAt = new THREE.Vector3();
  private readonly camN = new THREE.Vector3(1, 0, 0);

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, view: ChaseCamera, fx: FxRefs, maxCars: number, reduceMotion: boolean) {
    this.renderer = renderer;
    this.view = view;
    this.fx = fx;
    this.reduceMotion = reduceMotion;
    this.post = new PostFX(renderer);
    this.marks = new SkidMarks(maxCars);
    this.tyreSmoke = new TireSmokeSystem(scene, 360, true);
    this.pvx = new Float32Array(maxCars);
    this.pvz = new Float32Array(maxCars);
    this.hitCool = new Float32Array(maxCars);
    this.smokeAcc = new Float32Array(maxCars * 4);
    this.sparkAcc = new Float32Array(maxCars * 4);
  }

  get tier(): FxTier {
    return this.tierNow;
  }

  setTier(tier: FxTier): void {
    this.tierNow = tier;
    this.post.setTier(tier);
    this.marks.setResolution(MARK_RES[tier]);
    const on = tier !== "off";
    // Streaks and over-bright glow are for the bloom; the canvas-only tiers draw plain dots.
    const bloom = tier === "low" || tier === "high";
    this.fx.sparks.streaked = bloom;
    this.fx.sparks.glow(bloom ? 2.6 : 1);
    this.fx.glass.glow(bloom ? 1.8 : 1);
    if (!on) this.reset();
  }

  /** Sim time multiplier for this frame: below 1 during a hit-stop. */
  get timeWarp(): number {
    return this.hitStop > 0 ? HIT_STOP_SCALE : 1;
  }

  /** The crash cam is on: its letterbox and replay cuts, from the first impact until it hands back. */
  get directing(): boolean {
    return this.camT >= 0;
  }

  /** Scene reset: wipe marks, drop the crash cam and hit history. */
  reset(): void {
    this.marks.clear();
    this.havePrev = false;
    this.hitStop = 0;
    this.flash = 0;
    this.punch = 0;
    this.camT = -1;
    this.post.flash = 0;
    this.post.punch = 0;
    this.post.radial = 0;
    this.post.letterbox = 0;
    this.smokeAcc.fill(0);
    this.sparkAcc.fill(0);
    this.tyreSmoke.reset();
  }

  /** The first big impact of a crash run (fleet / barrier): punch, FOV kick and, unless the user framed the shot, the crash cam. */
  impact(contact: THREE.Vector3, normal: THREE.Vector3, impulse: number, crashCam: boolean): void {
    if (this.tierNow === "off") return;
    const k = THREE.MathUtils.clamp(impulse / 30, 0.35, 1);
    this.kick(k);
    if (!crashCam) return;
    this.camAt.set(contact.x, 0.55, contact.z);
    this.camN.set(normal.x, 0, normal.z);
    if (this.camN.lengthSq() < 1e-6) this.camN.set(1, 0, 0);
    this.camN.normalize();
    this.camT = 0;
  }

  /**
   * After the physics and FX steps: hits from each car's velocity jump, tyre marks / smoke / scrape sparks
   * from wheel slip, boost blur for the driven car, and the decay of every punch value.
   */
  update(wallDt: number, simDt: number, cars: readonly DeformableCar[], followed: DeformableCar | null, driving: boolean, fxDensity: number): void {
    if (this.tierNow === "off") return;
    this.hitStop = Math.max(0, this.hitStop - wallDt);
    if (simDt > 1e-5) this.detectHits(cars, followed, driving, wallDt);
    this.marks.update(cars, simDt);
    if (this.marks.slipping) this.emitSlipFx(cars.length, wallDt, fxDensity);
    this.tyreSmoke.update(Math.max(simDt, wallDt * 0.6), NO_BOUNCE, this.view.camera);

    this.flash = Math.max(0, this.flash - wallDt * 4);
    this.punch = Math.max(0, this.punch - wallDt * 2.2);
    const calm = this.reduceMotion;
    this.post.flash = calm ? 0 : this.flash;
    this.post.punch = calm ? 0 : this.punch;
    let radial = 0;
    if (!calm && driving && followed) {
      radial = THREE.MathUtils.clamp((followed.speed - DRIVE.maxFwd * 1.02) / (DRIVE.maxFwd * 0.4), 0, 1) * 0.05;
    }
    this.post.radial += (radial - this.post.radial) * Math.min(1, wallDt * 6);
  }

  /** The crash cam is on a cut (not just letterboxing in or out): it holds the camera this frame. */
  get cutting(): boolean {
    return this.camT >= CUTS[0] && this.camT < CUTS[3];
  }

  /** Crash cam: takes the camera for the replay cuts. False when the orbit / chase camera should run. */
  direct(camera: THREE.PerspectiveCamera, wallDt: number, allowed: boolean): boolean {
    if (this.camT < 0) return false;
    if (!allowed) this.camT = -1;
    else this.camT += wallDt;
    const t = this.camT;
    const box = t < 0 ? 0 : t < CUTS[0] ? THREE.MathUtils.clamp(t / 0.4, 0, 1) : t < CUTS[3] ? 1 : Math.max(0, 1 - (t - CUTS[3]) / 0.5);
    this.post.letterbox = box;
    if (t < 0 || t >= CUTS[3] + 0.5) {
      this.camT = -1;
      this.post.letterbox = 0;
      return false;
    }
    if (t < CUTS[0] || t >= CUTS[3]) return false;
    const at = this.camAt;
    const n = this.camN;
    _side.crossVectors(n, _up);
    const drift = this.reduceMotion ? 0 : 1;
    let fov: number;
    if (t < CUTS[1]) {
      // Bumper cam: low and side-on to the impact axis, creeping along it.
      const u = (t - CUTS[0]) * drift;
      camera.position.copy(at).addScaledVector(_side, 5.4).addScaledVector(n, -1.1 + u * 0.4);
      camera.position.y = 0.32;
      fov = 34;
    } else if (t < CUTS[2]) {
      // Crane: high over the wreck, turning slowly.
      const a = Math.atan2(_side.x, _side.z) + 0.7 + (t - CUTS[1]) * 0.22 * drift;
      camera.position.set(at.x + Math.sin(a) * 6.5, 7.2, at.z + Math.cos(a) * 6.5);
      fov = 46;
    } else {
      // Long lens from a quarter angle, panning a touch.
      _v.copy(_side).multiplyScalar(0.72).addScaledVector(n, -0.7).normalize();
      camera.position.copy(at).addScaledVector(_v, 19).addScaledVector(_side, (t - CUTS[2]) * 0.6 * drift);
      camera.position.y = 1.5;
      fov = 21;
    }
    camera.lookAt(at);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    return true;
  }

  /** Stamp the mark map, then draw the frame through the post chain. */
  render(scene: THREE.Scene, camera: THREE.Camera, wallDt: number): void {
    this.marks.flush(this.renderer, wallDt);
    this.post.render(scene, camera);
  }

  dispose(): void {
    this.post.dispose();
    this.marks.dispose();
    this.tyreSmoke.dispose();
  }

  private kick(k: number): void {
    this.flash = Math.max(this.flash, 0.55 * k);
    this.punch = Math.max(this.punch, k);
    if (this.reduceMotion) return;
    this.view.trauma = Math.max(this.view.trauma, 0.35 + 0.55 * k);
    const cam = this.view.camera;
    cam.fov += 7 * k;
    cam.updateProjectionMatrix();
  }

  private detectHits(cars: readonly DeformableCar[], followed: DeformableCar | null, driving: boolean, wallDt: number): void {
    const n = Math.min(cars.length, this.pvx.length);
    for (let i = 0; i < n; i++) {
      const v = cars[i]!.velocity;
      const dv = Math.hypot(v.x - this.pvx[i]!, v.z - this.pvz[i]!);
      this.pvx[i] = v.x;
      this.pvz[i] = v.z;
      this.hitCool[i] = Math.max(0, this.hitCool[i]! - wallDt);
      if (!this.havePrev || dv < HIT_DV || this.hitCool[i]! > 0) continue;
      const k = THREE.MathUtils.clamp((dv - HIT_DV) / (HIT_FULL - HIT_DV), 0, 1);
      const mine = cars[i] === followed;
      if (!mine && (followed || k < 0.5)) continue;
      this.hitCool[i] = 0.3;
      this.kick(mine ? 0.3 + 0.7 * k : 0.25 * k);
      if (mine && driving && k > 0.3) this.hitStop = HIT_STOP;
    }
    this.havePrev = true;
  }

  /** Tyre smoke from every slipping wheel (surface-tinted) and sparks off a scraping hub. */
  private emitSlipFx(nCars: number, wallDt: number, fxDensity: number): void {
    const w = this.marks.wheels;
    const slots = Math.min(nCars * 4, w.slip.length);
    for (let s = 0; s < slots; s++) {
      const slip = w.slip[s]!;
      if (slip < 0.2) {
        this.smokeAcc[s] = 0;
        continue;
      }
      _v.set(w.px[s]!, 0.14, w.pz[s]!);
      this.smokeAcc[s]! += slip * slip * wallDt * 60 * fxDensity;
      if (this.smokeAcc[s]! >= 1) {
        const count = this.smokeAcc[s]! | 0;
        this.smokeAcc[s]! -= count;
        const ch = w.channel[s]!;
        _side.set(w.vx[s]!, 0, w.vz[s]!);
        this.tyreSmoke.emitAt(_v, _side, count, ch === 1 ? DUST : ch === 2 ? TURF : undefined);
      }
      if (!w.scrape[s]) continue;
      this.sparkAcc[s]! += wallDt * 70 * fxDensity;
      if (this.sparkAcc[s]! < 1) continue;
      const count = this.sparkAcc[s]! | 0;
      this.sparkAcc[s]! -= count;
      _side.set(w.vx[s]!, 0, w.vz[s]!).normalize();
      _v.y = 0.05;
      this.fx.sparks.poof(_v, _side, count);
    }
  }
}
