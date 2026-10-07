import * as THREE from "three";
import { activeGround, NO_FLOOR } from "../world/ground.ts";
import {
  leftoverCrumple,
  applyGroundFriction,
  clampSpeed,
  CRASH,
  hypot2,
  hypot3,
} from "./physics-util.ts";
import {
  matchCluster,
  applyPlasticity,
  stiffnessIters,
  goalAlpha,
  deformBeta,
} from "./shape-match.ts";
import { DeformContact, ENGINE_SLACK } from "./deform-contact.ts";
import { HUB_OVERRUN, type MassNode } from "./deform-rig.ts";
import { FACE_TOP } from "./load-crush.ts";
import { ENGINE_PACK_GAP, HUB_FLOOR, POWER_HOLD, WHEEL_DIAMETER } from "./deform-state.ts";
import { resistYaw } from "./tyre-yaw.ts";
import { tiltedRise } from "./hub-plane.ts";
import { holdMomentum, holdPositions, turnVelocities, undoNetTurn } from "./turn-hold.ts";

/** Elastic part (m) of a crushed node's travel; the rest is permanent set. */
const SPRINGBACK = 0.08;
/** C4: a wheel separates only on an off-centre hit this hard (m/s EBS, 54 km/h)… */
const HUB_POP_MPS = 15;
/** …once the struck corner has crushed to within this of the hub (m): tyre radius 0.32 plus a 0.10 m
 *  packed bumper beam. With the 0.72 m overhang the wheel is reached after 0.30 m of corner crush. */
const TYRE_REACH = 0.42;
/** The hit speed (m/s EBS) from which a corner crushed to `HUB_OVERRUN` of its hub takes the wheel. */
const HUB_OVERRUN_MPS = 3;

const _a = new THREE.Vector3();
const _n = new THREE.Vector3();
/**
 * `clampMass`'s per-call doubles: [0] ix, [1] iz, [2] maxAway, [3] maxCrush, [4] stroke. Passed as arguments to
 * the out-of-line call, all five were boxed per mass.
 */
const _clamp = new Float64Array(5);
/** Slice rate the shape-match pulls (goalAlpha, contact alpha) and the step cap were tuned at. */
const SHAPE_REF_HZ = 240;
/** Largest goal step per SHAPE_REF_HZ slice (m): a 33.6 m/s pull limit. */
const SHAPE_MAX_STEP = 0.14;
/** Sim seconds a fed contact keeps the solver in contact mode: two 60 Hz frames. With one, the free
 *  solver (4 passes at α 0.64 at squash 0.32) closed a 100 km/h head-on's remaining shape gap in the
 *  slice after the tyres stopped both cars: bumpers 0.056 m with every mass at rest (limit 0.050). */
const CONTACT_HOLD = 2 / 60;

/** `clampMass`'s vertical travel cap (m): roof (more once a deep crush is on, and its load crush `sunk` already taken) and cabin floor, hubs, the rest. */
function maxLift(m: MassNode, deep: boolean, sunk: number): number {
  return m.name === "roof"
    ? (deep ? 0.28 : 0.07) + sunk
    : m.hub
      ? 0.07
      : m.name === "cell"
        ? deep
          ? 0.22
          : 0.06
        : 0.11;
}

/**
 * The mass solver: shape clamp, turn and momentum guards, beams, shape matching, the cabin fold, mass slices, ground and suspension.
 */
export abstract class DeformSolve extends DeformContact {

