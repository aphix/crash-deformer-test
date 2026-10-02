import * as THREE from "three";
import { TYRE_R } from "./deform-state.ts";
import { applyGroundFriction, CRASH } from "./physics-util.ts";
import { DOOR } from "./car-mesh.ts";
import { getCrackMap } from "./car-materials.ts";
import { activeGround, NO_FLOOR } from "./ground.ts";
import { MASS_SPECS } from "./rig-spec.ts";
import {
  CarCore,
  BUMPER_TEAR_MPS,
  type DetachPart,
  DOOR_AJAR,
  DOOR_DAMP,
  DOOR_INERTIA,
  DOOR_OPEN_MAX,
  DOOR_TEAR_MPS,
  type DoorHinge,
  type GlassName,
  type GlassPane,
  HINGE_TEAR_J,
  type Lamp,
  type LooseBody,
  type PartNetState,
  SLAM_TEAR_J,
  type WorldBounce,
} from "./car-core.ts";

const _qSpin = new THREE.Quaternion();
const _push = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _box = new THREE.Box3();
const _lampQ = new THREE.Quaternion();
const _doorW = new THREE.Vector3();

/** Police light bar: shears off once the roof mass under it sinks this far (m below its rest height; a
 *  56 km/h frontal sinks it ~0.07), or on any hit at or above this EBS (60 km/h, arcade: a big crash throws
 *  it). Guessed, tuned by eye. (The roof sensor's compression is no measure: a 20 km/h frontal reads 0.36.) */
const BAR_TEAR_SINK = 0.12;
const BAR_TEAR_MPS = 60 / 3.6;
const ROOF_REST_Y = MASS_SPECS.find((m) => m.name === "roof")!.rest[1];
/** Netplay part slots: the most parts any style has (8, plus the police light bar), so every car shares one layout. */
const PART_SLOTS = 9;

/** A part or wheel off the car: gravity, tumble, the world's walls, a floor at `floor` (m) and asphalt; none past the fleet disc's rim. */
function stepLoose(p: LooseBody, dt: number, floor: number, bounce?: WorldBounce): void {
  p.velocity.y -= 9.6 * dt;
  p.object.position.addScaledVector(p.velocity, dt);
  const spin = p.angular.length();
  if (spin > 1e-5) {
    _n.copy(p.angular).multiplyScalar(1 / spin);
    _qSpin.setFromAxisAngle(_n, spin * dt);
    p.object.quaternion.premultiply(_qSpin);
  }
  p.angular.multiplyScalar(Math.pow(0.72, dt));
  bounce?.(p.object.position, p.velocity, Math.min(0.22, p.radius * 0.45));
  const q = p.object.position;
  if (activeGround().heightAt(q.x, q.z, q.y) === NO_FLOOR) return;
  if (p.object.position.y < floor) {
    p.object.position.y = floor;
    if (p.velocity.y < 0) p.velocity.y *= -0.28;
  }
  if (p.object.position.y <= floor + GROUND_BAND) {
    // Sliding on asphalt: Coulomb friction per second, and the spin dies with the slide. The
    // band keeps the millimetre hops of the bounce in contact at any frame rate.
    const slide = Math.hypot(p.velocity.x, p.velocity.z);
    applyGroundFriction(p.velocity, dt, CRASH.muSlide, true);
    p.angular.multiplyScalar(slide > 1e-5 ? Math.hypot(p.velocity.x, p.velocity.z) / slide : 0);
  }
}
/** Height above its rest (m) at which a loose part still slides on the ground. */
const GROUND_BAND = 0.005;

/**
 * Detachable parts: attached-part posing, door hinges and mirrors, glass following, breakage and detaching,
 * loose parts and wheels, and their netplay state.
 */
export abstract class CarParts extends CarCore {
  protected syncAttachedParts(dt: number): void {
    const ix = this.deform.impactInward.x;
    const iz = this.deform.impactInward.z;
    for (const p of this.parts) {
      if (p.detached) continue;
      const left = this.deform.sensorCompression(p.attachL);
      const right = this.deform.sensorCompression(p.attachR);
      const crush = Math.max(left, right, this.deform.partCompression(p.cage));
      const local = Math.min(left, right);
      const onHit = this.partOnHit(p);

      let target = 0;
      if (p.name.startsWith("mirror")) {
        // C3: the mirror folds with the door skin under it (sensors 6/7 and 4/5), on its own side only.
        if (onHit) target = THREE.MathUtils.clamp((Math.max(left, right) - 0.04) / 0.3, 0, 1);
      } else if (p.hinge === "door") {
        const open = THREE.MathUtils.clamp((Math.max(local, crush) - 0.08) / 0.5, 0, 1);
        const endOn = !this.deform.bidirectional && Math.abs(ix) <= Math.abs(iz);
        if (onHit) target = open;
        else if (endOn && (crush > 0.16 || local > 0.12)) target = Math.min(open, DOOR_AJAR);
      } else if (onHit) {
        if (p.hinge === "two-point") target = THREE.MathUtils.clamp((crush - 0.04) / 0.55, 0, 1);
        else if (p.hinge === "cowl") target = THREE.MathUtils.clamp((crush - 0.1) / 0.6, 0, 1);
        else if (p.hinge === "tail") target = THREE.MathUtils.clamp((crush - 0.1) / 0.6, 0, 1);
      }
      p.hingeT = Math.max(p.hingeT, Math.min(target, p.hingeT + Math.max(dt * 3.2, 0.012)));
      this.posePart(p);
    }
  }

