import * as THREE from "three";
import { clampSpeed, hypot2 } from "./physics-util.ts";
import { resetCluster } from "./shape-match.ts";
import { DeformRig, type DeformMode, type MassNode } from "./deform-rig.ts";

/** A wreck takes a new hit only after this long (s) without contact: spikes inside one hit never re-arm. */
const REARM_QUIET = 0.3;
/** Smallest EBS (m/s, 10 km/h) that counts as a new hit on a wreck: the IIHS low-speed bumper test's
 *  6 mph full-width impact, where bumper systems start taking damage (research 12). The old 6 m/s
 *  (22 km/h) floor dropped every car-car hit under 43 km/h closing (each car's EBS is about half the
 *  closing), so a derby's dozens of 25–40 km/h rams added nothing and a 90 s match killed 0–2 cars. */
const REARM_EBS = 2.8;
/** One hit's most wear (EBS², m²/s²; 6 m/s ≈ 22 km/h): a single hard hit is the engine travel's to
 *  judge, the wear counts how many hits a wreck has taken (`wreckEnergy`). */
const WEAR_HIT = 36;

/**
 * Reset and mode, the shape-match rest, kinematic binding, crush start and re-arm, and impulses into the masses.
 */
export abstract class DeformHit extends DeformRig {
  /** Defined by a later layer. */
  protected abstract crumpleWeight(m: MassNode): number;
  protected abstract frontTransfer(): number;
  protected abstract impactWeight(m: MassNode): number;

  /** Back to the car as built (`initRunState`, `rebuildRunStructures`); settings stay. */
  reset(): void {
    this.initRunState();
    this.rebuildRunStructures();
  }

  setMode(mode: DeformMode): void {
    this.mode = mode;
    this.helper?.syncMode();
  }