  protected clampLocal(group: THREE.Object3D): void {
    const ix = this.impactInward.x;
    const iz = this.impactInward.z;
    const maxAway = 0.025 + this.squash * 0.04;
    // A squeeze's relaxed shape limits stay until reset: clamping a squeezed shape back to the one-ended
    // limits when the squeeze ended popped the dents out (fire("all"): bumperFL 0.49 → 0.30 m in 1 s).
    // Only the squeeze's rules (origin pin, no planting, no re-arm) end with it.
    if (this.bidirectional) this.squeezeShape = true;
    if (this.deepCrush) this.deepShape = true;
    const squeeze = this.squeezeShape;
    const deep = this.deepShape;
    const maxCrush = squeeze ? 1.65 : 0.5 + this.squash * 1.15;
    // B1/B3/B4: a hit only crushes as far as its stroke reaches (armMasses has no hit).
    let stroke = Infinity;
    if (this.hitSpeed >= 0) {
      this.measureStroke();
      stroke = this.strokeOut[0]!;
    }
    const sideHit = Math.abs(ix) > Math.abs(iz);
    this.yawMomentum(0, false);
    const pinned = !this.deepCrush && this.quietTime() > 0.2;
    // A squeeze's plates pin the shape in the world frame and planted tyres pin a quiet wreck: both keep
    // the plain write-back. Undoing its turn on a planted wreck turned the body against its hubs each
    // call and let a capped door drift 36–118 µm off its cap (left piston 60–80 km/h).
    const unturn = !squeeze && !pinned;
    if (!squeeze) this.holdTurn();
    _clamp[0] = ix;
    _clamp[1] = iz;
    _clamp[2] = maxAway;
    _clamp[3] = maxCrush;
    _clamp[4] = stroke;
    // The group's world matrix once for the masses below (`localToWorld` re-composed it and its parents for every mass).
    group.updateWorldMatrix(true, false);
    for (let i = 0; i < this.masses.length; i++) this.clampMass(this.masses[i]!, group, sideHit, pinned, squeeze, deep);
    this.settleHubStand(pinned);
    // A3: each mount caps its own side of the block, but the block is one casting; hold its rest
    // spacing in the frame the masses were just clamped into (T-bone struck car: engine gap error
    // 0.0106 m on 943ae5c). A squeeze keeps its per-mass caps (a held press: engineL sprang 444 → 363 mm).
    const eL = this.at.engineL;
    const eR = this.at.engineR;
    _a.subVectors(eR.local, eL.local);
    const gap = _a.length();
    if (!squeeze && gap > 1e-6) {
      _a.multiplyScalar((gap - eL.rest.distanceTo(eR.rest)) / gap / (eL.mass + eR.mass));
      eL.local.addScaledVector(_a, eR.mass);
      eR.local.addScaledVector(_a, -eL.mass);
      eL.world.copy(eL.local).applyMatrix4(group.matrixWorld);
      eR.world.copy(eR.local).applyMatrix4(group.matrixWorld);
    }
    // The write-back reshapes the wreck toward the frame; it must not turn it. Read off an axis that a
    // shove bent (engine → axle), the frame turned and the clamp turned the whole cloud after it with
    // no torque: derby seed 3 c4 0.45 rad in 0.15 s, seed 4 c8 0.78 rad, ΔL = 0. The frame follows the
    // cloud on the next read instead.
    if (unturn) this.undoTurn();
    else if (!squeeze) this.carryTurn();
    // The clamp moves positions only: writing back a crushing body (its front masses slower than its
    // rear) changed Σ m r × v, spin from nowhere (dump16 replay: clampLocal put +8.7 rad/s of L/I into
    // Khaki, −8.6 into Bronze). Hand back the angular momentum the masses had, as a rigid turn.
    this.yawMomentum(0, true);
    // A car on no wheels is out, like a dead engine.
    if (this.at.hubFL.popped && this.at.hubFR.popped && this.at.hubRL.popped && this.at.hubRR.popped) this.drivetrainAlive = false;
  }

