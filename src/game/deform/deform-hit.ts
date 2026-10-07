import * as THREE from "three";
import { clampSpeed, hypot2 } from "./physics-util.ts";
import { resetCluster } from "./shape-match.ts";
import { BodyFit } from "./body-fit.ts";
import { DeformRig, type DeformMode, type MassNode } from "./deform-rig.ts";
import { FACES, FACE_AXIS } from "./load-crush.ts";

/** Most (m/s) a wheel freed by the plant may slide off the body's speed (`seatHubs`). */
const HUB_SLIP = 8;
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
const _r = new THREE.Vector3();
/** `seatHubs`' spin sums (it resets and fills them). */
const _fit = new BodyFit();
/** A position-only pass's start (`driftFrom`): the centroid x, z; and its end (`settleDrift`): centroid x, z then mean velocity x, z. */
const _driftFrom = new Float64Array(2);
const _driftNow = new Float64Array(4);

/**
 * Reset and mode, the shape-match rest, kinematic binding, crush start and re-arm, and impulses into the masses.
 */
export abstract class DeformHit extends DeformRig {
  /** Defined by a later layer. */
  protected abstract crumpleWeight(m: MassNode): number;
  protected abstract frontTransfer(): number;
  protected abstract hitStroke(): number;
  protected abstract sampleGround(floor: Float64Array, grip: Float64Array | null): void;
  abstract crumpleTravelCorner(): number;

  /**
   * A world slice of `dt` seconds begins. Its pair pushes, sphere shifts, structure step, re-fits and wall translations
   * share one `PushBudget` window: `stepStructure` advances the sim clock the window was keyed by, and everything after
   * the pushes (the structure step, the re-fits, the bowl clip) was debited to the NEXT slice's, on top of a full cap.
   */
  beginSlice(dt: number): void {
    this.sliceDt = dt;
    this.sliceTouch = 0;
    if (this.massActive) this.sliceAt = this.elapsed;
    else {
      this.sliceAt = -1.5;
      this.push.reset();
    }
  }

  endSlice(): void {
    this.sliceAt = -1.5;
  }

  /** The `PushBudget` window now. */
  protected budgetAt(): number {
    return this.sliceAt < 0 ? this.elapsed : this.sliceAt;
  }

