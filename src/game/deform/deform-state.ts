import * as THREE from "three";
import { computeNormalsFast } from "./fast-normals.ts";
import { activeGround } from "../world/ground.ts";
import {
  round4,
  vec3,
  applyGroundFriction,
  clampSpeed,
  CRASH,
  forceTransfer,
  hypot2,
} from "./physics-util.ts";
import type { BodyPartName } from "../kernel/rig-spec.ts";
import { DeformParticleHelper, DeformRigHelper } from "./deform-helper.ts";
import { CRUSH_HULLS, HULLS, type Hull } from "./hulls.ts";
import { DeformHit } from "./deform-hit.ts";
import type { Beam, MassNode } from "./deform-rig.ts";
import { CageStrain, maxCompression, sensorsByPart } from "./cage-measure.ts";

/** Packed bumper-to-block-centre length (m): bumper beam and radiator crushed flat ahead of a
 *  0.36 m block. Nose crush past the 0.84 m rest gap minus this shoves the engine back. */
export const ENGINE_PACK_GAP = 0.54;

/** How far (m) a single nose hit's dynamic crush peaks short of its stroke: single 48–54 km/h hits at
 *  squash 0.32 and 0.4 all peak the block at the stroke's reach (stroke − 0.30) minus 0.06 ± 0.01 m. */
const STROKE_SHORTFALL = 0.06;
/** Tyre (m): radius along the car (TYRE_REACH's 0.32) and half-width across it, for the faces' hub contact. */
export const TYRE_R = 0.32;
/** A face that shoves a planted hub this far (m, one wheel diameter) off its rest tears the wheel off. */
export const WHEEL_DIAMETER = 2 * TYRE_R;
/** Throttle input this recent (s) still counts as "under power" for the settle rule. */
export const POWER_HOLD = 0.1;
/**
 * How long (s) after its last contact a hit can still pack the engine block: the springback of the crumple (a derby kill
 * measured up to 0.3 s after its last contact). Past it the block's drift in the frame is the frame's: a wreck whose frame
 * lies on the ground's plane (`measurePose`) turns about the ground while its masses stay, and across a crest the cabin 0.55 m up
 * read 0.1 m "back" and killed the engine of a car hit softly 30 s before.
 */
const PACK_QUIET = 0.35;
/** Quiet time (s) past which a wreck is planted: its frame moves from the cell onto its hubs (`measurePose`) and its hubs stop being clamped (`clampLocal`). */
export const PLANT_QUIET = 0.2;
/** Height (m) a planted hub's centre stands over the ground under it (`groundMasses`): its sphere's radius, 4 cm short of the tyre's. */
export const HUB_FLOOR = 0.28;
/** A hub this close (m) above its `HUB_FLOOR` still slides on the ground (dragGround). */
export const GROUND_SKIN = 0.08;
/** Half the span (m) the ground's slope under a drawn wheel is read over (`wheelLift`). */
const SLOPE_SPAN = 0.1;
/** Steepest gradient (34°, `measurePose`'s plane limit) a wheel is lifted for: a lip or wall under it is no slope. */
const MAX_GRADE = 0.68;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _panelCo = new Float64Array(24);
const _mat = new THREE.Matrix4();

/**
 * The trilinear cage map as a polynomial in (u, v, w): 8 coefficients per axis at `out[o + axis * 8]`
 * (A, Bu, Bv, Bw, Euv, Euw, Evw, H). Corner bits: 0 = u (x), 1 = v (y), 2 = w (z).
 */