  /** `clampLocal` for one mass (its doubles in `_clamp`): the far-side spring, lift, crush and lateral caps, the engine mounts and the hubs. */
  private clampMass(m: MassNode, group: THREE.Object3D, sideHit: boolean, pinned: boolean, squeeze: boolean, deep: boolean): void {
    const ix = _clamp[0]!;
    const iz = _clamp[1]!;
    const maxAway = _clamp[2]!;
    const maxCrush = _clamp[3]!;
    const stroke = _clamp[4]!;
    let dx = m.local.x - m.rest.x;
    let dy = m.local.y - m.rest.y;
    let dz = m.local.z - m.rest.z;
    // Earlier hits' damage stays put: the far-side spring and the crush/lateral caps below
    // measure only what the current hit adds on top of it.
    const bx = squeeze ? 0 : m.baseX;
    const bz = squeeze ? 0 : m.baseZ;
    const base = bx * ix + bz * iz;
    const along = dx * ix + dz * iz - base;
    const side = m.rest.x * ix + m.rest.z * iz;
    if (!squeeze && side > 0.12) {
      // Far side of the car: allow a little spring, never grow the shell.
      if (along > maxAway) {
        const extra = along - maxAway;
        m.local.x -= ix * extra;
        m.local.z -= iz * extra;
        dx = m.local.x - m.rest.x;
        dz = m.local.z - m.rest.z;
      }
      if (along < -maxAway * 2) {
        const extra = -along - maxAway * 2;
        m.local.x += ix * extra;
        m.local.z += iz * extra;
        dx = m.local.x - m.rest.x;
        dz = m.local.z - m.rest.z;
      }
    }
    const maxDy = maxLift(m, deep, this.crushBaked[FACE_TOP]!);
    dy = Math.max(-maxDy, Math.min(maxDy * 1.25, dy));
    const cw = squeeze ? 1 : this.cornerWeight(m);
    const latCap = squeeze ? 0.55 : 0.04 + cw * 0.07;
    if (squeeze || m.hub) {
      // A hub keeps at least the shove a face gave it, popped or not.
      const shove = m.hub ? hypot2(m.shoveX, m.shoveZ) : 0;
      const cap = m.name === "cell" || m.name === "roof" ? (deep ? 0.72 : 0.12) : m.hub ? Math.max(squeeze ? 0.95 : 0.38, shove) : maxCrush;
      const len = hypot2(dx, dz);
      if (len > cap) {
        const k = cap / len;
        dx *= k;
        dz *= k;
      }
      if (Math.abs(dx) > Math.max(latCap, Math.abs(m.shoveX))) dx = Math.sign(dx) * Math.max(latCap, Math.abs(m.shoveX));
      if (squeeze && !m.hub && m.name !== "cell") {
        // A squeezed shape keeps its set like a one-ended hit's: only the last SPRINGBACK of a
        // particle's distance change to the cell (shortened or bowed out) is elastic. Shape matching
        // and the cabin fold sprang fire("all")'s bumpers 0.10–0.46 m back out once the heads left.
        const c = this.at.cell;
        const rx = m.rest.x + dx - c.local.x;
        const ry = m.rest.y + dy - c.local.y;
        const rz = m.rest.z + dz - c.local.z;
        const len = hypot3(rx, ry, rz);
        const restLen = m.rest.distanceTo(c.rest);
        const dev = restLen - len;
        const set = m.crushSet;
        if (Math.abs(dev) - SPRINGBACK > Math.abs(set)) m.crushSet = dev - Math.sign(dev) * SPRINGBACK;
        // A bowed-out set holds only out of contact: a face still pressing may push the panel back in.
        else if (len > 1e-6 && (set > 0 ? dev < set : dev > set && this.quietTime() > 0.025)) {
          const k = (restLen - set) / len;
          dx = c.local.x + rx * k - m.rest.x;
          dy = c.local.y + ry * k - m.rest.y;
          dz = c.local.z + rz * k - m.rest.z;
        }
      }
    } else {
      // Hit frame: crush runs along impactInward, the rest of the planar travel is lateral. The
      // stroke is the struck end's total (rearmHit), so a node already crushed along it gets less.
      const cabin = m.name === "cell" || m.name === "roof";
      let cap = cabin ? (deep ? 0.72 : 0.12) : Math.min(maxCrush * (0.38 + 0.72 * cw), stroke);
      if (sideHit && (m.name === "doorL" || m.name === "doorR")) cap = Math.min(cap, m.bands.max);
      cap = Math.max(0, cap - Math.max(0, base));
      dx -= bx;
      dz -= bz;
      let along = dx * ix + dz * iz;
      let px = dx - along * ix;
      let pz = dz - along * iz;
      along = Math.max(-cap, Math.min(cap, along));
      if (!cabin && this.hitSpeed >= 0) {
        // Sheet metal keeps its set: only the last SPRINGBACK of crush is elastic.
        if (along - SPRINGBACK > m.crushSet) m.crushSet = along - SPRINGBACK;
        else if (along < m.crushSet) along = m.crushSet;
      }
      const perp = hypot2(px, pz);
      if (perp > latCap) {
        const k = latCap / perp;
        px *= k;
        pz *= k;
      }
      dx = along * ix + px + bx;
      dz = along * iz + pz + bz;
    }
    if ((m.name === "engineL" || m.name === "engineR") && !squeeze && !sideHit && iz < 0) dz = this.engineMountDz(m, dz, bz, stroke);
    if (m.hub && !deep) {
      if (!m.popped && this.hitSpeed >= HUB_OVERRUN_MPS) {
        const front = m.rest.z > 0;
        const corner = front ? (m.rest.x < 0 ? this.at.bumperFL : this.at.bumperFR) : m.rest.x < 0 ? this.at.bumperRL : this.at.bumperRR;
        const reach = Math.abs(corner.rest.z - m.rest.z);
        // C4: a hard off-centre hit whose struck corner has crushed onto the tyre pops it (a full-width hit loads the rails), as does any hit that overruns the hub.
        const crushed = (corner.local.x - corner.rest.x) * ix + (corner.local.z - corner.rest.z) * iz;
        const c4 = !sideHit && front === iz < 0 && this.hitSpeed >= HUB_POP_MPS && Math.abs(this.impactLocal.x) >= 0.2 && cw > 0.6 && crushed >= reach - TYRE_REACH;
        if (c4 || (front ? corner.rest.z - corner.local.z : corner.local.z - corner.rest.z) >= reach - HUB_OVERRUN) this.popHub(m);
      }
      if (!m.popped && hypot2(m.shoveX, m.shoveZ) > WHEEL_DIAMETER) this.popHub(m);
      if (!m.popped) {
        dx = m.shoveX;
        dz = m.shoveZ;
      }
    }
    m.local.x = m.rest.x + dx;
    m.local.y = m.rest.y + dy;
    m.local.z = m.rest.z + dz;
    if (squeeze) {
      const lim = Math.abs(m.rest.z) + 0.04;
      if (Math.abs(m.local.z) > lim) m.local.z = Math.sign(m.local.z || m.rest.z) * lim;
      if (this.deepCrush && this.mode === "lattice" && m.rail) {
        if (m.local.distanceTo(m.rest) < 0.22) m.local.z = m.rest.z * 0.67;
      }
    }
    // Planted tires are the world pin. Projecting them through a pitched
    // group was ratcheting the wreck backward every followGroup.
    if (m.hub && !m.popped && pinned) return;
    m.world.copy(m.local).applyMatrix4(group.matrixWorld);
  }