  /** The masses' centroid and mean velocity (x, z) into `out[0..3]`. */
  private meanInto(out: Float64Array): void {
    let x = 0;
    let z = 0;
    let vx = 0;
    let vz = 0;
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      x += m.world.x * m.mass;
      z += m.world.z * m.mass;
      vx += m.vel.x * m.mass;
      vz += m.vel.z * m.mass;
    }
    const inv = 1 / this.totalMass;
    out[0] = x * inv;
    out[1] = z * inv;
    out[2] = vx * inv;
    out[3] = vz * inv;
  }

  /** Two cars' masses touch: each notes the other's speed, what the re-fits that follow may move its centroid with. */
  protected noteTouch(other: DeformHit): void {
    this.meanInto(_driftNow);
    const mine = hypot2(_driftNow[2]!, _driftNow[3]!);
    other.meanInto(_driftNow);
    this.sliceTouch = Math.max(this.sliceTouch, hypot2(_driftNow[2]!, _driftNow[3]!));
    other.sliceTouch = Math.max(other.sliceTouch, mine);
  }

  /** A pass that moves positions alone (the structure step, a clamp's re-fit) begins: where the centroid is. */
  protected driftFrom(): void {
    this.meanInto(_driftNow);
    _driftFrom[0] = _driftNow[0]!;
    _driftFrom[1] = _driftNow[1]!;
  }

  /**
   * The pass ends. Its move of the centroid beyond `dt` of the masses' own velocity is a position correction, and takes
   * from the slice's budget (window `at`) as a pair push does: a re-fit after a 7 mm sphere shift moved a wreck 7 mm more,
   * the structure step 12 mm and a second re-fit 9 mm, all on top of the pushes' whole cap (derby `o6`, 17491eb). What the
   * budget does not allow is taken back, the wreck as one body: its shape is the pass's, its place is the slice's.
   */
  protected settleDrift(dt: number, at: number): void {
    this.meanInto(_driftNow);
    const vx = _driftNow[2]!;
    const vz = _driftNow[3]!;
    const dx = _driftNow[0]! - _driftFrom[0]! - vx * dt;
    const dz = _driftNow[1]! - _driftFrom[1]! - vz * dt;
    const drift = hypot2(dx, dz);
    if (!(drift > 1e-9)) return;
    const nx = dx / drift;
    const nz = dz / drift;
    const back = drift - this.push.settle(at, nx, nz, drift, this.sliceDt, Math.max(this.sliceTouch, hypot2(vx, vz)));
    if (back <= 1e-9) return;
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      m.world.x -= nx * back;
      m.world.z -= nz * back;
    }
  }
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
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      m.local.copy(m.rest);
      this.offsetByCrush(i, m.local, this.crushBaked);
      m.world.copy(m.local).applyMatrix4(group.matrixWorld);
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

  /** Mass `i`'s `local` moved inward by the face depths `depth` (m): each face pushes the masses that follow it (`loadW`). */
  private offsetByCrush(i: number, local: THREE.Vector3, depth: Float64Array): void {
    for (let f = 0; f < FACES; f++) {
      const d = depth[f]! * this.loadW[i * FACES + f]!;
      if (d === 0) continue;
      local.x -= FACE_AXIS[f * 3]! * d;
      local.y -= FACE_AXIS[f * 3 + 1]! * d;
      local.z -= FACE_AXIS[f * 3 + 2]! * d;
    }
  }

  /**
   * Bake the face depths that grew since the last bake into the masses of a body that is not simulating them (a
   * kinematic car, or a wreck in rigid flight), and mark the skin owed: `update` re-skins from the masses once.
   * `crushBaked` holds the growth while the masses take it, then the depths baked.
   */
  bakeLoadCrush(): void {
    if (this.massActive) return;
    let grew = false;
    for (let f = 0; f < FACES; f++) {
      const g = this.crush[f]! - this.crushBaked[f]!;
      this.crushBaked[f] = g;
      grew ||= g !== 0;
    }
    if (grew) {
      for (let i = 0; i < this.masses.length; i++) this.offsetByCrush(i, this.masses[i]!.local, this.crushBaked);
      this.loadDirty[0] = 1;
    }
    this.crushBaked.set(this.crush);
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
    this.leanAt = -Infinity;
    this.aloft = false;
    this.floorsFresh = false;
    this.frameY = group.position.y;
    this.frameAt = 0;
    this.frameVy = worldVel.y;
    this.snapImpactToNearestMass();
    for (const s of this.sensors) {
      s.target = 0;
      s.compression = 0;
      s.delay = 0;
      s.fired = false;
      s.pos.copy(s.rest);
    }
  }

  /**
   * Mark that a collision is still happening so settle/cutDrive stay off. Only a car whose masses run has a clock to mark:
   * `elapsed` stands still while they are idle, so a touch marked then (a wall, a prop or a ramp's flank, below a crash)
   * read "just touched" for good, in `collideWith` and the parts' touch timing, and no keyframe carries it for a car that is no wreck.
   */
  notifyContact(): void {
    if (this.massActive) this.lastContact = this.elapsed;
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
    // Base = damage as `clampLocal` reads it: `local − rest` in the frame the next followGroup keeps. Both modes
    // anchor on the held `local` (`measurePose`), so a quiet wreck's cell offset from its planted hubs (up to its
    // 0.12 m cap) stays in the frame when the touch ends the plant. A base taken cell-relative left that offset
    // in every mass's travel, and the first live clamp dragged the whole body back by it (0.1 m in one call,
    // derby seed 19 car 6 at 80.22 s).
    for (const m of this.masses) {
      m.baseX = m.local.x - m.rest.x;
      m.baseZ = m.local.z - m.rest.z;
      m.crushSet = 0;
    }
    return true;
  }

  /**
   * The wheels go free at no more than `HUB_SLIP` m/s off the body's own speed at the wheel (the centroid's plus the
   * spin's) when the plant starts. A hub written back every call keeps its own velocity, which went on taking contact
   * impulses with no position to show for them: 17–42 m/s against a body at 2 m/s at the plant of a derby pile
   * (seed 65), and the frame anchored on the hubs followed them 0.08 m a step. A hub within that of the body keeps its
   * speed (the calibrated slide of a struck car); measured off the centroid alone, a wreck turning 8 rad/s lost its wheels' share of L.
   */
  protected seatHubs(): void {
    const cell = this.at.cell;
    let vx = 0;
    let vz = 0;
    let cx = 0;
    let cz = 0;
    let mass = 0;
    _fit.reset();
    for (const m of this.masses) {
      if (!m.dynamic || m.hub) continue;
      vx += m.vel.x * m.mass;
      vz += m.vel.z * m.mass;
      cx += m.world.x * m.mass;
      cz += m.world.z * m.mass;
      mass += m.mass;
      _fit.addSpin(m.mass, m.world.x - cell.world.x, m.world.z - cell.world.z, m.vel.x, m.vel.z);
    }
    if (mass <= 0) return;
    vx /= mass;
    vz /= mass;
    cx /= mass;
    cz /= mass;
    const spin = _fit.spin();
    for (const m of this.masses) {
      if (!m.hub || m.popped || !m.dynamic) continue;
      // The body's own speed at the wheel: the centroid's plus the spin's (a turning wreck's wheels ride it).
      const bx = vx + spin * (m.world.z - cz);
      const bz = vz - spin * (m.world.x - cx);
      const sx = m.vel.x - bx;
      const sz = m.vel.z - bz;
      const slip = Math.hypot(sx, sz);
      if (slip <= HUB_SLIP) continue;
      m.vel.x = bx + (sx * HUB_SLIP) / slip;
      m.vel.z = bz + (sz * HUB_SLIP) / slip;
    }
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

  /**
   * Masses on without starting the crash cinematic (speed-bump hop, a wreck landing or struck in flight): each
   * where the group carries its `local` (a wreck's dents kept; `bindKinematic` keeps a driven car's at rest),
   * moving with the group's rigid motion (origin velocity `worldVel`, spin `worldOmega`). An attached hub stands on
   * its rest ride, where the body handing it over had its wheel (`wheelsAt`): a wreck's hubs kept the droop they flew
   * off with (7 cm), so landing on its tyres in the rigid step put them 7 cm deeper than its tyres, and the hub floor
   * lifted the frame by it in the slice the masses took it.
   */
  armMasses(group: THREE.Object3D, worldVel: THREE.Vector3, worldOmega: THREE.Vector3): void {
    if (this.massActive) return;
    this.massActive = true;
    group.updateWorldMatrix(false, false);
    const o = group.position;
    for (const m of this.masses) {
      if (m.hub && !m.popped) m.local.y = m.rest.y;
      m.world.copy(m.local).applyMatrix4(group.matrixWorld);
      m.vel.copy(worldVel).add(_r.subVectors(m.world, o).crossVectors(worldOmega, _r));
      m.dynamic = true;
    }
    this.prevYaw = Math.atan2(Math.sin(group.rotation.y), Math.cos(group.rotation.y));
    this.leanAt = -Infinity;
    this.aloft = false;
    // The first read lays the frame on the ground under its wheels: read with none (as the step after did), a quiet wreck
    // landing on a slope took the world's level for a slice, 0.07 m up, and its masses were pulled after it.
    this.takeAxes(group);
    this.sampleGround(this.floorPost, this.gripPost);
    this.floorsFresh = true;
    this.frameY = group.position.y;
    this.frameAt = this.elapsed;
    this.frameVy = worldVel.y;
  }

  /**
   * Masses just armed on a body whose flight (`stepFree`) already moved it `h` of the slice under way: back along their
   * velocities by that, which `stepStructure` then retakes (taken twice, a wreck touching another in flight fell at
   * twice its speed). `h` is 0 between slices.
   */
  unstep(h: number): void {
    for (const m of this.masses) m.world.addScaledVector(m.vel, -h);
    this.frameY -= this.frameVy * h;
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

  /** How far (m) the struck door has moved in from the cabin along this hit's inward axis (a hit on a flank). */
  private doorCrush(): number {
    const cell = this.at.cell;
    const door = this.impactInward.x > 0 ? this.at.doorL : this.at.doorR;
    return (door.local.x - cell.local.x - (door.rest.x - cell.rest.x)) * this.impactInward.x + (door.local.z - cell.local.z - (door.rest.z - cell.rest.z)) * this.impactInward.z;
  }

  /**
   * Share of hitStroke the struck face has crushed so far (0 untouched, 1 spent): the nose or tail on an end hit, and on a
   * side hit the struck door's travel inward from the cabin (the nose of a car hit on its flank is untouched by the hit).
   */
  strokeUsed(): number {
    if (Math.abs(this.impactInward.x) > Math.abs(this.impactInward.z)) return this.doorCrush() / Math.max(1e-3, this.hitStroke());
    const cell = this.at.cell;
    const rest =
      this.impactInward.z > 0
        ? cell.rest.z - Math.max(this.at.bumperRL.rest.z, this.at.bumperRR.rest.z)
        : Math.min(this.at.bumperFL.rest.z, this.at.bumperFR.rest.z) - cell.rest.z;
    return (rest - 0.36 - this.crumpleTravelCorner()) / Math.max(1e-3, this.hitStroke());
  }

  /** Crush travel (m) the struck face has left: the nose or tail's `crumpleTravelCorner` on an end hit, the door band less its crush on a flank. */
  faceTravel(): number {
    if (Math.abs(this.impactInward.x) > Math.abs(this.impactInward.z)) return Math.max(0, this.at.doorL.bands.max - this.doorCrush());
    return this.crumpleTravelCorner();
  }
}
