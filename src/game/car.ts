import * as THREE from "three";
import type { DeformNetState } from "./streamed-deform.ts";
import { applyGroundFriction, CRASH, hypot2, round4 } from "./physics-util.ts";
import { CAR_HALF, DOOR, WHEEL_POS } from "./car-mesh.ts";
import { getCrackMap } from "./car-materials.ts";
import { activeGround, DISC_GROUND, FLAT_GROUND, NO_FLOOR, type Ground } from "./ground.ts";
import { CarParts } from "./car-parts.ts";
import { END_WINDOW, type PartNetState, REARM_QUIET_S, type WorldBounce } from "./car-core.ts";

export { CAR_HALF, DOOR, WHEEL_POS };
export type { Hull } from "./hulls.ts";

const _qSpin = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _v = new THREE.Vector3();
const _in = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _gn = new THREE.Vector3();
const _fallC = new THREE.Vector3();
const _fallV = new THREE.Vector3();
const _fallR = new THREE.Vector3();

export class DeformableCar extends CarParts {
  spawn(x: number, z: number, speed: number): void {
    this.resetVisual();
    this.group.position.set(x, 0, z);
    this.group.lookAt(0, 0, 0);
    this.refreshBasis();
    this.placeAt(x, z, Math.atan2(this.forward.x, this.forward.z), speed, this.forward);
  }

  spawnFacing(x: number, z: number, yaw: number, speed: number): void {
    this.resetVisual();
    this.placeAt(x, z, yaw, speed, this.fwdFlat);
  }

  /** Upright at (x, z) facing `yaw`, moving at `speed` along `dir` (`forward` or `fwdFlat`, read after the basis refresh). */
  private placeAt(x: number, z: number, yaw: number, speed: number, dir: THREE.Vector3): void {
    this.yaw = yaw;
    this.group.position.set(x, 0, z);
    this.group.rotation.set(0, yaw, 0, "YXZ");
    this.roll = 0;
    this.pitch = 0;
    this.speed = speed;
    this.spawnSpeed = speed;
    this.crashed = false;
    this.angular.set(0, 0, 0);
    this.refreshBasis();
    this.velocity.copy(dir).multiplyScalar(speed);
    this.deform.bindKinematic(this.group, this.velocity, this.angular);
    this.resetLamps();
  }

  resetVisual(): void {
    this.vaporized = false;
    this.falling = false;
    this.fallSpin.set(0, 0, 0);
    this.group.scale.setScalar(1);
    this.deform.reset();
    this.deform.restoreRest(this.body.geometry);
    this.restoreRest(this.hood.geometry, this.hoodRest);
    this.restoreRest(this.trunk.geometry, this.trunkRest);
    this.restoreRest(this.doorMeshL.geometry, this.doorLRest);
    this.restoreRest(this.doorMeshR.geometry, this.doorRRest);
    this.wheelSpin = 0;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      const loose = this.looseWheels[i]!;
      if (loose.loose) {
        this.world.remove(w);
        this.group.add(w);
        loose.loose = false;
        loose.velocity.set(0, 0, 0);
        loose.angular.set(0, 0, 0);
      }
      const rest = WHEEL_POS[i]!;
      w.position.set(rest[0], rest[1], rest[2]);
      w.rotation.set(0, 0, 0);
      w.visible = true;
    }
    this.bodyMat.roughness = 0.42;
    this.group.rotation.set(0, 0, 0);
    this.interior.scale.set(1, 1, 1);
    this.interior.position.set(0, 0, 0);