  /**
   * The engine block's z travel (`dz`) under a frontal hit: the mounts hold it (ENGINE_SLACK past earlier hits'
   * set, `bz`) until the crushed nose packs against it; the packed nose then shoves it back, as far as this hit's
   * stroke reaches. A floor at the stroke's reach let a 43 km/h hit creep the block 0.045 m with 0.58 m of nose left.
   */
  private engineMountDz(m: MassNode, dz: number, bz: number, stroke: number): number {
    const nose = Math.min(this.at.bumperFL.local.z, this.at.bumperFR.local.z);
    const pushed = nose - ENGINE_PACK_GAP - m.rest.z;
    const reach = Math.max(ENGINE_SLACK, stroke - (Math.min(this.at.bumperFL.rest.z, this.at.bumperFR.rest.z) - m.rest.z - ENGINE_PACK_GAP));
    const floor = Math.max(-reach, Math.min(Math.min(0, bz) - ENGINE_SLACK, pushed));
    if (dz < floor) dz = floor;
    if (dz > pushed) dz = pushed;
    return dz;
  }

  holdTurn(): void {
    holdPositions(this.masses, this.turnX, this.turnZ);
  }

  /** Undo the net turn that a position-only pass made since `holdTurn` (turn-hold.ts). */
  undoTurn(): void {
    undoNetTurn(this.masses, this.turnX, this.turnZ);
  }

  /** Keep the turn a pinned write-back made, and turn the masses' relative velocities with it (turn-hold.ts); `followGroup` reports it as spin. */
  protected carryTurn(): void {
    turnVelocities(this.masses, this.turnX, this.turnZ, this.keptTurn);
  }

  /** The masses' angular momentum about their centroid into `spinHeld[slot]`, or with `restore`, back to it as a rigid turn (turn-hold.ts). */
  protected yawMomentum(slot: number, restore: boolean): void {
    holdMomentum(this.masses, this.spinHeld, slot, restore);
  }

  private stepBeams(dt: number): void {
    for (let i = 0; i < this.beams.length; i++) {
      const beam = this.beams[i]!;
      if (!beam.alive) continue;
      const a = this.masses[beam.a]!;
      const b = this.masses[beam.b]!;
      _n.copy(b.world).sub(a.world);
      const len = _n.length();
      if (len < 1e-5) continue;
      if (len > beam.rest * 2.2) {
        beam.alive = false;
        continue;
      }
      _n.multiplyScalar(1 / len);
      const alongA = -(a.rest.x * this.impactInward.x + a.rest.z * this.impactInward.z);
      const alongB = -(b.rest.x * this.impactInward.x + b.rest.z * this.impactInward.z);
      const front = alongA >= alongB ? a : b;
      const outward = Math.abs(a.rest.z) >= Math.abs(b.rest.z) ? a : b;
      const pass = this.bidirectional ? this.nodeTransfer(outward) : this.nodeTransfer(front);
      const maxStretch = 1.12 + this.squash * 0.35;
      if (len > beam.rest * maxStretch) {
        const extra = len - beam.rest * maxStretch;
        const ima = a.dynamic ? 1 / a.mass : 0;
        const imb = b.dynamic ? 1 / b.mass : 0;
        const inv = ima + imb;
        if (inv > 1e-8) {
          if (a.dynamic) a.world.addScaledVector(_n, extra * (ima / inv));
          if (b.dynamic) b.world.addScaledVector(_n, -extra * (imb / inv));
        }
      }
      const relV = b.vel.dot(_n) - a.vel.dot(_n);
      const ext = len - beam.plastic;
      let f = 0;
      if (ext > 0) {
        f = beam.kTen * ext + beam.damp * relV;
      } else {
        f = (beam.yieldK * ext + beam.damp * relV) * pass;
        const sideA = a.rest.x * this.impactInward.x + a.rest.z * this.impactInward.z;
        const sideB = b.rest.x * this.impactInward.x + b.rest.z * this.impactInward.z;
        const farSide = !this.bidirectional && sideA > 0.12 && sideB > 0.12;
        if ((relV < 0 || this.bidirectional) && !farSide) {
          const minLen =
            this.deepCrush && this.isCageBeam(beam) ? Math.min(beam.minLen, beam.rest * 0.22) : beam.minLen;
          const shrink = -ext * Math.min(1, Math.max(dt * (this.deepCrush ? 14 : 8.5), 0.03 + this.squash * 0.06));
          beam.plastic = Math.max(minLen, beam.plastic - shrink);
        }
      }
      const ima = a.dynamic ? 1 / a.mass : 0;
      const imb = b.dynamic ? 1 / b.mass : 0;
      if (a.dynamic) a.vel.addScaledVector(_n, f * ima * dt);
      if (b.dynamic) b.vel.addScaledVector(_n, -f * imb * dt);
    }
  }