export function cageCoeffs(c: THREE.Vector3[], out: Float64Array, o: number): void {
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
export function cageAxis(co: Float64Array, o: number, u: number, v: number, w: number): number {
  return co[o]! + u * co[o + 1]! + v * (co[o + 2]! + u * co[o + 4]!) + w * (co[o + 3]! + u * co[o + 5]! + v * (co[o + 6]! + u * co[o + 7]!));
}

/** Write one live hull, or its rest hull (`fallback`) when any extent is non-finite. */
function setHull(h: Hull, fallback: Hull, cx: number, cz: number, hx: number, hz: number): void {
  const ok = Number.isFinite(cx) && Number.isFinite(cz) && Number.isFinite(hx) && Number.isFinite(hz);
  h.cx = ok ? cx : fallback.cx;
  h.cz = ok ? cz : fallback.cz;
  h.hx = ok ? hx : fallback.hx;
  h.hz = ok ? hz : fallback.hz;
}

/**
 * Mass and hub queries and kicks, ground drag, the drivetrain, crush weights, the frame update, live hulls, the
 * debug helpers and measurements.
 */
export abstract class DeformState extends DeformHit {
  /** Defined by a later layer. */
  protected abstract bakeLocalSkin(): void;
  protected abstract hitStroke(): number;
  protected abstract pullSensorsFromMasses(dt: number): void;
  protected abstract skin(geometry: THREE.BufferGeometry): void;
  protected abstract solveCages(): void;
  /** Per mass (by `MassNode.index`), the beams that end on it, in beam order: rest-only, like `skinRest`. */
  private readonly massBeams = this.masses.map((_, mi) => this.beams.flatMap((b, bi) => (b.a === mi || b.b === mi ? [bi] : [])));

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
    const len = hypot2(m.shoveX, m.shoveZ);
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
    // Airborne (no hub within GROUND_SKIN of its HUB_FLOOR over the ground): nothing to slide on.
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
    if (low > HUB_FLOOR + GROUND_SKIN) return;
    const mu = CRASH.muSlide * (0.35 + amount * 1.25) * grip;
    for (const m of this.masses) {
      if (!m.dynamic) continue;
      applyGroundFriction(m.vel, dt, mu, true);
    }
  }

  /**
   * How far up (m, vertical) a wreck's drawn wheel stands over its hub at world (`x`, `y`, `z`) so the tyre rests on
   * the ground there: a planted hub is `HUB_FLOOR` over the ground, a tyre `TYRE_R` in radius `TYRE_R·√(1 + g²)` over a
   * slope of gradient g. The slope is the ground's under that hub, not the frame's: across a crest the rear and front
   * tyres lie on slopes 10° apart. Drawn on its hub the tyre sat 4 cm in the road (6 cm on −20°).
   */
  wheelLift(x: number, y: number, z: number): number {
    const ground = activeGround();
    const gx = (ground.heightAt(x + SLOPE_SPAN, z, y) - ground.heightAt(x - SLOPE_SPAN, z, y)) / (2 * SLOPE_SPAN);
    const gz = (ground.heightAt(x, z + SLOPE_SPAN, y) - ground.heightAt(x, z - SLOPE_SPAN, y)) / (2 * SLOPE_SPAN);
    const g2 = gx * gx + gz * gz;
    return TYRE_R * Math.sqrt(1 + (Number.isFinite(g2) ? Math.min(g2, MAX_GRADE ** 2) : 0)) - HUB_FLOOR;
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
   * dead block. `local` is the frame's: a live car's group sits on the cell, but a planted wreck's sits on
   * its hubs, so the cell's held offset in it (a flank scrape leaves the cabin 0.05–0.09 m back of the
   * wheels) is not the block's travel.
   */
  updateDrivetrain(): void {
    if (!this.drivetrainAlive || !this.massActive || this.quietTime() > PACK_QUIET) return;
    const el = this.at.engineL;
    const er = this.at.engineR;
    // Only the block's travel along the car toward the cabin packs it into the firewall (measured along
    // the hit, a 45° corner counted the nose's sideways shove and killed at 52 km/h, below the
    // front-middle's 56). It counts whatever the current hit's direction: a side or rear hit on a nose an
    // earlier hit had packed returned early or measured the other way, and derby cars ran 0.25 m back alive.
    const noseHit = this.hitSpeed >= 0 && -this.impactInward.z > Math.abs(this.impactInward.x);
    // Outside a nose hit the block is read against the cabin, and only in a frame that sits on it (live, to
    // PLANT_QUIET). A touch that woke a planted wreck moved the frame from its hubs onto the cell, and the block
    // read the cabin's 0.05 m offset as travel (62-66 mm on the stunt crest, nothing near the block); the replant
    // after the touch pulled the cell 11 mm back against its cap in the hub frame, and the block read that. A nose
    // hit's calibrated kills (measured up to PACK_QUIET) ride on the cabin's shove in whatever frame the wreck is in.
    // What counts is the read less that offset, floored at zero; a block read forward stays as read, as before (the
    // wear kill below sums it as slack).
    const back = Math.max(el.rest.z - el.local.z, er.rest.z - er.local.z);
    let counted = 0;
    if (noseHit) counted = back;
    else if (this.quietTime() <= PLANT_QUIET) counted = back - Math.max(0, this.at.cell.rest.z - this.at.cell.local.z);
    let travel = Math.min(back, Math.max(0, counted));
    // A rear hit has to cross the cabin to get here: its push along the hit counts too, so the same travel
    // kills a nose around 50 km/h and a tail much later. A side hit shoves the block sideways only.
    if (this.impactInward.z > Math.abs(this.impactInward.x)) travel = Math.max(travel, el.local.z - el.rest.z, er.local.z - er.rest.z);
    // A nose hit moves the block as far as one hit at the nose's energy-equivalent speed (Σ EBS², rearmHit)
    // reaches: the stroke past the crumple, less a single hit's dynamic shortfall. A first hit counts its
    // geometric peak up to that, which kept single-hit kills monotone (0.4: 49.5 km/h peaked 0.155 m and
    // died, 50 km/h 0.139 m lived). A re-armed hit counts it outright: its own peak rides the packed nose's
    // springback and the clip, so three 35 km/h hits killed on the 4th at squash 0.32 (0.128 m at 60 km/h
    // equivalent) and on the 2nd at 0.4 (0.154 m at 49 km/h).
    if (noseHit) {
      const crumple = Math.min(this.at.bumperFL.rest.z, this.at.bumperFR.rest.z) - Math.max(el.rest.z, er.rest.z) - ENGINE_PACK_GAP;
      const energy = this.hitStroke() - crumple - STROKE_SHORTFALL;
      travel = this.rearmed ? energy : Math.min(travel, energy);
    }
    if (travel > this.engineTravel) this.engineTravel = travel;
    if (travel / this.killTravel + this.wreckShare() > 1) this.drivetrainAlive = false;
  }

  /** Share of `wreckEnergy` the hits so far have worn. */
  private wreckShare(): number {
    return this.wear / this.wreckEnergy;
  }

  /** 0–1 drivability of the engine block: 1 untouched, 0 dead (graded damage for the handling model). */
  get drivetrainHealth(): number {
    return this.drivetrainAlive ? THREE.MathUtils.clamp(1 - this.engineTravel / this.killTravel - this.wreckShare(), 0, 1) : 0;
  }

  /** Wheels still on their hubs (0–4). */
  get wheelsOn(): number {
    return (this.at.hubFL.popped ? 0 : 1) + (this.at.hubFR.popped ? 0 : 1) + (this.at.hubRL.popped ? 0 : 1) + (this.at.hubRR.popped ? 0 : 1);
  }

  /** Which wheels are still on their hubs, as bits: 1 front left, 2 front right, 4 rear left, 8 rear right (`vehicle/wheel-loss.ts`). */
  get wheelsOnMask(): number {
    return (this.at.hubFL.popped ? 0 : 1) | (this.at.hubFR.popped ? 0 : 2) | (this.at.hubRL.popped ? 0 : 4) | (this.at.hubRR.popped ? 0 : 8);
  }

  private massByName(name: string): MassNode {
    return this.byName.get(name) ?? this.at.cell;
  }

  /** How much of this mass belongs to the crumple zone facing the impact (0 = cell, 1 = bumper). */
  protected crumpleWeight(m: MassNode): number {
    if (m.name === "cell" || m.name === "roof") return 0;
    if (m.hub) return 0;
    const along = -(m.rest.x * this.impactInward.x + m.rest.z * this.impactInward.z);
    // A bumper is the facing crumple zone only at the struck end: the far end's bumpers ride with the cabin.
    if (m.bumper) return along > 0 ? 1 : 0;
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
    const own = this.massBeams[m.index]!;
    for (let k = 0; k < own.length; k++) {
      const beam = this.beams[own[k]!]!;
      const other = beam.a === m.index ? this.masses[beam.b]! : this.masses[beam.a]!;
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
    for (let mi = 0; mi < this.masses.length; mi++) {
      const m = this.masses[mi]!;
      const w = this.impactWeight(m);
      if (w < 0.05) continue;
      sum += this.nodeTransfer(m) * w;
      wsum += w;
    }
    return wsum > 1e-6 ? sum / wsum : 0.1;
  }

  /** 1 at the hit corner, ~0 on the opposite side of the same axle. */
  protected cornerWeight(m: MassNode): number {
    const hitX = this.impactLocal.x;
    if (hitX !== this.massCornerX) this.fillCornerWeights(hitX);
    return this.massCornerW[m.index]!;
  }

  /** `cornerWeight` of every mass for a hit at car-frame x `hitX`: it reads nothing else, and `exp` per mass per call was 6% of a derby-32 frame. */
  private fillCornerWeights(hitX: number): void {
    for (let mi = 0; mi < this.masses.length; mi++) {
      const m = this.masses[mi]!;
      if (Math.abs(hitX) < 0.2) {
        this.massCornerW[mi] = 1;
        continue;
      }
      const lat = Math.abs(m.rest.x - hitX);
      const hitSide = Math.sign(hitX);
      const nodeSide = Math.sign(m.rest.x);
      const opposite = nodeSide !== 0 && nodeSide !== hitSide;
      this.massCornerW[mi] = Math.exp(-lat * (opposite ? 4.6 : 1.8)) * (opposite ? 0.06 : 1);
    }
    this.massCornerX = hitX;
  }

  protected impactWeight(m: MassNode): number {
    const far = m.rest.x * this.impactInward.x + m.rest.z * this.impactInward.z;
    if (!this.bidirectional && far > 0.18) return 0;
    return this.crumpleWeight(m) * this.cornerWeight(m);
  }

  protected isCageBeam(beam: Beam): boolean {
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

  /**
   * One fixed step of the crush: the sensors follow the masses, and the hit's window closes (here, in sim time, never
   * by the frame rate). With `solve`, the skin's solve (cluster fit, cage corners) is redone from them too: the glass
   * reads the cages' strain. Without it the solve waits for the next frame (`update`); the mesh write is always the
   * frame's. Called once per fixed step (`settleStep`): a part's tear, a lamp's break and the glass depended on how often
   * the renderer drew, and a replay drew at another rate than the live sim it re-ran.
   */
  stepCrush(dt: number, solve: boolean): void {
    if (this.crushing) {
      this.pullSensorsFromMasses(dt);

      let maxC = 0;
      for (const s of this.sensors) if (s.compression > maxC) maxC = s.compression;
      this.crushAmount = maxC;
      this.wrinkleAmp = THREE.MathUtils.clamp(maxC * (0.2 + this.buckle * 0.5), 0, 0.18 + this.buckle * 0.5);
      this.skinDue = true;
      // Plastic leftover (maxC) is not "still crushing". Keep skinning while
      // masses are live or contact is fresh — otherwise we rewrite the mesh
      // from a jittering polar every frame (flicker) and pay computeVertexNormals
      // through the slomo→1× handoff (hitch).
      // Contact window only. Residual bounce / cluster breathing is not crush —
      // reskinning it every frame is the polar snap-back flicker.
      this.crushing = this.bidirectional || this.quietTime() < 0.28;
      // Window closed with a deferred skin: write it at the next frame, from this solve — the pose an
      // always-skinned car freezes on. Later state drifts (cm), so a late catch-up would not match.
      if (!this.crushing) this.skinFinal = true;
    } else if (this.loadDirty[0] !== 0) {
      // Load crush baked into the masses (`bakeLoadCrush`) with no crash window open: skin once from them.
      this.loadDirty[0] = 0;
      this.skinDue = true;
    }
    if (solve) this.solveSkin();
  }

  /** The skin's solve from the masses as they are, if the crush has moved since the last one; the mesh write is owed. */
  private solveSkin(): void {
    if (!this.skinDue) return;
    this.skinDue = false;
    this.bakeLocalSkin();
    this.solveCages();
    this.skinOwed = true;
  }

  /** Per frame: solve what the steps left unsolved and write the mesh (a deferred skin waits unless the crush just ended). */
  update(geometry: THREE.BufferGeometry): void {
    this.skinnedThisFrame = false;
    this.solveSkin();
    if (this.skinOwed && (!this.skinDeferred || this.skinFinal)) {
      this.skinFinal = false;
      this.flushSkin(geometry);
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

  liveHulls(): Hull[] {
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

    const out = this.hullBuf;
    setHull(out[0]!, HULLS[0]!, (hubFL.local.x + engineL.local.x) * 0.5, (zFront + zFrontBack) * 0.5, 0.32, hzF);
    setHull(out[1]!, HULLS[1]!, (hubFR.local.x + engineR.local.x) * 0.5, (zFront + zFrontBack) * 0.5, 0.32, hzF);
    setHull(out[2]!, HULLS[2]!, cell.local.x, (zFrontBack + zRearFront) * 0.5, midHx, Math.max(0.12, (zFrontBack - zRearFront) * 0.5));
    setHull(out[3]!, HULLS[3]!, (hubRL.local.x + axleR.local.x) * 0.5, (zRear + zRearFront) * 0.5, 0.32, hzR);
    setHull(out[4]!, HULLS[4]!, (hubRR.local.x + axleR.local.x) * 0.5, (zRear + zRearFront) * 0.5, 0.32, hzR);
    return out;
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

    const out = this.crushHullBuf;
    setHull(out[0]!, CRUSH_HULLS[0]!, fl.local.x * 0.85, (zFront + zFrontBack) * 0.5, 0.34, hzF);
    setHull(out[1]!, CRUSH_HULLS[1]!, fr.local.x * 0.85, (zFront + zFrontBack) * 0.5, 0.34, hzF);
    setHull(out[2]!, CRUSH_HULLS[2]!, cell.local.x, (zFrontBack + zRearFront) * 0.5, midHx, Math.max(0.12, (zFrontBack - zRearFront) * 0.5));
    setHull(out[3]!, CRUSH_HULLS[3]!, rl.local.x * 0.85, (zRear + zRearFront) * 0.5, 0.34, hzR);
    setHull(out[4]!, CRUSH_HULLS[4]!, rr.local.x * 0.85, (zRear + zRearFront) * 0.5, 0.34, hzR);
    return out;
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

  /** The sensors that read each cage, by cage name (built on first use). */
  private sensorsOfPart: Record<string, Int32Array> | null = null;
  private readonly strain = new CageStrain();

  partCompression(name: BodyPartName): number {
    this.sensorsOfPart ??= sensorsByPart(this.cages, this.sensors);
    return maxCompression(this.sensors, this.sensorsOfPart[name]);
  }

  /** A cage's frame strain (m): the largest change of any corner-to-corner distance from rest. Rigid motion reads 0 (`CageStrain`). */
  cageStrain(name: BodyPartName): number {
    const cage = this.cageByPart.get(name);
    return cage ? this.strain.measure(cage) : 0;
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
}