  /** Rest pose plus the hinge value `hingeT` (crash) and, on doors and mirrors, the free swing. */
  protected posePart(p: DetachPart): void {
    const t = p.hingeT;
    p.object.position.copy(p.restPos);
    p.object.quaternion.copy(p.restQuat);
    p.object.scale.set(1, 1, 1);

    if (p.hinge === "two-point") {
      if (p.name.startsWith("bumper")) {
        p.folding = t > 0.04;
        const fl = this.deform.massLocal(p.name === "bumperF" ? "bumperFL" : "bumperRL");
        const fr = this.deform.massLocal(p.name === "bumperF" ? "bumperFR" : "bumperRR");
        p.object.position.set((fl.x + fr.x) * 0.5, (fl.y + fr.y) * 0.5, (fl.z + fr.z) * 0.5);
        const span = Math.abs(fl.z - (p.name === "bumperF" ? 2.06 : -2.06));
        p.object.scale.set(1 + t * 0.04, Math.max(0.45, 1 - t * 0.28), Math.max(0.18, 1 - span * 0.45));
      } else {
        p.folding = t > 0.08;
        const side = p.name === "mirrorL" ? -1 : 1;
        p.object.rotation.z += side * t * 1.4;
        p.object.rotation.y = p.swing!.mirrorFold;
        p.object.position.y -= t * 0.12;
        p.object.position.x += side * t * 0.18;
      }
    } else if (p.hinge === "cowl") {
      p.folding = t > 0.06;
      p.object.position.z -= t * 0.08;
      p.object.position.y += t * 0.26;
      p.object.rotation.x = -t * 0.5;
    } else if (p.hinge === "tail") {
      p.folding = t > 0.06;
      p.object.position.z += t * 0.08;
      p.object.position.y += t * 0.22;
      p.object.rotation.x = t * 0.5;
    } else if (p.hinge === "door") {
      p.folding = t > 0.08;
      const sign = p.name === "doorL" ? -1 : 1;
      p.object.rotation.y = -sign * Math.max(t * 1.45, p.swing!.theta);
      p.object.position.x += sign * t * 0.06;
      p.object.updateWorldMatrix(true, false);
      _box.setFromObject(p.object);
      // Keep the door's bottom off the ground (not where there is none: off the fleet disc's rim).
      const g = p.object.getWorldPosition(_doorW);
      if (_box.min.y < 0.04 && activeGround().heightAt(g.x, g.z, g.y) !== NO_FLOOR) p.object.position.y += 0.04 - _box.min.y;
    }
  }

  /** Door hinge state; `side` −1 is the left door, +1 the right. */
  doorHinge(side: number): DoorHinge {
    return this.doorParts[side < 0 ? 0 : 1]!.swing!;
  }

  /** Whether a door or mirror has left the car; a mirror rides off on its torn door. */
  partOff(name: "doorL" | "doorR" | "mirrorL" | "mirrorR"): boolean {
    const i = name.endsWith("L") ? 0 : 1;
    const door = this.doorParts[i]!.detached;
    return name.startsWith("door") ? door : door || this.mirrorParts[i]!.detached;
  }

  /** Unlatch a door and leave it at rest `theta` open (rad, up to the stop); 0 shuts and latches it. */
  setDoorOpen(side: number, theta: number): void {
    const p = this.doorParts[side < 0 ? 0 : 1]!;
    if (p.detached) return;
    const h = p.swing!;
    h.theta = THREE.MathUtils.clamp(theta, 0, DOOR_OPEN_MAX);
    h.omega = 0;
    h.latched = h.theta === 0;
    this.posePart(p);
  }