  /** Shape-match rest = the car-local rest pose; plastic state and warm starts cleared. */
  private captureShapeRest(): void {
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      const p = this.shapeParticles[i]!;
      p.x = m.rest.x;
      p.y = m.rest.y;
      p.z = m.rest.z;
      p.mass = m.mass;
    }
    for (const c of this.clusters) resetCluster(c, this.shapeParticles);
  }

  /** Shape-match rest = the current body-frame shape: Sp folds into the rest and resets to I. */
  protected rebaseShapeRest(): void {
    this.syncShapeFromMasses();
    for (const c of this.clusters) resetCluster(c, this.shapeParticles);
  }

  /**
   * Shape particles in the car body frame: the masses' world positions turned by the best
   * heading fit (bodyCos/bodySin about world up, through bodyC) of the shape-matched masses
   * onto their rest, so rest, plastic Sp, goals and the impact half-space all share car-local
   * axes at any heading. Up stays world up; pitch and roll are left to the clusters' R.
   */
  protected syncShapeFromMasses(): void {
    let cx = 0,
      cy = 0,
      cz = 0,
      rx = 0,
      ry = 0,
      rz = 0,
      ms = 0;
    for (let mi = 0; mi < this.masses.length; mi++) {
      const m = this.masses[mi]!;
      if (m.hub && !this.deepCrush) continue;
      cx += m.world.x * m.mass;
      cy += m.world.y * m.mass;
      cz += m.world.z * m.mass;
      rx += m.rest.x * m.mass;
      ry += m.rest.y * m.mass;
      rz += m.rest.z * m.mass;
      ms += m.mass;
    }
    ms = Math.max(ms, 1e-8);
    cx /= ms;
    cy /= ms;
    cz /= ms;
    rx /= ms;
    ry /= ms;
    rz /= ms;
    // max_θ tr(R_y(θ)ᵀ Σ m (x − c)(r − r_c)ᵀ) has the closed form θ = atan2(A02 − A20, A00 + A22).
    let sc = 0,
      ss = 0;
    for (let mi = 0; mi < this.masses.length; mi++) {
      const m = this.masses[mi]!;
      if (m.hub && !this.deepCrush) continue;
      const x = (m.world.x - cx) * m.mass,
        z = (m.world.z - cz) * m.mass;
      const u = m.rest.x - rx,
        w = m.rest.z - rz;
      sc += x * u + z * w;
      ss += x * w - z * u;
    }
    const len = hypot2(sc, ss);
    const c = len > 1e-9 ? sc / len : 1;
    const s = len > 1e-9 ? ss / len : 0;
    this.bodyCos = c;
    this.bodySin = s;
    this.bodyC.set(cx, cy, cz);
    this.bodyRestC.set(rx, ry, rz);
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      const p = this.shapeParticles[i]!;
      const x = m.world.x - cx,
        z = m.world.z - cz;
      p.x = c * x - s * z + rx;
      p.y = m.world.y - cy + ry;
      p.z = s * x + c * z + rz;
    }
  }

  /** Body-frame point → world, into `out` at offset `o` (inverse of syncShapeFromMasses). */
  protected bodyToWorld(x: number, y: number, z: number, out: Float64Array, o: number): void {
    const dx = x - this.bodyRestC.x,
      dz = z - this.bodyRestC.z;
    out[o] = this.bodyCos * dx + this.bodySin * dz + this.bodyC.x;
    out[o + 1] = y - this.bodyRestC.y + this.bodyC.y;
    out[o + 2] = this.bodyCos * dz - this.bodySin * dx + this.bodyC.z;
  }

  protected writeShapeToMasses(): void {
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      if (!m.dynamic) continue;
      if (m.hub && !m.popped && !this.deepCrush) continue;
      const p = this.shapeParticles[i]!;
      // bodyToWorld inlined: as a call it boxed p.x/y/z for every mass.
      const dx = p.x - this.bodyRestC.x,
        dz = p.z - this.bodyRestC.z;
      m.world.x = this.bodyCos * dx + this.bodySin * dz + this.bodyC.x;
      m.world.y = p.y - this.bodyRestC.y + this.bodyC.y;
      m.world.z = this.bodyCos * dz - this.bodySin * dx + this.bodyC.z;
      if (!Number.isFinite(m.world.x + m.world.y + m.world.z)) m.world.copy(m.rest);
      clampSpeed(m.vel);
    }
  }

  bindKinematic(group: THREE.Object3D, worldVel: THREE.Vector3, worldOmega: THREE.Vector3): void {
    group.updateWorldMatrix(false, false);
    const ox = group.position.x;
    const oz = group.position.z;
    for (const m of this.masses) {
      m.local.copy(m.rest);
      m.world.copy(m.rest).applyMatrix4(group.matrixWorld);
      m.vel.copy(worldVel);
      // v = ω × r with ω = (0, ωy, 0): yaw integrates as rotation.y += ωy·dt.
      const rx = m.world.x - ox;
      const rz = m.world.z - oz;
      m.vel.x += worldOmega.y * rz;
      m.vel.z -= worldOmega.y * rx;
      m.dynamic = false;
      m.crushSet = 0;
      m.baseX = 0;
      m.baseZ = 0;
    }
  }

  /** `impulse` drives FX and glass; `ebs` (equivalent barrier speed, m/s) sizes the crush. */
  beginCrush(
    localPoint: THREE.Vector3,
    localInward: THREE.Vector3,
    impulse: number,
    ebs: number,
    group: THREE.Object3D,
    worldVel: THREE.Vector3,
    worldOmega: THREE.Vector3,
  ): void {
    this.impactLocal.copy(localPoint);
    this.impactInward.copy(localInward).normalize();
    const clamped = THREE.MathUtils.clamp(impulse, 4, 70);
    if (this.hitSpeed < 0) {
      this.hitSpeed = THREE.MathUtils.clamp(ebs, 0, 70);
      this.endEbs2[this.struckEnd()] = this.hitSpeed * this.hitSpeed;
      this.wear = Math.min(this.hitSpeed * this.hitSpeed, WEAR_HIT);
    }
    this.impulse = clamped;
    this.crushing = true;
    this.massActive = true;
    this.elapsed = 0;
    this.lastContact = 0;
    this.hitAt = 0;
    this.cornerLow = Infinity;
    this.wrinkleAmp = 0;
    this.dirty = true;
    this.bindKinematic(group, worldVel, worldOmega);
    for (const m of this.masses) m.dynamic = true;
    this.captureShapeRest();
    this.prevYaw = Math.atan2(Math.sin(group.rotation.y), Math.cos(group.rotation.y));
    this.rateYaw = this.prevYaw;
    this.rateAt = 0;
    this.leanAt = -Infinity;
    this.snapImpactToNearestMass();
    for (const s of this.sensors) {
      s.target = 0;
      s.compression = 0;
      s.delay = 0;
      s.fired = false;
      s.pos.copy(s.rest);
    }
  }

  /** Mark that a collision is still happening so settle/cutDrive stay off. */
  notifyContact(): void {
    this.lastContact = this.elapsed;
  }

  quietTime(): number {
    return Math.max(0, this.elapsed - this.lastContact);
  }

  /**
   * A fresh contact on a wreck: after REARM_QUIET without contact, a hit of at least REARM_EBS takes
   * over the hit frame and adds its EBS² to the struck end, so repeated hard hits keep crushing (and
   * can reach the engine block) instead of reusing the first hit's stroke. False when the contact
   * belongs to the current hit or is too soft.
   */
  rearmHit(localPoint: THREE.Vector3, localInward: THREE.Vector3, impulse: number, ebs: number): boolean {
    if (!this.massActive || this.bidirectional || ebs < REARM_EBS || this.quietTime() < REARM_QUIET) return false;
    this.impactLocal.copy(localPoint);
    this.impactInward.copy(localInward).normalize();
    this.snapImpactToNearestMass();
    const end = this.struckEnd();
    const e = Math.min(ebs, 70);
    this.endEbs2[end] = this.endEbs2[end]! + e * e;
    this.wear += Math.min(e * e, WEAR_HIT);
    this.hitSpeed = Math.min(70, Math.sqrt(this.endEbs2[end]!));
    this.rearmed = true;
    this.impulse = THREE.MathUtils.clamp(impulse, 4, 70);
    this.crushing = true;
    this.dirty = true;
    this.lastContact = this.elapsed;
    this.hitAt = this.elapsed;
    this.cornerLow = Infinity;
    // Base = damage as the body frame sees it. A quiet wreck's group sits on its planted hubs, so
    // `local` here carries the cell's offset from them (up to its 0.12 m cap). The contact solve that
    // follows anchors the group on the cell, so a base taken raw pinned the cell 0.1 m off its own
    // anchor: every clampLocal moved it there, the next followGroup moved the group after it, and
    // derby wrecks crawled along the bowl rim at 30–90 m/s with no velocity behind it.
    const cell = this.at.cell;
    const cx = cell.local.x - cell.rest.x;
    const cz = cell.local.z - cell.rest.z;
    for (const m of this.masses) {
      m.baseX = m.local.x - m.rest.x - cx;
      m.baseZ = m.local.z - m.rest.z - cz;
      m.crushSet = 0;
    }
    return true;
  }

  /** End the current hit came in through: 0 front, 1 rear, 2 left (−x), 3 right (+x). */
  private struckEnd(): number {
    const ix = this.impactInward.x;
    const iz = this.impactInward.z;
    if (Math.abs(ix) > Math.abs(iz)) return ix > 0 ? 2 : 3;
    return iz < 0 ? 0 : 1;
  }

  /** Throttle held this step (applyDrive): a wreck under power is not parked by the settle rule. */
  notifyPower(): void {
    this.lastPower = this.elapsed;
  }

  /** Enable lattice masses without starting the crash cinematic (speed-bump hop). */
  armMasses(group: THREE.Object3D, worldVel: THREE.Vector3, worldOmega: THREE.Vector3): void {
    if (this.massActive) return;
    this.massActive = true;
    this.bindKinematic(group, worldVel, worldOmega);
    for (const m of this.masses) m.dynamic = true;
    this.prevYaw = Math.atan2(Math.sin(group.rotation.y), Math.cos(group.rotation.y));
    this.rateYaw = this.prevYaw;
    this.rateAt = this.elapsed;
    this.leanAt = -Infinity;
  }

  /**
   * Highlight replay: a wreck just restored from netplay state (`writeNetState`, which leaves its masses still)
   * carries on from there. Its current shape becomes the shape-match rest, so its dents stay, and every mass moves
   * with the body at `worldVel` turning at `worldOmega` (about up, as `bindKinematic`).
   */
  resumeWreck(group: THREE.Object3D, worldVel: THREE.Vector3, worldOmega: THREE.Vector3): void {
    if (!this.massActive) return;
    const ox = group.position.x;
    const oz = group.position.z;
    for (const m of this.masses) {
      m.vel.copy(worldVel);
      m.vel.x += worldOmega.y * (m.world.z - oz);
      m.vel.z -= worldOmega.y * (m.world.x - ox);
      m.dynamic = true;
    }
    this.rebaseShapeRest();
    this.prevYaw = Math.atan2(Math.sin(group.rotation.y), Math.cos(group.rotation.y));
    this.rateYaw = this.prevYaw;
    this.rateAt = this.elapsed;
    this.leanAt = -Infinity;
  }

  /** Pull impactLocal onto the nearest mass so L/R crush does not sit on the centerline. */
  private snapImpactToNearestMass(): void {
    // A true centerline hit must stay centered — snapping to bumperFL (first of
    // two equal distances) was turning every head-on into a left-corner crush.
    if (Math.abs(this.impactLocal.x) < 0.2) {
      let bestZ = this.impactLocal.z;
      let bestD = Infinity;
      for (const m of this.masses) {
        if (m.name === "cell" || m.name === "roof") continue;
        const dz = m.rest.z - this.impactLocal.z;
        const d = dz * dz + m.rest.x * m.rest.x * 0.15;
        if (d < bestD) {
          bestD = d;
          bestZ = m.rest.z;
        }
      }
      this.impactLocal.z = this.impactLocal.z * 0.28 + bestZ * 0.72;
      return;
    }
    let best: MassNode | null = null;
    let bestD = Infinity;
    const hitSide = Math.sign(this.impactLocal.x);
    for (const m of this.masses) {
      if (m.name === "cell" || m.name === "roof") continue;
      if (hitSide !== 0 && Math.sign(m.rest.x) !== 0 && Math.sign(m.rest.x) !== hitSide) continue;
      const dx = m.rest.x - this.impactLocal.x;
      const dz = m.rest.z - this.impactLocal.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    if (!best) return;
    this.impactLocal.x = this.impactLocal.x * 0.28 + best.rest.x * 0.72;
    this.impactLocal.z = this.impactLocal.z * 0.28 + best.rest.z * 0.72;
  }

  get totalMass(): number {
    return this._totalMass;
  }

  /**
   * Stopping impulse lands on the crumple face so the rear keeps piling in. The rear's transferred
   * share moves it as one body (equal Δv, momentum ∝ mass): spread per node it gave a 26 kg hub ten
   * times the cell's Δv, the pinned hubs and the clamped nose hid it, and the cell kept ~8 m/s into
   * the stopped car until the hubs planted and let it run 0.12 m up the nose (slow motion only).
   */
  applyImpulse(nx: number, ny: number, nz: number, j: number): void {
    if (!this.massActive || j === 0) return;
    const pass = this.frontTransfer();
    const masses = this.masses;
    const n = masses.length;
    const weights = this.impulseW;
    let wsum = 0;
    let down = 0;
    let downMass = 0;
    for (let i = 0; i < n; i++) {
      const m = masses[i]!;
      if (!m.dynamic) {
        weights[i] = 0;
        continue;
      }
      const face = this.impactWeight(m);
      const downstream = Math.max(0, 1 - this.crumpleWeight(m)) * pass;
      // Face eats the hit; rear only sees the transferred fraction (0.1 / 0.5 / 0.62 / 1).
      weights[i] = face;
      wsum += face + downstream;
      down += downstream;
      downMass += downstream * m.mass;
    }
    if (wsum < 1e-6) {
      // Graze / unknown contact: fall back to the crumple face as a whole.
      for (let i = 0; i < n; i++) {
        const m = masses[i]!;
        if (!m.dynamic) continue;
        const w = this.crumpleWeight(m);
        weights[i] = w;
        wsum += w;
      }
    }
    if (wsum < 1e-6) return;
    const invW = 1 / wsum;
    const downDv = downMass > 1e-9 ? (j * down * invW) / downMass : 0;
    for (let i = 0; i < n; i++) {
      const m = masses[i]!;
      if (!m.dynamic) continue;
      const dv = (j * weights[i]! * invW) / m.mass + (downMass > 1e-9 ? Math.max(0, 1 - this.crumpleWeight(m)) * pass * downDv : 0);
      m.vel.x += nx * dv;
      m.vel.y += ny * dv;
      m.vel.z += nz * dv;
      clampSpeed(m.vel);
    }
  }
}