    this.endAgo.fill(9);
    this.endReach = Infinity;
    this.endSqueeze = false;
    for (const p of this.parts) {
      if (p.detached) {
        this.world.remove(p.object);
        if (p.name === "mirrorL") this.doorL.add(p.object);
        else if (p.name === "mirrorR") this.doorR.add(p.object);
        else this.group.add(p.object);
      }
      p.detached = false;
      p.folding = false;
      p.hingeT = 0;
      if (p.swing) {
        p.swing.theta = 0;
        p.swing.omega = 0;
        p.swing.latched = true;
        p.swing.load = 0;
        p.swing.mirrorFold = 0;
      }
      p.object.position.copy(p.restPos);
      p.object.quaternion.copy(p.restQuat);
      p.object.rotation.set(0, 0, 0);
      p.object.scale.set(1, 1, 1);
      p.object.visible = true;
      p.velocity.set(0, 0, 0);
      p.angular.set(0, 0, 0);
    }
    for (const g of this.glassPanes) this.resetGlass(g);
    this.resetLamps();
  }
  /**
   * `impulse` is the closing speed (FX, glass); `ebs` the equivalent barrier speed that sizes the crush.
   * The first hit starts the crash; on a wreck a fresh, hard enough contact re-arms a new hit (`rearmHit`).
   */
  applyImpact(worldPoint: THREE.Vector3, worldInward: THREE.Vector3, impulse: number, ebs: number): void {
    const localP = this.worldToLocalPoint(worldPoint, _p);
    _in.copy(worldInward);
    _in.y = 0;
    _v.copy(this.group.position).sub(worldPoint);
    _v.y = 0;
    if (_v.lengthSq() > 1e-8) {
      _v.normalize();
      if (_in.dot(_v) < 0) _in.negate();
    }
    const localN = this.worldToLocalDir(_in, _n);
    const rough = Math.min(0.82, 0.42 + impulse * 0.012);
    if (this.crashed && this.deform.massActive) {
      if (!this.deform.rearmHit(localP, localN, impulse, ebs)) return;
      this.bodyMat.roughness = Math.max(this.bodyMat.roughness, rough);
    } else {
      this.crashed = true;
      this.deform.beginCrush(localP, localN, impulse, ebs, this.group, this.velocity, this.angular);
      this.bodyMat.roughness = rough;
    }
    this.deform.impulseAt(worldPoint, _in, impulse);
  }

  syncPose(dt: number): void {
    this.deform.followGroup(this.group, this.velocity, this.angular, dt);
    this.yaw = this.group.rotation.y;
    this.roll = this.group.rotation.z;
    this.pitch = this.group.rotation.x;
    this.refreshBasis();
  }

  afterContacts(dt: number, bounce?: WorldBounce): void {
    this.endAgo[0] += dt;
    this.endAgo[1] += dt;
    const d = this.deform;
    // The squeeze lasts while both ends are still being struck; after it a hit is an ordinary
    // one-ended hit again (and may re-arm), and a settled wreck may plant.
    if (this.endSqueeze && Math.max(this.endAgo[0]!, this.endAgo[1]!) > END_WINDOW) {
      this.endSqueeze = false;
      d.bidirectional = false;
      d.deepCrush = false;
    }
    if (this.endReach < Infinity && d.quietTime() > REARM_QUIET_S && Math.min(this.endAgo[0]!, this.endAgo[1]!) > END_WINDOW) this.endReach = Infinity;
    if (!this.doorParts[0]!.swing!.latched || !this.doorParts[1]!.swing!.latched) this.swingDoors(dt);
    if (!d.massActive) return;
    this.nudgeWheels(dt);
    this.stepLooseParts(dt, bounce);
  }

  /**
   * Shared crash rule for every contact path (car-car, press, pistons; docs/CONTACT_PARITY.md):
   * `end` (+1 front, −1 rear) is being struck, the striker's face `reach` m from the car's centre
   * along its length. Both ends struck within `END_WINDOW` is a squeeze: both ends become crumple
   * zones (`bidirectional`), and once a face is inboard of the wheel centres the cage may yield
   * (`deepCrush`). Both clear when the contact has been quiet for `REARM_QUIET_S`.
   */
  noteContactEnd(end: 1 | -1, reach: number): void {
    this.endAgo[end > 0 ? 0 : 1] = 0;
    this.endReach = Math.min(this.endReach, reach);
    if (this.endAgo[0]! < END_WINDOW && this.endAgo[1]! < END_WINDOW) {
      this.endSqueeze = true;
      this.deform.bidirectional = true;
    }
    if (this.endSqueeze && this.endReach < WHEEL_POS[0]![2]) this.deform.deepCrush = true;
  }

  snapshot(): Record<string, unknown> {
    return {
      name: this.paint.name,
      crashed: this.crashed,
      pos: { x: round4(this.group.position.x), y: round4(this.group.position.y), z: round4(this.group.position.z) },
      vel: { x: round4(this.velocity.x), y: round4(this.velocity.y), z: round4(this.velocity.z) },
      speed: round4(this.velocity.length()),
      angular: { x: round4(this.angular.x), y: round4(this.angular.y), z: round4(this.angular.z) },
      yaw: round4(this.yaw),
      pitch: round4(this.pitch),
      roll: round4(this.roll),
      spawnSpeed: round4(this.spawnSpeed),
      deform: this.deform.snapshot(),
      parts: this.parts.map((p) => ({
        name: p.name,
        detached: p.detached,
        folding: p.folding,
        hingeT: round4(p.hingeT),
        pos: { x: round4(p.object.position.x), y: round4(p.object.position.y), z: round4(p.object.position.z) },
        vel: { x: round4(p.velocity.x), y: round4(p.velocity.y), z: round4(p.velocity.z) },
      })),
      lamps: this.lamps.map((l) => ({
        kind: l.kind,
        side: l.side,
        intact: l.intact,
        on: l.intact && l.mat.emissiveIntensity > 0.05,
      })),
      glass: this.glassPanes.map((g) => g.state),
    };
  }

  step(dt: number): void {
    this.integrate(dt);
    this.updateDeform(dt);
  }

  integrate(dt: number): void {
    if (this.vaporized) return;
    if (this.falling) {
      this.velocity.y -= 9.6 * dt;
      this.group.position.addScaledVector(this.velocity, dt);
      const spin = this.fallSpin.length();
      if (spin > 1e-6) this.group.quaternion.premultiply(_qSpin.setFromAxisAngle(_n.copy(this.fallSpin).multiplyScalar(1 / spin), spin * dt));
      this.stepLooseParts(dt);
      return;
    }
    if (this.deform.massActive) {
      this.syncPose(dt);
      this.nudgeWheels(dt);
      this.stepLooseParts(dt);
      return;
    }
    if (!this.crashed) {
      this.velocity.y -= 9.6 * dt;
      this.group.position.addScaledVector(this.velocity, dt);
      this.wheelSpin += (this.speed / 0.32) * dt;
      for (const w of this.wheels) w.rotation.x = this.wheelSpin;
      this.deform.bindKinematic(this.group, this.velocity, this.angular);
    } else {
      this.velocity.y -= 9.6 * dt;
      this.velocity.x *= Math.pow(0.28, dt);
      this.velocity.z *= Math.pow(0.28, dt);
      this.angular.multiplyScalar(Math.pow(0.45, dt));
      this.group.position.addScaledVector(this.velocity, dt);
      this.yaw += this.angular.y * dt;
      this.roll = THREE.MathUtils.damp(this.roll, this.angular.z * 0.15, 4, dt);
      this.pitch = THREE.MathUtils.damp(this.pitch, this.angular.x * 0.12, 4, dt);
      this.group.rotation.set(this.pitch, this.yaw, this.roll, "YXZ");
      const v = this.velocity.length();
      this.wheelSpin += (v / 0.32) * dt;
      for (const w of this.wheels) w.rotation.x = this.wheelSpin;
    }
    const ground = activeGround();
    const pos = this.group.position;
    if (ground === FLAT_GROUND || ground === DISC_GROUND) {
      // The flat pad; the fleet's disc only inside its rim (y hint: where the car was before this step).
      if (pos.y < 0 && ground.heightAt(pos.x, pos.z, pos.y - this.velocity.y * dt) !== NO_FLOOR) {
        pos.y = 0;
        if (this.velocity.y < 0) this.velocity.y = 0;
      }
    } else {
      // A course's ground: ride it while it holds the car up; where it falls away faster than gravity
      // can follow (a ramp lip, a crest at speed) the car flies, and lands back on whatever is below.
      const y0 = pos.y - this.velocity.y * dt;
      const gy = ground.heightAt(pos.x, pos.z, y0);
      if (pos.y <= gy) {
        const was = ground.heightAt(pos.x - this.velocity.x * dt, pos.z - this.velocity.z * dt, y0);
        pos.y = gy;
        this.velocity.y = (gy - was) / dt;
        if (!this.crashed) this.alignToGround(ground, gy);
      }
    }
    this.refreshBasis();
    this.stepLooseParts(dt);
  }

  /** Pitch and roll a driven car onto the ground plane under it (yaw kept). */
  private alignToGround(ground: Ground, y: number): void {
    const n = ground.normalAt(this.group.position.x, this.group.position.z, _gn, y);
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    // YXZ takes local up to (−sin r·x̂ + cos r sin p·f̂ + cos r cos p·ŷ), x̂ = (fz, 0, −fx) the local +x:
    // pitch from n·f̂ against n.y, roll from −n·x̂ against the rest. A rise toward +x lifts the +x wheels.
    const nf = n.x * fx + n.z * fz;
    this.pitch = Math.atan2(nf, n.y);
    this.roll = Math.atan2(n.z * fx - n.x * fz, hypot2(nf, n.y));
    this.group.rotation.set(this.pitch, this.yaw, this.roll, "YXZ");
  }

  updateDeform(dt: number): void {
    if (this.vaporized || this.falling) return;
    this.deform.update(dt, this.body.geometry);
    // LoD gate lifted (back on screen / large again): catch the mesh up to the cages first.
    if (!this.deform.skinDeferred) this.deform.flushSkin(this.body.geometry);
    if (this.deform.skinnedThisFrame) this.poseLamps();
    if (this.crashed) {
      if (this.deform.skinnedThisFrame) this.skinPanels();
      this.syncAttachedParts(dt);
      this.followGlass();
      this.evaluateBreakage(this.deform.impulseValue, dt);
    }
    if (this.deform.massActive) this.fitInterior();
    if (this.hullHelper?.visible) this.updateHullHelper();
  }

  /** LoD catch-up once the camera has moved: write a deferred dent before this car is drawn. */
  flushDeferredSkin(): void {
    this.deform.skinDeferred = false;
    if (!this.deform.flushSkin(this.body.geometry)) return;
    this.poseLamps();
    if (this.crashed) this.skinPanels();
  }

  /** Bonnet, boot lid and the skinned glass follow the body skin. */
  private skinPanels(): void {
    let hood = true;
    let trunk = true;
    for (const p of this.parts) {
      if (!p.detached) continue;
      if (p.name === "hood") hood = false;
      else if (p.name === "trunk") trunk = false;
    }
    if (hood) this.deform.skinPanel(this.hood.geometry, this.hoodRest, "bonnet", this.hoodOrigin);
    if (trunk) this.deform.skinPanel(this.trunk.geometry, this.trunkRest, "boot", this.trunkOrigin);
    for (const g of this.glassPanes) {
      if (!g.skin || !g.restVerts || g.state === "shattered") continue;
      this.deform.skinPanel(g.mesh.geometry, g.restVerts, g.skin, _zero);
    }
  }

  /** `drop`: a popped hub throws its wheel (host); a netplay client takes loose wheels from snapshots. */
  private nudgeWheels(dt: number, drop = true): void {
    const v = this.velocity.length();
    if (!this.deform.drivetrainAlive) {
      this.wheelSpin *= Math.pow(0.45, dt);
      this.wheelSpin += (v / 0.32) * dt * 0.2;
    } else {
      const drive = this.crashed && this.deform.crushElapsed > 0.05 ? 0.35 : 1;
      this.wheelSpin += (v / 0.32) * dt * drive;
    }
    const hubs = ["hubFL", "hubFR", "hubRL", "hubRR"] as const;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      if (this.looseWheels[i]!.loose) continue;
      const rest = WHEEL_POS[i]!;
      w.rotation.x = this.wheelSpin;
      if (!this.deform.massActive) {
        w.position.set(rest[0], rest[1], rest[2]);
        continue;
      }
      const hub = this.deform.massLocal(hubs[i]!);
      const popped = this.deform.hubPopped(hubs[i]!);
      if (!popped) {
        // Follows its hub along the car too: a face's shove, or a squeeze past the hubs, moves it off rest.
        w.position.set(hub.x, THREE.MathUtils.clamp(hub.y, 0.16, 0.55), hub.z);
        w.visible = true;
        continue;
      }
      if (drop) this.dropWheel(i, hubs[i]!);
    }
  }

  setRigVisible(v: boolean): void {
    this.deform.setHelperVisible(v);
    if (this.hullHelper) this.hullHelper.visible = v;
    if (v) this.updateHullHelper();
  }

  dispose(): void {
    this.deform.disposeHelper();
    const free = (obj: THREE.Object3D) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) if (!m.userData.shared) m.dispose();
      }
      if (obj instanceof THREE.Light) obj.dispose();
    };
    // Loose parts live in the world, attached ones in the group: free each part before it leaves either.
    for (const p of this.parts) {
      p.object.traverse(free);
      p.object.removeFromParent();
    }
    this.group.traverse(free);
  }

  /**
   * Netplay client: take the host's deform and part state with no physics, breakage, launch or FX,
   * so the skin, hulls, parts, lamps and glass match the host's. Set the pose first.
   */
  writeNetState(deform: DeformNetState, parts: PartNetState): void {
    this.deform.writeNetState(deform, this.group, this.body.geometry);
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i]!;
      const f = parts.flags[i]!;
      const loose = (f & 1) !== 0;
      if (loose !== p.detached) {
        p.object.removeFromParent();
        if (loose) this.world.add(p.object);
        else if (p.name === "mirrorL") this.doorL.add(p.object);
        else if (p.name === "mirrorR") this.doorR.add(p.object);
        else this.group.add(p.object);
        p.detached = loose;
      }
      p.folding = (f & 2) !== 0;
      p.hingeT = parts.hinge[i * 3]!;
      if (p.swing) {
        p.swing.theta = parts.hinge[i * 3 + 1]!;
        p.swing.mirrorFold = parts.hinge[i * 3 + 2]!;
        p.swing.latched = (f & 4) !== 0;
        p.swing.omega = 0;
      }
      if (!loose) continue;
      p.object.position.fromArray(parts.pose, i * 7);
      p.object.quaternion.fromArray(parts.pose, i * 7 + 3);
    }
    // Mirrors pose on their door, which shares their swing: every swing is set before any pose.
    for (const p of this.parts) if (!p.detached) this.posePart(p);

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      const lw = this.looseWheels[i]!;
      const loose = ((parts.wheelLoose >> i) & 1) !== 0;
      if (loose !== lw.loose) {
        // Back under the class hub group (assignClass), where resetVisual's re-dress puts it.
        if (loose) this.world.add(w);
        else (this.group.getObjectByName("classHubs") ?? this.group).add(w);
        lw.loose = loose;
        lw.velocity.set(0, 0, 0);
        lw.angular.set(0, 0, 0);
      }
      if (!loose) continue;
      w.position.fromArray(parts.wheels, i * 7);
      w.quaternion.fromArray(parts.wheels, i * 7 + 3);
      w.visible = true;
    }

    let relight = false;
    for (let i = 0; i < this.lamps.length; i++) if ((parts.lamps >> i) & 1 && !this.lamps[i]!.intact) relight = true;
    if (relight) this.resetLamps();
    for (let i = 0; i < this.lamps.length; i++) if (!((parts.lamps >> i) & 1) && this.lamps[i]!.intact) this.breakLamp(this.lamps[i]!);

    for (let i = 0; i < this.glassPanes.length; i++) {
      const g = this.glassPanes[i]!;
      const want = (parts.glass >> (i * 2)) & 3;
      const have = g.state === "intact" ? 0 : g.state === "cracked" ? 1 : 2;
      if (want === have) continue;
      if (want < have) this.resetGlass(g);
      if (want >= 1 && g.state === "intact") {
        g.state = "cracked";
        g.mat.map = getCrackMap();
        g.mat.opacity = 0.55;
        g.mat.roughness = 0.32;
        g.mat.needsUpdate = true;
      }
      if (want === 2) {
        g.state = "shattered";
        g.mesh.visible = false;
      }
    }

    if (this.deform.skinnedThisFrame) {
      this.poseLamps();
      this.skinPanels();
    }
    this.followGlass();
    this.fitInterior();
    if (this.hullHelper?.visible) this.updateHullHelper();
  }

  /** Netplay client, every frame: wheels spin and ride their hubs as `afterContacts` does on the host. */
  netFrame(dt: number): void {
    this.nudgeWheels(dt, false);
  }
}