  /**
   * The check strap takes `energy` (J) past the stop. Once the total passes `HINGE_TEAR_J` the
   * door tears off with `push` (car-space m/s on top of the car's velocity). Returns whether it did.
   */
  loadDoorStop(side: number, energy: number, push: THREE.Vector3): boolean {
    const p = this.doorParts[side < 0 ? 0 : 1]!;
    if (p.detached) return false;
    p.swing!.load += energy;
    if (p.swing!.load < HINGE_TEAR_J) return false;
    this.detachPart(p, 0, push);
    return true;
  }

  /** Fold a mirror about its base (rad, its `rotation.y` in door space). */
  setMirrorFold(side: number, angle: number): void {
    const m = this.mirrorParts[side < 0 ? 0 : 1]!;
    if (m.detached) return;
    m.swing!.mirrorFold = angle;
    this.posePart(m);
  }

  /** Snap a mirror off its door with `push` (car-space m/s). */
  breakMirror(side: number, push: THREE.Vector3): void {
    this.detachPart(this.mirrorParts[side < 0 ? 0 : 1]!, 0, push);
  }

  /** Free door swing: hinge friction, then the check-strap stop, or the latch / slam overload at 0. */
  swingDoors(dt: number): void {
    for (let i = 0; i < 2; i++) {
      const p = this.doorParts[i]!;
      if (p.detached) continue;
      const h = p.swing!;
      const sign = i === 0 ? -1 : 1;
      if (!h.latched) {
        h.theta += h.omega * dt;
        h.omega *= Math.exp(-DOOR_DAMP * dt);
        if (h.theta >= DOOR_OPEN_MAX && h.omega > 0) {
          h.theta = DOOR_OPEN_MAX;
          // The trailing edge's velocity is what the strap stops.
          _push.set(sign * Math.cos(h.theta), 0, Math.sin(h.theta)).multiplyScalar(h.omega * DOOR.length);
          const e = 0.5 * DOOR_INERTIA * h.omega * h.omega;
          // The strap's detent holds it on the stop.
          h.omega = 0;
          if (this.loadDoorStop(sign, e, _push)) continue;
        } else if (h.theta <= 0 && h.omega < 0) {
          h.theta = 0;
          if (0.5 * DOOR_INERTIA * h.omega * h.omega >= SLAM_TEAR_J) {
            // Wrenched out of its hinges against the frame: it leaves outward and rearward at its
            // centre's swing speed.
            _push.set(sign * 1.2, 0.6, 0.5 * DOOR.length * h.omega);
            this.detachPart(p, 0, _push);
            continue;
          }
          h.theta = 0;
          h.omega = 0;
          h.latched = true;
        }
      }
      this.posePart(p);
      const m = this.mirrorParts[i]!;
      if (!m.detached) this.posePart(m);
    }
  }

  protected fitInterior(): void {
    if (!this.deform.massActive) {
      this.interior.scale.set(1, 1, 1);
      this.interior.position.set(0, 0, 0);
      return;
    }
    const l = this.deform.massLocal("doorL");
    const r = this.deform.massLocal("doorR");
    const cell = this.deform.massLocal("cell");
    const span = Math.max(0.35, r.x - l.x);
    this.interior.scale.x = THREE.MathUtils.clamp(span / 1.56, 0.32, 1);
    this.interior.position.x = (l.x + r.x) * 0.5;
    this.interior.position.z = cell.z * 0.35;
    this.interior.position.y = THREE.MathUtils.clamp(cell.y - 0.55, -0.08, 0.1);
  }

  protected followGlass(): void {
    const inward = this.deform.impactInward;
    for (const g of this.glassPanes) {
      if (g.state === "shattered" || g.skin) continue;
      const onDoor = g.parts.includes("doorLeft") || g.parts.includes("doorRight");
      if (onDoor) continue;
      let nearby = 0;
      for (const part of g.parts) nearby = Math.max(nearby, this.deform.partCompression(part));
      g.mesh.position.copy(g.restPos);
      if (nearby < 0.02) continue;
      g.mesh.position.x += inward.x * nearby * 0.32;
      g.mesh.position.y += inward.y * nearby * 0.12 - nearby * 0.08;
      g.mesh.position.z += inward.z * nearby * 0.32;
    }
  }

  /** Whether the current hit loads this part. Doors and the mirrors on them (C1/C3) take a hit only
   *  from their own side; every other part must sit on the struck end. */
  private partOnHit(p: DetachPart): boolean {
    const ix = this.deform.impactInward.x;
    const iz = this.deform.impactInward.z;
    if (this.deform.bidirectional) return Math.abs(p.restPos.z) > 0.8 || Math.abs(p.restPos.x) > 0.5;
    const side = p.cage === "doorLeft" ? -1 : p.cage === "doorRight" ? 1 : 0;
    if (side !== 0) return Math.abs(ix) > Math.abs(iz) && Math.sign(ix) === -side;
    return -(p.restPos.x * ix + p.restPos.z * iz) > 0.12;
  }