  private clusterBeta(ci: number, contacting: boolean): number {
    const absorb = this.clusterAbsorb[ci]!;
    if (this.squash < 0.03) return 0.04;
    // Müller T = (1-β)R + βA. High β is jelly stretch. Bugbear/Rajala: metal
    // wants rotation + plastic rest update, not a linear squash of the whole cell.
    if (contacting) return THREE.MathUtils.lerp(0.18 + this.squash * 0.22, 0.03, THREE.MathUtils.clamp(absorb, 0, 1));
    return deformBeta(this.squash) * (1 - absorb * 0.5);
  }

  private stepShapeMatch(dt: number): void {
    this.syncShapeFromMasses();
    this.shapeRan = true;
    const contacting = this.bidirectional || this.elapsed - this.contactAt <= CONTACT_HOLD;
    let comX = 0,
      comY = 0,
      comZ = 0,
      comM = 0;
    for (let i = 0; i < this.shapeParticles.length; i++) {
      const hub = this.masses[i]!;
      if (hub.hub && !this.deepCrush) continue;
      const p = this.shapeParticles[i]!;
      comX += p.x * p.mass;
      comY += p.y * p.mass;
      comZ += p.z * p.mass;
      comM += p.mass;
    }
    comM = Math.max(comM, 1e-8);
    for (let i = 0; i < this.shapeParticles.length; i++) {
      this.startX[i] = this.shapeParticles[i]!.x;
      this.startZ[i] = this.shapeParticles[i]!.z;
    }
    const alphaRef = contacting
      ? this.squash < 0.03
        ? 0.9
        : 0.32 + this.squash * 0.38
      : goalAlpha(this.squash);
    const iters = contacting ? 2 : stiffnessIters(this.squash);
    // alphaRef is the per-iteration pull at the SHAPE_REF_HZ slice: as a time constant
    // (x += (1 − e^{−h/τ})(g − x), XPBD's first-order form) the pull per sim second holds
    // at any slice length, so slow-mo and refresh rate leave the stiffness alone.
    const alpha = 1 - Math.pow(1 - alphaRef, dt * SHAPE_REF_HZ);
    const maxStep = SHAPE_MAX_STEP * dt * SHAPE_REF_HZ;
    const ix = this.impactInward.x;
    const iz = this.impactInward.z;
    for (let k = 0; k < iters; k++) {
      this.goalX.fill(0);
      this.goalY.fill(0);
      this.goalZ.fill(0);
      this.goalW.fill(0);
      for (let ci = 0; ci < this.clusters.length; ci++) {
        const c = this.clusters[ci]!;
        matchCluster(c, this.shapeParticles, this.clusterBeta(ci, contacting));
        const cw = 1;
        for (let i = 0; i < c.idx.length; i++) {
          const pi = c.idx[i]!;
          const gx = c.M[0]! * c.qx[i]! + c.M[1]! * c.qy[i]! + c.M[2]! * c.qz[i]! + c.cmx;
          const gy = c.M[3]! * c.qx[i]! + c.M[4]! * c.qy[i]! + c.M[5]! * c.qz[i]! + c.cmy;
          const gz = c.M[6]! * c.qx[i]! + c.M[7]! * c.qy[i]! + c.M[8]! * c.qz[i]! + c.cmz;
          this.goalX[pi]! += gx * cw;
          this.goalY[pi]! += gy * cw;
          this.goalZ[pi]! += gz * cw;
          this.goalW[pi]! += cw;
        }
      }
      const out = k === iters - 1 ? this.goalOut : null;
      out?.fill(NaN);
      for (let i = 0; i < this.shapeParticles.length; i++) {
        const p = this.shapeParticles[i]!;
        const hub = this.masses[i]!;
        if (hub.hub && !this.deepCrush) continue;
        const w = this.goalW[i]!;
        if (w < 1e-6) continue;
        let gx = this.goalX[i]! / w;
        let gy = this.goalY[i]! / w;
        let gz = this.goalZ[i]! / w;
        if (!Number.isFinite(gx + gy + gz)) continue;
        if (this.bidirectional) {
          gy = p.y;
          // Plates already pin the bumpers; don't let shape-match shove them deeper.
          // Cabin / rails must still be allowed to yield once the plates pass the hubs.
          if (hub.bumper && Math.abs(gz) < Math.abs(p.z)) gz = p.z;
        } else {
          const along = (gx - p.x) * ix + (gz - p.z) * iz;
          if (along < 0) {
            gx -= ix * along;
            gz -= iz * along;
          }
        }
        if (out) this.bodyToWorld(gx, gy, gz, out, i * 3);
        const ax0 = alpha * (gx - p.x);
        const ay0 = alpha * (gy - p.y);
        const az0 = alpha * (gz - p.z);
        const step = hypot3(ax0, ay0, az0);
        const kStep = step > maxStep ? maxStep / step : 1;
        const ax = ax0 * kStep;
        const ay = ay0 * kStep;
        const az = az0 * kStep;
        p.x += ax;
        p.y += ay;
        p.z += az;
      }
    }
    // Internal goals exert no net torque: remove the correction's spin about up (no hub, wheel
    // or ground restores yaw, so overlapping plastic rests would otherwise turn the wreck).
    const cx = comX / comM,
      cz = comZ / comM;
    let spin = 0,
      inertia = 0;
    for (let i = 0; i < this.shapeParticles.length; i++) {
      if (this.masses[i]!.hub && !this.deepCrush) continue;
      const p = this.shapeParticles[i]!;
      const rx = this.startX[i]! - cx,
        rz = this.startZ[i]! - cz;
      spin += p.mass * (rz * (p.x - this.startX[i]!) - rx * (p.z - this.startZ[i]!));
      inertia += p.mass * (rx * rx + rz * rz);
    }
    const w = inertia > 1e-8 ? spin / inertia : 0;
    if (Math.abs(w) > 1e-12) {
      for (let i = 0; i < this.shapeParticles.length; i++) {
        if (this.masses[i]!.hub && !this.deepCrush) continue;
        const p = this.shapeParticles[i]!;
        p.x -= w * (this.startZ[i]! - cz);
        p.z += w * (this.startX[i]! - cx);
      }
    }
    if (!contacting) {
      let comX1 = 0,
        comY1 = 0,
        comZ1 = 0;
      for (let i = 0; i < this.shapeParticles.length; i++) {
        const hub = this.masses[i]!;
        if (hub.hub && !this.deepCrush) continue;
        const p = this.shapeParticles[i]!;
        comX1 += p.x * p.mass;
        comY1 += p.y * p.mass;
        comZ1 += p.z * p.mass;
      }
      const dx = (comX - comX1) / comM;
      const dy = (comY - comY1) / comM;
      const dz = (comZ - comZ1) / comM;
      if (dx * dx + dy * dy + dz * dz > 1e-16) {
        for (let i = 0; i < this.shapeParticles.length; i++) {
          const hub = this.masses[i]!;
          if (hub.hub && !this.deepCrush) continue;
          const p = this.shapeParticles[i]!;
          p.x += dx;
          p.y += dy;
          p.z += dz;
        }
      }
    }
    if (contacting) {
      for (let ci = 0; ci < this.clusters.length; ci++) applyPlasticity(this.clusters[ci]!, this.shapeParticles, dt, this.squash, this.buckle);
    }
    this.writeShapeToMasses();
  }