/**
 * Start the fake fall. Host: the masses' mean velocity and the rigid spin that best fits their motion
 * (Σ m r × v / Σ m |r|² about their centre), or the kinematic car's own; the soft body then stops
 * (`massActive` off; its state is left as it is). Netplay client: pass the host's `spin` after setting
 * the pose and `velocity`.
 */
export function beginFakeFall(car: DeformableCar, spin?: THREE.Vector3): void {
  const d = car.deform;
  if (spin) car.fallSpin.copy(spin);
  else if (d.massActive) {
    let mass = 0;
    _fallC.set(0, 0, 0);
    _fallV.set(0, 0, 0);
    for (const m of d.masses) {
      mass += m.mass;
      _fallC.addScaledVector(m.world, m.mass);
      _fallV.addScaledVector(m.vel, m.mass);
    }
    _fallC.multiplyScalar(1 / mass);
    _fallV.multiplyScalar(1 / mass);
    car.fallSpin.set(0, 0, 0);
    let inertia = 0;
    for (const m of d.masses) {
      _fallR.subVectors(m.world, _fallC);
      inertia += m.mass * _fallR.lengthSq();
      car.fallSpin.addScaledVector(_fallR.cross(_v.subVectors(m.vel, _fallV)), m.mass);
    }
    car.fallSpin.multiplyScalar(1 / Math.max(inertia, 1e-6));
    // The fake turns about the group's origin: carry that point's velocity in the fitted rigid motion.
    car.velocity.copy(_fallV).add(_fallR.subVectors(car.group.position, _fallC).cross(_v.copy(car.fallSpin)).negate());
  } else car.fallSpin.copy(car.angular);
  d.massActive = false;
  car.falling = true;
}

/**
 * A crashed car's slide after the hit (`CrashEngine.tickInner`): tyre-style friction on the group, and
 * the mass ground drag. The drag ramps from the hit, not from the last car contact: a pair grinding
 * together kept resetting the contact timer and slid ~3× as far as one wreck alone, and a frictionless
 * pair pushed long enough lets the bullet drive through the struck car (T-bone, RIG_ANALYSIS §6.6). A car
 * under power keeps the contact ramp (it is driven, not sliding); `dragGround` skips an airborne wreck.
 */
export function bleedAfterSlide(car: DeformableCar, dt: number): void {
  if (!car.crashed) return;
  const q = car.deform.quietTime();
  const p = car.group.position;
  // × the course surface's friction where the wreck slides (1 on the flat sandbox ground).
  const mu = (q < 0.15 ? CRASH.muScuff : CRASH.muSlide * (1 + Math.min(1.4, q))) * activeGround().frictionAt(p.x, p.z, p.y);
  applyGroundFriction(car.velocity, dt, mu, true);
  if (car.deform.massActive) {
    const t = car.deform.powered ? q : car.deform.sinceHit();
    car.deform.dragGround(dt, THREE.MathUtils.clamp((t - 0.08) / 1.1, 0, 1));
  }
}