  protected evaluateBreakage(impulse: number, _dt: number): void {
    void _dt;
    for (const g of this.glassPanes) {
      if (g.state === "shattered") continue;
      let nearby = 0;
      for (const part of g.parts) nearby = Math.max(nearby, this.deform.partCompression(part));
      if (g.state === "intact" && nearby > 0.45 && this.deform.crushElapsed > 0.12) {
        g.state = "cracked";
        g.mat.map = getCrackMap();
        g.mat.opacity = 0.55;
        g.mat.roughness = 0.32;
        g.mat.needsUpdate = true;
      }
      if (
        (nearby > 0.7 && this.deform.crushElapsed > 0.2) ||
        (nearby > 0.55 && impulse > 40 && this.deform.crushElapsed > 0.16)
      ) {
        this.shatterGlass(g);
      }
    }

    const ebs = this.deform.hitSpeedValue;
    for (const p of this.parts) {
      if (p.detached) continue;
      if (p.hinge === "bar") {
        const sink = ROOF_REST_Y - this.deform.massLocal("roof").y;
        if (sink > BAR_TEAR_SINK || (ebs >= BAR_TEAR_MPS && this.deform.crushElapsed > 0.05)) this.detachPart(p, impulse);
        continue;
      }
      if (this.deform.bidirectional && p.hinge !== "door" && p.hinge !== "two-point") continue;
      if (!this.partOnHit(p)) continue;
      let should = false;
      if (p.name.startsWith("mirror")) should = p.hingeT > 0.5;
      else if (p.name.startsWith("bumper")) should = p.hingeT > 0.7 && ebs >= BUMPER_TEAR_MPS;
      else if (p.hinge === "cowl" || p.hinge === "tail") should = p.hingeT > 0.78;
      else if (p.hinge === "door") should = p.hingeT > 0.58 && (this.deform.bidirectional || ebs >= DOOR_TEAR_MPS);
      if (should) this.detachPart(p, impulse);
    }

    for (const lamp of this.lamps) {
      if (!lamp.intact) continue;
      let crush = 0;
      for (const s of lamp.sensors) crush = Math.max(crush, this.deform.sensorCompression(s));
      if (crush > 0.18 && this.deform.crushElapsed > 0.02) this.breakLamp(lamp);
    }
  }

  protected breakLamp(lamp: Lamp): void {
    lamp.intact = false;
    lamp.mat.color.setHex(0x5a5c60);
    lamp.mat.emissive.setHex(0x1a1b1c);
    lamp.mat.emissiveIntensity = 0.12;
  }

  /** Hand a part to the world. `push` (car-space m/s on top of the car's velocity) replaces the
   *  crash launch: outward from the body by `impulse`, popped up by `hingeT`. */
  private detachPart(p: DetachPart, impulse: number, push?: THREE.Vector3): void {
    if (p.detached) return;
    p.detached = true;
    this.group.updateMatrixWorld();
    const wpos = new THREE.Vector3();
    const wquat = new THREE.Quaternion();
    p.object.getWorldPosition(wpos);
    p.object.getWorldQuaternion(wquat);
    this.group.remove(p.object);
    this.world.add(p.object);
    p.object.position.copy(wpos);
    p.object.quaternion.copy(wquat);
    if (push) {
      p.velocity.copy(push).applyQuaternion(this.group.quaternion).add(this.velocity);
    } else {
      _p.copy(wpos).sub(this.group.position).setY(0);
      if (_p.lengthSq() < 1e-6) _p.set(p.restPos.x, 0, p.restPos.z).applyQuaternion(this.group.quaternion);
      _p.normalize();
      p.velocity.copy(this.velocity);
      p.velocity.addScaledVector(_p, 2.2 + Math.min(5, impulse * 0.06));
      p.velocity.y += 2.1 + p.hingeT * 1.2;
      p.object.position.addScaledVector(_p, 0.14);
      p.object.position.y += 0.08;
    }
    p.angular.set(
      (Math.random() - 0.5) * 6,
      (Math.random() - 0.5) * 5,
      (Math.random() - 0.5) * 6,
    );
    if (p.hinge === "door") p.angular.y += (p.name === "doorL" ? -1 : 1) * (3.2 + p.hingeT * 2.4);
    else if (p.hinge === "cowl") p.angular.x -= 3.4;
    else if (p.hinge === "tail") p.angular.x += 3.4;
  }