  /** Plates past the hubs: cabin must actually yield, not stay a rigid Müller cell. */
  private foldCabin(dt: number): void {
    const k = Math.min(1, dt * 3.6);
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      const p = this.shapeParticles[i];
      if (m.name === "cell") {
        const ty = m.rest.y - 0.22;
        const tz = m.rest.z * 0.25;
        m.world.y += (ty - m.world.y) * k;
        m.world.z += (tz - m.world.z) * k;
        m.local.y += (ty - m.local.y) * k;
        m.local.z += (tz - m.local.z) * k;
        if (p) {
          p.y = m.world.y;
          p.z = m.world.z;
        }
      } else if (m.name === "roof") {
        const ty = m.rest.y - 0.15;
        m.world.y += (ty - m.world.y) * k;
        m.local.y += (ty - m.local.y) * k;
        if (p) p.y = m.world.y;
      }
    }
  }

  private nudgeLatticeRails(dt: number): void {
    const k = Math.min(1, dt * 2.2);
    for (const m of this.masses) {
      if (!m.rail) continue;
      if (m.local.distanceTo(m.rest) >= 0.22) continue;
      const tz = m.rest.z * 0.68;
      m.world.z += (tz - m.world.z) * k;
      m.local.z += (tz - m.local.z) * k;
    }
  }

  /** The contact window: shape matching runs and the wreck stays on its masses (a flying one too, `syncPose`). */
  live(): boolean {
    return this.bidirectional || this.quietTime() < 0.35;
  }

  protected stepMassSlice(dt: number): void {
    const live = this.live();
    if (this.mode === "shape") {
      if (live) {
        // Shape matching moves positions only, so over the masses' velocities each correction moved Σ m r × v: a car shoved
        // against a wall went 0.9 → 7.5 rad/s with the matching alone adding 6400 kg·m²/s in 1.2 s (derby seed 8, c6).
        // Its goals are internal: the angular momentum it moved is handed back as a rigid turn, as clampLocal's is.
        this.yawMomentum(2, false);
        this.stepShapeMatch(dt);
        this.yawMomentum(2, true);
      } else this.goalOut?.fill(NaN);
    } else {
      this.goalOut?.fill(NaN);
      this.stepBeams(dt);
    }

    this.stepSuspension(dt);

    // A car under power is driven, not a quiet wreck: the settle rule must not park it.
    const powered = this.elapsed - this.lastPower < POWER_HOLD;
    const scuffed = this.drivetrainAlive && leftoverCrumple(this.crumpleTravel()) > 0.28;
    // One mass's step reads only that mass, so it runs as four loops: in one, the ground queries ran TurboFan
    // past its inlining budget, and every call left out boxed its doubles (~40 KB per race frame).
    this.sampleGround(this.floorPre, null);
    // The slide's drag (damping, ground Coulomb on every mass) takes the wreck's translation and its inner motion; its turn is
    // the tyres' (`tyreYaw`), so the spin the drag took off is handed back first: one yaw torque, not two stacked.
    const driven = powered && this.drivetrainAlive;
    const rigid = this.drivetrainAlive; // a car with its drivetrain turns by applyDrive's tyres, not the wreck's
    if (!rigid) this.yawMomentum(3, false);
    this.moveMasses(dt, powered);
    this.sampleGround(this.floorPost, this.gripPost);
    this.floorsFresh = true;
    this.groundMasses(dt, scuffed, driven);
    if (!rigid) {
      this.yawMomentum(3, true);
      if (!this.aloft) resistYaw(this.masses, this.floorPost, this.gripPost, dt);
    }
    // The block's spacing is internal too: its position correction over a turning pair moved 680 of a flying wreck's 730 kg·m²/s.
    this.yawMomentum(2, false);
    this.holdEngineBlock();
    this.yawMomentum(2, true);
    if (!live && !this.bidirectional) {
      // The body is rigid now: every mass takes the mean velocity, plus the spin it carries unless it is driven (the tyres, not this rule, stop a wreck's).
      let mx = 0,
        mz = 0,
        cx = 0,
        cz = 0,
        msum = 0;
      for (let mi = 0; mi < this.masses.length; mi++) {
        const m = this.masses[mi]!;
        if (!m.dynamic) continue;
        mx += m.vel.x * m.mass;
        mz += m.vel.z * m.mass;
        cx += m.world.x * m.mass;
        cz += m.world.z * m.mass;
        msum += m.mass;
      }
      if (msum > 1e-8) {
        mx /= msum;
        mz /= msum;
        cx /= msum;
        cz /= msum;
        let l = 0,
          inertia = 0;
        for (let mi = 0; mi < this.masses.length; mi++) {
          const m = this.masses[mi]!;
          if (!m.dynamic) continue;
          const rx = m.world.x - cx;
          const rz = m.world.z - cz;
          l += m.mass * (rz * m.vel.x - rx * m.vel.z);
          inertia += m.mass * (rx * rx + rz * rz);
        }
        const w = !rigid && inertia > 1e-9 ? l / inertia : 0;
        for (let mi = 0; mi < this.masses.length; mi++) {
          const m = this.masses[mi]!;
          if (!m.dynamic) continue;
          m.vel.x = mx + w * (m.world.z - cz);
          m.vel.z = mz - w * (m.world.x - cx);
        }
      }
    }
    if (this.bidirectional && this.deepCrush) {
      if (this.mode === "shape") this.foldCabin(dt);
      else this.nudgeLatticeRails(dt);
    }
  }

  /** The slide's ground drag past the slices (`bleedAfterSlide`) takes a wreck's translation and inner motion, never its turn: that is `resistYaw`'s. */
  override dragGround(dt: number, amount: number): void {
    if (this.drivetrainAlive) return super.dragGround(dt, amount);
    this.yawMomentum(3, false);
    super.dragGround(dt, amount);
    this.yawMomentum(3, true);
  }

  /** A course's ground (hills, bridge decks; 0 and grip 1 on the flat pad) under every dynamic mass on its own
   *  layer, where it stands now, and the grip where there is ground. */
  private sampleGround(floor: Float64Array, grip: Float64Array | null): void {
    const ground = activeGround();
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      if (!m.dynamic) continue;
      const w = m.world;
      const h = ground.heightAt(w.x, w.z, w.y);
      floor[i] = h;
      if (grip && h !== NO_FLOOR) grip[i] = ground.frictionAt(w.x, w.z, w.y);
    }
  }

  /** Gravity, damping, the speed clamp and the move of every dynamic mass (`stepMassSlice`). */
  private moveMasses(dt: number, powered: boolean): void {
    const quiet = this.quietTime();
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      if (!m.dynamic) continue;
      // Past the fleet disc's rim, or the body in flight (`aloft`): gravity alike on every mass and no ground
      // rules, so the car falls whole.
      if (this.floorPre[i] === NO_FLOOR || this.aloft) {
        m.vel.y -= 9.6 * dt;
        clampSpeed(m.vel);
        m.world.addScaledVector(m.vel, dt);
        continue;
      }
      if (m.hub) m.vel.y -= 9.6 * dt;
      else if (m.vel.y < 0) m.vel.y *= Math.pow(0.12, dt);
      // During contact: almost no extra damping so crumple can run.
      // After the last collision, ease into rest over a few seconds.
      let rate = 0.988;
      if (!this.drivetrainAlive && quiet > 0.12) {
        const t = Math.max(0, Math.min(1, (quiet - 0.12) / 1.8));
        const s = t * t * (3 - 2 * t);
        rate = (1 - s) * 0.96 + s * 0.18;
      }
      m.vel.multiplyScalar(Math.pow(rate, dt));
      clampSpeed(m.vel);
      if (quiet > 2.4 && !powered && m.vel.lengthSq() < 0.08) m.vel.set(0, 0, 0);
      m.world.addScaledVector(m.vel, dt);
      if (!Number.isFinite(m.world.x + m.world.y + m.world.z)) {
        m.world.copy(m.rest);
        m.vel.set(0, 0, 0);
      }
    }
  }

  /**
   * Floor, ceiling and ground drag of every dynamic mass after its move (`floorPost`, `gripPost`). A driven car
   * (`driven`: under power, drivetrain alive) gets no drag: its tyres are applyDrive's, whose Δv already scrubs the
   * sideways slip, and a sliding wreck's 0.75 g on top held a dented car under ~60 km/h in the gear buckets' top gears.
   */
  private groundMasses(dt: number, scuffed: boolean, driven: boolean): void {
    const quiet = this.quietTime();
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      // Fell past the rim, or this step carried it past (`floor + k` is -Infinity): no ground rules.
      if (!m.dynamic || this.floorPre[i] === NO_FLOOR) continue;
      const floor = this.floorPost[i]!;
      if (floor === NO_FLOOR) continue;
      // In flight only a mass that came down onto its ground meets it (held, as on the ground); the rest fly.
      if (this.aloft && m.world.y >= floor + (m.hub ? HUB_FLOOR : 0.16)) continue;
      const grip = this.gripPost[i]!;
      const hub = m.hub;
      // One drag call site: two left TurboFan's budget short and boxed `mu`.
      let mu = 0;
      let drag = true;
      if (hub) {
        if (m.world.y < floor + HUB_FLOOR) {
          m.world.y = floor + HUB_FLOOR;
          if (m.vel.y < 0) m.vel.y = 0;
        }
        mu = (!this.drivetrainAlive ? CRASH.muSlide : scuffed ? CRASH.muScuff : CRASH.muSlide) * grip;
      } else {
        if (m.world.y < floor + 0.16) {
          m.world.y = floor + 0.16;
          if (m.vel.y < 0) m.vel.y *= -0.22;
        }
        if (quiet > 0.12) {
          const grab = Math.max(0, Math.min(1, (quiet - 0.12) / 0.45));
          mu = CRASH.muSlide * grab * grip;
        } else if (m.world.y < floor + 0.16) mu = CRASH.muScuff * grip;
        else drag = false;
      }
      if (drag && !driven) applyGroundFriction(m.vel, dt, mu, true);
      if (m.world.y > floor + 3.4) {
        m.world.y = floor + 3.4;
        m.vel.y = 0;
      }
      if (!hub && !this.bidirectional && m.world.y > floor + 0.22) {
        m.vel.y = Math.max(-2.2, Math.min(3, m.vel.y));
      }
    }
  }

  /** A3: the block is one casting — engineL/engineR keep their rest spacing and share their
   *  velocity along it (mass-weighted), whatever the crumple does around them. */
  private holdEngineBlock(): void {
    const a = this.at.engineL;
    const b = this.at.engineR;
    const wa = a.dynamic ? 1 / a.mass : 0;
    const wb = b.dynamic ? 1 / b.mass : 0;
    const w = wa + wb;
    if (w < 1e-8) return;
    const dx = b.world.x - a.world.x;
    const dy = b.world.y - a.world.y;
    const dz = b.world.z - a.world.z;
    const len = hypot3(dx, dy, dz);
    if (len < 1e-6) return;
    const nx = dx / len;
    const ny = dy / len;
    const nz = dz / len;
    const err = (len - a.rest.distanceTo(b.rest)) / w;
    a.world.x += nx * err * wa;
    a.world.y += ny * err * wa;
    a.world.z += nz * err * wa;
    b.world.x -= nx * err * wb;
    b.world.y -= ny * err * wb;
    b.world.z -= nz * err * wb;
    const rel = ((b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny + (b.vel.z - a.vel.z) * nz) / w;
    a.vel.x += nx * rel * wa;
    a.vel.y += ny * rel * wa;
    a.vel.z += nz * rel * wa;
    b.vel.x -= nx * rel * wb;
    b.vel.y -= ny * rel * wb;
    b.vel.z -= nz * rel * wb;
  }

  private stepSuspension(dt: number): void {
    const k = 11000;
    const c = 260;
    for (let si = 0; si < this.suspension.length; si++) {
      const [hub, mount] = this.suspension[si]!;
      const restDy = tiltedRise(this.pose[12]!, this.pose[13]!, hub.rest.x - mount.rest.x, hub.rest.y - mount.rest.y, hub.rest.z - mount.rest.z);
      const dy = hub.world.y - mount.world.y - restDy;
      const dv = hub.vel.y - mount.vel.y;
      const f = (-k * dy - c * dv) * dt;
      if (hub.dynamic) hub.vel.y += f / hub.mass;
      if (mount.dynamic) mount.vel.y -= f / mount.mass;
    }
  }
}