  private shatterGlass(g: GlassPane): void {
    g.state = "shattered";
    g.mesh.visible = false;
    this.group.updateMatrixWorld();
    const origin = new THREE.Vector3();
    g.mesh.getWorldPosition(origin);
    origin.y += 0.12;
    const vel = this.pointVelocity(origin, new THREE.Vector3());
    vel.y += 1.5 + Math.abs(this.angular.x) * 2;
    this.onGlass?.(origin, vel, 56);
  }

  /** Shatter pane `name` now (a driver thrown through it); false if it is already gone. Call it on the
   *  authority only: netplay carries the pane to clients in the glass bits. */
  smashGlass(name: GlassName): boolean {
    const g = this.glassPanes.find((p) => p.name === name);
    if (!g || g.state === "shattered") return false;
    this.shatterGlass(g);
    return true;
  }

  /** World centre of pane `name` (its rest shape's box centre on its current seat). */
  glassWorld(name: GlassName, out: THREE.Vector3): THREE.Vector3 {
    const g = this.glassPanes.find((p) => p.name === name)!;
    const geo = g.mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    g.mesh.updateWorldMatrix(true, false);
    return geo.boundingBox!.getCenter(out).applyMatrix4(g.mesh.matrixWorld);
  }

  protected stepLooseParts(dt: number, bounce?: WorldBounce): void {
    for (const p of this.parts) if (p.detached) stepLoose(p, dt, 0.12, bounce);
    for (const w of this.looseWheels) if (w.loose) stepLoose(w, dt, TYRE_R, bounce);
  }

  /** A popped hub's wheel leaves the car: a world object launched at the hub's speed, out and up. */
  protected dropWheel(i: number, hub: string): void {
    const w = this.looseWheels[i]!;
    w.loose = true;
    this.group.updateMatrixWorld();
    w.object.getWorldQuaternion(_lampQ);
    this.group.remove(w.object);
    this.world.add(w.object);
    w.object.position.copy(this.deform.massWorld(hub));
    w.object.position.y = Math.max(TYRE_R, w.object.position.y);
    w.object.quaternion.copy(_lampQ);
    _p.copy(w.object.position).sub(this.group.position).setY(0);
    if (_p.lengthSq() > 1e-6) _p.normalize();
    w.velocity.copy(this.deform.massVel(hub)).addScaledVector(_p, 1.2);
    w.velocity.y = Math.max(w.velocity.y, 0) + 1;
    // Rolls on about its axle (the car's x) at the hub's ground speed.
    _n.set(1, 0, 0).applyQuaternion(this.group.quaternion);
    w.angular.copy(_n).multiplyScalar(Math.hypot(w.velocity.x, w.velocity.z) / TYRE_R);
  }

  /** Netplay: array sizes for a `PartNetState`; parts are `PART_SLOTS` on every style (one shared layout). */
  partNetSizes(): { parts: number; lamps: number; glass: number; wheels: number } {
    return { parts: PART_SLOTS, lamps: this.lamps.length, glass: this.glassPanes.length, wheels: this.wheels.length };
  }

  /** Netplay host: part, lamp and glass state, and each loose part's world pose. */
  readPartNetState(out: PartNetState): void {
    out.flags.fill(0, this.parts.length);
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i]!;
      const s = p.swing;
      out.flags[i] = (p.detached ? 1 : 0) | (p.folding ? 2 : 0) | (s?.latched ? 4 : 0);
      out.hinge[i * 3] = p.hingeT;
      out.hinge[i * 3 + 1] = s ? s.theta : 0;
      out.hinge[i * 3 + 2] = s ? s.mirrorFold : 0;
      if (!p.detached) continue;
      p.object.position.toArray(out.pose, i * 7);
      p.object.quaternion.toArray(out.pose, i * 7 + 3);
    }
    let lamps = 0;
    for (let i = 0; i < this.lamps.length; i++) if (this.lamps[i]!.intact) lamps |= 1 << i;
    let glass = 0;
    for (let i = 0; i < this.glassPanes.length; i++) {
      const s = this.glassPanes[i]!.state;
      glass |= (s === "cracked" ? 1 : s === "shattered" ? 2 : 0) << (i * 2);
    }
    out.lamps = lamps;
    out.glass = glass;
    let wheels = 0;
    for (let i = 0; i < this.wheels.length; i++) {
      if (!this.looseWheels[i]!.loose) continue;
      wheels |= 1 << i;
      this.wheels[i]!.position.toArray(out.wheels, i * 7);
      this.wheels[i]!.quaternion.toArray(out.wheels, i * 7 + 3);
    }
    out.wheelLoose = wheels;
  }

}
